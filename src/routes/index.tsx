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
      { title: "Study Desk — Source-Grounded Answers & Exam Marking" },
      {
        name: "description",
        content:
          "Upload your subject material, ask questions answered from your own documents, and get strict examiner-style marking with model answers and recommendations.",
      },
      { property: "og:title", content: "Study Desk — Source-Grounded Answers & Exam Marking" },
      {
        property: "og:description",
        content:
          "A private study workspace: subject tabs, document-grounded answers and item-by-item exam marking.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary_large_image" },
    ],
  }),
  component: WorkspacePage,
});

type Subject = { id: string; name: string };

function WorkspacePage() {
  const navigate = useNavigate();
  const { user, loading } = useAuth();
  const queryClient = useQueryClient();
  const [activeSubject, setActiveSubject] = useState<string | null>(null);
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
        .select("id, name")
        .order("created_at", { ascending: true });
      if (error) throw error;
      return data as Subject[];
    },
  });

  useEffect(() => {
    if (!activeSubject && subjects.length > 0) setActiveSubject(subjects[0]!.id);
    if (activeSubject && !subjects.some((s) => s.id === activeSubject)) {
      setActiveSubject(subjects[0]?.id ?? null);
    }
  }, [subjects, activeSubject]);

  const createSubject = useMutation({
    mutationFn: async (name: string) => {
      if (!user) throw new Error("Not signed in");
      const { data, error } = await supabase
        .from("subjects")
        .insert({ user_id: user.id, name })
        .select("id, name")
        .single();
      if (error) throw error;
      return data as Subject;
    },
    onSuccess: (subject) => {
      setNewSubject("");
      setActiveSubject(subject.id);
      queryClient.invalidateQueries({ queryKey: ["subjects", user?.id] });
    },
    onError: () => toast.error("Could not create this subject"),
  });

  const deleteSubject = useMutation({
    mutationFn: async (id: string) => {
      const { error } = await supabase.from("subjects").delete().eq("id", id);
      if (error) throw error;
    },
    onSuccess: () => {
      toast.success("Subject removed");
      queryClient.invalidateQueries({ queryKey: ["subjects", user?.id] });
    },
  });

  if (loading || !user) {
    return (
      <main className="flex min-h-screen items-center justify-center bg-background">
        <p className="text-sm text-muted-foreground">Loading your study desk…</p>
      </main>
    );
  }

  return (
    <main className="min-h-screen bg-background">
      <header className="border-b border-border bg-card">
        <div className="mx-auto flex max-w-6xl flex-wrap items-center justify-between gap-4 px-6 py-4">
          <div>
            <p className="text-[11px] font-semibold uppercase tracking-[0.2em] text-primary">
              Study Desk
            </p>
            <h1 className="mt-0.5 text-lg font-semibold text-foreground">
              Source-grounded answers &amp; examiner marking
            </h1>
          </div>
          <div className="flex items-center gap-2">
            <span className="hidden text-sm text-muted-foreground sm:inline">{user.email}</span>
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

      <div className="mx-auto max-w-6xl px-6 py-6">
        <div className="flex flex-wrap items-center gap-2 border-b border-border pb-4">
          {subjects.map((subject) => (
            <button
              key={subject.id}
              type="button"
              onClick={() => setActiveSubject(subject.id)}
              className={`group flex items-center gap-2 rounded-md border px-3 py-1.5 text-sm transition-colors ${
                activeSubject === subject.id
                  ? "border-primary bg-primary text-primary-foreground"
                  : "border-border bg-card text-foreground hover:bg-muted"
              }`}
            >
              {subject.name}
              <span
                role="button"
                tabIndex={0}
                aria-label={`Delete ${subject.name}`}
                onClick={(e) => {
                  e.stopPropagation();
                  if (window.confirm(`Delete "${subject.name}" and its questions?`)) {
                    deleteSubject.mutate(subject.id);
                  }
                }}
                onKeyDown={(e) => e.stopPropagation()}
                className="opacity-40 transition-opacity hover:opacity-100"
              >
                ×
              </span>
            </button>
          ))}
          <form
            className="flex items-center gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              if (newSubject.trim()) createSubject.mutate(newSubject.trim());
            }}
          >
            <Input
              value={newSubject}
              onChange={(e) => setNewSubject(e.target.value)}
              placeholder="New subject"
              className="h-9 w-40"
            />
            <Button type="submit" size="sm" variant="outline" disabled={!newSubject.trim()}>
              Add
            </Button>
          </form>
        </div>

        {!activeSubject ? (
          <div className="mt-16 text-center">
            <h2 className="text-lg font-semibold text-foreground">Create your first subject</h2>
            <p className="mx-auto mt-2 max-w-md text-sm text-muted-foreground">
              Each subject keeps its own documents, questions and lessons learned — for example
              "Audit &amp; Assurance" or "Financial Reporting".
            </p>
          </div>
        ) : (
          <Tabs defaultValue="ask" className="mt-6">
            <TabsList>
              <TabsTrigger value="ask">Ask</TabsTrigger>
              <TabsTrigger value="mark">Mark &amp; evaluate</TabsTrigger>
              <TabsTrigger value="documents">Sources</TabsTrigger>
              <TabsTrigger value="lessons">Lessons learned</TabsTrigger>
              <TabsTrigger value="history">History</TabsTrigger>
            </TabsList>
            <div className="mt-6">
              <TabsContent value="ask">
                <AskPanel subjectId={activeSubject} />
              </TabsContent>
              <TabsContent value="mark">
                <MarkPanel subjectId={activeSubject} />
              </TabsContent>
              <TabsContent value="documents">
                <DocumentsPanel subjectId={activeSubject} userId={user.id} />
              </TabsContent>
              <TabsContent value="lessons">
                <LessonsPanel subjectId={activeSubject} />
              </TabsContent>
              <TabsContent value="history">
                <HistoryPanel subjectId={activeSubject} />
              </TabsContent>
            </div>
          </Tabs>
        )}
      </div>
    </main>
  );
}
