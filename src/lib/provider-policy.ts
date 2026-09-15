/**
 * Provider failure policy — what the app does when an AI quota or billing error
 * arrives, in one place so it can be tested without a network call.
 *
 * Rules:
 * - A quota/billing failure (HTTP 402) is reported to the user as a quota
 *   failure. It is never retried onto a metered endpoint behind their back: no
 *   automatic paid fallback exists in this project, and
 *   `paidFallbackAllowed()` must be explicitly opted into for anything to change.
 * - Rate limits (429) are retryable; hard failures are not.
 * - The message always names the actionable fix (set a personal key / wait /
 *   top up deliberately) and never claims a result was produced.
 */

import { paidFallbackAllowed } from "@/lib/load-env";

/** HTTP statuses that mean "you have run out of allowance" rather than "the model is wrong". */
export const QUOTA_STATUSES = [402, 429, 403] as const;

export type QuotaNotice = {
  kind: "quota" | "rate" | "blocked" | "unconfigured" | "unreachable";
  /** HTTP status the caller should answer with. */
  status: number;
  retryable: boolean;
  /** Headlines for the user, in order of importance. */
  lines: string[];
  /** True only when a metered endpoint was allowed to absorb the request. */
  paidFallbackUsed: boolean;
};

/**
 * Translate a failing provider status into what the user should be told.
 *
 * `personalKeys` lists which fallback providers are configured (Gemini/Groq/Grok);
 * an exhausted shared gateway is a different fix than an exhausted personal key,
 * so the notice only suggests what actually applies.
 */
export function quotaNotice(
  status: number,
  opts: {
    personalKeys?: { gemini?: boolean; groq?: boolean; grok?: boolean };
    paidFallback?: boolean;
    /** True when no AI key of any kind is configured. */
    unconfigured?: boolean;
  } = {},
): QuotaNotice {
  const personalKeys = opts.personalKeys ?? {};
  const hasPersonal = Boolean(personalKeys.gemini || personalKeys.groq || personalKeys.grok);
  const paidFallback = opts.paidFallback ?? paidFallbackAllowed();
  const lines: string[] = [];

  if (opts.unconfigured) {
    return {
      kind: "unconfigured",
      status: 503,
      retryable: false,
      paidFallbackUsed: false,
      lines: [
        "No AI provider is configured for this deployment, so nothing was sent and nothing was saved.",
        "Set GEMINI_API_KEY (or GROQ_API_KEY / GROK_API_KEY) in the deployment environment, then try again.",
      ],
    };
  }

  if (status === 402) {
    lines.push(
      "The AI allowance for this deployment is used up (HTTP 402). Your answer was not generated.",
    );
    if (!hasPersonal) {
      lines.push(
        "Set GEMINI_API_KEY, GROQ_API_KEY or GROK_API_KEY / XAI_API_KEY (in .env.local for local runs, or in the deployment secrets) and requests will use that key instead of the shared allowance.",
      );
    } else {
      lines.push(
        "The configured personal keys were already tried and did not return an answer — check the per-provider reasons above.",
      );
    }
    lines.push(
      paidFallback
        ? "Paid on-demand fallback is enabled for this deployment, so metered requests may be attempted."
        : "No paid fallback was used: nothing was purchased and no metered endpoint was charged. Add credits deliberately if you want the shared allowance to continue.",
    );
    return { kind: "quota", status: 402, retryable: false, lines, paidFallbackUsed: false };
  }

  if (status === 429) {
    lines.push("The AI provider is rate limited (HTTP 429). Nothing was saved for this request.");
    lines.push("Wait a few seconds and ask again — the same question can be re-submitted safely.");
    return { kind: "rate", status: 429, retryable: true, lines, paidFallbackUsed: false };
  }

  if (status === 403) {
    lines.push("The AI provider refused this request (HTTP 403 — blocked by policy or key scope).");
    lines.push(
      "Check the key's restrictions/allowed models; nothing was charged and nothing was saved.",
    );
    return { kind: "blocked", status: 403, retryable: false, lines, paidFallbackUsed: false };
  }

  lines.push(`The AI provider failed (HTTP ${status || 0}). Nothing was saved for this request.`);
  lines.push(
    "Try again in a moment; if it persists, check the provider status in the error above.",
  );
  return { kind: "unreachable", status: 502, retryable: true, lines, paidFallbackUsed: false };
}

/** Render a notice as the plain-text body a route should return. */
export function quotaNoticeBody(notice: QuotaNotice, reasons: string[] = []): string {
  const head = reasons.length
    ? `${notice.lines[0] ?? ""}\n\nWhy this request failed:\n${reasons.map((r) => `• ${r}`).join("\n")}`
    : (notice.lines[0] ?? "");
  return [head, ...notice.lines.slice(1)].filter(Boolean).join("\n\n");
}

/** Status a request should answer with: quota/rate keep the provider's code. */
export function quotaResponseStatus(notice: QuotaNotice, hasPersonalKeys: boolean): number {
  // Personal keys configured means "the shared allowance is out" is not the
  // actionable failure — 502 (bad gateway across every provider) is.
  if (hasPersonalKeys) return 502;
  return notice.status === 402 || notice.status === 429 ? notice.status : 502;
}
