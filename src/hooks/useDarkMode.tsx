import { useCallback, useEffect, useState } from "react";

const STORAGE_KEY = "study-desk-theme";

function readInitial(): boolean {
  if (typeof window === "undefined") return false;
  try {
    const saved = window.localStorage.getItem(STORAGE_KEY);
    if (saved) return saved === "dark";
    return window.matchMedia?.("(prefers-color-scheme: dark)").matches ?? false;
  } catch {
    return false;
  }
}

/** Pure presentation toggle — flips the `dark` class already wired up in styles.css. */
export function useDarkMode() {
  const [dark, setDark] = useState<boolean>(readInitial);

  useEffect(() => {
    document.documentElement.classList.toggle("dark", dark);
    try {
      window.localStorage.setItem(STORAGE_KEY, dark ? "dark" : "light");
    } catch {
      /* ignore */
    }
  }, [dark]);

  const toggle = useCallback(() => setDark((d) => !d), []);

  return { dark, toggle };
}
