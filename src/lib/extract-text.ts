// Client-side document text extraction. Browser-only: call from event handlers.
//
// Two guarantees drive this file:
//  1. Every page keeps its own `[Page N]` marker — a page's text is never merged
//     into another page's, so a quote can always be traced to the page it came from.
//  2. A page that could not be read is reported as a failure. It is never written
//     out as if it had been read, and there is no page-count cutoff: every page of
//     a long document is attempted.

// Big enough for multi-year indexed past-papers compilations. Truncating here was
// silently dropping the tail pages of long documents, which then surfaced as
// "not found in your sources". Truncation is now reported in `truncated`.
const MAX_CHARS = 8_000_000;
/** Scanned pages OCR'd concurrently — one page per request keeps the mapping exact. */
const OCR_CONCURRENCY = 4;
/** A text-layer page with fewer usable characters than this is treated as scanned. */
const MIN_PAGE_CHARS = 120;
/** Render scale for OCR. 3× (≈216 dpi) keeps decimals, minus signs and small print legible. */
const OCR_RENDER_SCALE = 3;
/** Attempts per page before the page is declared unreadable. */
const OCR_ATTEMPTS = 3;

/** The marker that opens one page's block. */
export const PAGE_MARKER = (page: number) => `[Page ${page}]`;

/** Text written in place of a page nothing could be read from. */
export const UNREADABLE = "[unreadable]";

/** Written for a page whose OCR call itself failed — never presented as extracted text. */
export const FAILED_PREFIX = "[unreadable — this page could not be read";

/** An OCR-capable transcriber: one image in, that page's text out. */
export type OcrFn = (images: string[]) => Promise<string>;

export type ExtractionIssue = {
  /** 1-based page number (1 for a standalone image). */
  page: number;
  reason: string;
};

export type ExtractionResult = {
  text: string;
  /** Pages nothing could be read from. Non-empty means the extraction did not fully succeed. */
  failedPages: ExtractionIssue[];
  /** True when the text hit the size cap and the tail was dropped. */
  truncated: boolean;
  /** Pages that had no usable text layer and were sent to OCR. */
  ocrPages: number[];
  /** Total pages seen (PDFs); 1 for images/text files. */
  pageCount: number;
};

/** Back-compat wrapper: the extracted text only. Prefer `extractDocument`. */
export async function extractText(
  file: File,
  ocr?: OcrFn,
  onProgress?: (message: string) => void,
): Promise<string> {
  return (await extractDocument(file, ocr, onProgress)).text;
}

/**
 * Extract a document, reporting honestly what could and could not be read.
 * Throws only when the file itself could not be opened at all; a page that
 * failed to OCR is returned in `failedPages` so the caller can tell the user
 * instead of saving a partial read as a complete one.
 */
export async function extractDocument(
  file: File,
  ocr?: OcrFn,
  onProgress?: (message: string) => void,
): Promise<ExtractionResult> {
  const name = file.name.toLowerCase();

  try {
    if (name.endsWith(".pdf") || file.type === "application/pdf") {
      return await extractPdfSmart(file, ocr, onProgress);
    }
    if (name.endsWith(".docx")) {
      const mammoth = await import("mammoth/mammoth.browser.js");
      const buffer = await file.arrayBuffer();
      const result = await mammoth.extractRawText({ arrayBuffer: buffer });
      return single(result.value);
    }
    if (name.endsWith(".doc")) {
      // Legacy binary .doc has no usable reader in the browser. Saying so beats
      // indexing an empty document and reporting "no text found".
      return {
        text: "",
        failedPages: [
          {
            page: 1,
            reason:
              "Legacy .doc files cannot be read in the browser — convert to .docx or PDF, then Review text to paste it in.",
          },
        ],
        truncated: false,
        ocrPages: [],
        pageCount: 1,
      };
    }
    if (file.type.startsWith("image/")) {
      onProgress?.(`Reading text from "${file.name}"…`);
      const dataUrl = await fileToDataUrl(file);
      if (!ocr) {
        return {
          text: "",
          failedPages: [
            { page: 1, reason: "No OCR provider is configured, so this image could not be read." },
          ],
          truncated: false,
          ocrPages: [],
          pageCount: 1,
        };
      }
      const { text, issue } = await ocrPage(ocr, dataUrl, 1);
      return {
        text: text ? `${PAGE_MARKER(1)}\n${text}` : "",
        failedPages: issue ? [issue] : [],
        truncated: false,
        ocrPages: [1],
        pageCount: 1,
      };
    }
    if (file.type.startsWith("text/") || /\.(txt|md|csv|json|html?)$/.test(name)) {
      return single(await file.text());
    }
  } catch (error) {
    console.error("Text extraction failed", error);
    throw error instanceof Error ? error : new Error(String(error));
  }

  return {
    text: "",
    failedPages: [{ page: 1, reason: "Unsupported file type — no text could be extracted." }],
    truncated: false,
    ocrPages: [],
    pageCount: 1,
  };
}

function single(raw: string): ExtractionResult {
  const { text, truncated } = cap(raw ?? "");
  return { text, failedPages: [], truncated, ocrPages: [], pageCount: 1 };
}

function cap(text: string): { text: string; truncated: boolean } {
  const clean = text.trim();
  if (clean.length <= MAX_CHARS) return { text: clean, truncated: false };
  return {
    text: `${clean.slice(0, MAX_CHARS)}\n\n[Extraction stopped at ${MAX_CHARS.toLocaleString()} characters — the rest of this file was not indexed.]`,
    truncated: true,
  };
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
 * ordered left-to-right, so tables, headings, numbering and decimal columns
 * survive instead of collapsing into one blurred paragraph.
 */
export function layoutPageText(items: { str: string; transform: number[] }[]): string {
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
): Promise<ExtractionResult> {
  const doc = await loadPdf(file);
  const total = doc.numPages;
  const pages: string[] = new Array(total).fill("");
  const scanned: number[] = [];
  const failedPages: ExtractionIssue[] = [];

  for (let pageNumber = 1; pageNumber <= total; pageNumber += 1) {
    if (pageNumber % 5 === 0) onProgress?.(`Reading page ${pageNumber} of ${total}…`);
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

  // OCR EVERY scanned page — no page-count cutoff, and one request per page so a
  // page's transcription can never be attached to another page's number. A page
  // whose OCR never succeeded is recorded in `failedPages` and written out as an
  // explicit unreadable marker instead of being quietly skipped.
  if (scanned.length > 0) {
    if (!ocr) {
      for (const pageNumber of scanned) {
        failedPages.push({
          page: pageNumber,
          reason: "No OCR provider is configured, so this scanned page could not be read.",
        });
      }
    } else {
      const ocrTotal = scanned.length;
      let done = 0;
      onProgress?.(
        `Scanned pages detected — reading ${ocrTotal} page${ocrTotal === 1 ? "" : "s"} with OCR at 3× resolution…`,
      );
      await runPool(scanned, OCR_CONCURRENCY, async (pageNumber) => {
        let reason = "could not be read";
        try {
          const image = await renderPageForOcr(doc, pageNumber);
          if (!image) {
            reason = "could not be rendered for OCR";
          } else {
            const outcome = await ocrPage(ocr, image, pageNumber);
            if (outcome.text) pages[pageNumber - 1] = outcome.text;
            else if (outcome.issue) reason = outcome.issue.reason;
          }
        } catch (error) {
          reason = error instanceof Error ? error.message : String(error);
        }
        if (!pages[pageNumber - 1]?.trim()) {
          failedPages.push({ page: pageNumber, reason });
        }
        done += 1;
        if (done % 5 === 0 || done === ocrTotal) {
          onProgress?.(`Reading scanned page ${done} of ${ocrTotal}…`);
        }
      });
      failedPages.sort((a, b) => a.page - b.page);
    }
  }

  const blocks: string[] = [];
  for (let pageNumber = 1; pageNumber <= total; pageNumber += 1) {
    const text = (pages[pageNumber - 1] ?? "").trim();
    if (text) {
      blocks.push(`${PAGE_MARKER(pageNumber)}\n${text}`);
      continue;
    }
    const failure = failedPages.find((f) => f.page === pageNumber);
    if (failure) blocks.push(`${PAGE_MARKER(pageNumber)}\n${FAILED_PREFIX}: ${failure.reason}]`);
    // A genuinely blank page (nothing printed, and nothing failed) is skipped —
    // it is not a failure, and an empty marker block would only add noise.
  }

  const { text, truncated } = cap(blocks.join("\n\n"));
  return { text, failedPages, truncated, ocrPages: scanned, pageCount: total };
}

/**
 * OCR one page, retrying transient provider failures. Returns the page's text or
 * an explicit issue — never an empty "success".
 */
async function ocrPage(
  ocr: OcrFn,
  dataUrl: string,
  pageNumber: number,
): Promise<{ text: string; issue: ExtractionIssue | null }> {
  let lastReason = "the OCR service returned no text";
  for (let attempt = 1; attempt <= OCR_ATTEMPTS; attempt += 1) {
    try {
      const raw = await ocr([dataUrl]);
      const text = normalizeOcrPage(raw, pageNumber);
      if (text) return { text, issue: null };
      lastReason = "the OCR service returned no text for this page";
    } catch (error) {
      lastReason = error instanceof Error ? error.message : String(error);
    }
    if (attempt < OCR_ATTEMPTS) await sleep(400 * attempt);
  }
  return { text: "", issue: { page: pageNumber, reason: lastReason } };
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * A page's transcription, cleaned so it can only ever describe that page:
 * invented page numbers/headers are removed (the caller re-attaches the real
 * `[Page N]` marker), and the model's commentary wrappers are dropped.
 */
export function normalizeOcrPage(raw: string | null | undefined, pageNumber: number): string {
  if (!raw) return "";
  const body = raw
    .replace(/\r/g, "")
    // Drop a model-invented page label or per-page preamble, so nothing from
    // this page can be mistaken for another page's content.
    .replace(
      /^[ \t]*[<([]?\s*(page|pagina|pg)\s*#?\s*\d{1,4}\s*[>)\]]?\s*[:.\-–]?\s*(of\s*\d{1,4})?[ \t]*$/gim,
      "",
    )
    .replace(/^[ \t]*(transcription|text|output)\s*[:-][ \t]*$/gi, "")
    // Any page marker inside the body is neutralised: the caller owns those.
    .replace(/[<([]\s*(?:page|pg)\s*#?\s*\d{1,4}\s*[>)\]]/gi, (match) =>
      match.replace(/\d+/, String(pageNumber)),
    )
    .replace(/```(?:text|markdown)?/gi, "")
    .trim();
  return body;
}

/** Run `task` over `items` with at most `limit` in flight at once. */
async function runPool<T>(items: T[], limit: number, task: (item: T) => Promise<void>) {
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const item = items[next++];
      if (item === undefined) return;
      await task(item);
    }
  });
  await Promise.all(workers);
}

/**
 * Render one PDF page as a PNG data URL at `OCR_RENDER_SCALE`. PNG (not JPEG)
 * because lossy compression blurs the exact glyphs OCR needs: decimal points,
 * minus signs, and thin table rules.
 */
export async function renderPageForOcr(
  doc: Awaited<ReturnType<typeof loadPdf>>,
  pageNumber: number,
  scale: number = OCR_RENDER_SCALE,
): Promise<string | null> {
  const page = await doc.getPage(pageNumber);
  const viewport = page.getViewport({ scale });
  const canvas = document.createElement("canvas");
  canvas.width = Math.ceil(viewport.width);
  canvas.height = Math.ceil(viewport.height);
  const ctx = canvas.getContext("2d");
  if (!ctx) return null;
  // White background: a transparent PNG makes inverted/sketched pages unreadable.
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  await page.render({ canvas, canvasContext: ctx, viewport }).promise;
  return canvas.toDataURL("image/png");
}
