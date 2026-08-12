import { useState } from "react";
import { useServerFn } from "@tanstack/react-start";
import { useMutation } from "@tanstack/react-query";
import { toast } from "sonner";
import { runStudyQuery } from "@/lib/study.functions";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Markdown } from "@/components/study/Markdown";
import { LessonCapture } from "@/components/study/LessonCapture";

type Turn = { question: string; answer: string };

export function AskPanel({ subjectId }: { subjectId: string }) {
  const run = useServerFn(runStudyQuery);
  const [question, setQuestion] = useState("");
  const [turns, setTurns] = useState<Turn[]>([]);

  const mutation = useMutation({
    mutationFn: async (q: string) =>
      run({ data: { subjectId, mode: "ask" as const, question: q } }),
    onSuccess: (res, q) => {
      setTurns((prev) => [...prev, { question: q, answer: res.content }]);
      setQuestion("");
    },
    onError: (e: unknown) =>
      toast.error(e instanceof Error ? e.message : "Could not answer that"),
  });

  function submit() {
    const q = question.trim();
    if (q.length < 2) return;
    mutation.mutate(q);
  }

  return (
    <div className="space-y-6">
      {turns.length === 0 && !mutation.isPending && (
        <div className="rounded-xl border border-border bg-card p-8 text-center">
          <h2 className="text-base font-semibold text-foreground">Ask anything about your sources</h2>
          <p className="mx-auto mt-2 max-w-md text-sm text-muted-foreground">
            You get the direct answer first — a rate, a figure, a name, a rule — then only the
            supporting detail, cited from your documents.
          </p>
        </div>
      )}

      <div className="space-y-5">
        {turns.map((turn, i) => (
          <div key={i} className="space-y-3">
            <p className="ml-auto w-fit max-w-[85%] rounded-2xl rounded-br-sm bg-primary px-4 py-2 text-sm text-primary-foreground">
              {turn.question}
            </p>
            <div className="rounded-xl border border-border bg-card p-5">
              <Markdown>{turn.answer}</Markdown>
              <LessonCapture subjectId={subjectId} />
            </div>
          </div>
        ))}
        {mutation.isPending && (
          <p className="text-sm text-muted-foreground">Searching your sources…</p>
        )}
      </div>

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
          <Button onClick={submit} disabled={mutation.isPending || question.trim().length < 2}>
            {mutation.isPending ? "Thinking…" : "Ask"}
          </Button>
        </div>
      </div>
    </div>
  );
}
