/**
 * Regression tests for the performance charts.
 *
 * These are the cases where an honest graph and a flattering one differ by one
 * line of arithmetic: a weighted denominator, a zero that is real data, a mark
 * that was never recorded, a part reported twice, a total that cannot exist.
 * Run: npm test
 */

import test from "node:test";
import assert from "node:assert/strict";

import {
  canonicalTopicName,
  countsTowardGraph,
  formatPercent,
  groupBySubtopic,
  groupByTopic,
  isStyleOnlyWeakness,
  parseClassificationReport,
  parseMarksFromReport,
  recordKey,
  scoreGroup,
  extractCanonicalTopics,
  type ClassificationRecord,
} from "../src/lib/performance-model.ts";

const row = (over: Partial<ClassificationRecord> = {}): ClassificationRecord => ({
  attempt: 1,
  part: "(a)",
  topic: "Income tax — salary",
  subtopic: "Deductions",
  confidence: "high",
  evidence: "The taxpayer claimed the allowance.",
  source: "Tax Notes",
  awarded: 3,
  available: 5,
  weakness: "No workings shown",
  action: "Show the subtraction line.",
  ...over,
});

const report = (rows: ClassificationRecord[], expected: number[] = [1]) =>
  parseClassificationReport(JSON.stringify(rows), expected);

test("score is weighted: sum awarded ÷ sum available, never an average of percentages", () => {
  // A 1/10 part and a 9/10 part. Averaging the two percentages would say 50%;
  // the marks actually earned are 10 of 20.
  const rows = [
    row({ part: "(a)", awarded: 1, available: 10 }),
    row({ part: "(b)", awarded: 9, available: 10 }),
  ];
  const group = scoreGroup("Income tax — salary", rows);
  assert.equal(group.awarded, 10);
  assert.equal(group.available, 20);
  assert.equal(group.percent, 50);
  assert.equal(formatPercent(group.percent), "50%");

  const skewed = scoreGroup("t", [
    row({ part: "(a)", awarded: 1, available: 2 }),
    row({ part: "(b)", awarded: 8, available: 10 }),
  ]);
  // Mean of percents would be 60%; the weighted score is 75% of 12 marks → 62.5%.
  assert.equal(skewed.percent, (9 / 12) * 100);
});

test("zero marks are preserved as a real score, not dropped or turned into null", () => {
  const rows = [
    row({ part: "(a)", awarded: 0, available: 6 }),
    row({ part: "(b)", awarded: 4, available: 4 }),
  ];
  const group = scoreGroup("Audit — risk", rows);
  assert.equal(group.percent, (4 / 10) * 100);
  assert.equal(group.zeroScores, 1);

  const allZero = scoreGroup("Audit — risk", [row({ awarded: 0, available: 8 })]);
  assert.equal(allZero.percent, 0);
  assert.equal(formatPercent(allZero.percent), "0%");
  assert.equal(allZero.awarded, 0);
});

test("missing marks are excluded from percentages and flagged, never guessed", () => {
  const rows = [
    row({ part: "(a)", awarded: 4, available: 8 }),
    row({ part: "(b)", awarded: null, available: null }),
  ];
  const parsed = report(rows);
  assert.equal(parsed.records.length, 2);
  assert.equal(countsTowardGraph(rows[1]!), false);

  const group = scoreGroup("t", rows);
  assert.equal(group.percent, 50, "only the row with real marks feeds the score");
  assert.equal(group.needsReview, 1);
  // A group where nothing has marks must not show 0% — that would be a lie.
  const nothing = scoreGroup("t", [row({ awarded: null, available: null })]);
  assert.equal(nothing.percent, null);
  assert.equal(formatPercent(nothing.percent), "—");
});

test("a low-confidence classification never enters a percentage", () => {
  const confident = row({ part: "(a)", awarded: 8, available: 10, confidence: "high" });
  const guessing = row({ part: "(b)", awarded: 10, available: 10, confidence: "low" });
  const group = scoreGroup("t", [confident, guessing]);
  assert.equal(group.percent, 80, "the unsure 10/10 row is excluded, not averaged in");
  assert.equal(group.needsReview, 1);
  assert.equal(countsTowardGraph(guessing), false);
});

test("duplicate attempt + part records are rejected, first row wins", () => {
  const parsed = report(
    [
      row({ attempt: 2, part: "(b)", awarded: 2, available: 8 }),
      row({ attempt: 2, part: "b)", awarded: 8, available: 8 }),
      row({ attempt: 2, part: "(c)", awarded: 4, available: 4 }),
    ],
    [2],
  );
  assert.equal(parsed.rejected.length, 1);
  assert.match(parsed.rejected[0]!.reason, /duplicate attempt 2/);
  assert.equal(parsed.records.length, 2);
  const group = scoreGroup("t", parsed.records);
  // 6 of 12, not 10 of 12: the inflated duplicate could not raise the score.
  assert.equal(group.awarded, 6);
  assert.equal(group.available, 12);
});

test("invalid totals are rejected instead of clamped or trusted", () => {
  const parsed = report([row({ awarded: 9, available: 5 })]);
  assert.equal(parsed.records.length, 0);
  assert.match(parsed.rejected[0]!.reason, /awarded 9 exceeds available 5/);

  const zeroAvailable = report([row({ awarded: 0, available: 0 })]);
  assert.match(zeroAvailable.rejected[0]!.reason, /available marks must be greater than 0/);

  const negative = report([row({ awarded: -1 })]);
  assert.equal(negative.records.length, 0);
  assert.match(negative.rejected[0]!.reason, /awarded/);
});

test("a report that omits an attempt is rejected, not shown as a partial picture", () => {
  const parsed = report([row({ attempt: 1 })], [1, 2, 3]);
  assert.equal(parsed.complete, false);
  assert.deepEqual(parsed.missingAttempts, [2, 3]);
  assert.match(parsed.error ?? "", /omitted attempts 2, 3/);

  const covered = report(
    [row({ attempt: 1 }), row({ attempt: 2 }), row({ attempt: 3 })],
    [1, 2, 3],
  );
  assert.equal(covered.complete, true);
  assert.equal(covered.error, undefined);
});

test("malformed rows are rejected with a reason, and prose around the JSON is tolerated", () => {
  const messy = `Here is the classification:\n\`\`\`json\n[{"attempt":"one","part":"(a)","topic":"x"},${JSON.stringify(
    row(),
  )}]\n\`\`\``;
  const parsed = parseClassificationReport(messy, [1]);
  assert.equal(parsed.records.length, 1);
  assert.equal(parsed.rejected.length, 1);
  assert.match(parsed.rejected[0]!.reason, /attempt/);
});

test("garbage in, loud failure out — no silent empty chart", () => {
  const parsed = parseClassificationReport("I could not classify these attempts.", [1]);
  assert.equal(parsed.records.length, 0);
  assert.equal(parsed.complete, false);
  assert.match(parsed.error ?? "", /not valid JSON/);
});

test('"6 / 10 marks" strings land in the right slot, so a fraction cannot inflate a score', () => {
  // Models habitually write the fraction into both fields despite being asked
  // for plain numbers. Available must read the denominator.
  const parsed = report([
    {
      ...row(),
      awarded: "6 / 10 marks" as unknown as number,
      available: "6 / 10 marks" as unknown as number,
    },
  ]);
  assert.equal(parsed.error, undefined);
  assert.equal(parsed.records[0]!.awarded, 6);
  assert.equal(parsed.records[0]!.available, 10);
  assert.equal(scoreGroup("t", parsed.records).percent, 60);

  const absent = report([
    { ...row(), awarded: "not stated" as unknown as number, available: null },
  ]);
  assert.equal(absent.records[0]!.awarded, null, "no digits, no invented number");
  assert.equal(absent.records[0]!.available, null);
});

test("attempt + part is the identity of a row", () => {
  assert.equal(recordKey({ attempt: 3, part: "Q3(b)" }), recordKey({ attempt: 3, part: "(b)" }));
  assert.notEqual(recordKey({ attempt: 3, part: "(b)" }), recordKey({ attempt: 4, part: "(b)" }));
});

test("topic grouping sorts worst first and keeps needs-review rows visible", () => {
  const groups = groupByTopic([
    row({ topic: "Audit — evidence", part: "(a)", awarded: 9, available: 10 }),
    row({ topic: "Audit — evidence", part: "(b)", awarded: 1, available: 10 }),
    row({ topic: "Tax — salary", part: "(a)", awarded: 0, available: 5 }),
    row({ topic: "Tax — salary", part: "(b)", awarded: null, available: null, confidence: "low" }),
  ]);
  assert.deepEqual(
    groups.map((g) => g.name),
    ["Tax — salary", "Audit — evidence"],
  );
  assert.equal(groups[0]!.percent, 0);
  assert.equal(groups[0]!.needsReview, 1);
  assert.equal(groups[1]!.percent, 50);

  const subtopics = groupBySubtopic([
    row({ subtopic: "Deductions" }),
    row({ subtopic: "Computation" }),
  ]);
  assert.equal(subtopics.length, 2);
  assert.match(subtopics[0]!.name, /›|—/);
});

test("canonical syllabus names win, so two spellings share one bar", () => {
  const canonical = ["Income tax — salary", "Audit evidence and documentation"];
  assert.equal(canonicalTopicName("income tax salary", canonical), "Income tax — salary");
  assert.equal(canonicalTopicName("Salary", canonical), "Income tax — salary");
  assert.equal(canonicalTopicName("Group audits", canonical), null);
});

test("canonical topics come from the notebook's own contents page", () => {
  const docs = [
    {
      name: "CFAP-3 Study Text contents",
      extracted_text:
        "[Page 1]\nCONTENTS\n1. Income tax — salary ........ 12\n2. Income tax — business income ........ 40\n3. Audit evidence and documentation ........ 88\nThe board must consider the going concern assumption carefully before signing.\n[Page 2]\nChapter 4 Deferred tax ........ 120",
    },
    { name: "Random past paper", extracted_text: "Q.1 Discuss. (10 marks)" },
  ];
  const topics = extractCanonicalTopics(docs);
  assert.ok(topics.includes("Income tax — salary"), topics.join(" | "));
  assert.ok(topics.includes("Audit evidence and documentation"));
  assert.ok(!topics.some((t) => /going concern assumption carefully before signing/.test(t)));
});

test("a document with no syllabus shape yields no invented taxonomy", () => {
  assert.deepEqual(
    extractCanonicalTopics([{ name: "Notes", extracted_text: "just prose here" }]),
    [],
  );
});

test("generic writing advice is never a knowledge weakness", () => {
  assert.equal(isStyleOnlyWeakness("Improve grammar and sentence structure"), true);
  assert.equal(isStyleOnlyWeakness("Wrong rate: the source states 29%"), false);
  assert.equal(
    isStyleOnlyWeakness("Presentation was untidy and the workings were missing"),
    false,
    "a real reasoning gap inside a style sentence still counts",
  );
});

test("marks are read from the report's own total line, and absent marks stay absent", () => {
  assert.deepEqual(parseMarksFromReport("...\n**Marks awarded: 12 / 20**"), {
    awarded: 12,
    available: 20,
  });
  assert.deepEqual(parseMarksFromReport("| **GRAND TOTAL** | 18 | 25 |"), {
    awarded: 18,
    available: 25,
  });
  assert.deepEqual(parseMarksFromReport("| Total | 7 | 10 |"), { awarded: 7, available: 10 });
  assert.deepEqual(parseMarksFromReport("No numbers anywhere here"), {
    awarded: null,
    available: null,
  });
});
