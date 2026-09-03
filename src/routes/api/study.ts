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
  type ReasoningMode,
} from "@/lib/reasoning";

const GATEWAY = "https://ai.gateway.lovable.dev/v1/chat/completions";

/** Tried in order — if the budget for one model is exhausted, fall back to a cheaper one. */
const MODEL_CHAIN = [
  "google/gemini-3.6-flash",
  "google/gemini-2.5-flash",
  "google/gemini-2.5-flash-lite",
];

/**
 * Marking and challenges need the strongest reasoning available on the shared
 * allowance: Pro-tier models first (critical evaluation of an exam script is a
 * reasoning task, and flash models grade too generously), then the usual flash
 * chain. The critical marking standard is carried by the prompts in
 * study-prompts.ts; the Pro-tier model is what executes it reliably.
 */
const MODEL_CHAIN_MARK = ["google/gemini-3.1-pro-preview", "google/gemini-2.5-pro", ...MODEL_CHAIN];

/** Personal-key fallback (direct Google API) used only when the shared allowance runs out. */
const GOOGLE_MODEL_CHAIN = ["gemini-3.6-flash", "gemini-3.5-flash", "gemini-flash-latest"];

/** Second personal-key fallback (direct Groq API) used when Google is also exhausted. */
const GROQ_MODEL_CHAIN = ["llama-3.3-70b-versatile", "llama-3.1-8b-instant"];

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
        const apiKey = process.env["LOVABLE_API_KEY"];
        const url = process.env["SUPABASE_URL"];
        const anon = process.env["SUPABASE_PUBLISHABLE_KEY"];
        if (!apiKey || !url || !anon) return new Response("Not configured", { status: 500 });

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
        let source: "gateway" | "google" | "groq" = "gateway";
        let servedModel = "";
        let lastStatus = 0;

        // Marking and challenges run on the Pro-tier chain — critical
        // evaluation of an exam script is a reasoning task, and the marking
        // prompts' critical standard needs the strongest model to execute
        // it. Other modes keep the fast flash chain.
        const chain =
          data.mode === "mark" || data.mode === "challenge" ? MODEL_CHAIN_MARK : MODEL_CHAIN;
        for (const model of chain) {
          // openAiRequestParams adds the model's reasoning tier (and the old
          // sampling, for the non-Gemini-3 models) — the thinking budget that
          // makes a marking run deeper, not just longer.
          const post = (withReasoning: boolean) =>
            fetch(GATEWAY, {
              method: "POST",
              headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
              body: JSON.stringify({
                model,
                stream: true,
                ...(withReasoning
                  ? openAiRequestParams(model, data.mode)
                  : { temperature: 0, top_p: 0.1 }),
                messages: [
                  { role: "system", content: system },
                  ...priorMessages,
                  { role: "user", content: userContent },
                ],
              }),
            });

          let res = await post(true);
          // A gateway that does not know `reasoning_effort` answers 400/422.
          // Retry once without it instead of losing the model over a knob.
          if (res.status === 400 || res.status === 422) {
            await res.body?.cancel();
            res = await post(false);
          }
          lastStatus = res.status;
          if (res.ok && res.body) {
            upstream = res;
            servedModel = model;
            break;
          }
          // Budget or rate limit on this model — try the next, cheaper one.
          // 404 = this model id is not on the gateway; the next one may be.
          if (res.status !== 402 && res.status !== 429 && res.status !== 404) break;
          await res.body?.cancel();
          if (res.status === 429) await new Promise((r) => setTimeout(r, 800));
        }

        // Allowance/rate-limit exhausted on the shared gateway — fall back to the
        // project's own Gemini key so the user is never blocked.
        // Any gateway failure (credits, rate limit, upstream error) falls back to the
        // project's own Gemini key so a marking run never dead-ends.
        if (!upstream) {
          const googleKey = process.env["GEMINI_API_KEY"];
          if (googleKey) {
            for (const model of GOOGLE_MODEL_CHAIN) {
              const post = (mode: ReasoningMode) =>
                fetch(
                  `https://generativelanguage.googleapis.com/v1beta/models/${model}:streamGenerateContent?alt=sse`,
                  {
                    method: "POST",
                    headers: { "Content-Type": "application/json", "x-goog-api-key": googleKey },
                    body: JSON.stringify({
                      systemInstruction: { parts: [{ text: system }] },
                      contents: [
                        ...priorMessages.map((m) => ({
                          role: m.role === "assistant" ? "model" : "user",
                          parts: [{ text: m.content }],
                        })),
                        { role: "user", parts: [{ text: userContent }] },
                      ],
                      generationConfig: geminiGenerationConfig(model, mode),
                    }),
                  },
                );

              let res = await post(data.mode);
              // 400 here almost always means this model rejects the thinking
              // config (an alias that resolves to a 2.5 model, or a level this
              // model does not offer). Retry once with thinking off before
              // falling through to a weaker model.
              if (res.status === 400) {
                await res.body?.cancel();
                res = await post("off");
              }
              if (res.ok && res.body) {
                upstream = res;
                source = "google";
                servedModel = model;
                break;
              }
              lastStatus = res.status;
              await res.body?.cancel();
              // 404 = model retired for this key; 400 = unsupported request for
              // this model. Both are per-model, so try the next one.
              if (
                res.status !== 429 &&
                res.status !== 503 &&
                res.status !== 404 &&
                res.status !== 400
              )
                break;
              if (res.status === 429 || res.status === 503)
                await new Promise((r) => setTimeout(r, 800));
            }
          }
        }

        // Google key also exhausted — final fallback to the project's Groq key.
        // Groq speaks the same OpenAI-style SSE shape as the gateway, so the
        // stream parser below handles it unchanged.
        if (!upstream) {
          const groqKey = process.env["GROQ_API_KEY"];
          if (groqKey) {
            for (const model of GROQ_MODEL_CHAIN) {
              const res = await fetch("https://api.groq.com/openai/v1/chat/completions", {
                method: "POST",
                headers: {
                  Authorization: `Bearer ${groqKey}`,
                  "Content-Type": "application/json",
                },
                body: JSON.stringify({
                  model,
                  stream: true,
                  // llama has no reasoning tier; a reasoning-capable Groq model
                  // would get one here. See groqRequestParams.
                  ...groqRequestParams(model, data.mode),
                  messages: [
                    { role: "system", content: system },
                    ...priorMessages,
                    { role: "user", content: userContent },
                  ],
                }),
              });
              if (res.ok && res.body) {
                upstream = res;
                source = "groq";
                servedModel = model;
                break;
              }
              lastStatus = res.status;
              await res.body?.cancel();
              if (res.status !== 429 && res.status !== 503 && res.status !== 404) break;
              if (res.status !== 404) await new Promise((r) => setTimeout(r, 800));
            }
          }
        }

        if (!upstream) {
          if (lastStatus === 429)
            return new Response("The AI is busy right now — try again in a few seconds.", {
              status: 429,
            });
          return new Response(`AI request failed (${lastStatus})`, { status: 502 });
        }

        const encoder = new TextEncoder();
        const decoder = new TextDecoder();
        let full = "";
        let buffer = "";

        const stream = new ReadableStream<Uint8Array>({
          async start(controller) {
            const reader = upstream.body!.getReader();
            try {
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
