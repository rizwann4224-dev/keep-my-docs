/**
 * Module resolution for `node --test` runs.
 *
 * The app is written against Vite's `@/` alias and extensionless relative
 * imports, neither of which plain Node ESM understands. Rather than duplicate
 * the test suite for a second runner, the tests register this tiny hook so the
 * exact source files the app ships are what gets tested.
 */
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

const SRC = new URL("../src/", import.meta.url);
const EXTENSIONS = [".ts", ".tsx", "/index.ts", "/index.tsx"];

function firstExisting(url) {
  try {
    if (existsSync(fileURLToPath(url))) return url.href;
  } catch {
    /* not a file URL we can stat */
  }
  for (const extension of EXTENSIONS) {
    const candidate = new URL(url.href + extension);
    if (existsSync(fileURLToPath(candidate))) return candidate.href;
  }
  return null;
}

export async function resolve(specifier, context, nextResolve) {
  if (specifier.startsWith("@/")) {
    const target = firstExisting(new URL(specifier.slice(2), SRC));
    if (target) return { url: target, shortCircuit: true };
  }

  if (specifier.startsWith(".") && !/\.[a-z]{2,4}$/i.test(specifier)) {
    const target = firstExisting(new URL(specifier, context.parentURL));
    if (target) return { url: target, shortCircuit: true };
  }

  return nextResolve(specifier, context);
}
