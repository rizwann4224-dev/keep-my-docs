import { jsPDF } from "jspdf";

export type AskExport = {
  notebook: string;
  /** Heading suffix, e.g. "Ask session" or "Exam paper". */
  title?: string;
  turns: { question: string; answer: string }[];
};

const MARGIN = 56;
const PAGE_W = 595.28; // A4 portrait, pt
const PAGE_H = 841.89;
const WIDTH = PAGE_W - MARGIN * 2;
const INK: [number, number, number] = [26, 30, 38];
const ACCENT: [number, number, number] = [31, 56, 100];
const MUTED: [number, number, number] = [118, 122, 132];

/** Strips markdown emphasis so the PDF reads cleanly. */
function plain(text: string) {
  return text
    .replace(/`{1,3}/g, "")
    .replace(/\*\*(.+?)\*\*/g, "$1")
    .replace(/(^|\s)\*(?!\s)(.+?)\*/g, "$1$2");
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

  // Title block
  write(`${data.notebook} — ${data.title ?? "Ask session"}`, {
    size: 19,
    style: "bold",
    color: ACCENT,
    gap: 2,
  });
  write(new Date().toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" }), {
    size: 9,
    color: MUTED,
    gap: 8,
  });
  doc.setDrawColor(ACCENT[0], ACCENT[1], ACCENT[2]);
  doc.setLineWidth(1.2);
  doc.line(MARGIN, y, PAGE_W - MARGIN, y);
  y += 18;

  data.turns.forEach((turn, index) => {
    space(48);
    doc.setFillColor(240, 243, 249);
    const qLines = doc.splitTextToSize(plain(turn.question), WIDTH - 20) as string[];
    const qHeight = qLines.length * 15 + 14;
    doc.rect(MARGIN, y - 12, WIDTH, qHeight, "F");
    write(`Q${index + 1}. ${plain(turn.question)}`, {
      size: 12,
      style: "bold",
      color: ACCENT,
      gap: 10,
      indent: 8,
    });

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

  const pages = doc.getNumberOfPages();
  for (let p = 1; p <= pages; p++) {
    doc.setPage(p);
    doc.setFont("times", "normal");
    doc.setFontSize(9);
    doc.setTextColor(MUTED[0], MUTED[1], MUTED[2]);
    doc.text(data.notebook, MARGIN, PAGE_H - 28);
    doc.text(`${p} / ${pages}`, PAGE_W - MARGIN, PAGE_H - 28, { align: "right" });
  }

  const safe = data.notebook.replace(/[^\w\-]+/g, "-").replace(/^-|-$/g, "") || "notebook";
  doc.save(`${safe}-${(data.title ?? "ask").toLowerCase().replace(/\s+/g, "-")}.pdf`);
}
