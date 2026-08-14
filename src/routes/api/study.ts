import { createFileRoute } from "@tanstack/react-router";
import { createClient } from "@supabase/supabase-js";
import { z } from "zod";
import {
  askSystemPrompt,
  buildLessonsBlock,
  buildRelevantSourceBlock,
  markSystemPrompt,
  type MarkPart,
} from "@/lib/study-prompts";

const GATEWAY = "https://ai.gateway.lovable.dev/v1/chat/completions";

/** Tried in order — if the budget for one model is exhausted, fall back to a cheaper one. */
const MODEL_CHAIN = [
  "google/gemini-2.5-flash",
  "google/gemini-2.5-flash-lite",
  "google/gemini-2.5-pro",
];

const Body = z.object({
  subjectId: z.string().uuid(),
  mode: z.enum(["ask", "mark"]),
  question: z.string().min(1),
  userAnswer: z.string().optional(),
  parts: z.array(z.enum(["feedback", "marks", "suggested", "recommendations"])).optional(),
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

        const [{ data: docs }, { data: notes }] = await Promise.all([
          supabase
            .from("documents")
            .select("name, extracted_text")
            .eq("subject_id", data.subjectId),
          supabase
            .from("learning_notes")
            .select("content")
            .eq("subject_id", data.subjectId)
            .order("created_at", { ascending: true }),
        ]);

        const retrievalQuery = `${data.question}\n${data.userAnswer ?? ""}`;
        const sources = buildRelevantSourceBlock(docs ?? [], retrievalQuery);
        const lessons = buildLessonsBlock(notes ?? []);
        const system =
          data.mode === "mark"
            ? markSystemPrompt(sources, lessons, (data.parts ?? []) as MarkPart[])
            : askSystemPrompt(sources, lessons);

        const userContent =
          data.mode === "mark"
            ? `QUESTION / SCENARIO:\n${data.question}\n\nCANDIDATE'S ANSWER:\n${data.userAnswer?.trim() || "(no answer provided — produce only the requested sections)"}`
            : data.question;

        let upstream: Response | null = null;
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

        if (!upstream) {
          if (lastStatus === 429)
            return new Response("The AI is busy right now — try again in a few seconds.", {
              status: 429,
            });
          if (lastStatus === 402)
            return new Response(
              "Your workspace has used its AI allowance for today. It refreshes automatically — or add credits in workspace billing to keep going without waiting.",
              { status: 402 },
            );
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
                    };
                    const delta = json.choices?.[0]?.delta?.content;
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
              controller.close();
              if (full) {
                await supabase.from("qa_entries").insert({
                  user_id: userId,
                  subject_id: data.subjectId,
                  mode: data.mode,
                  question: data.question,
                  user_answer: data.userAnswer ?? null,
                  response: full,
                });
              }
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
