/**
 * In-tab deterministic marking cache.
 *
 * Re-checking the SAME question + answer at the SAME severity must return the
 * SAME marks and the SAME words. The server has a replay path for this, but it
 * depends on parsing the stored verdict back out of the database, which fails
 * whenever the model formats its headings slightly differently — and then the
 * user gets a freshly sampled (different) verdict for an unchanged submission.
 *
 * This cache closes that hole on the client: an identical marking request made
 * again in the same tab replays the exact verdict already on screen, without a
 * model call at all. It is invalidated whenever the notebook changes (new
 * source documents or newly flagged lessons), because those legitimately change
 * how an answer must be marked.
 */

import type { StudyRequest } from "@/lib/study-stream";

const STORAGE_KEY = "marking-verdicts-v1";
/** Keep the cache small enough to stay well inside the localStorage quota. */
const MAX_ENTRIES = 40;

export type CachedVerdict = { text: string; model?: string | undefined; at: string };

type Store = Record<string, CachedVerdict>;

/** Whitespace and case differences never change a mark. */
const norm = (text: string | null | undefined): string =>
  (text ?? "").replace(/\s+/g, " ").trim().toLowerCase();

/**
 * Everything that legitimately changes a verdict — and nothing else. Two
 * requests with the same fingerprint MUST produce the same marking output.
 */
export function markingFingerprint(body: StudyRequest): string | null {
  if (body.mode !== "mark" && body.mode !== "challenge") return null;
  const parts = [...(body.parts ?? [])].sort().join(",");
  const fields = [
    body.mode,
    body.subjectId,
    body.rigour ?? "strict",
    parts,
    norm(body.question),
    norm(body.userAnswer),
    // Challenge mode: the query and the verdict being challenged are inputs too.
    norm(body.challengeQuery),
    norm(body.originalEvaluation),
  ];
  return fields.join("\u0000");
}

function load(): Store {
  if (typeof window === "undefined") return {};
  try {
    return (JSON.parse(window.localStorage.getItem(STORAGE_KEY) ?? "{}") as Store) ?? {};
  } catch {
    return {};
  }
}

function save(store: Store) {
  if (typeof window === "undefined") return;
  const keys = Object.keys(store);
  if (keys.length > MAX_ENTRIES) {
    // Drop the oldest entries first.
    const sorted = keys.sort((a, b) => (store[a]!.at < store[b]!.at ? -1 : 1));
    for (const key of sorted.slice(0, keys.length - MAX_ENTRIES)) delete store[key];
  }
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(store));
  } catch {
    /* quota — the cache is an optimisation, never a correctness requirement */
  }
}

export function getCachedVerdict(body: StudyRequest): CachedVerdict | null {
  const key = markingFingerprint(body);
  if (!key) return null;
  return load()[key] ?? null;
}

export function putCachedVerdict(
  body: StudyRequest,
  verdict: { text: string; model?: string | undefined },
): void {
  const key = markingFingerprint(body);
  if (!key || !verdict.text.trim()) return;
  const store = load();
  store[key] = { text: verdict.text, model: verdict.model, at: new Date().toISOString() };
  save(store);
}

/**
 * The notebook moved on (a document was added/removed, or a lesson was
 * flagged): every stored verdict was produced against the old sources, so all
 * of them must be re-marked live.
 */
export function invalidateMarkingCache(): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.removeItem(STORAGE_KEY);
  } catch {
    /* ignore */
  }
}

if (typeof window !== "undefined") {
  window.addEventListener("documents-changed", invalidateMarkingCache);
  window.addEventListener("lessons-changed", invalidateMarkingCache);
}

/**
 * Stored marking verdicts carry an invisible fingerprint comment used for exact
 * replay matching. Strip it before displaying or exporting a verdict.
 */
export function stripMarkFingerprint(response: string): string {
  return response.replace(/\n?<!--\s*mark-fingerprint:[^\s>]+\s*-->\s*$/, "").trimEnd();
}
