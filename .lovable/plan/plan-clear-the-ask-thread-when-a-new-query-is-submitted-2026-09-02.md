# Plan: Clear the Ask thread when a new query is submitted

## Goal
In the Ask tab, submitting a new query should remove the previous question/answer from the visible thread, leaving only the new (streaming) question visible. Previous Q&As remain available in the History tab (already saved server-side on stream completion).

## Current behavior
- `AskPanel.submit()` calls `jobs.startRun(key, ...)`, which **appends** the new turn to any existing turns in the thread (`src/lib/study-jobs.ts` line 108).
- Completed turns are saved to the `qa_entries` table by the server when the stream ends, and `HistoryPanel` lists them — so history already persists.
- The Ask thread is keyed per subject + mode (`${subjectId}:ask` / `${subjectId}:exam`), so each tab has its own thread.
- Submission is disabled while a turn is streaming (`running` guard), so any old turns in the thread are guaranteed to be `done` (and thus already saved to history) when a new query is submitted.

## Change
1. **`src/lib/study-jobs.ts`** — add an optional `replace` flag to `startRun`:
   ```ts
   export function startRun(
     key: string,
     body: StudyRequest,
     label?: string,
     opts?: { replace?: boolean },
   )
   ```
   In the initial `commit`, when `opts?.replace` is true, start the thread as `[turn]` instead of `[...(state[key] ?? []), turn]`. The streaming lifecycle (`patch`/`.then`/`.catch`) is unchanged.

2. **`src/components/study/AskPanel.tsx`** — in `submit()`, pass `{ replace: true }` to `startRun`. The `live`/`past` context arrays are computed **before** the call (as today), so follow-up conversation context still reaches the model via the `history` field. The `saved` query (already fetched for context) keeps providing prior questions after the thread is cleared, so the model still "remembers" what was asked before.

## What stays the same
- History tab still shows every saved Q&A (no change to `HistoryPanel` or the server save path).
- The model still receives prior-question context for follow-ups.
- Exam-setter and general-query sub-modes both clear-on-submit (they share the AskPanel).
- Mark tab behavior is untouched (its own thread/panel).
- PDF/Word export and "Clear thread" buttons continue to work against the (now single-turn) thread.

## Verification
- Submit a query in Ask → answer streams in → only that Q&A is visible.
- Submit a second query → first Q&A disappears from Ask thread, only the new one shows.
- Open History tab → both Q&As are listed.
- Ask a follow-up question that references the previous one → model still has context (answer reflects prior question).
- Switch between General query and Question (exam setter) → each keeps its own single-turn thread.
- Build check passes (no type errors).
