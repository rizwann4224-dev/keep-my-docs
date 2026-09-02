/**
 * Contract checks for the marking prompts. The critical-evaluation rules below
 * are what keep the marker honest (a weak answer must not score ~80%), so they
 * must survive every future prompt edit. Run manually:
 *   npx -y tsx tests/marking-prompt.test.ts   (or: bun tests/marking-prompt.test.ts)
 */

import { challengeSystemPrompt, markSystemPrompt } from "../src/lib/study-prompts";

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
  check(`${rigour}: Claude-style marker behaviour present`, prompt.includes("MARK LIKE CLAUDE"));
  check(
    `${rigour}: severity declared to the model`,
    prompt.includes(`Severity: ${rigour.toUpperCase()}`),
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

// Challenge mode re-grades with the same standard — no inflation on request.
const challenge = challengeSystemPrompt(sources, "None recorded yet.", "strict");
check("challenge: evidence rule carried over", challenge.includes("EVIDENCE RULE"));
check("challenge: calibration anchors carried over", challenge.includes("CALIBRATION ANCHORS"));
check("challenge: marker behaviour carried over", challenge.includes("MARK LIKE CLAUDE"));

if (failures > 0) {
  console.error(`\n${failures} check(s) FAILED`);
  process.exit(1);
}
console.log("\nAll marking-prompt contract checks passed.");
