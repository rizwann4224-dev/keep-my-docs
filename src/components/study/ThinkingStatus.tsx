import { useEffect, useRef, useState } from "react";
import { Sparkles, CheckCircle2, Loader2, Circle } from "lucide-react";
import { cn } from "@/lib/utils";

const DEFAULT_STEPS = [
  "Understanding your question",
  "Searching relevant content in your sources",
  "Analyzing and generating answer",
  "Finalizing answer",
];

type StepStatus = "done" | "active" | "pending";

/**
 * Purely cosmetic, client-side progress indicator shown while a model run is
 * in flight. It has no knowledge of — and no effect on — the actual request,
 * streaming, or response timing: it just animates locally in real time and is
 * unmounted the instant the parent has something to show (first token / done),
 * which removes the whole card immediately.
 */
export function ThinkingStatus({
  title = "Generating answer…",
  subtitle = "This may take a few seconds",
  kicker = "Thinking with your sources…",
  steps = DEFAULT_STEPS,
}: {
  title?: string;
  subtitle?: string;
  kicker?: string;
  steps?: string[];
}) {
  const [progress, setProgress] = useState(0);
  const startRef = useRef<number>(Date.now());

  useEffect(() => {
    startRef.current = Date.now();
    // Ease toward ~92% and hold — real completion happens by the parent
    // unmounting this component once the answer is ready, so the bar never
    // has to "guess" the true finish time.
    const timer = setInterval(() => {
      const elapsed = Date.now() - startRef.current;
      const eased = 1 - Math.exp(-elapsed / 3200);
      setProgress(Math.min(0.92, eased));
    }, 80);
    return () => clearInterval(timer);
  }, []);

  const stepCount = steps.length;
  const activeIndex = Math.min(stepCount - 1, Math.floor(progress * stepCount));

  const statuses: StepStatus[] = steps.map((_, i) => {
    if (i < activeIndex) return "done";
    if (i === activeIndex) return "active";
    return "pending";
  });

  return (
    <div className="rounded-xl border border-border bg-card p-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex items-start gap-3">
          <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-primary text-primary-foreground">
            <Sparkles className="h-4 w-4 animate-pulse" />
          </span>
          <div>
            <p className="text-sm font-semibold text-foreground">{title}</p>
            <p className="text-xs text-muted-foreground">{subtitle}</p>
          </div>
        </div>
        <div className="flex items-center gap-1.5 pt-1 text-xs text-muted-foreground">
          <span>{kicker}</span>
          <span className="flex gap-1">
            <span className="h-1 w-1 animate-bounce rounded-full bg-primary [animation-delay:-0.3s]" />
            <span className="h-1 w-1 animate-bounce rounded-full bg-primary [animation-delay:-0.15s]" />
            <span className="h-1 w-1 animate-bounce rounded-full bg-primary" />
          </span>
        </div>
      </div>

      <div className="mt-4 h-1.5 w-full overflow-hidden rounded-full bg-muted">
        <div
          className="h-full rounded-full bg-primary transition-[width] duration-200 ease-out"
          style={{ width: `${Math.round(progress * 100)}%` }}
        />
      </div>

      <ul className="mt-4 space-y-2.5">
        {steps.map((step, i) => {
          const status = statuses[i] ?? "pending";
          return (
            <li key={step} className="flex items-center justify-between gap-3 text-sm">
              <span className="flex min-w-0 items-center gap-2.5">
                <StepIcon status={status} />
                <span
                  className={cn(
                    "truncate",
                    status === "pending" ? "text-muted-foreground" : "text-foreground",
                  )}
                >
                  {step}
                </span>
              </span>
              <StepBadge status={status} />
            </li>
          );
        })}
      </ul>
    </div>
  );
}

function StepIcon({ status }: { status: StepStatus }) {
  if (status === "done") return <CheckCircle2 className="h-4 w-4 shrink-0 text-emerald-500" />;
  if (status === "active")
    return <Loader2 className="h-4 w-4 shrink-0 animate-spin text-primary" />;
  return <Circle className="h-4 w-4 shrink-0 text-muted-foreground/40" />;
}

function StepBadge({ status }: { status: StepStatus }) {
  if (status === "done")
    return (
      <span className="shrink-0 rounded-full bg-emerald-500/10 px-2 py-0.5 text-[11px] font-medium text-emerald-600 dark:text-emerald-400">
        Completed
      </span>
    );
  if (status === "active")
    return (
      <span className="shrink-0 rounded-full bg-primary/10 px-2 py-0.5 text-[11px] font-medium text-primary">
        In progress
      </span>
    );
  return (
    <span className="shrink-0 rounded-full bg-muted px-2 py-0.5 text-[11px] font-medium text-muted-foreground">
      Pending
    </span>
  );
}
