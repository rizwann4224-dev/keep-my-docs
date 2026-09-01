import { useEffect, useState } from "react";
import { CheckCircle2, Loader2, Circle, Sparkles } from "lucide-react";
import { cn } from "@/lib/utils";

export const ASK_STEPS = [
  "Understanding your question",
  "Searching relevant content in your sources",
  "Analyzing and generating answer",
  "Finalizing answer",
];

export const MARK_STEPS = (rigourLabel = "Strict") => [
  "Reading question and answer",
  `Applying marking standard (${rigourLabel})`,
  "Evaluating each point",
  "Calculating marks",
  "Generating feedback and suggestions",
];

export const GENERIC_STEPS = [
  "Reading your sources",
  "Cross-checking the details",
  "Putting the response together",
];

/**
 * Live progress indicator shown only while a run is in flight — the moment the
 * real answer starts arriving, the parent unmounts this and nothing here lingers.
 * The step list advances on a timer purely for visual feedback; it never blocks
 * or delays the actual response, which can finish (and replace this) at any time.
 */
export function ThinkingStatus({
  title = "Generating answer…",
  subtitle = "This may take a few seconds",
  meta = "Thinking with your sources…",
  steps = ASK_STEPS,
}: {
  title?: string;
  subtitle?: string;
  meta?: string;
  steps?: string[];
}) {
  const [index, setIndex] = useState(0);

  useEffect(() => {
    setIndex(0);
    const timer = setInterval(() => {
      setIndex((i) => (i < steps.length - 1 ? i + 1 : i));
    }, 1400);
    return () => clearInterval(timer);
  }, [steps.length]);

  const percent = Math.min(96, Math.round(((index + 0.5) / steps.length) * 100));

  return (
    <div className="space-y-4" role="status" aria-live="polite">
      <div className="flex items-start justify-between gap-3">
        <div className="flex items-center gap-3">
          <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-primary text-primary-foreground">
            <Sparkles className="h-4 w-4 animate-pulse" />
          </span>
          <div>
            <p className="text-sm font-semibold text-foreground">{title}</p>
            <p className="text-xs text-muted-foreground">{subtitle}</p>
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-1.5 pt-1.5 text-xs text-muted-foreground">
          <span className="hidden sm:inline">{meta}</span>
          <span className="flex gap-1">
            <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-primary [animation-delay:-0.3s]" />
            <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-primary [animation-delay:-0.15s]" />
            <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-primary" />
          </span>
        </div>
      </div>

      <div className="h-1.5 w-full overflow-hidden rounded-full bg-muted">
        <div
          className="h-full rounded-full bg-primary transition-[width] duration-700 ease-out"
          style={{ width: `${percent}%` }}
        />
      </div>

      <ul className="space-y-2.5">
        {steps.map((step, i) => {
          const state = i < index ? "done" : i === index ? "active" : "pending";
          return (
            <li key={step} className="flex items-center justify-between gap-3 text-sm">
              <span className="flex items-center gap-2.5">
                {state === "done" && <CheckCircle2 className="h-4 w-4 shrink-0 text-emerald-500" />}
                {state === "active" && (
                  <Loader2 className="h-4 w-4 shrink-0 animate-spin text-primary" />
                )}
                {state === "pending" && (
                  <Circle className="h-4 w-4 shrink-0 text-muted-foreground/40" />
                )}
                <span
                  className={cn("text-foreground", state === "pending" && "text-muted-foreground")}
                >
                  {step}
                </span>
              </span>
              <span
                className={cn(
                  "shrink-0 rounded-full px-2 py-0.5 text-[11px] font-medium",
                  state === "done" && "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400",
                  state === "active" && "bg-primary/10 text-primary",
                  state === "pending" && "bg-muted text-muted-foreground",
                )}
              >
                {state === "done" ? "Completed" : state === "active" ? "In progress" : "Pending"}
              </span>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
