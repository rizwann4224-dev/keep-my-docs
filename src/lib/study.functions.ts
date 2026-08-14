import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import {
  askSystemPrompt,
  buildLessonsBlock,
  buildSourceBlock,
  markSystemPrompt,
  type MarkPart,
} from "@/lib/study-prompts";

const GATEWAY = "https://ai.gateway.lovable.dev/v1/chat/completions";

async function callGateway(apiKey: string, body: Record<string, unknown>) {
  const res = await fetch(GATEWAY, {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (res.status === 429) throw new Error("Rate limit reached. Try again in a moment.");
  if (res.status === 402) throw new Error("AI is busy right now — please try again.");

  if (!res.ok) throw new Error(`AI request failed (${res.status})`);
  const json = (await res.json()) as { choices?: { message?: { content?: string } }[] };
  return json.choices?.[0]?.message?.content ?? "";
}


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
      data.mode === "mark"
        ? markSystemPrompt(sources, lessons, (data.parts ?? []) as MarkPart[])
        : askSystemPrompt(sources, lessons);

    const userContent =
      data.mode === "mark"
        ? `QUESTION / SCENARIO:\n${data.question}\n\nCANDIDATE'S ANSWER:\n${data.userAnswer?.trim() || "(no answer provided — produce only the requested sections)"}`
        : data.question;

    const content = await callGateway(apiKey, {
      model: "google/gemini-2.5-pro",
      messages: [
        { role: "system", content: system },
        { role: "user", content: userContent },
      ],
    });
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
  .inputValidator((data) =>
    z.object({ images: z.array(z.string()).min(1).max(30) }).parse(data),
  )
  .handler(async ({ data }) => {
    const apiKey = process.env["LOVABLE_API_KEY"];
    if (!apiKey) throw new Error("AI is not configured yet.");

    const content = await callGateway(apiKey, {
      model: "google/gemini-2.5-flash",
      messages: [
        {
          role: "system",
          content:
            "Transcribe every page image into plain text, preserving headings, numbering and tables (as markdown tables). Output only the transcription, no commentary.",
        },
        {
          role: "user",
          content: [
            { type: "text", text: "Transcribe these document pages in order." },
            ...data.images.map((url) => ({ type: "image_url", image_url: { url } })),
          ],
        },
      ],
    });

    return { text: content };
  });
