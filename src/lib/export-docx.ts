import {
  AlignmentType,
  BorderStyle,
  Document,
  HeadingLevel,
  LevelFormat,
  Packer,
  Paragraph,
  ShadingType,
  Table,
  TableCell,
  TableRow,
  TextRun,
  WidthType,
} from "docx";
import { fileNameFromQuestion } from "@/lib/export-pdf";

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

function buildTable(lines: string[]): Table {
  const rows = lines.map(splitRow).filter((cells) => !cells.every((c) => /^:?-{2,}:?$/.test(c)));
  const columns = Math.max(...rows.map((r) => r.length));
  const width = Math.floor(CONTENT_WIDTH / columns);
  const widths = Array.from({ length: columns }, (_, i) =>
    i === columns - 1 ? CONTENT_WIDTH - width * (columns - 1) : width,
  );

  return new Table({
    width: { size: CONTENT_WIDTH, type: WidthType.DXA },
    columnWidths: widths,
    rows: rows.map(
      (cells, rowIndex) =>
        new TableRow({
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

/** Markdown-lite → docx block elements. */
function markdownToBlocks(markdown: string): (Paragraph | Table)[] {
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
      blocks.push(buildTable(table));
      blocks.push(new Paragraph({ children: [new TextRun("")] }));
      continue;
    }

    const heading = /^(#{1,4})\s+(.*)$/.exec(trimmed);
    if (heading) {
      const level = heading[1]!.length;
      blocks.push(
        new Paragraph({
          heading:
            level <= 1
              ? HeadingLevel.HEADING_1
              : level === 2
                ? HeadingLevel.HEADING_2
                : HeadingLevel.HEADING_3,
          children: runs(heading[2] ?? ""),
        }),
      );
      i += 1;
      continue;
    }

    if (/^([-*•]|\u2022)\s+/.test(trimmed)) {
      blocks.push(
        new Paragraph({
          numbering: { reference: "bullets", level: 0 },
          children: runs(trimmed.replace(/^([-*•]|\u2022)\s+/, "")),
        }),
      );
      i += 1;
      continue;
    }

    const numbered = /^\d+[.)]\s+(.*)$/.exec(trimmed);
    if (numbered) {
      blocks.push(
        new Paragraph({
          numbering: { reference: "numbers", level: 0 },
          children: runs(numbered[1] ?? ""),
        }),
      );
      i += 1;
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

function labelledBlock(markdown: string): (Paragraph | Table)[] {
  const blocks = markdownToBlocks(markdown);
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
    styles: {
      default: { document: { run: { font: "Times New Roman", size: 22 } } },
      paragraphStyles: [
        {
          id: "Heading1",
          name: "Heading 1",
          basedOn: "Normal",
          next: "Normal",
          quickFormat: true,
          run: { size: 32, bold: true, font: "Times New Roman" },
          paragraph: { spacing: { before: 240, after: 200 }, outlineLevel: 0 },
        },
        {
          id: "Heading2",
          name: "Heading 2",
          basedOn: "Normal",
          next: "Normal",
          quickFormat: true,
          run: { size: 26, bold: true, font: "Times New Roman", color: "1F3864" },
          paragraph: { spacing: { before: 280, after: 140 }, outlineLevel: 1 },
        },
        {
          id: "Heading3",
          name: "Heading 3",
          basedOn: "Normal",
          next: "Normal",
          quickFormat: true,
          run: { size: 23, bold: true, font: "Times New Roman" },
          paragraph: { spacing: { before: 200, after: 100 }, outlineLevel: 2 },
        },
      ],
    },
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
    data.notebook.replace(/[^\w\s-]/g, "").trim().replace(/\s+/g, "-").toLowerCase() || "marking",
  )}.docx`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}
