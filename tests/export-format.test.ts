/**
 * Regression tests for the shared export formatting.
 *
 * The exports are the artefacts a candidate takes to a teacher, so two mistakes
 * matter more than any styling preference: a label that gets renumbered (the
 * answer no longer maps to the question) and a table that squeezes the one
 * column holding the explanation into 20 characters. Both are pure functions
 * here, so both are testable without a browser, a printer or a model.
 * Run: npm test
 */

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  conciseTitle,
  headingTooLong,
  isListContinuation,
  parseListLine,
  proportionalColumnWidths,
  shortenHeading,
} from "../src/lib/export-format.ts";

const len = (text: string) => text.length;

test("exam labels survive verbatim — nothing is renumbered", () => {
  const labels = [
    "1.",
    "2)",
    "(1)",
    "A.",
    "B)",
    "a.",
    "(a)",
    "(b)",
    "i.",
    "ii.",
    "(i)",
    "(iv)",
    "IV.",
    "Q3(b)",
  ];
  for (const label of labels) {
    const text = label === "Q3(b)" ? "Q3(b)" : "some requirement about depreciation";
    const parsed = parseListLine(`${label} ${text}`);
    if (label === "Q3(b)") {
      assert.equal(parsed.isListItem, false, "an inline reference is not a line label");
      continue;
    }
    assert.equal(parsed.isListItem, true, `${label} must be read as a label`);
    assert.equal(parsed.marker, label, `"${label}" must be written back exactly as it came`);
    assert.equal(parsed.text, text);
  }
});

test("nesting comes from the label style, so flattened text keeps its depth", () => {
  assert.equal(parseListLine("1. Compute the charge.").level, 0);
  assert.equal(parseListLine("A. Two methods exist.").level, 1);
  assert.equal(parseListLine("a. Straight line.").level, 2);
  assert.equal(parseListLine("(a) Straight line.").level, 2);
  assert.equal(parseListLine("ii. Year two.").level, 3);
  assert.equal(parseListLine("(ii) Year two.").level, 3);
});

test("measured indentation wins over the label style, and depth is capped", () => {
  assert.equal(parseListLine("      a. Deeply nested point").level, 3);
  assert.equal(parseListLine("            a. Very deep point").level, 4);
  assert.equal(parseListLine("            a. Very deep point", 2).level, 2);
});

test("ordinary prose and markdown structure are never mistaken for list items", () => {
  const plain = [
    "The candidate showed the subtraction line.",
    "| Item | Marks awarded |",
    "# Recommendations",
    "> Quoted from the study text.",
    "Dr. Ahmed computed 4,000,000.",
    "3.5 is not a label either.",
  ];
  for (const line of plain) {
    assert.equal(parseListLine(line).isListItem, false, `"${line}" is not a list item`);
  }
  // A label with nothing after it is a cut-off line, not an item.
  assert.equal(parseListLine("a.").isListItem, false);
  // Bold labels ("**1. point**") are content, not markers to hang.
  assert.equal(parseListLine("**1.** the first point").marker, "");
});

test("wrapped lines fold under their item instead of starting a new paragraph", () => {
  const first = parseListLine("1. Compute the depreciation charge for the year,");
  const second = "   showing the workings before the conclusion.";
  assert.equal(first.isListItem, true);
  assert.equal(isListContinuation(second, true), true);
  assert.equal(isListContinuation(second, false), false, "no item above, nothing to fold into");
  assert.equal(isListContinuation("2. The next labelled point.", true), false);
  assert.equal(isListContinuation("# Heading", true), false);
  assert.equal(isListContinuation("   ", true), false);
});

test("table columns take width in proportion to their content", () => {
  const rows = [
    ["Item", "Available", "Awarded", "Justification"],
    [
      "Recognise and explain the treatment of the revalued asset, including the OCI presentation and the effect on the carrying amount",
      "4",
      "2",
      "The figure is right; the reasoning is not stated in words.",
    ],
    ["Total", "10", "6", "ok"],
  ];
  const widths = proportionalColumnWidths(rows, 480, len, { min: 46, maxShare: 0.55 });
  assert.equal(widths.length, 4);
  assert.ok(widths[0]! > widths[1]!, "the prose column must be wider than a number column");
  assert.ok(widths[3]! > widths[2]!, "the justification column must beat a single digit");
  assert.ok(
    Math.abs(widths.reduce((a, b) => a + b, 0) - 480) < 1,
    `widths must span the page, got ${widths}`,
  );
  assert.ok(Math.min(...widths) >= 46, `every column keeps a readable floor, got ${widths}`);
  assert.ok(widths[1]! < 480 * 0.7, "one column cannot swallow the table");
});

test("degenerate tables still produce usable widths", () => {
  assert.deepEqual(proportionalColumnWidths([], 480, len), []);
  const ragged = proportionalColumnWidths([["a", "b", "c"], ["x"], ["y", "z"]], 300, len);
  assert.equal(ragged.length, 3);
  assert.ok(Math.abs(ragged.reduce((a, b) => a + b, 0) - 300) < 1);
  const single = proportionalColumnWidths([["only one column of text"]], 200, len);
  assert.equal(Math.round(single[0]!), 200);
});

test("export titles are short and honest, not the first paragraph of the answer", () => {
  assert.equal(
    conciseTitle("Question 3 (a) Explain the treatment of donations. (10 marks)"),
    "(a) Explain the treatment of donations.",
  );
  assert.equal(conciseTitle("# \n\n**Marks awarded: 2 / 4**"), "Marks awarded: 2 / 4");
  assert.equal(conciseTitle("**Question 2.** _Discuss._"), "Discuss");
  assert.ok(!conciseTitle("**Q1 Alpha**").includes("*"), "no literal markup in a title");
  assert.ok(!conciseTitle("### `Compute` the charge").includes("`"), "no code ticks in a title");
  const long = conciseTitle(
    `Q.4 ${"Discuss the audit approach and the documentation requirements. ".repeat(5)}`,
  );
  assert.ok(long.length <= 73, `title must fit a heading line, got ${long.length}`);
  assert.ok(long.endsWith("…"), "a truncated title says so");
  assert.equal(conciseTitle(""), "Marking report");
});

test("headings are capped instead of running three lines deep", () => {
  const short = "Recommendations for attempt 2";
  assert.equal(headingTooLong(short), false);
  assert.equal(shortenHeading(short), short);
  const long =
    "Detailed item by item marking of the candidate's response to part (b) of question 4 which covered the treatment";
  assert.equal(headingTooLong(long), true);
  const capped = shortenHeading(long);
  assert.ok(capped.length <= 91, `capped heading is ${capped.length} characters`);
  assert.ok(!/\s/.test(capped.slice(-1)), "the ellipsis sits on a word boundary");
  assert.equal(shortenHeading("already   spaced   out"), "already spaced out");
});

/* ------------------------------------------------------------------ *
 * Writer parity: the two exporters must apply the same rules, so the
 * checks below read the writers and assert the shared helpers are the
 * ones they actually call (a second, hand-rolled implementation in one
 * format is exactly how PDF and Word drifted apart before).
 * ------------------------------------------------------------------ */

const docx = readFileSync(new URL("../src/lib/export-docx.ts", import.meta.url), "utf8");
const pdf = readFileSync(new URL("../src/lib/export-pdf.ts", import.meta.url), "utf8");

test("Word uses one readable font, with page numbers, on every export", () => {
  assert.equal(/const WORD_FONT = "Calibri";/.test(docx), true);
  assert.ok(!docx.includes("Times New Roman"), "the serif default is retired");
  for (const name of ["exportMarkingToWord", "exportInsightsToWord", "exportHistoryToWord"]) {
    const start = docx.indexOf(`export async function ${name}`);
    assert.ok(start >= 0, `${name} is missing`);
    const next = docx.slice(start + 1).search(/^export /m);
    const body = docx.slice(start, next === -1 ? docx.length : start + 1 + next);
    assert.match(body, /styles: calibriStyles\(/, `${name} must use the Calibri styles`);
    assert.match(body, /footers: \{ default: pageFooter\(\) \}/, `${name} must number its pages`);
  }
});

test("both writers size tables from the content and cap a single column", () => {
  assert.match(docx, /proportionalColumnWidths\(/);
  assert.match(pdf, /proportionalColumnWidths\(/);
  assert.match(docx, /tableHeader/, "a table that spans a page repeats its header row in Word");
  assert.match(pdf, /repeatHeader|header/, "and in PDF");
});

test("both writers keep the source labels and reuse the same title rules", () => {
  assert.match(docx, /parseListLine\(/);
  assert.match(pdf, /parseListLine\(/);
  assert.match(docx, /conciseTitle\(/);
  assert.match(pdf, /conciseTitle\(/);
  assert.match(pdf, /shortenHeading\(/);
  // The performance export is landscape and renders the whole report, not just its table.
  assert.match(pdf, /new jsPDF\({[^}]*orientation: "landscape"/, "the PDF overview is landscape");
  assert.match(
    docx,
    /\.\.\.markdownToBlocks\(markdown, LANDSCAPE_WIDTH\)/,
    "the Word overview carries the whole report, not only the grid",
  );
});
