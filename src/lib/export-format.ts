/**
 * Export formatting primitives shared by the PDF and Word writers.
 *
 * Both exporters must agree on one thing: a candidate's (and a marker's) labels
 * carry meaning. "(b)" is a sub-part of a question, "ii." is inside "(b)", and
 * "1." is a numbered procedure — silently renumbering any of them (which the old
 * PDF writer did, flattening every bullet to "(i), (ii), (iii)") destroys the
 * mapping between the answer and the question. So the label is parsed, kept
 * verbatim, and only the INDENT changes with nesting.
 */

export type ListLabelKind =
  | "decimal"
  | "paren-decimal"
  | "upper-alpha"
  | "lower-alpha"
  | "paren-alpha"
  | "upper-roman"
  | "lower-roman"
  | "paren-roman"
  | "bullet"
  | "dash";

/** Default nesting depth for each label style, used when the text has no indentation. */
const KIND_LEVEL: Record<ListLabelKind, number> = {
  decimal: 0,
  "paren-decimal": 0,
  "upper-alpha": 1,
  "lower-alpha": 2,
  "paren-alpha": 2,
  "upper-roman": 3,
  "lower-roman": 3,
  "paren-roman": 3,
  bullet: 0,
  dash: 0,
};

const ROMAN = /^(?:x{0,3})(?:ix|iv|v?i{0,3})$/i;

/** Is the bare label token ("ii", "IV", "a") a real roman numeral? */
function isRoman(labelBody: string): boolean {
  return labelBody.length > 0 && labelBody.length <= 7 && ROMAN.test(labelBody);
}

const PATTERNS: { re: RegExp; kind: ListLabelKind; romanOnly?: boolean }[] = [
  // 1.  /  1)
  { re: /^(\d{1,3})[.)]\s+/, kind: "decimal" },
  // (1)  /  [1]
  { re: /^[([](\d{1,3})[)\]]\s+/, kind: "paren-decimal" },
  // I.  II.  III. — checked before the alphabet so "I." is read as a roman part
  // label (level 3), while "A." and "D." still fall through to upper-alpha.
  { re: /^([IVXLCDM]{1,7})\.\s+/, kind: "upper-roman", romanOnly: true },
  // A.  /  A)      (single capital letter, so "Dr." and "No." are safe)
  { re: /^([A-Z])[.)]\s+/, kind: "upper-alpha" },
  // i.  ii.  iii.
  { re: /^([ivxlcdm]{1,7})\.\s+/, kind: "lower-roman", romanOnly: true },
  // a.  /  a)
  { re: /^([a-z])[.)]\s+/, kind: "lower-alpha" },
  // (i) (ii) (iv) — before (a)/(b) so a roman sub-part is not read as a letter,
  // and validated, so "(c)" stays a letter because it cannot be a numeral.
  { re: /^[([]([ivxlcdmIVXLCDM]{1,7})[)\]]\s+/, kind: "paren-roman", romanOnly: true },
  // (a)  /  [a]
  { re: /^[([]([A-Za-z]{1,3})[)\]]\s+/, kind: "paren-alpha" },
  // • · ◦ ‣ ▪▫ ●○
  { re: /^([•·◦‣▪▫●○])\s+/, kind: "bullet" },
  // - * +
  { re: /^([-*+])\s+/, kind: "dash" },
];
export type ParsedListLine = {
  /** True when the line opens with an explicit label. */
  isListItem: boolean;
  /** The label exactly as written, e.g. "(b)" or "ii." — never renumbered. */
  marker: string;
  /** The line without its label. */
  text: string;
  /** Nesting depth, 0-based. */
  level: number;
  kind: ListLabelKind | null;
};

/**
 * Split one line into label + content. `indent` is the leading whitespace width
 * already measured by the caller; when it is absent the label style decides the
 * depth, which is what keeps `1. / a. / (i)` lists nested correctly even after
 * PDF text extraction has flattened their indentation.
 */
export function parseListLine(raw: string, maxLevel = 4): ParsedListLine {
  const line = raw.replace(/\t/g, "  ");
  const indent = /^[ ]*/.exec(line)?.[0].length ?? 0;
  const content = line.slice(indent).trim();
  const indentLevel = Math.min(maxLevel, Math.floor(indent / 2));

  for (const { re, kind, romanOnly } of PATTERNS) {
    const match = re.exec(content);
    if (!match) continue;
    const label = match[0].trim().replace(/\s+/g, "");
    const rest = content.slice(match[0].length).trim();
    if (!rest) continue;
    // A numeral-looking label that is not a legal roman number ("MC", "c") is a
    // letter, not a roman part, so this pattern must not claim the line.
    if (romanOnly && !isRoman(stripLabel(label))) continue;
    const styleLevel = KIND_LEVEL[kind];
    return {
      isListItem: true,
      marker: label,
      text: rest,
      level: Math.min(maxLevel, Math.max(indentLevel, styleLevel)),
      kind,
    };
  }

  return { isListItem: false, marker: "", text: content, level: indentLevel, kind: null };
}

function stripLabel(label: string): string {
  return label.replace(/[().[\]]/g, "");
}

/** A wrapped continuation of the list item above it (no label, indented). */
export function isListContinuation(raw: string, previousWasItem: boolean): boolean {
  if (!previousWasItem) return false;
  const line = raw.replace(/\t/g, "  ");
  const indent = /^[ ]*/.exec(line)?.[0].length ?? 0;
  const content = line.slice(indent).trim();
  if (!content) return false;
  if (/^[#>|\-*=]/.test(content)) return false;
  return parseListLine(raw).isListItem === false;
}

/**
 * Column widths proportional to content, in the same units the caller works in
 * (pt for jsPDF, twips for docx). Long prose columns get more room, and short
 * numeric columns keep enough width for their widest value.
 */
export function proportionalColumnWidths(
  rows: string[][],
  totalWidth: number,
  measure: (text: string) => number,
  options: { min?: number; maxShare?: number; padding?: number } = {},
): number[] {
  const padding = options.padding ?? 0;
  const min = options.min ?? 40;
  const maxShare = options.maxShare ?? 0.6;
  const columns = rows.reduce((widest, row) => Math.max(widest, row.length), 0);
  if (columns === 0) return [];

  const weights: number[] = [];
  for (let i = 0; i < columns; i += 1) {
    let widest = 0;
    let lines = 0;
    for (const row of rows) {
      const cell = row[i] ?? "";
      const width = measure(cell);
      if (width > widest) widest = width;
      lines += 1;
    }
    // A header row is usually the shortest text in a column, so let the body
    // pull a column wider: max(width, average width * 0.6) with a floor.
    weights.push(Math.max(widest, padding * 2 + min, (widest / Math.max(1, lines)) * 0.6 + min));
  }

  const sum = weights.reduce((a, b) => a + b, 0) || 1;
  const usable = totalWidth - padding * 2 * columns;
  const max = usable * maxShare;

  const widths = weights.map((weight) => Math.max(min, (weight / sum) * usable));
  // Redistribute the overflow from clamped columns so the table still spans the page.
  const over = widths.reduce((a, b) => a + b, 0) - usable;
  if (Math.abs(over) > 0.5) {
    const flexible = widths.map((w, i) => (w < max ? i : -1)).filter((i) => i >= 0);
    const flexTotal = flexible.reduce((a, i) => a + (widths[i] ?? 0), 0) || 1;
    for (const i of flexible) {
      widths[i] = Math.max(min, (widths[i] ?? 0) - over * ((widths[i] ?? 0) / flexTotal));
    }
  }

  const total = widths.reduce((a, b) => a + b, 0) + padding * 2 * columns;
  if (total > 0 && Math.abs(total - totalWidth) > 1) {
    const scale = totalWidth / total;
    for (let i = 0; i < widths.length; i += 1) widths[i] = (widths[i] ?? 0) * scale;
  }
  return widths;
}

/** A short, honest title for an export: first meaningful line, trimmed of labels. */
export function conciseTitle(text: string, maxLength = 72): string {
  const line =
    text
      .replace(/\r/g, "")
      .split("\n")
      .map((raw) =>
        raw
          .replace(/^#{1,6}\s*/, "")
          // Emphasis is markup, and a title line renders it literally in both
          // Word and the standard-font PDF, so it never belongs in a filename
          // or a heading.
          .replace(/\*\*|__|[*`_]/g, "")
          .replace(/^[\s:>.-]+|[\s:>.,-]+$/g, "")
          .trim(),
      )
      .find((raw) => raw.length > 3) ?? "";
  const cleaned = line
    // "Question 4." / "Q.4 (a)" / "Question 3 (a)" are numbering, not content:
    // drop it, but stop before a part label like "(a)" which changes the meaning.
    .replace(/^(?:question|q(?=\s*\d))\.?\s*\d{0,3}\s*[.):]?\s*[-–—:]?\s*/i, "")
    .replace(/\(?\d{1,3}\s*marks?\)?\s*$/i, "")
    .replace(/\s+/g, " ")
    .trim();
  if (cleaned.length <= maxLength) return cleaned || "Marking report";
  const cut = cleaned.slice(0, maxLength);
  const lastSpace = cut.lastIndexOf(" ");
  return `${(lastSpace > maxLength * 0.5 ? cut.slice(0, lastSpace) : cut).replace(/[,;:.\s]+$/, "")}…`;
}

/** Headings are for navigation, not for whole sentences. */
export function headingTooLong(text: string, maxLength = 90): boolean {
  return text.trim().length > maxLength;
}

/** Cap a heading so an exported page never starts with a three-line banner. */
export function shortenHeading(text: string, maxLength = 90): string {
  const clean = text.replace(/\s+/g, " ").trim();
  if (clean.length <= maxLength) return clean;
  const cut = clean.slice(0, maxLength);
  const lastSpace = cut.lastIndexOf(" ");
  return `${(lastSpace > maxLength * 0.6 ? cut.slice(0, lastSpace) : cut).replace(/[,;:.\s]+$/, "")}…`;
}
