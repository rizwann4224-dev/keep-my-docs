import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";

const GATEWAY = "https://ai.gateway.lovable.dev/v1/chat/completions";

/** Same behaviour as the notebook: try the shared allowance first, then cheaper models. */
const MODEL_CHAIN = [
  "google/gemini-3.6-flash",
  "google/gemini-2.5-flash",
  "google/gemini-2.5-flash-lite",
];

/** Personal-key fallback (direct Google API) used only when the shared allowance runs out. */
const GOOGLE_MODEL_CHAIN = ["gemini-3.6-flash", "gemini-3.5-flash", "gemini-flash-latest"];

/** Second personal-key fallback (direct Groq API) used when Google is also exhausted. */
const GROQ_MODEL_CHAIN = ["llama-3.3-70b-versatile", "llama-3.1-8b-instant"];

const Body = z.object({
  system: z.string().min(1),
  user: z.string().min(1),
  tokens: z.number().int().positive().max(32000).optional(),
});

export const Route = createFileRoute("/api/public/icap")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const parsed = Body.safeParse(await request.json().catch(() => null));
        if (!parsed.success) return new Response("Bad request", { status: 400 });
        const { system, user, tokens } = parsed.data;

        const apiKey = process.env["LOVABLE_API_KEY"];
        let lastStatus = 0;
        let lastBody = "";

        if (apiKey) {
          for (const model of MODEL_CHAIN) {
            const res = await fetch(GATEWAY, {
              method: "POST",
              headers: {
                Authorization: `Bearer ${apiKey}`,
                "Content-Type": "application/json",
              },
              body: JSON.stringify({
                model,
                temperature: 0,
                max_tokens: Math.round((tokens ?? 1000) * 1.8),
                messages: [
                  { role: "system", content: system },
                  { role: "user", content: user },
                ],
              }),
            });
            if (res.ok) {
              const json = (await res.json()) as {
                choices?: { message?: { content?: string } }[];
              };
              const text = json.choices?.[0]?.message?.content ?? "";
              if (text.trim()) {
                return Response.json({ text, source: "lovable", model });
              }
              lastStatus = 502;
              lastBody = "Empty reply from the AI.";
              continue;
            }
            lastStatus = res.status;
            lastBody = await res.text().catch(() => "");
            // Only credit/rate-limit problems are worth trying a cheaper model for.
            if (res.status !== 402 && res.status !== 429) break;
            if (res.status === 429) await new Promise((r) => setTimeout(r, 800));
          }
        } else {
          lastStatus = 401;
          lastBody = "AI is not configured.";
        }

        // Shared allowance exhausted or rate limited — fall back to the free key.
        if (lastStatus === 402 || lastStatus === 429 || lastStatus === 401) {
          const googleKey = process.env["GEMINI_API_KEY"];
          if (googleKey) {
            for (const model of GOOGLE_MODEL_CHAIN) {
              const res = await fetch(
                `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`,
                {
                  method: "POST",
                  headers: {
                    "Content-Type": "application/json",
                    "x-goog-api-key": googleKey,
                  },
                  body: JSON.stringify({
                    system_instruction: { parts: [{ text: system }] },
                    contents: [{ role: "user", parts: [{ text: user }] }],
                    generationConfig: {
                      maxOutputTokens: Math.round((tokens ?? 1000) * 1.8),
                    },
                  }),
                },
              );
              if (res.ok) {
                const json = (await res.json()) as {
                  candidates?: { content?: { parts?: { text?: string }[] } }[];
                };
                const text = (json.candidates?.[0]?.content?.parts ?? [])
                  .map((p) => p.text ?? "")
                  .join("\n")
                  .trim();
                if (text) return Response.json({ text, source: "google", model });
                lastStatus = 502;
                lastBody = "Empty reply from the fallback model.";
                continue;
              }
              lastStatus = res.status;
              lastBody = await res.text().catch(() => "");
              if (res.status !== 429 && res.status !== 503) break;
              await new Promise((r) => setTimeout(r, 800));
            }
          }
        }

        // Google key also exhausted or rate limited — fall back to the Groq key.
        if (lastStatus === 402 || lastStatus === 429 || lastStatus === 401 || lastStatus === 503) {
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
                  temperature: 0,
                  max_tokens: Math.round((tokens ?? 1000) * 1.8),
                  messages: [
                    { role: "system", content: system },
                    { role: "user", content: user },
                  ],
                }),
              });
              if (res.ok) {
                const json = (await res.json()) as {
                  choices?: { message?: { content?: string } }[];
                };
                const text = (json.choices?.[0]?.message?.content ?? "").trim();
                if (text) return Response.json({ text, source: "groq", model });
                lastStatus = 502;
                lastBody = "Empty reply from the Groq model.";
                continue;
              }
              lastStatus = res.status;
              lastBody = await res.text().catch(() => "");
              if (res.status !== 429 && res.status !== 503) break;
              await new Promise((r) => setTimeout(r, 800));
            }
          }
        }

        const message =
          lastStatus === 402
            ? "AI credits are used up and the backup key is unavailable — add credits or switch the provider dropdown to your own key."
            : lastStatus === 429
              ? "The AI is busy right now — try again in a few seconds."
              : `AI request failed (${lastStatus}). ${lastBody.slice(0, 200)}`;
        return new Response(message, { status: lastStatus === 429 ? 429 : 502 });
      },
    },
  },
});
