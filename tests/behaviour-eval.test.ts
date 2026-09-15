/**
 * Behaviour evaluation for the marking / exam-setting prompts.
 *
 * `tests/eval/behaviour-cases.json` is the written contract of this desk: a
 * correct alternative that the suggested answer never mentioned, a point said
 * four times, a compulsory element the candidate skipped, an alternative no
 * source supports, a new subject with no past papers, a question paper that
 * must not leak its own marking guide. Each case is checked in two halves:
 *
 *   offline — the real prompt builders are asked for the rule, and the app's own
 *     validators are fed the artefact a fair marker would have produced, so the
 *     scoring, dedupe and exclusion rules are proven without a model call;
 *   live (`RUN_LIVE_EVAL=1` + `GEMINI_API_KEY`) — the same case is put to the
 *     model and its answer is checked by the same validators.
 *
 * `npm test` runs the offline half only, so CI stays deterministic and free.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  examSetterSystemPrompt,
  markSystemPrompt,
  buildSourceBlock,
  type ExamDifficulty,
  type MarkPart,
  type Rigour,
} from "../src/lib/study-prompts.ts";
import {
  parseClassificationReport,
  parseMarksFromReport,
  recordKey,
  scoreGroup,
} from "../src/lib/performance-model.ts";
import { isMarkingReportComplete } from "../src/lib/stream-safety.ts";

type EvalCase = {
  id: string;
  title: string;
  mode: "mark" | "exam";
  rigour?: Rigour;
  difficulty?: ExamDifficulty;
  parts?: MarkPart[];
  rubric: string;
  inputs: {
    question: string;
    userAnswer?: string;
    suggestedAnswer?: string;
    sources: { name: string; extracted_text: string }[];
  };
  artifacts: Record<string, unknown>;
  expect: {
    promptMustContain?: string[];
    promptMustNotContain?: string[];
    deterministic?: { assert: string; [key: string]: unknown }[];
  };
  live?: { assertions?: { mustMatch?: string; mustNotMatch?: string; marksNotAbove?: number }[] };
};

const suite = JSON.parse(
  readFileSync(new URL("./eval/behaviour-cases.json", import.meta.url), "utf8"),
) as { version: number; cases: EvalCase[] };

const ALL_PARTS: MarkPart[] = ["feedback", "marks", "suggested", "recommendations"];

function buildPrompt(c: EvalCase): string {
  const sources = buildSourceBlock(c.inputs.sources);
  const lessons = c.inputs.userAnswer
    ? `CANDIDATE'S ANSWER TO THE PART ABOVE (verbatim):\n${c.inputs.userAnswer}`
    : "NO_LESSONS";
  return c.mode === "exam"
    ? examSetterSystemPrompt(sources, lessons, c.difficulty ?? "medium")
    : markSystemPrompt(sources, lessons, c.parts ?? ALL_PARTS, c.rigour ?? "strict");
}

const artifactText = (c: EvalCase, key: string): string => {
  const value = c.artifacts[key];
  if (typeof value === "string") return value;
  return JSON.stringify(value ?? "", null, 2);
};

/** A copy of a row whose part label is written differently but means the same part. */
function rewritten(row: Record<string, unknown>): Record<string, unknown> {
  const part = String(row["part"] ?? "");
  const alias = /^(?:q\d+[\s.]*)?\(?(?<key>[a-z0-9ivx]+)\)?$/i.exec(part)?.groups?.["key"] ?? "a";
  return { ...row, part: `Question 1 (${alias})` };
}

const asserts: Record<string, (c: EvalCase, args: Record<string, unknown>) => string | void> = {
  // A fair report's own numbers must survive the app's validator untouched:
  // nothing dropped, nothing inflated, and the percentage is the weighted one.
  classificationAccepted(c, args) {
    const rows = (c.artifacts["classification"] ?? []) as Record<string, unknown>[];
    const parsed = parseClassificationReport(JSON.stringify(rows), [1]);
    if (parsed.error) return `classification was rejected: ${parsed.error}`;
    if (parsed.rejected.length) return `rows were rejected: ${JSON.stringify(parsed.rejected)}`;
    const expectCount = Number(args["expectCount"]);
    if (parsed.records.length !== expectCount) {
      return `expected ${expectCount} row(s), got ${parsed.records.length}`;
    }
    const percent = scoreGroup("topic", parsed.records).percent;
    if (percent !== Number(args["expectPercent"]))
      return `percent was ${percent}, expected ${args["expectPercent"]}`;
    return undefined;
  },

  // The same part reported twice is a double count: the second row is refused.
  duplicateRowsRejected(c) {
    const rows = (c.artifacts["classification"] ?? []) as Record<string, unknown>[];
    const first = rows[0];
    if (!first) return "no rows to duplicate";
    const parsed = parseClassificationReport(JSON.stringify([...rows, rewritten(first)]), [1]);
    const duplicate = parsed.rejected.find((r) => /duplicate/.test(r.reason));
    if (!duplicate) return "a repeated attempt+part row was accepted";
    const inflated = scoreGroup("t", parsed.records).available;
    const honest = rows.reduce((sum, r) => sum + Number(r["available"] ?? 0), 0);
    if (inflated !== honest)
      return `the duplicate changed the denominator (${honest} → ${inflated})`;
    return undefined;
  },

  // Marks cannot be borrowed between matters: one topic, two parts, and each
  // part carries only its own lost marks.
  multiPartSplit(c, args) {
    const rows = (c.artifacts["classification"] ?? []) as Record<string, unknown>[];
    const parsed = parseClassificationReport(JSON.stringify(rows), [1]);
    const topics = new Set(parsed.records.map((r) => r.topic));
    const parts = new Set(parsed.records.map((r) => recordKey(r)));
    if (topics.size !== Number(args["expectTopics"])) return `topics: ${topics.size}`;
    if (parts.size !== Number(args["expectParts"])) return `parts: ${parts.size}`;
    return undefined;
  },

  // A guess is never a data point: nothing counted, and no percentage invented.
  lowConfidenceExcluded(c, args) {
    const rows = (c.artifacts["classification"] ?? []) as Record<string, unknown>[];
    const parsed = parseClassificationReport(JSON.stringify(rows), [1]);
    const counted = parsed.records.filter((r) => r.confidence !== "low" && r.awarded !== null);
    if (counted.length !== Number(args["expectCounted"])) return `counted rows: ${counted.length}`;
    const percent = scoreGroup("t", parsed.records).percent;
    const expected = args["expectPercent"];
    if (expected === null ? percent !== null : percent !== Number(expected)) {
      return `percent was ${percent}, expected ${String(expected)}`;
    }
    return undefined;
  },

  // A section the prompt promises must actually be in the report the case shows.
  reportSectionPresent(c, args) {
    const section = String(args["section"]);
    const report = artifactText(c, "report");
    if (
      !new RegExp(
        `\\n?#{0,4}\\s*\\*{0,2}${section.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`,
        "i",
      ).test(report)
    ) {
      return `the report has no "${section}" section`;
    }
    return undefined;
  },

  // An exam paper is neutral text: no provenance, no teaching notes, no citations.
  headingsAreNeutral(c, args) {
    const key =
      String(args["of"] ?? "artifacts.report")
        .split(".")
        .pop() ?? "report";
    const text = artifactText(c, key);
    const leak =
      /learning objective|syllabus|examiner|official|as examined|markscheme|\[Source:|Modelled on|New angle|Hidden (issue|angle)|Standard \d|topic:? /i.exec(
        text
          .split("\n")
          .filter((line) => !/^\s*[|(]/.test(line))
          .join("\n"),
      );
    if (leak) return `the candidate-facing text leaked "${leak[0]}"`;
    if (!/^\s*Question \d+ \(\d{1,2} marks\)/i.test(text))
      return "the paper does not open with a neutral question heading";
    return undefined;
  },

  // The branch's own policy: what the candidate labelled the answer is not a
  // mark either way, so no sentence in a fair report may read as a naming penalty.
  noNamingPenalty(c, args) {
    const key =
      String(args["of"] ?? "artifacts.report")
        .split(".")
        .pop() ?? "report";
    const naming =
      /\b(?:did not|didn't|never|without|failing to|not)\s+(?:the\s+)?(?:name|naming|titled|labelled|labeled|cite|state the (?:topic|standard|chapter|section))\b|\b(?:topic|standard|chapter|section)\s+(?:name|title|label)\b|\bno\s+(?:topic|standard|chapter)\s+name\b/i;
    const exonerating =
      /never|no deduction|not deducted|not penalised|not penalized|earns nothing|does not cost|cuts both ways|not a weakness|no mark for the label/i;
    for (const sentence of artifactText(c, key).split(/(?<=[.!?])\s|\n/)) {
      if (naming.test(sentence) && !exonerating.test(sentence)) {
        return `the report treats a name as a mark: "${sentence.trim()}"`;
      }
    }
    const rows = (c.artifacts["classification"] ?? []) as Record<string, unknown>[];
    for (const r of rows) {
      if (
        naming.test(String(r["weakness"] ?? "")) &&
        !exonerating.test(String(r["weakness"] ?? ""))
      ) {
        return `a row was called a weakness for its label: "${r["weakness"]}"`;
      }
    }
    const parsed = parseClassificationReport(JSON.stringify(rows), [1]);
    const perfect = parsed.records.find((r) => r.awarded === r.available && r.confidence !== "low");
    if (!perfect) return "a complete answer that named nothing was not carried to full marks";
    return undefined;
  },

  noLeaks(c, args) {
    const key =
      String(args["of"] ?? "artifacts.candidatePaper")
        .split(".")
        .pop() ?? "candidatePaper";
    const text = artifactText(c, key);
    const leak =
      /marking guide|mark scheme|expected answer|suggested answer|compulsory element|acceptable alternative|point expected|\[Source:|Modelled on|Learning objective/i.exec(
        text,
      );
    if (leak) return `the candidate paper leaked "${leak[0]}"`;
    if (/answer|explain why this is|the point is/i.test(text) && !/\*\*Required/i.test(text)) {
      return "the candidate paper appears to contain the answer";
    }
    return undefined;
  },

  // The marks a paper advertises must be the marks its parts add up to.
  marksSum(c, args) {
    const key =
      String(args["of"] ?? "artifacts.candidatePaper")
        .split(".")
        .pop() ?? "candidatePaper";
    const text = artifactText(c, key);
    const total = /Question \d+ \((\d{1,3}) marks?\)/i.exec(text)?.[1];
    if (!total) return "no total marks stated on the question";
    const parts = [
      ...text.matchAll(/^\s*\(?[a-z0-9ivx]{1,4}\)?\.?\s+.*?\((\d{1,3})\s*marks?\)\s*$/gim),
    ].map((m) => Number(m[1]));
    const sum = parts.reduce((a, b) => a + b, 0);
    if (!parts.length) return "no part mark allocations to check";
    if (sum !== Number(total)) return `the parts add up to ${sum} but the question says ${total}`;
    return undefined;
  },
};

for (const c of suite.cases) {
  test(`${c.id}: the built prompt states the rule the case protects`, () => {
    const prompt = buildPrompt(c);
    for (const needle of c.expect.promptMustContain ?? []) {
      assert.ok(prompt.includes(needle), `the ${c.mode} prompt is missing "${needle}"`);
    }
    for (const needle of c.expect.promptMustNotContain ?? []) {
      assert.ok(!prompt.includes(needle), `the ${c.mode} prompt re-introduced "${needle}"`);
    }
    assert.ok(
      prompt.includes("never"),
      "the prompt must contain its prohibitions, not only its permissions",
    );
  });

  test(`${c.id}: the app's own validators agree with the fair outcome`, () => {
    for (const assertion of c.expect.deterministic ?? []) {
      const { assert: name, ...args } = assertion;
      const run = asserts[name];
      assert.ok(run, `no deterministic check implemented for "${name}"`);
      const failure = run(c, args);
      assert.equal(failure, undefined, `${name}: ${failure}\n${c.rubric}`);
    }
  });

  if (c.mode === "mark") {
    test(`${c.id}: the report itself is a complete verdict, so it may be saved`, () => {
      const check = isMarkingReportComplete(artifactText(c, "report"), c.parts ?? ALL_PARTS);
      assert.equal(check.ok, true, check.reason);
      const marks = parseMarksFromReport(artifactText(c, "report"));
      assert.ok(marks.awarded !== null && marks.available !== null, "the report states no total");
      assert.ok(
        marks.awarded <= marks.available,
        `${marks.awarded}/${marks.available} is not a possible score`,
      );
    });
  }
}

test("every case in the suite is executable", () => {
  for (const c of suite.cases) {
    assert.ok(c.title.length > 10, `${c.id} has no description`);
    assert.ok((c.expect.promptMustContain?.length ?? 0) > 0, `${c.id} checks no rule`);
    assert.ok((c.expect.deterministic?.length ?? 0) > 0, `${c.id} checks no outcome`);
    for (const assertion of c.expect.deterministic ?? []) {
      assert.ok(
        asserts[assertion.assert],
        `${c.id} asks for an unimplemented check "${assertion.assert}"`,
      );
    }
  }
});

/* ------------------------------------------------------------------ *
 * Live half. Opt in with RUN_LIVE_EVAL=1 and a GEMINI_API_KEY; the
 * cases above are then put to the model and judged by the same rules.
 * ------------------------------------------------------------------ */

const liveEnabled = process.env["RUN_LIVE_EVAL"] === "1" && Boolean(process.env["GEMINI_API_KEY"]);

test(
  "live model run agrees with the offline contract",
  { skip: liveEnabled ? false : "set RUN_LIVE_EVAL=1 with GEMINI_API_KEY" },
  async () => {
    const model = process.env["GEMINI_MODEL"]?.replace(/^google\//, "") || "gemini-2.5-pro";
    for (const c of suite.cases) {
      const prompt = buildPrompt(c);
      const userTurn =
        c.mode === "exam"
          ? c.inputs.question
          : `QUESTION:\n${c.inputs.question}\n\nCANDIDATE'S ANSWER:\n${c.inputs.userAnswer ?? ""}\n\nMark it.`;
      const response = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${process.env["GEMINI_API_KEY"]}`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            system_instruction: { parts: [{ text: prompt }] },
            contents: [{ role: "user", parts: [{ text: userTurn }] }],
            generationConfig: { temperature: 0, topP: 0.1 },
          }),
        },
      );
      assert.equal(response.status, 200, `${c.id}: provider returned ${response.status}`);
      const body = (await response.json()) as {
        candidates?: { content?: { parts?: { text?: string }[] } }[];
      };
      const text = (body.candidates?.[0]?.content?.parts ?? []).map((p) => p.text ?? "").join("");
      assert.ok(text.trim().length > 80, `${c.id}: the model returned nothing usable`);

      for (const assertion of c.live?.assertions ?? []) {
        if (assertion.mustMatch) {
          assert.match(
            text,
            new RegExp(assertion.mustMatch, "i"),
            `${c.id}: expected "${assertion.mustMatch}"`,
          );
        }
        if (assertion.mustNotMatch) {
          assert.doesNotMatch(
            text,
            new RegExp(assertion.mustNotMatch, "i"),
            `${c.id}: leaked "${assertion.mustNotMatch}"`,
          );
        }
        if (typeof assertion.marksNotAbove === "number") {
          const marks = parseMarksFromReport(text);
          if (marks.awarded !== null) {
            assert.ok(
              marks.awarded <= assertion.marksNotAbove,
              `${c.id}: awarded ${marks.awarded} of ${marks.available}`,
            );
          }
        }
      }
    }
  },
);
