import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

/**
 * Models occasionally emit LaTeX math markup even when told not to
 * (e.g. `$\text{Rs. } 195 \times \frac{150}{240}$`). react-markdown has no
 * math support, so it would render as literal backslash soup. Convert the
 * most common LaTeX constructs to plain readable text before rendering.
 */

/** Read a balanced {...} group starting at `start`; returns body and end index. */
function readBraceGroup(s: string, start: number): { body: string; end: number } | null {
  if (s[start] !== "{") return null;
  let depth = 0;
  for (let i = start; i < s.length; i++) {
    if (s[i] === "{") depth++;
    else if (s[i] === "}") {
      depth--;
      if (depth === 0) return { body: s.slice(start + 1, i), end: i + 1 };
    }
  }
  return null;
}

/** Replace the first \frac{a}{b} with "(a / b)". Nested fracs resolve by re-running. */
function replaceFirstFrac(s: string): string {
  const idx = s.indexOf("\\frac");
  if (idx === -1) return s;
  const num = readBraceGroup(s, idx + 5);
  if (!num) return s;
  const den = readBraceGroup(s, num.end);
  if (!den) return s;
  return s.slice(0, idx) + `(${num.body} / ${den.body})` + s.slice(den.end);
}

/** Convert the body of a math expression to plain text. */
function decodeMathBody(raw: string): string {
  let out = raw;
  // Resolve fractions (outermost first, nested ones on later passes).
  for (let i = 0; i < 12 && out.includes("\\frac"); i++) {
    out = replaceFirstFrac(out);
  }
  out = out
    .replace(/\\text\s*\{([^{}]*)\}/g, "$1")
    .replace(/\\mathrm\s*\{([^{}]*)\}/g, "$1")
    .replace(/\\operatorname\s*\{([^{}]*)\}/g, "$1")
    .replace(/\^\s*\{([^{}]*)\}/g, "^$1")
    .replace(/_\s*\{([^{}]*)\}/g, "_$1")
    .replace(/\\times/g, " × ")
    .replace(/\\cdot/g, " × ")
    .replace(/\\div/g, " ÷ ")
    .replace(/\\leq|\\le\b/g, " ≤ ")
    .replace(/\\geq|\\ge\b/g, " ≥ ")
    .replace(/\\neq?/g, " ≠ ")
    .replace(/\\approx/g, " ≈ ")
    .replace(/\\pm/g, "±")
    .replace(/\\%/g, "%")
    .replace(/\\\$/g, "$")
    .replace(/\\left|\\right/g, "")
    .replace(/\\[a-zA-Z]+\b/g, " ")
    .replace(/[{}]/g, "")
    .replace(/[ \t]{2,}/g, " ")
    .replace(/ ?\n ?/g, " ");
  return out.trim();
}

/** Strip math delimiters and decode their contents; leave ordinary text alone. */
export function decodeLatexToText(input: string): string {
  if (!input.includes("\\") && !input.includes("$")) return input;
  return input
    .replace(/\$\$([\s\S]+?)\$\$/g, (_, m) => decodeMathBody(m))
    .replace(/\$([^$\n]+?)\$/g, (_, m) => decodeMathBody(m))
    .replace(/\\\(([\s\S]+?)\\\)/g, (_, m) => decodeMathBody(m))
    .replace(/\\\[([\s\S]+?)\\\]/g, (_, m) => decodeMathBody(m));
}

export function Markdown({ children }: { children: string }) {
  return (
    <div className="min-w-0 text-[0.9375rem] leading-7 text-foreground">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          h1: (props) => (
            <h2
              className="mb-3 mt-8 border-b border-border pb-2 text-xl font-semibold text-foreground first:mt-0"
              {...props}
            />
          ),
          h2: (props) => (
            <h3
              className="mb-2 mt-7 border-l-2 border-primary pl-3 text-lg font-semibold text-foreground first:mt-0"
              {...props}
            />
          ),
          h3: (props) => (
            <h4 className="mb-2 mt-6 text-base font-semibold text-foreground first:mt-0" {...props} />
          ),
          p: (props) => <p className="my-3 text-foreground/90 first:mt-0 last:mb-0" {...props} />,
          ul: (props) => (
            <ul className="my-4 ml-5 list-disc space-y-2 marker:text-primary" {...props} />
          ),
          ol: (props) => (
            <ol className="my-4 ml-5 list-decimal space-y-2 marker:font-semibold marker:text-primary" {...props} />
          ),
          li: (props) => <li className="pl-1 text-foreground/90" {...props} />,
          strong: (props) => <strong className="font-semibold text-foreground" {...props} />,
          blockquote: (props) => (
            <blockquote
              className="my-4 border-l-2 border-primary bg-muted/60 px-4 py-3 text-muted-foreground"
              {...props}
            />
          ),
          code: (props) => (
            <code className="rounded bg-muted px-1.5 py-0.5 text-[0.8125rem] text-foreground" {...props} />
          ),
          table: (props) => (
            <div className="my-5 overflow-x-auto rounded-lg border border-border">
              <table className="w-full border-collapse text-sm" {...props} />
            </div>
          ),
          th: (props) => (
            <th
              className="border-b border-r border-border bg-muted px-3 py-2.5 text-left font-semibold text-foreground last:border-r-0"
              {...props}
            />
          ),
          td: (props) => (
            <td
              className="border-b border-r border-border px-3 py-2.5 align-top text-foreground/90 last:border-r-0"
              {...props}
            />
          ),
          hr: (props) => <hr className="my-6 border-border" {...props} />,
        }}
      >
        {decodeLatexToText(children)}
      </ReactMarkdown>
    </div>
  );
}
