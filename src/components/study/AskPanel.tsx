import { useState, useSyncExternalStore } from "react";
import { toast } from "sonner";
import { useQuery } from "@tanstack/react-query";
import { FileText, Sparkles } from "lucide-react";
import * as jobs from "@/lib/study-jobs";
import { supabase } from "@/integrations/supabase/client";
import { exportAskToPdf } from "@/lib/export-pdf";
import type { ExamDifficulty } from "@/lib/study-prompts";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { LessonCapture } from "@/components/study/LessonCapture";
import { ThinkingStatus } from "@/components/study/ThinkingStatus";
import { AnswerCard } from "@/components/study/AnswerCard";

const DIFFICULTIES: { id: ExamDifficulty; label: string; hint: string }[] = [
  { id: "medium", label: "Medium", hint: "Standard ICAP professional level" },
  { id: "professional", label: "Professional", hint: "Strict ICAP formatting, no hints" },
  { id: "hard", label: "Hard", hint: "Very hard — ~20% pass level" },
];

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
  const [difficulty, setDifficulty] = useState<ExamDifficulty>("medium");
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
        // Exam mode needs a long memory so previously-set questions are never repeated.
        .limit(isExam ? 50 : 6);
      if (error) throw error;
      return (data ?? []).reverse() as { question: string; response: string }[];
    },
  });

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
          ? '\n\n[Answer format: LONG — a thorough answer with full explanation, structure, and references to the sources. Still lead with the direct answer. End with exactly ONE worked practical example (labelled "Practical example:") that applies the rule to realistic figures, using source figures where possible.]'
          : "";
    // Questions already set for this notebook (live thread + saved history) so the
    // exam setter never repeats one.
    const priorQuestions = Array.from(
      new Set([...saved.map((entry) => entry.question), ...live.map((t) => t.question)]),
    ).filter((q) => q.trim().length > 0);
    jobs.startRun(
      key,
      {
        subjectId,
        mode: isExam ? "exam" : "ask",
        question: q + directive,
        difficulty: isExam ? difficulty : undefined,
        priorQuestions: isExam ? priorQuestions : undefined,
        history: [...past, ...live],
      },
      q,
    );
    setQuestion("");
    toast.info("Working — you can switch tabs, the answer keeps generating.");
  }

  return (
    <div className="space-y-6">
      {/* Header: mirrors the "Ask / Get answers from your notebooks" banner. */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <span className="flex h-10 w-10 items-center justify-center rounded-full bg-primary/10 text-primary">
            <Sparkles className="h-5 w-5" />
          </span>
          <div>
            <h2 className="text-xl font-semibold text-foreground">Ask</h2>
            <p className="text-sm text-muted-foreground">Get answers from your notebooks</p>
          </div>
        </div>
        <span className="flex items-center gap-2 rounded-lg border border-border bg-card px-3 py-1.5 text-sm font-medium text-foreground">
          <FileText className="h-4 w-4 text-muted-foreground" />
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

      {isExam && (
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-sm font-medium text-foreground">Difficulty:</span>
          <div className="flex flex-wrap gap-2">
            {DIFFICULTIES.map((option) => {
              const active = difficulty === option.id;
              return (
                <button
                  key={option.id}
                  type="button"
                  aria-pressed={active}
                  onClick={() => setDifficulty(option.id)}
                  className={`rounded-lg border px-3 py-1.5 text-left transition-colors ${
                    active
                      ? "border-primary bg-primary/5 text-primary"
                      : "border-border text-muted-foreground hover:bg-muted"
                  }`}
                >
                  <span className="block text-sm font-semibold">{option.label}</span>
                  <span className="block text-xs text-muted-foreground">{option.hint}</span>
                </button>
              );
            })}
          </div>
        </div>
      )}

      {!isExam && (
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-sm font-medium text-foreground">Answer length:</span>
          <div className="flex flex-wrap gap-2">
            {(
              [
                { id: "short", label: "Short" },
                { id: "medium", label: "Medium" },
                { id: "long", label: "Long + explanation" },
              ] as const
            ).map((option) => (
              <button
                key={option.id}
                type="button"
                onClick={() => setAnswerLength(option.id)}
                className={`rounded-lg border px-3 py-1.5 text-sm font-medium transition-colors ${
                  answerLength === option.id
                    ? "border-primary bg-primary/5 text-primary"
                    : "border-border text-muted-foreground hover:bg-muted"
                }`}
              >
                {option.label}
              </button>
            ))}
          </div>
        </div>
      )}

      <div className="rounded-xl border border-border bg-card p-3 shadow-sm">
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
            {question.length.toLocaleString()} chars
          </span>
          <Button onClick={submit} disabled={running || question.trim().length < 2}>
            {running ? "Thinking…" : isExam ? "Set exam" : "Ask"}
            {!running && <span aria-hidden>→</span>}
          </Button>
        </div>
      </div>

      <div className="space-y-5">
        {turns.map((turn) => (
          <div key={turn.id} className="space-y-3">
            <p className="ml-auto w-fit max-w-[85%] rounded-2xl rounded-br-sm bg-primary px-4 py-2 text-sm text-primary-foreground">
              {turn.question}
            </p>

            {/* Live progress — real-time, purely visual, and unmounts itself
                the instant there is any answer text or a terminal status, so
                nothing about the request/response timing is affected. */}
            {turn.status === "streaming" && !turn.answer && <ThinkingStatus />}

            {turn.answer && (
              <AnswerCard
                answer={turn.answer}
                streaming={turn.status === "streaming"}
                sourceCount={turn.status === "done" ? sourceCount : undefined}
                answerLength={turn.status === "done" && !isExam ? answerLength : undefined}
              >
                {turn.status === "done" && <LessonCapture subjectId={subjectId} />}
              </AnswerCard>
            )}

            {turn.status === "error" && (
              <div className="rounded-xl border border-border bg-card p-5">
                <p className="text-sm text-destructive">{turn.error ?? "Something went wrong"}</p>
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
    </div>
  );
}
