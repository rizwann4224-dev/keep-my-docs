export type FontOption = {
  id: string;
  label: string;
  stack: string;
  note: string;
};

export const FONT_OPTIONS: FontOption[] = [
  {
    id: "Inter",
    label: "Inter",
    stack: '"Inter", ui-sans-serif, system-ui, sans-serif',
    note: "Neutral modern sans — default",
  },
  {
    id: "IBM Plex Sans",
    label: "IBM Plex Sans",
    stack: '"IBM Plex Sans", ui-sans-serif, system-ui, sans-serif',
    note: "Technical, corporate",
  },
  {
    id: "Source Serif 4",
    label: "Source Serif",
    stack: '"Source Serif 4", ui-serif, Georgia, serif',
    note: "Serif — easiest for long reading",
  },
  {
    id: "Lora",
    label: "Lora",
    stack: '"Lora", ui-serif, Georgia, serif',
    note: "Classic academic serif",
  },
  {
    id: "Roboto",
    label: "Roboto",
    stack: '"Roboto", ui-sans-serif, system-ui, sans-serif',
    note: "Compact and clean",
  },
  {
    id: "JetBrains Mono",
    label: "JetBrains Mono",
    stack: '"JetBrains Mono", ui-monospace, monospace',
    note: "Monospaced, for dense study notes",
  },
];

export function fontStackFor(id: string): string {
  return FONT_OPTIONS.find((f) => f.id === id)?.stack ?? FONT_OPTIONS[0]!.stack;
}
