import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

export function Markdown({ children }: { children: string }) {
  return (
    <div className="space-y-3 text-sm leading-relaxed text-foreground">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          h1: (props) => (
            <h2
              className="mt-6 border-b border-border pb-2 text-lg font-semibold text-foreground first:mt-0"
              {...props}
            />
          ),
          h2: (props) => (
            <h3 className="mt-5 text-base font-semibold text-foreground" {...props} />
          ),
          h3: (props) => <h4 className="mt-4 font-semibold text-foreground" {...props} />,
          p: (props) => <p className="text-sm leading-relaxed text-foreground/90" {...props} />,
          ul: (props) => <ul className="ml-5 list-disc space-y-1.5" {...props} />,
          ol: (props) => <ol className="ml-5 list-decimal space-y-1.5" {...props} />,
          strong: (props) => <strong className="font-semibold text-foreground" {...props} />,
          blockquote: (props) => (
            <blockquote
              className="border-l-2 border-primary/50 bg-muted/50 px-4 py-2 text-muted-foreground"
              {...props}
            />
          ),
          code: (props) => (
            <code className="rounded bg-muted px-1.5 py-0.5 text-xs text-foreground" {...props} />
          ),
          table: (props) => (
            <div className="overflow-x-auto">
              <table className="w-full border-collapse text-sm" {...props} />
            </div>
          ),
          th: (props) => (
            <th className="border border-border bg-muted px-3 py-2 text-left font-semibold" {...props} />
          ),
          td: (props) => <td className="border border-border px-3 py-2 align-top" {...props} />,
        }}
      >
        {children}
      </ReactMarkdown>
    </div>
  );
}
