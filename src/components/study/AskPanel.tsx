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
  const [tab, setTab] = useState<"general" | "question">("general");
  const [question, setQuestion] = useState("");
  const [answerLength, setAnswerLength] = useState<"short" | "medium" | "long">("medium");
  const isExam = tab === "question";
  const key = `${subjectId}:${isExam ? "exam" : "ask"}`;

  useSyncExternalStore(jobs.subscribe, jobs.getSnapshot, jobs.getSnapshot);
  const turns = jobs.getTurns(key);
  const running = jobs.isRunning(key);

  // Earlier asks are saved to History; pull them back so the model still knows
  // what was asked before, even after a tab switch or reload.
  const { data: saved = [] } = useQuery({
    queryKey: ["ask-history", subjectId, isExam ? "exam" : "ask"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("qa_entries")
        .select("question, response, created_at")
        .eq("subject_id", subjectId)
        .eq("mode", isExam ? "exam" : "ask")
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
    // The selected answer length rides along as an instruction so the model
    // honours it, while the on-screen bubble keeps the clean question.
    const directive =
      !isExam && answerLength === "short"
        ? "\n\n[Answer format: VERY SHORT — the direct answer only in 1–3 lines. No headings, no extra explanation.]"
        : !isExam && answerLength === "long"
          ? "\n\n[Answer format: LONG — a thorough answer with full explanation, structure, and references to the sources. Still lead with the direct answer.]"
          : "";
    jobs.startRun(
      key,
      {
        subjectId,
        mode: isExam ? "exam" : "ask",
        question: q + directive,
        history: [...past, ...live],
      },
      q,
    );
    setQuestion("");
    toast.info("Working — you can switch tabs, the answer keeps generating.");
  }

  return (
    <div className="space-y-6">
      {/* Mode switch: full-width toggle buttons with an explicit on/off state. */}
      <div className="grid grid-cols-1 gap-2 rounded-xl border border-border bg-muted p-1.5 sm:grid-cols-2">
        {([
          { id: "general", label: "General query" },
          { id: "question", label: "Question (exam setter)" },
        ] as const).map((option) => {
          const active = tab === option.id;
          return (
            <button
              key={option.id}
              type="button"
              aria-pressed={active}
              onClick={() => setTab(option.id)}
              className={`flex w-full items-center justify-center gap-2.5 rounded-lg px-6 py-3 text-sm font-semibold transition-colors ${
                active
                  ? "bg-primary text-primary-foreground shadow-sm"
                  : "text-muted-foreground hover:bg-background/70 hover:text-foreground"
              }`}
            >
              <span
                aria-hidden
                className={`h-2.5 w-2.5 shrink-0 rounded-full border transition-colors ${
                  active
                    ? "border-primary-foreground bg-primary-foreground"
                    : "border-muted-foreground/60 bg-transparent"
                }`}
              />
              {option.label}
            </button>
          );
        })}
      </div>

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
        <div className="flex justify-end gap-2">
          <Button
            variant="outline"
            size="sm"
            onClick={() => {
              try {
                exportAskToPdf({
                  notebook: subjectName,
                  title: isExam ? "Exam paper" : "Ask session",
                  // Exam papers export the questions only — not the brief typed in.
                  showPrompts: !isExam,
                  turns: turns
                    .filter((t) => t.answer)
                    .map((t) => ({ question: t.question, answer: t.answer })),
                });
              } catch {
                toast.error("Could not build the PDF");
              }
            }}
          >
            Export to PDF
          </Button>
          <Button variant="ghost" size="sm" onClick={() => jobs.clear(key)}>
            Clear thread
          </Button>
        </div>
      )}

      <div className="sticky bottom-4 rounded-xl border border-border bg-card p-3 shadow-sm">
        {!isExam && (
          <div className="mb-2 flex items-center gap-2 px-1">
            <span className="text-xs text-muted-foreground">Answer length:</span>
            <div className="inline-flex rounded-md border border-border bg-muted p-0.5">
              {([
                { id: "short", label: "Short (1–3 lines)" },
                { id: "medium", label: "Medium" },
                { id: "long", label: "Long + explanation" },
              ] as const).map((option) => (
                <button
                  key={option.id}
                  type="button"
                  onClick={() => setAnswerLength(option.id)}
                  className={`rounded px-2.5 py-1 text-xs font-medium transition-colors ${
                    answerLength === option.id
                      ? "bg-background text-foreground shadow-sm"
                      : "text-muted-foreground hover:text-foreground"
                  }`}
                >
                  {option.label}
                </button>
              ))}
            </div>
          </div>
        )}
        <Textarea
          value={question}
          onChange={(e) => setQuestion(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              submit();
            }
          }}
          placeholder={
            isExam
              ? "e.g. Set 2 professional-level questions on IAS 12 deferred tax, 15 marks each, hard difficulty, with the marking guide."
              : "e.g. What is the tax rate for a small company?  (Enter to send, Shift+Enter for a new line)"
          }
          className="min-h-32 resize-y border-0 focus-visible:ring-0"
        />
        <div className="mt-1 flex items-center justify-between px-1">
          <span className="text-xs text-muted-foreground">
            {question.length.toLocaleString()} chars — paste the full question/scenario
          </span>
          <Button onClick={submit} disabled={running || question.trim().length < 2}>
            {running ? "Thinking…" : isExam ? "Set exam" : "Ask"}
          </Button>
        </div>
      </div>
    </div>
  );
}
