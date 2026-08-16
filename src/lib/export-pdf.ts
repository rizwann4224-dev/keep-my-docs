import { jsPDF } from "jspdf";

export type AskExport = {
  notebook: string;
  /** Heading suffix, e.g. "Ask session" or "Exam paper". */
  title?: string;
  /** When false the user's prompt/brief is omitted and only the content is exported. */
  showPrompts?: boolean;
  turns: { question: string; answer: string }[];
};

const MARGIN = 56;
const PAGE_W = 595.28; // A4 portrait, pt
const PAGE_H = 841.89;
const WIDTH = PAGE_W - MARGIN * 2;
const INK: [number, number, number] = [26, 30, 38];
const ACCENT: [number, number, number] = [31, 56, 100];
const MUTED: [number, number, number] = [118, 122, 132];

/** Emoji/pictographs are not in the PDF core fonts and render as mojibake. */
const EMOJI = /[\p{Extended_Pictographic}\u{FE0F}\u{20E3}\u{1F3FB}-\u{1F3FF}]/gu;

/** Strips markdown emphasis and emoji so the PDF reads cleanly. */
function plain(text: string) {
  return text
    .replace(/`{1,3}/g, "")
    .replace(/\*\*(.+?)\*\*/g, "$1")
    .replace(/(^|\s)\*(?!\s)(.+?)\*/g, "$1$2")
    .replace(EMOJI, "")
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

export function exportAskToPdf(data: AskExport) {
  const doc = new jsPDF({ unit: "pt", format: "a4" });
  let y = MARGIN;

  const space = (needed: number) => {
    if (y + needed > PAGE_H - MARGIN) {
      doc.addPage();
      y = MARGIN;
    }
  };

  const write = (
    text: string,
    opts: {
      size?: number;
      style?: "normal" | "bold" | "italic";
      gap?: number;
      color?: [number, number, number];
      indent?: number;
    } = {},
  ) => {
    const size = opts.size ?? 11;
    const indent = opts.indent ?? 0;
    doc.setFont("times", opts.style ?? "normal");
    doc.setFontSize(size);
    const [r, g, b] = opts.color ?? INK;
    doc.setTextColor(r, g, b);
    const lines = doc.splitTextToSize(text, WIDTH - indent) as string[];
    const lh = size * 1.42;
    for (const line of lines) {
      space(lh);
      doc.text(line, MARGIN + indent, y);
      y += lh;
    }
    y += opts.gap ?? 6;
  };

  /** Renders a markdown table as a bordered grid. */
  const table = (rows: string[][]) => {
    if (rows.length === 0) return;
    const columns = Math.max(...rows.map((r) => r.length));
    const colW = WIDTH / columns;
    const size = 10;
    const lh = size * 1.3;

    rows.forEach((cells, rowIndex) => {
      doc.setFont("times", rowIndex === 0 ? "bold" : "normal");
      doc.setFontSize(size);
      const wrapped = Array.from({ length: columns }, (_, i) =>
        doc.splitTextToSize(cells[i] ?? "", colW - 12) as string[],
      );
      const height = Math.max(...wrapped.map((w) => w.length)) * lh + 8;
      space(height);

      if (rowIndex === 0) {
        doc.setFillColor(237, 241, 247);
        doc.rect(MARGIN, y - 2, WIDTH, height, "F");
      }
      doc.setDrawColor(205, 210, 220);
      doc.setLineWidth(0.5);
      for (let i = 0; i < columns; i++) {
        doc.rect(MARGIN + i * colW, y - 2, colW, height);
      }
      doc.setTextColor(INK[0], INK[1], INK[2]);
      wrapped.forEach((lines, i) => {
        lines.forEach((line, li) => {
          doc.text(line, MARGIN + i * colW + 6, y + 10 + li * lh);
        });
      });
      y += height;
    });
    y += 10;
  };

  // Cover band
  doc.setFillColor(ACCENT[0], ACCENT[1], ACCENT[2]);
  doc.rect(0, 0, PAGE_W, 92, "F");
  doc.setFont("times", "bold");
  doc.setFontSize(20);
  doc.setTextColor(255, 255, 255);
  doc.text(data.title ?? "Ask session", MARGIN, 44);
  doc.setFont("times", "italic");
  doc.setFontSize(11);
  doc.setTextColor(214, 222, 238);
  doc.text(data.notebook, MARGIN, 64);
  doc.setFont("times", "normal");
  doc.setFontSize(9);
  doc.text(
    new Date().toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" }),
    PAGE_W - MARGIN,
    64,
    { align: "right" },
  );
  y = 92 + 30;

  const showPrompts = data.showPrompts !== false;

  data.turns.forEach((turn, index) => {
    if (showPrompts) {
      space(48);
      const qText = `Q${index + 1}. ${plain(turn.question)}`;
      const qLines = doc.splitTextToSize(qText, WIDTH - 28) as string[];
      const qHeight = qLines.length * 16 + 20;
      doc.setFillColor(241, 244, 250);
      doc.rect(MARGIN, y - 14, WIDTH, qHeight, "F");
      doc.setFillColor(ACCENT[0], ACCENT[1], ACCENT[2]);
      doc.rect(MARGIN, y - 14, 3.5, qHeight, "F");
      write(qText, {
        size: 12,
        style: "bold",
        color: ACCENT,
        gap: 14,
        indent: 14,
      });
    } else if (index > 0) {
      y += 6;
    }

    const lines = turn.answer.replace(/\r/g, "").split("\n");
    let i = 0;
    while (i < lines.length) {
      const line = (lines[i] ?? "").trim();
      if (!line) {
        i += 1;
        continue;
      }

      if (line.startsWith("|")) {
        const rows: string[][] = [];
        while (i < lines.length && (lines[i] ?? "").trim().startsWith("|")) {
          const cells = splitRow(lines[i] ?? "");
          if (!isDivider(cells)) rows.push(cells);
          i += 1;
        }
        table(rows);
        continue;
      }

      const heading = /^(#{1,6})\s+(.*)$/.exec(line);
      if (heading) {
        space(20);
        write(plain(heading[2] ?? ""), {
          size: (heading[1]?.length ?? 1) <= 2 ? 13 : 12,
          style: "bold",
          color: ACCENT,
          gap: 4,
        });
        i += 1;
        continue;
      }

      const bullet = /^[-*•]\s+(.*)$/.exec(line);
      if (bullet) {
        write(`•  ${plain(bullet[1] ?? "")}`, { size: 11, gap: 2, indent: 14 });
        i += 1;
        continue;
      }

      const numbered = /^(\d+[.)])\s+(.*)$/.exec(line);
      if (numbered) {
        write(`${numbered[1]}  ${plain(numbered[2] ?? "")}`, { size: 11, gap: 2, indent: 14 });
        i += 1;
        continue;
      }

      write(plain(line), { size: 11, gap: 6 });
      i += 1;
    }

    y += 10;
    space(12);
    doc.setDrawColor(214, 218, 226);
    doc.setLineWidth(0.6);
    doc.line(MARGIN, y, PAGE_W - MARGIN, y);
    y += 18;
  });

  const fallback =
    data.notebook.replace(/[^\w\-]+/g, "-").replace(/^-|-$/g, "").toLowerCase() || "notebook";
  const name = fileNameFromQuestion(data.turns[0]?.question ?? "", fallback);
  doc.save(`${name}.pdf`);
}
