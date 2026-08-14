import { jsPDF } from "jspdf";

export type AskExport = {
  notebook: string;
  turns: { question: string; answer: string }[];
};

const MARGIN = 56;
const PAGE_W = 595.28; // A4 portrait, pt
const PAGE_H = 841.89;
const WIDTH = PAGE_W - MARGIN * 2;

/** Strips markdown emphasis so the PDF reads cleanly. */
function plain(text: string) {
  return text
    .replace(/`{1,3}/g, "")
    .replace(/\*\*(.+?)\*\*/g, "$1")
    .replace(/(^|\s)\*(?!\s)(.+?)\*/g, "$1$2");
}

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
    opts: { size?: number; style?: "normal" | "bold" | "italic"; gap?: number; color?: number[] } = {},
  ) => {
    const size = opts.size ?? 11;
    doc.setFont("helvetica", opts.style ?? "normal");
    doc.setFontSize(size);
    const [r, g, b] = opts.color ?? [30, 30, 35];
    doc.setTextColor(r!, g!, b!);
    const lines = doc.splitTextToSize(plain(text), WIDTH) as string[];
    const lh = size * 1.42;
    for (const line of lines) {
      space(lh);
      doc.text(line, MARGIN, y);
      y += lh;
    }
    y += opts.gap ?? 6;
  };

  write(`${data.notebook} — Ask session`, { size: 18, style: "bold", gap: 4 });
  write(
    new Date().toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" }),
    { size: 9, color: [120, 120, 130], gap: 14 },
  );

  data.turns.forEach((turn, index) => {
    space(40);
    write(`Q${index + 1}. ${turn.question}`, { size: 12, style: "bold", gap: 8 });

    for (const block of turn.answer.split(/\n{2,}/)) {
      const line = block.trim();
      if (!line) continue;
      const heading = /^#{1,6}\s+/.test(line);
      write(line.replace(/^#{1,6}\s+/, "").replace(/^[-*]\s+/gm, "• "), {
        size: heading ? 12 : 11,
        style: heading ? "bold" : "normal",
        gap: heading ? 4 : 8,
      });
    }

    y += 8;
    space(12);
    doc.setDrawColor(210, 210, 216);
    doc.line(MARGIN, y, PAGE_W - MARGIN, y);
    y += 16;
  });

  const pages = doc.getNumberOfPages();
  for (let p = 1; p <= pages; p++) {
    doc.setPage(p);
    doc.setFont("helvetica", "normal");
    doc.setFontSize(9);
    doc.setTextColor(140, 140, 150);
    doc.text(`${p} / ${pages}`, PAGE_W / 2, PAGE_H - 28, { align: "center" });
  }

  const safe = data.notebook.replace(/[^\w\-]+/g, "-").replace(/^-|-$/g, "") || "notebook";
  doc.save(`${safe}-ask.pdf`);
}
