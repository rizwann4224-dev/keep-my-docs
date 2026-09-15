/**
 * Stream safety.
 *
 * A model call that stops early — a dropped upstream connection, a token cap, a
 * proxy that closes the socket after a minute — otherwise looks like a finished
 * answer to everyone downstream. The single worst symptom of that was a half
 * written marking report being saved as a completed verdict: the history entry,
 * the marks and the performance charts all trusted it.
 *
 * Everything here is pure so the rules can be tested without a server: a run is
 * only "complete" when the stream ended cleanly AND the text contains the
 * sections that were asked for.
 */

import type { MarkPart } from "@/lib/study-prompts";

/** Sentinels appended to the response body so the browser can tell failure from a full answer. */
export const INCOMPLETE_MARKER = "[[study-stream-incomplete]]";
export const QUOTA_MARKER = "[[study-stream-quota]]";

/** The section headings a marking report must contain, by requested part. */
const SECTION_PROBES: Record<MarkPart, RegExp> = {
  feedback: /^#{1,4}\s*🔍|Item-by-Item Detailed Marking/im,
  marks: /^#{1,4}\s*📊|## Marks\b|^# Marks\b/im,
  suggested: /^#{1,4}\s*✅|Suggested Answer/im,
  recommendations: /^#{1,4}\s*🎯|Recommendations/im,
};

export type Completeness = { ok: boolean; reason?: string | undefined };

/**
 * Is this marking output something that may be stored as a completed verdict?
 *
 * Checks, in order: the run is non-empty; every requested section arrived; when
 * marks were requested the report states a machine-readable total (an entry with
 * no total is a truncated report far more often than an intentional one); and the
 * text does not stop inside a table row, a heading or an unfinished bold marker.
 */
export function isMarkingReportComplete(text: string, parts: MarkPart[]): Completeness {
  const body = stripMarkers(text).trim();
  if (!body) return { ok: false, reason: "the model returned no text" };
  if (body.length < 80) {
    return { ok: false, reason: `the response was only ${body.length} characters` };
  }

  const requested = parts.length ? parts : (Object.keys(SECTION_PROBES) as MarkPart[]);
  const missing = requested.filter((part) => !SECTION_PROBES[part].test(body));
  // Reports are occasionally written with plain headings; accept a named section.
  const trulyMissing = missing.filter((part) => !new RegExp(part, "i").test(body));
  if (trulyMissing.length > 0) {
    return {
      ok: false,
      reason: `the ${trulyMissing.join(", ")} section${trulyMissing.length === 1 ? "" : "s"} never arrived`,
    };
  }

  if (requested.includes("marks")) {
    const statesTotal =
      /Marks awarded:\s*\*{0,2}\s*\d+(?:\.\d+)?\s*\/\s*\d+(?:\.\d+)?/i.test(body) ||
      /GRAND TOTAL[^|\n]*\|[^|\n]*\d+(?:\.\d+)?/i.test(body) ||
      /\|\s*\*{0,2}Total\*{0,2}\s*\|/i.test(body);
    if (!statesTotal) {
      return { ok: false, reason: "the marks section never stated a total" };
    }
  }

  const lastLine = (
    body
      .split("\n")
      .filter((line) => line.trim().length > 0)
      .at(-1) ?? ""
  ).trim();
  // A markdown row that opens with "|" and never closes is the signature of a
  // stream cut off mid-cell — the table the user is reading stops being a table.
  if (lastLine.startsWith("|") && !lastLine.endsWith("|")) {
    return { ok: false, reason: "the output stopped inside a table row" };
  }
  if (/^#{1,6}\s*$/.test(lastLine)) {
    return { ok: false, reason: "the output stopped right after a heading" };
  }
  const bolds = (body.match(/\*\*/g) ?? []).length;
  if (bolds % 2 === 1 && requested.length > 0) {
    return { ok: false, reason: "the output ended with an unclosed bold marker" };
  }

  return { ok: true };
}

/** Is a classification report usable? Anything but a complete JSON array is not. */
export function isClassificationComplete(text: string): Completeness {
  const body = stripMarkers(text).trim();
  if (!body) return { ok: false, reason: "the model returned no text" };
  if (!/[[{]/.test(body)) {
    return { ok: false, reason: "the response contained no JSON" };
  }
  return { ok: true };
}

export type PersistDecision = {
  persist: boolean;
  reason?: string | undefined;
  /** The marker to append to the body, when the client must be told it failed. */
  marker?: (typeof INCOMPLETE_MARKER | typeof QUOTA_MARKER) | undefined;
};

/**
 * Whether a finished run may be written to history as a completed result.
 *
 * `streamCompleted` is false when the upstream connection dropped or the client
 * cancelled. Ask/exam answers are kept as soon as any text arrived (they are
 * conversation, and the user saw them), but a MARKING verdict is only stored when
 * it is structurally complete — a partial mark is never a result.
 */
export function shouldPersistVerdict(input: {
  mode: "ask" | "mark" | "insights" | "exam" | "challenge" | "classify";
  text: string;
  streamCompleted: boolean;
  requestedParts?: MarkPart[] | undefined;
  quotaFailure?: boolean | undefined;
}): PersistDecision {
  if (!input.text.trim()) {
    return { persist: false, reason: "no text was produced" };
  }
  // Insights and classification are derived reports, never attempts: storing them
  // as qa_entries would pollute the history the next classification reads.
  if (input.mode === "insights" || input.mode === "classify") {
    return { persist: false, reason: "derived reports are not saved as attempts" };
  }
  if (!input.streamCompleted) {
    return {
      persist: false,
      reason: "the stream was interrupted before the answer finished",
      marker: input.quotaFailure ? QUOTA_MARKER : INCOMPLETE_MARKER,
    };
  }
  if (input.mode === "mark" || input.mode === "challenge") {
    const completeness = isMarkingReportComplete(input.text, input.requestedParts ?? []);
    if (!completeness.ok) {
      return {
        persist: false,
        reason: completeness.reason,
        marker: input.quotaFailure ? QUOTA_MARKER : INCOMPLETE_MARKER,
      };
    }
  }
  return { persist: true };
}

/** True when the text carries a failure sentinel. */
export function hasIncompleteMarker(text: string): boolean {
  return text.includes(INCOMPLETE_MARKER) || text.includes(QUOTA_MARKER);
}

/** The reason to show the user when a run was flagged as failed at the tail. */
export function incompleteReasonFor(text: string): string | null {
  if (text.includes(QUOTA_MARKER)) {
    return "The AI allowance ran out while this was being written, so nothing was saved. No paid fallback was used.";
  }
  if (text.includes(INCOMPLETE_MARKER)) {
    return "The answer stopped before it was complete, so it was not saved as a result. Try again.";
  }
  return null;
}

/** Remove any failure sentinels before the text is displayed, exported or stored. */
export function stripMarkers(text: string): string {
  return text
    .replace(new RegExp(`\\n*\\s*\\[\\[study-stream-(?:incomplete|quota)\\]\\]\\s*$`), "")
    .trimEnd();
}

/** Append the sentinel the browser turns into a visible failure. */
export function withMarker(text: string, marker: string): string {
  return `${text}\n\n${marker}`;
}
