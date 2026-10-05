import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { decodeLatexToText } from "@/lib/latex";


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
