import { useState } from "react";
import { useServerFn } from "@tanstack/react-start";
import { useMutation } from "@tanstack/react-query";
import { toast } from "sonner";
import { runStudyQuery } from "@/lib/study.functions";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Markdown } from "@/components/study/Markdown";
import { LessonCapture } from "@/components/study/LessonCapture";

export function AskPanel({ subjectId }: { subjectId: string }) {
  const run = useServerFn(runStudyQuery);
  const [question, setQuestion] = useState("");
  const [answer, setAnswer] = useState<string | null>(null);

  const mutation = useMutation({
    mutationFn: async () =>
      run({ data: { subjectId, mode: "ask" as const, question: question.trim() } }),
    onSuccess: (res) => setAnswer(res.content),
    onError: (e: unknown) =>
      toast.error(e instanceof Error ? e.message : "Could not generate an answer"),
  });

  return (
    <div className="space-y-6">
      <div className="rounded-lg border border-border bg-card p-5">
        <h2 className="text-base font-semibold text-foreground">Ask or draft an answer</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          Answers are built ~80% from this subject's uploaded sources, with up to 20% wider
          professional context clearly labelled.
        </p>
        <Textarea
          value={question}
          onChange={(e) => setQuestion(e.target.value)}
          placeholder="Paste the exam question or scenario, or ask a discussion question…"
          className="mt-4 min-h-40"
        />
        <div className="mt-3 flex justify-end">
          <Button
            onClick={() => mutation.mutate()}
            disabled={mutation.isPending || question.trim().length < 3}
          >
            {mutation.isPending ? "Drafting…" : "Generate answer"}
          </Button>
        </div>
      </div>

      {answer && (
        <div className="rounded-lg border border-border bg-card p-6">
          <Markdown>{answer}</Markdown>
          <LessonCapture subjectId={subjectId} />
        </div>
      )}
    </div>
  );
}
