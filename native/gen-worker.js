// Puzzle generation off the game's thread (a starhermit:script module
// worker): content.js buildPuzzle — the seeded picture generator and the
// unique-solution check (rules.js solve) — for a Daily, Practice or
// Challenge board. Natively one board takes up to about a second, longer
// than a frame may run; on the worker the screen keeps drawing meanwhile.
// content.js and rules.js are the browser build's, unchanged.
// In:  { id, spec }   Out: { id, puzzle } | { id, error }
import { buildPuzzle } from "../js/content.js";

globalThis.onmessage = (e) => {
  const d = e.data;
  try {
    const p = buildPuzzle(d.spec);
    postMessage({ id: d.id, puzzle: { id: p.id, seed: p.seed, rows: p.rows, cols: p.cols, solution: p.solution, constraints: p.constraints, parMs: p.parMs, name: p.name, theme: p.theme, ranked: p.ranked } });
  } catch (err) {
    postMessage({ id: d.id, error: String((err && err.message) || err) });
  }
};
