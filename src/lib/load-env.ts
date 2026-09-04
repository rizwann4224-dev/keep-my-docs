/**
 * Ensure server-side secrets from `.env` / `.env.local` land in `process.env`.
 *
 * Vite injects `VITE_*` into the client bundle, but server route handlers read
 * bare names (`GEMINI_API_KEY`, `GROQ_API_KEY`, …). Depending on the runtime
 * (Vite SSR, Nitro, Cloudflare, Lovable sandbox) those files are not always
 * applied before the first request. Empty placeholders in the committed `.env`
 * (`GEMINI_API_KEY=`) can also clobber a real value that was set later.
 *
 * Call `ensureServerEnv()` at the top of every AI route. It is idempotent and
 * only fills keys that are currently missing or blank — never overwrites a
 * non-empty value already present in the process environment (e.g. Lovable
 * Cloud secrets, CI, shell exports).
 */

import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";

const AI_KEYS = [
  "GEMINI_API_KEY",
  "GOOGLE_API_KEY",
  "GROQ_API_KEY",
  "GROK_API_KEY",
  "XAI_API_KEY",
  "LOVABLE_API_KEY",
  "STUDY_REASONING_EFFORT",
] as const;

let loaded = false;

function parseEnvFile(contents: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const rawLine of contents.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    // Strip matching quotes.
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    out[key] = value;
  }
  return out;
}

function readEnvFile(path: string): Record<string, string> {
  try {
    if (!existsSync(path)) return {};
    return parseEnvFile(readFileSync(path, "utf8"));
  } catch {
    return {};
  }
}

/**
 * Load `.env` then `.env.local` (local wins on conflicts) into process.env for
 * the AI secret keys, but only where the current value is missing/blank.
 */
export function ensureServerEnv(): void {
  if (typeof process === "undefined") return;
  if (loaded) return;
  loaded = true;

  // cwd is the project root in Vite/Nitro; also try one level up for nested runs.
  const roots = [process.cwd(), resolve(process.cwd(), "..")];
  const merged: Record<string, string> = {};

  for (const root of roots) {
    // Lower priority first so .env.local wins.
    Object.assign(merged, readEnvFile(resolve(root, ".env")));
    Object.assign(merged, readEnvFile(resolve(root, ".env.local")));
  }

  for (const key of AI_KEYS) {
    const current = process.env[key];
    if (typeof current === "string" && current.trim()) continue; // already set
    const next = merged[key];
    if (typeof next === "string" && next.trim()) {
      process.env[key] = next.trim();
    }
  }
}

/** First non-empty value among the given env var names (after ensureServerEnv). */
export function readServerKey(...names: string[]): string | undefined {
  ensureServerEnv();
  for (const name of names) {
    const value = process.env[name];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return undefined;
}
