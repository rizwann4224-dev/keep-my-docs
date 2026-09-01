import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import {
  askSystemPrompt,
  buildLessonsBlock,
  buildSourceBlock,
  buildRelevantSourceBlock,
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

    // For "ask" mode: use relevant source extraction (smarter filtering)
    // For "mark" mode: use comprehensive sources (need full context for marking)
    const sources =
      data.mode === "ask"
        ? buildRelevantSourceBlock(docs ?? [], data.question)
        : buildSourceBlock(docs ?? []);
    
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
      model: "google/gemini-2.5-pro", // Using the more powerful model for better reasoning
      messages: [
        { role: "system", content: system },
        { role: "user", content: userContent },
      ],
      temperature: 0.3, // Lower temperature for more precise, consistent answers
      top_p: 0.9,
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

    const MAX_BATCH_SIZE = 5; // Process images in smaller batches for better reliability
    const batches: string[][] = [];
    
    for (let i = 0; i < data.images.length; i += MAX_BATCH_SIZE) {
      batches.push(data.images.slice(i, i + MAX_BATCH_SIZE));
    }

    const results: string[] = [];
    const MAX_RETRIES = 2;

    for (let batchIndex = 0; batchIndex < batches.length; batchIndex++) {
      const batch = batches[batchIndex] ?? [];
      let batchText = "";
      let lastError: Error | null = null;

      // Retry logic for each batch
      for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
        try {
          const content = await callGateway(apiKey, {
            model: "google/gemini-2.5-flash",
            messages: [
              {
                role: "system",
                content:
                  "Transcribe every page image into plain text, preserving headings, numbering, tables (as markdown), formatting, and structure. " +
                  "If text is blurry, handwritten, faded, or partially visible, do your best to interpret and transcribe it. " +
                  "Preserve line breaks and spacing that indicate structure. " +
                  "If absolutely no text can be detected on a page, write [Page {n}: No readable text detected]. " +
                  "Output ONLY the transcription with NO additional commentary, explanations, or disclaimers.",
              },
              {
                role: "user",
                content: [
                  { 
                    type: "text", 
                    text: `Transcribe these ${batch.length} document page(s) in order (Batch ${batchIndex + 1}/${batches.length})${attempt > 0 ? ` - Attempt ${attempt + 1}` : ""}.` 
                  },
                  ...batch.map((url) => ({ 
                    type: "image_url", 
                    image_url: { url } 
                  })),
                ],
              },
            ],
            temperature: 0.1, // Very low temperature for consistency
          });

          if (content && content.trim().length > 0) {
            batchText = content;
            break; // Success, exit retry loop
          } else if (attempt < MAX_RETRIES) {
            // Empty response, retry
            lastError = new Error("Empty response from OCR model");
            await new Promise(r => setTimeout(r, 1000 * (attempt + 1))); // Exponential backoff
          } else {
            batchText = `[Batch ${batchIndex + 1}: No text extracted from any pages]`;
          }
        } catch (error) {
          lastError = error instanceof Error ? error : new Error(String(error));
          
          if (attempt < MAX_RETRIES) {
            // Retry on error
            await new Promise(r => setTimeout(r, 1000 * (attempt + 1))); // Exponential backoff
          } else {
            // All retries exhausted
            batchText = `[Batch ${batchIndex + 1}: Transcription failed - ${lastError.message}]`;
          }
        }
      }

      if (batchText) {
        results.push(batchText);
      }
    }

    const finalText = results
      .filter(r => r && r.trim().length > 0)
      .join("\n\n");
    
    if (finalText.trim().length === 0 || finalText.includes("No text extracted") && results.length === batches.length) {
      throw new Error(
        "Unable to extract text from the document. This may happen if:\n" +
        "1. The image quality is too low or too dark\n" +
        "2. The document is blank or contains only images\n" +
        "3. The text is in an unsupported language\n\n" +
        "Try re-uploading with a clearer, higher-resolution scan."
      );
    }

    return { text: finalText };
  });
