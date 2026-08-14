// Client-side document text extraction. Browser-only: call from event handlers.

const MAX_CHARS = 1_200_000;
const OCR_MAX_PAGES = 80;
const OCR_BATCH = 4;
/** A text-layer page with fewer usable characters than this is treated as scanned. */
const MIN_PAGE_CHARS = 120;

export type OcrFn = (images: string[]) => Promise<string>;

export async function extractText(
  file: File,
  ocr?: OcrFn,
  onProgress?: (message: string) => void,
): Promise<string> {
  const name = file.name.toLowerCase();

  try {
    if (name.endsWith(".pdf") || file.type === "application/pdf") {
      return await extractPdfSmart(file, ocr, onProgress);
    }
    if (name.endsWith(".docx")) {
      const mammoth = await import("mammoth/mammoth.browser.js");
      const buffer = await file.arrayBuffer();
      const result = await mammoth.extractRawText({ arrayBuffer: buffer });
      return result.value.slice(0, MAX_CHARS);
    }
    if (file.type.startsWith("image/") && ocr) {
      onProgress?.(`Reading text from "${file.name}"…`);
      const dataUrl = await fileToDataUrl(file);
      return (await ocr([dataUrl])).slice(0, MAX_CHARS);
    }
    if (file.type.startsWith("text/") || /\.(txt|md|csv|json|html?)$/.test(name)) {
      return (await file.text()).slice(0, MAX_CHARS);
    }
  } catch (error) {
    console.error("Text extraction failed", error);
  }
  return "";
}

function fileToDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}

async function loadPdf(file: File) {
  const [pdfjs, workerUrl] = await Promise.all([
    import("pdfjs-dist"),
    import("pdfjs-dist/build/pdf.worker.min.mjs?url").then((m) => m.default),
  ]);
  pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;
  const data = new Uint8Array(await file.arrayBuffer());
  return pdfjs.getDocument({ data }).promise;
}

/**
 * Layout-aware page text: items are grouped into lines by their y position and
 * ordered left-to-right, so tables, headings and numbered clauses survive
 * instead of collapsing into one blurred paragraph.
 */
function layoutPageText(items: { str: string; transform: number[] }[]): string {
  const lines: { y: number; parts: { x: number; str: string }[] }[] = [];

  for (const item of items) {
    if (!item.str || !item.str.trim()) continue;
    const x = item.transform[4] ?? 0;
    const y = Math.round((item.transform[5] ?? 0) * 2) / 2;
    const line = lines.find((l) => Math.abs(l.y - y) < 2.5);
    if (line) line.parts.push({ x, str: item.str });
    else lines.push({ y, parts: [{ x, str: item.str }] });
  }

  return lines
    .sort((a, b) => b.y - a.y)
    .map((line) => {
      const parts = line.parts.sort((a, b) => a.x - b.x);
      let out = "";
      let prevEnd = -Infinity;
      for (const part of parts) {
        const gap = part.x - prevEnd;
        if (out && gap > 12) out += "   ";
        else if (out && !/\s$/.test(out) && !/^\s/.test(part.str)) out += " ";
        out += part.str;
        prevEnd = part.x + part.str.length * 4.5;
      }
      return out.replace(/[ \t]{4,}/g, "   ").trimEnd();
    })
    .filter((line) => line.length > 0)
    .join("\n");
}

async function extractPdfSmart(
  file: File,
  ocr: OcrFn | undefined,
  onProgress?: (message: string) => void,
): Promise<string> {
  const doc = await loadPdf(file);
  const pages: string[] = [];
  const scanned: number[] = [];

  for (let pageNumber = 1; pageNumber <= doc.numPages; pageNumber += 1) {
    if (pageNumber % 5 === 0) onProgress?.(`Reading page ${pageNumber} of ${doc.numPages}…`);
    const page = await doc.getPage(pageNumber);
    const content = await page.getTextContent();
    const text = layoutPageText(
      content.items.flatMap((item) =>
        "str" in item ? [{ str: item.str, transform: item.transform as number[] }] : [],
      ),
    );
    pages[pageNumber - 1] = text;
    if (text.replace(/\s/g, "").length < MIN_PAGE_CHARS) scanned.push(pageNumber);
  }

  // Only the pages that genuinely have no text layer are sent to OCR.
  if (ocr && scanned.length > 0) {
    const targets = scanned.slice(0, OCR_MAX_PAGES);
    onProgress?.(`Scanned pages detected — reading ${targets.length} with OCR…`);
    const batches: number[][] = [];
    for (let i = 0; i < targets.length; i += OCR_BATCH) {
      batches.push(targets.slice(i, i + OCR_BATCH));
    }
    const results = await Promise.all(
      batches.map(async (batch) => {
        const images: string[] = [];
        for (const pageNumber of batch) {
          const image = await renderPage(doc, pageNumber);
          if (image) images.push(image);
        }
        if (!images.length) return { batch, text: "" };
        return { batch, text: await ocr(images) };
      }),
    );
    for (const { batch, text } of results) {
      if (!text.trim()) continue;
      // OCR returns the batch as one block; attach it to the first page of the batch.
      pages[(batch[0] ?? 1) - 1] = text;
    }
  }

  const out = pages
    .map((text, i) => (text?.trim() ? `[Page ${i + 1}]\n${text.trim()}` : ""))
    .filter(Boolean)
    .join("\n\n");
  return out.slice(0, MAX_CHARS);
}

async function renderPage(
  doc: Awaited<ReturnType<typeof loadPdf>>,
  pageNumber: number,
): Promise<string | null> {
  const page = await doc.getPage(pageNumber);
  const viewport = page.getViewport({ scale: 2 });
  const canvas = document.createElement("canvas");
  canvas.width = viewport.width;
  canvas.height = viewport.height;
  const ctx = canvas.getContext("2d");
  if (!ctx) return null;
  await page.render({ canvas, canvasContext: ctx, viewport }).promise;
  return canvas.toDataURL("image/jpeg", 0.8);
}
