import { useState } from "react";
import { toast } from "sonner";
import { Copy, Sparkles, ThumbsDown, ThumbsUp } from "lucide-react";
import { cn } from "@/lib/utils";
import { Markdown } from "@/components/study/Markdown";

/**
 * Presentational wrapper around a finished answer: header actions (copy /
 * feedback) plus a small footer with generation metadata. It only reads the
 * already-produced `answer` text — it has no involvement in producing it.
 */
export function AnswerCard({
  answer,
  streaming,
  sourceCount,
  answerLength,
  children,
}: {
  answer: string;
  streaming?: boolean | undefined;
  sourceCount?: number | undefined;
  answerLength?: "short" | "medium" | "long" | undefined;
  children?: React.ReactNode;
}) {
  const [vote, setVote] = useState<"up" | "down" | null>(null);

  async function copy() {
    try {
      await navigator.clipboard.writeText(answer);
      toast.success("Copied to clipboard");
    } catch {
      toast.error("Could not copy");
    }
  }

  return (
    <div className="rounded-xl border border-border bg-card p-5">
      <div className="flex items-center justify-between gap-3">
        <span className="flex items-center gap-2 text-sm font-semibold text-foreground">
          <Sparkles className="h-4 w-4 text-primary" />
          Answer
        </span>
        <div className="flex items-center gap-1.5">
          <button
            type="button"
            onClick={copy}
            title="Copy"
            className="flex h-7 w-7 items-center justify-center rounded-md border border-border text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
          >
            <Copy className="h-3.5 w-3.5" />
          </button>
          <button
            type="button"
            onClick={() => setVote((v) => (v === "up" ? null : "up"))}
            title="Good answer"
            className={cn(
              "flex h-7 w-7 items-center justify-center rounded-md border transition-colors",
              vote === "up"
                ? "border-primary bg-primary/10 text-primary"
                : "border-border text-muted-foreground hover:bg-muted hover:text-foreground",
            )}
          >
            <ThumbsUp className="h-3.5 w-3.5" />
          </button>
          <button
            type="button"
            onClick={() => setVote((v) => (v === "down" ? null : "down"))}
            title="Needs work"
            className={cn(
              "flex h-7 w-7 items-center justify-center rounded-md border transition-colors",
              vote === "down"
                ? "border-destructive bg-destructive/10 text-destructive"
                : "border-border text-muted-foreground hover:bg-muted hover:text-foreground",
            )}
          >
            <ThumbsDown className="h-3.5 w-3.5" />
          </button>
        </div>
      </div>

      <div className="mt-3">
        <Markdown>{answer}</Markdown>
        {streaming && (
          <span className="ml-0.5 inline-block h-4 w-1.5 animate-pulse bg-foreground align-text-bottom" />
        )}
      </div>

      {!streaming && (sourceCount !== undefined || answerLength) && (
        <div className="mt-4 flex flex-wrap items-center gap-x-4 gap-y-1 border-t border-border pt-3 text-xs text-muted-foreground">
          {sourceCount !== undefined && (
            <span>
              Answer generated from {sourceCount} source{sourceCount === 1 ? "" : "s"}
            </span>
          )}
          {answerLength && <span className="capitalize">Answer length: {answerLength}</span>}
          <span className="ml-auto flex items-center gap-1.5">
            Generated just now
            <span className="h-1.5 w-1.5 rounded-full bg-emerald-500" />
          </span>
        </div>
      )}

      {children}
    </div>
  );
}
