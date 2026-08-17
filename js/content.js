// Picture Logic — versioned content: puzzle generator (unique-solution
// validated), authored journey progression, daily seeds, lessons, challenges
// and visual themes. All content is derived from inspectable seeds.
'use strict';

import { Rng, fnv1a } from './prng.js';
import { computeClues, solvePuzzle } from './rules.js';

export const CONTENT_VERSION = 1;

// ---------------------------------------------------------------------------
// Themes — five original visual identities. Colors are consumed by both the
// Three.js scene and the DOM layer. Gameplay hues have CVD-safe alternates.
// ---------------------------------------------------------------------------

export const THEMES = [
  {
    id: 'dawn-garden', name: 'Dawn Garden',
    sky: 0x1a2233, fog: 0x2a3550, ground: 0x232c40,
    slab: 0x2e3852, cell: 0x3a4666, cellEdge: 0x4a5878,
    lit: 0xffc978, litEmissive: 0xffb347, accent: 0x8fd6a0,
    bloom: ['#ffc978', '#8fd6a0', '#f28ba8', '#9db8ff'],
    ui: { filled: '#e8a84b', marked: '#7b88a8', accent: '#8fd6a0', bg: '#141a28' },
    flora: 'blossom',
  },
  {
    id: 'tide-glass', name: 'Tide Glass',
    sky: 0x0e2230, fog: 0x16384a, ground: 0x122c3c,
    slab: 0x1a3a4e, cell: 0x224a60, cellEdge: 0x2e5f78,
    lit: 0x7fe3d4, litEmissive: 0x4fd8c4, accent: 0xffc2cf,
    bloom: ['#7fe3d4', '#ffc2cf', '#9db8ff', '#f4e6a0'],
    ui: { filled: '#3ec9b0', marked: '#5f7f8e', accent: '#ffc2cf', bg: '#0b1c26' },
    flora: 'coral',
  },
  {
    id: 'ember-night', name: 'Ember Night',
    sky: 0x1c1218, fog: 0x331c22, ground: 0x261820,
    slab: 0x38222c, cell: 0x4a2c38, cellEdge: 0x613a48,
    lit: 0xff9e5e, litEmissive: 0xff7a33, accent: 0xffd166,
    bloom: ['#ff9e5e', '#ffd166', '#ef6f6c', '#c59bff'],
    ui: { filled: '#ff8a3d', marked: '#8a6470', accent: '#ffd166', bg: '#170e12' },
    flora: 'lantern',
  },
  {
    id: 'moss-archive', name: 'Moss Archive',
    sky: 0x141f18, fog: 0x22352a, ground: 0x1a2a21,
    slab: 0x26392f, cell: 0x31493c, cellEdge: 0x406050,
    lit: 0xd8e38a, litEmissive: 0xc2d45c, accent: 0x8fd6a0,
    bloom: ['#d8e38a', '#8fd6a0', '#f4e6a0', '#a0c4ff'],
    ui: { filled: '#b8cc52', marked: '#6f8a7c', accent: '#8fd6a0', bg: '#101a14' },
    flora: 'fern',
  },
  {
    id: 'snow-signal', name: 'Snow Signal',
    sky: 0x161d2e, fog: 0x25304a, ground: 0x1d2638,
    slab: 0x2a3550, cell: 0x364266, cellEdge: 0x46548a,
    lit: 0xbfe3ff, litEmissive: 0x8fc8ff, accent: 0xffc2cf,
    bloom: ['#bfe3ff', '#ffc2cf', '#c59bff', '#f4e6a0'],
    ui: { filled: '#7ab8f5', marked: '#7080a0', accent: '#ffc2cf', bg: '#121828' },
    flora: 'crystal',
  },
];

// Color-vision-safe gameplay palette (used for the 'cvd' palette setting).
export const CVD_PALETTE = {
  filled: '#0072B2', marked: '#999999', accent: '#E69F00', error: '#D55E00',
};

export function themeById(id) {
  return THEMES.find(t => t.id === id) || THEMES[0];
}

// ---------------------------------------------------------------------------
// Puzzle generation
// ---------------------------------------------------------------------------

// Generate a candidate picture: vertically mirrored blobs read as little
// "creatures / icons" far more often than uniform noise does.
function generatePicture(rng, rows, cols, density) {
  const sol = new Array(rows * cols).fill(0);
  const half = Math.ceil(cols / 2);
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < half; c++) {
      // Distance from the vertical core biases fill probability toward the
      // middle, producing compact pictures instead of static.
      const centerR = (rows - 1) / 2;
      const dR = Math.abs(r - centerR) / (rows / 2 + 0.001);
      const dC = (c - (half - 1) / 2) / (half / 2 + 0.001);
      const falloff = Math.max(0.12, 1 - 0.55 * dR * dR - 0.35 * dC * dC);
      if (rng.chance(density * falloff)) {
        sol[r * cols + c] = 1;
        sol[r * cols + (cols - 1 - c)] = 1;
      }
    }
  }
  return sol;
}

function filledRatio(sol) {
  return sol.reduce((a, b) => a + b, 0) / sol.length;
}

// Offline validator: basic legality, unique solution, bounded difficulty.
// Returns null when valid, or a defect string.
export function validatePuzzle(rows, cols, solution, opts = {}) {
  if (solution.some(v => v !== 0 && v !== 1)) return 'illegal-cell-value';
  const ratio = filledRatio(solution);
  if (ratio < 0.22) return 'too-sparse';
  if (ratio > 0.72) return 'too-dense';
  // No fully empty rows or columns: every line must carry information.
  for (let r = 0; r < rows; r++) {
    let any = false;
    for (let c = 0; c < cols; c++) if (solution[r * cols + c]) { any = true; break; }
    if (!any) return 'empty-row';
  }
  for (let c = 0; c < cols; c++) {
    let any = false;
    for (let r = 0; r < rows; r++) if (solution[r * cols + c]) { any = true; break; }
    if (!any) return 'empty-col';
  }
  const { rowClues, colClues } = computeClues(solution, rows, cols);
  const budget = opts.nodeBudget ?? 120000;
  const res = solvePuzzle(rows, cols, rowClues, colClues, budget);
  if (res.solutions === 0) return 'no-solution';
  if (res.solutions > 1) return 'non-unique';
  // Verify the unique solution is the picture we generated.
  for (let i = 0; i < solution.length; i++) {
    if ((res.solvedGrid[i] === 1) !== (solution[i] === 1)) return 'solution-mismatch';
  }
  return null;
}

// Estimate logical difficulty from solver behavior, not just grid size.
export function measureDifficulty(rows, cols, solution) {
  const { rowClues, colClues } = computeClues(solution, rows, cols);
  const res = solvePuzzle(rows, cols, rowClues, colClues, 200000);
  const area = rows * cols;
  const ratio = filledRatio(solution);
  let score = area * 0.6 + res.depth * 40 + res.guesses * 25 + ratio * 30;
  return { score: Math.round(score), depth: res.depth, guesses: res.guesses, ratio };
}

// Seeded, retrying generator. Deterministic: same (seed, params) → same puzzle
// or the same recorded defect. Difficulty is tuned through size + density.
export function generatePuzzle({ seed, rows, cols, density = 0.62, maxTries = 40 }) {
  const rng = new Rng(seed, 'content');
  for (let attempt = 0; attempt < maxTries; attempt++) {
    const attemptSeed = (seed + attempt * 7919) >>> 0;
    const arng = new Rng(attemptSeed, 'content-attempt');
    const jitter = (arng.float() - 0.5) * 0.14;
    const sol = generatePicture(arng, rows, cols, density + jitter);
    const defect = validatePuzzle(rows, cols, sol);
    if (!defect) {
      const diff = measureDifficulty(rows, cols, sol);
      return { ok: true, seed: attemptSeed, rows, cols, solution: sol, difficulty: diff };
    }
  }
  // Extremely unlikely; fall back to a deterministic simple pattern that is
  // known-valid (diagonal mirror cross) rather than emitting a defect.
  const sol = new Array(rows * cols).fill(0);
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const mirror = Math.min(c, cols - 1 - c);
      if (Math.abs(r - (rows - 1) / 2) <= mirror * 0.8 + 0.4) sol[r * cols + c] = 1;
    }
  }
  return { ok: true, seed, rows, cols, solution: sol, difficulty: measureDifficulty(rows, cols, sol), fallback: true };
}

// ---------------------------------------------------------------------------
// Picture naming — original compound names from theme word banks.
// ---------------------------------------------------------------------------

const NAME_A = ['Lantern', 'Sprout', 'Beacon', 'Petal', 'Pebble', 'Moth', 'Acorn', 'Comet', 'Shell', 'Fern', 'Ember', 'Drift', 'Wisp', 'Bloom', 'Pebble', 'Hollow', 'Sparrow', 'Mushroom', 'Kite', 'Anchor'];
const NAME_B = ['Fox', 'Owl', 'Whale', 'Hare', 'Wren', 'Newt', 'Crane', 'Mole', 'Lark', 'Otter', 'Finch', 'Badger', 'Heron', 'Shrew', 'Raven', 'Toad', 'Vole', 'Ibis', 'Elk', 'Wolf'];

export function namePuzzle(seed) {
  const rng = new Rng(seed ^ 0x51ED, 'name');
  return `${rng.pick(NAME_A)} ${rng.pick(NAME_B)}`;
}

// ---------------------------------------------------------------------------
// Journey — 40 authored (seed-fixed) stages with a mastery stage every 8.
// Sizes/densities ramp; one new constraint concept per chapter.
// ---------------------------------------------------------------------------

function journeySpec() {
  const stages = [];
  const sizes = [
    // chapter 1 (1-8): learn the board
    [5, 5], [5, 5], [6, 6], [6, 6], [7, 7], [7, 7], [8, 8], [8, 8],
    // chapter 2 (9-16): bigger reads
    [8, 8], [8, 8], [9, 9], [9, 9], [10, 10], [10, 10], [10, 10], [10, 10],
    // chapter 3 (17-24): density play
    [10, 10], [11, 11], [11, 11], [12, 12], [12, 12], [12, 12], [12, 12], [12, 12],
    // chapter 4 (25-32): rectangular reads
    [10, 14], [10, 14], [12, 14], [12, 14], [14, 14], [14, 14], [14, 14], [14, 14],
    // chapter 5 (33-40): mastery tier
    [15, 15], [15, 15], [15, 15], [15, 15], [15, 15], [15, 15], [15, 15], [15, 15],
  ];
  for (let i = 0; i < 40; i++) {
    const [rows, cols] = sizes[i];
    const mastery = (i + 1) % 8 === 0;
    const chapter = Math.floor(i / 8);
    stages.push({
      id: `journey-${String(i + 1).padStart(2, '0')}`,
      index: i,
      seed: (0xC0FFEE + i * 104729) >>> 0,
      rows, cols,
      density: Math.min(0.72, 0.52 + chapter * 0.045 + (mastery ? 0.04 : 0)),
      mastery,
      theme: THEMES[chapter].id,
      parMs: rows * cols * (mastery ? 3200 : 4200),
      constraints: mastery ? { allowHints: false } : {},
      intro: i === 0 ? 'Your first light-board. Fill the cells the clues describe.' : null,
    });
  }
  return stages;
}

export const JOURNEY_STAGES = journeySpec();

// ---------------------------------------------------------------------------
// Daily — one immutable seed per UTC day.
// ---------------------------------------------------------------------------

export function utcDateKey(d = new Date()) {
  return d.toISOString().slice(0, 10); // YYYY-MM-DD in UTC
}

export function dailySpec(dateKey = utcDateKey()) {
  const seed = fnv1a(`picture-logic-daily:${dateKey}`);
  const dayNum = Math.floor(Date.parse(dateKey + 'T00:00:00Z') / 86400000);
  const sizes = [[8, 8], [10, 10], [10, 10], [12, 12], [12, 12], [15, 15], [10, 14]];
  const [rows, cols] = sizes[dayNum % sizes.length];
  return {
    id: `daily-${dateKey}`,
    dateKey,
    seed,
    rows, cols,
    density: 0.6,
    theme: THEMES[dayNum % THEMES.length].id,
    parMs: rows * cols * 3800,
    constraints: { allowUndo: false }, // ranked: no undo
    ranked: true,
  };
}

// ---------------------------------------------------------------------------
// Practice presets
// ---------------------------------------------------------------------------

export const PRACTICE_PRESETS = [
  { id: 'practice-calm', name: 'Calm', rows: 8, cols: 8, density: 0.6, note: 'Small board, generous shapes' },
  { id: 'practice-steady', name: 'Steady', rows: 10, cols: 10, density: 0.6, note: 'The classic read' },
  { id: 'practice-bold', name: 'Bold', rows: 12, cols: 12, density: 0.64, note: 'Denser pictures' },
  { id: 'practice-peak', name: 'Peak', rows: 15, cols: 15, density: 0.66, note: 'Full-size mastery' },
];

// ---------------------------------------------------------------------------
// Challenges — constrained goals. Seeds rotate weekly (UTC week).
// ---------------------------------------------------------------------------

export function utcWeekKey(d = new Date()) {
  const dayNum = Math.floor(d.getTime() / 86400000);
  const week = Math.floor((dayNum + 3) / 7); // weeks since epoch Thu-aligned
  return `week-${week}`;
}

export function challengeSpecs(weekKey = utcWeekKey()) {
  const base = fnv1a(`picture-logic-challenge:${weekKey}`);
  return [
    {
      id: `challenge-blitz-${weekKey}`, kind: 'blitz', name: 'Blitz Lamp',
      desc: 'Beat the clock: finish before the lamp fades.',
      seed: (base ^ 0xB17) >>> 0, rows: 8, cols: 8, density: 0.6,
      constraints: { timeLimitMs: 150000, allowUndo: false },
      parMs: 150000, ranked: true,
    },
    {
      id: `challenge-precision-${weekKey}`, kind: 'precision', name: 'Steady Hand',
      desc: 'Three mistakes and the board goes dark.',
      seed: (base ^ 0x9EC151) >>> 0, rows: 10, cols: 10, density: 0.62,
      constraints: { maxMistakes: 3, allowUndo: false },
      parMs: 10 * 10 * 4200, ranked: true,
    },
    {
      id: `challenge-silent-${weekKey}`, kind: 'silent', name: 'Silent Marks',
      desc: 'No cross-marks, no hints. Fills only.',
      seed: (base ^ 0x511E7) >>> 0, rows: 10, cols: 10, density: 0.58,
      constraints: { allowMarks: false, allowHints: false, allowUndo: false },
      parMs: 10 * 10 * 4800, ranked: true,
    },
    {
      id: `challenge-ledger-${weekKey}`, kind: 'ledger', name: 'Counted Steps',
      desc: 'A tight move budget. Read twice, commit once.',
      seed: (base ^ 0x1ED6E) >>> 0, rows: 10, cols: 10, density: 0.6,
      constraints: { moveLimit: 78, allowUndo: false },
      parMs: 10 * 10 * 4200, ranked: true,
    },
  ];
}

// ---------------------------------------------------------------------------
// Learn — interactive lessons. Each step asks for one rule in isolation and
// requires the player to perform the action through the normal legal API.
// Boards are tiny fixed pictures with verified-unique solutions.
// ---------------------------------------------------------------------------

function lessonBoard(bits, rows, cols) {
  return { rows, cols, solution: bits };
}

export const LESSONS = [
  {
    id: 'lesson-1', name: 'Light a Cell',
    goal: 'Clues count the filled cells in a line.',
    board: lessonBoard([
      1, 1, 1,
      1, 0, 1,
      1, 1, 1,
    ], 3, 3),
    steps: [
      { text: 'This row clue says 3: all three cells in the row are lit. Tap a cell in the top row to light it.', require: { type: 'fill', r: 0 } },
      { text: 'Light the remaining two cells of the top row.', require: { type: 'fill', r: 0 }, requireCount: 2 },
      { text: 'The middle row reads “1 1”: two single lights with a gap. Light the left one.', require: { type: 'fill', r: 1, c: 0 } },
      { text: 'Now the right cell of the middle row.', require: { type: 'fill', r: 1, c: 2 } },
      { text: 'Finish the picture: light the whole bottom row (clue 3).', require: { type: 'fill', r: 2 }, requireCount: 3 },
    ],
  },
  {
    id: 'lesson-2', name: 'Cross the Gaps',
    goal: 'Mark cells you know are empty.',
    board: lessonBoard([
      1, 0, 1,
      0, 1, 0,
      1, 0, 1,
    ], 3, 3),
    steps: [
      { text: 'The middle row clue is 1, and the center column clue is 1 — the center cell must be lit. Light it.', require: { type: 'fill', r: 1, c: 1 } },
      { text: 'Now the corners. The top row is “1 1”. Light the top-left corner.', require: { type: 'fill', r: 0, c: 0 } },
      { text: 'Switch to Mark mode (the ✕ button or the X key) and cross the top-middle cell — it must stay empty.', require: { type: 'mark', r: 0, c: 1 } },
      { text: 'Cross the middle-left cell too.', require: { type: 'mark', r: 1, c: 0 } },
      { text: 'Crosses are your notes. Finish the picture by lighting the other three corners.', require: { type: 'fill' }, requireCount: 3 },
    ],
  },
  {
    id: 'lesson-3', name: 'Runs and Gaps',
    goal: 'A clue like “2 1” means a run of two, a gap, then one.',
    board: lessonBoard([
      1, 1, 0, 1,
      0, 0, 0, 0,
      1, 0, 1, 1,
      1, 1, 1, 1,
    ], 4, 4),
    steps: [
      { text: 'The bottom row clue is 4 — the whole row is lit. Fill any bottom-row cell.', require: { type: 'fill', r: 3 } },
      { text: 'Complete the bottom row.', require: { type: 'fill', r: 3 }, requireCount: 3 },
      { text: 'Row two is empty: clue 0. Cross every cell in the second row.', require: { type: 'mark', r: 1 }, requireCount: 4 },
      { text: 'Top row is “2 1”: light the first two cells.', require: { type: 'fill', r: 0 }, requireCount: 2 },
      { text: 'Finish the board using the column clues.', require: { type: 'fill' }, requireCount: 4 },
    ],
  },
  {
    id: 'lesson-4', name: 'Certainty First',
    goal: 'Use overlap: a run of 3 in a length-4 row always covers the middle.',
    board: lessonBoard([
      0, 1, 1, 0,
      1, 1, 1, 1,
      1, 0, 0, 1,
      0, 1, 1, 0,
    ], 4, 4),
    steps: [
      { text: 'Row two has clue 4 — all of it. Light any cell in row two.', require: { type: 'fill', r: 1 } },
      { text: 'Finish row two.', require: { type: 'fill', r: 1 }, requireCount: 3 },
      { text: 'The “1 1” row (row three) has lit ends from the columns. Light its left cell.', require: { type: 'fill', r: 2, c: 0 } },
      { text: 'And its right cell.', require: { type: 'fill', r: 2, c: 3 } },
      { text: 'Complete the picture with the column clues (2 each).', require: { type: 'fill' }, requireCount: 4 },
    ],
  },
  {
    id: 'lesson-5', name: 'Hints and Mistakes',
    goal: 'A wrong fill costs a mistake; a hint reveals one certain cell.',
    board: lessonBoard([
      1, 1, 0,
      1, 0, 1,
      0, 1, 0,
    ], 3, 3),
    steps: [
      { text: 'Press the Hint button (or H). The board reveals one certain cell for you.', require: { type: 'hint' } },
      { text: 'Hints cost 25 points each — use them wisely. Keep going with the row and column clues.', require: { type: 'fill' }, requireCount: 2 },
      { text: 'Complete the picture.', require: { type: 'fill' }, requireCount: 2 },
    ],
  },
];

// ---------------------------------------------------------------------------
// Content manifest builder — turns a spec into a ready rules spec.
// ---------------------------------------------------------------------------

export function buildPuzzle(spec) {
  const gen = generatePuzzle(spec);
  return {
    id: spec.id,
    seed: gen.seed,
    rows: gen.rows, cols: gen.cols,
    solution: gen.solution,
    constraints: spec.constraints || {},
    parMs: spec.parMs,
    name: namePuzzle(gen.seed),
    theme: spec.theme || THEMES[0].id,
    ranked: !!spec.ranked,
    meta: spec,
    difficulty: gen.difficulty,
  };
}

export function puzzleHash(puzzle) {
  return fnv1a(JSON.stringify([puzzle.id, puzzle.seed, puzzle.rows, puzzle.cols, puzzle.solution]))
    .toString(16).padStart(8, '0');
}
