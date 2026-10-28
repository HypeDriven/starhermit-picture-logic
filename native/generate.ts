// Boards for a round: a Journey stage at once from js/puzzles.js (the 40
// stages precomputed), a lesson board as authored, and a Daily, Practice or
// Challenge board from the generator worker (native/gen-worker.js: up to
// about a second natively, so the screen shows "Preparing…" meanwhile).
// Without a worker (it failed to start) the generator runs on the game's
// thread, as the browser build ran it.
import { worker, type Worker } from "starhermit:script";
import { Content, journeyPuzzle, type Puzzle, type Spec } from "./game.ts";

type Reply = { id: number; puzzle?: Puzzle; error?: string };
let w: Worker | null = null;
let failed = false;
let nextId = 1;
const waiting = new Map<number, (r: Reply | null) => void>();

function ensure(): Worker | null {
  if (w || failed) return w;
  try {
    w = worker("native/gen-worker.js", { type: "module" });
    w.on("message", (m) => {
      const r = m as unknown as Reply;
      const job = waiting.get(r.id);
      if (!job) return;
      waiting.delete(r.id);
      job(r);
    });
    // A long generation reports "not responding" but goes on: the answer still comes.
    w.on("error", (msg) => { if (!/not responding/i.test(msg)) console.warn(`generator worker: ${msg}`); });
    w.on("stopped", () => {
      failed = true; w = null;
      for (const [id, job] of waiting) { waiting.delete(id); job(null); }
    });
  } catch (e) { console.warn(`generator worker: ${String(e)}`); failed = true; w = null; }
  return w;
}
/** Starts the worker ahead of the first request (its modules load meanwhile). */
export function warm(): void { ensure(); }

/** The board for a spec: at once (Journey table) or from the worker. Returns a cancel. */
export function puzzleFor(spec: Spec, done: (p: Puzzle | null, error?: string) => void): () => void {
  const fixed = journeyPuzzle(spec);
  if (fixed) { done(fixed); return () => undefined; }
  const run = (): void => {
    let p: Puzzle | null = null, err: string | undefined;
    try { p = Content.buildPuzzle(spec); } catch (e) { err = String(e); }
    done(p, err);
  };
  const wk = ensure();
  if (!wk) { run(); return () => undefined; }
  const id = nextId++;
  let cancelled = false;
  waiting.set(id, (r) => {
    if (cancelled) return;
    if (!r) run();
    else done(r.puzzle ?? null, r.error);
  });
  try { wk.post({ id, spec: JSON.parse(JSON.stringify(spec)) }); } catch (e) { waiting.delete(id); console.warn(`generator worker: ${String(e)}`); run(); }
  return () => { cancelled = true; waiting.delete(id); };
}
