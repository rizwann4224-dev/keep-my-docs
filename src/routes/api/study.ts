import { createFileRoute } from "@tanstack/react-router";
import { createClient } from "@supabase/supabase-js";
import { z } from "zod";
import {
  askSystemPrompt,
  buildLessonsBlock,
  challengeSystemPrompt,
  examSetterSystemPrompt,
  insightsSystemPrompt,
  buildRelevantSourceBlock,
  markSystemPrompt,
  MAX_CONTEXT_CHARS,
  type MarkPart,
  type Rigour,
} from "@/lib/study-prompts";
import {
  geminiGenerationConfig,
  groqRequestParams,
  openAiRequestParams,
  openAiSamplingParams,
  type ReasoningMode,
} from "@/lib/reasoning";
import { fetchWithTimeout } from "@/lib/ai-fetch";
import { ensureServerEnv, readServerKey } from "@/lib/load-env";

const GATEWAY = "https://ai.gateway.lovable.dev/v1/chat/completions";

/** Tried in order — if the budget for one model is exhausted, fall back to a cheaper one. */
const MODEL_CHAIN = [
  "google/gemini-3.6-flash",
  "google/gemini-3.5-flash-lite",
];

/**
 * Marking and challenges need the strongest reasoning available on the shared
 * allowance: Pro-tier models first (critical evaluation of an exam script is a
 * reasoning task, and flash models grade too generously), then the usual flash
 * chain. The critical marking standard is carried by the prompts in
 * study-prompts.ts; the Pro-tier model is what executes it reliably.
 */
const MODEL_CHAIN_MARK = ["google/gemini-3.1-pro-preview", ...MODEL_CHAIN];

/**
 * Project's own Gemini key (direct Google API) — FIRST priority on every request.
 * Prefer widely-available Flash models first so a free AI Studio key always has
 * something to hit; Pro is tried after for mark/challenge quality.
 */
const GOOGLE_MODEL_CHAIN = [
  "gemini-3.6-flash",
  "gemini-2.0-flash",
  "gemini-3.5-flash-lite",
  "gemini-flash-latest",
  "gemini-3.1-pro-preview",
];

/** Extra Pro-first chain for mark/challenge when a Gemini key is set. */
const GOOGLE_MODEL_CHAIN_MARK = [
  "gemini-3.1-pro-preview",
  "gemini-3.6-flash",
  "gemini-2.0-flash",
  "gemini-3.5-flash-lite",
  "gemini-flash-latest",
];

/**
 * Second personal-key fallback (direct Groq API) used when Google is also exhausted.
 * Groq shut down the llama-3.1 / llama-3.3 chat SKUs on 2026-08-16 for free and
 * developer tiers — use the current production replacements only.
 */
const GROQ_MODEL_CHAIN = ["openai/gpt-oss-120b", "openai/gpt-oss-20b"];

/** Third personal-key fallback (direct xAI / Grok API). */
const GROK_MODEL_CHAIN = ["grok-4-fast-reasoning", "grok-4-fast-non-reasoning", "grok-3"];

/**
 * When the shared Lovable gateway reports 402 (credits exhausted) or 403
 * (blocked), that applies to every model on it. Remember it for a few minutes
 * so later requests skip the gateway entirely and go straight to the project's
 * own Gemini/Groq keys instead of burning seconds on doomed calls.
 */
let gatewayFailure: { status: number; until: number } | null = null;
/** Hard bound on how long a single provider call may wait for response headers. */
const REQUEST_TIMEOUT_MS = 45_000;

/**
 * Gemini streamGenerateContent with a large system prompt + thinking can take
 * longer than a simple chat completion to return headers. Give it more room so
 * a working key is not abandoned as "timed out or unreachable".
 */
const GEMINI_TIMEOUT_MS = 90_000;

/** Total budget for finding a working provider (Gemini → gateway → Groq → Grok). */
const ACQUIRE_DEADLINE_MS = 180_000;

/** Short, human-readable description of a failed provider response, including
 *  the provider's own error body so the real cause is visible to the user. */
async function describeHttpFailure(label: string, res: Response): Promise<string> {
  const body = (await res.text().catch(() => "")).trim().slice(0, 240);
  return `${label}: HTTP ${res.status}${body ? ` — ${body}` : ""}`;
}

const Body = z.object({
  subjectId: z.string().uuid(),
  mode: z.enum(["ask", "mark", "insights", "exam", "challenge"]),
  question: z.string().min(1),
  userAnswer: z.string().optional(),
  parts: z.array(z.enum(["feedback", "marks", "suggested", "recommendations"])).optional(),
  rigour: z.enum(["moderate", "strict", "hard"]).optional(),
  difficulty: z.enum(["medium", "professional", "hard"]).optional(),
  history: z
    .array(z.object({ question: z.string(), answer: z.string() }))
    .max(40)
    .optional(),
  priorQuestions: z.array(z.string()).max(100).optional(),
  originalEvaluation: z.string().optional(),
  challengeQuery: z.string().min(1).optional(),
  originalMarks: z.number().optional(),
  maxMarks: z.number().optional(),
});

export const Route = createFileRoute("/api/study")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        // Pull GEMINI_API_KEY etc. from .env.local even when the runtime did not.
        ensureServerEnv();
        const apiKey = readServerKey("LOVABLE_API_KEY");
        const url = process.env["SUPABASE_URL"];
        const anon = process.env["SUPABASE_PUBLISHABLE_KEY"];
        // Gemini / Grok / Groq can serve the request without the Lovable gateway,
        // so only Supabase config is mandatory — the AI providers are tried in
        // order (Gemini -> Lovable -> Groq -> Grok) and fall through to whichever key exists.
        if (!url || !anon) return new Response("Not configured", { status: 500 });
        const authHeader = request.headers.get("authorization");
        if (!authHeader) return new Response("Unauthorized", { status: 401 });

        const supabase = createClient(url, anon, {
          global: { headers: { Authorization: authHeader, apikey: anon } },
          auth: { persistSession: false, autoRefreshToken: false },
        });
        const { data: userData } = await supabase.auth.getUser();
        const userId = userData.user?.id;
        if (!userId) return new Response("Unauthorized", { status: 401 });

        const parsed = Body.safeParse(await request.json());
        if (!parsed.success) return new Response("Bad request", { status: 400 });
        const data = parsed.data;

        // Insights never reads source documents — skipping the (large) extracted_text
        // fetch is the single biggest latency win for the diagnostic.
        const [{ data: docs }, { data: notes }] = await Promise.all([
          data.mode === "insights"
            ? Promise.resolve({ data: [] as { name: string; extracted_text: string }[] })
            : supabase
                .from("documents")
                .select("name, extracted_text")
                .eq("subject_id", data.subjectId),
          supabase
            .from("learning_notes")
            .select("content")
            .eq("subject_id", data.subjectId)
            .order("created_at", { ascending: true }),
        ]);

        const lessons = buildLessonsBlock(notes ?? []);

        let system: string;
        if (data.mode === "insights") {
          const { data: attempts } = await supabase
            .from("qa_entries")
            .select("question, user_answer, response, created_at")
            .eq("subject_id", data.subjectId)
            .eq("mode", "mark")
            .order("created_at", { ascending: true })
            // Every marked attempt in the notebook — the diagnostic must aggregate all of them.
            .limit(500);

          if (!attempts || attempts.length === 0) {
            return new Response(
              "No marked attempts yet — answer a question in Answer & marking first.",
              { status: 400 },
            );
          }
          system = insightsSystemPrompt(attempts, lessons);
        } else {
          const retrievalQuery =
            `${data.question}\n${data.userAnswer ?? ""}` +
            (data.mode === "challenge" ? `\n${data.challengeQuery ?? ""}` : "");
          // Marking must see the WHOLE notebook — the official answer, marking
          // guide and examiner's comments for the question can sit in any
          // source, so mark/challenge get the maximum context budget. Exam and
          // ask keep a leaner, relevance-ranked context for speed.
          const budget =
            data.mode === "mark" || data.mode === "challenge"
              ? MAX_CONTEXT_CHARS
              : data.mode === "exam"
                ? 300_000
                : 350_000;
          const sources = buildRelevantSourceBlock(docs ?? [], retrievalQuery, budget);
          system =
            data.mode === "mark"
              ? markSystemPrompt(
                  sources,
                  lessons,
                  (data.parts ?? []) as MarkPart[],
                  (data.rigour ?? "strict") as Rigour,
                )
              : data.mode === "exam"
                ? examSetterSystemPrompt(
                    sources,
                    lessons,
                    (data.difficulty ?? "medium") as "medium" | "professional" | "hard",
                  )
                : data.mode === "challenge"
                  ? challengeSystemPrompt(sources, lessons, (data.rigour ?? "strict") as Rigour)
                  : askSystemPrompt(sources, lessons);
        }

        const userContent =
          data.mode === "insights"
            ? "Produce the performance diagnostic now."
            : data.mode === "mark"
              ? `QUESTION / SCENARIO:\n${data.question}\n\nCANDIDATE'S ANSWER:\n${data.userAnswer?.trim() || "(no answer provided — produce only the requested sections)"}`
              : data.mode === "exam"
                ? `EXAM BRIEF FROM THE CANDIDATE:\n${data.question}${
                    (data.priorQuestions ?? []).filter((q) => q.trim().length > 0).length
                      ? `\n\nQUESTION LEDGER — questions already set for this notebook (NEVER repeat any of these, and never reuse their scenario, entity, facts, figures or testing angle):\n${data
                          .priorQuestions!.filter((q) => q.trim().length > 0)
                          .slice(-50)
                          .map((q, i) => `${i + 1}. ${q.trim()}`)
                          .join("\n")}`
                      : ""
                  }`
                : data.mode === "challenge"
                  ? `ORIGINAL QUESTION / SCENARIO:\n${data.question}\n\nCANDIDATE'S ORIGINAL ANSWER:\n${data.userAnswer?.trim() || "(none provided)"}\n\nORIGINAL MARKING OUTPUT GIVEN TO CANDIDATE:\n${data.originalEvaluation?.trim() || "(not provided)"}\n\nORIGINAL MARKS AWARDED: ${data.originalMarks ?? "unknown"} / ${data.maxMarks ?? "unknown"}\n\nCANDIDATE'S CHALLENGE / QUERY:\n${data.challengeQuery?.trim() || ""}`
                  : data.question;

        // Ask mode keeps the thread's earlier turns so follow-ups ("and for the
        // next year?", "rephrase that") resolve against the previous question.
        const priorMessages =
          data.mode === "ask" || data.mode === "exam"
            ? (data.history ?? []).slice(-12).flatMap((turn) => [
                { role: "user" as const, content: turn.question },
                { role: "assistant" as const, content: turn.answer.slice(0, 4000) },
              ])
            : [];

        let upstream: Response | null = null;
        // "google-plain" = non-streaming generateContent wrapped as raw text bytes
        // (no SSE framing). Everything else is OpenAI-style SSE except "google".
        let source: "gateway" | "google" | "google-plain" | "groq" | "grok" = "gateway";
        let servedModel = "";
        // Why each provider failed, so the final error names the real cause
        // instead of a blanket "unavailable" — e.g. the gateway running out of
        // credits while a GEMINI_API_KEY that IS set gets rejected by Google.
        let gatewayStatus = 0;
        let gatewayError = "";
        let googleError = "";
        let groqError = "";
        let grokError = "";

        // Marking and challenges run on the Pro-tier chain — critical
        // evaluation of an exam script is a reasoning task, and the marking
        // prompts' critical standard needs the strongest model to execute
        // it. Other modes keep the fast flash chain.
        const chain =
          data.mode === "mark" || data.mode === "challenge" ? MODEL_CHAIN_MARK : MODEL_CHAIN;
        // Total budget for finding a working provider this request; after that
        // the caller gets a clean timeout instead of an endless wait.
        const deadline = Date.now() + ACQUIRE_DEADLINE_MS;

        /** First non-empty value among the given env var names. */
        const readKey = (...names: string[]): string | undefined => readServerKey(...names);

        // 1) FIRST PRIORITY — the project's own Gemini key (user-provided API key,
        // e.g. a Google AI Studio key). Tried before the shared gateway on every
        // request. Never abandon the whole chain on a single model timeout —
        // keep walking every model, and on timeout retry once with thinking off
        // (thinking is what makes stream headers slow on large mark prompts).
        if (!upstream) {
          const googleKey = readKey("GOOGLE_API_KEY", "GEMINI_API_KEY");
          if (googleKey) {
            console.error(
              `[study] Gemini key present (${googleKey.slice(0, 6)}…${googleKey.slice(-4)}, len=${googleKey.length}) — trying direct Google API first`,
            );
            const googleChain =
              data.mode === "mark" || data.mode === "challenge"
                ? GOOGLE_MODEL_CHAIN_MARK
                : GOOGLE_MODEL_CHAIN;

            const geminiBody = (model: string, mode: ReasoningMode) =>
              JSON.stringify({
                systemInstruction: { parts: [{ text: system }] },
                contents: [
                  ...priorMessages.map((m) => ({
                    role: m.role === "assistant" ? "model" : "user",
                    parts: [{ text: m.content }],
                  })),
                  { role: "user", parts: [{ text: userContent }] },
                ],
                generationConfig: geminiGenerationConfig(model, mode),
              });

            const postStream = (model: string, mode: ReasoningMode, timeoutMs: number) =>
              fetchWithTimeout(
                `https://generativelanguage.googleapis.com/v1beta/models/${model}:streamGenerateContent?alt=sse`,
                {
                  method: "POST",
                  headers: { "Content-Type": "application/json", "x-goog-api-key": googleKey },
                  body: geminiBody(model, mode),
                },
                timeoutMs,
              );

            /** Non-streaming fallback when SSE headers hang — still returns the full answer. */
            const postOnce = async (
              model: string,
              mode: ReasoningMode,
              timeoutMs: number,
            ): Promise<Response | null> => {
              try {
                const res = await fetchWithTimeout(
                  `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`,
                  {
                    method: "POST",
                    headers: { "Content-Type": "application/json", "x-goog-api-key": googleKey },
                    body: geminiBody(model, mode),
                  },
                  timeoutMs,
                );
                if (!res.ok) {
                  googleError = await describeHttpFailure(`Gemini fallback (${model})`, res);
                  return null;
                }
                const json = (await res.json()) as {
                  candidates?: { content?: { parts?: { text?: string; thought?: boolean }[] } }[];
                  error?: { message?: string };
                };
                if (json.error?.message) {
                  googleError = `Gemini fallback (${model}): ${json.error.message}`;
                  return null;
                }
                const text = (json.candidates?.[0]?.content?.parts ?? [])
                  .filter((p) => !p.thought)
                  .map((p) => p.text ?? "")
                  .join("")
                  .trim();
                if (!text) {
                  googleError = `Gemini fallback (${model}): empty response`;
                  return null;
                }
                // Wrap the plain text as a ReadableStream so the rest of the
                // handler can treat it like a streaming upstream.
                const encoder = new TextEncoder();
                const body = new ReadableStream<Uint8Array>({
                  start(controller) {
                    controller.enqueue(encoder.encode(text));
                    controller.close();
                  },
                });
                return new Response(body, { status: 200 });
              } catch (err) {
                const why = err instanceof Error ? err.message : "timed out or unreachable";
                googleError = `Gemini fallback (${model}): ${why}`;
                return null;
              }
            };

            for (const model of googleChain) {
              const remaining = deadline - Date.now();
              if (remaining <= 0) break;
              const timeoutMs = Math.min(GEMINI_TIMEOUT_MS, remaining);

              let res: Response | null = null;
              let usedNonStream = false;

              // Attempt 1: streaming with the task's normal reasoning depth.
              try {
                res = await postStream(model, data.mode, timeoutMs);
                if (res.status === 400) {
                  await res.body?.cancel();
                  // Attempt 2: streaming with thinking off (config rejection).
                  res = await postStream(model, "off", timeoutMs);
                }
              } catch (err) {
                const why = err instanceof Error ? err.message : "timed out or unreachable";
                googleError = `Gemini fallback (${model}): ${why}`;
                // Attempt 3: same model, thinking off, still streaming — thinking
                // is the usual reason headers take so long on mark prompts.
                try {
                  res = await postStream(model, "off", timeoutMs);
                } catch (err2) {
                  const why2 = err2 instanceof Error ? err2.message : "timed out or unreachable";
                  googleError = `Gemini fallback (${model}): ${why2}`;
                  // Attempt 4: non-streaming generateContent (often faster to first byte).
                  const once = await postOnce(model, "off", timeoutMs);
                  if (once) {
                    res = once;
                    usedNonStream = true;
                  } else {
                    continue; // next model
                  }
                }
              }

              if (!res) continue;

              if (res.ok && res.body) {
                if (usedNonStream) {
                  // Non-stream path already produced plain text bytes — tag it so
                  // the stream parser below does not look for SSE `data:` lines.
                  source = "google-plain";
                } else {
                  source = "google";
                }
                upstream = res;
                servedModel = model;
                console.error(`[study] Gemini served via ${model} (${source})`);
                break;
              }

              googleError = await describeHttpFailure(`Gemini fallback (${model})`, res);
              // Keep walking the chain on per-model problems (404 unknown id,
              // 400 bad config, 429/503 transient). Only stop on auth / hard
              // client errors that every model will also hit (401/403).
              if (res.status === 401 || res.status === 403) break;
              if (res.status === 429 || res.status === 503) {
                await new Promise((r) => setTimeout(r, 800));
              }
              // Everything else (404/400/5xx): try the next model.
            }
          } else {
            console.error(
              "[study] No GEMINI_API_KEY / GOOGLE_API_KEY in process.env — Gemini path skipped",
            );
          }
        }

        // 4) Project's Grok (xAI) key — final personal-key fallback.
        if (!upstream) {
          const grokKey = readKey("GROK_API_KEY", "XAI_API_KEY");
          if (grokKey) {
            for (const model of GROK_MODEL_CHAIN) {
              const remaining = deadline - Date.now();
              if (remaining <= 0) break;
              const post = (withReasoning: boolean) =>
                fetchWithTimeout(
                  "https://api.x.ai/v1/chat/completions",
                  {
                    method: "POST",
                    headers: {
                      Authorization: `Bearer ${grokKey}`,
                      "Content-Type": "application/json",
                    },
                    body: JSON.stringify({
                      model,
                      stream: true,
                      temperature: 0.3,
                      ...(withReasoning ? openAiRequestParams(model, data.mode) : {}),
                      messages: [
                        { role: "system", content: system },
                        ...priorMessages,
                        { role: "user", content: userContent },
                      ],
                    }),
                  },
                  Math.min(REQUEST_TIMEOUT_MS, remaining),
                );
              let res: Response;
              try {
                res = await post(true);
                if (res.status === 400 || res.status === 422) {
                  await res.body?.cancel();
                  res = await post(false);
                }
              } catch (err) {
                const why = err instanceof Error ? err.message : "timed out or unreachable";
                grokError = `Grok fallback (${model}): ${why}`;
                continue;
              }
              if (res.ok && res.body) {
                upstream = res;
                source = "grok";
                servedModel = model;
                break;
              }
              grokError = await describeHttpFailure(`Grok fallback (${model})`, res);
              if (res.status !== 429 && res.status !== 503 && res.status !== 404) break;
              if (res.status !== 404) await new Promise((r) => setTimeout(r, 800));
            }
          }
        }

        // 3) Project's Groq key — after Gemini and the gateway.
        // Groq speaks the same OpenAI-style SSE shape as the gateway, so the
        // stream parser below handles it unchanged.
        if (!upstream) {
          const groqKey = readKey("GROQ_API_KEY");
          if (groqKey) {
            // Groq's on-demand tier caps a single request at ~8k tokens per
            // minute, so the full notebook context (hundreds of thousands of
            // characters) always came back 413 and the whole request ended as
            // a 502. Send a trimmed prompt instead — head + tail of the source
            // block keeps the instructions and the most relevant extract.
            const groqUserContent = clampForGroq(userContent, 6_000);
            const groqSystem = clampForGroq(
              system,
              Math.max(4_000, GROQ_MAX_PROMPT_CHARS - groqUserContent.length),
            );
            const groqMessages = [
              { role: "system", content: groqSystem },
              { role: "user", content: groqUserContent },
            ];
            for (const model of GROQ_MODEL_CHAIN) {
              const remaining = deadline - Date.now();
              if (remaining <= 0) break;
              let res: Response;
              try {
                res = await fetchWithTimeout(
                  "https://api.groq.com/openai/v1/chat/completions",
                  {
                    method: "POST",
                    headers: {
                      Authorization: `Bearer ${groqKey}`,
                      "Content-Type": "application/json",
                    },
                    body: JSON.stringify({
                      model,
                      stream: true,
                      // gpt-oss models accept reasoning_effort; llama (retired)
                      // does not. See groqRequestParams.
                      ...groqRequestParams(model, data.mode),
                      messages: groqMessages,
                    }),
                  },
                  Math.min(REQUEST_TIMEOUT_MS, remaining),
                );
              } catch (err) {
                const why = err instanceof Error ? err.message : "timed out or unreachable";
                groqError = `Groq fallback (${model}): ${why}`;
                continue;
              }
              if (res.ok && res.body) {
                upstream = res;
                source = "groq";
                servedModel = model;
                break;
              }
              groqError = await describeHttpFailure(`Groq fallback (${model})`, res);
              // 404 = unknown/retired model — try the next id. 400/422 may be a
              // rejected reasoning knob; retry once without it before giving up.
              if (res.status === 400 || res.status === 422) {
                try {
                  await res.body?.cancel();
                  const retryRemaining = deadline - Date.now();
                  if (retryRemaining <= 0) break;
                  res = await fetchWithTimeout(
                    "https://api.groq.com/openai/v1/chat/completions",
                    {
                      method: "POST",
                      headers: {
                        Authorization: `Bearer ${groqKey}`,
                        "Content-Type": "application/json",
                      },
                      body: JSON.stringify({
                        model,
                        stream: true,
                        temperature: 0,
                        top_p: 0.1,
                        messages: groqMessages,

                      }),
                    },
                    Math.min(REQUEST_TIMEOUT_MS, retryRemaining),
                  );
                  if (res.ok && res.body) {
                    upstream = res;
                    source = "groq";
                    servedModel = model;
                    break;
                  }
                  groqError = await describeHttpFailure(`Groq fallback (${model})`, res);
                } catch (err) {
                  const why = err instanceof Error ? err.message : "timed out or unreachable";
                  groqError = `Groq fallback (${model}): ${why}`;
                }
              }
              if (res.status !== 429 && res.status !== 503 && res.status !== 404) break;
              if (res.status !== 404) await new Promise((r) => setTimeout(r, 800));
            }
          }
        }

        if (!upstream) {
          // 2) Shared Lovable gateway — only when a LOVABLE_API_KEY is present and
          // the Gemini key failed (or was missing). Credit exhaustion (402) /
          // policy block (403) is workspace-wide, not per-model: once seen, every
          // further gateway model returns the same. Skip the whole gateway for a
          // while and go straight to the project's own keys.
          const gatewaySkipped =
            !apiKey || (gatewayFailure !== null && gatewayFailure.until > Date.now());
          if (!apiKey) {
            gatewayError = "Shared gateway: LOVABLE_API_KEY not set";
          } else if (gatewayFailure !== null && gatewayFailure.until > Date.now()) {
            gatewayStatus = gatewayFailure.status;
            gatewayError =
              gatewayFailure.status === 402
                ? "Shared gateway: credits exhausted (402) — skipped (cached)"
                : `Shared gateway: previously failed (${gatewayFailure.status}) — skipped`;
          }
          for (const model of gatewaySkipped ? [] : chain) {
            const remaining = deadline - Date.now();
            if (remaining <= 0) break;

            // openAiRequestParams adds the model's reasoning tier (and the old
            // sampling, for the non-Gemini-3 models) — the thinking budget that
            // makes a marking run deeper, not just longer.
            const post = (withReasoning: boolean) =>
              fetchWithTimeout(
                GATEWAY,
                {
                  method: "POST",
                  headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
                  body: JSON.stringify({
                    model,
                    stream: true,
                    ...(withReasoning
                      ? openAiRequestParams(model, data.mode)
                      : openAiSamplingParams(model)),
                    messages: [
                      { role: "system", content: system },
                      ...priorMessages,
                      { role: "user", content: userContent },
                    ],
                  }),
                },
                Math.min(REQUEST_TIMEOUT_MS, remaining),
              );

            let res: Response;
            try {
              res = await post(true);
              // A gateway that does not know `reasoning_effort` answers 400/422.
              // Retry once without it instead of losing the model over a knob.
              if (res.status === 400 || res.status === 422) {
                await res.body?.cancel();
                res = await post(false);
              }
            } catch {
              // Timed out or network failure — the whole gateway host is
              // unreachable, not just this model. Stop and fall through.
              gatewayStatus = 504;
              gatewayError = "Shared gateway: timed out or unreachable";
              break;
            }
            gatewayStatus = res.status;
            if (res.ok && res.body) {
              upstream = res;
              servedModel = model;
              break;
            }
            gatewayError = await describeHttpFailure("Shared gateway", res);
            // Out of credits / blocked by policy — terminal for the whole
            // gateway. Stop trying gateway models here and for the next 10
            // minutes; the project keys below take over.
            if (res.status === 402 || res.status === 403) {
              gatewayFailure = { status: res.status, until: Date.now() + 10 * 60_000 };
              break;
            }
            // 429 is a workspace-wide rate limit: every other model on the same
            // gateway returns the same, so stop instead of burning seconds.
            if (res.status === 429) break;
            // 404 = unknown/retired model id — the next model may still work.
            if (res.status === 404) continue;
            break;
          }
        }

        if (!upstream) {
          // Every path tried and failed. The gateway status decides the HTTP
          // code (402/429 mirror the gateway's), but the message reports the
          // actual failures of BOTH the gateway and the configured fallbacks,
          // so "GEMINI_API_KEY is set but still failing" is finally visible.
          const hasGemini = !!readKey("GOOGLE_API_KEY", "GEMINI_API_KEY");
          const hasGroq = !!readKey("GROQ_API_KEY");
          const hasGrok = !!readKey("GROK_API_KEY", "XAI_API_KEY");
          const reasons = [
            gatewayStatus === 402 ? gatewayError || "Shared gateway: credits exhausted (402)" : "",
            gatewayStatus === 403 ? gatewayError || "Shared gateway: blocked (403)" : "",
            gatewayStatus === 429 ? gatewayError || "Shared gateway: rate limited (429)" : "",
            gatewayStatus === 504 ? gatewayError || "Shared gateway: timed out" : "",
            gatewayError &&
            gatewayStatus !== 402 &&
            gatewayStatus !== 403 &&
            gatewayStatus !== 429 &&
            gatewayStatus !== 504
              ? gatewayError
              : "",
            googleError || "",
            groqError || "",
            grokError || "",
          ].filter(Boolean);

          let message =
            "The AI providers are unavailable right now — please try again in a moment.";
          if (reasons.length > 0) {
            message =
              "The AI providers are unavailable right now — please try again in a moment.\n\nWhy this request failed:\n" +
              reasons.map((r) => `• ${r}`).join("\n");
            if (gatewayStatus === 402)
              message +=
                "\n\nThe shared Lovable AI allowance has run out of credits. " +
                "Set GEMINI_API_KEY, GROQ_API_KEY, or GROK_API_KEY / XAI_API_KEY in the deployment " +
                "(or .env.local for local dev) so requests bypass the shared gateway, " +
                "or add credits / enable auto top-up in Lovable (Settings → Plans & credit usage).";
            if (!googleError && !hasGemini)
              message +=
                "\n\nNote: no GEMINI_API_KEY is set in the deployment, so the Google fallback was never attempted.";
            if (!groqError && !hasGroq)
              message += "\n\nNote: no GROQ_API_KEY is set in the deployment.";
            if (!grokError && !hasGrok)
              message += "\n\nNote: no GROK_API_KEY / XAI_API_KEY is set in the deployment.";
          }

          // Prefer 502 over 402 when personal keys are configured — the gateway
          // being out of credits is not the actionable failure once fallbacks exist.
          const status =
            hasGemini || hasGroq || hasGrok
              ? 502
              : gatewayStatus === 402
                ? 402
                : gatewayStatus === 429
                  ? 429
                  : 502;
          return new Response(message, { status });
        }
        const encoder = new TextEncoder();
        const decoder = new TextDecoder();
        let full = "";
        let buffer = "";

        const stream = new ReadableStream<Uint8Array>({
          async start(controller) {
            const reader = upstream.body!.getReader();
            try {
              // Non-streaming Gemini fallback already produced plain UTF-8 text —
              // forward it as-is, no SSE parse.
              if (source === "google-plain") {
                for (;;) {
                  const { done, value } = await reader.read();
                  if (done) break;
                  if (value) {
                    full += decoder.decode(value, { stream: true });
                    controller.enqueue(value);
                  }
                }
                full += decoder.decode();
              } else {
              for (;;) {
                const { done, value } = await reader.read();
                if (done) break;
                buffer += decoder.decode(value, { stream: true });
                const lines = buffer.split("\n");
                buffer = lines.pop() ?? "";
                for (const line of lines) {
                  const trimmed = line.trim();
                  if (!trimmed.startsWith("data:")) continue;
                  const payload = trimmed.slice(5).trim();
                  if (payload === "[DONE]") continue;
                  try {
                    const json = JSON.parse(payload) as {
                      choices?: { delta?: { content?: string } }[];
                      candidates?: {
                        content?: { parts?: { text?: string; thought?: boolean }[] };
                      }[];
                    };
                    const delta =
                      source === "google"
                        ? (json.candidates?.[0]?.content?.parts ?? [])
                            // Reasoning summaries arrive as parts flagged
                            // `thought: true` — scaffolding, not the answer.
                            .filter((p) => !p.thought)
                            .map((p) => p.text ?? "")
                            .join("")
                        : json.choices?.[0]?.delta?.content;
                    if (delta) {
                      full += delta;
                      controller.enqueue(encoder.encode(delta));
                    }
                  } catch {
                    /* ignore partial json */
                  }
                }
              }
              } // end SSE branch
            } finally {
              // Save BEFORE closing the stream: once the response closes the
              // worker can be torn down and a pending insert would be dropped.
              if (full && data.mode !== "insights") {
                const { error } = await supabase.from("qa_entries").insert({
                  user_id: userId,
                  subject_id: data.subjectId,
                  mode: data.mode,
                  question: data.question,
                  user_answer: data.userAnswer ?? null,
                  response: full,
                });
                if (error) console.error("qa_entries insert failed", error.message);
              }
              controller.close();
            }
          },
        });

        return new Response(stream, {
          headers: {
            "Content-Type": "text/plain; charset=utf-8",
            "Cache-Control": "no-cache, no-transform",
            "X-Accel-Buffering": "no",
            // Which model actually served the run (google/gemini-…, groq/…) —
            // surfaced in the answer footer so the user can see it.
            "X-Study-Model": servedModel,
          },
        });
      },
    },
  },
});
