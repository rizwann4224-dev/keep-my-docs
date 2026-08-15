import { useEffect } from "react";
import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { Badge } from "@/components/ui/badge";
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from "@/components/ui/accordion";
import { Markdown } from "@/components/study/Markdown";

type Entry = {
  id: string;
  mode: string;
  question: string;
  response: string;
  created_at: string;
};

export function HistoryPanel({
  subjectId,
  mode,
}: {
  subjectId: string;
  mode?: "ask" | "mark";
}) {
  const { data: entries = [] } = useQuery({
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
    <Accordion type="single" collapsible className="rounded-lg border border-border bg-card px-4">
      {entries.map((entry) => (
        <AccordionItem key={entry.id} value={entry.id}>
          <AccordionTrigger className="text-left">
            <span className="flex min-w-0 flex-1 items-center gap-3">
              <Badge variant={entry.mode === "mark" ? "default" : "secondary"}>
                {entry.mode === "mark" ? "Marked" : entry.mode === "exam" ? "Exam" : "Answer"}
              </Badge>
              <span className="truncate text-sm font-medium">{entry.question}</span>
              <span className="ml-auto shrink-0 text-xs text-muted-foreground">
                {new Date(entry.created_at).toLocaleDateString()}
              </span>
            </span>
          </AccordionTrigger>
          <AccordionContent>
            <Markdown>{entry.response}</Markdown>
          </AccordionContent>
        </AccordionItem>
      ))}
    </Accordion>
  );
}
