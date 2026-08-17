// Picture Logic — rules engine.
// Pure, deterministic, rendering-independent. Every state transition goes
// through validated commands; UI, tutorials and hints all call the same
// legal-action API. State is JSON-serializable and carries a monotonically
// increasing turn number plus an explicit terminal reason.
'use strict';

import { Rng, fnv1a } from './prng.js';

export const RULES_VERSION = 1;

export const CELL = Object.freeze({ UNKNOWN: 0, FILLED: 1, MARKED: 2 });

export const STATUS = Object.freeze({
  ACTIVE: 'active',
  COMPLETE: 'complete',
  FAILED: 'failed',
});

export const REASON = Object.freeze({
  COMPLETED: 'completed',
  MISTAKES: 'failed-mistakes',
  TIME: 'failed-time',
  MOVES: 'failed-moves',
  ABANDONED: 'abandoned',
});

// ---------------------------------------------------------------------------
// Clues
// ---------------------------------------------------------------------------

export function lineClues(bits) {
  const clues = [];
  let run = 0;
  for (const b of bits) {
    if (b) run++;
    else if (run > 0) { clues.push(run); run = 0; }
  }
  if (run > 0) clues.push(run);
  return clues; // empty array means "no filled cells" (rendered as 0 by UI)
}

export function computeClues(solution, rows, cols) {
  const rowClues = [];
  const colClues = [];
  for (let r = 0; r < rows; r++) {
    const bits = [];
    for (let c = 0; c < cols; c++) bits.push(solution[r * cols + c]);
    rowClues.push(lineClues(bits));
  }
  for (let c = 0; c < cols; c++) {
    const bits = [];
    for (let r = 0; r < rows; r++) bits.push(solution[r * cols + c]);
    colClues.push(lineClues(bits));
  }
  return { rowClues, colClues };
}

// ---------------------------------------------------------------------------
// State construction
// ---------------------------------------------------------------------------

// constraints: { maxMistakes, timeLimitMs, moveLimit, allowMarks, allowHints,
//               allowUndo } — null means unconstrained.
export function createState(spec) {
  const { seed, rows, cols, solution } = spec;
  if (!Array.isArray(solution) || solution.length !== rows * cols) {
    throw new Error('solution shape mismatch');
  }
  const { rowClues, colClues } = computeClues(solution, rows, cols);
  const constraints = Object.assign({
    maxMistakes: null,
    timeLimitMs: null,
    moveLimit: null,
    allowMarks: true,
    allowHints: true,
    allowUndo: true,
  }, spec.constraints || {});
  const parMs = spec.parMs ?? Math.round(rows * cols * 4000);
  return {
    v: RULES_VERSION,
    id: spec.id || `p-${seed}-${rows}x${cols}`,
    seed: seed >>> 0,
    rows, cols,
    solution: solution.slice(),
    rowClues, colClues,
    grid: new Array(rows * cols).fill(CELL.UNKNOWN),
    turn: 0,          // monotonically increasing, one per accepted command
    moves: 0,         // committed fill/mark/clear actions
    mistakes: 0,      // invalid (against-solution) fill attempts
    hints: 0,
    elapsedMs: 0,     // authoritative accumulated active time (via tick commands)
    parMs,
    constraints,
    status: STATUS.ACTIVE,
    reason: null,
    filledCount: solution.reduce((a, b) => a + (b ? 1 : 0), 0),
  };
}

// ---------------------------------------------------------------------------
// Serialization
// ---------------------------------------------------------------------------

export function serialize(state) {
  return JSON.stringify(state);
}

export function deserialize(json) {
  const s = JSON.parse(json);
  if (typeof s !== 'object' || s === null) throw new Error('bad state');
  if (s.v > RULES_VERSION) throw new Error(`unsupported rules version ${s.v}`);
  // Migration point: RULES_VERSION 1 is current; older versions upgrade here.
  if (s.v !== RULES_VERSION) s.v = RULES_VERSION;
  const { rowClues, colClues } = computeClues(s.solution, s.rows, s.cols);
  // Never trust stored derived data.
  s.rowClues = rowClues; s.colClues = colClues;
  s.filledCount = s.solution.reduce((a, b) => a + (b ? 1 : 0), 0);
  s.constraints = Object.assign({
    maxMistakes: null, timeLimitMs: null, moveLimit: null,
    allowMarks: true, allowHints: true, allowUndo: true,
  }, s.constraints || {});
  return s;
}

export function stateHash(state) {
  // Hash only the gameplay-relevant fields, in a stable order.
  return fnv1a(JSON.stringify([
    state.v, state.seed, state.rows, state.cols, state.grid, state.turn,
    state.moves, state.mistakes, state.hints, state.elapsedMs,
    state.status, state.reason,
  ])).toString(16).padStart(8, '0');
}

// ---------------------------------------------------------------------------
// Legal-action API — shared by play, tutorials and hints.
// ---------------------------------------------------------------------------

// Returns { ok, reason? } for a command without applying it.
export function validate(state, cmd) {
  if (!cmd || typeof cmd !== 'object') return { ok: false, reason: 'malformed' };
  if (state.status !== STATUS.ACTIVE && cmd.type !== 'tick') {
    return { ok: false, reason: 'not-active' };
  }
  switch (cmd.type) {
    case 'tick': {
      if (state.status !== STATUS.ACTIVE) return { ok: false, reason: 'not-active' };
      if (!Number.isFinite(cmd.ms) || cmd.ms < 0 || cmd.ms > 60000) {
        return { ok: false, reason: 'bad-tick' };
      }
      return { ok: true };
    }
    case 'fill':
    case 'mark':
    case 'clear': {
      const { r, c } = cmd;
      if (!Number.isInteger(r) || !Number.isInteger(c) ||
          r < 0 || c < 0 || r >= state.rows || c >= state.cols) {
        return { ok: false, reason: 'out-of-bounds' };
      }
      if (state.constraints.moveLimit !== null && state.moves >= state.constraints.moveLimit
          && cmd.type !== 'clear') {
        return { ok: false, reason: 'move-limit' };
      }
      const cell = state.grid[r * state.cols + c];
      if (cmd.type === 'fill') {
        if (cell === CELL.FILLED) return { ok: false, reason: 'cell-locked' };
        return { ok: true };
      }
      if (cmd.type === 'mark') {
        if (!state.constraints.allowMarks) return { ok: false, reason: 'marks-disabled' };
        if (cell !== CELL.UNKNOWN) return { ok: false, reason: 'cell-not-unknown' };
        return { ok: true };
      }
      // clear: only MARKED cells can be cleared (fills are locked once correct)
      if (cell !== CELL.MARKED) return { ok: false, reason: 'cell-not-marked' };
      return { ok: true };
    }
    case 'hint': {
      if (!state.constraints.allowHints) return { ok: false, reason: 'hints-disabled' };
      const remaining = state.grid.some((g, i) =>
        g !== CELL.FILLED && state.solution[i] === 1) ||
        state.grid.some((g, i) => g === CELL.UNKNOWN && state.solution[i] === 0);
      if (!remaining) return { ok: false, reason: 'nothing-to-reveal' };
      return { ok: true };
    }
    case 'restore': {
      // Session undo: the session layer supplies a grid it captured earlier
      // through the public API. Validated for shape/domain; counters are
      // intentionally NOT rolled back (mistakes and hints stay on record).
      if (!state.constraints.allowUndo) return { ok: false, reason: 'undo-disabled' };
      const g = cmd.grid;
      if (!Array.isArray(g) || g.length !== state.rows * state.cols) return { ok: false, reason: 'bad-restore' };
      if (!g.every(v => v === 0 || v === 1 || v === 2)) return { ok: false, reason: 'bad-restore' };
      // A restore may never un-fill a correctly filled cell (fills are locked truth).
      for (let i = 0; i < g.length; i++) {
        if (state.grid[i] === CELL.FILLED && g[i] !== CELL.FILLED) {
          return { ok: false, reason: 'restore-removes-fill' };
        }
      }
      return { ok: true };
    }
    case 'abandon':
      return { ok: true };
    default:
      return { ok: false, reason: 'unknown-command' };
  }
}

// Per-cell legal targets for directional/focus navigation.
export function legalTargets(state) {
  const out = [];
  if (state.status !== STATUS.ACTIVE) return out;
  for (let r = 0; r < state.rows; r++) {
    for (let c = 0; c < state.cols; c++) {
      const cell = state.grid[r * state.cols + c];
      const acts = [];
      if (cell !== CELL.FILLED) acts.push('fill');
      if (cell === CELL.UNKNOWN && state.constraints.allowMarks) acts.push('mark');
      if (cell === CELL.MARKED) acts.push('clear');
      if (acts.length) out.push({ r, c, actions: acts });
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Line propagation — when every filled cell of a line is placed, the
// remaining unknowns become certain-empty and are auto-marked.
// ---------------------------------------------------------------------------

function propagateLine(state, isRow, index) {
  const { rows, cols, grid, solution } = state;
  const n = isRow ? cols : rows;
  let allFilledPlaced = true;
  for (let i = 0; i < n; i++) {
    const idx = isRow ? index * cols + i : i * cols + index;
    if (solution[idx] === 1 && grid[idx] !== CELL.FILLED) { allFilledPlaced = false; break; }
  }
  if (!allFilledPlaced) return [];
  const changed = [];
  for (let i = 0; i < n; i++) {
    const idx = isRow ? index * cols + i : i * cols + index;
    if (grid[idx] === CELL.UNKNOWN && solution[idx] === 0) {
      grid[idx] = CELL.MARKED;
      changed.push(idx);
    }
  }
  return changed;
}

function propagate(state) {
  const changed = [];
  for (let r = 0; r < state.rows; r++) changed.push(...propagateLine(state, true, r));
  for (let c = 0; c < state.cols; c++) changed.push(...propagateLine(state, false, c));
  return changed;
}

function checkTerminal(state) {
  if (state.status !== STATUS.ACTIVE) return;
  // Completion: every solution-filled cell is filled.
  let complete = true;
  for (let i = 0; i < state.solution.length; i++) {
    if (state.solution[i] === 1 && state.grid[i] !== CELL.FILLED) { complete = false; break; }
  }
  if (complete) {
    // Sweep any leftover unknowns to marked for a clean final picture.
    for (let i = 0; i < state.grid.length; i++) {
      if (state.grid[i] === CELL.UNKNOWN) state.grid[i] = CELL.MARKED;
    }
    state.status = STATUS.COMPLETE;
    state.reason = REASON.COMPLETED;
    return;
  }
  const k = state.constraints;
  if (k.maxMistakes !== null && state.mistakes >= k.maxMistakes) {
    state.status = STATUS.FAILED; state.reason = REASON.MISTAKES; return;
  }
  if (k.timeLimitMs !== null && state.elapsedMs >= k.timeLimitMs) {
    state.status = STATUS.FAILED; state.reason = REASON.TIME; return;
  }
  if (k.moveLimit !== null && state.moves >= k.moveLimit) {
    state.status = STATUS.FAILED; state.reason = REASON.MOVES; return;
  }
}

// ---------------------------------------------------------------------------
// Hint — uses the same solver as content validation, seeded for determinism.
// ---------------------------------------------------------------------------

// Find a logically forced cell from the current *verified* knowledge
// (FILLED cells only — player marks are advisory and not trusted).
export function findForcedCell(state) {
  const rows = state.rows, cols = state.cols;
  const known = new Array(rows * cols).fill(-1); // -1 unknown, 0 empty, 1 filled
  for (let i = 0; i < known.length; i++) {
    if (state.grid[i] === CELL.FILLED) known[i] = 1;
  }
  const tryLine = (clues, bits) => {
    const forced = new Array(bits.length).fill(null);
    const count = enumerateLine(clues, bits, (line) => {
      for (let i = 0; i < line.length; i++) {
        if (forced[i] === null) forced[i] = line[i];
        else if (forced[i] !== line[i]) forced[i] = 2; // 2 = varies
      }
    }, 2 ** 22);
    return count > 0 ? forced : null;
  };
  for (let r = 0; r < rows; r++) {
    const bits = []; for (let c = 0; c < cols; c++) bits.push(known[r * cols + c]);
    const forced = tryLine(state.rowClues[r], bits);
    if (!forced) continue;
    for (let c = 0; c < cols; c++) {
      const idx = r * cols + c;
      if (state.grid[idx] === CELL.UNKNOWN && (forced[c] === 0 || forced[c] === 1)) {
        return { r, c, value: forced[c], via: 'logic' };
      }
    }
  }
  for (let c = 0; c < cols; c++) {
    const bits = []; for (let r = 0; r < rows; r++) bits.push(known[r * cols + c]);
    const forced = tryLine(state.colClues[c], bits);
    if (!forced) continue;
    for (let r = 0; r < rows; r++) {
      const idx = r * cols + c;
      if (state.grid[idx] === CELL.UNKNOWN && (forced[r] === 0 || forced[r] === 1)) {
        return { r, c, value: forced[r], via: 'logic' };
      }
    }
  }
  return null;
}

function hintCell(state) {
  const forced = findForcedCell(state);
  if (forced) return forced;
  // No pure-logic cell: deterministically reveal an unresolved cell using the
  // rules random stream (seeded from puzzle seed + hint count, so replays of
  // the same command sequence stay identical).
  const rng = new Rng((state.seed ^ (state.hints * 0x85EBCA6B) ^ state.turn) >>> 0, 'rules-hint');
  const candidates = [];
  for (let i = 0; i < state.grid.length; i++) {
    const isUnresolvedFilled = state.solution[i] === 1 && state.grid[i] !== CELL.FILLED;
    const isUnknown = state.grid[i] === CELL.UNKNOWN;
    if (isUnresolvedFilled || isUnknown) candidates.push(i);
  }
  if (!candidates.length) return null;
  const idx = candidates[rng.int(0, candidates.length - 1)];
  return { r: Math.floor(idx / state.cols), c: idx % state.cols, value: state.solution[idx], via: 'reveal' };
}

// ---------------------------------------------------------------------------
// Command application — the only mutation path for rules state.
// ---------------------------------------------------------------------------

let commandCounter = 0;
export function nextCommandId(prefix = 'cmd') {
  commandCounter = (commandCounter + 1) >>> 0;
  return `${prefix}-${Date.now().toString(36)}-${commandCounter.toString(36)}`;
}

// Returns { ok, reason?, events: [] } — events drive presentation and audio.
export function applyCommand(state, cmd) {
  const v = validate(state, cmd);
  if (!v.ok) return { ok: false, reason: v.reason, events: [] };
  const events = [];
  const cols = state.cols;

  switch (cmd.type) {
    case 'tick': {
      state.elapsedMs += Math.round(cmd.ms);
      events.push({ type: 'tick', elapsedMs: state.elapsedMs });
      state.turn++;
      checkTerminal(state);
      if (state.status !== STATUS.ACTIVE) events.push({ type: 'terminal', status: state.status, reason: state.reason });
      return { ok: true, events };
    }
    case 'abandon': {
      state.status = STATUS.FAILED; state.reason = REASON.ABANDONED; state.turn++;
      events.push({ type: 'terminal', status: state.status, reason: state.reason });
      return { ok: true, events };
    }
    case 'fill': {
      const idx = cmd.r * cols + cmd.c;
      if (state.solution[idx] === 1) {
        state.grid[idx] = CELL.FILLED;
        state.moves++;
        events.push({ type: 'fill', r: cmd.r, c: cmd.c, correct: true });
        const marked = propagate(state);
        if (marked.length) {
          events.push({
            type: 'propagate',
            cells: marked.map(i => ({ r: Math.floor(i / cols), c: i % cols })),
          });
        }
      } else {
        // Invalid action: counted, explained, and the certain-empty truth is shown.
        state.mistakes++;
        state.grid[idx] = CELL.MARKED;
        events.push({ type: 'mistake', r: cmd.r, c: cmd.c, reason: 'cell-is-empty' });
      }
      state.turn++;
      checkTerminal(state);
      if (state.status !== STATUS.ACTIVE) events.push({ type: 'terminal', status: state.status, reason: state.reason });
      return { ok: true, events };
    }
    case 'mark': {
      state.grid[cmd.r * cols + cmd.c] = CELL.MARKED;
      state.moves++; state.turn++;
      events.push({ type: 'mark', r: cmd.r, c: cmd.c });
      checkTerminal(state);
      if (state.status !== STATUS.ACTIVE) events.push({ type: 'terminal', status: state.status, reason: state.reason });
      return { ok: true, events };
    }
    case 'clear': {
      state.grid[cmd.r * cols + cmd.c] = CELL.UNKNOWN;
      state.moves++; state.turn++;
      events.push({ type: 'clear', r: cmd.r, c: cmd.c });
      checkTerminal(state);
      if (state.status !== STATUS.ACTIVE) events.push({ type: 'terminal', status: state.status, reason: state.reason });
      return { ok: true, events };
    }
    case 'restore': {
      state.grid = cmd.grid.slice();
      state.turn++;
      events.push({ type: 'restore' });
      checkTerminal(state);
      if (state.status !== STATUS.ACTIVE) events.push({ type: 'terminal', status: state.status, reason: state.reason });
      return { ok: true, events };
    }
    case 'hint': {
      const h = hintCell(state);
      if (!h) return { ok: false, reason: 'nothing-to-reveal', events: [] };      state.hints++;
      const idx = h.r * cols + h.c;
      if (h.value === 1) {
        state.grid[idx] = CELL.FILLED;
        const marked = propagate(state);
        if (marked.length) {
          events.push({ type: 'propagate', cells: marked.map(i => ({ r: Math.floor(i / cols), c: i % cols })) });
        }
      } else {
        state.grid[idx] = CELL.MARKED;
      }
      state.turn++;
      events.push({ type: 'hint', r: h.r, c: h.c, value: h.value, via: h.via });
      checkTerminal(state);
      if (state.status !== STATUS.ACTIVE) events.push({ type: 'terminal', status: state.status, reason: state.reason });
      return { ok: true, events };
    }
  }
  return { ok: false, reason: 'unknown-command', events: [] };
}

// ---------------------------------------------------------------------------
// Scoring — integer components; formatting lives in presentation.
// ---------------------------------------------------------------------------

export function scoreComponents(state) {
  const base = state.filledCount * 10;
  const sizeBonus = state.rows * state.cols;
  const timeBonus = state.status === STATUS.COMPLETE
    ? Math.max(0, Math.round((state.parMs - state.elapsedMs) / 500)) : 0;
  const mistakePenalty = state.mistakes * 50;
  const hintPenalty = state.hints * 25;
  const cleanBonus = (state.status === STATUS.COMPLETE && state.mistakes === 0 && state.hints === 0) ? 500 : 0;
  const total = state.status === STATUS.COMPLETE
    ? Math.max(0, base + sizeBonus + timeBonus + cleanBonus - mistakePenalty - hintPenalty)
    : 0;
  return { base, sizeBonus, timeBonus, mistakePenalty, hintPenalty, cleanBonus, total };
}

// Tie-break ordering: objective completion, fewer invalid actions,
// lower authoritative elapsed time, then stable session identifier.
export function compareResults(a, b) {
  const ca = a.status === STATUS.COMPLETE ? 1 : 0;
  const cb = b.status === STATUS.COMPLETE ? 1 : 0;
  if (ca !== cb) return cb - ca;
  if (a.mistakes !== b.mistakes) return a.mistakes - b.mistakes;
  if (a.elapsedMs !== b.elapsedMs) return a.elapsedMs - b.elapsedMs;
  return String(a.id).localeCompare(String(b.id));
}

// ---------------------------------------------------------------------------
// Line enumeration + solver (used by content validation and hints).
// ---------------------------------------------------------------------------

// Enumerate placements of `clues` in a line consistent with `bits`
// (-1 unknown / 0 empty / 1 filled). Calls cb(lineArray); stops early if
// cb returns false or the node budget is exhausted. Returns count (capped).
export function enumerateLine(clues, bits, cb, budget = 1 << 22) {
  const n = bits.length;
  const line = new Array(n).fill(0);
  let count = 0;
  let nodes = 0;
  let stopped = false;

  // Precompute: can cell i be value v?
  const canFill = bits.map(b => b !== 0);
  const canEmpty = bits.map(b => b !== 1);

  function place(clueIdx, pos, start) {
    if (stopped) return;
    if (++nodes > budget) { stopped = true; return; }
    if (clueIdx === clues.length) {
      for (let i = pos; i < n; i++) {
        if (!canEmpty[i]) return;
        line[i] = 0;
      }
      count++;
      if (cb(line) === false) stopped = true;
      return;
    }
    const len = clues[clueIdx];
    // Remaining minimum space after this clue.
    let rest = 0;
    for (let k = clueIdx + 1; k < clues.length; k++) rest += clues[k] + 1;
    const maxStart = n - rest - len;
    for (let s = start; s <= maxStart; s++) {
      // empties before s
      let ok = true;
      for (let i = pos; i < s; i++) if (!canEmpty[i]) { ok = false; break; }
      if (!ok) { if (pos < n && !canEmpty[pos]) return; continue; }
      for (let i = s; i < s + len; i++) if (!canFill[i]) { ok = false; break; }
      if (!ok) continue;
      if (s + len < n && !canEmpty[s + len]) continue;
      for (let i = pos; i < s; i++) line[i] = 0;
      for (let i = s; i < s + len; i++) line[i] = 1;
      place(clueIdx + 1, s + len + 1, s + len + 1);
      if (stopped) return;
    }
  }
  place(0, 0, 0);
  return count;
}

// Full solver with propagation + bounded backtracking.
// Returns { solutions: 0|1|2 (2 = "2 or more"), solvedGrid, depth, guesses }.
export function solve(solution_unknown, rows, cols, rowClues, colClues, nodeBudget = 60000) {
  const grid = solution_unknown.slice(); // -1/0/1
  let nodes = 0;
  let guesses = 0;
  let maxDepth = 0;

  const propagateAll = (g) => {
    let changed = true;
    let rounds = 0;
    while (changed) {
      changed = false;
      rounds++;
      if (rounds > rows + cols + 2) return -1; // safety
      for (let isRow = 0; isRow <= 1; isRow++) {
        const lines = isRow ? rows : cols;
        for (let li = 0; li < lines; li++) {
          const n = isRow ? cols : rows;
          const bits = new Array(n);
          for (let i = 0; i < n; i++) bits[i] = g[isRow ? li * cols + i : i * cols + li];
          const clues = isRow ? rowClues[li] : colClues[li];
          const forced0 = new Array(n).fill(true);
          const forced1 = new Array(n).fill(true);
          let count = 0;
          nodes += n;
          if (nodes > nodeBudget) return -2; // budget exhausted
          enumerateLine(clues, bits, (line) => {
            count++;
            for (let i = 0; i < n; i++) {
              if (line[i] !== 0) forced0[i] = false;
              if (line[i] !== 1) forced1[i] = false;
            }
            if (count >= 2 && forced0.every(v => !v) && forced1.every(v => !v)) return false;
          }, 1 << 20);
          if (count === 0) return -1; // contradiction
          for (let i = 0; i < n; i++) {
            const idx = isRow ? li * cols + i : i * cols + li;
            if (g[idx] === -1) {
              if (forced0[i]) { g[idx] = 0; changed = true; }
              else if (forced1[i]) { g[idx] = 1; changed = true; }
            }
          }
        }
      }
    }
    return 0;
  };

  let solutions = 0;
  let solvedGrid = null;

  const dfs = (g, depth) => {
    if (solutions >= 2) return;
    maxDepth = Math.max(maxDepth, depth);
    const res = propagateAll(g);
    if (res === -1) return;
    if (res === -2) { return; } // treat as unknown branch, bounded by budget
    let firstUnknown = -1;
    for (let i = 0; i < g.length; i++) if (g[i] === -1) { firstUnknown = i; break; }
    if (firstUnknown === -1) {
      solutions++;
      if (!solvedGrid) solvedGrid = g.slice();
      return;
    }
    guesses++;
    for (const v of [1, 0]) {
      const g2 = g.slice();
      g2[firstUnknown] = v;
      dfs(g2, depth + 1);
      if (solutions >= 2) return;
    }
  };

  dfs(grid, 0);
  return { solutions, solvedGrid, depth: maxDepth, guesses };
}

// Convenience: solve a puzzle given only its clues.
export function solvePuzzle(rows, cols, rowClues, colClues, nodeBudget) {
  return solve(new Array(rows * cols).fill(-1), rows, cols, rowClues, colClues, nodeBudget);
}

// ---------------------------------------------------------------------------
// Replay envelope — schema version, content version, seed, ordered commands,
// periodic state hashes, terminal result.
// ---------------------------------------------------------------------------

export function createReplayEnvelope(state, contentVersion, buildVersion) {
  return {
    schema: 1,
    build: buildVersion,
    content: contentVersion,
    id: state.id,
    seed: state.seed,
    rows: state.rows, cols: state.cols,
    solutionHash: fnv1a(state.solution.join('')).toString(16),
    initialHash: stateHash(state),
    startedAtOffsetMs: 0,
    commands: [],
    hashes: [],
    terminal: null,
  };
}

export function replayRecord(envelope, state, cmd, result) {
  envelope.commands.push({ turn: state.turn, cmd });
  if (state.turn % 10 === 0 || !result.ok) {
    envelope.hashes.push({ turn: state.turn, hash: stateHash(state) });
  }
  const term = result.events.find(e => e.type === 'terminal');
  if (term) {
    envelope.terminal = {
      status: state.status, reason: state.reason,
      score: scoreComponents(state), finalHash: stateHash(state),
    };
  }
}

// Re-run an envelope against a fresh state built from the stored solution.
// Purely deterministic: identical version+seed+commands → identical hashes.
export function validateReplay(envelope, solution) {
  const state = createState({
    id: envelope.id, seed: envelope.seed,
    rows: envelope.rows, cols: envelope.cols, solution,
  });
  if (stateHash(state) !== envelope.initialHash) {
    return { valid: false, reason: 'initial-hash-mismatch' };
  }
  const hashByTurn = new Map((envelope.hashes || []).map(h => [h.turn, h.hash]));
  for (const rec of envelope.commands) {
    const res = applyCommand(state, rec.cmd);
    if (!res.ok) return { valid: false, reason: `illegal-command:${res.reason}` };
    const expected = hashByTurn.get(state.turn);
    if (expected !== undefined && expected !== stateHash(state)) {
      return { valid: false, reason: `hash-mismatch@${state.turn}` };
    }
  }
  if (envelope.terminal) {
    if (stateHash(state) !== envelope.terminal.finalHash) {
      return { valid: false, reason: 'final-hash-mismatch' };
    }
    return { valid: true, score: scoreComponents(state) };
  }
  return { valid: true, score: null };
}
