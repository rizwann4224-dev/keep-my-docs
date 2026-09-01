import { useState, useSyncExternalStore } from "react";
import { toast } from "sonner";
import { useQuery } from "@tanstack/react-query";
import { Copy, FileText, Sparkles, ThumbsDown, ThumbsUp } from "lucide-react";
import * as jobs from "@/lib/study-jobs";
import { supabase } from "@/integrations/supabase/client";
import { exportAskToPdf } from "@/lib/export-pdf";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Markdown } from "@/components/study/Markdown";
import { LessonCapture } from "@/components/study/LessonCapture";
import { ThinkingStatus, ASK_STEPS } from "@/components/study/ThinkingStatus";

const ANSWER_LENGTH_LABEL: Record<"short" | "medium" | "long", string> = {
  short: "Short",
  medium: "Medium",
  long: "Long + explanation",
};

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

  // Purely cosmetic — the "Sources: N" badge in the header. Read-only, no
  // impact on how the question is answered.
  const { data: sourceCount = 0 } = useQuery({
    queryKey: ["subject-source-count", subjectId],
    queryFn: async () => {
      const { count, error } = await supabase
        .from("documents")
        .select("id", { count: "exact", head: true })
        .eq("subject_id", subjectId);
      if (error) throw error;
      return count ?? 0;
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
      {/* Panel header */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <span className="flex h-10 w-10 items-center justify-center rounded-xl bg-primary/10 text-primary">
            <Sparkles className="h-5 w-5" />
          </span>
          <div>
            <h2 className="text-lg font-semibold leading-tight text-foreground">Ask</h2>
            <p className="text-xs text-muted-foreground">Get answers from your notebooks</p>
          </div>
        </div>
        <span className="inline-flex items-center gap-2 rounded-lg border border-border bg-card px-3 py-1.5 text-xs font-medium text-foreground">
          <FileText className="h-3.5 w-3.5 text-muted-foreground" />
          Sources: {sourceCount}
        </span>
      </div>

      {/* Mode switch: full-width toggle buttons with an explicit on/off state. */}
      <div className="grid grid-cols-1 gap-2 rounded-xl border border-border bg-muted p-1.5 sm:grid-cols-2">
        {(
          [
            { id: "general", label: "General query" },
            { id: "question", label: "Question (exam setter)" },
          ] as const
        ).map((option) => {
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

            {/* Live progress — mounted only while this turn is streaming with no
                text yet. It fully unmounts the instant the answer is ready or
                tokens start arriving, so nothing lingers once generation ends. */}
            {turn.status === "streaming" && !turn.answer && (
              <div className="rounded-xl border border-border bg-card p-5">
                <ThinkingStatus
                  title="Generating answer…"
                  subtitle="This may take a few seconds"
                  meta="Thinking with your sources…"
                  steps={ASK_STEPS}
                />
              </div>
            )}

            {(turn.answer || turn.status === "error") && (
              <div className="rounded-xl border border-border bg-card p-5">
                {turn.answer ? (
                  <>
                    <div className="mb-3 flex items-center justify-between gap-2">
                      <span className="flex items-center gap-2 text-sm font-semibold text-foreground">
                        <Sparkles className="h-4 w-4 text-primary" />
                        Answer
                      </span>
                      {turn.status === "done" && (
                        <div className="flex items-center gap-1">
                          <Button
                            variant="outline"
                            size="icon"
                            className="h-8 w-8"
                            aria-label="Copy answer"
                            onClick={async () => {
                              try {
                                await navigator.clipboard.writeText(turn.answer);
                                toast.success("Copied to clipboard");
                              } catch {
                                toast.error("Could not copy");
                              }
                            }}
                          >
                            <Copy className="h-3.5 w-3.5" />
                          </Button>
                          <Button
                            variant="outline"
                            size="icon"
                            className="h-8 w-8"
                            aria-label="Good answer"
                            onClick={() => toast.success("Thanks for the feedback")}
                          >
                            <ThumbsUp className="h-3.5 w-3.5" />
                          </Button>
                          <Button
                            variant="outline"
                            size="icon"
                            className="h-8 w-8"
                            aria-label="Bad answer"
                            onClick={() => toast.info("Thanks — noted")}
                          >
                            <ThumbsDown className="h-3.5 w-3.5" />
                          </Button>
                        </div>
                      )}
                    </div>
                    <Markdown>{turn.answer}</Markdown>
                    {turn.status === "streaming" && (
                      <span className="ml-0.5 inline-block h-4 w-1.5 animate-pulse bg-foreground align-text-bottom" />
                    )}
                  </>
                ) : (
                  <p className="text-sm text-destructive">{turn.error ?? "Something went wrong"}</p>
                )}
                {turn.status === "done" && turn.answer && (
                  <div className="mt-4 flex flex-wrap items-center gap-x-4 gap-y-1 border-t border-border pt-3 text-xs text-muted-foreground">
                    <span>Answer generated from {sourceCount} sources</span>
                    <span>Answer length: {ANSWER_LENGTH_LABEL[answerLength]}</span>
                    <span className="flex items-center gap-1">
                      Generated just now
                      <span className="h-1.5 w-1.5 rounded-full bg-emerald-500" />
                    </span>
                  </div>
                )}
                {turn.status === "done" && <LessonCapture subjectId={subjectId} />}
              </div>
            )}
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
              {(
                [
                  { id: "short", label: "Short (1–3 lines)" },
                  { id: "medium", label: "Medium" },
                  { id: "long", label: "Long + explanation" },
                ] as const
              ).map((option) => (
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
