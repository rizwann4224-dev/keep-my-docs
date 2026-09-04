# AI reasoning depth

Every model call in this app asks for a specific amount of _thinking_ (the model's
internal reasoning budget), rather than leaving it at each provider's default.
All of it is configured in one place: [`src/lib/reasoning.ts`](../src/lib/reasoning.ts).

## Depth per task

| Mode        | Tier     | Why                                                      |
| ----------- | -------- | -------------------------------------------------------- |
| `mark`      | `high`   | A shallow marked answer is the one that costs marks.     |
| `exam`      | `high`   | Scenario design needs several checks against the ledger. |
| `challenge` | `high`   | Re-reviewing a disputed mark is the hardest judgement.   |
| `ask`       | `medium` | Conversational — first token has to arrive quickly.      |
| `insights`  | `medium` | Aggregation over attempts, no per-line verification.     |

Override every mode at once with an environment variable:

```
STUDY_REASONING_EFFORT=high   # low | medium | high | xhigh | off
```

`off` restores the previous behaviour (no reasoning parameter sent at all).

## How each provider is told

The same tier is translated per provider, because the dialects are mutually
exclusive — sending both Gemini keys in one request is a hard `400`:

- **Gemini 3.x** (`gemini-3.6-flash`, `gemini-3.5-flash-lite`, …) →
  `generationConfig.thinkingConfig.thinkingLevel: "low" | "medium" | "high"`.
  Sampling overrides are _not_ sent: Google documents that Gemini 3's reasoning
  is tuned for the default `temperature` / `top_p` / `top_k`.
- **Gemini 2.5.x** (`gemini-2.5-flash`, `-lite`, unversioned aliases such as
  `gemini-flash-latest`) → `thinkingConfig.thinkingBudget` in tokens
  (1 024 / 4 096 / 12 288 / 24 576). These models reject `thinkingLevel`.
- **Lovable gateway (OpenAI-style)** → top-level `reasoning_effort`.
- **Groq** → the tier is passed to reasoning-capable models (`openai/gpt-oss-*`,
  `qwen/*`). Retired `llama-*` ids (shut down 2026-08-16) get none and would
  rely on the prompt-level protocol instead.

## Safety nets

- A gateway that does not understand `reasoning_effort` answers `400`/`422`; the
  request is retried once without it instead of dropping to a weaker model.
- A direct Gemini call that answers `400` is retried once with thinking off.
- Where a caller caps output (`/api/public/icap`), thinking tokens are added to
  the cap — they are billed against it, so an answer-sized cap would truncate.
- Streamed reasoning summaries (`parts[].thought === true`) are filtered out of
  the answer stream, so thinking never leaks into the saved `qa_entries` row.

## Cost / latency

Deeper thinking means more thinking tokens and a longer wait before the first
visible token (the model thinks before it writes, and the thoughts are not
streamed to the UI). If marking feels slow, set `STUDY_REASONING_EFFORT=medium`
rather than `off` — you keep the reasoning quality on `ask` and halve the wait
on `mark`.

## Tuning further

- Prompt-level protocol: the "DEEP REASONING PROTOCOL" block at the top of
  `BASE_RULES` in `src/lib/study-prompts.ts` applies to all five modes and is
  what carries the reasoning on models without native thinking.
- Adding a stronger model: prepend it to `MODEL_CHAIN` in
  `src/routes/api/study.ts`. A `404` for an unknown id now skips to the next
  model instead of aborting the chain.
