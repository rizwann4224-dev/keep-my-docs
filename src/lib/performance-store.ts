/**
 * Where a performance breakdown is kept.
 *
 * Rows live in Supabase (`performance_breakdown`, per-user RLS) so they survive a
 * device change and can be edited back. If the project has not run the migration
 * yet — or the network is down — the store degrades to this browser's
 * localStorage and reports `persisted: false`, so the UI can say plainly that the
 * breakdown is device-local instead of pretending it was saved to the account.
 */

import { supabase } from "@/integrations/supabase/client";
import { recordKey, type BreakdownRow, type ClassificationRecord } from "@/lib/performance-model";

const STORAGE_PREFIX = "performance-breakdown-v1:";

export type StoredRow = BreakdownRow & {
  /** Stable identity for edits: attempt + part. */
  key: string;
  id?: string | undefined;
  qa_entry_id?: string | null;
  updated_at?: string | undefined;
};

export type BreakdownState = {
  rows: StoredRow[];
  /** False when Supabase could not be used and only this device has the data. */
  persisted: boolean;
  /** Why persistence failed, for the notice shown to the user. */
  notice?: string | undefined;
  generatedAt?: string | undefined;
};

const MISSING_TABLE = /(relation|does not exist|42P01|schema cache|Could not find the table)/i;

function storageKey(subjectId: string): string {
  return `${STORAGE_PREFIX}${subjectId}`;
}

function readLocal(
  subjectId: string,
): { rows: StoredRow[]; generatedAt?: string | undefined } | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(storageKey(subjectId));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as { rows: StoredRow[]; generatedAt?: string };
    return Array.isArray(parsed.rows) ? parsed : null;
  } catch {
    return null;
  }
}

function writeLocal(
  subjectId: string,
  state: { rows: StoredRow[]; generatedAt?: string | undefined },
): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(storageKey(subjectId), JSON.stringify(state));
  } catch {
    /* quota — the Supabase copy is the primary one anyway */
  }
}

export function clearLocal(subjectId: string): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.removeItem(storageKey(subjectId));
  } catch {
    /* ignore */
  }
}

/** Read the notebook's breakdown, Supabase first, this device as the fallback. */
export async function loadBreakdown(subjectId: string): Promise<BreakdownState> {
  const local = readLocal(subjectId);
  const { data, error } = await supabase
    .from("performance_breakdown")
    .select(
      "id, attempt, part, topic, subtopic, confidence, evidence, source, awarded, available, weakness, action, qa_entry_id, updated_at",
    )
    .eq("subject_id", subjectId)
    .order("attempt", { ascending: true })
    .order("part", { ascending: true })
    .limit(2000);

  if (!error && Array.isArray(data)) {
    const rows = (data as Record<string, unknown>[]).map((row) => toStoredRow(row));
    return { rows, persisted: true, generatedAt: latest(rows) };
  }
  if (local) {
    return {
      rows: local.rows,
      persisted: false,
      notice: MISSING_TABLE.test(String((error as { message?: string } | null)?.message ?? ""))
        ? "Saved on this device only — run the performance_breakdown migration to keep it in your account."
        : "Saved on this device only — Supabase could not be reached.",
      generatedAt: local.generatedAt,
    };
  }
  return {
    rows: [],
    persisted: false,
    ...(error
      ? { notice: `Could not read the saved breakdown: ${String(error.message ?? error)}` }
      : {}),
  };
}

const latest = (rows: StoredRow[]): string | undefined => {
  const stamps = rows.map((row) => row.updated_at).filter(Boolean) as string[];
  return stamps.length ? stamps.sort().at(-1) : undefined;
};

function toStoredRow(row: Record<string, unknown>): StoredRow {
  const attempt = Number(row["attempt"] ?? 1);
  const part = String(row["part"] ?? "whole");
  return {
    key: `${attempt}::${part}`,
    ...(row["id"] ? { id: String(row["id"]) } : {}),
    attempt,
    part,
    topic: String(row["topic"] ?? "Unlabelled"),
    subtopic: String(row["subtopic"] ?? "Unlabelled"),
    confidence: (row["confidence"] as StoredRow["confidence"]) ?? "medium",
    evidence: String(row["evidence"] ?? ""),
    source: String(row["source"] ?? ""),
    awarded:
      row["awarded"] === null || row["awarded"] === undefined ? null : Number(row["awarded"]),
    available:
      row["available"] === null || row["available"] === undefined ? null : Number(row["available"]),
    weakness: String(row["weakness"] ?? "None"),
    action: String(row["action"] ?? "None"),
    qa_entry_id: row["qa_entry_id"] ? String(row["qa_entry_id"]) : null,
    ...(row["updated_at"] ? { updated_at: String(row["updated_at"]) } : {}),
  };
}

/**
 * Replace a notebook's breakdown with a fresh classification.
 *
 * The rows arriving here are already validated and de-duplicated by
 * `parseClassificationReport`; this writes them with a `subject_id + attempt +
 * part` uniqueness contract so a repeated classification of the same attempts
 * cannot leave two rows for one part.
 */
export async function saveBreakdown(
  subjectId: string,
  userId: string,
  records: ClassificationRecord[],
  opts: { persistToSupabase?: boolean } = {},
): Promise<BreakdownState> {
  const generatedAt = new Date().toISOString();
  const seen = new Map<string, StoredRow>();
  for (const record of records) {
    const row: StoredRow = { ...record, key: recordKey(record) };
    // First row for an attempt+part wins; a second is a duplicate, never an update.
    if (!seen.has(row.key)) seen.set(row.key, row);
  }
  const rows = [...seen.values()];

  writeLocal(subjectId, { rows, generatedAt });

  if (opts.persistToSupabase === false) {
    return { rows, persisted: false, notice: "Saved on this device only.", generatedAt };
  }

  await supabase.from("performance_breakdown").delete().eq("subject_id", subjectId);
  const payload = rows.map((row) => ({
    user_id: userId,
    subject_id: subjectId,
    attempt: row.attempt,
    part: row.part,
    topic: row.topic,
    subtopic: row.subtopic,
    confidence: row.confidence,
    evidence: row.evidence,
    source: row.source,
    awarded: row.awarded,
    available: row.available,
    weakness: row.weakness,
    action: row.action,
    qa_entry_id: row.qa_entry_id ?? null,
  }));
  const { error } = await supabase.from("performance_breakdown").insert(payload);
  if (error) {
    return {
      rows,
      persisted: false,
      notice: MISSING_TABLE.test(String((error as { message?: string }).message ?? ""))
        ? "Saved on this device only — run the performance_breakdown migration to keep it in your account."
        : `Saved on this device only — Supabase refused the write (${String(error.message)}).`,
      generatedAt,
    };
  }
  return { rows, persisted: true, generatedAt };
}

/** Persist one user edit to a topic / subtopic label (or its marks). */
export async function updateBreakdownRow(
  subjectId: string,
  row: StoredRow,
  changes: Partial<Pick<StoredRow, "topic" | "subtopic" | "awarded" | "available">>,
): Promise<{ ok: boolean; error?: string }> {
  const local = readLocal(subjectId);
  if (local) {
    writeLocal(subjectId, {
      generatedAt: local.generatedAt,
      rows: local.rows.map((candidate) =>
        candidate.key === row.key ? { ...candidate, ...changes } : candidate,
      ),
    });
  }

  if (!row.id) return { ok: true };
  const { error } = await supabase
    .from("performance_breakdown")
    .update(changes)
    .eq("id", row.id)
    .eq("subject_id", subjectId);
  if (error) return { ok: false, error: String(error.message) };
  return { ok: true };
}

/** Drop the whole breakdown for a notebook. */
export async function deleteBreakdown(subjectId: string): Promise<void> {
  clearLocal(subjectId);
  await supabase.from("performance_breakdown").delete().eq("subject_id", subjectId);
}
