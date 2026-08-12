import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { LessonCapture } from "@/components/study/LessonCapture";

type Lesson = { id: string; content: string; created_at: string };

export function LessonsPanel({ subjectId }: { subjectId: string }) {
  const queryClient = useQueryClient();

  const { data: lessons = [] } = useQuery({
    queryKey: ["lessons", subjectId],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("learning_notes")
        .select("id, content, created_at")
        .eq("subject_id", subjectId)
        .order("created_at", { ascending: false });
      if (error) throw error;
      return data as Lesson[];
    },
  });

  const remove = useMutation({
    mutationFn: async (id: string) => {
      const { error } = await supabase.from("learning_notes").delete().eq("id", id);
      if (error) throw error;
    },
    onSuccess: () => {
      toast.success("Correction removed");
      queryClient.invalidateQueries({ queryKey: ["lessons", subjectId] });
    },
  });

  return (
    <div className="space-y-6">
      <div className="rounded-lg border border-border bg-card p-5">
        <h2 className="text-base font-semibold text-foreground">Lessons learned</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          Every correction below is injected into future answers and marking for this subject, so
          the same mistake is not repeated.
        </p>
        <LessonCapture subjectId={subjectId} />
      </div>

      <div className="overflow-hidden rounded-lg border border-border bg-card">
        {lessons.length === 0 ? (
          <p className="p-10 text-center text-sm text-muted-foreground">
            No corrections recorded yet.
          </p>
        ) : (
          <ul className="divide-y divide-border">
            {lessons.map((lesson) => (
              <li key={lesson.id} className="flex items-start gap-4 px-4 py-3">
                <p className="flex-1 text-sm text-foreground">{lesson.content}</p>
                <Button
                  variant="ghost"
                  size="sm"
                  className="text-destructive"
                  onClick={() => remove.mutate(lesson.id)}
                >
                  Remove
                </Button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
