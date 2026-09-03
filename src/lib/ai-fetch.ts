/**
 * Abortable fetch with a hard time-to-response-headers bound.
 *
 * Providers can hang indefinitely (a gateway under load, a model queue that
 * never drains). Without a timeout, one stuck request stalls the whole answer
 * — the "takes a lot of time" symptom. This helper bounds only the time to
 * receive response headers: for a streaming call `fetch` resolves as soon as
 * the server responds, so a model that is already thinking or streaming is NOT
 * cut off. The caller decides what to do on timeout (typically fall through to
 * the next provider or model in the chain).
 */
export async function fetchWithTimeout(
  input: string,
  init: RequestInit,
  timeoutMs: number,
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error("AI request timed out")), timeoutMs);
  try {
    return await fetch(input, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}
