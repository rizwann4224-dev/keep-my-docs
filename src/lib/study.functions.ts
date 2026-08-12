import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import {
  askSystemPrompt,
  buildLessonsBlock,
  buildSourceBlock,
  markSystemPrompt,
} from "@/lib/study-prompts";

export const runStudyQuery = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((data) =>
    z
      .object({
        subjectId: z.string().uuid(),
        mode: z.enum(["ask", "mark"]),
        question: z.string().min(3),
        userAnswer: z.string().optional(),
      })
      .parse(data),
  )
  .handler(async ({ data, context }) => {
    const apiKey = process.env["LOVABLE_API_KEY"];
    if (!apiKey) throw new Error("AI is not configured yet.");

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

    const sources = buildSourceBlock(docs ?? []);
    const lessons = buildLessonsBlock(notes ?? []);
    const system =
      data.mode === "mark" ? markSystemPrompt(sources, lessons) : askSystemPrompt(sources, lessons);

    const userContent =
      data.mode === "mark"
        ? `QUESTION / SCENARIO:\n${data.question}\n\nCANDIDATE'S ANSWER:\n${data.userAnswer ?? "(no answer provided)"}`
        : data.question;

    const res = await fetch("https://ai.gateway.lovable.dev/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "google/gemini-2.5-pro",
        messages: [
          { role: "system", content: system },
          { role: "user", content: userContent },
        ],
      }),
    });

    if (res.status === 429) throw new Error("Rate limit reached. Try again in a moment.");
    if (res.status === 402) throw new Error("AI credits exhausted. Please top up in Settings.");
    if (!res.ok) throw new Error(`AI request failed (${res.status})`);

    const json = (await res.json()) as {
      choices?: { message?: { content?: string } }[];
    };
    const content = json.choices?.[0]?.message?.content ?? "";
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
