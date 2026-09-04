import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import {
  askSystemPrompt,
  buildLessonsBlock,
  buildCoverageBlock,
  buildRelevantSourceBlock,
  markSystemPrompt,
  type MarkPart,
} from "@/lib/study-prompts";
import {
  reasoningEffortParam,
  geminiGenerationConfig,
  groqRequestParams,
  type ReasoningMode,
} from "@/lib/reasoning";
import { fetchWithTimeout } from "@/lib/ai-fetch";

/**
 * Unified AI caller for the study server functions.
 *
 * Provider order (per project policy): Gemini -> Grok (xAI) -> Groq -> Lovable
 * gateway. Gemini and Grok/Groq are the primary providers; the Lovable gateway
 * is the last-resort fallback. Every configured provider is tried in order and
 * the first non-empty answer wins, so a missing or exhausted key never
 * hard-fails a request — as long as at least one provider is configured.
 *
 * "AI is not configured yet." is now only thrown when NONE of GEMINI_API_KEY,
 * GROK_API_KEY / XAI_API_KEY, GROQ_API_KEY or LOVABLE_API_KEY is present.
 */

const GATEWAY = "https://ai.gateway.lovable.dev/v1/chat/completions";
const GOOGLE_URL = (model: string) =>
  `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`;
const GROK_URL = "https://api.x.ai/v1/chat/completions";
const GROQ_URL = "https://api.groq.com/openai/v1/chat/completions";

/** Hard bound on how long a single provider call may wait for response headers. */
const REQUEST_TIMEOUT_MS = 60_000;
const IMAGE_TIMEOUT_MS = 30_000;

// ---- shared message model -------------------------------------------------
type Part = { type: "text"; text: string } | { type: "image_url"; image_url: { url: string } };
type Message = { role: "system" | "user" | "assistant"; content: string | Part[] };

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** First non-empty value among the given env var names. */
function readKey(...names: string[]): string | undefined {
  for (const name of names) {
    const value = process.env[name];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return undefined;
}

function safeCancel(res: Response) {
  try {
    void res.body?.cancel();
  } catch {
    /* ignore */
  }
}

// ---- Gemini (direct Google API) ------------------------------------------
type GeminiPart = { text: string } | { inline_data: { mime_type: string; data: string } };

function toBase64(bytes: Uint8Array): string {
  if (typeof Buffer !== "undefined") return Buffer.from(bytes).toString("base64");
  let binary = "";
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i] ?? 0);
  return btoa(binary);
}

/** Download a remote image and return it as a Gemini inline_data part. */
async function fetchImageAsInlineData(
  url: string,
): Promise<{ inline_data: { mime_type: string; data: string } } | null> {
  try {
    const res = await fetchWithTimeout(url, {}, IMAGE_TIMEOUT_MS);
    if (!res.ok) return null;
    const mime = res.headers.get("content-type")?.split(";")[0]?.trim() || "image/png";
    const bytes = new Uint8Array(await res.arrayBuffer());
    return { inline_data: { mime_type: mime, data: toBase64(bytes) } };
  } catch {
    return null;
  }
}

async function toGeminiParts(content: string | Part[]): Promise<GeminiPart[]> {
  if (typeof content === "string") return [{ text: content }];
  const parts: GeminiPart[] = [];
  for (const part of content) {
    if (part.type === "text") parts.push({ text: part.text });
    else {
      const inline = await fetchImageAsInlineData(part.image_url.url);
      if (inline) parts.push(inline);
    }
  }
  return parts;
}

async function callGemini(
  apiKey: string,
  model: string,
  messages: Message[],
  mode: ReasoningMode,
): Promise<string> {
  const system = messages.find((m) => m.role === "system");
  const rest = messages.filter((m) => m.role !== "system");

  const contents: { role: string; parts: GeminiPart[] }[] = [];
  for (const m of rest) {
    const parts = await toGeminiParts(m.content);
    if (parts.length === 0) continue;
    contents.push({ role: m.role === "assistant" ? "model" : "user", parts });
  }

  const sysParts = system ? await toGeminiParts(system.content) : [];

  const post = (generationConfig: Record<string, unknown>) =>
    fetchWithTimeout(
      GOOGLE_URL(model),
      {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-goog-api-key": apiKey },
        body: JSON.stringify({
          contents,
          generationConfig,
          ...(sysParts.length ? { systemInstruction: { parts: sysParts } } : {}),
        }),
      },
      REQUEST_TIMEOUT_MS,
    );

  // A model that rejects the thinking config answers 400 — retry once without
  // it (an alias that resolves to a 2.5 model, or a level this model lacks).
  let res = await post(geminiGenerationConfig(model, mode));
  if (res.status === 400) {
    safeCancel(res);
    res = await post(geminiGenerationConfig(model, "off"));
  }
  if (!res.ok) {
    const detail = (await res.text().catch(() => "")).slice(0, 240);
    throw new Error(`Gemini HTTP ${res.status}${detail ? ` — ${detail}` : ""}`);
  }
  const json = (await res.json()) as {
    candidates?: { content?: { parts?: { text?: string }[] } }[];
    error?: { message?: string };
  };
  if (json.error?.message) throw new Error(`Gemini: ${json.error.message}`);
  const text = (json.candidates?.[0]?.content?.parts ?? [])
    .map((p) => p.text ?? "")
    .join("")
    .trim();
  return text;
}

// ---- Grok (xAI) -----------------------------------------------------------
async function callGrok(
  apiKey: string,
  model: string,
  messages: Message[],
  mode: ReasoningMode,
): Promise<string> {
  const post = (withReasoning: boolean) =>
    fetchWithTimeout(
      GROK_URL,
      {
        method: "POST",
        headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          model,
          messages: messages.map((m) => ({ role: m.role, content: m.content })),
          temperature: 0.3,
          ...(withReasoning ? reasoningEffortParam(mode) : {}),
        }),
      },
      REQUEST_TIMEOUT_MS,
    );

  let res = await post(true);
  // A model that does not know `reasoning_effort` answers 400/422 — retry once
  // without it rather than losing the model over a knob.
  if (res.status === 400 || res.status === 422) {
    safeCancel(res);
    res = await post(false);
  }
  if (res.status === 429) throw new Error("Grok is rate limited — try again in a moment.");
  if (res.status === 402) throw new Error("Grok is busy right now — please try again.");
  if (!res.ok) {
    const detail = (await res.text().catch(() => "")).slice(0, 240);
    throw new Error(`Grok HTTP ${res.status}${detail ? ` — ${detail}` : ""}`);
  }
  const json = (await res.json()) as {
    choices?: { message?: { content?: string } }[];
    error?: { message?: string };
  };
  if (json.error?.message) throw new Error(`Grok: ${json.error.message}`);
  return (json.choices?.[0]?.message?.content ?? "").trim();
}

// ---- Groq (extra fallback, OpenAI-compatible) ----------------------------
async function callGroq(
  apiKey: string,
  model: string,
  messages: Message[],
  mode: ReasoningMode,
): Promise<string> {
  const post = (withReasoning: boolean) =>
    fetchWithTimeout(
      GROQ_URL,
      {
        method: "POST",
        headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          model,
          messages: messages.map((m) => ({ role: m.role, content: m.content })),
          ...(withReasoning ? groqRequestParams(model, mode) : { temperature: 0, top_p: 0.1 }),
        }),
      },
      REQUEST_TIMEOUT_MS,
    );

  let res = await post(true);
  if (res.status === 400 || res.status === 422) {
    safeCancel(res);
    res = await post(false);
  }
  if (res.status === 429) throw new Error("Groq is rate limited — try again in a moment.");
  if (!res.ok) {
    const detail = (await res.text().catch(() => "")).slice(0, 240);
    throw new Error(`Groq HTTP ${res.status}${detail ? ` — ${detail}` : ""}`);
  }
  const json = (await res.json()) as {
    choices?: { message?: { content?: string } }[];
    error?: { message?: string };
  };
  if (json.error?.message) throw new Error(`Groq: ${json.error.message}`);
  return (json.choices?.[0]?.message?.content ?? "").trim();
}

// ---- Lovable gateway (last-resort fallback) ------------------------------
async function callLovable(
  apiKey: string,
  model: string,
  messages: Message[],
  mode: ReasoningMode,
): Promise<string> {
  const res = await fetchWithTimeout(
    GATEWAY,
    {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model,
        temperature: 0.3,
        top_p: 0.9,
        ...reasoningEffortParam(mode),
        messages: messages.map((m) => ({ role: m.role, content: m.content })),
      }),
    },
    REQUEST_TIMEOUT_MS,
  );
  if (res.status === 429) throw new Error("Rate limit reached. Try again in a moment.");
  if (res.status === 402) throw new Error("AI is busy right now — please try again.");
  if (!res.ok) throw new Error(`AI request failed (${res.status})`);
  const json = (await res.json()) as { choices?: { message?: { content?: string } }[] };
  return (json.choices?.[0]?.message?.content ?? "").trim();
}

export type ProviderChains = {
  gemini: string[];
  grok: string[];
  groq: string[];
  lovable: string[];
};

/**
 * Try every configured provider in order (Gemini -> Grok -> Groq -> Lovable)
 * and return the first non-empty answer. Throws "AI is not configured yet."
 * only when no provider key is set at all; otherwise throws a descriptive
 * error listing why each configured provider failed.
 */
async function complete(
  messages: Message[],
  mode: ReasoningMode,
  chains: ProviderChains,
): Promise<string> {
  const geminiKey = readKey("GEMINI_API_KEY", "GOOGLE_API_KEY");
  const grokKey = readKey("GROK_API_KEY", "XAI_API_KEY");
  const groqKey = readKey("GROQ_API_KEY");
  const lovableKey = readKey("LOVABLE_API_KEY");

  // Diagnostic: shows at a glance which providers the running process can see.
  // If both read "missing" the env vars are not reaching the server (wrong .env /
  // not restarted / set in the wrong place). If "set" but the call still fails,
  // the key itself is being rejected by the provider (check the reason below).
  console.error(
    `[study] AI providers — gemini:${geminiKey ? "set" : "missing"} grok:${grokKey ? "set" : "missing"} groq:${groqKey ? "set" : "missing"} lovable:${lovableKey ? "set" : "missing"}`,
  );

  const failures: string[] = [];
  const tryOnce = async (label: string, fn: () => Promise<string>): Promise<string | null> => {
    try {
      const out = await fn();
      if (out && out.trim()) return out;
      failures.push(`${label}: empty response`);
    } catch (err) {
      failures.push(`${label}: ${err instanceof Error ? err.message : String(err)}`);
    }
    return null;
  };

  // 1) Gemini — primary provider.
  if (geminiKey) {
    for (const model of chains.gemini) {
      const out = await tryOnce(`Gemini ${model}`, () =>
        callGemini(geminiKey, model, messages, mode),
      );
      if (out) return out;
    }
  }
  // 2) Grok (xAI) — primary provider.
  if (grokKey) {
    for (const model of chains.grok) {
      const out = await tryOnce(`Grok ${model}`, () => callGrok(grokKey, model, messages, mode));
      if (out) return out;
    }
  }
  // 3) Groq — extra fallback (kept for deployments already using it).
  if (groqKey) {
    for (const model of chains.groq) {
      const out = await tryOnce(`Groq ${model}`, () => callGroq(groqKey, model, messages, mode));
      if (out) return out;
    }
  }
  // 4) Lovable gateway — last-resort fallback.
  if (lovableKey) {
    for (const model of chains.lovable) {
      const out = await tryOnce(`Lovable ${model}`, () =>
        callLovable(lovableKey, model, messages, mode),
      );
      if (out) return out;
    }
  }

  if (!geminiKey && !grokKey && !groqKey && !lovableKey) {
    throw new Error("AI is not configured yet.");
  }
  throw new Error(`All AI providers failed. ${failures.join(" | ")}`.slice(0, 600));
}

/** Models tried for plain text (ask / mark). */
const TEXT_CHAINS: ProviderChains = {
  gemini: ["gemini-2.5-pro", "gemini-2.5-flash", "gemini-2.5-flash-lite", "gemini-2.0-flash"],
  grok: ["grok-4.3", "grok-4.1-fast", "grok-3"],
  // Groq shut down llama-3.1 / llama-3.3 chat SKUs on 2026-08-16.
  groq: ["openai/gpt-oss-120b", "openai/gpt-oss-20b"],
  lovable: ["google/gemini-2.5-pro", "google/gemini-2.5-flash"],
};

/** Models tried for vision (OCR of scanned pages). */
const VISION_CHAINS: ProviderChains = {
  gemini: ["gemini-2.5-flash", "gemini-2.5-flash-lite", "gemini-2.0-flash"],
  grok: ["grok-4.3", "grok-2-vision-1212"],
  groq: [],
  lovable: ["google/gemini-2.5-flash", "google/gemini-2.5-flash-lite"],
};
export const runStudyQuery = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((data) =>
    z
      .object({
        subjectId: z.string().uuid(),
        mode: z.enum(["ask", "mark"]),
        question: z.string().min(1),
        userAnswer: z.string().optional(),
        parts: z.array(z.enum(["feedback", "marks", "suggested", "recommendations"])).optional(),
      })
      .parse(data),
  )
  .handler(async ({ data, context }) => {
    const [{ data: docs }, { data: notes }] = await Promise.all([
      context.supabase
        .from("documents")
        .select("name, extracted_text")
        .eq("subject_id", data.subjectId),
      context.supabase
        .from("learning_notes")
        .select("content")
        .eq("subject_id", data.subjectId)
        .order("created_at", { ascending: true }),
    ]);

    // For "ask" mode: use relevant source extraction (smarter filtering)
    // For "mark" mode: even coverage across the FULL span of every document — the
    // marking guide and examiner's comments for a question are often many pages
    // after it, so reading only each document's head was hiding them.
    const sources =
      data.mode === "ask"
        ? buildRelevantSourceBlock(docs ?? [], data.question)
        : buildCoverageBlock(docs ?? []);

    const lessons = buildLessonsBlock(notes ?? []);
    const system =
      data.mode === "mark"
        ? markSystemPrompt(sources, lessons, (data.parts ?? []) as MarkPart[])
        : askSystemPrompt(sources, lessons);

    const userContent =
      data.mode === "mark"
        ? `QUESTION / SCENARIO:\n${data.question}\n\nCANDIDATE'S ANSWER:\n${data.userAnswer?.trim() || "(no answer provided — produce only the requested sections)"}`
        : data.question;

    const content = await complete(
      [
        { role: "system", content: system },
        { role: "user", content: userContent },
      ],
      data.mode,
      TEXT_CHAINS,
    );
    if (!content) throw new Error("The AI returned an empty response.");

    await context.supabase.from("qa_entries").insert({
      user_id: context.userId,
      subject_id: data.subjectId,
      mode: data.mode,
      question: data.question,
      user_answer: data.userAnswer ?? null,
      response: content,
    });

    return { content };
  });

/** OCR fallback: transcribe page images of scanned PDFs that carry no text layer. */
export const transcribePages = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((data) => z.object({ images: z.array(z.string()).min(1).max(30) }).parse(data))
  .handler(async ({ data }) => {
    const OCR_SYSTEM_PROMPT =
      "Transcribe every page image into plain text, preserving headings, numbering, tables (as markdown), formatting, and structure. " +
      "If text is blurry, handwritten, faded, or partially visible, do your best to interpret and transcribe it. " +
      "Preserve line breaks and spacing that indicate structure. " +
      "If absolutely no text can be detected on a page, write [Page {n}: No readable text detected]. " +
      "Output ONLY the transcription with NO additional commentary, explanations, or disclaimers.";

    const MAX_BATCH_SIZE = 5; // Process images in smaller batches for better reliability
    const batches: string[][] = [];

    for (let i = 0; i < data.images.length; i += MAX_BATCH_SIZE) {
      batches.push(data.images.slice(i, i + MAX_BATCH_SIZE));
    }

    const results: string[] = [];
    const MAX_RETRIES = 2;
    let lastError: string | null = null;

    for (let batchIndex = 0; batchIndex < batches.length; batchIndex++) {
      const batch = batches[batchIndex] ?? [];
      let batchText = "";
      let batchError: string | null = null;

      // Retry logic for each batch, then fall back across every configured AI provider.
      for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
        try {
          const messages: Message[] = [
            { role: "system", content: OCR_SYSTEM_PROMPT },
            {
              role: "user",
              content: [
                {
                  type: "text",
                  text: `Transcribe these ${batch.length} document page(s) in order (Batch ${batchIndex + 1}/${batches.length})${attempt > 0 ? ` - Attempt ${attempt + 1}` : ""}.`,
                },
                ...batch.map((url): Part => ({ type: "image_url", image_url: { url } })),
              ],
            },
          ];

          const content = await complete(messages, "off", VISION_CHAINS);

          if (content && content.trim().length > 0) {
            batchText = content;
            break; // Success, exit retry loop
          } else {
            batchError = "Empty response from OCR model";
            await sleep(1000 * (attempt + 1)); // Exponential backoff
          }
        } catch (error) {
          batchError = error instanceof Error ? error.message : String(error);
          if (attempt < MAX_RETRIES) {
            await sleep(1000 * (attempt + 1)); // Exponential backoff
          }
        }
      }

      lastError = batchError;
      if (batchText) {
        results.push(batchText);
      } else {
        results.push(`[Batch ${batchIndex + 1}: failed - ${batchError ?? "unknown error"}]`);
      }
    }

    const finalText = results.filter((r) => r && r.trim().length > 0).join("\n\n");

    const allFailed = results.every((r) => r.startsWith("[Batch") && r.includes("failed"));
    if (allFailed || finalText.trim().length === 0) {
      throw new Error(
        "Unable to transcribe the document with any configured AI provider.\n" +
          `Last error: ${lastError ?? "unknown"}.\n\n` +
          "Set GEMINI_API_KEY, GROK_API_KEY (or XAI_API_KEY), GROQ_API_KEY or LOVABLE_API_KEY in the deployment, " +
          "and make sure the page images are reachable.",
      );
    }

    return { text: finalText };
  });
