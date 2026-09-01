import {
  CheckCircle2,
  FileText,
  BarChart3,
  BookOpen,
  History,
  Target,
  ChevronsLeft,
  ChevronsRight,
  Moon,
  Sun,
} from "lucide-react";
import { useState } from "react";
import { Switch } from "@/components/ui/switch";
import { useDarkMode } from "@/hooks/useDarkMode";
import { cn } from "@/lib/utils";

export type WorkspaceTab =
  "ask" | "mark" | "performance" | "documents" | "lessons" | "history" | "mark-history";

const NAV_ITEMS: {
  id: WorkspaceTab;
  label: string;
  hint: string;
  icon: typeof CheckCircle2;
}[] = [
  { id: "ask", label: "Ask", hint: "Get answers from your notebooks", icon: CheckCircle2 },
  { id: "mark", label: "Answer & marking", hint: "Mark your answers", icon: CheckCircle2 },
  { id: "performance", label: "Strengths & weak areas", hint: "See your trends", icon: BarChart3 },
  { id: "documents", label: "Sources", hint: "Manage your uploads", icon: FileText },
  { id: "lessons", label: "Lessons learned", hint: "Corrections you saved", icon: BookOpen },
  { id: "history", label: "Ask history", hint: "Past questions", icon: History },
  { id: "mark-history", label: "Marking history", hint: "Past evaluations", icon: Target },
];

/**
 * Left-hand notebook navigation styled after the reference design. This is a
 * presentational replacement for the previous horizontal TabsList — it drives
 * the exact same `tab` state/values, so nothing about how panels fetch or
 * stream their answers changes.
 */
export function WorkspaceSidebar({
  tab,
  onTabChange,
  notebookName,
}: {
  tab: WorkspaceTab;
  onTabChange: (tab: WorkspaceTab) => void;
  notebookName: string;
}) {
  const [collapsed, setCollapsed] = useState(false);
  const { dark, toggle } = useDarkMode();

  return (
    <aside
      className={cn(
        "sticky top-4 flex h-fit shrink-0 flex-col justify-between rounded-2xl bg-[#0b1a33] p-3 text-slate-200 transition-[width] duration-200",
        collapsed ? "w-[76px]" : "w-64",
      )}
    >
      <div>
        <div className="flex items-center gap-2.5 px-2 py-2">
          <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border border-slate-600/60 text-sm font-semibold text-white">
            {notebookName.trim().charAt(0).toUpperCase() || "N"}
          </span>
          {!collapsed && (
            <span className="truncate text-sm font-semibold text-white">{notebookName}</span>
          )}
        </div>

        <nav className="mt-3 space-y-1.5">
          {NAV_ITEMS.map((item) => {
            const active = tab === item.id;
            const Icon = item.icon;
            return (
              <button
                key={item.id}
                type="button"
                onClick={() => onTabChange(item.id)}
                title={collapsed ? item.label : undefined}
                className={cn(
                  "flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-left transition-colors",
                  active
                    ? "bg-blue-600 text-white shadow-sm"
                    : "text-slate-300 hover:bg-white/5 hover:text-white",
                )}
              >
                <Icon className="h-4 w-4 shrink-0" />
                {!collapsed && (
                  <span className="min-w-0">
                    <span className="block truncate text-sm font-medium">{item.label}</span>
                    <span
                      className={cn(
                        "block truncate text-[11px]",
                        active ? "text-blue-100" : "text-slate-400",
                      )}
                    >
                      {item.hint}
                    </span>
                  </span>
                )}
              </button>
            );
          })}
        </nav>
      </div>

      <div className="mt-4 space-y-2 border-t border-white/10 pt-3">
        <div className="flex items-center justify-between gap-2 rounded-xl px-2 py-1.5">
          <span className="flex items-center gap-2 text-sm text-slate-300">
            {dark ? <Moon className="h-4 w-4" /> : <Sun className="h-4 w-4" />}
            {!collapsed && "Dark mode"}
          </span>
          <Switch checked={dark} onCheckedChange={toggle} aria-label="Toggle dark mode" />
        </div>
        <button
          type="button"
          onClick={() => setCollapsed((c) => !c)}
          className="flex w-full items-center justify-center gap-2 rounded-xl px-2 py-2 text-slate-400 transition-colors hover:bg-white/5 hover:text-white"
          aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
        >
          {collapsed ? <ChevronsRight className="h-4 w-4" /> : <ChevronsLeft className="h-4 w-4" />}
        </button>
      </div>
    </aside>
  );
}
