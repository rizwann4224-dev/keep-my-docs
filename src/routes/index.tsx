import { useEffect, useState } from "react";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/hooks/useAuth";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { SettingsDialog } from "@/components/study/SettingsDialog";
import { DocumentsPanel } from "@/components/study/DocumentsPanel";
import { AskPanel } from "@/components/study/AskPanel";
import { MarkPanel } from "@/components/study/MarkPanel";
import { LessonsPanel } from "@/components/study/LessonsPanel";
import { HistoryPanel } from "@/components/study/HistoryPanel";

export const Route = createFileRoute("/")({
  head: () => ({
    meta: [
      { title: "Study Desk — Notebooks for Source-Grounded Exam Answers" },
      {
        name: "description",
        content:
          "Create a notebook per subject, upload your material, get precise answers from your own documents and examiner-style marking exactly as you want it.",
      },
      { property: "og:title", content: "Study Desk — Notebooks for Source-Grounded Exam Answers" },
      {
        property: "og:description",
        content:
          "Private notebooks: your sources, precise document-grounded answers and flexible exam marking.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary_large_image" },
    ],
  }),
  component: WorkspacePage,
});

type Subject = { id: string; name: string; created_at: string };

function WorkspacePage() {
  const navigate = useNavigate();
  const { user, loading } = useAuth();
  const queryClient = useQueryClient();
  const [openNotebook, setOpenNotebook] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [newSubject, setNewSubject] = useState("");

  useEffect(() => {
    if (!loading && !user) navigate({ to: "/auth" });
  }, [loading, user, navigate]);

  const { data: subjects = [] } = useQuery({
    queryKey: ["subjects", user?.id],
    enabled: !!user,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("subjects")
        .select("id, name, created_at")
        .order("created_at", { ascending: false });
      if (error) throw error;
      return data as Subject[];
    },
  });

  const { data: counts = {} } = useQuery({
    queryKey: ["subject-doc-counts", user?.id],
    enabled: !!user,
    queryFn: async () => {
      const { data, error } = await supabase.from("documents").select("subject_id");
      if (error) throw error;
      const map: Record<string, number> = {};
      for (const row of data as { subject_id: string | null }[]) {
        if (row.subject_id) map[row.subject_id] = (map[row.subject_id] ?? 0) + 1;
      }
      return map;
    },
  });

  const createSubject = useMutation({
    mutationFn: async (name: string) => {
      if (!user) throw new Error("Not signed in");
      const { data, error } = await supabase
        .from("subjects")
        .insert({ user_id: user.id, name })
        .select("id, name, created_at")
        .single();
      if (error) throw error;
      return data as Subject;
    },
    onSuccess: (subject) => {
      setNewSubject("");
      setCreating(false);
      setOpenNotebook(subject.id);
      queryClient.invalidateQueries({ queryKey: ["subjects", user?.id] });
    },
    onError: () => toast.error("Could not create this notebook"),
  });

  const deleteSubject = useMutation({
    mutationFn: async (id: string) => {
      const { error } = await supabase.from("subjects").delete().eq("id", id);
      if (error) throw error;
    },
    onSuccess: () => {
      toast.success("Notebook deleted");
      setOpenNotebook(null);
      queryClient.invalidateQueries({ queryKey: ["subjects", user?.id] });
    },
  });

  if (loading || !user) {
    return (
      <main className="flex min-h-screen items-center justify-center bg-background">
        <p className="text-sm text-muted-foreground">Loading your notebooks…</p>
      </main>
    );
  }

  const active = subjects.find((s) => s.id === openNotebook) ?? null;

  return (
    <main className="min-h-screen bg-background">
      <header className="border-b border-border bg-card">
        <div className="mx-auto flex max-w-6xl flex-wrap items-center justify-between gap-4 px-6 py-4">
          <button
            type="button"
            onClick={() => setOpenNotebook(null)}
            className="text-left"
          >
            <p className="text-[11px] font-semibold uppercase tracking-[0.2em] text-primary">
              Study Desk
            </p>
            <h1 className="mt-0.5 text-lg font-semibold text-foreground">
              {active ? active.name : "Your notebooks"}
            </h1>
          </button>
          <div className="flex items-center gap-2">
            <span className="hidden text-sm text-muted-foreground sm:inline">{user.email}</span>
            <Button asChild variant="outline" size="sm">
              <Link to="/icap">ICAP exam tool</Link>
            </Button>
            <SettingsDialog />
            <Button
              variant="ghost"
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

      <div className="mx-auto max-w-6xl px-6 py-8">
        {!active ? (
          <>
            <div className="flex flex-wrap items-end justify-between gap-4">
              <div>
                <h2 className="text-2xl font-semibold text-foreground">Notebooks</h2>
                <p className="mt-1 text-sm text-muted-foreground">
                  One notebook per subject — its own sources, questions and lessons learned.
                </p>
              </div>
            </div>

            <div className="mt-6 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
              <div className="rounded-xl border-2 border-dashed border-border bg-card p-5">
                {creating ? (
                  <form
                    onSubmit={(e) => {
                      e.preventDefault();
                      if (newSubject.trim()) createSubject.mutate(newSubject.trim());
                    }}
                    className="space-y-3"
                  >
                    <Input
                      autoFocus
                      value={newSubject}
                      onChange={(e) => setNewSubject(e.target.value)}
                      placeholder="e.g. Audit & Assurance"
                    />
                    <div className="flex gap-2">
                      <Button type="submit" size="sm" disabled={!newSubject.trim()}>
                        Create
                      </Button>
                      <Button
                        type="button"
                        size="sm"
                        variant="ghost"
                        onClick={() => setCreating(false)}
                      >
                        Cancel
                      </Button>
                    </div>
                  </form>
                ) : (
                  <button
                    type="button"
                    onClick={() => setCreating(true)}
                    className="flex h-full w-full flex-col items-center justify-center gap-2 py-6 text-center"
                  >
                    <span className="flex h-10 w-10 items-center justify-center rounded-full bg-primary text-xl leading-none text-primary-foreground">
                      +
                    </span>
                    <span className="text-sm font-medium text-foreground">New notebook</span>
                    <span className="text-xs text-muted-foreground">
                      Start a new subject workspace
                    </span>
                  </button>
                )}
              </div>

              {subjects.map((subject) => (
                <div
                  key={subject.id}
                  className="group relative rounded-xl border border-border bg-card p-5 transition-shadow hover:shadow-md"
                >
                  <button
                    type="button"
                    onClick={() => setOpenNotebook(subject.id)}
                    className="block w-full text-left"
                  >
                    <span className="text-2xl">📓</span>
                    <h3 className="mt-3 truncate text-base font-semibold text-foreground">
                      {subject.name}
                    </h3>
                    <p className="mt-1 text-xs text-muted-foreground">
                      {counts[subject.id] ?? 0} source{(counts[subject.id] ?? 0) === 1 ? "" : "s"} ·{" "}
                      {new Date(subject.created_at).toLocaleDateString(undefined, {
                        year: "numeric",
                        month: "short",
                        day: "numeric",
                      })}
                    </p>
                  </button>
                  <button
                    type="button"
                    aria-label={`Delete ${subject.name}`}
                    onClick={() => {
                      if (window.confirm(`Delete "${subject.name}" and everything in it?`)) {
                        deleteSubject.mutate(subject.id);
                      }
                    }}
                    className="absolute right-3 top-3 rounded px-2 text-muted-foreground opacity-0 transition-opacity hover:text-destructive group-hover:opacity-100"
                  >
                    ×
                  </button>
                </div>
              ))}
            </div>
          </>
        ) : (
          <>
            <Button variant="ghost" size="sm" onClick={() => setOpenNotebook(null)}>
              ← All notebooks
            </Button>
            <Tabs defaultValue="ask" className="mt-4">
              <TabsList>
                <TabsTrigger value="ask">Ask</TabsTrigger>
                <TabsTrigger value="mark">Answer &amp; marking</TabsTrigger>
                <TabsTrigger value="documents">Sources</TabsTrigger>
                <TabsTrigger value="lessons">Lessons learned</TabsTrigger>
                <TabsTrigger value="history">History</TabsTrigger>
              </TabsList>
              <div className="mt-6">
                <TabsContent value="ask">
                  <AskPanel subjectId={active.id} />
                </TabsContent>
                <TabsContent value="mark">
                  <MarkPanel subjectId={active.id} />
                </TabsContent>
                <TabsContent value="documents">
                  <DocumentsPanel subjectId={active.id} userId={user.id} />
                </TabsContent>
                <TabsContent value="lessons">
                  <LessonsPanel subjectId={active.id} />
                </TabsContent>
                <TabsContent value="history">
                  <HistoryPanel subjectId={active.id} />
                </TabsContent>
              </div>
            </Tabs>
          </>
        )}
      </div>
    </main>
  );
}
