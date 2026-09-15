import { createHash } from "node:crypto";

import { createFileRoute } from "@tanstack/react-router";
import { createClient } from "@supabase/supabase-js";
import { z } from "zod";
import {
  askSystemPrompt,
  classificationJsonSchema,
  performanceClassificationPrompt,
  type ClassifiableAttempt,
  buildCoverageBlock,
  buildLessonsBlock,
  challengeSystemPrompt,
  countSubmissionQuestions,
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
import {
  ensureServerEnv,
  readServerKey,
  withPreferredModel,
  preferredGeminiModel,
} from "@/lib/load-env";
import {
  isClassificationComplete,
  shouldPersistVerdict,
  stripMarkers,
  withMarker,
} from "@/lib/stream-safety";
import { quotaNotice, quotaNoticeBody, quotaResponseStatus } from "@/lib/provider-policy";
import {
  canonicalTopicName,
  canonicalTopicsFrom,
  parseClassificationReport,
  parseMarksFromReport,
  toRows,
  type BreakdownRow,
} from "@/lib/performance-model";

const GATEWAY = "https://ai.gateway.lovable.dev/v1/chat/completions";

/** Tried in order — if the budget for one model is exhausted, fall back to a cheaper one. */
const MODEL_CHAIN = ["google/gemini-3.6-flash", "google/gemini-3.5-flash-lite"];

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
const GOOGLE_MODEL_CHAIN = withPreferredModel(
  [
    "gemini-3.6-flash",
    "gemini-2.0-flash",
    "gemini-3.5-flash-lite",
    "gemini-flash-latest",
    "gemini-3.1-pro-preview",
  ],
  preferredGeminiModel(),
);

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

/**
 * Groq's on-demand tier limits a single request to ~8000 tokens per minute, so
 * the full notebook context must be trimmed before it is sent there. Roughly
 * 4 chars/token, minus room for the reply.
 */
const GROQ_MAX_PROMPT_CHARS = 18_000;

/** Keep the head (instructions) and tail (most relevant extract) of a prompt. */
function clampForGroq(text: string, max: number): string {
  if (text.length <= max) return text;
  const head = Math.floor(max * 0.6);
  const tail = max - head;
  return `${text.slice(0, head)}\n\n…[context trimmed to fit the fallback model's size limit]…\n\n${text.slice(-tail)}`;
}

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
  mode: z.enum(["ask", "mark", "insights", "exam", "challenge", "classify"]),
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

// ---- Deterministic marking cache -----------------------------------------
// Re-marking the SAME question + answer at the SAME severity must return the
// SAME marks. A live model call can never guarantee that (sampling variance and
// the fallback chain may even serve a different model), so an identical repeat
// submission replays its previous verdict verbatim instead of being re-rolled.
// Freshness guards invalidate the replay when the notebook changed (new source
// documents or new flagged lessons), because those legitimately change marking.

/** Every section a full marking run can produce, in prompt order. */
const ALL_MARK_PARTS: MarkPart[] = ["feedback", "marks", "suggested", "recommendations"];

/** Whitespace and case differences never change a mark. */
const normalizeForCache = (text: string | null | undefined): string =>
  (text ?? "").replace(/\s+/g, " ").trim().toLowerCase();

/**
 * A stable fingerprint of everything that legitimately changes a verdict. It is
 * appended to the stored marking output as an HTML comment (invisible in the
 * rendered markdown, and stripped again before the verdict is replayed), so a
 * repeat submission is matched EXACTLY instead of being re-derived by parsing
 * headings out of the previous output — heading-sniffing is what used to let an
 * unchanged submission fall through to a freshly sampled, differently scored
 * re-mark.
 */
const MARK_FINGERPRINT_RE = /\n?<!--\s*mark-fingerprint:([^\s>]+)\s*-->\s*$/;

function markFingerprint(input: {
  mode: string;
  subjectId: string;
  question: string;
  userAnswer?: string | undefined;
  parts?: MarkPart[] | undefined;
  rigour?: Rigour | undefined;
  challengeQuery?: string | undefined;
  originalEvaluation?: string | undefined;
}): string {
  const parts = (input.parts?.length ? [...input.parts] : ALL_MARK_PARTS).sort().join(",");
  const payload = [
    input.mode,
    input.subjectId,
    input.rigour ?? "strict",
    parts,
    normalizeForCache(input.question),
    normalizeForCache(input.userAnswer),
    normalizeForCache(input.challengeQuery),
    normalizeForCache(input.originalEvaluation),
  ].join("\u0000");
  return createHash("sha256").update(payload).digest("hex").slice(0, 32);
}

/** The fingerprint stored with a saved verdict, if it carries one. */
const fingerprintOfStored = (response: string): string | null =>
  MARK_FINGERPRINT_RE.exec(response)?.[1] ?? null;

/** The verdict as the candidate should see it — without the fingerprint marker. */
const stripFingerprint = (response: string): string =>
  response.replace(MARK_FINGERPRINT_RE, "").trimEnd();

/** Severity a stored marking output was produced under (its declaration line). */
function severityOfMarking(response: string): Rigour | null {
  const match = /\bSeverity:\s*(MODERATE|STRICT|HARD)\b/i.exec(response);
  return match ? (match[1]!.toLowerCase() as Rigour) : null;
}

/** Which of the four output sections a stored marking response contains. */
function partsOfMarking(response: string): Set<string> {
  const found = new Set<string>();
  if (/^#{1,4}\s*🔍/m.test(response) || /Item-by-Item Detailed Marking/i.test(response))
    found.add("feedback");
  if (/^#{1,4}\s*📊/m.test(response)) found.add("marks");
  if (/^#{1,4}\s*✅/m.test(response)) found.add("suggested");
  if (/^#{1,4}\s*🎯/m.test(response)) found.add("recommendations");
  return found;
}

/** Structural minimum of the Supabase query builder the replay lookup uses
 *  (the client here is created without Database types, so its rows are untyped). */
type ReplayRows = { data: unknown; error?: unknown };
type ReplayQuery = {
  eq: (column: string, value: string) => ReplayQuery;
  order: (column: string, options: { ascending: boolean }) => ReplayQuery;
  limit: (count: number) => PromiseLike<ReplayRows>;
};
type ReplaySupabase = { from: (table: string) => { select: (columns: string) => ReplayQuery } };

type MarkingRow = { user_answer: string | null; response: string; created_at: string };

/**
 * The stored verdict for an identical earlier submission, or null. A replay
 * requires ALL of: same subject, same question, same answer, same severity,
 * same requested sections, and no new documents/lessons recorded since it.
 *
 * Matching is primarily by the exact fingerprint stored with the verdict. The
 * older heading-sniffing path is kept only for verdicts saved before
 * fingerprints existed — it is approximate, and an unchanged submission whose
 * stored output merely formatted its headings differently used to slip past it
 * and get re-marked live (producing different marks for identical input).
 */
async function findMarkingReplay(
  supabase: ReplaySupabase,
  data: {
    subjectId: string;
    mode: "mark" | "challenge";
    question: string;
    userAnswer?: string | undefined;
    parts?: MarkPart[] | undefined;
    rigour?: Rigour | undefined;
    challengeQuery?: string | undefined;
    originalEvaluation?: string | undefined;
  },
): Promise<{ response: string; createdAt: string } | null> {
  const rigour = data.rigour ?? "strict";
  const parts = (data.parts?.length ? [...data.parts] : ALL_MARK_PARTS).sort();
  const wanted = markFingerprint(data);
  const rowsResult = await supabase
    .from("qa_entries")
    .select("user_answer, response, created_at")
    .eq("subject_id", data.subjectId)
    .eq("mode", data.mode)
    .eq("question", data.question)
    .order("created_at", { ascending: false })
    .limit(10);
  const rows = (rowsResult.data ?? []) as MarkingRow[];
  if (rows.length === 0) return null;

  const answer = normalizeForCache(data.userAnswer ?? "");
  // Exact match first: identical inputs, byte-for-byte identical verdict.
  const match =
    rows.find((row) => fingerprintOfStored(row.response) === wanted) ??
    // Legacy verdicts (no fingerprint stored) fall back to structural matching.
    rows.find((row) => {
      if (fingerprintOfStored(row.response) !== null) return false;
      if (data.mode !== "mark") return false;
      if (normalizeForCache(row.user_answer) !== answer) return false;
      if (severityOfMarking(row.response) !== rigour) return false;
      const have = partsOfMarking(row.response);
      return parts.length > 0 && parts.every((p) => have.has(p)) && have.size === parts.length;
    });
  if (!match) return null;

  // The notebook moved on after that verdict — new source documents or flagged
  // lessons change what the marker must apply, so re-mark live instead.
  const [docResult, noteResult] = await Promise.all([
    supabase
      .from("documents")
      .select("created_at")
      .eq("subject_id", data.subjectId)
      .order("created_at", { ascending: false })
      .limit(1),
    supabase
      .from("learning_notes")
      .select("created_at")
      .eq("subject_id", data.subjectId)
      .order("created_at", { ascending: false })
      .limit(1),
  ]);
  const newestDocAt = ((docResult.data ?? []) as { created_at?: string }[])[0]?.created_at ?? "";
  const newestNoteAt = ((noteResult.data ?? []) as { created_at?: string }[])[0]?.created_at ?? "";
  if (newestDocAt > match.created_at || newestNoteAt > match.created_at) return null;

  return { response: stripFingerprint(match.response), createdAt: match.created_at };
}

/** How an upstream response frames its body. */
export type StreamSource = "gateway" | "google" | "google-plain" | "groq" | "grok";

/** One SSE payload → the answer text it carries (reasoning parts are skipped). */
export function deltaFromPayload(source: StreamSource, payload: string): string {
  if (!payload || payload === "[DONE]") return "";
  try {
    const json = JSON.parse(payload) as {
      choices?: { delta?: { content?: string } }[];
      candidates?: { content?: { parts?: { text?: string; thought?: boolean }[] } }[];
    };
    if (source === "google") {
      // Reasoning summaries arrive as parts flagged `thought: true` — scaffolding,
      // not the answer.
      return (json.candidates?.[0]?.content?.parts ?? [])
        .filter((part) => !part.thought)
        .map((part) => part.text ?? "")
        .join("");
    }
    return json.choices?.[0]?.delta?.content ?? "";
  } catch {
    return "";
  }
}

export type CollectedStream = {
  text: string;
  /** True when the upstream body ended by error rather than by finishing. */
  interrupted: boolean;
  /** True once the provider sent its own `[DONE]` sentinel, when it sends one. */
  sawDone: boolean;
};

/**
 * Drain an upstream stream into a string.
 *
 * Used by modes whose result must be whole before it is trusted (classification):
 * the caller gets `interrupted: true` for any stream that ended by throwing, so a
 * half-received body can never be mistaken for a finished one.
 */
export async function collectUpstreamText(
  upstream: Response,
  source: StreamSource,
): Promise<CollectedStream> {
  const decoder = new TextDecoder();
  let text = "";
  let buffer = "";
  let interrupted = false;
  let sawDone = false;
  const body = upstream.body;
  if (!body) return { text: "", interrupted: true, sawDone: false };
  const reader = body.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      if (source === "google-plain") {
        text += decoder.decode(value, { stream: true });
        continue;
      }
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed.startsWith("data:")) continue;
        const payload = trimmed.slice(5).trim();
        if (payload === "[DONE]") {
          sawDone = true;
          continue;
        }
        text += deltaFromPayload(source, payload);
      }
    }
    if (buffer.trim().startsWith("data:")) {
      const payload = buffer.trim().slice(5).trim();
      if (payload === "[DONE]") sawDone = true;
      else text += deltaFromPayload(source, payload);
    }
    if (source === "google-plain") text += decoder.decode();
  } catch (error) {
    interrupted = true;
    console.error(
      `[study] upstream stream failed mid-body: ${error instanceof Error ? error.message : String(error)}`,
    );
    // Release the reader; the collected prefix is discarded by the caller.
    try {
      await reader.cancel();
    } catch {
      /* ignore */
    }
  }
  return { text, interrupted, sawDone };
}

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

        // Deterministic marking: the identical question + answer, re-submitted at
        // the same severity, replays its previous verdict verbatim — same marks,
        // guaranteed — instead of re-rolling a live model that may sample (or be
        // served by a different fallback model) differently. Any change to the
        // severity, the answer, the requested sections, or the notebook's
        // documents/lessons falls through to a fresh live marking below.
        if (data.mode === "mark" || data.mode === "challenge") {
          try {
            const cached = await findMarkingReplay(supabase as unknown as ReplaySupabase, {
              subjectId: data.subjectId,
              mode: data.mode,
              question: data.question,
              userAnswer: data.userAnswer,
              parts: data.parts as MarkPart[] | undefined,
              rigour: data.rigour as Rigour | undefined,
              challengeQuery: data.challengeQuery,
              originalEvaluation: data.originalEvaluation,
            });
            if (cached) {
              console.error(
                `[study] mark replay — identical submission at the same severity, reusing verdict from ${cached.createdAt}`,
              );
              const encoder = new TextEncoder();
              const body = new ReadableStream<Uint8Array>({
                start(controller) {
                  controller.enqueue(encoder.encode(cached.response));
                  controller.close();
                },
              });
              return new Response(body, {
                headers: {
                  "Content-Type": "text/plain; charset=utf-8",
                  "Cache-Control": "no-cache, no-transform",
                  "X-Accel-Buffering": "no",
                  "X-Study-Model": "replay (identical submission → identical marks; no model call)",
                },
              });
            }
          } catch (err) {
            // The replay path must never break live marking — a lookup hiccup
            // simply means this request is marked fresh.
            console.error(
              `[study] mark replay lookup failed, marking live: ${err instanceof Error ? err.message : String(err)}`,
            );
          }
        }

        // Insights never reads source documents — skipping the (large) extracted_text
        // fetch is the single biggest latency win for the diagnostic. Classification
        // needs the documents only for their syllabus/contents headings, so it fetches
        // them (names always; text is truncated per document below).
        const wantsDocuments = data.mode !== "insights";
        const [{ data: docs }, { data: notes }] = await Promise.all([
          wantsDocuments
            ? supabase
                .from("documents")
                .select("name, extracted_text")
                .eq("subject_id", data.subjectId)
            : Promise.resolve({ data: [] as { name: string; extracted_text: string }[] }),
          supabase
            .from("learning_notes")
            .select("content")
            .eq("subject_id", data.subjectId)
            .order("created_at", { ascending: true }),
        ]);

        const lessons = buildLessonsBlock(notes ?? []);

        let system: string;
        // Detect a full-paper submission before any prompt is built (cheap; used
        // by both retrieval and the user-content manifest below).
        const questionCount = data.mode === "mark" ? countSubmissionQuestions(data.question) : 0;
        // Hand the marker the manifest explicitly so it cannot mark Q.1 and stop.
        const manifestHint =
          questionCount >= 2
            ? `\n\nSUBMISSION MANIFEST (detected automatically): this submission contains ${questionCount} distinct numbered questions. Per MULTI-QUESTION SUBMISSIONS you MUST mark EVERY one of them separately — each question gets its own source sweep, mark plan, item feedback, marks rows and subtotal, followed by the GRAND TOTAL row. Marking only question 1 is a failed evaluation.`
            : "";

        /** Rows the classification report must cover, one per marked attempt. */
        let classificationAttempts: ClassifiableAttempt[] = [];

        if (data.mode === "classify") {
          const { data: marked, error: markedError } = await supabase
            .from("qa_entries")
            .select("id, question, user_answer, response, created_at")
            .eq("subject_id", data.subjectId)
            .eq("mode", "mark")
            .order("created_at", { ascending: true })
            .limit(500);
          if (markedError) {
            return new Response(`Could not read your marked attempts: ${markedError.message}`, {
              status: 500,
            });
          }
          classificationAttempts = (marked ?? []).map((row, index) => {
            const entry = row as {
              id: string;
              question: string;
              user_answer: string | null;
              response: string;
              created_at: string;
            };
            const marks = parseMarksFromReport(stripMarkers(entry.response));
            return {
              index: index + 1,
              question: entry.question,
              answer: entry.user_answer ?? "",
              response: stripMarkers(entry.response),
              created_at: entry.created_at,
              awarded: marks.awarded,
              available: marks.available,
            };
          });
          if (classificationAttempts.length === 0) {
            return new Response(
              "Nothing to classify yet — mark at least one answer in Answer & marking first.",
              { status: 400 },
            );
          }
          system = performanceClassificationPrompt(
            classificationAttempts,
            canonicalTopicsFrom(docs ?? []),
            // Topic naming needs the syllabus/contents pages, not the whole library:
            // each document contributes its opening (contents/headings) only.
            buildCoverageBlock(
              (docs ?? []).map((doc) => ({
                name: doc.name,
                extracted_text: (doc.extracted_text ?? "").slice(0, 24_000),
              })),
              120_000,
            ),
          );
        } else if (data.mode === "insights") {
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
          // A full past paper pasted in one go (several numbered questions, each
          // with an answer) needs EVEN coverage of every source: keyword
          // retrieval ranks question 1's passages highest and starves the later
          // questions' official answers and marking guides — which is exactly
          // why only Q.1 used to get marked. Even coverage gives every
          // question's scenario, suggested answer and marking guide a seat.
          const sources =
            data.mode === "mark" && questionCount >= 2
              ? buildCoverageBlock(docs ?? [], budget)
              : buildRelevantSourceBlock(docs ?? [], retrievalQuery, budget);
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
          data.mode === "classify"
            ? `Classify all ${classificationAttempts.length} marked attempt${
                classificationAttempts.length === 1 ? "" : "s"
              } now. Output ONLY the JSON array: one object per marked part, every attempt covered, marks exactly as the reports state them (null when they never were).`
            : data.mode === "insights"
              ? "Produce the performance diagnostic now."
              : data.mode === "mark"
                ? `QUESTION / SCENARIO:\n${data.question}\n\nCANDIDATE'S ANSWER:\n${data.userAnswer?.trim() || "(no answer provided — produce only the requested sections)"}${manifestHint}`
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
        let source: StreamSource = "gateway";
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

            // Classification answers must be parseable JSON. Gemini is asked for it
            // natively (responseMimeType), and additionally constrained by the
            // record schema — dropped on the first 400, because a model that
            // rejects the schema must still be able to answer.
            let useJsonSchema = data.mode === "classify";
            const jsonConfig = (): Record<string, unknown> =>
              data.mode === "classify"
                ? {
                    responseMimeType: "application/json",
                    ...(useJsonSchema ? { responseSchema: classificationJsonSchema() } : {}),
                  }
                : {};

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
                generationConfig: geminiGenerationConfig(model, mode, jsonConfig()),
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
                  // Attempt 2: streaming with thinking off (config rejection) — and
                  // without the JSON schema, the other thing a model may reject.
                  useJsonSchema = false;
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
                      // Marking must be reproducible: the same script marked
                      // again has to score the same, so mark/challenge sample
                      // greedily instead of at the conversational default.
                      temperature: data.mode === "mark" || data.mode === "challenge" ? 0 : 0.3,
                      ...(data.mode === "mark" || data.mode === "challenge" ? { top_p: 0.1 } : {}),
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
              // 413 = still over this model's per-minute token cap; the smaller
              // model in the chain may accept it, so keep walking.
              if (
                res.status !== 429 &&
                res.status !== 503 &&
                res.status !== 404 &&
                res.status !== 413
              )
                break;
              if (res.status !== 404 && res.status !== 413)
                await new Promise((r) => setTimeout(r, 800));
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
                  headers: {
                    Authorization: `Bearer ${apiKey}`,
                    "Content-Type": "application/json",
                  },
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
          // Every path tried and failed. The HTTP code follows the gateway's
          // quota/rate status, and the message reports the actual failures of the
          // gateway AND the configured fallbacks, so "GEMINI_API_KEY is set but
          // still failing" is visible instead of a blanket "unavailable".
          const hasGemini = !!readKey("GOOGLE_API_KEY", "GEMINI_API_KEY");
          const hasGroq = !!readKey("GROQ_API_KEY");
          const hasGrok = !!readKey("GROK_API_KEY", "XAI_API_KEY");
          const reasons = [
            gatewayError,
            googleError,
            groqError,
            grokError,
            !hasGemini && !googleError
              ? "no GEMINI_API_KEY is set, so the Google fallback was never attempted"
              : "",
            !hasGroq ? "no GROQ_API_KEY is set in the deployment" : "",
            !hasGrok && !hasGemini ? "no GROK_API_KEY / XAI_API_KEY is set" : "",
          ].filter(Boolean);

          const notice = quotaNotice(gatewayStatus || 0, {
            personalKeys: { gemini: hasGemini, groq: hasGroq, grok: hasGrok },
            unconfigured: !hasGemini && !hasGroq && !hasGrok && !apiKey,
          });
          const message = quotaNoticeBody(notice, reasons);
          const status = quotaResponseStatus(notice, hasGemini || hasGroq || hasGrok);
          console.error(
            `[study] every provider failed (${status}) — ${reasons.join(" | ").slice(0, 400)}`,
          );
          return new Response(message, { status });
        }

        // ---- classification: validated JSON, never a partial report -----------
        // The response is collected, parsed and schema-checked HERE, so what the
        // charts receive has already been validated. An interrupted stream, a
        // truncated array or an omitted attempt is a failure (422/502) — the app
        // never receives "records" it should trust. Nothing is written to
        // qa_entries for this mode.
        if (data.mode === "classify") {
          const collected = await collectUpstreamText(upstream, source);
          if (collected.interrupted) {
            return new Response(
              "The classification stream was interrupted, so it was discarded — nothing was saved.",
              { status: 502 },
            );
          }
          const expected = classificationAttempts.map((a) => a.index);
          const report = parseClassificationReport(collected.text, expected);
          const canonical = canonicalTopicsFrom(docs ?? []);
          const canonicalized = report.records.map((record) => {
            const match = canonicalTopicName(record.topic, canonical);
            return match && match !== record.topic ? { ...record, topic: match } : record;
          });
          if (report.rejected.length > 0) {
            console.error(
              `[study] classification rejected ${report.rejected.length} row(s): ${report.rejected
                .map((r) => `#${r.index + 1} ${r.reason}`)
                .join(" | ")
                .slice(0, 400)}`,
            );
          }

          if (!report.complete) {
            return new Response(
              report.error ?? "The classification report was not usable and nothing was saved.",
              { status: 422 },
            );
          }

          const rows: BreakdownRow[] = toRows(canonicalized);
          return new Response(
            JSON.stringify({
              rows,
              rejected: report.rejected.map((r) => ({ row: r.index + 1, reason: r.reason })),
              needsReview: report.needsReview.map((r) => ({
                attempt: r.attempt,
                part: r.part,
                because:
                  r.confidence === "low"
                    ? "low-confidence topic match"
                    : r.awarded === null || r.available === null
                      ? "marks were never stated"
                      : "invalid marks",
              })),
              attemptsClassified: new Set(rows.map((r) => r.attempt)).size,
              attemptsExpected: expected.length,
              canonicalTopics: canonical,
              model: servedModel,
            }),
            {
              status: 200,
              headers: {
                "Content-Type": "application/json",
                "Cache-Control": "no-store",
                "X-Study-Model": servedModel,
              },
            },
          );
        }

        const encoder = new TextEncoder();
        const decoder = new TextDecoder();
        let full = "";
        let buffer = "";

        const stream = new ReadableStream<Uint8Array>({
          async start(controller) {
            const reader = upstream.body!.getReader();
            let streamError: string | null = null;
            let sawDone = false;
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
                    if (payload === "[DONE]") {
                      sawDone = true;
                      continue;
                    }
                    const delta = deltaFromPayload(source, payload);
                    if (delta) {
                      full += delta;
                      controller.enqueue(encoder.encode(delta));
                    }
                  }
                }
              } // end SSE branch
            } catch (error) {
              // The upstream died mid-body. Everything below treats this run as a
              // FAILURE: no history row, and a sentinel so the browser can say so.
              streamError =
                error instanceof Error ? error.message : "the stream ended unexpectedly";
            } finally {
              const streamCompleted = streamError === null;
              const decision = shouldPersistVerdict({
                mode: data.mode,
                text: full,
                streamCompleted,
                requestedParts: data.parts as MarkPart[] | undefined,
                quotaFailure: gatewayStatus === 402,
              });

              if (!decision.persist && decision.marker) {
                // Tell the browser this is not a finished answer. Appended at the
                // tail so live text is untouched while it streams.
                try {
                  controller.enqueue(
                    encoder.encode(
                      `\n\n${decision.marker}${decision.reason ? ` (${decision.reason})` : ""}`,
                    ),
                  );
                } catch {
                  /* the client is already gone */
                }
              }

              // Save BEFORE closing the stream: once the response closes the
              // worker can be torn down and a pending insert would be dropped.
              if (decision.persist) {
                // Marking verdicts carry their input fingerprint so an identical
                // resubmission replays this exact verdict instead of being
                // re-marked live (which would sample different marks). The
                // marker is an HTML comment: invisible in the rendered output,
                // and stripped again on replay.
                const stamped =
                  data.mode === "mark" || data.mode === "challenge"
                    ? `${full}\n<!-- mark-fingerprint:${markFingerprint({
                        mode: data.mode,
                        subjectId: data.subjectId,
                        question: data.question,
                        userAnswer: data.userAnswer,
                        parts: data.parts as MarkPart[] | undefined,
                        rigour: data.rigour as Rigour | undefined,
                        challengeQuery: data.challengeQuery,
                        originalEvaluation: data.originalEvaluation,
                      })} -->`
                    : full;
                const { error } = await supabase.from("qa_entries").insert({
                  user_id: userId,
                  subject_id: data.subjectId,
                  mode: data.mode,
                  question: data.question,
                  user_answer: data.userAnswer ?? null,
                  response: stamped,
                });
                if (error) console.error("qa_entries insert failed", error.message);
              } else if (data.mode !== "insights" && data.mode !== "classify") {
                console.error(
                  `[study] run NOT saved — ${decision.reason ?? "incomplete"}${
                    sawDone ? "" : " (no [DONE] from the provider)"
                  }`,
                );
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
