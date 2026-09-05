/**
 * Contract checks for the marking prompts. The critical-evaluation rules below
 * are what keep the marker honest (a weak answer must not score ~80%), so they
 * must survive every future prompt edit. Run manually:
 *   npx -y tsx tests/marking-prompt.test.ts   (or: bun tests/marking-prompt.test.ts)
 */

import {
  challengeSystemPrompt,
  countSubmissionQuestions,
  isMultiQuestionSubmission,
  markSystemPrompt,
} from "../src/lib/study-prompts";

let failures = 0;
function check(label: string, ok: boolean) {
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}`);
  if (!ok) failures += 1;
}

const sources = "<<<SOURCE 1: Test Manual>>>\nThe rate is 29%.\n<<<END SOURCE 1>>>";
const parts = ["feedback", "marks", "suggested", "recommendments"] as const;

// The rules that apply at every severity.
for (const rigour of ["moderate", "strict", "hard"] as const) {
  const prompt = markSystemPrompt(sources, "None recorded yet.", [...parts], rigour);
  check(`${rigour}: evidence rule present`, prompt.includes("EVIDENCE RULE"));
  check(`${rigour}: calibration anchors present`, prompt.includes("CALIBRATION ANCHORS"));
  check(`${rigour}: worked calibration example present`, prompt.includes("CALIBRATION EXAMPLE"));
  check(`${rigour}: adversarial re-read step present`, prompt.includes("ADVERSARIAL RE-READ"));
  check(`${rigour}: source sweep (all sources) present`, prompt.includes("SOURCE SWEEP FIRST"));
  check(
    `${rigour}: sceptical-examiner behaviour present`,
    prompt.includes("THE SCEPTICAL EXAMINER"),
  );
  check(
    `${rigour}: severity declared to the model`,
    prompt.includes(`Severity: ${rigour.toUpperCase()}`),
  );
  check(
    `${rigour}: grammar/language never costs marks (reasoning-only deductions)`,
    prompt.includes("REASONING-ONLY DEDUCTIONS") && prompt.includes("NEVER cost a single mark"),
  );
  check(
    `${rigour}: deductions must name their reasoning basis`,
    prompt.includes("DEDUCTIONS MUST NAME THEIR REASONING BASIS"),
  );
  check(
    `${rigour}: re-mark consistency rule present (same input → same marks)`,
    prompt.includes("RE-MARK CONSISTENCY"),
  );
  check(
    `${rigour}: multi-question submissions must be marked in full`,
    prompt.includes("MULTI-QUESTION SUBMISSIONS") && prompt.includes("QUESTION MANIFEST"),
  );
  check(
    `${rigour}: marks section ends with a machine-readable total line`,
    prompt.includes("Marks awarded: <X> / <Y>"),
  );
}

// Strictness ordering must stay: moderate > strict > hard expectations.
const strict = markSystemPrompt(sources, "None recorded yet.", [...parts], "strict");
check("strict: generic statements earn zero", strict.includes("GENERIC = ZERO"));
check("strict: weak answers land at 40-60%, not 75%+", strict.includes("40-60%"));
check("strict: knowledge dump cap present", strict.includes("KNOWLEDGE DUMP CAP"));
check(
  "strict: several missing elements make a point zero",
  strict.includes("Several missing elements make it ZERO"),
);
check(
  "strict: reasoning chain traced step by step before awarding",
  strict.includes("REASONING CHAIN REQUIRED, STEP BY STEP"),
);
check("strict: borderline points break downward", strict.includes("BORDERLINE BREAKS DOWNWARD"));
check(
  "strict: grammar is never a deduction reason",
  strict.includes("Grammar, spelling and phrasing are NEVER a reason for any deduction"),
);

// Hard must stay the harshest — with the same reasoning-first machinery.
const hard = markSystemPrompt(sources, "None recorded yet.", [...parts], "hard");
check("hard: reasoning chain traced step by step", hard.includes("REASONING CHAIN REQUIRED"));
check("hard: borderline points break downward", hard.includes("BORDERLINE BREAKS DOWNWARD"));
check(
  "hard: precise technical vocabulary is reasoning, not style",
  hard.includes("PRECISE TECHNICAL VOCABULARY IS REASONING, NOT STYLE"),
);
check(
  "hard: style-based deductions removed (no 'exam technique may cost')",
  !hard.includes("may cost at most 25%"),
);

// Multi-question (full past paper) detection.
const fullPaper = `AUTUMN 2024 EXAM — Attempt ALL questions.
Q.1 (a) Define audit risk. (04 marks) (b) State procedures. (06 marks)
Q.2 Discuss going concern. (10 marks)
Question 3 — Compute the tax liability. (15 marks)
Q.4(b) Explain internal controls. (08 marks)
Q.5 Advise the board. (12 marks)`;
check(
  "full paper: counts every question (5), not just Q.1",
  countSubmissionQuestions(fullPaper) === 5,
);
check("full paper: flagged multi-question", isMultiQuestionSubmission(fullPaper));

const singleQuestion = `Q.2 (a) Discuss the ethical threats. (05 marks)
(b) State the safeguards the firm should apply, per section 114. (05 marks)
The answer must reference Question 2's scenario only.`;
check(
  "single question with sub-parts: stays single",
  !isMultiQuestionSubmission(singleQuestion) && countSubmissionQuestions(singleQuestion) === 1,
);

const crossReference = `Q.3 Using your answer to Q.2 above, advise the directors on deferred tax.
(a) Compute the charge. (06 marks)
(b) Discuss presentation. (04 marks)`;
check(
  "question that references another question mid-sentence: stays single",
  !isMultiQuestionSubmission(crossReference) && countSubmissionQuestions(crossReference) === 1,
);

// Challenge mode re-grades with the same standard — no inflation on request.
const challenge = challengeSystemPrompt(sources, "None recorded yet.", "strict");
check("challenge: evidence rule carried over", challenge.includes("EVIDENCE RULE"));
check("challenge: calibration anchors carried over", challenge.includes("CALIBRATION ANCHORS"));
check("challenge: marker behaviour carried over", challenge.includes("THE SCEPTICAL EXAMINER"));
check(
  "challenge: reasoning-only deductions carried over",
  challenge.includes("REASONING-ONLY DEDUCTIONS"),
);

if (failures > 0) {
  console.error(`\n${failures} check(s) FAILED`);
  process.exit(1);
}
console.log("\nAll marking-prompt contract checks passed.");
