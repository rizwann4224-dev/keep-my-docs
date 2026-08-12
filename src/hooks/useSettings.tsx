import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from "react";
import { supabase } from "@/integrations/supabase/client";
import { fontStackFor } from "@/lib/fonts";

type Settings = { font: string; fontSize: number };

const DEFAULTS: Settings = { font: "Inter", fontSize: 16 };
const STORAGE_KEY = "study-settings";

const SettingsContext = createContext<{
  settings: Settings;
  update: (next: Partial<Settings>) => void;
}>({ settings: DEFAULTS, update: () => {} });

export function SettingsProvider({ children }: { children: ReactNode }) {
  const [settings, setSettings] = useState<Settings>(DEFAULTS);

  useEffect(() => {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      try {
        setSettings({ ...DEFAULTS, ...(JSON.parse(raw) as Partial<Settings>) });
      } catch {
        /* ignore */
      }
    }
  }, []);

  useEffect(() => {
    const root = document.documentElement;
    root.style.setProperty("--font-sans", fontStackFor(settings.font));
    root.style.fontSize = `${settings.fontSize}px`;
  }, [settings]);

  const update = useCallback((next: Partial<Settings>) => {
    setSettings((prev) => {
      const merged = { ...prev, ...next };
      localStorage.setItem(STORAGE_KEY, JSON.stringify(merged));
      void supabase.auth.getUser().then(({ data }) => {
        if (!data.user) return;
        void supabase
          .from("user_settings")
          .upsert(
            { user_id: data.user.id, font_family: merged.font, updated_at: new Date().toISOString() },
            { onConflict: "user_id" },
          );
      });
      return merged;
    });
  }, []);

  return (
    <SettingsContext.Provider value={{ settings, update }}>{children}</SettingsContext.Provider>
  );
}

export function useSettings() {
  return useContext(SettingsContext);
}
