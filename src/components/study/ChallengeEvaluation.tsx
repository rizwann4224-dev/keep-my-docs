import { useState, useSyncExternalStore } from "react";
import { toast } from "sonner";
import * as jobs from "@/lib/study-jobs";
import type { Rigour } from "@/lib/study-prompts";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Markdown } from "@/components/study/Markdown";
import { ThinkingStatus, GENERIC_STEPS } from "@/components/study/ThinkingStatus";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";

export interface ChallengeState {
  originalMarks: number;
  maxMarks: number;
  originalEvaluation: string;
  originalQuestion: string;
  originalAnswer: string;
  rigour: string;
}

export function ChallengeEvaluation({
  subjectId,
  challenge,
}: {
  subjectId: string;
  challenge: ChallengeState;
}) {
  const [showChallenge, setShowChallenge] = useState(false);
  const [query, setQuery] = useState("");
  const [submitted, setSubmitted] = useState<string | null>(null);
  // Stable per mount — computing this inline with Date.now() regenerated the
  // key on every render, so a running job could never be found after it started.
  const [challengeKey] = useState(() => `${subjectId}:challenge:${crypto.randomUUID()}`);

  useSyncExternalStore(jobs.subscribe, jobs.getSnapshot, jobs.getSnapshot);
  const turns = jobs.getTurns(challengeKey);
  const latest = turns[turns.length - 1];
  const running = jobs.isRunning(challengeKey);

  function submitChallenge() {
    if (!query.trim()) {
      toast.error("Please enter your query or objection");
      return;
    }

    setSubmitted(query.trim());
    jobs.startRun(
      challengeKey,
      {
        subjectId,
        mode: "challenge",
        question: challenge.originalQuestion,
        userAnswer: challenge.originalAnswer,
        originalEvaluation: challenge.originalEvaluation,
        challengeQuery: query.trim(),
        originalMarks: challenge.originalMarks,
        maxMarks: challenge.maxMarks,
        rigour: challenge.rigour as Rigour,
      },
      "Challenge Evaluation",
    );
    toast.info("Reviewing your objection...");
  }

  if (!showChallenge) {
    return (
      <div className="mt-6 border-t border-border pt-4">
        <Button variant="outline" onClick={() => setShowChallenge(true)}>
          ❓ Question This Evaluation
        </Button>
      </div>
    );
  }

  return (
    <div className="mt-6 space-y-4 rounded-lg border border-blue-200 bg-blue-50 p-4">
      <div className="space-y-3">
        <h3 className="text-sm font-semibold text-foreground">Challenge or Ask About Marks</h3>
        <p className="text-xs text-muted-foreground">
          If you disagree with the evaluation, explain why. The AI will review your objection
          against the original question, your answer, and the marking scheme.
        </p>

        <Textarea
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Example: I think Point 3 should get marks because... OR Why did you give me only 6 marks?"
          className="min-h-24 resize-y text-sm"
          disabled={running || !!latest}
        />

        <div className="flex gap-2">
          <Button
            size="sm"
            onClick={submitChallenge}
            disabled={running || !!latest || query.trim().length < 10}
          >
            {running ? "Reviewing..." : "Submit"}
          </Button>
          <Button
            size="sm"
            variant="outline"
            onClick={() => {
              setShowChallenge(false);
              setQuery("");
              setSubmitted(null);
              jobs.clear(challengeKey);
            }}
            disabled={running}
          >
            Cancel
          </Button>
        </div>
      </div>

      {latest && (
        <div className="mt-4 space-y-3 border-t border-blue-200 pt-4">
          {submitted && (
            <div className="rounded bg-white p-3">
              <p className="text-xs font-semibold text-muted-foreground uppercase">Your Query</p>
              <p className="mt-1 text-sm text-foreground">{submitted}</p>
            </div>
          )}

          {latest.answer ? (
            <>
              {latest.answer.trim().startsWith("⚠️") ? (
                <div className="rounded-md border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900">
                  {latest.answer.trim()}
                </div>
              ) : (
                <Markdown>{latest.answer}</Markdown>
              )}
              <div className="mt-4 flex gap-2 border-t border-blue-200 pt-4">
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => {
                    setShowChallenge(false);
                    setQuery("");
                    setSubmitted(null);
                    jobs.clear(challengeKey);
                  }}
                >
                  Close
                </Button>
              </div>
            </>
          ) : latest.status === "error" ? (
            <>
              <p className="text-sm text-destructive">{latest.error ?? "Something went wrong"}</p>
              <div className="flex gap-2">
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => {
                    setShowChallenge(false);
                    setQuery("");
                    setSubmitted(null);
                    jobs.clear(challengeKey);
                  }}
                >
                  Close
                </Button>
              </div>
            </>
          ) : (
            <ThinkingStatus
              title="Reviewing your objection…"
              subtitle="This may take a few seconds"
              meta="Re-checking the marking scheme…"
              steps={GENERIC_STEPS}
            />
          )}
        </div>
      )}
    </div>
  );
}
