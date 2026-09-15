import { createFileRoute } from "@tanstack/react-router";
import { createClient } from "@supabase/supabase-js";
import { z } from "zod";
import { geminiThinkingConfig, reasoningEffortParam, thinkingHeadroom } from "@/lib/reasoning";
import { fetchWithTimeout } from "@/lib/ai-fetch";
import { anonymousAiAllowed, ensureServerEnv, readServerKey } from "@/lib/load-env";
import { quotaNotice, quotaNoticeBody } from "@/lib/provider-policy";

const GATEWAY = "https://ai.gateway.lovable.dev/v1/chat/completions";

/** Hard bound on how long a single provider call may wait for response headers. */
const REQUEST_TIMEOUT_MS = 45_000;

/** Same behaviour as the notebook: try the shared allowance first, then cheaper models. */
const MODEL_CHAIN = ["google/gemini-3.6-flash", "google/gemini-3.5-flash-lite"];

/** Project's own Gemini key (direct Google API) — FIRST priority on every request. */
const GOOGLE_MODEL_CHAIN = [
  "gemini-3.6-flash",
  "gemini-2.0-flash",
  "gemini-3.5-flash-lite",
  "gemini-flash-latest",
  "gemini-3.1-pro-preview",
];

/**
 * Project's Groq key — last resort after Gemini and the gateway.
 * llama-3.1 / llama-3.3 chat SKUs were shut down 2026-08-16; use production replacements.
 */
const GROQ_MODEL_CHAIN = ["openai/gpt-oss-120b", "openai/gpt-oss-20b"];
const Body = z.object({
  system: z.string().min(1),
  user: z.string().min(1),
  tokens: z.number().int().positive().max(32000).optional(),
});

export const Route = createFileRoute("/api/public/icap")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        ensureServerEnv();

        // ANONYMOUS AI ACCESS IS OFF BY DEFAULT (ENABLE_PUBLIC_ICAP=false).
        // This endpoint spends the deployment's AI allowance, so an unauthenticated
        // caller could drain it. Until a deployment opts in, only a signed-in
        // notebook user (same Supabase session as /api/study) may call it.
        if (!anonymousAiAllowed()) {
          const authHeader = request.headers.get("authorization");
          if (!authHeader) {
            return new Response(
              "Public AI access is disabled. Sign in to Study Desk to use this tool, or set ENABLE_PUBLIC_ICAP=true in the deployment to allow anonymous access.",
              { status: 403, headers: { "X-Study-Access": "authenticated-only" } },
            );
          }
          const url = process.env["SUPABASE_URL"];
          const anon = process.env["SUPABASE_PUBLISHABLE_KEY"] ?? process.env["SUPABASE_ANON_KEY"];
          if (!url || !anon) {
            return new Response("Not configured", { status: 500 });
          }
          const supabase = createClient(url, anon, {
            global: { headers: { Authorization: authHeader, apikey: anon } },
            auth: { persistSession: false, autoRefreshToken: false },
          });
          const { data: userData } = await supabase.auth.getUser();
          if (!userData.user?.id) return new Response("Unauthorized", { status: 401 });
        }

        const parsed = Body.safeParse(await request.json().catch(() => null));
        if (!parsed.success) return new Response("Bad request", { status: 400 });
        const { system, user, tokens } = parsed.data;
        const apiKey = readServerKey("LOVABLE_API_KEY");
        const googleKey = readServerKey("GOOGLE_API_KEY", "GEMINI_API_KEY");
        let lastStatus = 0;
        let lastBody = "";
        let googleTried = false;

        // Thinking tokens are billed against the output cap, so a cap sized for
        // the answer alone would be truncated mid-sentence.
        const maxOut = Math.round((tokens ?? 1000) * 1.8) + thinkingHeadroom("ask");

        // 1) FIRST PRIORITY — the project's own Gemini key (user-provided API key,
        // e.g. a Google AI Studio key). A success returns immediately; any failure
        // falls through to the shared gateway below so the request still has a chance.
        if (googleKey) {
          googleTried = true;
          for (const model of GOOGLE_MODEL_CHAIN) {
            const res = await fetchWithTimeout(
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
                    maxOutputTokens: maxOut,
                    ...(geminiThinkingConfig(model, "ask") ?? {}),
                  },
                }),
              },
              REQUEST_TIMEOUT_MS,
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

        // The Gemini key was already tried first above — this is only a safety net
        // for paths that never attempted it (i.e. no key existed at step 1).
        if (!googleTried && (lastStatus === 402 || lastStatus === 429 || lastStatus === 401)) {
          if (googleKey) {
            for (const model of GOOGLE_MODEL_CHAIN) {
              const res = await fetchWithTimeout(
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
                      maxOutputTokens: maxOut,
                      ...(geminiThinkingConfig(model, "ask") ?? {}),
                    },
                  }),
                },
                REQUEST_TIMEOUT_MS,
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

        // Google key also exhausted, timed out, or rate limited — fall back to Groq.
        // Always attempt Groq when personal keys exist and we still have no answer,
        // including the 402 (Lovable credits out) and network-timeout paths.
        if (
          lastStatus === 402 ||
          lastStatus === 429 ||
          lastStatus === 401 ||
          lastStatus === 503 ||
          lastStatus === 502 ||
          lastStatus === 404 ||
          lastStatus === 0
        ) {
          const groqKey = readServerKey("GROQ_API_KEY");
          if (groqKey) {
            for (const model of GROQ_MODEL_CHAIN) {
              try {
                const res = await fetchWithTimeout(
                  "https://api.groq.com/openai/v1/chat/completions",
                  {
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
                  },
                  REQUEST_TIMEOUT_MS,
                );
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
                // 404 = retired model id — try the next one.
                if (res.status !== 429 && res.status !== 503 && res.status !== 404) break;
                if (res.status !== 404) await new Promise((r) => setTimeout(r, 800));
              } catch (err) {
                lastStatus = 504;
                lastBody = err instanceof Error ? err.message : "Groq timed out or unreachable";
                continue;
              }
            }
          }
        }

        // 2) Shared Lovable gateway — tried when no Gemini key is set, or when the
        // Gemini key failed above.
        if (apiKey) {
          for (const model of MODEL_CHAIN) {
            const post = (withReasoning: boolean) =>
              fetchWithTimeout(
                GATEWAY,
                {
                  method: "POST",
                  headers: {
                    Authorization: `Bearer ${apiKey}`,
                    "Content-Type": "application/json",
                  },
                  body: JSON.stringify({
                    model,
                    temperature: 0,
                    max_tokens: maxOut,
                    ...(withReasoning ? reasoningEffortParam("ask") : {}),
                    messages: [
                      { role: "system", content: system },
                      { role: "user", content: user },
                    ],
                  }),
                },
                REQUEST_TIMEOUT_MS,
              );
            let res = await post(true);
            // Gateway without `reasoning_effort` support answers 400/422 —
            // retry once without the knob rather than giving up on the model.
            if (res.status === 400 || res.status === 422) res = await post(false);
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
        } else if (!googleTried) {
          lastStatus = 401;
          lastBody = "AI is not configured.";
        }

        // Quota and rate limits are reported through the shared provider policy:
        // the user is told the allowance ran out, that nothing was purchased to
        // work around it, and what to configure. A failed run never returns text.
        const notice = quotaNotice(lastStatus, {
          personalKeys: {
            gemini: !!readServerKey("GOOGLE_API_KEY", "GEMINI_API_KEY"),
            groq: !!readServerKey("GROQ_API_KEY"),
            grok: !!readServerKey("GROK_API_KEY", "XAI_API_KEY"),
          },
        });
        const message =
          lastStatus === 402 || lastStatus === 429 || lastStatus === 403
            ? quotaNoticeBody(notice, [lastBody.slice(0, 200)].filter(Boolean))
            : `AI request failed (${lastStatus}). ${lastBody.slice(0, 200)}`;
        return new Response(message, {
          status: lastStatus === 429 ? 429 : notice.status === 402 ? 402 : 502,
        });
      },
    },
  },
});
