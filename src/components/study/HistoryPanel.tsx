import { useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { toast } from "sonner";
import { Check, FileDown, FileText } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { Badge } from "@/components/ui/badge";
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from "@/components/ui/accordion";
import { Markdown } from "@/components/study/Markdown";
import { exportHistoryToPdf, type HistoryExportEntry } from "@/lib/export-pdf";
import { exportHistoryToWord } from "@/lib/export-docx";
import { cn } from "@/lib/utils";

type Entry = {
  id: string;
  mode: string;
  question: string;
  response: string;
  created_at: string;
};

/** "XYZ Limited" / "ABC (Pvt) Ltd" style entity name, or null. */
function entityName(question: string): string | null {
  const m = question.match(
    /(?:^|\n)\s*([A-Z][A-Za-z0-9&.'’()\s,]{1,60}?(?:Ltd\.?|Limited|Pvt\.?\s*Ltd\.?|Private Limited|LLP|PLC|Pte\.?\s*Ltd\.?|Company|Corporation|Corp\.?|Inc\.?))\b/,
  );
  const name = m?.[1];
  return name ? name.trim().replace(/[,;:.\s]+$/, "") : null;
}

function firstLine(question: string): string {
  const line = question
    .split("\n")
    .map((l) => l.trim())
    .find((l) => l.length > 1);
  return line ?? "Question";
}

/** Topic area signalled by the "Required:" line, or null. */
function areaFromQuestion(question: string): string | null {
  const m = question.match(
    /(?:Required|REQUIRED|Requirement)\s*[:-]?\s*(?:\(?[a-z0-9]+\)?\.?\s*)?([^\n]{0,80})/i,
  );
  const raw = m?.[1];
  if (!raw) return null;
  const area = raw.trim().replace(/[,;:.\s]+$/, "");
  return area ? area.slice(0, 60) : null;
}

/** Marking entries carry a "**Question title:** Name (Area)" line from the marker. */
function markLabel(entry: Entry): string {
  const parsed = entry.response.match(/\*\*Question title:\*\*\s*(.+)/i);
  if (parsed?.[1]?.trim()) return parsed[1].trim();
  const name = entityName(entry.question) ?? firstLine(entry.question);
  const area = areaFromQuestion(entry.question);
  return area ? `${name} (${area})` : name;
}

export function HistoryPanel({
  subjectId,
  mode,
  subjectName = "Notebook",
}: {
  subjectId: string;
  mode?: "ask" | "mark";
  subjectName?: string;
}) {
  const [checked, setChecked] = useState<Set<string>>(new Set());
  const [exporting, setExporting] = useState<"pdf" | "word" | null>(null);

  const { data: entries = [], refetch } = useQuery({
    queryKey: ["qa", subjectId, mode ?? "all"],
    queryFn: async () => {
      let query = supabase
        .from("qa_entries")
        .select("id, mode, question, response, created_at")
        .eq("subject_id", subjectId);
      if (mode === "mark") query = query.eq("mode", "mark");
      else if (mode === "ask") query = query.in("mode", ["ask", "exam"]);
      const { data, error } = await query.order("created_at", { ascending: false }).limit(50);
      if (error) throw error;
      return data as Entry[];
    },
  });

  useEffect(() => {
    const onUpdate = () => void refetch();
    window.addEventListener("study-history-updated", onUpdate);
    return () => window.removeEventListener("study-history-updated", onUpdate);
  }, [refetch]);

  // Drop selections for entries that no longer exist.
  const validIds = useMemo(() => new Set(entries.map((e) => e.id)), [entries]);
  useEffect(() => {
    setChecked((prev) => {
      const next = new Set([...prev].filter((id) => validIds.has(id)));
      return next.size === prev.size ? prev : next;
    });
  }, [validIds]);

  function toggle(id: string) {
    setChecked((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  const selected = entries.filter((e) => checked.has(e.id));

  function buildExport(): HistoryExportEntry[] {
    return selected.map((e) => ({
      title: e.mode === "mark" ? markLabel(e) : firstLine(e.question),
      question: e.question,
      answer: e.response,
      date: new Date(e.created_at).toLocaleString(undefined, {
        dateStyle: "medium",
        timeStyle: "short",
      }),
    }));
  }

  async function exportPdf() {
    if (selected.length === 0) return;
    setExporting("pdf");
    try {
      exportHistoryToPdf({
        notebook: subjectName,
        title: mode === "mark" ? "Marking history" : "Ask history",
        entries: buildExport(),
      });
    } catch {
      toast.error("Could not build the PDF");
    } finally {
      setExporting(null);
    }
  }

  async function exportWord() {
    if (selected.length === 0) return;
    setExporting("word");
    try {
      await exportHistoryToWord({
        notebook: subjectName,
        title: mode === "mark" ? "Marking history" : "Ask history",
        entries: buildExport(),
      });
    } catch {
      toast.error("Could not build the Word file");
    } finally {
      setExporting(null);
    }
  }

  if (entries.length === 0) {
    return (
      <p className="rounded-lg border border-border bg-card p-10 text-center text-sm text-muted-foreground">
        {mode === "mark"
          ? "No marked attempts yet — they are saved here automatically."
          : "No questions yet — everything you ask is saved here automatically."}
      </p>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-sm text-muted-foreground">
          {checked.size} of {entries.length} selected
        </span>
        <div className="ml-auto flex flex-wrap items-center gap-2">
          <button
            type="button"
            className="text-xs font-medium text-muted-foreground hover:text-foreground"
            onClick={() =>
              setChecked(
                checked.size === entries.length ? new Set() : new Set(entries.map((e) => e.id)),
              )
            }
          >
            {checked.size === entries.length ? "Clear all" : "Select all"}
          </button>
          <button
            type="button"
            disabled={selected.length === 0 || exporting !== null}
            onClick={() => void exportPdf()}
            className="flex items-center gap-1.5 rounded-lg border border-border px-3 py-1.5 text-sm font-medium text-foreground transition-colors hover:bg-muted disabled:cursor-not-allowed disabled:opacity-50"
          >
            <FileText className="h-4 w-4" />
            {exporting === "pdf" ? "Preparing…" : "Export PDF"}
          </button>
          <button
            type="button"
            disabled={selected.length === 0 || exporting !== null}
            onClick={() => void exportWord()}
            className="flex items-center gap-1.5 rounded-lg border border-border px-3 py-1.5 text-sm font-medium text-foreground transition-colors hover:bg-muted disabled:cursor-not-allowed disabled:opacity-50"
          >
            <FileDown className="h-4 w-4" />
            {exporting === "word" ? "Preparing…" : "Export Word"}
          </button>
        </div>
      </div>

      <Accordion type="single" collapsible className="rounded-lg border border-border bg-card px-4">
        {entries.map((entry) => {
          const label = entry.mode === "mark" ? markLabel(entry) : firstLine(entry.question);
          const isChecked = checked.has(entry.id);
          return (
            <AccordionItem key={entry.id} value={entry.id}>
              <AccordionTrigger className="text-left">
                <span className="flex min-w-0 flex-1 items-center gap-3">
                  <span
                    role="checkbox"
                    aria-checked={isChecked}
                    title="Select for export"
                    onClick={(e) => {
                      e.stopPropagation();
                      e.preventDefault();
                      toggle(entry.id);
                    }}
                    className={cn(
                      "flex h-4 w-4 shrink-0 items-center justify-center rounded border",
                      isChecked
                        ? "border-primary bg-primary text-primary-foreground"
                        : "border-border bg-card",
                    )}
                  >
                    {isChecked && <Check className="h-3 w-3" />}
                  </span>
                  <Badge
                    variant={entry.mode === "mark" ? "default" : "secondary"}
                    className="shrink-0"
                  >
                    {entry.mode === "mark" ? "Marked" : entry.mode === "exam" ? "Exam" : "Answer"}
                  </Badge>
                  <span className="min-w-0 flex-1 truncate text-sm font-medium">{label}</span>
                  <span className="ml-auto shrink-0 text-xs text-muted-foreground">
                    {new Date(entry.created_at).toLocaleDateString()}
                  </span>
                </span>
              </AccordionTrigger>
              <AccordionContent>
                <Markdown>{entry.response}</Markdown>
              </AccordionContent>
            </AccordionItem>
          );
        })}
      </Accordion>
    </div>
  );
}
