/**
 * Models occasionally emit LaTeX math markup even when told not to
 * (e.g. `$\text{Rs. } 195 \times \frac{150}{240}$`). It must never reach the
 * user as backslash soup — in the chat renderer or in Word/PDF exports.
 * These helpers convert the most common LaTeX constructs to plain text.
 */

/** Read a balanced {...} group starting at `start`; returns body and end index. */
function readBraceGroup(s: string, start: number): { body: string; end: number } | null {
  if (s[start] !== "{") return null;
  let depth = 0;
  for (let i = start; i < s.length; i++) {
    if (s[i] === "{") depth++;
    else if (s[i] === "}") {
      depth--;
      if (depth === 0) return { body: s.slice(start + 1, i), end: i + 1 };
    }
  }
  return null;
}

/** Replace the first \frac{a}{b} with "(a / b)". Nested fracs resolve by re-running. */
function replaceFirstFrac(s: string): string {
  const idx = s.indexOf("\\frac");
  if (idx === -1) return s;
  const num = readBraceGroup(s, idx + 5);
  if (!num) return s;
  const den = readBraceGroup(s, num.end);
  if (!den) return s;
  return s.slice(0, idx) + `(${num.body} / ${den.body})` + s.slice(den.end);
}

/** Convert the body of a math expression to plain text. */
function decodeMathBody(raw: string): string {
  let out = raw;
  // Resolve fractions (outermost first, nested ones on later passes).
  for (let i = 0; i < 12 && out.includes("\\frac"); i++) {
    out = replaceFirstFrac(out);
  }
  out = out
    .replace(/\\text\s*\{([^{}]*)\}/g, "$1")
    .replace(/\\mathrm\s*\{([^{}]*)\}/g, "$1")
    .replace(/\\operatorname\s*\{([^{}]*)\}/g, "$1")
    .replace(/\^\s*\{([^{}]*)\}/g, "^$1")
    .replace(/_\s*\{([^{}]*)\}/g, "_$1")
    .replace(/\\times/g, " × ")
    .replace(/\\cdot/g, " × ")
    .replace(/\\div/g, " ÷ ")
    .replace(/\\leq|\\le\b/g, " ≤ ")
    .replace(/\\geq|\\ge\b/g, " ≥ ")
    .replace(/\\neq?/g, " ≠ ")
    .replace(/\\approx/g, " ≈ ")
    .replace(/\\pm/g, "±")
    .replace(/\\%/g, "%")
    .replace(/\\\$/g, "$")
    .replace(/\\left|\\right/g, "")
    .replace(/\\[a-zA-Z]+\b/g, " ")
    .replace(/[{}]/g, "")
    .replace(/[ \t]{2,}/g, " ")
    .replace(/ ?\n ?/g, " ");
  return out.trim();
}

/** Strip math delimiters and decode their contents; leave ordinary text alone. */
export function decodeLatexToText(input: string): string {
  if (!input.includes("\\") && !input.includes("$")) return input;
  return input
    .replace(/\$\$([\s\S]+?)\$\$/g, (_, m) => decodeMathBody(m))
    .replace(/\$([^$\n]+?)\$/g, (_, m) => decodeMathBody(m))
    .replace(/\\\(([\s\S]+?)\\\)/g, (_, m) => decodeMathBody(m))
    .replace(/\\\[([\s\S]+?)\\\]/g, (_, m) => decodeMathBody(m));
}
