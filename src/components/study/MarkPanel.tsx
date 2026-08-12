import { useState } from "react";
import { useServerFn } from "@tanstack/react-start";
import { useMutation } from "@tanstack/react-query";
import { toast } from "sonner";
import { runStudyQuery } from "@/lib/study.functions";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Markdown } from "@/components/study/Markdown";
import { LessonCapture } from "@/components/study/LessonCapture";

export function MarkPanel({ subjectId }: { subjectId: string }) {
  const run = useServerFn(runStudyQuery);
  const [question, setQuestion] = useState("");
  const [userAnswer, setUserAnswer] = useState("");
  const [result, setResult] = useState<string | null>(null);

  const mutation = useMutation({
    mutationFn: async () =>
      run({
        data: {
          subjectId,
          mode: "mark" as const,
          question: question.trim(),
          userAnswer: userAnswer.trim(),
        },
      }),
    onSuccess: (res) => setResult(res.content),
    onError: (e: unknown) => toast.error(e instanceof Error ? e.message : "Could not mark this"),
  });

  return (
    <div className="space-y-6">
      <div className="grid gap-4 lg:grid-cols-2">
        <div className="rounded-lg border border-border bg-card p-5">
          <h2 className="text-base font-semibold text-foreground">Exam question</h2>
          <p className="mt-1 text-sm text-muted-foreground">
            Include all sub-parts (i), (ii), (iii) and the marks available.
          </p>
          <Textarea
            value={question}
            onChange={(e) => setQuestion(e.target.value)}
            placeholder="Paste the full question / scenario here…"
            className="mt-4 min-h-56"
          />
        </div>
        <div className="rounded-lg border border-border bg-card p-5">
          <h2 className="text-base font-semibold text-foreground">Your answer</h2>
          <p className="mt-1 text-sm text-muted-foreground">
            Write exactly what you would write in the exam — it is quoted back verbatim.
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
          onClick={() => mutation.mutate()}
          disabled={mutation.isPending || question.trim().length < 3 || userAnswer.trim().length < 3}
        >
          {mutation.isPending ? "Marking…" : "Mark & evaluate"}
        </Button>
      </div>

      {result && (
        <div className="rounded-lg border border-border bg-card p-6">
          <Markdown>{result}</Markdown>
          <LessonCapture subjectId={subjectId} />
        </div>
      )}
    </div>
  );
}
