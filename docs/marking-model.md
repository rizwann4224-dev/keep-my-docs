# Marking model & severity

Which model marks an answer, how strict the marking is, and how to run marking on Claude.

## Model chain — marking & challenge

Tried in order; the first that responds serves the request:

1. **Claude (preferred when configured)** — if `ANTHROPIC_API_KEY` is set, marking and challenge requests run on Claude via the Anthropic Messages API: `claude-sonnet-4-6`, then `claude-opus-4-8`. Pin a specific model with `ANTHROPIC_MODEL` (e.g. `claude-opus-4-8`).
2. **Lovable gateway, Pro tier** — `google/gemini-3.1-pro-preview`, then `google/gemini-2.5-pro`.
3. **Lovable gateway, flash tier** — `google/gemini-3.6-flash` → `google/gemini-2.5-flash` → `google/gemini-2.5-flash-lite`.
4. **Project keys** — Google Gemini, then Groq (unchanged).

Ask / exam / insights modes keep the flash chain for speed. The model that served
each answer is shown in the answer footer ("Model: …").

### Enabling Claude

The Lovable AI gateway offers only Google and OpenAI models — no Anthropic — so
Claude is called directly on `api.anthropic.com`:

1. Create an Anthropic API key at console.anthropic.com.
2. Add it to the project environment as `ANTHROPIC_API_KEY` (in Lovable: project
   settings → environment variables, then redeploy).
3. Optional: pin a model with `ANTHROPIC_MODEL`.

Without the key nothing changes — marking uses the gateway chain above.

## Why the marking prompts got stricter

Marking previously came out far too generous: a weak, generic answer could score
~80% where a real examiner (or Claude) would award ~45%. The marking prompt now
enforces, at every severity:

- **Evidence rule** — a point is credited only when the marker can quote the
  candidate's exact words that earn it; otherwise it scores zero.
- **No benefit of the doubt / GENERIC = ZERO** — vague or universally-true
  statements earn nothing.
- **Correct conclusion without reasoning scores zero**; a wrong figure or
  reference loses the full point, not half.
- **Omissions cost their full marks** — missing required matters are never
  redistributed to points the candidate did make.
- **Knowledge-dump cap** — reciting rules without applying the scenario caps the
  item at 50% (moderate), 40% (strict), 30% (hard).
- **Calibration anchors** — totals must land in the band the answer's true
  quality justifies (broadly correct but generic/under-applied: 40–60%).
- **Adversarial re-read** — before totalling, the marker re-reads the answer
  looking only for reasons to withdraw marks.

## Using all sources

- Marking/challenge requests receive the **maximum source budget** (the whole
  notebook where it fits), because the official answer, marking guide and
  examiner's comments for a question can sit in any source.
- The prompt's **SOURCE SWEEP FIRST** step makes the model walk the notebook
  inventory source by source and assemble the correct answer from all of them
  before it reads the candidate's answer, recomputing every figure itself.
- For Claude the source block is rebuilt at a reduced budget only when the
  notebook is too large for its context window.

`tests/marking-prompt.test.ts` guards these rules — run it after any prompt edit.
