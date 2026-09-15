import { supabase } from "@/integrations/supabase/client";
import { hasIncompleteMarker, incompleteReasonFor, stripMarkers } from "@/lib/stream-safety";
import type { ExamDifficulty, MarkPart, Rigour } from "@/lib/study-prompts";
import type { BreakdownRow } from "@/lib/performance-model";

export type StudyRequest = {
  subjectId: string;
  mode: "ask" | "mark" | "insights" | "exam" | "challenge" | "classify";
  question: string;
  userAnswer?: string | undefined;
  parts?: MarkPart[] | undefined;
  /** Marking severity for mark/challenge mode. */
  rigour?: Rigour | undefined;
  /** Exam-setter difficulty (exam mode only). */
  difficulty?: ExamDifficulty | undefined;
  /** Prior turns in this Ask thread, so follow-up questions keep their context. */
  history?: { question: string; answer: string }[] | undefined;
  /** Questions already set for this notebook (exam mode) — never repeat these. */
  priorQuestions?: string[] | undefined;
  /** Challenge mode only. */
  originalEvaluation?: string | undefined;
  challengeQuery?: string | undefined;
  originalMarks?: number | undefined;
  maxMarks?: number | undefined;
};

/** Streams the model's answer token-by-token; resolves with the full text and
 *  the model that served the request (from the X-Study-Model header). */
export async function streamStudyQuery(
  body: StudyRequest,
  onDelta: (fullSoFar: string) => void,
  signal?: AbortSignal,
): Promise<{ text: string; model?: string | undefined }> {
  const { data } = await supabase.auth.getSession();
  const token = data.session?.access_token;
  if (!token) throw new Error("Your session expired — sign in again.");

  const res = await fetch("/api/study", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
    signal: signal ?? null,
  });

  if (!res.ok || !res.body) {
    throw new Error((await res.text()) || `Request failed (${res.status})`);
  }

  const model = res.headers.get("x-study-model") ?? undefined;
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let full = "";
  let streamError: unknown = null;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      full += decoder.decode(value, { stream: true });
      // The failure sentinel is never shown while streaming — it arrives at the tail.
      onDelta(stripMarkers(full));
    }
    full += decoder.decode();
  } catch (error) {
    streamError = error;
  }

  const reason = incompleteReasonFor(full);
  if (streamError) {
    throw new Error(
      "The connection dropped while the answer was still arriving, so it was not saved as a result. Try again.",
    );
  }
  if (reason) {
    // The server marked this run failed: an interrupted or truncated answer is
    // never presented as a completed one.
    throw new Error(reason);
  }
  const text = stripMarkers(full);
  if (!text.trim()) throw new Error("The AI returned an empty response.");
  if (hasIncompleteMarker(full)) throw new Error("The answer was incomplete and was not saved.");
  return { text, model };
}

/** What /api/study returns for mode "classify": already validated rows. */
export type ClassificationResponse = {
  rows: BreakdownRow[];
  rejected: { row: number; reason: string }[];
  needsReview: { attempt: number; part: string; because: string }[];
  attemptsClassified: number;
  attemptsExpected: number;
  canonicalTopics: string[];
  model?: string;
};

/**
 * Ask the server for a validated topic/subtopic classification of every marked
 * attempt. The server parses and schema-checks the model's JSON before it
 * answers, so a truncated or partial report arrives as an error — never as rows
 * the charts would then draw from.
 */
export async function requestClassification(
  subjectId: string,
  signal?: AbortSignal,
): Promise<ClassificationResponse> {
  const { data } = await supabase.auth.getSession();
  const token = data.session?.access_token;
  if (!token) throw new Error("Your session expired — sign in again.");

  const res = await fetch("/api/study", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify({
      subjectId,
      mode: "classify",
      question: "Classify every marked attempt by topic and subtopic",
    }),
    signal: signal ?? null,
  });

  const body = await res.text();
  if (!res.ok) {
    throw new Error(body || `Classification failed (${res.status}).`);
  }
  try {
    return JSON.parse(body) as ClassificationResponse;
  } catch {
    throw new Error("The classification response was not valid JSON, so nothing was saved.");
  }
}
