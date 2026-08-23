import { createFileRoute } from "@tanstack/react-router";
import { createClient } from "@supabase/supabase-js";
import { z } from "zod";
import {
  import {
  askSystemPrompt,
  buildLessonsBlock,
  challengeSystemPrompt,
  examSetterSystemPrompt,
  insightsSystemPrompt,
  buildRelevantSourceBlock,
  markSystemPrompt,
  type MarkPart,
  type Rigour,
} from "@/lib/study-prompts";


const GATEWAY = "https://ai.gateway.lovable.dev/v1/chat/completions";

/** Tried in order — if the budget for one model is exhausted, fall back to a cheaper one. */
const MODEL_CHAIN = [
  "google/gemini-3.6-flash",
  "google/gemini-2.5-flash",
  "google/gemini-2.5-flash-lite",
];

/** Personal-key fallback (direct Google API) used only when the shared allowance runs out. */
const GOOGLE_MODEL_CHAIN = ["gemini-3.6-flash", "gemini-3.5-flash", "gemini-flash-latest"];


const Body = z.object({
  subjectId: z.string().uuid(),
  mode: z.enum(["ask", "mark", "insights", "exam"]),
  question: z.string().min(1),
  userAnswer: z.string().optional(),
  parts: z.array(z.enum(["feedback", "marks", "suggested", "recommendations"])).optional(),
  rigour: z.enum(["moderate", "strict", "hard"]).optional(),
  history: z
    .array(z.object({ question: z.string(), answer: z.string() }))
    .max(40)
    .optional(),
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
          const retrievalQuery = `${data.question}\n${data.userAnswer ?? ""}`;
          // Marking and exam-setting only need the passages that bear on the question:
          // a leaner context is what makes the first tokens arrive in seconds.
          const budget =
            data.mode === "mark" ? 250_000 : data.mode === "exam" ? 300_000 : 350_000;
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
                ? examSetterSystemPrompt(sources, lessons)
                : askSystemPrompt(sources, lessons);
        }

        const userContent =
          data.mode === "insights"
            ? "Produce the performance diagnostic now."
            : data.mode === "mark"
            ? `QUESTION / SCENARIO:\n${data.question}\n\nCANDIDATE'S ANSWER:\n${data.userAnswer?.trim() || "(no answer provided — produce only the requested sections)"}`
            : data.mode === "exam"
            ? `EXAM BRIEF FROM THE CANDIDATE:\n${data.question}`
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
        let source: "gateway" | "google" = "gateway";
        let lastStatus = 0;
        for (const model of MODEL_CHAIN) {
          const res = await fetch(GATEWAY, {
            method: "POST",
            headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
            body: JSON.stringify({
              model,
              temperature: 0,
              top_p: 0.1,
              stream: true,
              messages: [
                { role: "system", content: system },
                ...priorMessages,
                { role: "user", content: userContent },
              ],
            }),
          });
          lastStatus = res.status;
          if (res.ok && res.body) {
            upstream = res;
            break;
          }
          // Budget or rate limit on this model — try the next, cheaper one.
          if (res.status !== 402 && res.status !== 429) break;
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
              const res = await fetch(
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
                    generationConfig: { temperature: 0, topP: 0.1 },
                  }),
                },
              );
              if (res.ok && res.body) {
                upstream = res;
                source = "google";
                break;
              }
              lastStatus = res.status;
              await res.body?.cancel();
              if (res.status !== 429 && res.status !== 503) break;
              await new Promise((r) => setTimeout(r, 800));
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
                      candidates?: { content?: { parts?: { text?: string }[] } }[];
                    };
                    const delta =
                      source === "google"
                        ? (json.candidates?.[0]?.content?.parts ?? [])
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
          },
        });

      },
    },
  },
});
