import {
  BarChart3,
  BookOpen,
  CheckCircle2,
  ChevronsLeft,
  ChevronsRight,
  FileText,
  History,
  Moon,
  Sun,
  Target,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { useDarkMode } from "@/hooks/useDarkMode";

export type StudyTab =
  "ask" | "mark" | "performance" | "documents" | "lessons" | "history" | "mark-history";

const NAV_ITEMS: {
  id: StudyTab;
  label: string;
  description: string;
  icon: typeof CheckCircle2;
}[] = [
  { id: "ask", label: "Ask", description: "Get answers from your notebooks", icon: CheckCircle2 },
  { id: "mark", label: "Answer & marking", description: "Mark your answers", icon: CheckCircle2 },
  {
    id: "performance",
    label: "Strengths & weak areas",
    description: "See your trends",
    icon: BarChart3,
  },
  { id: "documents", label: "Sources", description: "Your uploaded material", icon: FileText },
  { id: "lessons", label: "Lessons learned", description: "Corrections you saved", icon: BookOpen },
  { id: "history", label: "Ask history", description: "Everything you asked", icon: History },
  {
    id: "mark-history",
    label: "Marking history",
    description: "Everything you marked",
    icon: Target,
  },
];

/**
 * Purely presentational left-hand navigation. It only reads/writes the `tab`
 * state that already exists in the parent route — it does not touch any
 * response, streaming, or job logic.
 *
 * Light mode matches the Study Desk reference design: a soft neutral-grey
 * rail with dark navy text and a grey chip on the active item. Dark mode
 * keeps the original navy palette.
 */
export function StudyDeskSidebar({
  tab,
  onSelect,
  collapsed,
  onToggleCollapsed,
}: {
  tab: string;
  onSelect: (tab: StudyTab) => void;
  collapsed: boolean;
  onToggleCollapsed: () => void;
}) {
  const { dark, toggle } = useDarkMode();

  return (
    <aside
      className={cn(
        "sticky top-0 flex h-screen shrink-0 flex-col justify-between transition-[width] duration-200",
        dark
          ? "bg-[#0b1830] text-slate-200"
          : "border-r border-[#e3e8f0] bg-[#f7f8fa] text-[#52657a]",
        collapsed ? "w-[76px]" : "w-[264px]",
      )}
    >
      <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
        <div className="flex items-center gap-3 px-5 py-5">
          <span
            className={cn(
              "flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border text-sm font-semibold",
              dark
                ? "border-white/15 bg-white/5 text-white"
                : "border-[#d9e3f0] bg-white text-[#142b4a]",
            )}
          >
            S
          </span>
          {!collapsed && (
            <span
              className={cn(
                "truncate text-base font-semibold",
                dark ? "text-white" : "text-[#142b4a]",
              )}
            >
              Study Desk
            </span>
          )}
        </div>

        <nav className="mt-2 flex flex-col gap-1 px-3">
          {NAV_ITEMS.map((item) => {
            const active = tab === item.id;
            const Icon = item.icon;
            return (
              <button
                key={item.id}
                type="button"
                onClick={() => onSelect(item.id)}
                title={collapsed ? item.label : undefined}
                aria-current={active ? "page" : undefined}
                className={cn(
                  "flex items-center gap-3 rounded-xl px-3 py-2.5 text-left transition-colors",
                  active
                    ? dark
                      ? "bg-primary text-primary-foreground shadow-sm"
                      : "bg-[#e9ecf1] text-[#142b4a]"
                    : dark
                      ? "text-slate-300 hover:bg-white/5 hover:text-white"
                      : "text-[#334155] hover:bg-[#edf0f4] hover:text-[#142b4a]",
                )}
              >
                <span
                  className={cn(
                    "flex h-8 w-8 shrink-0 items-center justify-center rounded-full border",
                    active
                      ? dark
                        ? "border-primary-foreground/40 bg-white/15 text-primary-foreground"
                        : "border-[#d9e3f0] bg-[#e0e5ec] text-[#142b4a]"
                      : dark
                        ? "border-white/15 bg-white/5 text-slate-300"
                        : "border-transparent bg-transparent text-[#8a97a8]",
                  )}
                >
                  <Icon className="h-4 w-4" />
                </span>
                {!collapsed && (
                  <span className="min-w-0">
                    <span className="block truncate text-sm font-semibold">{item.label}</span>
                    <span
                      className={cn(
                        "block truncate text-xs",
                        active
                          ? dark
                            ? "text-primary-foreground/80"
                            : "text-[#52657a]"
                          : dark
                            ? "text-slate-400"
                            : "text-[#64748b]",
                      )}
                    >
                      {item.description}
                    </span>
                  </span>
                )}
              </button>
            );
          })}
        </nav>
      </div>

      <div
        className={cn("shrink-0 border-t px-3 py-4", dark ? "border-white/10" : "border-[#e3e8f0]")}
      >
        <div
          className={cn(
            "flex items-center gap-3 rounded-xl px-2 py-2",
            collapsed && "justify-center",
          )}
        >
          {dark ? (
            <Moon className="h-4 w-4 shrink-0 text-slate-300" />
          ) : (
            <Sun className="h-4 w-4 shrink-0 text-[#52657a]" />
          )}
          {!collapsed && (
            <span className={cn("flex-1 text-sm", dark ? "text-slate-200" : "text-[#334155]")}>
              Dark mode
            </span>
          )}
          <button
            type="button"
            role="switch"
            aria-checked={dark}
            aria-label="Toggle dark mode"
            onClick={toggle}
            className={cn(
              "relative inline-flex h-5 w-9 shrink-0 items-center rounded-full transition-colors",
              dark ? "bg-primary" : "bg-[#d3dae3]",
            )}
          >
            <span
              className={cn(
                "inline-block h-4 w-4 transform rounded-full bg-white transition-transform",
                dark ? "translate-x-4" : "translate-x-0.5",
              )}
            />
          </button>
        </div>

        <button
          type="button"
          onClick={onToggleCollapsed}
          className={cn(
            "mt-2 flex w-full items-center justify-center gap-2 rounded-lg px-2 py-2 text-xs",
            dark
              ? "text-slate-400 hover:bg-white/5 hover:text-white"
              : "text-[#64748b] hover:bg-[#edf0f4] hover:text-[#142b4a]",
          )}
        >
          {collapsed ? <ChevronsRight className="h-4 w-4" /> : <ChevronsLeft className="h-4 w-4" />}
          {!collapsed && <span>Collapse</span>}
        </button>
      </div>
    </aside>
  );
}
