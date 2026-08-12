// Client-side document text extraction. Browser-only: call from event handlers.

const MAX_CHARS = 120_000;

export async function extractText(file: File): Promise<string> {
  const name = file.name.toLowerCase();

  try {
    if (name.endsWith(".pdf") || file.type === "application/pdf") {
      return (await extractPdf(file)).slice(0, MAX_CHARS);
    }
    if (name.endsWith(".docx")) {
      const mammoth = await import("mammoth/mammoth.browser.js");
      const buffer = await file.arrayBuffer();
      const result = await mammoth.extractRawText({ arrayBuffer: buffer });
      return result.value.slice(0, MAX_CHARS);
    }
    if (
      file.type.startsWith("text/") ||
      /\.(txt|md|csv|json|html?)$/.test(name)
    ) {
      return (await file.text()).slice(0, MAX_CHARS);
    }
  } catch (error) {
    console.error("Text extraction failed", error);
  }
  return "";
}

async function extractPdf(file: File): Promise<string> {
  const pdfjs = await import("pdfjs-dist");
  pdfjs.GlobalWorkerOptions.workerSrc = new URL(
    "pdfjs-dist/build/pdf.worker.min.mjs",
    import.meta.url,
  ).toString();

  const data = new Uint8Array(await file.arrayBuffer());
  const doc = await pdfjs.getDocument({ data }).promise;
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
