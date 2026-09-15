// Global upload store. Uploads keep running when the user switches tabs or
// notebooks — only leaving the page can interrupt them (and we warn first).
import { supabase } from "@/integrations/supabase/client";
import { extractDocument, type ExtractionResult, type OcrFn } from "@/lib/extract-text";
import { uploadWithProgress, formatSpeed } from "@/lib/upload";

export type UploadJob = {
  id: string;
  subjectId: string;
  name: string;
  size: number;
  percent: number;
  speed: string;
  stage: string;
  status: "active" | "done" | "error";
  /** Pages that could not be read — the upload is never called "done" while these exist. */
  unreadablePages?: number[];
};

let jobs: UploadJob[] = [];
const listeners = new Set<() => void>();

function commit(next: UploadJob[]) {
  jobs = next;
  for (const listener of listeners) listener();
}

export function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function getJobs(): UploadJob[] {
  return jobs;
}

export function jobsFor(subjectId: string) {
  return jobs.filter((job) => job.subjectId === subjectId);
}

export function anyUploading() {
  return jobs.some((job) => job.status === "active");
}

function patch(id: string, updates: Partial<UploadJob>) {
  commit(jobs.map((job) => (job.id === id ? { ...job, ...updates } : job)));
}

function notifyDocuments(subjectId: string) {
  if (typeof window !== "undefined") {
    window.dispatchEvent(new CustomEvent("documents-changed", { detail: subjectId }));
  }
}

/**
 * True when a stored document still carries unreadable-page markers, so the
 * source list can show "Needs review" instead of "Indexed".
 */
export function unreadablePagesIn(text: string | null | undefined): number[] {
  if (!text) return [];
  const pages: number[] = [];
  const blocks = text.split(/^\[Page (\d+)\]$/m);
  for (let i = 1; i < blocks.length - 1; i += 2) {
    const page = Number(blocks[i]);
    const body = blocks[i + 1] ?? "";
    if (/\[unreadable/i.test(body) || /could not be read/i.test(body)) pages.push(page);
  }
  return pages;
}

async function runOne(job: UploadJob, file: File, userId: string, ocr: OcrFn): Promise<void> {
  const safeName = file.name.replace(/[^\w.\- ]+/g, "_");
  const path = `${userId}/${crypto.randomUUID()}-${safeName}`;

  const uploadTask = uploadWithProgress("documents", path, file, (p) =>
    patch(job.id, {
      percent: p.percent,
      speed: formatSpeed(p.bytesPerSecond),
      stage: p.percent >= 100 ? "Reading text…" : "Uploading",
    }),
  );
  const extractTask = extractDocument(file, ocr, (message) => patch(job.id, { stage: message }));

  const [uploadOutcome, extractOutcome] = await Promise.allSettled([uploadTask, extractTask]);

  if (uploadOutcome.status === "rejected") {
    // Nothing reached storage, so nothing is recorded anywhere.
    patch(job.id, {
      status: "error",
      stage: uploadOutcome.reason instanceof Error ? uploadOutcome.reason.message : "Upload failed",
    });
    return;
  }

  if (extractOutcome.status === "rejected") {
    // The file itself is safely stored, but the read failed: record the document
    // with no text so Re-index / Review text can fix it, and say so plainly.
    const message =
      extractOutcome.reason instanceof Error
        ? extractOutcome.reason.message
        : "Could not read text from this file";
    const { error: insertError } = await supabase.from("documents").insert({
      user_id: userId,
      subject_id: job.subjectId,
      name: file.name,
      storage_path: path,
      mime_type: file.type || null,
      size_bytes: file.size,
      extracted_text: null,
    });
    if (insertError) {
      await supabase.storage.from("documents").remove([path]);
      patch(job.id, { status: "error", stage: "Could not save this file" });
      return;
    }
    notifyDocuments(job.subjectId);
    patch(job.id, {
      status: "error",
      percent: 100,
      stage: `File stored, but reading it failed — ${message}`,
    });
    return;
  }

  const result: ExtractionResult = extractOutcome.value;

  const text = result.text.trim();
  const failed = result.failedPages;

  const { error: insertError } = await supabase.from("documents").insert({
    user_id: userId,
    subject_id: job.subjectId,
    name: file.name,
    storage_path: path,
    mime_type: file.type || null,
    size_bytes: file.size,
    extracted_text: text || null,
  });

  if (insertError) {
    await supabase.storage.from("documents").remove([path]);
    patch(job.id, { status: "error", stage: "Could not save this file" });
    return;
  }

  notifyDocuments(job.subjectId);

  if (failed.length > 0) {
    // Partial read: saved so the pages that WERE read stay searchable, but the
    // job reports failure and names the pages, so it is never mistaken for a
    // complete index. "Review text" lets the user fix the marked pages by hand.
    patch(job.id, {
      status: "error",
      percent: 100,
      speed: "",
      unreadablePages: failed.map((f) => f.page),
      stage: `Page${failed.length === 1 ? "" : "s"} ${failed
        .map((f) => f.page)
        .join(", ")} unreadable — saved as marked. Open Review text to fix.`,
    });
    return;
  }

  if (!text) {
    patch(job.id, {
      status: "error",
      percent: 100,
      speed: "",
      stage: "No readable text found — nothing was indexed. Open Review text to paste it in.",
    });
    return;
  }

  patch(job.id, {
    status: "done",
    percent: 100,
    speed: "",
    stage: result.truncated
      ? `Indexed (truncated at the size limit)`
      : `Indexed${
          result.ocrPages.length
            ? ` — ${result.ocrPages.length} scanned page${
                result.ocrPages.length === 1 ? "" : "s"
              } read by OCR`
            : ""
        }`,
  });
}

export function startUploads(subjectId: string, userId: string, files: File[], ocr: OcrFn) {
  if (files.length === 0) return;
  const newJobs: UploadJob[] = files.map((file) => ({
    id: crypto.randomUUID(),
    subjectId,
    name: file.name,
    size: file.size,
    percent: 0,
    speed: "",
    stage: "Queued",
    status: "active",
  }));
  commit([...jobs, ...newJobs]);

  newJobs.forEach((job, index) => {
    void runOne(job, files[index]!, userId, ocr);
  });
}

export function dismiss(id: string) {
  commit(jobs.filter((job) => job.id !== id));
}

export function clearFinished(subjectId: string) {
  commit(jobs.filter((job) => job.subjectId !== subjectId || job.status === "active"));
}
