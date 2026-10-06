/**
 * Contract checks for the marking prompts. The critical-evaluation rules below
 * are what keep the marker honest (a weak answer must not score ~80%), so they
 * must survive every future prompt edit. Run manually:
 *   npx -y tsx tests/marking-prompt.test.ts   (or: bun tests/marking-prompt.test.ts)
 */

import {
  askSystemPrompt,
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
const parts = ["feedback", "marks", "suggested", "recommendations"] as const;

const ask = askSystemPrompt(sources, "None recorded yet.");
check("ask: direct answer remains first", ask.includes("FIRST line, in bold"));
check(
  "ask: readable hierarchy is mandatory",
  ask.includes("READABLE RESPONSE STRUCTURE") && ask.includes("short, descriptive headings"),
);
check(
  "ask: developed answers follow rule, application, approach and conclusion",
  ask.includes("**Rule** → **Application to the scenario/question** → **Approach** → **Conclusion**") &&
    ask.includes("connect that rule to the specific facts, figures or requirement") &&
    ask.includes("how to deal with or solve the issue"),
);
check(
  "ask: added explanation cannot weaken precision",
  ask.includes("without adding filler") &&
    ask.includes("never give a generic explanation that ignores those facts"),
);
check(
  "ask: dense text and unnecessary tables are prevented",
  ask.includes("Break dense explanations into bullets") &&
    ask.includes("Use a markdown table only when comparing like-for-like items or showing workings"),
);
check(
  "ask: repeated summaries and clutter are prevented",
  ask.includes("Do not repeat the same point under more than one heading") &&
    ask.includes("Do not add a repeated summary or conclusion"),
);

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
    `${rigour}: omitting the topic/standard name never costs marks`,
    prompt.includes("TOPIC AND STANDARD NAMES ARE NOT MARKS"),
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
  check(
    `${rigour}: feedback omits alternative and pending-review sections`,
    !prompt.includes("**Valid alternatives credited**") && !prompt.includes("**Pending review**"),
  );
  check(
    `${rigour}: errors and omissions show exact deductions`,
    prompt.includes("Every error must show its exact deduction") &&
      prompt.includes("Every omission must show its exact deduction"),
  );
  check(
    `${rigour}: official answer is the closed benchmark`,
    prompt.includes("THE OFFICIAL ANSWER IS THE BENCHMARK") &&
      prompt.includes("could also be an acceptable answer"),
  );
  check(
    `${rigour}: every line gets a verdict against the answer`,
    prompt.includes("LINE-BY-LINE VERDICT") && prompt.includes("Doubt always resolves to zero"),
  );
  check(
    `${rigour}: alternatives need explicit source permission`,
    prompt.includes("EXPLICITLY state it is acceptable") && prompt.includes("NOT-IN-ANSWER"),
  );
  check(`${rigour}: match-rate ceiling caps the total`, prompt.includes("MATCH-RATE CEILING"));
  check(
    `${rigour}: credited points are concise`,
    prompt.includes("Do NOT reproduce, quote or paraphrase all of the candidate's wording"),
  );
}

// Strictness ordering must stay: moderate > strict > hard expectations.
const strict = markSystemPrompt(sources, "None recorded yet.", [...parts], "strict");
check("strict: generic statements earn zero", strict.includes("GENERIC = ZERO"));
check("strict: weak answers land at 35-50%, not 60%+", strict.includes("35-50%"));
check(
  "strict: claim-by-claim decomposition required (no holistic scoring)",
  strict.includes("CLAIM-BY-CLAIM DECOMPOSITION") && strict.includes("VAGUE-HEDGING"),
);
check("strict: gap audit for missing elements present", strict.includes("GAP AUDIT"));
check(
  "strict: reasoning must support the conclusion",
  strict.includes("REASONING-SUPPORTS-CONCLUSION CHECK"),
);
check(
  "strict: ambiguity resolves against the candidate",
  strict.includes("AMBIGUITY RESOLVES AGAINST THE CANDIDATE"),
);
check(
  "strict: no score may be formed before the analysis",
  strict.includes("NO NUMBER BEFORE THE ANALYSIS"),
);
check(
  "strict: coverage cross-check caps inflated totals",
  strict.includes("COVERAGE CROSS-CHECK") && strict.includes("HARD CEILING FROM COVERAGE"),
);
check("strict: deduction ledger must reconcile", strict.includes("DEDUCTION LEDGER"));
check(
  "strict: no credit for confidence, length or fluency",
  strict.includes("NO CREDIT FOR CONFIDENCE, LENGTH OR FLUENCY"),
);
check("strict: vague hedging earns zero", strict.includes("VAGUE HEDGING = ZERO"));
check(
  "strict: correct but irrelevant earns zero",
  strict.includes("CORRECT BUT IRRELEVANT = ZERO"),
);
check(
  "strict: the question's tested skill is identified first",
  strict.includes("IDENTIFY WHAT THE QUESTION TESTS"),
);
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
