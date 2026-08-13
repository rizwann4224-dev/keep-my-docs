import { supabase } from "@/integrations/supabase/client";
import type { MarkPart } from "@/lib/study-prompts";

export type StudyRequest = {
  subjectId: string;
  mode: "ask" | "mark";
  question: string;
  userAnswer?: string | undefined;
  parts?: MarkPart[] | undefined;
};

/** Streams the model's answer token-by-token; resolves with the full text. */
export async function streamStudyQuery(
  body: StudyRequest,
  onDelta: (fullSoFar: string) => void,
  signal?: AbortSignal,
): Promise<string> {
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
