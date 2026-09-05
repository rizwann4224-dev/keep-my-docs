/**
 * Reasoning depth ("thinking") for every model call in the app.
 *
 * Every provider in this project speaks a different dialect of the same idea:
 *
 *  - Gemini 3.x      -> `generationConfig.thinkingConfig.thinkingLevel` ("low"|"medium"|"high")
 *  - Gemini 2.5.x    -> `generationConfig.thinkingConfig.thinkingBudget` (0..24576 tokens)
 *  - OpenAI-style    -> top-level `reasoning_effort` ("low"|"medium"|"high")
 *
 * The two Gemini dialects are mutually exclusive: sending BOTH `thinkingLevel`
 * and `thinkingBudget` in one request is a hard 400, and Gemini 2.5 models do
 * not understand `thinkingLevel` at all. So the family has to be decided from
 * the model id before the config is built — that decision lives here, nowhere else.
 *
 * Sampling: Google documents that Gemini 3's reasoning is tuned for the DEFAULT
 * temperature/top_p/top_k and asks you not to override them. The old code sent
 * `temperature: 0, top_p: 0.1` to every model, which both flattens the sampling
 * the reasoning path relies on and buys nothing extra. Gemini 2.5 keeps the old
 * deterministic settings (its thinking budget is unaffected by them).
 */

export type StudyMode = "ask" | "mark" | "insights" | "exam" | "challenge";

/** Effort tiers, cheapest to deepest. */
export type ReasoningEffort = "low" | "medium" | "high" | "xhigh";

const EFFORTS: ReasoningEffort[] = ["low", "medium", "high", "xhigh"];

/**
 * Depth per task. Marking, exam-setting and challenge review are the tasks where
 * a wrong number costs the student marks, so they get the deepest thinking.
 * Ask/insights stay a tier lower because they are conversational and the first
 * token has to arrive quickly. Marking and challenges run at the MAXIMUM tier:
 * critical evaluation of an exam script (and strict re-verification of it) is a
 * pure reasoning task, and deeper thinking is what keeps strict/hard marking
 * rigorous instead of generous.
 */
const MODE_EFFORT: Record<StudyMode, ReasoningEffort> = {
  ask: "medium",
  mark: "xhigh",
  exam: "high",
  challenge: "xhigh",
  insights: "medium",
};

/** Gemini 3.x levels. There is nothing above "high", so xhigh saturates there. */
const THINKING_LEVEL: Record<ReasoningEffort, "low" | "medium" | "high"> = {
  low: "low",
  medium: "medium",
  high: "high",
  xhigh: "high",
};

/**
 * Gemini 2.5 thinking-token budgets (valid range 0..24576 on 2.5 Flash,
 * 512..24576 on 2.5 Flash-Lite, so every tier below is legal on both).
 * 2.5 Flash's default is "dynamic", which in practice lands well under these,
 * so an explicit tier is a real increase rather than a restatement.
 */
const THINKING_BUDGET: Record<ReasoningEffort, number> = {
  low: 1_024,
  medium: 4_096,
  high: 12_288,
  xhigh: 24_576,
};

/** Room (in output tokens) thinking needs on top of the answer itself. */
const THINKING_HEADROOM: Record<ReasoningEffort, number> = {
  low: 1_024,
  medium: 4_096,
  high: 12_288,
  xhigh: 24_576,
};

const ENV_KEY = "STUDY_REASONING_EFFORT";

/** "off" = never send any reasoning parameter, i.e. the pre-existing behaviour. */
export type EffortSetting = ReasoningEffort | "off";

/**
 * What a call site asks for: either a task mode, or an explicit "off" (used by
 * the retry path that re-issues a request the provider rejected because of the
 * thinking config).
 */
export type ReasoningMode = StudyMode | "off";

function readEnv(name: string): string {
  // Client bundles have no `process`; these helpers are server-only, but the
  // guard keeps a stray import from blowing up the browser build.
  if (typeof process === "undefined") return "";
  const value = process.env?.[name];
  return typeof value === "string" ? value.trim().toLowerCase() : "";
}

/**
 * Effective depth for a mode. `STUDY_REASONING_EFFORT` (low|medium|high|xhigh|off)
 * overrides every mode at once, so a slow day can be dialed back without a deploy.
 */
export function effortFor(mode: StudyMode): EffortSetting {
  const raw = readEnv(ENV_KEY);
  if (raw === "off" || raw === "none" || raw === "minimal" || raw === "0") return "off";
  const override = EFFORTS.find((e) => e === raw);
  if (override) return override;
  return MODE_EFFORT[mode];
}

/** Gemini 3 family: `gemini-3*`, with or without the `google/` gateway prefix. */
export function isGemini3Family(model: string): boolean {
  return /(^|[/\-.])gemini-3/i.test(model);
}

/**
 * The `thinkingConfig` object for a direct Gemini API call, or `null` when the
 * effort is off. Never contains both keys — that combination is rejected.
 */
export function geminiThinkingConfig(
  model: string,
  mode: ReasoningMode,
): { thinkingLevel: string } | { thinkingBudget: number } | null {
  const effort = mode === "off" ? "off" : effortFor(mode);
  if (effort === "off") return null;
  // Anything that is not recognisably Gemini 3 (including unversioned aliases
  // like `gemini-flash-latest`) takes the budget form: Gemini 3 still accepts
  // `thinkingBudget` for backwards compatibility, Gemini 2.5 rejects
  // `thinkingLevel` outright.
  return isGemini3Family(model)
    ? { thinkingLevel: THINKING_LEVEL[effort] }
    : { thinkingBudget: THINKING_BUDGET[effort] };
}

/** Full `generationConfig` for a direct Gemini API call. */
export function geminiGenerationConfig(
  model: string,
  mode: ReasoningMode,
  extra?: Record<string, unknown>,
): Record<string, unknown> {
  const config: Record<string, unknown> = { ...(extra ?? {}) };
  const thinking = geminiThinkingConfig(model, mode);
  if (!isGemini3Family(model)) {
    // 2.5 series: keep the deterministic sampling the app has always used.
    config["temperature"] ??= 0;
    config["topP"] ??= 0.1;
  }
  if (thinking) config["thinkingConfig"] = thinking;
  return config;
}

/**
 * Just the reasoning tier — for call sites that already pick their own sampling
 * and only want the thinking knob added on top.
 */
export function reasoningEffortParam(mode: ReasoningMode): Record<string, unknown> {
  const effort = mode === "off" ? "off" : effortFor(mode);
  if (effort === "off") return {};
  // "xhigh" is not a portable tier across gateways — saturate at "high".
  return { reasoning_effort: effort === "xhigh" ? "high" : effort };
}

/**
 * Sampling fields only (no reasoning knob) for an OpenAI-style request. Gemini 3
 * models get none — Google documents that Gemini 3's reasoning is tuned for the
 * default temperature/top_p/top_k, and overriding them is rejected. Used by the
 * 400/422 retry path that re-issues a request without `reasoning_effort`.
 */
export function openAiSamplingParams(model: string): Record<string, unknown> {
  if (isGemini3Family(model)) return {};
  return { temperature: 0, top_p: 0.1 };
}

/**
 * Sampling/reasoning fields for an OpenAI-style request (Lovable gateway).
 * Gemini 3 models get no sampling overrides — only the effort tier.
 */
export function openAiRequestParams(model: string, mode: ReasoningMode): Record<string, unknown> {
  return { ...openAiSamplingParams(model), ...reasoningEffortParam(mode) };
}

/**
 * Groq params. The retired llama chat SKUs rejected unknown reasoning knobs;
 * current production models (openai/gpt-oss-*, qwen/*) accept `reasoning_effort`.
 * Anything that still looks like a plain llama id stays silent.
 */
export function groqRequestParams(model: string, mode: ReasoningMode): Record<string, unknown> {
  const params: Record<string, unknown> = { temperature: 0, top_p: 0.1 };
  // Plain llama ids (retired) get no reasoning tier; gpt-oss / qwen do.
  if (/(^|[/])llama-/i.test(model)) return params;
  return { ...params, ...reasoningEffortParam(mode) };
}
/**
 * Extra output tokens to reserve when a caller caps `max_tokens`/`maxOutputTokens`:
 * thinking tokens are billed against that same cap, so a cap sized for the answer
 * alone would truncate it.
 */
export function thinkingHeadroom(mode: StudyMode): number {
  const effort = effortFor(mode);
  return effort === "off" ? 0 : THINKING_HEADROOM[effort];
}
