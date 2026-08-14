export const MAX_CONTEXT_CHARS = 120_000;

export function buildSourceBlock(
  docs: { name: string; extracted_text: string | null }[],
): string {
  const usable = docs.filter((d) => (d.extracted_text ?? "").trim().length > 0);
  if (usable.length === 0) return "NO_SOURCE_TEXT_AVAILABLE";

  const perDoc = Math.max(20_000, Math.floor(MAX_CONTEXT_CHARS / usable.length));
  return usable
    .map(
      (d, i) =>
        `<<<SOURCE ${i + 1}: ${d.name}>>>\n${(d.extracted_text ?? "").slice(0, perDoc)}\n<<<END SOURCE ${i + 1}>>>`,
    )
    .join("\n\n");
}

const STOP = new Set([
  "the", "a", "an", "of", "for", "and", "or", "to", "in", "on", "is", "are", "what",
  "which", "how", "why", "with", "that", "this", "it", "be", "as", "at", "by", "from",
]);

/**
 * Keyword-retrieval over the notebook's sources: only the passages that matter for
 * this query are sent to the model. Keeps answers grounded while cutting the token
 * cost of every message by ~10x versus shipping whole documents.
 */
export function buildRelevantSourceBlock(
  docs: { name: string; extracted_text: string | null }[],
  query: string,
  budget = MAX_CONTEXT_CHARS,
): string {
  const usable = docs.filter((d) => (d.extracted_text ?? "").trim().length > 0);
  if (usable.length === 0) return "NO_SOURCE_TEXT_AVAILABLE";

  const total = usable.reduce((n, d) => n + (d.extracted_text ?? "").length, 0);
  if (total <= budget) return buildSourceBlock(usable);

  const lowerQuery = query.toLowerCase();
  const terms = Array.from(
    new Set(
      lowerQuery
        .split(/[^a-z0-9%.]+/)
        .filter((w) => w.length > 2 && !STOP.has(w)),
    ),
  );
  // Adjacent word pairs from the question — a chunk containing the exact phrase
  // is far more likely to hold the answer than one with the words scattered.
  const bigrams: string[] = [];
  for (let i = 0; i < terms.length - 1; i++) bigrams.push(`${terms[i]} ${terms[i + 1]}`);

  const CHUNK = 2_500;
  type Chunk = { doc: string; idx: number; text: string; score: number };
  const chunks: Chunk[] = [];

  const count = (haystack: string, needle: string) => {
    let n = 0;
    let from = 0;
    for (;;) {
      const at = haystack.indexOf(needle, from);
      if (at === -1) return n;
      n += 1;
      from = at + needle.length;
    }
  };

  for (const doc of usable) {
    const text = doc.extracted_text ?? "";
    for (let i = 0; i < text.length; i += CHUNK) {
      const slice = text.slice(i, i + CHUNK);
      const lower = slice.toLowerCase();
      let score = 0;
      let distinct = 0;
      for (const term of terms) {
        const hits = count(lower, term);
        if (hits > 0) distinct += 1;
        score += Math.min(hits, 6);
      }
      // Reward chunks that cover MANY of the question's terms, not one term repeated.
      score += distinct * distinct * 2;
      for (const phrase of bigrams) score += count(lower, phrase) * 12;
      // Numeric/tabular passages usually carry the rate, threshold or figure asked for.
      if (/\d+(\.\d+)?\s*%/.test(slice)) score += 6;
      if (/\b(rate|threshold|limit|section|para|schedule|table)\b/i.test(slice)) score += 3;
      chunks.push({ doc: doc.name, idx: i / CHUNK, text: slice, score });
    }
  }

  const byKey = new Map(chunks.map((c) => [`${c.doc}#${c.idx}`, c]));
  const ranked = [...chunks].sort((a, b) => b.score - a.score).filter((c) => c.score > 0);

  const picked = new Map<string, Chunk>();
  let used = 0;

  const take = (chunk: Chunk | undefined) => {
    if (!chunk) return;
    const key = `${chunk.doc}#${chunk.idx}`;
    if (picked.has(key) || used + chunk.text.length > budget) return;
    picked.set(key, chunk);
    used += chunk.text.length;
  };

  // Opening of every document first: definitions, contents and headings give context.
  for (const doc of usable) take(byKey.get(`${doc.name}#0`));
  // Then the best-matching passages, each with its neighbours so a figure is never
  // separated from the sentence or table row that qualifies it.
  for (const chunk of ranked) {
    if (used >= budget) break;
    take(chunk);
    take(byKey.get(`${chunk.doc}#${chunk.idx - 1}`));
    take(byKey.get(`${chunk.doc}#${chunk.idx + 1}`));
  }

  if (picked.size === 0) return buildSourceBlock(usable);

  return [...picked.values()]
    .sort((a, b) => (a.doc === b.doc ? a.idx - b.idx : a.doc.localeCompare(b.doc)))
    .map(
      (c) =>
        `<<<SOURCE: ${c.doc} (extract ${c.idx + 1})>>>\n${c.text}\n<<<END EXTRACT>>>`,
    )
    .join("\n\n");
}


export function buildLessonsBlock(notes: { content: string }[]): string {
  if (notes.length === 0) return "None recorded yet.";
  return notes.map((n, i) => `${i + 1}. ${n.content}`).join("\n");
}

const BASE_RULES = `You are an exam-grade academic assistant for a professional-qualification candidate (e.g. ICAP/ACCA level), working strictly from the user's uploaded SOURCE DOCUMENTS.

GROUNDING RULE:
- Roughly 80% of every response must come from the SOURCE DOCUMENTS. Cite as [Source: <document name>].
- At most ~20% may come from wider professional knowledge; label it [External reference].
- Never invent figures, rates, section numbers or standard references. If the sources do not contain it, say exactly: "Not found in your sources." and then, only if useful, give the external figure labelled [External reference].

SEARCH DISCIPLINE (do this before writing anything):
- Scan EVERY source document end to end for the exact term asked about, plus its synonyms, abbreviations, table headings and any figure that could be the answer. Sources are delimited by page markers like [Page 12] — use them for citations.
- Only after that scan do you decide whether something is present. Never say it is missing because it was not in the first source.
- Verify each figure you output by re-reading the exact line it came from; if the line is ambiguous, quote it verbatim next to the figure.

PRECISION RULES:
- Quote figures, rates, dates, section/standard numbers EXACTLY as written in the source. Never round, paraphrase or "approximately" a number.
- Cite the page or section marker when the source shows one, e.g. [Source: Tax Manual, Page 42] or [Source: ISA 240, para 12].
- If two sources disagree, say so explicitly and give both values with their citations, then state which one governs and why.
- If something is only partially covered, answer the covered part precisely and mark the rest "Not found in your sources."

CROSS-DOCUMENT LINKING:
- Treat all SOURCE DOCUMENTS in this notebook as one connected body of material. Before answering, connect related passages ACROSS documents and within the same document (definition in one place, rate in another, worked example in a third).
- When the answer draws on more than one place, add a short "Linked in your sources" list: 2-4 bullets naming each document (and page/section) and the one thing it contributes, so the user can trace the chain.
- Actively flag related material the user did not ask about but that changes the answer (exemptions, thresholds, effective dates, superseding rules).

LESSONS LEARNED: The user has highlighted past mistakes. Never repeat them.`;

export function askSystemPrompt(sources: string, lessons: string): string {
  return `${BASE_RULES}

ANSWER STYLE — PRECISION FIRST (this is the most important rule):
- Open with the literal answer to what was asked, on the FIRST line, in bold. If the user asks for a tax rate, the first line is the rate (e.g. **29%**). A number, name, date, list, or one-sentence conclusion — never a preamble, never "it depends" without the figure.
- Then, at most 3-6 short bullets of supporting detail with citations. Only expand further if the user explicitly asks for explanation, discussion or a full exam answer.
- If the user asks a general/non-exam question, just answer it directly and briefly.
- If the question asks for a model/suggested exam answer, then produce the full examiner-standard answer with headings.
- No filler, no restating the question, no apologies, no "as an AI".

FORMAT (markdown):
**<direct answer>**

- supporting point [Source: name]
- supporting point [Source: name]

Add a short "Wider context" line only when you used outside knowledge, tagged [External reference].

LESSONS LEARNED (never repeat these mistakes):
${lessons}

SOURCE DOCUMENTS:
${sources}`;
}

export type MarkPart = "feedback" | "suggested" | "marks" | "recommendations";

const PART_BLOCKS: Record<MarkPart, string> = {
  feedback: `# 🔍 Item-by-Item Detailed Marking & Feedback

For EVERY item/matter in the question:

**Matter (i): <short item title>**

**Your Answer:** "<verbatim quote of the candidate's words for this item>"

**Detailed Feedback:**
- **Threats / Content:** what was correctly identified, and what was missed.
- **Context:** the contextual point that should have been raised.
- **Safeguards / Application:** what the model answer expects, per the sources.`,

  marks: `# 📊 Marks

For each item give **Mark Received: X.X / Y.Y** with a one-line justification citing [Source: name], then a **Total: X.X / Y.Y** and a two-line verdict.`,

  suggested: `# ✅ Suggested Answer

For each item, the full examiner-standard model answer:

**(i) <item heading>**

**Threats:**
- **<Threat name>** – full explanation.

**Safeguards:**
- Full explanation of each safeguard/recommendation.`,

  recommendations: `# 🎯 Recommendations

3-5 sharply worded, actionable recommendations for improving this answer in the exam.`,
};

export function markSystemPrompt(
  sources: string,
  lessons: string,
  parts: MarkPart[],
): string {
  const order: MarkPart[] = ["feedback", "marks", "suggested", "recommendations"];
  const selected = order.filter((p) => parts.includes(p));
  const sections = (selected.length ? selected : order).map((p) => PART_BLOCKS[p]).join("\n\n");

  return `${BASE_RULES}

TASK: Critically evaluate the candidate's answer against the sources and examiner standards.

OUTPUT ONLY THE SECTIONS BELOW — nothing else. Do not add sections the user did not request.

${sections}

Marking must be strict, evidence-based and consistent with the uploaded marking guides/standards.

LESSONS LEARNED (never repeat these mistakes):
${lessons}

SOURCE DOCUMENTS:
${sources}`;
}
