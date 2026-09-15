import {
  AlignmentType,
  Footer,
  PageNumber,
  BorderStyle,
  Document,
  HeadingLevel,
  LevelFormat,
  PageOrientation,
  Packer,
  Paragraph,
  ShadingType,
  Table,
  TableCell,
  TableRow,
  TextRun,
  WidthType,
} from "docx";
import { fileNameFromQuestion, type HistoryExport } from "@/lib/export-pdf";
import {
  conciseTitle,
  isListContinuation,
  parseListLine,
  proportionalColumnWidths,
  shortenHeading,
} from "@/lib/export-format";

/** Word exports are set in Calibri (the requirement), everywhere, including headings. */
const WORD_FONT = "Calibri";
/** Approximate Calibri advance width per character, in twips at 11pt — 1/20 pt units. */
const CHAR_TWIPS = 105;

const CONTENT_WIDTH = 9360;

/** Inline markdown (**bold**, *italic*, `code`) → docx runs. */
function runs(text: string, base: { bold?: boolean } = {}): TextRun[] {
  const out: TextRun[] = [];
  const pattern = /(\*\*[^*]+\*\*|\*[^*]+\*|`[^`]+`)/g;
  let last = 0;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(text))) {
    if (match.index > last) {
      out.push(new TextRun({ text: text.slice(last, match.index), ...base }));
    }
    const token = match[0];
    if (token.startsWith("**")) {
      out.push(new TextRun({ text: token.slice(2, -2), bold: true }));
    } else if (token.startsWith("`")) {
      out.push(new TextRun({ text: token.slice(1, -1), font: "Consolas", ...base }));
    } else {
      out.push(new TextRun({ text: token.slice(1, -1), italics: true, ...base }));
    }
    last = match.index + token.length;
  }
  if (last < text.length) out.push(new TextRun({ text: text.slice(last), ...base }));
  return out.length ? out : [new TextRun({ text: "", ...base })];
}

const cellBorder = { style: BorderStyle.SINGLE, size: 1, color: "CCCCCC" };
const borders = { top: cellBorder, bottom: cellBorder, left: cellBorder, right: cellBorder };

function splitRow(line: string): string[] {
  return line
    .trim()
    .replace(/^\|/, "")
    .replace(/\|$/, "")
    .split("|")
    .map((c) => c.trim());
}

/**
 * Markdown table → docx table.
 *
 * Widths follow the content instead of splitting the page evenly, the header row
 * repeats when a table runs onto another page, and rows are allowed to break, so
 * nothing is clipped at a page boundary.
 */
export function buildTable(lines: string[], totalWidth = CONTENT_WIDTH): Table {
  const rows = lines.map(splitRow).filter((cells) => !cells.every((c) => /^:?-{2,}:?$/.test(c)));
  const columns = Math.max(1, ...rows.map((r) => r.length));
  const widths = proportionalColumnWidths(
    rows,
    totalWidth,
    (text) => Math.min(totalWidth / 2, text.replace(/\s+/g, " ").trim().length * CHAR_TWIPS),
    { min: 900, maxShare: 0.55, padding: 240 },
  );
  const used = widths.reduce((a, b) => a + b, 0) || totalWidth;
  const lastGap = Math.max(0, totalWidth - used);
  if (widths.length) widths[widths.length - 1] = (widths.at(-1) ?? 0) + lastGap;

  return new Table({
    width: { size: totalWidth, type: WidthType.DXA },
    columnWidths: widths,
    rows: rows.map(
      (cells, rowIndex) =>
        new TableRow({
          // Header stays on top when the table continues onto the next page.
          ...(rowIndex === 0 ? { tableHeader: true } : {}),
          cantSplit: false,
          children: widths.map(
            (w, i) =>
              new TableCell({
                borders,
                width: { size: w, type: WidthType.DXA },
                margins: { top: 80, bottom: 80, left: 120, right: 120 },
                ...(rowIndex === 0
                  ? { shading: { fill: "EDF1F7", type: ShadingType.CLEAR, color: "auto" } }
                  : {}),
                children: [
                  new Paragraph({ children: runs(cells[i] ?? "", { bold: rowIndex === 0 }) }),
                ],
              }),
          ),
        }),
    ),
  });
}

/**
 * Markdown-lite → docx block elements.
 *
 * List labels are written into the paragraph as text and never renumbered by
 * Word's own list numbering: "(b)" and "ii." must keep matching the requirement
 * they were answering. Each level indents and hangs, so a wrapped point lines up
 * under its own first word.
 */
function markdownToBlocks(markdown: string, totalWidth = CONTENT_WIDTH): (Paragraph | Table)[] {
  const lines = markdown.replace(/\r/g, "").split("\n");
  const blocks: (Paragraph | Table)[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i] ?? "";
    const trimmed = line.trim();

    if (!trimmed) {
      i += 1;
      continue;
    }

    if (trimmed.startsWith("|")) {
      const table: string[] = [];
      while (i < lines.length && (lines[i] ?? "").trim().startsWith("|")) {
        table.push(lines[i] ?? "");
        i += 1;
      }
      blocks.push(buildTable(table, totalWidth));
      blocks.push(new Paragraph({ children: [new TextRun("")] }));
      continue;
    }

    const heading = /^(#{1,4})\s+(.*)$/.exec(trimmed);
    if (heading) {
      const level = heading[1]!.length;
      const text = shortenHeading(heading[2] ?? "");
      blocks.push(
        new Paragraph({
          heading:
            level <= 1
              ? HeadingLevel.HEADING_1
              : level === 2
                ? HeadingLevel.HEADING_2
                : HeadingLevel.HEADING_3,
          children: runs(text),
        }),
      );
      i += 1;
      continue;
    }

    const parsed = parseListLine(line);
    if (parsed.isListItem) {
      let text = parsed.text;
      i += 1;
      while (i < lines.length && isListContinuation(lines[i] ?? "", true)) {
        const next = (lines[i] ?? "").trim();
        if (!next || next.startsWith("|")) break;
        text += ` ${next}`;
        i += 1;
      }
      const plainBullet = parsed.kind === "dash" || parsed.kind === "bullet";
      const marker = plainBullet ? "•" : parsed.marker;
      const indentLeft = 360 + parsed.level * 360;
      blocks.push(
        new Paragraph({
          alignment: AlignmentType.LEFT,
          indent: { left: indentLeft + 320, hanging: 320 },
          spacing: { after: 60 },
          children: [new TextRun({ text: `${marker}\t`, bold: false }), ...runs(text)],
        }),
      );
      continue;
    }

    if (/^([-*_])\1{2,}$/.test(trimmed)) {
      blocks.push(
        new Paragraph({
          border: { bottom: { style: BorderStyle.SINGLE, size: 6, color: "2E75B6", space: 1 } },
          children: [new TextRun("")],
        }),
      );
      i += 1;
      continue;
    }

    blocks.push(new Paragraph({ children: runs(trimmed), spacing: { after: 120 } }));
    i += 1;
  }

  return blocks;
}

function sectionHeading(text: string): Paragraph {
  return new Paragraph({
    heading: HeadingLevel.HEADING_2,
    children: [new TextRun({ text })],
  });
}

function labelledBlock(markdown: string, totalWidth = CONTENT_WIDTH): (Paragraph | Table)[] {
  const blocks = markdownToBlocks(markdown, totalWidth);
  return blocks.length ? blocks : [new Paragraph({ children: [new TextRun("—")] })];
}

export type MarkExport = {
  notebook: string;
  question: string;
  userAnswer?: string | undefined;
  requested: string[];
  rigour?: string | undefined;
  response: string;
};

/** Two-column key/value table used for the cover summary. */
function infoTable(rows: [string, string][]): Table {
  const left = 2600;
  const right = CONTENT_WIDTH - left;
  return new Table({
    width: { size: CONTENT_WIDTH, type: WidthType.DXA },
    columnWidths: [left, right],
    rows: rows.map(
      ([label, value]) =>
        new TableRow({
          children: [
            new TableCell({
              borders,
              width: { size: left, type: WidthType.DXA },
              margins: { top: 80, bottom: 80, left: 120, right: 120 },
              shading: { fill: "EDF1F7", type: ShadingType.CLEAR, color: "auto" },
              children: [new Paragraph({ children: [new TextRun({ text: label, bold: true })] })],
            }),
            new TableCell({
              borders,
              width: { size: right, type: WidthType.DXA },
              margins: { top: 80, bottom: 80, left: 120, right: 120 },
              children: [new Paragraph({ children: runs(value) })],
            }),
          ],
        }),
    ),
  });
}

/** Calibri style block for every Word export, headings included. */
function calibriStyles(baseSize = 22) {
  return {
    default: {
      document: { run: { font: WORD_FONT, size: baseSize } },
    },
    paragraphStyles: [
      {
        id: "Heading1",
        name: "Heading 1",
        basedOn: "Normal",
        next: "Normal",
        quickFormat: true,
        run: { size: 32, bold: true, font: WORD_FONT },
        paragraph: { spacing: { before: 240, after: 200 }, outlineLevel: 0 },
      },
      {
        id: "Heading2",
        name: "Heading 2",
        basedOn: "Normal",
        next: "Normal",
        quickFormat: true,
        run: { size: 26, bold: true, font: WORD_FONT, color: "1F3864" },
        paragraph: { spacing: { before: 280, after: 140 }, outlineLevel: 1 },
      },
      {
        id: "Heading3",
        name: "Heading 3",
        basedOn: "Normal",
        next: "Normal",
        quickFormat: true,
        run: { size: 23, bold: true, font: WORD_FONT },
        paragraph: { spacing: { before: 200, after: 100 }, outlineLevel: 2 },
      },
    ],
  };
}

/** Footer carrying "Page N of M", so a printed export can be reassembled. */
function pageFooter() {
  return new Footer({
    children: [
      new Paragraph({
        alignment: AlignmentType.CENTER,
        children: [
          new TextRun({ text: "Page ", size: 18, font: WORD_FONT, color: "5C6C80" }),
          new TextRun({
            children: [PageNumber.CURRENT],
            size: 18,
            font: WORD_FONT,
            color: "5C6C80",
          }),
          new TextRun({ text: " of ", size: 18, font: WORD_FONT, color: "5C6C80" }),
          new TextRun({
            children: [PageNumber.TOTAL_PAGES],
            size: 18,
            font: WORD_FONT,
            color: "5C6C80",
          }),
        ],
      }),
    ],
  });
}

export async function exportMarkingToWord(data: MarkExport) {
  const dated = new Date().toLocaleString(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  });

  const children: (Paragraph | Table)[] = [
    // Navy title band, full content width.
    new Table({
      width: { size: CONTENT_WIDTH, type: WidthType.DXA },
      columnWidths: [CONTENT_WIDTH],
      rows: [
        new TableRow({
          children: [
            new TableCell({
              borders: {
                top: { style: BorderStyle.NONE, size: 0, color: "1F3864" },
                bottom: { style: BorderStyle.NONE, size: 0, color: "1F3864" },
                left: { style: BorderStyle.NONE, size: 0, color: "1F3864" },
                right: { style: BorderStyle.NONE, size: 0, color: "1F3864" },
              },
              width: { size: CONTENT_WIDTH, type: WidthType.DXA },
              margins: { top: 220, bottom: 220, left: 220, right: 220 },
              shading: { fill: "1F3864", type: ShadingType.CLEAR, color: "auto" },
              children: [
                new Paragraph({
                  children: [
                    new TextRun({
                      text: "Answer & marking",
                      bold: true,
                      size: 34,
                      color: "FFFFFF",
                    }),
                  ],
                }),
                new Paragraph({
                  children: [
                    new TextRun({
                      text: `${data.notebook}  ·  ICAP professional-level examiner report`,
                      italics: true,
                      size: 20,
                      color: "D6DEEE",
                    }),
                  ],
                }),
              ],
            }),
          ],
        }),
      ],
    }),
    new Paragraph({ spacing: { after: 160 }, children: [new TextRun("")] }),
    infoTable([
      ["Notebook", data.notebook],
      ["Generated", dated],
      ["Marking standard", data.rigour ?? "Strict"],
      ["Sections included", data.requested.length ? data.requested.join(", ") : "All"],
    ]),
    new Paragraph({ children: [new TextRun("")] }),
    sectionHeading("Question / scenario"),
    ...labelledBlock(data.question),
  ];

  if (data.userAnswer?.trim()) {
    children.push(sectionHeading("Your answer"), ...labelledBlock(data.userAnswer));
  }

  children.push(sectionHeading("Marking output"), ...labelledBlock(data.response));

  const doc = new Document({
    styles: calibriStyles(22),
    numbering: {
      config: [
        {
          reference: "bullets",
          levels: [
            {
              level: 0,
              format: LevelFormat.BULLET,
              text: "•",
              alignment: AlignmentType.LEFT,
              style: { paragraph: { indent: { left: 720, hanging: 360 } } },
            },
          ],
        },
        {
          reference: "numbers",
          levels: [
            {
              level: 0,
              format: LevelFormat.DECIMAL,
              text: "%1.",
              alignment: AlignmentType.LEFT,
              style: { paragraph: { indent: { left: 720, hanging: 360 } } },
            },
          ],
        },
      ],
    },
    sections: [
      {
        properties: {
          page: {
            size: { width: 12240, height: 15840 },
            margin: { top: 1440, right: 1440, bottom: 1440, left: 1440 },
          },
        },
        footers: { default: pageFooter() },
        children,
      },
    ],
  });

  const blob = await Packer.toBlob(doc);
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `${fileNameFromQuestion(
    data.question,
    data.notebook
      .replace(/[^\w\s-]/g, "")
      .trim()
      .replace(/\s+/g, "-")
      .toLowerCase() || "marking",
  )}.docx`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

/**
 * Performance overview export: landscape page carrying the whole report —
 * the topic table, the evidence behind it and the next steps.
 */
export async function exportInsightsToWord(markdown: string, fileName = "performance-overview") {
  const LANDSCAPE_WIDTH = 15840 - 1440 * 2;

  // The whole report goes out, not only the grid: the evidence lines and the
  // "what to do next" section are what a candidate acts on, so dropping them
  // made the export a scoreboard with no diagnosis.
  const children: (Paragraph | Table)[] = [
    new Paragraph({
      heading: HeadingLevel.HEADING_1,
      spacing: { after: 120 },
      children: [new TextRun({ text: "Performance Overview", bold: true, color: "1F3864" })],
    }),
    new Paragraph({
      spacing: { after: 220 },
      children: [
        new TextRun({
          text: "Scores are awarded marks ÷ available marks over the marked attempts in this notebook. Rows marked “Needs review” are excluded from every percentage.",
          italics: true,
          size: 18,
          color: "5C6C80",
        }),
      ],
    }),
    ...markdownToBlocks(markdown, LANDSCAPE_WIDTH),
  ];

  const doc = new Document({
    styles: calibriStyles(20),
    sections: [
      {
        properties: {
          page: {
            size: { width: 12240, height: 15840, orientation: PageOrientation.LANDSCAPE },
            margin: { top: 1440, right: 1440, bottom: 1440, left: 1440 },
          },
        },
        footers: { default: pageFooter() },
        children,
      },
    ],
  });

  const blob = await Packer.toBlob(doc);
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `${fileName}.docx`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

/**
 * History export: one section per selected entry — the title, the full detailed
 * question, then the complete answer/marking output.
 */
export async function exportHistoryToWord(data: HistoryExport) {
  const dated = new Date().toLocaleString(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  });

  const children: (Paragraph | Table)[] = [
    new Table({
      width: { size: CONTENT_WIDTH, type: WidthType.DXA },
      columnWidths: [CONTENT_WIDTH],
      rows: [
        new TableRow({
          children: [
            new TableCell({
              borders: {
                top: { style: BorderStyle.NONE, size: 0, color: "1F3864" },
                bottom: { style: BorderStyle.NONE, size: 0, color: "1F3864" },
                left: { style: BorderStyle.NONE, size: 0, color: "1F3864" },
                right: { style: BorderStyle.NONE, size: 0, color: "1F3864" },
              },
              width: { size: CONTENT_WIDTH, type: WidthType.DXA },
              margins: { top: 220, bottom: 220, left: 220, right: 220 },
              shading: { fill: "1F3864", type: ShadingType.CLEAR, color: "auto" },
              children: [
                new Paragraph({
                  children: [
                    new TextRun({
                      text: data.title ?? "History",
                      bold: true,
                      size: 34,
                      color: "FFFFFF",
                    }),
                  ],
                }),
                new Paragraph({
                  children: [
                    new TextRun({
                      text: `${data.notebook}  ·  ${data.entries.length} selected entr${data.entries.length === 1 ? "y" : "ies"}`,
                      italics: true,
                      size: 20,
                      color: "D6DEEE",
                    }),
                  ],
                }),
              ],
            }),
          ],
        }),
      ],
    }),
    new Paragraph({ spacing: { after: 160 }, children: [new TextRun("")] }),
    infoTable([
      ["Notebook", data.notebook],
      ["Generated", dated],
      ["Entries exported", String(data.entries.length)],
    ]),
    new Paragraph({ children: [new TextRun("")] }),
  ];

  data.entries.forEach((entry, index) => {
    children.push(
      new Paragraph({
        heading: HeadingLevel.HEADING_2,
        spacing: { before: 240 },
        // Short titles only — the full question follows as body text below.
        children: [new TextRun({ text: `${index + 1}. ${conciseTitle(entry.title)}` })],
      }),
    );
    if (entry.date) {
      children.push(
        new Paragraph({
          children: [new TextRun({ text: entry.date, italics: true, size: 18, color: "52657A" })],
        }),
      );
    }
    children.push(sectionHeading("Question"), ...labelledBlock(entry.question));
    children.push(sectionHeading("Answer"), ...labelledBlock(entry.answer));
  });

  const doc = new Document({
    styles: calibriStyles(22),
    numbering: {
      config: [
        {
          reference: "bullets",
          levels: [
            {
              level: 0,
              format: LevelFormat.BULLET,
              text: "•",
              alignment: AlignmentType.LEFT,
              style: { paragraph: { indent: { left: 720, hanging: 360 } } },
            },
          ],
        },
        {
          reference: "numbers",
          levels: [
            {
              level: 0,
              format: LevelFormat.DECIMAL,
              text: "%1.",
              alignment: AlignmentType.LEFT,
              style: { paragraph: { indent: { left: 720, hanging: 360 } } },
            },
          ],
        },
      ],
    },
    sections: [
      {
        properties: {
          page: {
            size: { width: 12240, height: 15840 },
            margin: { top: 1440, right: 1440, bottom: 1440, left: 1440 },
          },
        },
        footers: { default: pageFooter() },
        children,
      },
    ],
  });

  const blob = await Packer.toBlob(doc);
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  const fallback =
    data.notebook
      .replace(/[^\w\s-]/g, "")
      .trim()
      .replace(/\s+/g, "-")
      .toLowerCase() || "history";
  a.download = `${fileNameFromQuestion(data.entries[0]?.title ?? "", fallback)}.docx`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}
