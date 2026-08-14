import { useEffect, useState } from "react";

const PHASES = [
  "Reading your sources…",
  "Searching for the exact term and its synonyms…",
  "Cross-checking figures across documents…",
  "Linking related passages…",
  "Verifying every number against the source line…",
  "Concluding…",
];

/** Shows what the model is doing while the first tokens are still on the way. */
export function ThinkingStatus({ label }: { label?: string }) {
  const [index, setIndex] = useState(0);

  useEffect(() => {
    const timer = setInterval(() => {
      setIndex((i) => (i < PHASES.length - 1 ? i + 1 : i));
    }, 1600);
    return () => clearInterval(timer);
  }, []);

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2 text-sm text-muted-foreground">
        <span className="flex gap-1">
          <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-primary [animation-delay:-0.3s]" />
          <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-primary [animation-delay:-0.15s]" />
          <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-primary" />
        </span>
        <span>{label ?? PHASES[index]}</span>
      </div>
      <ul className="space-y-1 text-xs text-muted-foreground/80">
        {PHASES.slice(0, index).map((phase) => (
          <li key={phase} className="flex items-center gap-2">
            <span className="text-primary">✓</span>
            <span className="line-through decoration-muted-foreground/40">{phase}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}
