// Global store for AI runs. Streaming continues even when the user switches
// tabs or notebooks; state is persisted so a reload keeps the conversation.
import { streamStudyQuery, type StudyRequest } from "@/lib/study-stream";

export type Turn = {
  id: string;
  question: string;
  answer: string;
  status: "streaming" | "done" | "error";
  error?: string;
};

type State = Record<string, Turn[]>;

const STORAGE_KEY = "study-jobs-v2";

function load(): State {
  if (typeof window === "undefined") return {};
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as State;
    for (const key of Object.keys(parsed)) {
      parsed[key] = (parsed[key] ?? []).map((turn) =>
        turn.status === "streaming"
          ? {
              ...turn,
              status: turn.answer ? "done" : "error",
              ...(turn.answer ? {} : { error: "Interrupted before the answer arrived." }),
            }
          : turn,
      );
    }
    return parsed;
  } catch {
    return {};
  }
}

let state: State = load();
const listeners = new Set<() => void>();
let persistTimer: ReturnType<typeof setTimeout> | null = null;

function persist() {
  if (typeof window === "undefined" || persistTimer) return;
  persistTimer = setTimeout(() => {
    persistTimer = null;
    try {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    } catch {
      /* quota — ignore */
    }
  }, 400);
}

function commit(next: State) {
  state = next;
  persist();
  for (const listener of listeners) listener();
}

export function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

const EMPTY: Turn[] = [];

export function getTurns(key: string): Turn[] {
  return state[key] ?? EMPTY;
}

export function getSnapshot(): State {
  return state;
}

export function isRunning(key: string) {
  return (state[key] ?? EMPTY).some((turn) => turn.status === "streaming");
}

export function anyRunning() {
  return Object.values(state).some((turns) => turns.some((t) => t.status === "streaming"));
}

function patch(key: string, id: string, updates: Partial<Turn>) {
  const turns = (state[key] ?? []).map((turn) =>
    turn.id === id ? { ...turn, ...updates } : turn,
  );
  commit({ ...state, [key]: turns });
}

export function clear(key: string) {
  if (isRunning(key)) return;
  const next = { ...state };
  delete next[key];
  commit(next);
}

/** Fire-and-forget: the run owns its lifecycle, not the React component. */
export function startRun(key: string, body: StudyRequest, label?: string) {
  const id = crypto.randomUUID();
  const turn: Turn = {
    id,
    question: label ?? body.question,
    answer: "",
    status: "streaming",
  };
  commit({ ...state, [key]: [...(state[key] ?? []), turn] });

  void streamStudyQuery(body, (full) => patch(key, id, { answer: full }))
    .then((full) => patch(key, id, { answer: full, status: "done" }))
    .catch((error: unknown) =>
      patch(key, id, {
        status: "error",
        error: error instanceof Error ? error.message : "Something went wrong",
      }),
    );

  return id;
}
