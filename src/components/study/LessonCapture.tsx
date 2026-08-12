import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";

export function LessonCapture({ subjectId }: { subjectId: string }) {
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const [content, setContent] = useState("");

  const save = useMutation({
    mutationFn: async () => {
      const { data: userData } = await supabase.auth.getUser();
      if (!userData.user) throw new Error("Not signed in");
      const { error } = await supabase.from("learning_notes").insert({
        user_id: userData.user.id,
        subject_id: subjectId,
        content: content.trim(),
      });
      if (error) throw error;
    },
    onSuccess: () => {
      toast.success("Saved. The assistant will not repeat this mistake.");
      setContent("");
      setOpen(false);
      queryClient.invalidateQueries({ queryKey: ["lessons", subjectId] });
    },
    onError: () => toast.error("Could not save this correction"),
  });

  return (
    <div className="mt-6 border-t border-border pt-4">
      {open ? (
        <div className="space-y-3">
          <Textarea
            value={content}
            onChange={(e) => setContent(e.target.value)}
            placeholder="Highlight what was wrong or missing, e.g. 'Always state whether the client is a PIE before applying rotation rules.'"
            className="min-h-24"
          />
          <div className="flex gap-2">
            <Button
              size="sm"
              onClick={() => save.mutate()}
              disabled={save.isPending || content.trim().length < 5}
            >
              Save correction
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setOpen(false)}>
              Cancel
            </Button>
          </div>
        </div>
      ) : (
        <Button size="sm" variant="outline" onClick={() => setOpen(true)}>
          Highlight a mistake in this response
        </Button>
      )}
    </div>
  );
}
