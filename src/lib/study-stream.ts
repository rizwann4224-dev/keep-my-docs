import { supabase } from "@/integrations/supabase/client";
import type { ExamDifficulty, MarkPart, Rigour } from "@/lib/study-prompts";

export type StudyRequest = {
  subjectId: string;
  mode: "ask" | "mark" | "insights" | "exam" | "challenge";
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

function getStudyApiPath() {
  const base = (import.meta.env.BASE_URL || "/").replace(/\/+$/, "");
  return `${base || ""}/api/study`;
}

/** Streams the model's answer token-by-token; resolves with the full text. */
export async function streamStudyQuery(
  body: StudyRequest,
  onDelta: (fullSoFar: string) => void,
  signal?: AbortSignal,
): Promise<string> {
  const { data } = await supabase.auth.getSession();
  const token = data.session?.access_token;
  if (!token) throw new Error("Your session expired — sign in again.");

  const res = await fetch(getStudyApiPath(), {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
    signal: signal ?? null,
  });

  if (!res.ok || !res.body) {
    throw new Error((await res.text()) || `Request failed (${res.status})`);
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let full = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    full += decoder.decode(value, { stream: true });
    onDelta(full);
  }
  if (!full.trim()) throw new Error("The AI returned an empty response.");
  return full;
}
