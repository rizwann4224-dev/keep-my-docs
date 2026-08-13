// Client-side document text extraction. Browser-only: call from event handlers.

const MAX_CHARS = 400_000;
const OCR_MAX_PAGES = 20;

export type OcrFn = (images: string[]) => Promise<string>;

export async function extractText(
  file: File,
  ocr?: OcrFn,
  onProgress?: (message: string) => void,
): Promise<string> {
  const name = file.name.toLowerCase();

  try {
    if (name.endsWith(".pdf") || file.type === "application/pdf") {
      const text = await extractPdf(file);
      if (text.replace(/\[Page \d+\]/g, "").trim().length > 200 || !ocr) {
        return text.slice(0, MAX_CHARS);
      }
      onProgress?.(`Scanned PDF — reading "${file.name}" with OCR…`);
      const ocrText = await ocrPdf(file, ocr);
      return (ocrText || text).slice(0, MAX_CHARS);
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

async function extractPdf(file: File): Promise<string> {
  const doc = await loadPdf(file);
  const parts: string[] = [];

  for (let pageNumber = 1; pageNumber <= doc.numPages; pageNumber += 1) {
    const page = await doc.getPage(pageNumber);
    const content = await page.getTextContent();
    const text = content.items
      .map((item) => ("str" in item ? item.str : ""))
      .join(" ")
      .replace(/\s+/g, " ")
      .trim();
    if (text) parts.push(`[Page ${pageNumber}] ${text}`);
    if (parts.join("\n").length > MAX_CHARS) break;
  }

  return parts.join("\n\n");
}

async function ocrPdf(file: File, ocr: OcrFn): Promise<string> {
  const doc = await loadPdf(file);
  const pageCount = Math.min(doc.numPages, OCR_MAX_PAGES);
  const batches: string[][] = [];

  for (let start = 1; start <= pageCount; start += 5) {
    const images: string[] = [];
    for (let n = start; n < start + 5 && n <= pageCount; n += 1) {
      const page = await doc.getPage(n);
      const viewport = page.getViewport({ scale: 1.4 });
      const canvas = document.createElement("canvas");
      canvas.width = viewport.width;
      canvas.height = viewport.height;
      const ctx = canvas.getContext("2d");
      if (!ctx) continue;
      await page.render({ canvas, canvasContext: ctx, viewport }).promise;
      images.push(canvas.toDataURL("image/jpeg", 0.65));
    }
    if (images.length) batches.push(images);
  }

  // All page batches are transcribed in parallel rather than one after another.
  const out = await Promise.all(batches.map((images) => ocr(images)));
  return out.join("\n\n");
}
