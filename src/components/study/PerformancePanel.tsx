import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  LabelList,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import * as jobs from "@/lib/study-jobs";
import { supabase } from "@/integrations/supabase/client";
import { requestClassification } from "@/lib/study-stream";
import {
  breakdownTable,
  countsTowardGraph,
  formatPercent,
  groupBySubtopic,
  groupByTopic,
  isStyleOnlyWeakness,
  type ClassificationRecord,
} from "@/lib/performance-model";
import {
  loadBreakdown,
  saveBreakdown,
  updateBreakdownRow,
  type BreakdownState,
  type StoredRow,
} from "@/lib/performance-store";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Markdown } from "@/components/study/Markdown";
import { ThinkingStatus, GENERIC_STEPS } from "@/components/study/ThinkingStatus";
import { exportInsightsToPdf } from "@/lib/export-pdf";
import { exportInsightsToWord } from "@/lib/export-docx";
import { useAuth } from "@/hooks/useAuth";

const BAR_COLOR = "#1769E0";
const REVIEW_COLOR = "#94A3B8";

type Row = ClassificationRecord & { id?: string | undefined; key: string };

const fromStored = (row: StoredRow): Row => ({
  attempt: row.attempt,
  part: row.part,
  topic: row.topic,
  subtopic: row.subtopic,
  confidence: row.confidence,
  evidence: row.evidence,
  source: row.source,
  awarded: row.awarded,
  available: row.available,
  weakness: row.weakness,
  action: row.action,
  id: row.id,
  key: row.key,
});

export function PerformancePanel({ subjectId }: { subjectId: string }) {
  const key = `${subjectId}:insights`;
  const { user } = useAuth();
  const queryClient = useQueryClient();

  useSyncExternalStore(jobs.subscribe, jobs.getSnapshot, jobs.getSnapshot);
  const turns = jobs.getTurns(key);
  const latest = turns[turns.length - 1];
  const running = jobs.isRunning(key);

  const [classifying, setClassifying] = useState(false);
  const [state, setState] = useState<BreakdownState | null>(null);
  const [loadingBreakdown, setLoadingBreakdown] = useState(true);
  const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft] = useState<{ topic: string; subtopic: string }>({
    topic: "",
    subtopic: "",
  });

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

  async function reloadBreakdown() {
    setLoadingBreakdown(true);
    try {
      setState(await loadBreakdown(subjectId));
    } finally {
      setLoadingBreakdown(false);
    }
  }

  // Load any previously saved breakdown when the notebook opens. A fresh
  // classification writes its rows into state itself, so this runs once per
  // notebook and never re-reads on the way back from an edit.
  useEffect(() => {
    let active = true;
    setLoadingBreakdown(true);
    void loadBreakdown(subjectId).then((next) => {
      if (!active) return;
      setState(next);
      setLoadingBreakdown(false);
    });
    return () => {
      active = false;
    };
  }, [subjectId]);

  const rows = useMemo<Row[]>(() => (state?.rows ?? []).map(fromStored), [state]);
  const classified = rows.filter((row) => countsTowardGraph(row));
  const needsReview = rows.filter((row) => !countsTowardGraph(row));
  const topics = useMemo(() => groupByTopic(rows), [rows]);
  const subtopics = useMemo(() => groupBySubtopic(rows), [rows]);
  const chartTopics = topics.filter((group) => group.percent !== null);
  const chartSubtopics = subtopics.filter((group) => group.percent !== null);

  const overall = useMemo(() => {
    const awarded = classified.reduce((sum, row) => sum + (row.awarded ?? 0), 0);
    const available = classified.reduce((sum, row) => sum + (row.available ?? 0), 0);
    return {
      awarded,
      available,
      percent: available > 0 ? (awarded / available) * 100 : null,
    };
  }, [classified]);

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

  async function classify() {
    if (!user) {
      toast.error("Sign in first.");
      return;
    }
    if (count === 0) {
      toast.error("Mark at least one answer first — the breakdown reads your marked attempts.");
      return;
    }
    setClassifying(true);
    try {
      const result = await requestClassification(subjectId);
      const next = await saveBreakdown(subjectId, user.id, result.rows);
      setState(next);
      if (result.rejected.length > 0) {
        toast.warning(
          `${result.rejected.length} row${result.rejected.length === 1 ? "" : "s"} rejected: ${result.rejected
            .slice(0, 2)
            .map((r) => `row ${r.row} (${r.reason})`)
            .join("; ")}`,
        );
      }
      if (result.needsReview.length > 0) {
        toast.info(
          `${result.needsReview.length} row${
            result.needsReview.length === 1 ? "" : "s"
          } need review and are excluded from the percentages.`,
        );
      }
      toast.success(
        `Classified ${result.attemptsClassified} of ${result.attemptsExpected} marked attempts`,
      );
      queryClient.invalidateQueries({ queryKey: ["performance-breakdown", subjectId] });
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Could not classify your attempts");
    } finally {
      setClassifying(false);
    }
  }

  async function saveEdit(row: Row) {
    const result = await updateBreakdownRow(
      subjectId,
      { ...row, key: row.key },
      {
        topic: draft.topic.trim() || row.topic,
        subtopic: draft.subtopic.trim() || row.subtopic,
      },
    );
    if (!result.ok) {
      toast.error(`Saved on this device only — ${result.error}`);
    } else {
      toast.success("Topic labels updated");
    }
    await reloadBreakdown();
    setEditing(null);
  }

  /**
   * Everything the exports need: the score table, then the evidence and the next
   * steps for each row. Percentages are only ever computed from rows with real
   * marks and a confident classification — a missing mark never becomes a 0%.
   */
  function exportBody(): string {
    const header = `# Performance overview\n\n${
      overall.percent === null
        ? `Overall: no computable marks yet — every row is still awaiting a mark or a review.`
        : `Overall: ${overall.awarded} / ${overall.available} marks (${formatPercent(
            overall.percent,
          )}) across ${new Set(classified.map((r) => r.attempt)).size} marked attempt${
            new Set(classified.map((r) => r.attempt)).size === 1 ? "" : "s"
          }.`
    }\n\nScore = sum of awarded marks ÷ sum of available marks. Rows below the line are excluded from every percentage.\n\n${breakdownTable(
      state?.rows ?? [],
    )}\n\n## Evidence and next steps\n\n${rows
      .map(
        (row) =>
          `### Attempt ${row.attempt} ${row.part} — ${row.topic} › ${row.subtopic}\n` +
          `- Marks: ${row.awarded === null ? "not stated" : `${row.awarded} / ${row.available ?? "?"}`}\n` +
          `- Classification confidence: ${row.confidence}${
            countsTowardGraph(row) ? "" : " — Needs review, excluded from the charts"
          }\n` +
          `- Evidence: ${row.evidence}\n` +
          `- Source of the topic name: ${row.source}\n` +
          `- Weakness: ${
            isStyleOnlyWeakness(row.weakness)
              ? `${row.weakness} (writing style — not counted as a knowledge weakness)`
              : row.weakness
          }\n` +
          `- Next step: ${row.action}`,
      )
      .join("\n\n")}\n`;
    return header;
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
          <Button
            variant="outline"
            onClick={() => void classify()}
            disabled={classifying || count === 0}
          >
            {classifying ? "Classifying…" : "Classify topics & marks"}
          </Button>
          {latest?.answer && !running && (
            <>
              <Button variant="outline" onClick={() => exportInsightsToPdf(latest.answer)}>
                Export narrative PDF
              </Button>
              <Button variant="outline" onClick={() => void exportInsightsToWord(latest.answer)}>
                Export narrative Word
              </Button>
            </>
          )}
          {rows.length > 0 && (
            <>
              <Button
                variant="outline"
                onClick={() => exportInsightsToPdf(exportBody(), "performance-overview")}
              >
                Export overview PDF
              </Button>
              <Button variant="outline" onClick={() => void exportInsightsToWord(exportBody())}>
                Export overview Word
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
            <p className="whitespace-pre-line text-sm text-destructive">
              {latest.error ?? "Something went wrong"}
            </p>
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

      {classifying && (
        <div className="rounded-xl border border-border bg-card p-6">
          <ThinkingStatus
            title="Classifying each marked part…"
            subtitle="Topic, subtopic and marks are read from your marked reports"
            meta="One row per attempt + part; duplicates and gaps are rejected"
            steps={GENERIC_STEPS}
          />
        </div>
      )}

      {loadingBreakdown && rows.length === 0 ? (
        <p className="rounded-xl border border-border bg-card p-6 text-sm text-muted-foreground">
          Loading your topic breakdown…
        </p>
      ) : rows.length > 0 ? (
        <div className="space-y-6">
          <div className="rounded-xl border border-border bg-card p-5">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div>
                <h3 className="text-sm font-semibold text-foreground">Topic performance</h3>
                <p className="text-xs text-muted-foreground">
                  {overall.percent === null
                    ? "No percentage is shown until marks are recorded — the app never invents one."
                    : `${overall.awarded} / ${overall.available} marks = ${formatPercent(
                        overall.percent,
                      )} (sum awarded ÷ sum available)`}
                </p>
              </div>
              <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                <Badge variant="secondary">{classified.length} counted</Badge>
                {needsReview.length > 0 && (
                  <Badge variant="outline">{needsReview.length} Needs review</Badge>
                )}
                {state?.persisted === false && <Badge variant="destructive">Device-local</Badge>}
              </div>
            </div>
            {state?.notice && <p className="mt-2 text-xs text-muted-foreground">{state.notice}</p>}

            <div className="mt-4 grid gap-6 lg:grid-cols-2">
              <BreakdownChart
                title="By topic"
                data={chartTopics.map((group) => ({
                  name: group.name.length > 26 ? `${group.name.slice(0, 25)}…` : group.name,
                  percent: group.percent === null ? 0 : Math.round(group.percent * 10) / 10,
                  awarded: group.awarded,
                  available: group.available,
                }))}
              />
              <BreakdownChart
                title="By subtopic"
                data={chartSubtopics.slice(0, 8).map((group) => ({
                  name:
                    group.name.length > 26
                      ? `${group.name.split("—").pop()?.trim().slice(0, 25)}…`
                      : (group.name.split("—").pop()?.trim() ?? group.name),
                  percent: group.percent === null ? 0 : Math.round(group.percent * 10) / 10,
                  awarded: group.awarded,
                  available: group.available,
                }))}
              />
            </div>
            <p className="mt-3 text-[11px] text-muted-foreground">
              Bars are weighted: a topic's percentage is its total awarded marks over its total
              available marks. Zero scores stay on the chart; low-confidence rows and rows without
              marks are listed under “Needs review” instead of being counted.
            </p>
          </div>

          <div className="overflow-x-auto rounded-xl border border-border bg-card">
            <table className="w-full text-left text-xs">
              <thead className="bg-muted/50 text-muted-foreground">
                <tr>
                  <th className="px-3 py-2 font-medium">Attempt · part</th>
                  <th className="px-3 py-2 font-medium">Topic</th>
                  <th className="px-3 py-2 font-medium">Subtopic</th>
                  <th className="px-3 py-2 font-medium">Marks</th>
                  <th className="px-3 py-2 font-medium">Weakness</th>
                  <th className="px-3 py-2 font-medium">Next step</th>
                  <th className="px-3 py-2 font-medium" />
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {rows.map((row) => (
                  <tr key={row.key} className="align-top">
                    <td className="px-3 py-2 font-medium text-foreground">
                      {row.attempt} · {row.part}
                      {!countsTowardGraph(row) && (
                        <Badge variant="outline" className="ml-2">
                          Needs review
                        </Badge>
                      )}
                    </td>
                    <td className="px-3 py-2">
                      {editing === row.key ? (
                        <Input
                          value={draft.topic}
                          onChange={(e) => setDraft((d) => ({ ...d, topic: e.target.value }))}
                          className="h-7 text-xs"
                        />
                      ) : (
                        row.topic
                      )}
                    </td>
                    <td className="px-3 py-2">
                      {editing === row.key ? (
                        <Input
                          value={draft.subtopic}
                          onChange={(e) => setDraft((d) => ({ ...d, subtopic: e.target.value }))}
                          className="h-7 text-xs"
                        />
                      ) : (
                        row.subtopic
                      )}
                    </td>
                    <td className="px-3 py-2 tabular-nums">
                      {row.awarded === null || row.available === null
                        ? "—"
                        : `${row.awarded} / ${row.available}`}
                    </td>
                    <td className="max-w-[220px] px-3 py-2 text-muted-foreground">
                      {row.weakness}
                    </td>
                    <td className="max-w-[220px] px-3 py-2 text-muted-foreground">{row.action}</td>
                    <td className="px-3 py-2 text-right">
                      {editing === row.key ? (
                        <div className="flex justify-end gap-1">
                          <Button size="sm" variant="ghost" onClick={() => setEditing(null)}>
                            Cancel
                          </Button>
                          <Button size="sm" onClick={() => void saveEdit(row)}>
                            Save
                          </Button>
                        </div>
                      ) : (
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={() => {
                            setEditing(row.key);
                            setDraft({ topic: row.topic, subtopic: row.subtopic });
                          }}
                        >
                          Edit
                        </Button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {needsReview.length > 0 && (
            <div className="rounded-xl border border-border bg-card p-5">
              <h3 className="text-sm font-semibold text-foreground">Needs review</h3>
              <p className="mt-1 text-xs text-muted-foreground">
                These rows are excluded from every percentage above: either the classification was
                not confident, or the marking report never stated marks. Fix the labels (or the
                marks in the marking report) and re-classify — nothing is estimated in the meantime.
              </p>
              <ul className="mt-3 space-y-2 text-xs text-muted-foreground">
                {needsReview.map((row) => (
                  <li key={row.key} className="rounded-lg border border-border p-2">
                    Attempt {row.attempt} {row.part} — {row.topic} › {row.subtopic}
                    <span className="ml-2 text-foreground">
                      {row.confidence === "low"
                        ? "low-confidence classification"
                        : row.awarded === null || row.available === null
                          ? "marks not stated in the report"
                          : "invalid marks"}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      ) : (
        !classifying && (
          <p className="rounded-xl border border-border bg-card p-8 text-center text-sm text-muted-foreground">
            No topic breakdown yet. Mark an answer, then choose “Classify topics &amp; marks” — each
            marked part is classified against your syllabus and the charts are built from the marks
            your reports actually state.
          </p>
        )
      )}
    </div>
  );
}

function BreakdownChart({
  title,
  data,
}: {
  title: string;
  data: { name: string; percent: number; awarded: number; available: number }[];
}) {
  return (
    <div className="min-w-0">
      <p className="text-xs font-medium text-foreground">{title}</p>
      {data.length === 0 ? (
        <p className="mt-3 rounded-lg border border-dashed border-border p-6 text-center text-xs text-muted-foreground">
          Nothing to plot yet — no row has both a confident classification and stated marks.
        </p>
      ) : (
        <div className="mt-2 h-56 w-full">
          <ResponsiveContainer width="100%" height="100%">
            <BarChart
              data={data}
              layout="vertical"
              margin={{ left: 4, right: 24, top: 8, bottom: 8 }}
            >
              <CartesianGrid strokeDasharray="3 3" horizontal={false} stroke="#D9E3F0" />
              <XAxis type="number" domain={[0, 100]} unit="%" fontSize={11} tickLine={false} />
              <YAxis
                type="category"
                dataKey="name"
                width={120}
                fontSize={11}
                tickLine={false}
                axisLine={false}
              />
              <Tooltip
                cursor={{ fill: "rgba(23,105,224,0.06)" }}
                content={({ active, payload }) => {
                  const entry = payload?.[0]?.payload as
                    { awarded: number; available: number; percent: number } | undefined;
                  if (!active || !entry) return null;
                  return (
                    <div className="rounded-lg border border-border bg-card px-3 py-2 text-xs shadow-sm">
                      <p className="font-medium text-foreground">
                        {entry.awarded} / {entry.available} marks
                      </p>
                      <p className="text-muted-foreground">{entry.percent}% weighted score</p>
                    </div>
                  );
                }}
              />
              <Bar dataKey="percent" radius={[0, 4, 4, 0]} maxBarSize={22}>
                {data.map((entry, index) => (
                  <Cell key={index} fill={entry.available > 0 ? BAR_COLOR : REVIEW_COLOR} />
                ))}
                <LabelList
                  dataKey="percent"
                  position="right"
                  formatter={(value: number) => `${value}%`}
                  style={{ fontSize: 10, fill: "#52657A" }}
                />
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        </div>
      )}
    </div>
  );
}
