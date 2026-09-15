import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { toast } from "sonner";
import { supabase } from "@/integrations/supabase/client";
import * as uploadJobs from "@/lib/upload-jobs";
import { extractDocument, PAGE_MARKER } from "@/lib/extract-text";
import { Progress } from "@/components/ui/progress";
import { transcribePages } from "@/lib/study.functions";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Textarea } from "@/components/ui/textarea";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

export type DocumentRow = {
  id: string;
  name: string;
  storage_path: string;
  mime_type: string | null;
  size_bytes: number;
  created_at: string;
  extracted_text: string | null;
};

function formatSize(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function DocumentsPanel({ subjectId, userId }: { subjectId: string; userId: string }) {
  const queryClient = useQueryClient();
  const ocrCall = useServerFn(transcribePages);
  const inputRef = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false);
  const [search, setSearch] = useState("");
  const [reindexing, setReindexing] = useState<Record<string, string>>({});
  const [reviewing, setReviewing] = useState<DocumentRow | null>(null);
  const [reviewText, setReviewText] = useState("");
  const [reviewSaving, setReviewSaving] = useState(false);

  const runOcr = useMemo(
    () =>
      async (images: string[]): Promise<string> => {
        const result = await ocrCall({ data: { images } });
        return result.text;
      },
    [ocrCall],
  );

  useSyncExternalStore(uploadJobs.subscribe, uploadJobs.getJobs, uploadJobs.getJobs);
  const uploads = uploadJobs.jobsFor(subjectId);
  const busy = uploads.some((u) => u.status === "active");

  const { data: documents = [], isLoading } = useQuery({
    queryKey: ["documents", subjectId],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("documents")
        .select("id, name, storage_path, mime_type, size_bytes, created_at, extracted_text")
        .eq("subject_id", subjectId)
        .order("created_at", { ascending: false });
      if (error) throw error;
      return data as DocumentRow[];
    },
  });

  // Uploads finish in the background store; refresh the list whenever one lands.
  useEffect(() => {
    function onChanged(event: Event) {
      if ((event as CustomEvent<string>).detail === subjectId) {
        queryClient.invalidateQueries({ queryKey: ["documents", subjectId] });
        queryClient.invalidateQueries({ queryKey: ["subject-doc-counts"] });
      }
    }
    window.addEventListener("documents-changed", onChanged);
    return () => window.removeEventListener("documents-changed", onChanged);
  }, [subjectId, queryClient]);

  const remove = useMutation({
    mutationFn: async (doc: DocumentRow) => {
      await supabase.storage.from("documents").remove([doc.storage_path]);
      const { error } = await supabase.from("documents").delete().eq("id", doc.id);
      if (error) throw error;
    },
    onSuccess: () => {
      toast.success("Source removed");
      queryClient.invalidateQueries({ queryKey: ["documents", subjectId] });
    },
    onError: () => toast.error("Could not delete this document"),
  });

  function startUpload(files: FileList | File[]) {
    const list = Array.from(files);
    if (list.length === 0) return;
    uploadJobs.startUploads(subjectId, userId, list, runOcr);
  }

  /** Re-extract a stored document in place — useful after indexing fixes, when a
   *  long PDF was truncated, or when a page came back unreadable. Downloads the
   *  file, runs the same extract + OCR path as a fresh upload, and overwrites only
   *  `extracted_text`; the uploaded file in storage is never touched. */
  async function reindex(doc: DocumentRow) {
    setReindexing((m) => ({ ...m, [doc.id]: "Fetching file…" }));
    try {
      const { data, error } = await supabase.storage
        .from("documents")
        .createSignedUrl(doc.storage_path, 3600);
      if (error || !data) throw new Error("Could not read this file");

      const res = await fetch(data.signedUrl);
      if (!res.ok) throw new Error("Could not download this file");
      const blob = await res.blob();
      const file = new File([blob], doc.name, {
        type: doc.mime_type || blob.type || "application/octet-stream",
      });

      const result = await extractDocument(file, runOcr, (message) =>
        setReindexing((m) => ({ ...m, [doc.id]: message })),
      );

      const { error: updateError } = await supabase
        .from("documents")
        .update({ extracted_text: result.text || null })
        .eq("id", doc.id);
      if (updateError) throw updateError;

      if (result.failedPages.length > 0) {
        toast.error(
          `Page${result.failedPages.length === 1 ? "" : "s"} ${result.failedPages
            .map((f) => f.page)
            .join(", ")} could not be read — saved as marked. Use Review text to fix it.`,
        );
      } else if (!result.text) {
        toast.error("No readable text found — nothing was indexed.");
      } else {
        toast.success(
          result.truncated
            ? "Re-indexed (truncated at the size limit)"
            : "Re-indexed with full text",
        );
      }
      queryClient.invalidateQueries({ queryKey: ["documents", subjectId] });
      queryClient.invalidateQueries({ queryKey: ["subject-doc-counts"] });
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Re-index failed");
    } finally {
      setReindexing((m) => {
        const next = { ...m };
        delete next[doc.id];
        return next;
      });
    }
  }

  async function openDocument(doc: DocumentRow, download: boolean) {
    const { data, error } = await supabase.storage
      .from("documents")
      .createSignedUrl(doc.storage_path, 3600, download ? { download: doc.name } : undefined);
    if (error || !data) {
      toast.error("Could not open this document");
      return;
    }
    window.open(data.signedUrl, "_blank", "noopener,noreferrer");
  }

  function openReview(doc: DocumentRow) {
    setReviewing(doc);
    setReviewText(doc.extracted_text ?? "");
  }

  /** Saves corrections to `documents.extracted_text` only — the uploaded file,
   *  its storage object and its name are left exactly as they were. */
  async function saveReview() {
    if (!reviewing) return;
    setReviewSaving(true);
    try {
      const { error } = await supabase
        .from("documents")
        .update({ extracted_text: reviewText.trim() || null })
        .eq("id", reviewing.id);
      if (error) throw error;
      toast.success("Extracted text saved — the original file is unchanged");
      queryClient.invalidateQueries({ queryKey: ["documents", subjectId] });
      setReviewing(null);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Could not save the text");
    } finally {
      setReviewSaving(false);
    }
  }

  const filtered = documents.filter((d) =>
    d.name.toLowerCase().includes(search.trim().toLowerCase()),
  );

  const reviewPages = reviewing ? uploadJobs.unreadablePagesIn(reviewing.extracted_text) : [];

  return (
    <div className="space-y-6">
      <section
        onDragOver={(e) => {
          e.preventDefault();
          setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDragging(false);
          startUpload(e.dataTransfer.files);
        }}
        className={`rounded-xl border-2 border-dashed p-8 text-center transition-colors ${
          dragging ? "border-primary bg-accent" : "border-border bg-card"
        }`}
      >
        <h2 className="text-base font-semibold text-foreground">Add sources</h2>
        <p className="mx-auto mt-2 max-w-lg text-sm text-muted-foreground">
          PDF, DOCX, TXT, Markdown and images. Scanned pages are rendered at 3× and read one page at
          a time, so every page keeps its own [Page N] marker. No size limit and no page cutoff —
          uploads keep running while you use the rest of the notebook.
        </p>
        <div className="mt-4">
          <Button onClick={() => inputRef.current?.click()}>
            {busy ? "Add more files" : "Choose files"}
          </Button>
        </div>
        <input
          ref={inputRef}
          type="file"
          multiple
          className="hidden"
          onChange={(e) => {
            if (e.target.files) startUpload(e.target.files);
            e.target.value = "";
          }}
        />
        {uploads.length > 0 && (
          <ul className="mx-auto mt-6 max-w-lg space-y-3 text-left">
            {uploads.map((u) => (
              <li key={u.id} className="rounded-lg border border-border bg-background p-3">
                <div className="flex items-center justify-between gap-3">
                  <span className="truncate text-sm font-medium text-foreground">{u.name}</span>
                  <span className="shrink-0 text-xs tabular-nums text-muted-foreground">
                    {u.status === "done"
                      ? "Done"
                      : `${u.percent}%${u.speed ? ` · ${u.speed}` : ""}`}
                  </span>
                </div>
                <Progress value={u.percent} className="mt-2 h-1.5" />
                <p
                  className={`mt-1.5 text-xs ${
                    u.status === "error" ? "text-destructive" : "text-muted-foreground"
                  }`}
                >
                  {u.stage} · {formatSize(u.size)}
                </p>
                {u.unreadablePages?.length ? (
                  <p className="mt-1 text-xs text-destructive">
                    Unreadable page{u.unreadablePages.length === 1 ? "" : "s"}:{" "}
                    {u.unreadablePages.join(", ")} — marked as [unreadable], never guessed.
                  </p>
                ) : null}
              </li>
            ))}
          </ul>
        )}
        {uploads.length > 0 && !busy && (
          <Button
            variant="ghost"
            size="sm"
            className="mt-3"
            onClick={() => uploadJobs.clearFinished(subjectId)}
          >
            Clear finished
          </Button>
        )}
      </section>

      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-sm text-muted-foreground">
          {documents.length} source{documents.length === 1 ? "" : "s"} in this notebook
        </p>
        <Input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search sources"
          className="max-w-xs"
        />
      </div>

      <div className="overflow-hidden rounded-xl border border-border bg-card">
        {isLoading ? (
          <p className="p-8 text-center text-sm text-muted-foreground">Loading sources…</p>
        ) : filtered.length === 0 ? (
          <p className="p-10 text-center text-sm text-muted-foreground">
            No sources yet. Upload the study material for this notebook above.
          </p>
        ) : (
          <ul className="divide-y divide-border">
            {filtered.map((doc) => {
              const unreadable = uploadJobs.unreadablePagesIn(doc.extracted_text);
              const hasText = Boolean(doc.extracted_text?.trim());
              return (
                <li key={doc.id} className="flex flex-wrap items-center gap-3 px-4 py-3">
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-medium text-foreground">{doc.name}</p>
                    <p className="mt-0.5 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                      {formatSize(doc.size_bytes)} ·{" "}
                      {new Date(doc.created_at).toLocaleDateString(undefined, {
                        year: "numeric",
                        month: "short",
                        day: "numeric",
                      })}
                      {unreadable.length > 0 ? (
                        <Badge variant="destructive">
                          {unreadable.length} unreadable page{unreadable.length === 1 ? "" : "s"}
                        </Badge>
                      ) : hasText ? (
                        <Badge variant="secondary">Indexed</Badge>
                      ) : (
                        <Badge variant="outline">No text</Badge>
                      )}
                    </p>
                    {reindexing[doc.id] && (
                      <p className="mt-0.5 truncate text-xs text-primary">{reindexing[doc.id]}</p>
                    )}
                  </div>
                  <div className="flex flex-wrap gap-1">
                    <Button variant="ghost" size="sm" onClick={() => void openDocument(doc, false)}>
                      Preview
                    </Button>
                    <Button variant="ghost" size="sm" onClick={() => openReview(doc)}>
                      Review text
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      disabled={Boolean(reindexing[doc.id])}
                      onClick={() => void reindex(doc)}
                    >
                      {reindexing[doc.id] ? "Re-indexing…" : "Re-index"}
                    </Button>
                    <Button variant="ghost" size="sm" onClick={() => void openDocument(doc, true)}>
                      Download
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      className="text-destructive"
                      onClick={() => remove.mutate(doc)}
                    >
                      Delete
                    </Button>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </div>

      <Dialog open={reviewing !== null} onOpenChange={(open) => !open && setReviewing(null)}>
        <DialogContent className="max-w-4xl">
          <DialogHeader>
            <DialogTitle>Review extracted text</DialogTitle>
            <DialogDescription>
              {reviewing?.name} — fix anything the extraction got wrong. Saving writes only the
              extracted text used for search and marking; the uploaded file itself is never
              modified. Keep each page under its own {PAGE_MARKER(1)} marker so quotes stay
              traceable.
            </DialogDescription>
          </DialogHeader>

          {reviewPages.length > 0 && (
            <p className="rounded-lg border border-destructive/40 bg-destructive/5 p-3 text-xs text-destructive">
              Page{reviewPages.length === 1 ? "" : "s"} {reviewPages.join(", ")} were marked
              unreadable. Read them off the preview above and type them here — never estimate a
              figure you cannot see.
            </p>
          )}

          <Textarea
            value={reviewText}
            onChange={(e) => setReviewText(e.target.value)}
            className="min-h-[420px] font-mono text-xs"
            placeholder="No text has been extracted from this file yet. Paste the text here to make it searchable."
          />

          <div className="flex items-center justify-between text-xs text-muted-foreground">
            <span>{reviewText.length.toLocaleString()} characters</span>
            <span>Original file untouched · storage path unchanged</span>
          </div>

          <DialogFooter>
            <Button variant="ghost" onClick={() => setReviewing(null)}>
              Cancel
            </Button>
            <Button onClick={() => void saveReview()} disabled={reviewSaving}>
              {reviewSaving ? "Saving…" : "Save text"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
