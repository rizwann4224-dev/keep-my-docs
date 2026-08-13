import { useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { toast } from "sonner";
import { supabase } from "@/integrations/supabase/client";
import { extractText } from "@/lib/extract-text";
import { uploadWithProgress, formatSpeed } from "@/lib/upload";
import { Progress } from "@/components/ui/progress";
import { transcribePages } from "@/lib/study.functions";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";

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

type UploadState = {
  name: string;
  size: number;
  percent: number;
  speed: string;
  stage: string;
};

export function DocumentsPanel({ subjectId, userId }: { subjectId: string; userId: string }) {
  const queryClient = useQueryClient();
  const ocrCall = useServerFn(transcribePages);
  const inputRef = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [uploads, setUploads] = useState<UploadState[]>([]);
  const [search, setSearch] = useState("");

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

  function setUpload(name: string, patch: Partial<UploadState>) {
    setUploads((prev) =>
      prev.map((u) => (u.name === name ? { ...u, ...patch } : u)),
    );
  }

  async function uploadOne(file: File): Promise<boolean> {
    const safeName = file.name.replace(/[^\w.\- ]+/g, "_");
    const path = `${userId}/${crypto.randomUUID()}-${safeName}`;

    // Upload and text extraction run at the same time — the network transfer no
    // longer waits for parsing/OCR to finish.
    const uploadTask = uploadWithProgress("documents", path, file, (p) =>
      setUpload(file.name, {
        percent: p.percent,
        speed: formatSpeed(p.bytesPerSecond),
        stage: p.percent >= 100 ? "Processing…" : "Uploading",
      }),
    );
    const extractTask = extractText(
      file,
      async (images) => (await ocrCall({ data: { images } })).text,
      (message) => setUpload(file.name, { stage: message }),
    );

    let text = "";
    try {
      [, text] = await Promise.all([uploadTask, extractTask]);
    } catch (error) {
      await extractTask.catch(() => "");
      toast.error(
        `Upload failed for "${file.name}"${error instanceof Error ? `: ${error.message}` : ""}`,
      );
      return false;
    }

    const { error: insertError } = await supabase.from("documents").insert({
      user_id: userId,
      subject_id: subjectId,
      name: file.name,
      storage_path: path,
      mime_type: file.type || null,
      size_bytes: file.size,
      extracted_text: text || null,
    });
    if (insertError) {
      await supabase.storage.from("documents").remove([path]);
      toast.error(`Could not save "${file.name}"`);
      return false;
    }
    if (!text) toast.warning(`"${file.name}" stored, but no readable text was found in it.`);
    return true;
  }

  async function uploadFiles(files: FileList | File[]) {
    const list = Array.from(files);
    if (list.length === 0) return;

    setUploads(
      list.map((f) => ({ name: f.name, percent: 0, speed: "", stage: "Queued", size: f.size })),
    );
    setBusy(`Uploading ${list.length} file${list.length > 1 ? "s" : ""}…`);

    // Files upload in parallel instead of one after another.
    const results = await Promise.all(list.map((file) => uploadOne(file)));
    const saved = results.filter(Boolean).length;

    setBusy(null);
    setUploads([]);
    if (saved > 0) {
      toast.success(`${saved} source${saved > 1 ? "s" : ""} added`);
      queryClient.invalidateQueries({ queryKey: ["documents", subjectId] });
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

  const filtered = documents.filter((d) =>
    d.name.toLowerCase().includes(search.trim().toLowerCase()),
  );

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
          void uploadFiles(e.dataTransfer.files);
        }}
        className={`rounded-xl border-2 border-dashed p-8 text-center transition-colors ${
          dragging ? "border-primary bg-accent" : "border-border bg-card"
        }`}
      >
        <h2 className="text-base font-semibold text-foreground">Add sources</h2>
        <p className="mx-auto mt-2 max-w-lg text-sm text-muted-foreground">
          PDF, DOCX, TXT, Markdown and images. Scanned PDFs without a text layer are read with OCR
          automatically. No size limit.
        </p>
        <div className="mt-4">
          <Button onClick={() => inputRef.current?.click()} disabled={!!busy}>
            {busy ?? "Choose files"}
          </Button>
        </div>
        <input
          ref={inputRef}
          type="file"
          multiple
          className="hidden"
          onChange={(e) => {
            if (e.target.files) void uploadFiles(e.target.files);
            e.target.value = "";
          }}
        />
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
            {filtered.map((doc) => (
              <li key={doc.id} className="flex flex-wrap items-center gap-3 px-4 py-3">
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium text-foreground">{doc.name}</p>
                  <p className="mt-0.5 flex items-center gap-2 text-xs text-muted-foreground">
                    {formatSize(doc.size_bytes)} ·{" "}
                    {new Date(doc.created_at).toLocaleDateString(undefined, {
                      year: "numeric",
                      month: "short",
                      day: "numeric",
                    })}
                    {doc.extracted_text ? (
                      <Badge variant="secondary">Indexed</Badge>
                    ) : (
                      <Badge variant="outline">No text</Badge>
                    )}
                  </p>
                </div>
                <div className="flex gap-1">
                  <Button variant="ghost" size="sm" onClick={() => void openDocument(doc, false)}>
                    Preview
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
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
