/**
 * Gemini key rotation: the original key is always the default; the backup key
 * (GEMINI_API_KEY_BACKUP) is used only while the original is rate limited /
 * out of quota. A limited key is parked for a cooldown, after which the next
 * request goes back to the original automatically.
 */

import { readServerKey } from "@/lib/load-env";

const DEFAULT_COOLDOWN_MS = 60_000;
const limitedUntil = new Map<string, number>();

/** Statuses that mean "this key is out of allowance right now" — switch key. */
export function isKeyLimitStatus(status: number): boolean {
  return status === 429 || status === 403 || status === 401 || status === 503;
}

/** All configured Gemini keys, original first, without duplicates. */
export function configuredGeminiKeys(): string[] {
  const keys = [
    readServerKey("GOOGLE_API_KEY", "GEMINI_API_KEY"),
    readServerKey("GEMINI_API_KEY_BACKUP"),
  ].filter((k): k is string => !!k);
  return [...new Set(keys)];
}

/**
 * Keys in the order to try for this request: the original first unless it is
 * still cooling down from a limit hit; limited keys go last (never dropped, so
 * a request still has a chance if every key is parked).
 */
export function orderedGeminiKeys(now = Date.now()): string[] {
  const keys = configuredGeminiKeys();
  const ready = keys.filter((k) => (limitedUntil.get(k) ?? 0) <= now);
  const parked = keys.filter((k) => (limitedUntil.get(k) ?? 0) > now);
  return [...ready, ...parked];
}

/** Park a key after a limit hit. Honors Retry-After (seconds) when given. */
export function markGeminiKeyLimited(key: string, retryAfter?: string | null, now = Date.now()) {
  const seconds = retryAfter ? Number.parseInt(retryAfter, 10) : NaN;
  const ms = Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : DEFAULT_COOLDOWN_MS;
  limitedUntil.set(key, now + ms);
}

/** A successful answer proves the key works again. */
export function markGeminiKeyHealthy(key: string) {
  limitedUntil.delete(key);
}

export function keyLabel(key: string, keys = configuredGeminiKeys()): string {
  return keys.indexOf(key) === 0 ? "primary" : "backup";
}

/** Test helper. */
export function resetGeminiKeyState() {
  limitedUntil.clear();
}
