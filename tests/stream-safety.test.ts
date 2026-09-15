/**
 * Regression tests for interrupted AI runs and quota failures.
 *
 * The bug these guard against is quiet data corruption: a stream that dies
 * half-way through a marking report looks, to every consumer downstream, like a
 * finished report — so it gets saved, its marks get parsed, and the performance
 * charts inherit a verdict the model never finished writing. Persistence is
 * therefore a decision with a rule, and the rule lives in stream-safety.
 * Run: npm test
 */

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  INCOMPLETE_MARKER,
  QUOTA_MARKER,
  hasIncompleteMarker,
  incompleteReasonFor,
  isClassificationComplete,
  isMarkingReportComplete,
  shouldPersistVerdict,
  stripMarkers,
  withMarker,
} from "../src/lib/stream-safety.ts";
import { quotaNotice, quotaNoticeBody, quotaResponseStatus } from "../src/lib/provider-policy.ts";
import { readServerFlag } from "../src/lib/load-env.ts";

const ALL_PARTS = ["feedback", "marks", "suggested", "recommendations"] as const;

/** A report the app would accept, built the way the prompt demands. */
const completeReport = `# 🔍 Item-by-Item Detailed Marking & Feedback

**Matter (i): Depreciation**
- Candidate's words: "Rs 4,000,000 a year"
- Requirement satisfied: charge for the year
- Technical support: [Source: Study Text]
- Marks awarded: 2

# ✅ Suggested Answer

Work the charge line before concluding.

# 🎯 Recommendations

Practise two-part requirements in the order asked.

# 📊 Marks

| Item | Marks available | Marks awarded | Justification |
|---|---|---|---|
| Charge | 4 | 2 | "Rs 4,000,000 a year" |

**Marks awarded: 2 / 4**
`;

test("a structurally complete marking report is allowed to be saved", () => {
  assert.deepEqual(isMarkingReportComplete(completeReport, [...ALL_PARTS]), { ok: true });
  assert.deepEqual(
    shouldPersistVerdict({
      mode: "mark",
      text: completeReport,
      streamCompleted: true,
      requestedParts: [...ALL_PARTS],
    }),
    { persist: true },
  );
});

test("a truncated report is never persisted, and the client is told via a marker", () => {
  const half = completeReport.slice(0, completeReport.indexOf("# 🎯 Recommendations"));
  const verdict = shouldPersistVerdict({
    mode: "mark",
    text: half,
    streamCompleted: true,
    requestedParts: [...ALL_PARTS],
  });
  assert.equal(verdict.persist, false);
  assert.match(verdict.reason ?? "", /recommendations section never arrived/);
  assert.equal(verdict.marker, INCOMPLETE_MARKER);

  const body = withMarker(half, verdict.marker!);
  assert.ok(hasIncompleteMarker(body));
  assert.match(incompleteReasonFor(body) ?? "", /not saved as a result/);
  assert.equal(stripMarkers(body), half.trimEnd(), "the sentinel never reaches the saved text");
});

test("a stream that dropped mid-answer is not saved even when the text looks finished", () => {
  const verdict = shouldPersistVerdict({
    mode: "mark",
    text: completeReport,
    streamCompleted: false,
  });
  assert.equal(verdict.persist, false);
  assert.match(verdict.reason ?? "", /interrupted/);
  assert.equal(verdict.marker, INCOMPLETE_MARKER);
});

test("an empty answer is not saved and is not reported as an interruption", () => {
  assert.deepEqual(shouldPersistVerdict({ mode: "ask", text: "   ", streamCompleted: true }), {
    persist: false,
    reason: "no text was produced",
  });
});

test("output that stops inside a table row or right after a heading is incomplete", () => {
  const inTable = `${completeReport}\n| Cut off line | 3`;
  assert.equal(isMarkingReportComplete(inTable, [...ALL_PARTS]).ok, false);
  assert.match(isMarkingReportComplete(inTable, [...ALL_PARTS]).reason ?? "", /table row/);

  const afterHeading = `${completeReport.replace(/\*\*Marks awarded.*/, "")}## 📊 Marks\n`;
  const check = isMarkingReportComplete(afterHeading, ["marks"]);
  assert.equal(check.ok, false);
  assert.match(check.reason ?? "", /total|heading/);
});

test("a marks section with no total is a truncated verdict, not a 0/0 result", () => {
  const noTotal = `# 📊 Marks\n\n| Item | available | awarded |\n|---|---|---|\n| Charge | 4 | 2 |\n\n# ✅ Suggested answer\n\nSay the rate.\n\n# 🎯 Recommendations\n\nPractise timings.\n\n# 🔍 Feedback\n\nCite the clause. The candidate wrote a clear opening line about the allowance.`;
  const check = isMarkingReportComplete(noTotal, [
    "marks",
    "feedback",
    "suggested",
    "recommendations",
  ]);
  assert.equal(check.ok, false);
  assert.match(check.reason ?? "", /never stated a total/);
});

test("only the sections the user asked for are required", () => {
  const marksOnly = `# 📊 Marks\n\n| Item | available | awarded |\n|---|---|---|\n| Charge | 4 | 2 |\n\n**Marks awarded: 2 / 4** — workings are shown and the conclusion follows the figure.`;
  assert.deepEqual(isMarkingReportComplete(marksOnly, ["marks"]), { ok: true });
  assert.equal(
    shouldPersistVerdict({
      mode: "mark",
      text: marksOnly,
      streamCompleted: true,
      requestedParts: ["marks"],
    }).persist,
    true,
  );
});

test("unclosed formatting counts as a cut stream", () => {
  const bold = `${completeReport}\n**and one more point that never closed\n`;
  assert.equal(bold.split("**").length % 2, 0, "fixture has an odd number of bold markers");
  assert.match(isMarkingReportComplete(bold, [...ALL_PARTS]).reason ?? "", /unclosed bold/);
});

test("an unfinished reply of a few words is refused", () => {
  assert.deepEqual(isMarkingReportComplete("Looks good!", []), {
    ok: false,
    reason: "the response was only 11 characters",
  });
});

test("classification output is complete only when it is JSON", () => {
  assert.deepEqual(isClassificationComplete('[{"attempt":1}]'), { ok: true });
  assert.equal(isClassificationComplete("Here is my analysis of the attempts.").ok, false);
  assert.match(isClassificationComplete("no json here").reason ?? "", /no JSON/);
});

test("derived reports (insights, classification) are never written into attempt history", () => {
  for (const mode of ["insights", "classify"] as const) {
    const verdict = shouldPersistVerdict({ mode, text: completeReport, streamCompleted: true });
    assert.equal(verdict.persist, false);
    assert.match(verdict.reason ?? "", /not saved as attempts/);
    assert.equal(verdict.marker, undefined, "a normal, successful derived report is not an error");
  }
});

test("questions and exam drafts are saved as soon as the stream ended cleanly", () => {
  assert.deepEqual(
    shouldPersistVerdict({ mode: "ask", text: "Short but finished.", streamCompleted: true }),
    {
      persist: true,
    },
  );
  assert.equal(
    shouldPersistVerdict({ mode: "exam", text: "Question 1 (10 marks)", streamCompleted: false })
      .persist,
    false,
  );
});

test("a quota failure is marked as a quota failure, not as a generic cut stream", () => {
  const verdict = shouldPersistVerdict({
    mode: "mark",
    text: "Nothing more came.",
    streamCompleted: false,
    quotaFailure: true,
  });
  assert.equal(verdict.persist, false);
  assert.equal(verdict.marker, QUOTA_MARKER);
  const reason = incompleteReasonFor(withMarker("Nothing more came.", QUOTA_MARKER)) ?? "";
  assert.match(reason, /allowance ran out/);
  assert.match(reason, /No paid fallback was used/);
});

test("stripMarkers only removes a trailing sentinel, never one quoted mid-answer", () => {
  const quoted = `The marker ${INCOMPLETE_MARKER} means the run failed.\n\nEnd of my explanation.`;
  assert.equal(stripMarkers(quoted), quoted);
  assert.equal(stripMarkers(`Real answer.\n\n${INCOMPLETE_MARKER}`), "Real answer.");
});

test("a 402 is reported as exhausted allowance and never as a paid purchase", () => {
  const notice = quotaNotice(402, { personalKeys: {} });
  assert.equal(notice.kind, "quota");
  assert.equal(notice.retryable, false);
  assert.equal(notice.paidFallbackUsed, false);
  assert.equal(quotaResponseStatus(notice, false), 402);
  const body = quotaNoticeBody(notice);
  assert.match(body, /allowance for this deployment is used up/);
  assert.match(body, /No paid fallback was used/);
  assert.ok(
    !/successfully|your marks are/i.test(body),
    "a failed run must never read like a result",
  );
});

test("the paid-fallback wording only appears when the operator opted in", () => {
  const off = quotaNotice(402, { paidFallback: false });
  const on = quotaNotice(402, { paidFallback: true });
  assert.match(quotaNoticeBody(off), /No paid fallback was used/);
  assert.match(quotaNoticeBody(on), /Paid on-demand fallback is enabled/);
  assert.equal(on.paidFallbackUsed, false, "enabling the option is not a claim that it was used");
});

test("rate limits are retryable, refusals are not, and personal keys change the status", () => {
  assert.equal(quotaNotice(429, {}).retryable, true);
  assert.equal(quotaResponseStatus(quotaNotice(429, {}), false), 429);
  const blocked = quotaNotice(403, {});
  assert.equal(blocked.kind, "blocked");
  assert.equal(blocked.retryable, false);
  // With the user's own keys configured, "out of shared allowance" is not the
  // actionable message, so the route answers 502 across the whole chain.
  assert.equal(
    quotaResponseStatus(quotaNotice(402, { personalKeys: { gemini: true } }), true),
    502,
  );
  assert.equal(quotaNotice(599, {}).kind, "unreachable");
});

test("an unconfigured deployment says so instead of failing obscurely", () => {
  const notice = quotaNotice(402, { unconfigured: true });
  assert.equal(notice.status, 503);
  assert.match(quotaNoticeBody(notice).toLowerCase(), /nothing was sent and nothing was saved/);
});

test("spending and billing switches stay off unless the deployment says so", () => {
  const before = {
    public: process.env["ENABLE_PUBLIC_ICAP"],
    paid: process.env["ENABLE_PAID_FALLBACK"],
  };
  try {
    delete process.env["ENABLE_PUBLIC_ICAP"];
    delete process.env["ENABLE_PAID_FALLBACK"];
    assert.equal(readServerFlag("ENABLE_PUBLIC_ICAP"), false);
    assert.equal(readServerFlag("ENABLE_PAID_FALLBACK"), false);
    process.env["ENABLE_PAID_FALLBACK"] = "false";
    assert.equal(readServerFlag("ENABLE_PAID_FALLBACK"), false);
    process.env["ENABLE_PUBLIC_ICAP"] = "TRUE";
    assert.equal(readServerFlag("ENABLE_PUBLIC_ICAP"), true);
  } finally {
    for (const [key, value] of Object.entries(before)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

test("every AI setting the code reads is documented in .env.example", () => {
  const example = readFileSync(new URL("../.env.example", import.meta.url), "utf8");
  for (const key of [
    "GEMINI_API_KEY",
    "GEMINI_MODEL",
    "GROQ_API_KEY",
    "GROK_API_KEY",
    "LOVABLE_API_KEY",
    "SUPABASE_URL",
    "SUPABASE_PUBLISHABLE_KEY",
    "STUDY_REASONING_EFFORT",
    "ENABLE_PUBLIC_ICAP",
    "ENABLE_PAID_FALLBACK",
  ]) {
    assert.match(example, new RegExp(`^#?\\s*${key}=`, "m"), `${key} is missing from .env.example`);
  }
  // The two spending switches must ship disabled.
  assert.match(example, /^ENABLE_PUBLIC_ICAP=false$/m);
  assert.match(example, /^ENABLE_PAID_FALLBACK=false$/m);
});
