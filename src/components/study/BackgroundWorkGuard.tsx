import { useEffect } from "react";
import { anyRunning } from "@/lib/study-jobs";
import { anyUploading } from "@/lib/upload-jobs";

/** Warns before the tab is closed while an answer or upload is still running. */
export function BackgroundWorkGuard() {
  useEffect(() => {
    function onBeforeUnload(event: BeforeUnloadEvent) {
      if (anyRunning() || anyUploading()) {
        event.preventDefault();
        event.returnValue = "";
      }
    }
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => window.removeEventListener("beforeunload", onBeforeUnload);
  }, []);

  return null;
}
