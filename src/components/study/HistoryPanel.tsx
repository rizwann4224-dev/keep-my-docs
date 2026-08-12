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

export function HistoryPanel({ subjectId }: { subjectId: string }) {
  const { data: entries = [] } = useQuery({
    queryKey: ["qa", subjectId],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("qa_entries")
        .select("id, mode, question, response, created_at")
        .eq("subject_id", subjectId)
        .order("created_at", { ascending: false })
        .limit(50);
      if (error) throw error;
      return data as Entry[];
    },
  });

  if (entries.length === 0) {
    return (
      <p className="rounded-lg border border-border bg-card p-10 text-center text-sm text-muted-foreground">
        Nothing here yet. Answers and marked attempts are saved automatically.
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
                {entry.mode === "mark" ? "Marked" : "Answer"}
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
