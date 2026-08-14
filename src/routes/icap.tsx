import { createFileRoute, Link } from "@tanstack/react-router";
import { Button } from "@/components/ui/button";

export const Route = createFileRoute("/icap")({
  head: () => ({
    meta: [
      { title: "ICAP Exam Tool — CFAP Self-Study Marking Gutter" },
      {
        name: "description",
        content:
          "ICAP CFAP self-study workspace (Scheme 2025): practise questions, self-mark against the official scheme and track your examiner-style feedback.",
      },
      { property: "og:title", content: "ICAP Exam Tool — CFAP Self-Study Marking Gutter" },
      {
        property: "og:description",
        content:
          "Practise and self-mark ICAP CFAP questions under Scheme 2025 with examiner-style feedback.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary_large_image" },
    ],
  }),
  component: IcapToolPage,
});

function IcapToolPage() {
  return (
    <main className="flex min-h-screen flex-col bg-background">
      <header className="border-b border-border bg-card">
        <div className="mx-auto flex max-w-6xl flex-wrap items-center justify-between gap-4 px-6 py-4">
          <div>
            <p className="text-[11px] font-semibold uppercase tracking-[0.2em] text-primary">
              Study Desk
            </p>
            <h1 className="mt-0.5 text-lg font-semibold text-foreground">ICAP exam tool</h1>
          </div>
          <div className="flex items-center gap-2">
            <Button asChild variant="ghost" size="sm">
              <Link to="/">← Notebooks</Link>
            </Button>
            <Button asChild variant="outline" size="sm">
              <a href="/icap-tool.html" target="_blank" rel="noreferrer">
                Open full screen
              </a>
            </Button>
          </div>
        </div>
      </header>

      <iframe
        src="/icap-tool.html"
        title="ICAP CFAP self-study tool (Scheme 2025)"
        className="min-h-[calc(100vh-73px)] w-full flex-1 border-0"
      />
    </main>
  );
}
