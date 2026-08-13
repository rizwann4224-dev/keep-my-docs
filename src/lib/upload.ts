import { supabase } from "@/integrations/supabase/client";

export type UploadProgress = {
  loaded: number;
  total: number;
  percent: number;
  bytesPerSecond: number;
  secondsRemaining: number;
};

/** Uploads to storage over XHR so real-time progress and speed are available. */
export function uploadWithProgress(
  bucket: string,
  path: string,
  file: File,
  onProgress: (p: UploadProgress) => void,
): Promise<void> {
  return new Promise((resolve, reject) => {
    void (async () => {
      const url = import.meta.env["VITE_SUPABASE_URL"];
      const anon = import.meta.env["VITE_SUPABASE_PUBLISHABLE_KEY"];
      const { data } = await supabase.auth.getSession();
      const token = data.session?.access_token;
      if (!url || !anon || !token) {
        reject(new Error("Not signed in"));
        return;
      }

      const xhr = new XMLHttpRequest();
      xhr.open("POST", `${url}/storage/v1/object/${bucket}/${encodeURI(path)}`);
      xhr.setRequestHeader("Authorization", `Bearer ${token}`);
      xhr.setRequestHeader("apikey", anon);
      xhr.setRequestHeader("x-upsert", "false");
      xhr.setRequestHeader("Content-Type", file.type || "application/octet-stream");

      const started = performance.now();
      xhr.upload.onprogress = (event) => {
        if (!event.lengthComputable) return;
        const seconds = Math.max((performance.now() - started) / 1000, 0.001);
        const bytesPerSecond = event.loaded / seconds;
        onProgress({
          loaded: event.loaded,
          total: event.total,
          percent: Math.round((event.loaded / event.total) * 100),
          bytesPerSecond,
          secondsRemaining: bytesPerSecond > 0 ? (event.total - event.loaded) / bytesPerSecond : 0,
        });
      };
      xhr.onerror = () => reject(new Error("Network error during upload"));
      xhr.onload = () => {
        if (xhr.status >= 200 && xhr.status < 300) resolve();
        else reject(new Error(`Upload failed (${xhr.status})`));
      };
      xhr.send(file);
    })();
  });
}

export function formatSpeed(bytesPerSecond: number): string {
  if (bytesPerSecond > 1024 * 1024) return `${(bytesPerSecond / (1024 * 1024)).toFixed(1)} MB/s`;
  return `${Math.max(bytesPerSecond / 1024, 0).toFixed(0)} KB/s`;
}
