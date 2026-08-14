import { useState, useSyncExternalStore } from "react";
import { toast } from "sonner";
import * as jobs from "@/lib/study-jobs";
import type { MarkPart } from "@/lib/study-prompts";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Markdown } from "@/components/study/Markdown";
import { LessonCapture } from "@/components/study/LessonCapture";

const OPTIONS: { id: MarkPart; label: string; hint: string }[] = [
  { id: "feedback", label: "Item-by-item feedback", hint: "🔍 detailed marking commentary" },
  { id: "marks", label: "Marks", hint: "📊 mark per item + total" },
  { id: "suggested", label: "Suggested answer", hint: "✅ examiner-standard model answer" },
  { id: "recommendations", label: "Recommendations", hint: "🎯 how to improve" },
];

export function MarkPanel({ subjectId }: { subjectId: string }) {
  const [question, setQuestion] = useState("");
  const [userAnswer, setUserAnswer] = useState("");
  const [parts, setParts] = useState<MarkPart[]>(["feedback", "marks", "suggested"]);
  const key = `${subjectId}:mark`;

  useSyncExternalStore(jobs.subscribe, jobs.getSnapshot, jobs.getSnapshot);
  const turns = jobs.getTurns(key);
  const latest = turns[turns.length - 1];
  const running = jobs.isRunning(key);

  const needsAnswer = parts.includes("feedback") || parts.includes("marks");

  function run() {
    if (running) return;
    jobs.startRun(
      key,
      {
        subjectId,
        mode: "mark",
        question: question.trim(),
        userAnswer: userAnswer.trim() || undefined,
        parts,
      },
      question.trim(),
    );
    toast.info("Marking — this keeps running in the background if you switch tabs.");
  }

  function toggle(id: MarkPart) {
    setParts((prev) => (prev.includes(id) ? prev.filter((p) => p !== id) : [...prev, id]));
  }

  return (
    <div className="space-y-6">
      <div className="rounded-xl border border-border bg-card p-5">
        <h2 className="text-base font-semibold text-foreground">What do you want back?</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          Pick only the sections you need — nothing else is generated.
        </p>
        <div className="mt-4 grid gap-2 sm:grid-cols-2">
          {OPTIONS.map((option) => {
            const active = parts.includes(option.id);
            return (
              <button
                key={option.id}
                type="button"
                onClick={() => toggle(option.id)}
                className={`rounded-lg border p-3 text-left transition-colors ${
                  active
                    ? "border-primary bg-accent"
                    : "border-border bg-background hover:bg-muted"
                }`}
              >
                <span className="block text-sm font-medium text-foreground">{option.label}</span>
                <span className="block text-xs text-muted-foreground">{option.hint}</span>
              </button>
            );
          })}
        </div>
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <div className="rounded-xl border border-border bg-card p-5">
          <h2 className="text-base font-semibold text-foreground">Question / scenario</h2>
          <p className="mt-1 text-sm text-muted-foreground">
            Include all sub-parts (i), (ii), (iii) and the marks available.
          </p>
          <Textarea
            value={question}
            onChange={(e) => setQuestion(e.target.value)}
            placeholder="Paste the full question here…"
            className="mt-4 min-h-56"
          />
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
            className="mt-4 min-h-56"
          />
        </div>
      </div>

      <div className="flex justify-end">
        <Button
          onClick={run}
          disabled={
            running ||
            parts.length === 0 ||
            question.trim().length < 3 ||
            (needsAnswer && userAnswer.trim().length < 3)
          }
        >
          {running ? "Working…" : "Generate"}
        </Button>
      </div>

      {latest && (
        <div className="rounded-xl border border-border bg-card p-6">
          {latest.answer ? (
            <Markdown>{latest.answer}</Markdown>
          ) : latest.status === "error" ? (
            <p className="text-sm text-destructive">{latest.error ?? "Something went wrong"}</p>
          ) : (
            <p className="text-sm text-muted-foreground">Marking against your sources…</p>
          )}
          {latest.status === "done" && <LessonCapture subjectId={subjectId} />}
        </div>
      )}
    </div>
  );
}
