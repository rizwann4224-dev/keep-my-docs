// Global upload store. Uploads keep running when the user switches tabs or
// notebooks — only leaving the page can interrupt them (and we warn first).
import { supabase } from "@/integrations/supabase/client";
import { extractText, type OcrFn } from "@/lib/extract-text";
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

async function runOne(
  job: UploadJob,
  file: File,
  userId: string,
  ocr: OcrFn,
): Promise<void> {
  const safeName = file.name.replace(/[^\w.\- ]+/g, "_");
  const path = `${userId}/${crypto.randomUUID()}-${safeName}`;

  const uploadTask = uploadWithProgress("documents", path, file, (p) =>
    patch(job.id, {
      percent: p.percent,
      speed: formatSpeed(p.bytesPerSecond),
      stage: p.percent >= 100 ? "Reading text…" : "Uploading",
    }),
  );
  const extractTask = extractText(file, ocr, (message) => patch(job.id, { stage: message }));

  let text = "";
  try {
    [, text] = await Promise.all([uploadTask, extractTask]);
  } catch (error) {
    await extractTask.catch(() => "");
    patch(job.id, {
      status: "error",
      stage: error instanceof Error ? error.message : "Upload failed",
    });
    return;
  }

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

  patch(job.id, {
    status: "done",
    percent: 100,
    speed: "",
    stage: text ? "Indexed" : "Stored — no readable text found",
  });
  notifyDocuments(job.subjectId);
}

export function startUploads(
  subjectId: string,
  userId: string,
  files: File[],
  ocr: OcrFn,
) {
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
