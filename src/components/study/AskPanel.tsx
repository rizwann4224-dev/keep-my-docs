import { useState, useSyncExternalStore } from "react";
import { toast } from "sonner";
import { useQuery } from "@tanstack/react-query";
import * as jobs from "@/lib/study-jobs";
import { supabase } from "@/integrations/supabase/client";
import { exportAskToPdf } from "@/lib/export-pdf";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Markdown } from "@/components/study/Markdown";
import { LessonCapture } from "@/components/study/LessonCapture";
import { ThinkingStatus } from "@/components/study/ThinkingStatus";

export function AskPanel({
  subjectId,
  subjectName = "Notebook",
}: {
  subjectId: string;
  subjectName?: string;
}) {
  const [question, setQuestion] = useState("");
  const key = `${subjectId}:ask`;

  useSyncExternalStore(jobs.subscribe, jobs.getSnapshot, jobs.getSnapshot);
  const turns = jobs.getTurns(key);
  const running = jobs.isRunning(key);

  // Earlier asks are saved to History; pull them back so the model still knows
  // what was asked before, even after a tab switch or reload.
  const { data: saved = [] } = useQuery({
    queryKey: ["ask-history", subjectId],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("qa_entries")
        .select("question, response, created_at")
        .eq("subject_id", subjectId)
        .eq("mode", "ask")
        .order("created_at", { ascending: false })
        .limit(6);
      if (error) throw error;
      return (data ?? []).reverse() as { question: string; response: string }[];
    },
  });

  function submit() {
    const q = question.trim();
    if (q.length < 2 || running) return;
    const live = turns
      .filter((t) => t.status === "done" && t.answer)
      .map((t) => ({ question: t.question, answer: t.answer }));
    const past = saved
      .filter((entry) => !live.some((t) => t.question === entry.question))
      .map((entry) => ({ question: entry.question, answer: entry.response }));
    jobs.startRun(key, { subjectId, mode: "ask", question: q, history: [...past, ...live] });
    setQuestion("");
    toast.info("Working — you can switch tabs, the answer keeps generating.");
  }




  return (
    <div className="space-y-6">
      {turns.length === 0 && (
        <div className="rounded-xl border border-border bg-card p-8 text-center">
          <h2 className="text-base font-semibold text-foreground">Ask anything about your sources</h2>
          <p className="mx-auto mt-2 max-w-md text-sm text-muted-foreground">
            You get the direct answer first — a rate, a figure, a name, a rule — then only the
            supporting detail, cited from your documents. Answers keep generating in the background
            if you move around the app.
          </p>
        </div>
      )}

      <div className="space-y-5">
        {turns.map((turn) => (
          <div key={turn.id} className="space-y-3">
            <p className="ml-auto w-fit max-w-[85%] rounded-2xl rounded-br-sm bg-primary px-4 py-2 text-sm text-primary-foreground">
              {turn.question}
            </p>
            <div className="rounded-xl border border-border bg-card p-5">
              {turn.answer ? (
                <Markdown>{turn.answer}</Markdown>
              ) : turn.status === "error" ? null : (
                <ThinkingStatus />
              )}
              {turn.status === "streaming" && turn.answer && (
                <span className="ml-0.5 inline-block h-4 w-1.5 animate-pulse bg-foreground align-text-bottom" />
              )}
              {turn.status === "error" && (
                <p className="text-sm text-destructive">{turn.error ?? "Something went wrong"}</p>
              )}
              {turn.status === "done" && <LessonCapture subjectId={subjectId} />}
            </div>
          </div>
        ))}
      </div>

      {turns.length > 0 && !running && (
        <div className="flex justify-end">
          <Button variant="ghost" size="sm" onClick={() => jobs.clear(key)}>
            Clear thread
          </Button>
        </div>
      )}

      <div className="sticky bottom-4 rounded-xl border border-border bg-card p-3 shadow-sm">
        <Textarea
          value={question}
          onChange={(e) => setQuestion(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              submit();
            }
          }}
          placeholder="e.g. What is the tax rate for a small company?  (Enter to send, Shift+Enter for a new line)"
          className="min-h-20 resize-none border-0 focus-visible:ring-0"
        />
        <div className="flex justify-end">
          <Button onClick={submit} disabled={running || question.trim().length < 2}>
            {running ? "Thinking…" : "Ask"}
          </Button>
        </div>
      </div>
    </div>
  );
}
