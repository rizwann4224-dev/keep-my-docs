/**
 * Performance classification model.
 *
 * The graph is only honest if the data behind it is: every bar must trace to
 * marks a marker actually awarded out of marks a question actually had. So this
 * module owns the validation and the arithmetic, and nothing in it ever
 * estimates, rounds up, or fills a gap. Where a number is missing, the record
 * says so and is EXCLUDED from the percentages rather than guessed at.
 */

import { z } from "zod";

/** One row of the AI's classification report: a marked part, classified. */
export const ClassificationRecordSchema = z.object({
  /** 1-based index of the marked attempt this row belongs to. */
  attempt: z.number().int().min(1),
  /** The explicitly marked part, e.g. "(a)", "Q2(b)", "Part (i)". */
  part: z.string().min(1).max(40),
  /** Canonical topic name — the syllabus/study-text topic, not a generic skill. */
  topic: z.string().min(2).max(160),
  /** The narrower area inside the topic that the requirement actually tested. */
  subtopic: z.string().min(2).max(160),
  /** How sure the classifier is about THIS topic/subtopic assignment. */
  confidence: z.enum(["high", "medium", "low"]),
  /** The candidate's own words or workings this row is based on. */
  evidence: z.string().min(1).max(2000),
  /** Which source supports the classification (or "not in the sources"). */
  source: z.string().min(1).max(300),
  /** Marks awarded for this part. `null` when the marking report never stated them. */
  awarded: z.number().min(0).max(500).nullable(),
  /** Marks available for this part. `null` when never stated. */
  available: z.number().min(0).max(1000).nullable(),
  /** The specific gap in the tested requirement, or "None". */
  weakness: z.string().min(2).max(1000),
  /** What to do next time. */
  action: z.string().min(2).max(1000),
});

export type ClassificationRecord = z.infer<typeof ClassificationRecordSchema>;

export type RejectedRow = {
  index: number;
  reason: string;
  raw: unknown;
};

export type ClassificationReport = {
  /** Rows that passed validation (including any flagged for review). */
  records: ClassificationRecord[];
  /** Rows rejected, with the reason the caller must show the user. */
  rejected: RejectedRow[];
  /** Attempts the report never mentioned — a report that omits attempts is invalid. */
  missingAttempts: number[];
  /** Rows the graph must not use (low confidence or unusable marks). */
  needsReview: ClassificationRecord[];
  /** True when the report can be trusted as a complete picture of the notebook. */
  complete: boolean;
  error?: string;
};

/** Attempts the classifier must cover: one entry per marked attempt. */
export type MarkedAttemptInput = {
  /** 1-based attempt number, in the order given to the model. */
  index: number;
  question: string;
  answer?: string | null;
  response: string;
  created_at: string;
  /** Marks parsed from the report itself, when present. */
  awarded: number | null;
  available: number | null;
};

/**
 * A stable key for "this attempt's this part" — the unit records are stored and
 * compared on. `Q3(b)` / `part 3(b)` / `(b)` for attempt 3 all collapse to the
 * same key, so a duplicate report cannot double-count one part.
 */
export function partKey(part: string): string {
  const cleaned = part
    .toLowerCase()
    // "Question 3(b)", "Part 3 (b)" and "Q.3(b)" all name the same sub-part of
    // the attempt this row already belongs to, so the question number is not
    // part of the row's identity. "Part (i)" keeps its label: it has no number
    // to drop, and bare numbers ("2", "10") are parts too and must stay distinct.
    .replace(/\b(?:question|part)\s*\.?\s*\d*\s*[.):#-]?\s*/g, " ")
    .replace(/\bq\s*\.?\s*\d+\s*[.)-]?\s*/g, " ")
    .replace(/\b(?:question|part)\b/g, " ")
    .replace(/[\s.]+/g, "")
    .replace(/[()[\]{}]/g, "")
    .replace(/[:;,]+$/, "");
  return cleaned || "whole";
}

export function recordKey(record: Pick<ClassificationRecord, "attempt" | "part">): string {
  return `${record.attempt}::${partKey(record.part)}`;
}

const FENCE = /^\s*```(?:json)?\s*|\s*```\s*$/g;

/**
 * Pull the JSON out of a model reply. Accepts a bare array, or an object with a
 * `records` / `classifications` / `rows` array, and ignores prose around it.
 */
export function extractJsonArray(raw: string): unknown {
  const text = raw.replace(FENCE, "").trim();
  if (!text) throw new Error("The classification response was empty.");
  try {
    const parsed = JSON.parse(text) as unknown;
    if (Array.isArray(parsed)) return parsed;
    if (parsed && typeof parsed === "object") {
      for (const key of ["records", "classifications", "rows", "data"]) {
        const value = (parsed as Record<string, unknown>)[key];
        if (Array.isArray(value)) return value;
      }
    }
  } catch {
    /* fall through to the brace scan */
  }
  const start = text.indexOf("[");
  const end = text.lastIndexOf("]");
  if (start >= 0 && end > start) {
    const sliced = text.slice(start, end + 1);
    const parsed = JSON.parse(sliced) as unknown;
    if (Array.isArray(parsed)) return parsed;
  }
  throw new Error("The classification response was not valid JSON.");
}

/**
 * Coerce the shapes models habitually send ("2 marks", null strings, "" numbers).
 *
 * A `"6 / 10"` style string carries both numbers at once, so the slot decides
 * which half it is reading: taking the numerator for `available` would silently
 * turn a 60% score into 100%. Anything the value does not state stays `null`.
 */
function coerceMarks(value: unknown, slot: "awarded" | "available" = "awarded"): number | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  const fraction = /(\d+(?:\.\d+)?)\s*\/\s*(\d+(?:\.\d+)?)/.exec(String(value));
  if (fraction) return Number.parseFloat(slot === "awarded" ? fraction[1]! : fraction[2]!);
  const single = /-?\d+(?:\.\d+)?/.exec(String(value));
  return single ? Number.parseFloat(single[0]!) : null;
}

function coerceConfidence(value: unknown): "high" | "medium" | "low" {
  const text = String(value ?? "").toLowerCase();
  if (text.startsWith("h") || text === "certain" || text === "verified") return "high";
  if (text.startsWith("l") || text === "uncertain" || text === "guess") return "low";
  return "medium";
}

/**
 * Validate a classification report against the attempts it was supposed to cover.
 *
 * Rules enforced here (all of them fail loudly rather than quietly fixing data):
 * - every row must pass the schema — anything else is rejected with a reason;
 * - a second row for the same attempt + part is rejected as a duplicate;
 * - `awarded > available` is a broken total: the row never reaches the graph;
 * - a report that omits an attempt entirely is not complete, and the caller
 *   must treat it as a failed classification rather than a partial one.
 */
export function parseClassificationReport(
  raw: string,
  expectedAttempts: number[],
): ClassificationReport {
  const empty: ClassificationReport = {
    records: [],
    rejected: [],
    missingAttempts: [...expectedAttempts],
    needsReview: [],
    complete: false,
    error: "The classification response contained no records.",
  };

  let rows: unknown;
  try {
    rows = extractJsonArray(raw);
  } catch (error) {
    return { ...empty, error: error instanceof Error ? error.message : String(error) };
  }
  if (!Array.isArray(rows) || rows.length === 0) return empty;

  const records: ClassificationRecord[] = [];
  const rejected: RejectedRow[] = [];
  const seen = new Map<string, number>();

  rows.forEach((row, index) => {
    const source = (row ?? {}) as Record<string, unknown>;
    const attemptRaw = Number(source["attempt"] ?? source["attemptNumber"] ?? index + 1);
    const partRaw = String(source["part"] ?? source["subpart"] ?? "whole").trim();
    const topic = String(source["topic"] ?? "").trim();
    const subtopic = String(source["subtopic"] ?? "").trim();

    const parse = ClassificationRecordSchema.safeParse({
      attempt: Number.isInteger(attemptRaw) ? attemptRaw : Number.NaN,
      part: partRaw || "whole",
      topic,
      subtopic,
      confidence: coerceConfidence(source["confidence"]),
      evidence: String(source["evidence"] ?? "").trim() || "(no evidence quoted)",
      source: String(source["source"] ?? "").trim() || "not stated",
      awarded: coerceMarks(source["awarded"] ?? source["marksAwarded"], "awarded"),
      available: coerceMarks(source["available"] ?? source["marksAvailable"], "available"),
      weakness: String(source["weakness"] ?? "").trim() || "None",
      action: String(source["action"] ?? "").trim() || "None",
    });

    if (!parse.success) {
      rejected.push({
        index,
        reason: parse.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "),
        raw: row,
      });
      return;
    }

    const record = parse.data;
    const key = recordKey(record);
    const previous = seen.get(key);
    if (previous !== undefined) {
      rejected.push({
        index,
        reason: `duplicate attempt ${record.attempt} + part "${record.part}" (already given on row ${previous + 1})`,
        raw: row,
      });
      return;
    }

    if (record.awarded !== null && record.available !== null && record.awarded > record.available) {
      rejected.push({
        index,
        reason: `invalid total — awarded ${record.awarded} exceeds available ${record.available}`,
        raw: row,
      });
      return;
    }
    if (record.available !== null && record.available <= 0) {
      rejected.push({
        index,
        reason: "invalid total — available marks must be greater than 0",
        raw: row,
      });
      return;
    }

    seen.set(key, index);
    records.push(record);
  });

  const covered = new Set(records.map((r) => r.attempt));
  const missingAttempts = expectedAttempts.filter((a) => !covered.has(a));
  const needsReview = records.filter((r) => !countsTowardGraph(r));

  return {
    records,
    rejected,
    missingAttempts,
    needsReview,
    complete: records.length > 0 && missingAttempts.length === 0,
    ...(missingAttempts.length > 0
      ? {
          error: `The classification omitted attempt${
            missingAttempts.length === 1 ? "" : "s"
          } ${missingAttempts.join(", ")}. A report that does not cover every marked attempt is rejected rather than shown as a partial picture.`,
        }
      : {}),
  };
}

/** A row only feeds a percentage when its marks exist and it is not a guess. */
export function countsTowardGraph(record: ClassificationRecord): boolean {
  if (record.confidence === "low") return false;
  if (record.awarded === null || record.available === null) return false;
  if (record.available <= 0) return false;
  if (record.awarded > record.available) return false;
  return true;
}

export type ScoreGroup = {
  name: string;
  awarded: number;
  available: number;
  /** Percentage, or `null` when there is nothing to compute it from (never 0). */
  percent: number | null;
  attempts: number;
  /** Rows held back from the percentage (low confidence / missing marks). */
  needsReview: number;
  /** Rows whose awarded marks are exactly zero — kept, never dropped. */
  zeroScores: number;
};

/**
 * Weighted score for a group of rows: `sum awarded / sum available`.
 *
 * Zero-award rows count (they are evidence), rows with missing marks do not, and
 * an empty group returns `percent: null` instead of a fabricated 0% or 100%.
 */
export function scoreGroup(name: string, records: ClassificationRecord[]): ScoreGroup {
  let awarded = 0;
  let available = 0;
  let needsReview = 0;
  let zeroScores = 0;
  const attempts = new Set<number>();

  for (const record of records) {
    attempts.add(record.attempt);
    if (!countsTowardGraph(record)) {
      needsReview += 1;
      continue;
    }
    awarded += record.awarded ?? 0;
    available += record.available ?? 0;
    if ((record.awarded ?? 0) === 0) zeroScores += 1;
  }

  return {
    name,
    awarded,
    available,
    percent: available > 0 ? (awarded / available) * 100 : null,
    attempts: attempts.size,
    needsReview,
    zeroScores,
  };
}

/** Percentage to one decimal, `null` when it cannot be computed at all. */
export function formatPercent(percent: number | null): string {
  if (percent === null) return "—";
  return `${Math.round(percent * 10) / 10}%`;
}

export function groupByTopic(records: ClassificationRecord[]): ScoreGroup[] {
  const groups = new Map<string, ClassificationRecord[]>();
  for (const record of records) {
    const key = record.topic.trim();
    groups.set(key, [...(groups.get(key) ?? []), record]);
  }
  return [...groups.entries()]
    .map(([name, rows]) => scoreGroup(name, rows))
    .sort(
      (a, b) => (a.percent ?? Number.MAX_SAFE_INTEGER) - (b.percent ?? Number.MAX_SAFE_INTEGER),
    );
}

export function groupBySubtopic(records: ClassificationRecord[]): ScoreGroup[] {
  const groups = new Map<string, ClassificationRecord[]>();
  for (const record of records) {
    const key = `${record.topic} — ${record.subtopic}`.trim();
    groups.set(key, [...(groups.get(key) ?? []), record]);
  }
  return [...groups.entries()]
    .map(([name, rows]) => scoreGroup(name, rows))
    .sort(
      (a, b) => (a.percent ?? Number.MAX_SAFE_INTEGER) - (b.percent ?? Number.MAX_SAFE_INTEGER),
    );
}

/**
 * Match a model-returned topic to the notebook's canonical syllabus / contents
 * names, so "Income tax – salary", "TAX-04 Salaries" and "Salaries" all chart as
 * the one syllabus line. Returns the canonical label when it matches, otherwise
 * the model's own wording (flagged as non-canonical by the caller).
 */
export function canonicalTopicName(candidate: string, canonical: string[]): string | null {
  const wanted = normalizeTopicKey(candidate);
  if (!wanted) return null;
  for (const name of canonical) {
    const key = normalizeTopicKey(name);
    if (!key) continue;
    if (key === wanted) return name;
    if (key.length > 8 && (wanted.includes(key) || key.includes(wanted))) return name;
  }
  const near = canonical.find((name) => tokenOverlap(normalizeTopicKey(name), wanted) >= 0.6);
  return near ?? null;
}

export function normalizeTopicKey(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9 ]+/g, " ")
    .replace(/\b(topic|chapter|section|unit|part|and|the|of|in|on)\b/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function tokenOverlap(a: string, b: string): number {
  const left = new Set(a.split(" ").filter(Boolean));
  const right = new Set(b.split(" ").filter(Boolean));
  if (left.size === 0 || right.size === 0) return 0;
  let shared = 0;
  for (const token of left) if (right.has(token)) shared += 1;
  return shared / Math.min(left.size, right.size);
}

/**
 * Weaknesses must describe the requirement the question tested, not how the
 * candidate wrote. A language/style note is not a knowledge weakness, so it is
 * never allowed to name a bar on the chart.
 */
const STYLE_WORDS =
  /\b(grammar|spelling|punctuation|handwriting|neatness|wording|phrasing|presentation|paragraph(?:s|ing)?|sentence structure|essay style|tone|vocabulary|typing)\b/i;

export function isStyleOnlyWeakness(weakness: string): boolean {
  const technical =
    /\b(rule|rate|figure|section|standard|calculat\w*|workings?|applicat\w*|conclusion|referenc\w*|method|treatment|recognition|measurement|evidence|procedure|judgement|judgment)\b/i;
  return STYLE_WORDS.test(weakness) && !technical.test(weakness);
}

/** Parse the marks line a marking report ends with. Never invents a number. */
export function parseMarksFromReport(response: string): {
  awarded: number | null;
  available: number | null;
} {
  const labelled = /Marks awarded:\s*\*{0,2}(\d+(?:\.\d+)?)\s*\/\s*(\d+(?:\.\d+)?)/i.exec(response);
  if (labelled) {
    return { awarded: Number.parseFloat(labelled[1]!), available: Number.parseFloat(labelled[2]!) };
  }
  const grand = /\*\*\s*GRAND TOTAL[^|\n]*\|\s*(\d+(?:\.\d+)?)\s*\|\s*(\d+(?:\.\d+)?)/i.exec(
    response,
  );
  if (grand) {
    return { awarded: Number.parseFloat(grand[1]!), available: Number.parseFloat(grand[2]!) };
  }
  const tableTotal = /\|\s*\*{0,2}Total\*{0,2}\s*\|\s*(\d+(?:\.\d+)?)\s*\|\s*(\d+(?:\.\d+)?)/i.exec(
    response,
  );
  if (tableTotal) {
    return {
      awarded: Number.parseFloat(tableTotal[1]!),
      available: Number.parseFloat(tableTotal[2]!),
    };
  }
  const bare = /(\d+(?:\.\d+)?)\s*\/\s*(\d+(?:\.\d+)?)\s*marks/i.exec(response);
  if (bare) {
    return { awarded: Number.parseFloat(bare[1]!), available: Number.parseFloat(bare[2]!) };
  }
  return { awarded: null, available: null };
}

/** A row ready to persist (Supabase `performance_breakdown`). */
export type BreakdownRow = {
  attempt: number;
  part: string;
  topic: string;
  subtopic: string;
  confidence: ClassificationRecord["confidence"];
  evidence: string;
  source: string;
  awarded: number | null;
  available: number | null;
  weakness: string;
  action: string;
  qa_entry_id?: string | null;
};

export function toRows(records: ClassificationRecord[]): BreakdownRow[] {
  return records.map((record) => ({
    attempt: record.attempt,
    part: record.part,
    topic: record.topic,
    subtopic: record.subtopic,
    confidence: record.confidence,
    evidence: record.evidence,
    source: record.source,
    awarded: record.awarded,
    available: record.available,
    weakness: record.weakness,
    action: record.action,
  }));
}

/** Render rows as the markdown table the exports and the panel both show. */
export function breakdownTable(rows: BreakdownRow[]): string {
  const header =
    "| Topic | Subtopic | Attempts | Awarded | Available | Score | Needs review |\n|---|---|---|---|---|---|---|";
  const groups = new Map<string, BreakdownRow[]>();
  for (const row of rows) {
    const key = `${row.topic}||${row.subtopic}`;
    groups.set(key, [...(groups.get(key) ?? []), row]);
  }
  const lines = [...groups.entries()].map(([key, group]) => {
    const [topic = "", subtopic = ""] = key.split("||");
    const score = scoreGroup(topic, group);
    return [
      `| ${topic}`,
      subtopic,
      String(score.attempts),
      score.available > 0 || score.awarded > 0 ? String(score.awarded) : "—",
      score.available > 0 ? String(score.available) : "—",
      formatPercent(score.percent),
      score.needsReview > 0 ? `${score.needsReview} Needs review` : "",
      "|",
    ].join(" | ");
  });
  return [header, ...lines].join("\n");
}

/* -------------------------------------------------------------------------- */
/*  Canonical topic names from the notebook's own syllabus / contents pages   */
/* -------------------------------------------------------------------------- */

/** Documents that can tell us what the official topic names are. */
const SYLLABUS_HINT =
  /\b(syllab|syllabus|scheme of exam|contents|index|study text|study-text|outline|topic list|chapter list|learning outcome|aims and objectives|markscheme distribution)\b/i;

/** A heading that reads like a syllabus line, not a sentence of prose. */
const TOPIC_LINE =
  /^(?:(?:chapter|unit|section|part|topic)\s*)?(\d{1,2}(?:\.\d{1,2})?)?[.)]?\s*([A-Z][^.\n]{2,88})$/;

/**
 * Canonical topic / subtopic names, taken from the uploaded syllabus, contents
 * page or study-text headings. Chart labels come from THESE, so two attempts on
 * the same area always land on one bar and the names match what the candidate
 * actually studies. Returns an empty list when the notebook holds nothing that
 * looks like a syllabus — the caller then falls back to the model's wording and
 * says so, rather than inventing a taxonomy.
 */
export function extractCanonicalTopics(
  docs: { name: string; extracted_text: string | null }[],
  limit = 160,
): string[] {
  const names = new Set<string>();
  for (const doc of docs) {
    const text = doc.extracted_text ?? "";
    const head = `${doc.name}\n${text.slice(0, 40_000)}`;
    if (!SYLLABUS_HINT.test(head)) continue;

    // Read the contents region only: the first 40k characters after a
    // "contents"/"syllabus" heading is where the topic list lives.
    const regionStart = /contents|syllab|outline/i.exec(text)?.index ?? 0;
    const region = text.slice(regionStart, regionStart + 40_000);

    for (const rawLine of region.split("\n")) {
      const line = rawLine
        .replace(/\.[.,·\s]{3,}\s*\d+$/, "") // dot leaders: "Introduction ........ 12"
        .replace(/\[Page \d+\]/g, "")
        .replace(/\s{2,}/g, " ")
        .trim();
      if (line.length < 4 || line.length > 100) continue;
      if (/^[|:-]+$/.test(line)) continue; // table divider
      if (/^https?:/.test(line)) continue;
      const match = TOPIC_LINE.exec(line);
      const candidate = (match?.[2] ?? line).replace(/[,;:.\s]+$/, "").trim();
      if (candidate.length < 3 || candidate.length > 80) continue;
      if (
        /^(the|and|or|of|for|note|notes|page|question|answer|required|however)$|^[a-z]+$/.test(
          candidate,
        )
      )
        continue;
      // Sentences are prose, not topic names.
      if (
        /\s\S+\s\S+\s\S+\s\S+\s\S+/.test(candidate) &&
        /\b(is|are|was|were|must|should|will)\b/i.test(candidate)
      )
        continue;
      names.add(candidate);
      if (names.size >= limit) return [...names];
    }
  }
  return [...names];
}

/** Convenience wrapper used by the API route. */
export function canonicalTopicsFrom(
  docs: { name: string; extracted_text: string | null }[],
): string[] {
  return extractCanonicalTopics(docs);
}
