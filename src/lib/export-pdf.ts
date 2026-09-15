import { jsPDF } from "jspdf";
import {
  conciseTitle,
  isListContinuation,
  parseListLine,
  proportionalColumnWidths,
  shortenHeading,
} from "@/lib/export-format";

export type AskExport = {
  notebook: string;
  /** Heading suffix, e.g. "Ask session" or "Exam paper". */
  title?: string;
  /** When false the user's prompt/brief is omitted and only the content is exported. */
  showPrompts?: boolean;
  turns: { question: string; answer: string }[];
};

/** A single history entry selected for export. */
export type HistoryExportEntry = {
  /** Short label, e.g. "XYZ Limited (Audit reporting)". */
  title: string;
  /** The full detailed question / scenario. */
  question: string;
  /** The answer / marking output. */
  answer: string;
  date?: string;
};

export type HistoryExport = {
  notebook: string;
  /** Heading suffix, e.g. "Ask history" or "Marking history". */
  title?: string;
  entries: HistoryExportEntry[];
};

/* -------------------------------------------------------------------------- */
/*  Page geometry and house style                                             */
/* -------------------------------------------------------------------------- */

const MARGIN = 56;
const PAGE_W = 595.28; // A4 portrait, pt
const PAGE_H = 841.89;
const WIDTH = PAGE_W - MARGIN * 2;

/** Every page of every export is set in Times New Roman (PDF base font "times"). */
const FONT = "times";
type FontStyle = "normal" | "bold" | "italic" | "bolditalic";
type Rgb = [number, number, number];

/** Slim letterhead band across the top of the first page — title left, notebook right. */
const BAND_H = 32;

const INK: Rgb = [26, 30, 38];
const ACCENT: Rgb = [31, 56, 100];
const MUTED: Rgb = [92, 108, 128];
const RULE: Rgb = [198, 205, 216];
const PANEL: Rgb = [244, 247, 251];
const TABLE_HEAD: Rgb = [236, 240, 246];
const TABLE_EDGE: Rgb = [203, 209, 219];
const WHITE: Rgb = [255, 255, 255];

const SIZE = {
  bandTitle: 13.5,
  bandNotebook: 11.5,
  /** Body / answer text. */
  body: 11.5,
  /** The question: normal weight and a shade smaller than the body text. */
  question: 11,
  heading: 12.5,
  subheading: 12,
  /** Small caps style label, e.g. "QUESTION". */
  label: 9.5,
  meta: 9.5,
  table: 10,
};

/** Line height as a multiple of the font size — Times needs a little more air. */
const LEADING = 1.45;
/** Baseline offset from the top of a line, as a multiple of the font size. */
const ASCENT = 0.74;
/** Space between two list items, so each point reads as its own line. */
const ITEM_GAP = 6;

/* -------------------------------------------------------------------------- */
/*  Text cleanup                                                              */
/* -------------------------------------------------------------------------- */

/** Emoji/pictographs are not in the PDF core fonts and render as mojibake. */
const EMOJI = /(\p{Extended_Pictographic}|[\u{FE0F}\u{20E3}]|[\u{1F3FB}-\u{1F3FF}])/gu;

/**
 * The base-14 Times faces are WinAnsi encoded: anything outside that repertoire
 * turns into garbage bytes. Map the common ones to a readable equivalent.
 */
const GLYPHS: Record<string, string> = {
  "\u00a0": " ", // no-break space
  "\u00ad": "", // soft hyphen
  "\u2007": " ",
  "\u200b": "",
  "\u200c": "",
  "\u200d": "",
  "\u200e": "",
  "\u200f": "",
  "\ufeff": "",
  "\u2212": "-", // minus
  "\u2010": "-",
  "\u2011": "-",
  "\u2012": "-",
  "\u2015": "—", // horizontal bar
  "\u2032": "'",
  "\u2033": '"',
  "\u2035": "'",
  "\u2192": "->",
  "\u2190": "<-",
  "\u2194": "<->",
  "\u21d2": "=>",
  "\u21d0": "<=",
  "\u2794": "->",
  "\u27a4": "->",
  "\u2191": "^",
  "\u2193": "v",
  "\u2713": "",
  "\u2714": "",
  "\u2715": "x",
  "\u2716": "x",
  "\u2717": "x",
  "\u2718": "x",
  "\u2611": "",
  "\u2610": "[  ]",
  "\u2612": "[x]",
  "\u2264": "<=",
  "\u2265": ">=",
  "\u2260": "!=",
  "\u2248": "~",
  "\u2261": "=",
  "\u221e": "infinity",
  "\u2211": "sum",
  "\u220f": "product",
  "\u221a": "sqrt",
  "\u222b": "integral",
  "\u2206": "delta",
  "\u2202": "d",
  "\u2229": "intersection",
  "\u222a": "union",
  "\u2208": "in",
  "\u2209": "not in",
  "\u2282": "subset",
  "\u2286": "subset",
  "\u00d7": "x",
  "\u00f7": "/",
  "\u2016": "||",
  "\u2044": "/",
  "\u2116": "No.",
  "\u2105": "c/o",
  "\u20b9": "Rs",
  "\u20bd": "RUB",
  "\u20ba": "TRY",
  "\u20a9": "KRW",
  "\u20aa": "ILS",
  "\u20ab": "VND",
  "\u20b4": "UAH",
  "\u25aa": "•",
  "\u25ab": "•",
  "\u25cf": "•",
  "\u25cb": "•",
  "\u25c6": "•",
  "\u25c7": "•",
  "\u25a0": "•",
  "\u25a1": "•",
  "\u25b6": "•",
  "\u25ba": "•",
  "\u2023": "•",
  "\u2043": "-",
  "\u02d9": ".",
  "\u2605": "*",
  "\u2606": "*",
  "\u2731": "*",
  "\u0394": "delta",
  "\u03b1": "alpha",
  "\u03b2": "beta",
  "\u03b3": "gamma",
  "\u03b4": "delta",
  "\u03b5": "epsilon",
  "\u03b8": "theta",
  "\u03bb": "lambda",
  "\u03bc": "mu",
  "\u03c0": "pi",
  "\u03c1": "rho",
  "\u03c3": "sigma",
  "\u03c6": "phi",
  "\u03c9": "omega",
};

/** Code points WinAnsi covers outside printable ASCII and Latin-1. */
const WIN_ANSI_EXTRA = new Set([
  0x152, 0x153, 0x160, 0x161, 0x178, 0x17d, 0x17e, 0x192, 0x2c6, 0x2dc, 0x2013, 0x2014, 0x2018,
  0x2019, 0x201a, 0x201c, 0x201d, 0x201e, 0x2020, 0x2021, 0x2022, 0x2026, 0x2030, 0x2039, 0x203a,
  0x20ac, 0x2122,
]);

/** Rewrites text so it survives the WinAnsi encoding of the Times base fonts. */
function encodable(text: string) {
  let out = "";
  for (const char of text) {
    const mapped = GLYPHS[char];
    if (mapped !== undefined) {
      out += mapped;
      continue;
    }
    const code = char.codePointAt(0) ?? 0;
    if (code === 0x0a || code === 0x09) {
      out += char;
    } else if ((code >= 0x20 && code <= 0x7e) || (code >= 0xa1 && code <= 0xff)) {
      out += char;
    } else if (WIN_ANSI_EXTRA.has(code)) {
      out += char;
    }
    // Anything else (CJK, Arabic, Greek not mapped above, dingbats) is dropped.
  }
  return out;
}

/** Strips markdown emphasis, emoji and un-encodable glyphs so the PDF reads cleanly. */
function plain(text: string) {
  return encodable(
    text
      .replace(/`{1,3}/g, "")
      .replace(/\*\*(.+?)\*\*/g, "$1")
      .replace(/(^|\s)\*(?!\s)(.+?)\*/g, "$1$2")
      .replace(EMOJI, ""),
  )
    .replace(/[ \t]{2,}/g, " ")
    .trim();
}

/** Builds a file name from the question text, e.g. "abc-limited-internal-controls". */
export function fileNameFromQuestion(question: string, fallback: string) {
  const first =
    plain(question)
      .replace(/^#{1,6}\s*/gm, "")
      .split("\n")
      .map((l) => l.trim())
      .find((l) => l.length > 2) ?? "";
  const cleaned = first
    .replace(/[^\w\s&-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 70)
    .trim()
    .replace(/\s/g, "-")
    .toLowerCase();
  return cleaned || fallback;
}

function splitRow(line: string): string[] {
  return line
    .trim()
    .replace(/^\|/, "")
    .replace(/\|$/, "")
    .split("|")
    .map((c) => plain(c.trim()));
}

const isDivider = (cells: string[]) => cells.every((c) => /^:?-{2,}:?$/.test(c));

/* -------------------------------------------------------------------------- */
/*  Renderer                                                                  */
/* -------------------------------------------------------------------------- */

type TextOpts = {
  size?: number;
  style?: FontStyle;
  color?: Rgb;
  /** Extra space added after the block. */
  gap?: number;
  /** Left indent applied to every wrapped line. */
  indent?: number;
  /** Letter spacing, used for the small-caps style labels. */
  charSpace?: number;
};

type Page = { w: number; h: number; margin: number };

/**
 * Small layout helper around a jsPDF document: everything is Times New Roman,
 * `y` is always the baseline of the next line of text.
 */
function createRenderer(doc: jsPDF, page: Page = { w: PAGE_W, h: PAGE_H, margin: MARGIN }) {
  const { w: pageW, h: pageH, margin } = page;
  const width = pageW - margin * 2;
  let y = margin;

  const ensure = (needed: number) => {
    if (y + needed > pageH - margin) {
      doc.addPage();
      y = margin;
    }
  };

  const ink = (color: Rgb) => doc.setTextColor(color[0], color[1], color[2]);

  const face = (style: FontStyle, size: number) => {
    doc.setFont(FONT, style);
    doc.setFontSize(size);
  };

  /** A paragraph (or several, split on "\n") of body text. */
  const write = (text: string, opts: TextOpts = {}) => {
    const size = opts.size ?? SIZE.body;
    const indent = opts.indent ?? 0;
    const style = opts.style ?? "normal";
    const lh = size * LEADING;
    face(style, size);
    ink(opts.color ?? INK);
    const spacing = opts.charSpace ?? 0;
    for (const paragraph of String(text).split("\n")) {
      const lines = (doc.splitTextToSize(paragraph, width - indent) as string[]) ?? [];
      for (const line of lines.length ? lines : [""]) {
        ensure(lh);
        if (spacing) doc.text(line, margin + indent, y, { charSpace: spacing });
        else doc.text(line, margin + indent, y);
        y += lh;
      }
    }
    y += opts.gap ?? 6;
  };

  /**
   * A hanging-indented line: the marker sits at `indent`, the text starts after
   * it and every wrapped line lines up under the first word.
   */
  const item = (marker: string, text: string, opts: TextOpts = {}) => {
    const size = opts.size ?? SIZE.body;
    const indent = opts.indent ?? 12;
    const style = opts.style ?? "normal";
    const lh = size * LEADING;
    face(style, size);
    const markerX = margin + indent;
    const textX = markerX + doc.getTextWidth(marker) + 6;
    const avail = Math.max(width - (textX - margin), 80);
    const lines = (doc.splitTextToSize(text, avail) as string[]) ?? [];
    // Keep the marker together with at least its first two lines.
    ensure(lh * 2 + (opts.gap ?? ITEM_GAP));
    ink(opts.color ?? INK);
    doc.text(marker, markerX, y);
    for (const line of lines.length ? lines : [""]) {
      ensure(lh);
      doc.text(line, textX, y);
      y += lh;
    }
    y += opts.gap ?? ITEM_GAP;
  };

  /** Compact letterhead: the export title on the left, the notebook on the right. */
  const band = (title: string, notebook: string) => {
    doc.setFillColor(ACCENT[0], ACCENT[1], ACCENT[2]);
    doc.rect(0, 0, pageW, BAND_H, "F");
    const baseline = BAND_H / 2 + 4.4;
    ink(WHITE);
    face("bold", SIZE.bandTitle);
    doc.text(title, margin, baseline);
    face("normal", SIZE.bandNotebook);
    doc.text(notebook, pageW - margin, baseline, { align: "right" });
    y = BAND_H + 30;
  };

  /** Thin separator between two exported entries. */
  const rule = (before = 10, after = 18) => {
    y += before;
    ensure(14);
    doc.setDrawColor(RULE[0], RULE[1], RULE[2]);
    doc.setLineWidth(0.6);
    doc.line(margin, y, pageW - margin, y);
    y += after;
  };

  /**
   * Markdown table as a bordered grid.
   *
   * Two things the old version got wrong and this one fixes: columns are sized
   * from their CONTENT (a "Marks" column no longer eats a third of the page and
   * a "Justification" column is no longer squeezed until its text is clipped),
   * and a row that cannot fit on the remaining page is split across the page
   * break with its header repeated — text is never cut off.
   */
  const table = (rows: string[][]) => {
    if (rows.length === 0) return;
    const size = SIZE.table;
    const lh = size * 1.34;
    const padX = 6;
    const padY = 4;
    face("normal", size);

    const cells = rows.map((row) =>
      Array.from({ length: rows[0]?.length ?? 0 }, (_, i) => row[i] ?? ""),
    );
    const widths = proportionalColumnWidths(
      cells,
      width,
      (text) => doc.getTextWidth(text.replace(/\s+/g, " ").trim()),
      { min: 46, maxShare: 0.55, padding: padX },
    );
    const offsets: number[] = [];
    let cursor = 0;
    for (const w of widths) {
      offsets.push(cursor);
      cursor += w;
    }
    const totalTableWidth = Math.max(cursor, width);

    const linesFor = (row: string[]) =>
      row.map((cell, i) => {
        const available = Math.max(24, (widths[i] ?? 60) - padX * 2);
        const lines = (doc.splitTextToSize(cell, available) as string[]) ?? [];
        return lines.length ? lines : [""];
      });

    const paintRow = (
      row: string[],
      style: FontStyle,
      shade: Rgb | null,
      fromLine = 0,
      lineCount?: number,
    ) => {
      face(style, size);
      const wrapped = linesFor(row);
      const maxLines = Math.max(...wrapped.map((lines) => lines.length));
      const startLine = fromLine;
      const endLine = Math.min(maxLines, startLine + (lineCount ?? maxLines - startLine));
      const height = Math.max(1, endLine - startLine) * lh + padY * 2;
      const top = y - size * ASCENT - padY;

      if (shade) {
        doc.setFillColor(shade[0], shade[1], shade[2]);
        doc.rect(margin, top, totalTableWidth, height, "F");
      }
      doc.setDrawColor(TABLE_EDGE[0], TABLE_EDGE[1], TABLE_EDGE[2]);
      doc.setLineWidth(0.5);
      for (let i = 0; i < row.length; i += 1) {
        doc.rect(margin + (offsets[i] ?? 0), top, widths[i] ?? 0, height);
      }
      ink(INK);
      wrapped.forEach((lines, i) => {
        lines.slice(startLine, endLine).forEach((line, li) => {
          doc.text(line, margin + (offsets[i] ?? 0) + padX, top + padY + size * ASCENT + li * lh);
        });
      });
      y = top + height + size * ASCENT * 0.4;
      return { maxLines, drawn: endLine - startLine };
    };

    const header = cells[0] ?? [];
    const hasHeader = cells.length > 1;

    const spaceLeft = () => pageH - margin - y;
    const linesThatFit = (heightPerLine: number) =>
      Math.max(0, Math.floor((spaceLeft() - padY * 2 - 2) / heightPerLine));

    const startNewPage = () => {
      doc.addPage();
      y = margin + size * ASCENT;
      // A table that continues keeps its header visible on the new page.
      if (hasHeader) {
        paintRow(header, "bold", TABLE_HEAD);
        y += 2;
      }
    };

    cells.forEach((row, rowIndex) => {
      const isHeader = hasHeader && rowIndex === 0;
      const style: FontStyle = isHeader ? "bold" : "normal";
      const wrapped = linesFor(row);
      const maxLines = Math.max(...wrapped.map((lines) => lines.length));
      const fullHeight = maxLines * lh + padY * 2;

      // Whole row fits on a fresh page but not here: move it down first.
      const roomForWholeRow = pageH - margin - margin;
      if (spaceLeft() < fullHeight && fullHeight <= roomForWholeRow) {
        startNewPage();
      }

      let from = 0;
      while (from < maxLines) {
        const available = linesThatFit(lh);
        if (available <= 0) {
          startNewPage();
          continue;
        }
        const take = Math.min(available, maxLines - from);
        const { drawn } = paintRow(row, style, isHeader ? TABLE_HEAD : null, from, take);
        from += Math.max(1, drawn);
        if (from < maxLines) startNewPage();
      }
      y += 2;
    });
    y += 8;
  };

  return {
    doc,
    margin,
    pageW,
    width,
    ensure,
    write,
    item,
    band,
    rule,
    table,
    get y() {
      return y;
    },
    set y(value: number) {
      y = value;
    },
  };
}

/**
 * Page numbers on every page: "Page 2 of 7" in the footer, plus a thin rule.
 * Runs after the content is laid out, because the total is only known then.
 */
function addPageNumbers(doc: jsPDF, options: { label?: string; margin?: number } = {}) {
  const margin = options.margin ?? MARGIN;
  const pages = doc.getNumberOfPages();
  const label = options.label ?? "";
  for (let page = 1; page <= pages; page += 1) {
    doc.setPage(page);
    const baseline = PAGE_FOOTER_BASELINE(doc);
    doc.setDrawColor(RULE[0], RULE[1], RULE[2]);
    doc.setLineWidth(0.4);
    doc.line(
      margin,
      baseline - SIZE.meta - 3,
      doc.internal.pageSize.getWidth() - margin,
      baseline - SIZE.meta - 3,
    );
    doc.setFont(FONT, "normal");
    doc.setFontSize(SIZE.meta);
    doc.setTextColor(MUTED[0], MUTED[1], MUTED[2]);
    const text = `${label}${label ? "  ·  " : ""}Page ${page} of ${pages}`;
    doc.text(text, doc.internal.pageSize.getWidth() - margin, baseline, { align: "right" });
  }
}

/** Footer baseline that respects the page's bottom margin on either orientation. */
function PAGE_FOOTER_BASELINE(doc: jsPDF): number {
  return doc.internal.pageSize.getHeight() - MARGIN / 2;
}

type Renderer = ReturnType<typeof createRenderer>;

/* -------------------------------------------------------------------------- */
/*  Shared content rendering                                                  */
/* -------------------------------------------------------------------------- */

const QUOTE = /^>+\s?(.*)$/;
const HR = /^(-{3,}|\*{3,}|_{3,})$/;

/**
 * The marker a bullet with no printed label gets. Everything that DOES carry a
 * label — 1. 2. 3. / A. B. C. / a. b. c. / i. ii. iii. / (a) (i) — is written out
 * exactly as the source had it, because those labels are how a candidate matches
 * an answer to the requirement it belongs to.
 */
const BULLET_MARK = "•";

/** Small caps style section label, e.g. QUESTION / ANSWER. */
function label(r: Renderer, text: string, gap = 4) {
  r.write(encodable(text.toUpperCase()), {
    size: SIZE.label,
    style: "bold",
    color: ACCENT,
    charSpace: 0.9,
    gap,
  });
}

/**
 * Renders an answer/marking body: headings, paragraphs, tables and lists.
 *
 * Labels are preserved verbatim and nesting is expressed by indentation with a
 * hanging indent, so a wrapped point lines up under its own text and the label
 * stays on the line that owns it.
 */
function renderMarkdown(body: string, r: Renderer) {
  const lines = body.replace(/\r/g, "").split("\n");
  /** Running text of a wrapped list item, flushed when the item ends. */
  let openLevel = -1;

  let i = 0;
  while (i < lines.length) {
    const raw = lines[i] ?? "";
    const line = raw.trim();

    if (!line) {
      i += 1;
      continue;
    }

    if (line.startsWith("|")) {
      openLevel = -1;
      const rows: string[][] = [];
      while (i < lines.length && (lines[i] ?? "").trim().startsWith("|")) {
        const cells = splitRow(lines[i] ?? "");
        if (!isDivider(cells)) rows.push(cells);
        i += 1;
      }
      r.table(rows);
      continue;
    }

    if (HR.test(line)) {
      openLevel = -1;
      r.rule(4, 12);
      i += 1;
      continue;
    }

    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    if (heading) {
      openLevel = -1;
      const depth = heading[1]?.length ?? 1;
      const text = plain(heading[2] ?? "");
      // A long heading is a sentence, not a heading: it is demoted to bold body
      // text so an export never opens with a wrapped three-line banner.
      const size = depth <= 2 ? SIZE.heading : SIZE.subheading;
      r.y += 6;
      r.ensure(size * LEADING + 24);
      r.write(shortenHeading(text), { size, style: "bold", color: ACCENT, gap: 5 });
      i += 1;
      continue;
    }

    const quote = QUOTE.exec(line);
    if (quote) {
      openLevel = -1;
      r.y += 2;
      r.write(plain(quote[1] ?? ""), {
        size: SIZE.body,
        style: "italic",
        color: MUTED,
        indent: 16,
        gap: 7,
      });
      i += 1;
      continue;
    }

    const parsed = parseListLine(raw);
    if (parsed.isListItem) {
      // Descending into a nested list re-starts that level; climbing out does not
      // renumber anything, because the label comes from the text itself.
      openLevel = parsed.level;
      const marker =
        parsed.kind === "dash" || parsed.kind === "bullet" ? BULLET_MARK : parsed.marker;
      let text = plain(parsed.text);
      i += 1;
      // Fold wrapped continuation lines into the item so the hanging indent
      // carries them, instead of emitting an unlabelled orphan paragraph.
      while (i < lines.length && isListContinuation(lines[i] ?? "", true)) {
        const next = (lines[i] ?? "").trim();
        if (!next || next.startsWith("|")) break;
        text += ` ${plain(next)}`;
        i += 1;
      }
      r.item(marker, text, {
        size: SIZE.body,
        indent: 12 + parsed.level * 16,
        gap: ITEM_GAP,
      });
      continue;
    }

    openLevel = -1;
    r.write(plain(line), { size: SIZE.body, gap: 7 });
    i += 1;
  }

  if (openLevel !== -1) r.y += 3;
}

/** The question block used by the Ask export: normal weight, in a light panel. */
function questionPanel(r: Renderer, text: string) {
  const doc = r.doc;
  const bar = 2.5;
  const padX = 10;
  const padY = 8;
  const size = SIZE.question;
  const lh = size * LEADING;

  doc.setFont(FONT, "normal");
  doc.setFontSize(size);
  const avail = r.width - bar - padX * 2;
  const paragraphs = text
    .split("\n")
    .map((p) => p.trim())
    .filter(Boolean);
  const blocks = (paragraphs.length ? paragraphs : [""]).map(
    (p) => (doc.splitTextToSize(p, avail) as string[]) ?? [],
  );
  const inner =
    blocks.reduce((total, block) => total + block.length, 0) * lh + (blocks.length - 1) * 4;
  const boxH = inner + padY * 2;

  r.ensure(boxH + 10);
  const top = r.y - size * ASCENT - padY;
  doc.setFillColor(PANEL[0], PANEL[1], PANEL[2]);
  doc.rect(r.margin, top, r.width, boxH, "F");
  doc.setFillColor(ACCENT[0], ACCENT[1], ACCENT[2]);
  doc.rect(r.margin, top, bar, boxH, "F");
  doc.setTextColor(ACCENT[0], ACCENT[1], ACCENT[2]);

  let baseline = top + padY + size * ASCENT;
  blocks.forEach((block, index) => {
    block.forEach((line) => {
      doc.text(line, r.margin + bar + padX, baseline);
      baseline += lh;
    });
    if (index < blocks.length - 1) baseline += 4;
  });

  r.y = top + boxH + 16;
}

/* -------------------------------------------------------------------------- */
/*  Exports                                                                   */
/* -------------------------------------------------------------------------- */

export function exportAskToPdf(data: AskExport) {
  const doc = new jsPDF({ unit: "pt", format: "a4" });
  const r = createRenderer(doc);

  r.band(data.title ?? "Ask session", data.notebook);

  const showPrompts = data.showPrompts !== false;

  data.turns.forEach((turn, index) => {
    if (showPrompts) {
      questionPanel(r, plain(`Q${index + 1}. ${turn.question}`));
    } else if (index > 0) {
      r.y += 6;
    }

    renderMarkdown(turn.answer, r);
    if (index < data.turns.length - 1) r.rule();
  });

  addPageNumbers(doc, { label: data.notebook });

  const fallback =
    data.notebook
      .replace(/[^\w-]+/g, "-")
      .replace(/^-|-$/g, "")
      .toLowerCase() || "notebook";
  const name = fileNameFromQuestion(data.turns[0]?.question ?? "", fallback);
  doc.save(`${name}.pdf`);
}

/**
 * Performance overview export: landscape A4.
 *
 * The topic table is the headline, but the evidence rows and the "what to do
 * next" lines are the part a candidate acts on — so the whole report is exported,
 * not just the grid. Nothing here is invented: every figure comes from the
 * classification rows the caller was shown.
 */
export function exportInsightsToPdf(markdown: string, fallbackName = "performance-overview") {
  const doc = new jsPDF({ unit: "pt", format: "a4", orientation: "landscape" });
  const r = createRenderer(doc, { w: PAGE_H, h: PAGE_W, margin: MARGIN });

  r.ensure(40);
  r.write("Performance Overview", {
    size: 16,
    style: "bold",
    color: ACCENT,
    gap: 8,
  });
  r.write("Scores are awarded marks ÷ available marks over the marked attempts in this notebook.", {
    size: SIZE.meta,
    style: "italic",
    color: MUTED,
    gap: 14,
  });

  renderMarkdown(markdown, r);
  addPageNumbers(doc, { label: "Performance Overview" });
  doc.save(`${fallbackName}.pdf`);
}

/**
 * History export: one section per selected entry — the title, the full detailed
 * question, then the complete answer/marking output.
 */
export function exportHistoryToPdf(data: HistoryExport) {
  const doc = new jsPDF({ unit: "pt", format: "a4" });
  const r = createRenderer(doc);

  r.band(data.title ?? "History", data.notebook);

  data.entries.forEach((entry, index) => {
    r.ensure(56);
    // Titles stay short: the full question follows as body text underneath.
    r.write(`${index + 1}. ${plain(conciseTitle(entry.title))}`, {
      size: SIZE.heading,
      style: "bold",
      color: ACCENT,
      gap: 3,
    });
    if (entry.date) {
      r.write(entry.date, { size: SIZE.meta, style: "italic", color: MUTED, gap: 10 });
    }

    label(r, "Question", 5);
    for (const raw of plain(entry.question).split("\n")) {
      const line = raw.trim();
      if (line) r.write(line, { size: SIZE.question, style: "normal", gap: 4 });
    }

    r.y += 5;
    label(r, "Answer", 5);
    renderMarkdown(entry.answer, r);

    if (index < data.entries.length - 1) r.rule(8, 20);
  });

  addPageNumbers(doc, { label: data.notebook });

  const fallback =
    data.notebook
      .replace(/[^\w-]+/g, "-")
      .replace(/^-|-$/g, "")
      .toLowerCase() || "history";
  const name = fileNameFromQuestion(data.entries[0]?.title ?? "", `${fallback}-history`);
  doc.save(`${name}.pdf`);
}
