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
  // Prefer a clear Error reason so callers can tell timeout apart from other aborts.
  const timer = setTimeout(() => {
    controller.abort(new Error(`AI request timed out after ${timeoutMs}ms`));
  }, timeoutMs);
  try {
    // Honour a caller-supplied signal as well (e.g. request cancellation).
    const outer = init.signal;
    if (outer) {
      if (outer.aborted) controller.abort(outer.reason);
      else {
        outer.addEventListener("abort", () => controller.abort(outer.reason), { once: true });
      }
    }
    return await fetch(input, { ...init, signal: controller.signal });
  } catch (err) {
    // Normalize AbortError into a plain Error with the timeout message so
    // provider chains can log "timed out after Nms" instead of a bare AbortError.
    if (err instanceof Error && err.name === "AbortError") {
      throw new Error(controller.signal.reason instanceof Error
        ? controller.signal.reason.message
        : `AI request timed out after ${timeoutMs}ms`);
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}
