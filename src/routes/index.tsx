import { useEffect, useMemo, useRef, useState } from "react";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/hooks/useAuth";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";

const MAX_BYTES = 30 * 1024 * 1024;

export const Route = createFileRoute("/")({
  head: () => ({
    meta: [
      { title: "Paper Vault — Your Private Document Library" },
      {
        name: "description",
        content:
          "Upload documents once and keep them forever. Paper Vault stores your PDFs, images and office files privately in the cloud, ready to download anytime.",
      },
      { property: "og:title", content: "Paper Vault — Your Private Document Library" },
      {
        property: "og:description",
        content: "Upload, store, search and download your documents from one private library.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary_large_image" },
    ],
  }),
  component: LibraryPage,
});

type DocumentRow = {
  id: string;
  name: string;
  storage_path: string;
  mime_type: string | null;
  size_bytes: number;
  created_at: string;
};

function formatSize(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function kindLabel(name: string, mime: string | null) {
  const ext = name.split(".").pop()?.toUpperCase();
  if (ext && ext.length <= 5) return ext;
  return mime?.split("/").pop()?.toUpperCase() ?? "FILE";
}

function LibraryPage() {
  const navigate = useNavigate();
  const { user, loading } = useAuth();
  const queryClient = useQueryClient();
  const inputRef = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false);
  const [search, setSearch] = useState("");
  const [uploading, setUploading] = useState(false);
  const [pendingDelete, setPendingDelete] = useState<DocumentRow | null>(null);

  useEffect(() => {
    if (!loading && !user) navigate({ to: "/auth" });
  }, [loading, user, navigate]);

  const { data: documents = [], isLoading } = useQuery({
    queryKey: ["documents", user?.id],
    enabled: !!user,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("documents")
        .select("id, name, storage_path, mime_type, size_bytes, created_at")
        .order("created_at", { ascending: false });
      if (error) throw error;
      return data as DocumentRow[];
    },
  });

  const filtered = useMemo(
    () => documents.filter((d) => d.name.toLowerCase().includes(search.trim().toLowerCase())),
    [documents, search],
  );

  const totalBytes = documents.reduce((sum, d) => sum + d.size_bytes, 0);

  const deleteMutation = useMutation({
    mutationFn: async (doc: DocumentRow) => {
      const { error: storageError } = await supabase.storage
        .from("documents")
        .remove([doc.storage_path]);
      if (storageError) throw storageError;
      const { error } = await supabase.from("documents").delete().eq("id", doc.id);
      if (error) throw error;
    },
    onSuccess: () => {
      toast.success("Document deleted");
      queryClient.invalidateQueries({ queryKey: ["documents", user?.id] });
    },
    onError: (e: unknown) => toast.error(e instanceof Error ? e.message : "Could not delete"),
  });

  async function uploadFiles(files: FileList | File[]) {
    if (!user) return;
    const list = Array.from(files);
    if (list.length === 0) return;
    setUploading(true);
    let uploaded = 0;

    for (const file of list) {
      if (file.size > MAX_BYTES) {
        toast.error(`"${file.name}" is larger than 30 MB`);
        continue;
      }
      const safeName = file.name.replace(/[^\w.\- ]+/g, "_");
      const path = `${user.id}/${crypto.randomUUID()}-${safeName}`;
      const { error: uploadError } = await supabase.storage
        .from("documents")
        .upload(path, file, { contentType: file.type || "application/octet-stream" });
      if (uploadError) {
        toast.error(`Upload failed for "${file.name}"`);
        continue;
      }
      const { error: insertError } = await supabase.from("documents").insert({
        user_id: user.id,
        name: file.name,
        storage_path: path,
        mime_type: file.type || null,
        size_bytes: file.size,
      });
      if (insertError) {
        await supabase.storage.from("documents").remove([path]);
        toast.error(`Could not save "${file.name}"`);
        continue;
      }
      uploaded += 1;
    }

    setUploading(false);
    if (uploaded > 0) {
      toast.success(`${uploaded} document${uploaded > 1 ? "s" : ""} saved`);
      queryClient.invalidateQueries({ queryKey: ["documents", user.id] });
    }
  }

  async function openDocument(doc: DocumentRow, download: boolean) {
    const { data, error } = await supabase.storage
      .from("documents")
      .createSignedUrl(doc.storage_path, 60 * 60, download ? { download: doc.name } : undefined);
    if (error || !data) {
      toast.error("Could not open this document");
      return;
    }
    window.open(data.signedUrl, "_blank", "noopener,noreferrer");
  }

  async function renameDocument(doc: DocumentRow) {
    const next = window.prompt("Rename document", doc.name);
    if (!next || next.trim() === "" || next === doc.name) return;
    const { error } = await supabase
      .from("documents")
      .update({ name: next.trim() })
      .eq("id", doc.id);
    if (error) {
      toast.error("Rename failed");
      return;
    }
    toast.success("Renamed");
    queryClient.invalidateQueries({ queryKey: ["documents", user?.id] });
  }

  if (loading || !user) {
    return (
      <main className="flex min-h-screen items-center justify-center bg-background">
        <p className="text-sm text-muted-foreground">Loading your vault…</p>
      </main>
    );
  }

  return (
    <main className="min-h-screen bg-background">
      <header className="border-b border-border">
        <div className="mx-auto flex max-w-5xl flex-wrap items-center justify-between gap-4 px-6 py-5">
          <div>
            <p className="text-xs uppercase tracking-[0.35em] text-muted-foreground">Paper Vault</p>
            <h1 className="mt-1 font-serif text-2xl text-foreground">Your documents</h1>
          </div>
          <div className="flex items-center gap-3">
            <span className="hidden text-sm text-muted-foreground sm:inline">{user.email}</span>
            <Button
              variant="outline"
              size="sm"
              onClick={async () => {
                await supabase.auth.signOut();
                navigate({ to: "/auth" });
              }}
            >
              Sign out
            </Button>
          </div>
        </div>
      </header>

      <div className="mx-auto max-w-5xl px-6 py-8">
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
          className={`rounded-2xl border-2 border-dashed p-10 text-center transition-colors ${
            dragging ? "border-primary bg-accent" : "border-border bg-card"
          }`}
        >
          <h2 className="font-serif text-xl text-foreground">Drop files to keep them forever</h2>
          <p className="mt-2 text-sm text-muted-foreground">
            PDFs, images, spreadsheets, docs and more — up to 30 MB per file.
          </p>
          <div className="mt-5">
            <Button onClick={() => inputRef.current?.click()} disabled={uploading}>
              {uploading ? "Uploading…" : "Choose files"}
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

        <div className="mt-8 flex flex-wrap items-center justify-between gap-3">
          <p className="text-sm text-muted-foreground">
            {documents.length} document{documents.length === 1 ? "" : "s"} · {formatSize(totalBytes)}{" "}
            stored
          </p>
          <Input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search by name"
            className="max-w-xs"
          />
        </div>

        <section className="mt-4 overflow-hidden rounded-2xl border border-border bg-card">
          {isLoading ? (
            <p className="p-8 text-center text-sm text-muted-foreground">Loading documents…</p>
          ) : filtered.length === 0 ? (
            <p className="p-10 text-center text-sm text-muted-foreground">
              {documents.length === 0
                ? "Nothing saved yet. Upload your first document above."
                : "No documents match your search."}
            </p>
          ) : (
            <ul className="divide-y divide-border">
              {filtered.map((doc) => (
                <li
                  key={doc.id}
                  className="flex flex-wrap items-center gap-4 px-5 py-4 transition-colors hover:bg-accent/50"
                >
                  <span className="flex h-10 w-12 shrink-0 items-center justify-center rounded-md bg-secondary text-[10px] font-semibold tracking-wide text-secondary-foreground">
                    {kindLabel(doc.name, doc.mime_type)}
                  </span>
                  <div className="min-w-0 flex-1">
                    <p className="truncate font-medium text-foreground">{doc.name}</p>
                    <p className="text-xs text-muted-foreground">
                      {formatSize(doc.size_bytes)} ·{" "}
                      {new Date(doc.created_at).toLocaleDateString(undefined, {
                        year: "numeric",
                        month: "short",
                        day: "numeric",
                      })}
                    </p>
                  </div>
                  <div className="flex flex-wrap gap-2">
                    <Button variant="ghost" size="sm" onClick={() => void openDocument(doc, false)}>
                      Preview
                    </Button>
                    <Button variant="ghost" size="sm" onClick={() => void openDocument(doc, true)}>
                      Download
                    </Button>
                    <Button variant="ghost" size="sm" onClick={() => void renameDocument(doc)}>
                      Rename
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      className="text-destructive"
                      onClick={() => setPendingDelete(doc)}
                    >
                      Delete
                    </Button>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>

      <AlertDialog open={!!pendingDelete} onOpenChange={(open) => !open && setPendingDelete(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete this document?</AlertDialogTitle>
            <AlertDialogDescription>
              "{pendingDelete?.name}" will be permanently removed from your vault.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                if (pendingDelete) deleteMutation.mutate(pendingDelete);
                setPendingDelete(null);
              }}
            >
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </main>
  );
}
