# Marking model & severity

Which model marks an answer, and how marking is kept as critical as a real
examiner — with no external API key and no third-party model connection.

## Model chain — marking & challenge

Tried in order; the first that responds serves the request:

1. **Project Gemini key (`GEMINI_API_KEY` / `GOOGLE_API_KEY`)** — direct Google
   API, first priority on every request. Both old (`AIza…`) and new (`AQ.…`) AI
   Studio keys work. Models: `gemini-2.5-flash` → `gemini-2.5-flash-lite` →
   `gemini-2.0-flash` → `gemini-flash-latest`.
2. **Lovable gateway, Pro tier** — `google/gemini-3.1-pro-preview`, then
   `google/gemini-2.5-pro`. Skipped entirely when credits are exhausted (402).
3. **Lovable gateway, flash tier** — `google/gemini-3.6-flash` →
   `google/gemini-2.5-flash` → `google/gemini-2.5-flash-lite`.
4. **Project Groq key (`GROQ_API_KEY`)** — `openai/gpt-oss-120b` →
   `openai/gpt-oss-20b` (the llama-3.1 / llama-3.3 chat SKUs were shut down
   2026-08-16).
5. **Project Grok / xAI key (`GROK_API_KEY` / `XAI_API_KEY`)** — final fallback.
Ask / exam / insights modes keep the flash chain for speed. The model that
served each answer is shown in the answer footer ("Model: …").

## How the marking got critical (no new keys, no new providers)

Marking used to come out far too generous: a weak, generic answer could score
~80% where a real examiner would award ~45%. That is fixed inside the marking
prompt itself, and by using the strongest reasoning model on the existing
gateway:

- **Pro-tier models mark** — critical evaluation of an exam script is a
  reasoning task; flash models grade too generously.
- **MARKER BEHAVIOUR — THE SCEPTICAL EXAMINER** — the marking prompt installs
  the marker's working personality: a sceptical verifier (not an encourager),
  zero sycophancy, verify-don't-assume, comfort with low marks, no halo effect,
  and every criticism naming the exact gap.
- **Evidence rule** — a point is credited only when the marker can quote the
  candidate's exact words that earn it; otherwise it scores zero.
- **Calibration anchors + worked example** — a broadly-correct-but-generic
  answer must land at 40–60%, and the prompt contains a worked example of a
  fluent, generic answer correctly marked near zero (the exact failure pattern
  that previously produced inflated marks).
- **Adversarial re-read** — before totalling, the marker re-reads the answer
  looking only for reasons to withdraw marks.
- **Generic = zero, omissions cost their full marks, knowledge dumps capped**
  (50% moderate / 40% strict / 30% hard), wrong figures lose the full point.
- **Auditable marks table** — every justification in the marks table must open
  with a verbatim quote from the answer or the word "Absent".

## Using all sources

- Marking/challenge requests receive the **maximum source budget** (the whole
  notebook where it fits), because the official answer, marking guide and
  examiner's comments for a question can sit in any source.
- The **SOURCE SWEEP FIRST** step makes the model walk the notebook inventory
  source by source and assemble the correct answer from all of them before it
  reads the candidate's answer, recomputing every figure itself.

## Guard tests

`tests/marking-prompt.test.ts` checks that all of the above survive future
prompt edits:

```
npx -y tsx tests/marking-prompt.test.ts
```
