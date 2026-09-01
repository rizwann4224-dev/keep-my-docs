import { useState, useSyncExternalStore } from "react";
import { toast } from "sonner";
import { Bell, CheckCircle2, ClipboardCheck, FileText, LineChart, Sparkles } from "lucide-react";
import * as jobs from "@/lib/study-jobs";
import type { MarkPart, Rigour } from "@/lib/study-prompts";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { LessonCapture } from "@/components/study/LessonCapture";
import { ThinkingStatus } from "@/components/study/ThinkingStatus";
import { AnswerCard } from "@/components/study/AnswerCard";
import { ChallengeEvaluation } from "@/components/study/ChallengeEvaluation";
import { exportMarkingToWord } from "@/lib/export-docx";
import { cn } from "@/lib/utils";

const OPTIONS: { id: MarkPart; label: string; hint: string; icon: typeof FileText }[] = [
  {
    id: "feedback",
    label: "Item-by-item feedback",
    hint: "detailed marking commentary",
    icon: FileText,
  },
  { id: "marks", label: "Marks", hint: "mark per item + total", icon: LineChart },
  {
    id: "suggested",
    label: "Suggested answer",
    hint: "examiner-standard model answer",
    icon: CheckCircle2,
  },
  { id: "recommendations", label: "Recommendations", hint: "how to improve", icon: Bell },
];

const RIGOURS: { id: Rigour; label: string; hint: string }[] = [
  { id: "moderate", label: "Moderate", hint: "Credit for correct substance" },
  { id: "strict", label: "Strict", hint: "Standard ICAP examiner" },
  { id: "hard", label: "Hard / difficult", hint: "Distinction standard, no benefit of the doubt" },
];

const MARK_STEPS = [
  "Reading question and answer",
  "Applying marking standard",
  "Evaluating each point",
  "Calculating marks",
  "Generating feedback and suggestions",
];

export function MarkPanel({ subjectId, subjectName }: { subjectId: string; subjectName: string }) {
  const [question, setQuestion] = useState("");
  const [userAnswer, setUserAnswer] = useState("");
  const [parts, setParts] = useState<MarkPart[]>(["feedback", "marks", "suggested"]);
  const [rigour, setRigour] = useState<Rigour>("strict");
  const [submitted, setSubmitted] = useState<{
    question: string;
    userAnswer: string;
    parts: MarkPart[];
    rigour: Rigour;
  } | null>(null);
  const [exporting, setExporting] = useState(false);
  const [markData, setMarkData] = useState<{
    marks: number;
    maxMarks: number;
  } | null>(null);
  const key = `${subjectId}:mark`;

  useSyncExternalStore(jobs.subscribe, jobs.getSnapshot, jobs.getSnapshot);
  const turns = jobs.getTurns(key);
  const latest = turns[turns.length - 1];
  const running = jobs.isRunning(key);

  const needsAnswer = parts.includes("feedback") || parts.includes("marks");
  const hasMarks = parts.includes("marks");

  function run() {
    if (running) return;
    setSubmitted({
      question: question.trim(),
      userAnswer: userAnswer.trim(),
      parts: [...parts],
      rigour,
    });
    setMarkData(null);
    jobs.startRun(
      key,
      {
        subjectId,
        mode: "mark",
        question: question.trim(),
        userAnswer: userAnswer.trim() || undefined,
        parts,
        rigour,
      },
      question.trim(),
    );
    toast.info("Marking — this keeps running in the background if you switch tabs.");
  }

  function toggle(id: MarkPart) {
    setParts((prev) => (prev.includes(id) ? prev.filter((p) => p !== id) : [...prev, id]));
  }

  // Extract marks from response (simple regex pattern)
  function extractMarksFromResponse(response: string): { marks: number; maxMarks: number } | null {
    // Look for patterns like "Marks awarded: 18/20" or "18 / 20"
    const match = response.match(/Marks awarded:\s*(\d+)\s*\/\s*(\d+)|(\d+)\s*\/\s*(\d+)\s*marks/i);
    if (match) {
      const marks = parseInt(match[1] ?? match[3] ?? "");
      const maxMarks = parseInt(match[2] ?? match[4] ?? "");
      if (Number.isNaN(marks) || Number.isNaN(maxMarks)) return null;
      return { marks, maxMarks };
    }
    return null;
  }

  // Update markData when response arrives
  if (latest?.status === "done" && latest.answer && hasMarks && !markData) {
    const extracted = extractMarksFromResponse(latest.answer);
    if (extracted) {
      setMarkData(extracted);
    }
  }

  const canGenerate =
    !running &&
    parts.length > 0 &&
    question.trim().length >= 3 &&
    (!needsAnswer || userAnswer.trim().length >= 3);

  return (
    <div className="space-y-6">
      {/* Header: mirrors "Answer & marking / Mark your answer using marking standard". */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <span className="flex h-10 w-10 items-center justify-center rounded-full bg-primary/10 text-primary">
            <ClipboardCheck className="h-5 w-5" />
          </span>
          <div>
            <h2 className="text-xl font-semibold text-foreground">Answer &amp; marking</h2>
            <p className="text-sm text-muted-foreground">Mark your answer using marking standard</p>
          </div>
        </div>
        <Button onClick={run} disabled={!canGenerate}>
          <Sparkles className="h-4 w-4" />
          {running ? "Marking…" : "Generate"}
        </Button>
      </div>

      <div className="grid gap-2 sm:grid-cols-3">
        {RIGOURS.map((option) => {
          const active = rigour === option.id;
          return (
            <button
              key={option.id}
              type="button"
              onClick={() => setRigour(option.id)}
              className={cn(
                "relative rounded-xl border p-4 text-left transition-colors",
                active ? "border-primary bg-primary/5" : "border-border bg-card hover:bg-muted",
              )}
            >
              <span className="flex items-center gap-2">
                <span
                  className={cn(
                    "flex h-4 w-4 shrink-0 items-center justify-center rounded-full",
                    active
                      ? "bg-primary text-primary-foreground"
                      : "border border-muted-foreground/40",
                  )}
                >
                  {active && <CheckCircle2 className="h-4 w-4" />}
                </span>
                <span className="text-sm font-semibold text-foreground">{option.label}</span>
              </span>
              <span className="mt-1 block pl-6 text-xs text-muted-foreground">{option.hint}</span>
            </button>
          );
        })}
      </div>

      <div>
        <h3 className="text-sm font-semibold text-foreground">What do you want back?</h3>
        <div className="mt-3 grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
          {OPTIONS.map((option) => {
            const active = parts.includes(option.id);
            const Icon = option.icon;
            return (
              <button
                key={option.id}
                type="button"
                onClick={() => toggle(option.id)}
                className={cn(
                  "rounded-xl border p-3 text-left transition-colors",
                  active ? "border-primary bg-primary/5" : "border-border bg-card hover:bg-muted",
                )}
              >
                <span className="flex items-center gap-2">
                  <Icon
                    className={cn(
                      "h-4 w-4 shrink-0",
                      active ? "text-primary" : "text-muted-foreground",
                    )}
                  />
                  <span className="text-sm font-semibold text-foreground">{option.label}</span>
                </span>
                <span className="mt-1 block text-xs text-muted-foreground">{option.hint}</span>
              </button>
            );
          })}
        </div>
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <div className="rounded-xl border border-border bg-card p-5">
          <h2 className="text-base font-semibold text-foreground">Question / scenario</h2>
          <p className="mt-1 text-sm text-muted-foreground">
            Include all sub-parts (a), (b), (i), (ii), (iii) and the marks available. Long scenarios
            are fully accepted.
          </p>
          <Textarea
            value={question}
            onChange={(e) => setQuestion(e.target.value)}
            placeholder="Paste the full question here…"
            className="mt-4 min-h-56 resize-y"
          />
          <p className="mt-1 text-right text-xs text-muted-foreground">
            {question.length.toLocaleString()} chars
          </p>
        </div>
        <div className="rounded-xl border border-border bg-card p-5">
          <h2 className="text-base font-semibold text-foreground">
            Your answer{needsAnswer ? "" : " (optional)"}
          </h2>
          <p className="mt-1 text-sm text-muted-foreground">
            {needsAnswer
              ? "Quoted back verbatim while marking."
              : "Leave blank if you only want a suggested answer."}
          </p>
          <Textarea
            value={userAnswer}
            onChange={(e) => setUserAnswer(e.target.value)}
            placeholder="Type or paste your answer…"
            className="mt-4 min-h-56 resize-y"
          />
          <p className="mt-1 text-right text-xs text-muted-foreground">
            {userAnswer.length.toLocaleString()} chars
          </p>
        </div>
      </div>

      {/* Live progress — purely a client-side visual; unmounts itself the
          instant the parent has any answer text or a terminal status. */}
      {latest && latest.status === "streaming" && !latest.answer && (
        <ThinkingStatus
          title="Marking your answer…"
          subtitle="This may take a few seconds"
          meta="Evaluating your answer…"
          steps={MARK_STEPS}
        />
      )}

      {latest?.status === "error" && (
        <div className="rounded-xl border border-border bg-card p-6">
          <p className="text-sm text-destructive">{latest.error ?? "Something went wrong"}</p>
        </div>
      )}

      {latest?.answer && (
        <AnswerCard answer={latest.answer} streaming={latest.status === "streaming"}>
          {latest.status === "done" && hasMarks && markData && (
            <ChallengeEvaluation
              subjectId={subjectId}
              challenge={{
                originalMarks: markData.marks,
                maxMarks: markData.maxMarks,
                originalEvaluation: latest.answer,
                originalQuestion: submitted?.question || question,
                originalAnswer: submitted?.userAnswer || userAnswer,
                rigour: submitted?.rigour || rigour,
              }}
            />
          )}

          {latest.status === "done" && (
            <div className="mt-4 flex justify-end border-t border-border pt-4">
              <Button
                variant="outline"
                size="sm"
                disabled={exporting}
                onClick={async () => {
                  setExporting(true);
                  try {
                    await exportMarkingToWord({
                      notebook: subjectName,
                      question: submitted?.question || latest.question,
                      userAnswer: submitted?.userAnswer,
                      requested: (submitted?.parts ?? parts).map(
                        (id) => OPTIONS.find((o) => o.id === id)?.label ?? id,
                      ),
                      rigour:
                        RIGOURS.find((r) => r.id === (submitted?.rigour ?? rigour))?.label ??
                        "Strict",
                      response: latest.answer,
                    });
                  } catch {
                    toast.error("Could not build the Word file");
                  } finally {
                    setExporting(false);
                  }
                }}
              >
                {exporting ? "Preparing…" : "Export to Word"}
              </Button>
            </div>
          )}

          {latest.status === "done" && <LessonCapture subjectId={subjectId} />}
        </AnswerCard>
      )}
    </div>
  );
}
