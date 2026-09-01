import { useSyncExternalStore } from "react";
import { useQuery } from "@tanstack/react-query";
import { toast } from "sonner";
import * as jobs from "@/lib/study-jobs";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { Markdown } from "@/components/study/Markdown";
import { ThinkingStatus, GENERIC_STEPS } from "@/components/study/ThinkingStatus";
import { exportInsightsToPdf } from "@/lib/export-pdf";
import { exportInsightsToWord } from "@/lib/export-docx";

export function PerformancePanel({ subjectId }: { subjectId: string }) {
  const key = `${subjectId}:insights`;

  useSyncExternalStore(jobs.subscribe, jobs.getSnapshot, jobs.getSnapshot);
  const turns = jobs.getTurns(key);
  const latest = turns[turns.length - 1];
  const running = jobs.isRunning(key);

  const { data: count = 0 } = useQuery({
    queryKey: ["marked-count", subjectId],
    queryFn: async () => {
      const { count: c, error } = await supabase
        .from("qa_entries")
        .select("id", { count: "exact", head: true })
        .eq("subject_id", subjectId)
        .eq("mode", "mark");
      if (error) throw error;
      return c ?? 0;
    },
  });

  function analyse() {
    if (running) return;
    if (count === 0) {
      toast.error("Mark at least one answer first — this reads your marked attempts.");
      return;
    }
    jobs.clear(key);
    jobs.startRun(
      key,
      { subjectId, mode: "insights", question: "Performance diagnostic" },
      "Performance diagnostic",
    );
    toast.info("Analysing your marked attempts — this keeps running if you switch tabs.");
  }

  return (
    <div className="space-y-6">
      <div className="rounded-xl border border-border bg-card p-5">
        <h2 className="text-base font-semibold text-foreground">Strengths &amp; weak areas</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          Built from everything you have had marked in this notebook. One marked attempt gives a
          single-attempt read; two or more are aggregated, with recurring mistakes counted and
          ranked so your weakest topics stand out.
        </p>
        <div className="mt-4 flex flex-wrap items-center gap-3">
          <Button onClick={analyse} disabled={running || count === 0}>
            {running ? "Analysing…" : latest ? "Re-analyse" : "Analyse my performance"}
          </Button>
          {latest?.answer && !running && (
            <>
              <Button variant="outline" onClick={() => exportInsightsToPdf(latest.answer)}>
                Export PDF
              </Button>
              <Button variant="outline" onClick={() => void exportInsightsToWord(latest.answer)}>
                Export Word
              </Button>
            </>
          )}
          <span className="text-sm text-muted-foreground">
            {count} marked attempt{count === 1 ? "" : "s"} in this notebook
          </span>
        </div>
      </div>

      {latest && (
        <div className="rounded-xl border border-border bg-card p-6">
          {latest.answer ? (
            <Markdown>{latest.answer}</Markdown>
          ) : latest.status === "error" ? (
            <p className="text-sm text-destructive">{latest.error ?? "Something went wrong"}</p>
          ) : (
            <ThinkingStatus
              title="Analysing your performance…"
              subtitle="This may take a few seconds"
              meta="Reviewing your marked attempts…"
              steps={GENERIC_STEPS}
            />
          )}
        </div>
      )}
    </div>
  );
}
