import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Slider } from "@/components/ui/slider";
import { FONT_OPTIONS } from "@/lib/fonts";
import { useSettings } from "@/hooks/useSettings";

export function SettingsDialog() {
  const { settings, update } = useSettings();

  return (
    <Dialog>
      <DialogTrigger asChild>
        <Button variant="outline" size="sm">
          Settings
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Appearance</DialogTitle>
          <DialogDescription>Choose the typeface and reading size for the app.</DialogDescription>
        </DialogHeader>

        <div className="space-y-5">
          <div className="space-y-2">
            <Label>Font</Label>
            <div className="grid gap-2 sm:grid-cols-2">
              {FONT_OPTIONS.map((font) => (
                <button
                  key={font.id}
                  type="button"
                  onClick={() => update({ font: font.id })}
                  style={{ fontFamily: font.stack }}
                  className={`rounded-md border p-3 text-left transition-colors ${
                    settings.font === font.id
                      ? "border-primary bg-accent"
                      : "border-border hover:bg-muted"
                  }`}
                >
                  <span className="block text-sm font-medium text-foreground">{font.label}</span>
                  <span className="mt-0.5 block text-xs text-muted-foreground">{font.note}</span>
                </button>
              ))}
            </div>
          </div>

          <div className="space-y-3">
            <Label>Text size — {settings.fontSize}px</Label>
            <Slider
              value={[settings.fontSize]}
              min={14}
              max={20}
              step={1}
              onValueChange={([value]) => update({ fontSize: value ?? 16 })}
            />
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
