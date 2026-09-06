/**
 * Determinism contract: the SAME question + answer at the SAME severity must
 * always replay the SAME verdict, and anything that legitimately changes a
 * verdict must break the match. Run manually:
 *   npx -y tsx tests/marking-determinism.test.ts
 */

import { markingFingerprint, stripMarkFingerprint } from "../src/lib/marking-cache";
import type { StudyRequest } from "../src/lib/study-stream";

let failures = 0;
function check(label: string, ok: boolean) {
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}`);
  if (!ok) failures += 1;
}

const base: StudyRequest = {
  subjectId: "11111111-1111-1111-1111-111111111111",
  mode: "mark",
  question: "Q.1 Discuss the audit risks. (10 marks)",
  userAnswer: "The auditor should consider inherent risk and control risk.",
  parts: ["feedback", "marks", "suggested"],
  rigour: "strict",
};

const fp = (over: Partial<StudyRequest>) =>
  markingFingerprint({ ...base, ...over } as StudyRequest);

// Identical input → identical fingerprint (so the verdict is replayed).
check("identical submission matches", fp({}) === fp({}));
check(
  "whitespace-only difference still matches",
  fp({}) === fp({ question: "  Q.1   Discuss the audit risks.  (10 marks) " }),
);
check(
  "case-only difference still matches",
  fp({}) === fp({ userAnswer: "THE AUDITOR SHOULD CONSIDER INHERENT RISK AND CONTROL RISK." }),
);
check(
  "section order does not matter",
  fp({}) === fp({ parts: ["suggested", "marks", "feedback"] }),
);

// Anything that legitimately changes the verdict must NOT match.
check("severity change re-marks live", fp({}) !== fp({ rigour: "hard" }));
check("moderate differs from strict", fp({ rigour: "moderate" }) !== fp({ rigour: "strict" }));
check(
  "a changed answer re-marks live",
  fp({ userAnswer: "Different answer entirely." }) !== fp({}),
);
check("a changed question re-marks live", fp({ question: "Q.2 Something else." }) !== fp({}));
check(
  "a different set of sections re-marks live",
  fp({ parts: ["marks"] }) !== fp({ parts: ["feedback", "marks", "suggested"] }),
);
check(
  "a different notebook re-marks live",
  fp({ subjectId: "22222222-2222-2222-2222-222222222222" }) !== fp({}),
);
check("challenge mode is fingerprinted separately", fp({ mode: "challenge" }) !== fp({}));
check(
  "a different challenge query re-marks live",
  fp({ mode: "challenge", challengeQuery: "a" }) !== fp({ mode: "challenge", challengeQuery: "b" }),
);

// Non-marking modes are never replayed.
check("ask mode is not cached", markingFingerprint({ ...base, mode: "ask" }) === null);
check("exam mode is not cached", markingFingerprint({ ...base, mode: "exam" }) === null);

// The stored fingerprint marker never reaches the candidate.
const stored = "# Marks\n\n**Marks awarded: 12 / 30**\n<!-- mark-fingerprint:abc123def456 -->";
check(
  "fingerprint marker is stripped before display",
  stripMarkFingerprint(stored) === "# Marks\n\n**Marks awarded: 12 / 30**",
);
check(
  "a verdict without a marker is untouched",
  stripMarkFingerprint("# Marks\n\n12 / 30") === "# Marks\n\n12 / 30",
);

console.log(
  failures === 0
    ? "\nAll marking-determinism checks passed."
    : `\n${failures} determinism check(s) FAILED.`,
);
if (failures > 0) process.exitCode = 1;
