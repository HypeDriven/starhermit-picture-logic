// Picture Logic — rules & content test suite (node tests/run-tests.mjs)
'use strict';

import {
  CELL, STATUS, REASON, createState, serialize, deserialize, stateHash,
  validate, applyCommand, legalTargets, scoreComponents, compareResults,
  lineClues, computeClues, solvePuzzle, createReplayEnvelope, replayRecord,
  validateReplay, findForcedCell,
} from '../js/rules.js';
import {
  generatePuzzle, validatePuzzle, JOURNEY_STAGES, dailySpec, challengeSpecs,
  buildPuzzle, LESSONS, THEMES, PRACTICE_PRESETS,
} from '../js/content.js';
import { Rng, fnv1a } from '../js/prng.js';
import { overlayLayout } from '../js/ui.js';

let passed = 0, failed = 0;
function ok(cond, name) {
  if (cond) { passed++; }
  else { failed++; console.error(`FAIL: ${name}`); }
}
function eq(a, b, name) { ok(a === b, `${name} (got ${JSON.stringify(a)}, want ${JSON.stringify(b)})`); }
function section(s) { console.log(`\n== ${s}`); }

// ---------------------------------------------------------------------------
section('line clues');
eq(JSON.stringify(lineClues([1, 1, 0, 1])), JSON.stringify([2, 1]), 'clue 2,1');
eq(JSON.stringify(lineClues([0, 0, 0])), JSON.stringify([]), 'clue empty');
eq(JSON.stringify(lineClues([1, 1, 1])), JSON.stringify([3]), 'clue 3');

// ---------------------------------------------------------------------------
section('state creation & serialization');
const SOL5 = [
  1, 1, 0, 1, 1,
  1, 0, 0, 0, 1,
  0, 0, 1, 0, 0,
  1, 0, 0, 0, 1,
  1, 1, 0, 1, 1,
];
const spec5 = { id: 't1', seed: 42, rows: 5, cols: 5, solution: SOL5, parMs: 60000 };
const st = createState(spec5);
eq(st.turn, 0, 'initial turn');
eq(st.status, STATUS.ACTIVE, 'initial status');
eq(JSON.stringify(st.rowClues[0]), JSON.stringify([2, 2]), 'row clue 0');
eq(st.filledCount, 13, 'filled count');
const round = deserialize(serialize(st));
eq(stateHash(round), stateHash(st), 'serialize roundtrip hash');
eq(round.constraints.allowUndo, true, 'constraints defaulted');

// ---------------------------------------------------------------------------
section('legal actions & invalid reasons');
eq(validate(st, { type: 'fill', r: 0, c: 0 }).ok, true, 'fill legal');
eq(validate(st, { type: 'fill', r: 5, c: 0 }).reason, 'out-of-bounds', 'oob row');
eq(validate(st, { type: 'fill', r: -1, c: 0 }).reason, 'out-of-bounds', 'negative');
eq(validate(st, { type: 'fill', r: 0.5, c: 0 }).reason, 'out-of-bounds', 'non-integer');
eq(validate(st, null).reason, 'malformed', 'malformed cmd');
eq(validate(st, { type: 'nonsense' }).reason, 'unknown-command', 'unknown cmd');
eq(validate(st, { type: 'clear', r: 0, c: 0 }).reason, 'cell-not-marked', 'clear unknown');
ok(legalTargets(st).length === 25, 'all cells legal initially');

// fill correct
let res = applyCommand(st, { type: 'fill', r: 0, c: 0 });
ok(res.ok && st.grid[0] === CELL.FILLED, 'fill applied');
eq(st.turn, 1, 'turn incremented');
eq(validate(st, { type: 'fill', r: 0, c: 0 }).reason, 'cell-locked', 'filled cell locked');

// wrong fill -> mistake, cell marked
res = applyCommand(st, { type: 'fill', r: 0, c: 2 });
ok(res.ok, 'wrong fill still a valid command');
eq(st.mistakes, 1, 'mistake counted');
eq(st.grid[2], CELL.MARKED, 'mistake reveals mark');
ok(res.events.some(e => e.type === 'mistake' && e.reason === 'cell-is-empty'), 'mistake event explains');

// mark + clear cycle
res = applyCommand(st, { type: 'mark', r: 4, c: 4 });
ok(res.ok && st.grid[24] === CELL.MARKED, 'mark applied');
eq(validate(st, { type: 'mark', r: 4, c: 4 }).reason, 'cell-not-unknown', 're-mark rejected');
res = applyCommand(st, { type: 'clear', r: 4, c: 4 });
ok(res.ok && st.grid[24] === CELL.UNKNOWN, 'clear applied');

// ---------------------------------------------------------------------------
section('propagation');
// Fill all of row 2's single filled cell (r=2,c=2) — row should auto-mark.
res = applyCommand(st, { type: 'fill', r: 2, c: 2 });
ok(res.ok, 'center fill');
eq(st.grid[11], CELL.MARKED, 'propagation marks row-left');
eq(st.grid[13], CELL.MARKED, 'propagation marks row-right');
eq(st.grid[12], CELL.FILLED, 'center stays filled');
ok(res.events.some(e => e.type === 'propagate'), 'propagate event emitted');

// ---------------------------------------------------------------------------
section('completion & terminal reason');
const st2 = createState(spec5);
for (let i = 0; i < SOL5.length; i++) {
  if (SOL5[i] === 1) {
    const r = applyCommand(st2, { type: 'fill', r: Math.floor(i / 5), c: i % 5 });
    ok(r.ok, `fill ${i} accepted`);
  }
}
eq(st2.status, STATUS.COMPLETE, 'completed');
eq(st2.reason, REASON.COMPLETED, 'terminal reason completed');
ok(st2.grid.every(g => g !== CELL.UNKNOWN), 'no unknowns after completion');
eq(validate(st2, { type: 'fill', r: 0, c: 0 }).reason, 'not-active', 'commands locked after terminal');

// ---------------------------------------------------------------------------
section('constraints: mistakes, moves, time');
const stM = createState({ ...spec5, constraints: { maxMistakes: 2 } });
applyCommand(stM, { type: 'fill', r: 0, c: 2 });
applyCommand(stM, { type: 'fill', r: 1, c: 1 });
eq(stM.status, STATUS.FAILED, 'mistake limit fails');
eq(stM.reason, REASON.MISTAKES, 'mistake reason');

const stMv = createState({ ...spec5, constraints: { moveLimit: 2 } });
applyCommand(stMv, { type: 'mark', r: 0, c: 2 });
eq(stMv.status, STATUS.ACTIVE, 'under move limit');
eq(validate(stMv, { type: 'fill', r: 0, c: 0 }).ok, true, 'fill legal under limit');
applyCommand(stMv, { type: 'clear', r: 0, c: 2 });
eq(stMv.status, STATUS.FAILED, 'move limit terminal');
eq(stMv.reason, REASON.MOVES, 'moves reason');
eq(validate(stMv, { type: 'fill', r: 0, c: 0 }).reason, 'not-active', 'terminal locks input');

const stT = createState({ ...spec5, constraints: { timeLimitMs: 5000 } });
applyCommand(stT, { type: 'tick', ms: 3000 });
eq(stT.elapsedMs, 3000, 'tick accumulates');
eq(stT.status, STATUS.ACTIVE, 'still active under limit');
applyCommand(stT, { type: 'tick', ms: 2500 });
eq(stT.status, STATUS.FAILED, 'time limit fails');
eq(stT.reason, REASON.TIME, 'time reason');
eq(validate(stT, { type: 'tick', ms: -5 }).reason, 'not-active', 'tick after terminal rejected');

const stNM = createState({ ...spec5, constraints: { allowMarks: false } });
eq(validate(stNM, { type: 'mark', r: 0, c: 2 }).reason, 'marks-disabled', 'marks disabled');
const stNH = createState({ ...spec5, constraints: { allowHints: false } });
eq(validate(stNH, { type: 'hint' }).reason, 'hints-disabled', 'hints disabled');

// ---------------------------------------------------------------------------
section('scoring');
const stS = createState(spec5);
for (let i = 0; i < SOL5.length; i++) if (SOL5[i]) applyCommand(stS, { type: 'fill', r: Math.floor(i / 5), c: i % 5 });
const sc = scoreComponents(stS);
ok(sc.base === 130, `base score ${sc.base}`);
ok(sc.cleanBonus === 500, 'clean bonus');
ok(sc.total > sc.base, 'total includes bonuses');
const stS2 = createState(spec5);
applyCommand(stS2, { type: 'fill', r: 0, c: 2 }); // mistake
applyCommand(stS2, { type: 'hint' });
for (let i = 0; i < SOL5.length; i++) if (SOL5[i]) applyCommand(stS2, { type: 'fill', r: Math.floor(i / 5), c: i % 5 });
const sc2 = scoreComponents(stS2);
eq(sc2.mistakePenalty, 50, 'mistake penalty');
eq(sc2.hintPenalty, 25, 'hint penalty');
eq(sc2.cleanBonus, 0, 'no clean bonus');
ok(sc2.total < sc.total, 'mistakes+hints lower score');
// tie-break
const a = { status: STATUS.COMPLETE, mistakes: 0, elapsedMs: 1000, id: 'b' };
const b = { status: STATUS.COMPLETE, mistakes: 0, elapsedMs: 1000, id: 'a' };
ok(compareResults(a, b) > 0, 'stable id tie-break');

// ---------------------------------------------------------------------------
section('hints use the legal API');
const stH = createState(spec5);
const before = stH.turn;
const resH = applyCommand(stH, { type: 'hint' });
ok(resH.ok, 'hint accepted');
eq(stH.hints, 1, 'hint counted');
eq(stH.turn, before + 1, 'hint advances turn');
const evH = resH.events.find(e => e.type === 'hint');
ok(evH && (stH.grid[evH.r * 5 + evH.c] === CELL.FILLED || stH.grid[evH.r * 5 + evH.c] === CELL.MARKED), 'hint applied to grid');
ok(findForcedCell(stH) !== null || stH.grid.every((g, i) => g !== CELL.UNKNOWN || stH.solution[i] === 0), 'forced cell sane');

// ---------------------------------------------------------------------------
section('solver');
{
  const rows = 5, cols = 5;
  const { rowClues, colClues } = computeClues(SOL5, rows, cols);
  const resS = solvePuzzle(rows, cols, rowClues, colClues);
  eq(resS.solutions, 1, 'spec puzzle unique');
  ok(resS.solvedGrid.every((v, i) => (v === 1) === (SOL5[i] === 1)), 'solver recovers solution');
  // non-unique example: 2x2 with every clue "1" has two diagonal solutions
  const amb = solvePuzzle(2, 2, [[1], [1]], [[1], [1]]);
  eq(amb.solutions, 2, 'ambiguous clues detected (2=multiple)');
  const none = solvePuzzle(2, 2, [[3], []], [[], []]);
  eq(none.solutions, 0, 'impossible clues detected');
}

// ---------------------------------------------------------------------------
section('deterministic replay');
{
  const mk = () => createState(spec5);
  const cmds = [
    { type: 'fill', r: 0, c: 0 }, { type: 'fill', r: 0, c: 2 },
    { type: 'hint' }, { type: 'tick', ms: 1200 },
    { type: 'mark', r: 1, c: 1 }, { type: 'clear', r: 1, c: 1 },
    { type: 'fill', r: 2, c: 2 }, { type: 'tick', ms: 300 },
    { type: 'mark', r: 3, c: 1 }, { type: 'clear', r: 3, c: 1 },
    { type: 'fill', r: 4, c: 0 },
  ];
  const runAll = () => {
    const s = mk();
    const env = createReplayEnvelope(s, 1, 'test');
    for (const cmd of cmds) {
      const res = applyCommand(s, cmd);
      replayRecord(env, s, cmd, res);
    }
    return { s, env };
  };
  const r1 = runAll(); const r2 = runAll();
  eq(stateHash(r1.s), stateHash(r2.s), 'same commands → same hash');
  eq(JSON.stringify(r1.env.hashes), JSON.stringify(r2.env.hashes), 'periodic hashes match');
  const v = validateReplay(r1.env, SOL5);
  ok(v.valid, `replay validates (${v.reason || 'ok'})`);
  const bad = JSON.parse(JSON.stringify(r1.env));
  bad.commands[3].cmd.ms = 1299; // tamper: elapsed time diverges from hashes
  const vb = validateReplay(bad, SOL5);
  ok(!vb.valid, `tampered replay rejected (${vb.reason || 'accepted!'})`);
  // illegal command in log is rejected
  const bad2 = JSON.parse(JSON.stringify(r1.env));
  bad2.commands.push({ turn: 999, cmd: { type: 'fill', r: 99, c: 0 } });
  ok(!validateReplay(bad2, SOL5).valid, 'illegal command rejected');
}

// ---------------------------------------------------------------------------
section('generator: validity & uniqueness');
{
  const rng = new Rng(1234, 'test-picks');
  const samples = [];
  for (let i = 0; i < 12; i++) {
    const p = generatePuzzle({ seed: 1000 + i * 977, rows: 8, cols: 8, density: 0.6 });
    ok(p.ok, `gen ${i} ok`);
    eq(validatePuzzle(8, 8, p.solution), null, `gen ${i} validates unique`);
    samples.push(p.solution.join(''));
  }
  ok(new Set(samples).size === samples.length, 'distinct seeds → distinct puzzles');
  const p1 = generatePuzzle({ seed: 555, rows: 10, cols: 10, density: 0.62 });
  const p2 = generatePuzzle({ seed: 555, rows: 10, cols: 10, density: 0.62 });
  eq(p1.solution.join(''), p2.solution.join(''), 'same seed → same puzzle');
}

// ---------------------------------------------------------------------------
section('journey content: all 40 stages valid & unique');
{
  eq(JOURNEY_STAGES.length, 40, '40 journey stages');
  for (const s of JOURNEY_STAGES) {
    const p = generatePuzzle(s);
    ok(p.ok, `${s.id} generated`);
    const defect = validatePuzzle(p.rows, p.cols, p.solution);
    eq(defect, null, `${s.id} (${p.rows}x${p.cols}) unique-solution valid`);
  }
  // mastery stages flagged and hint-free
  ok(JOURNEY_STAGES.filter(s => s.mastery).length === 5, 'five mastery stages');
  ok(JOURNEY_STAGES.filter(s => s.mastery).every(s => s.constraints.allowHints === false), 'mastery disables hints');
}

// ---------------------------------------------------------------------------
section('daily & challenge specs');
{
  const d1 = dailySpec('2026-08-16');
  const d2 = dailySpec('2026-08-16');
  eq(d1.seed, d2.seed, 'daily seed immutable per date');
  ok(dailySpec('2026-08-17').seed !== d1.seed, 'next day differs');
  ok(d1.ranked && d1.constraints.allowUndo === false, 'daily is ranked, no undo');
  const p = generatePuzzle(d1);
  eq(validatePuzzle(p.rows, p.cols, p.solution), null, 'daily puzzle valid');
  const ch = challengeSpecs('week-1');
  eq(ch.length, 4, 'four challenge cards');
  ok(ch.every(c => c.ranked), 'challenges ranked');
  const pc = generatePuzzle(ch[0]);
  eq(validatePuzzle(pc.rows, pc.cols, pc.solution), null, 'challenge puzzle valid');
  eq(challengeSpecs('week-1')[0].seed, ch[0].seed, 'weekly challenge stable');
  ok(challengeSpecs('week-2')[0].seed !== ch[0].seed, 'next week differs');
  ok(PRACTICE_PRESETS.length === 4, 'practice presets');
}

// ---------------------------------------------------------------------------
section('lessons');
{
  eq(LESSONS.length, 5, 'five lessons');
  for (const l of LESSONS) {
    eq(l.board.solution.length, l.board.rows * l.board.cols, `${l.id} board shape`);
    // Lesson boards are teaching aids (may contain empty lines on purpose);
    // they must still have exactly one solution.
    const { rowClues, colClues } = computeClues(l.board.solution, l.board.rows, l.board.cols);
    const sr = solvePuzzle(l.board.rows, l.board.cols, rowClues, colClues);
    eq(sr.solutions, 1, `${l.id} board unique`);
    ok(l.steps.every(s => s.require && s.require.type), `${l.id} steps require actions`);
  }
  eq(THEMES.length, 5, 'five themes');
  ok(new Set(THEMES.map(t => t.id)).size === 5, 'theme ids unique');
}

// ---------------------------------------------------------------------------
section('fuzz: malformed commands never hang or corrupt');
{
  const s = createState(spec5);
  const rng = new Rng(99, 'fuzz');
  const types = ['fill', 'mark', 'clear', 'hint', 'tick', 'abandon', 'wat', null, 42, [], {}];
  for (let i = 0; i < 2000; i++) {
    const t = types[rng.int(0, types.length - 1)];
    const cmd = typeof t === 'string'
      ? { type: t, r: rng.int(-3, 8), c: rng.int(-3, 8), ms: rng.int(-100, 70000) }
      : t;
    const res = applyCommand(s, cmd);
    ok(typeof res.ok === 'boolean', 'fuzz returns verdict');
    if (res.ok === false) ok(typeof res.reason === 'string', 'fuzz rejection has reason');
    if (s.status !== STATUS.ACTIVE) break;
    ok(s.grid.every(g => g === 0 || g === 1 || g === 2), 'grid stays in domain');
    ok(Number.isInteger(s.turn) && s.turn >= 0, 'turn stays sane');
  }
  // hash stability through the fuzz
  ok(/^[0-9a-f]{8}$/.test(stateHash(s)), 'hash format stable');
}

// ---------------------------------------------------------------------------
section('checksum');
ok(fnv1a('picture-logic') !== fnv1a('picture-logic!'), 'fnv distinguishes');
ok(Number.isInteger(fnv1a('x')), 'fnv integer');

// ---------------------------------------------------------------------------
section('undo via validated restore command');
{
  const s = createState(spec5);
  applyCommand(s, { type: 'mark', r: 0, c: 2 });
  const snap = s.grid.slice();
  applyCommand(s, { type: 'mark', r: 1, c: 1 });
  eq(s.grid[6], CELL.MARKED, 'second mark applied');
  const bad = applyCommand(s, { type: 'restore', grid: [1, 2, 3] });
  eq(bad.reason, 'bad-restore', 'bad restore rejected');
  const res2 = applyCommand(s, { type: 'restore', grid: snap });
  ok(res2.ok, 'restore accepted');
  eq(s.grid[6], CELL.UNKNOWN, 'undo rolled back mark');
  eq(s.moves, 2, 'moves not rolled back');
  // restore may not remove locked fills
  applyCommand(s, { type: 'fill', r: 0, c: 0 });
  const res3 = applyCommand(s, { type: 'restore', grid: snap });
  eq(res3.reason, 'restore-removes-fill', 'cannot unfill via restore');
  const sNo = createState({ ...spec5, constraints: { allowUndo: false } });
  eq(applyCommand(sNo, { type: 'restore', grid: sNo.grid }).reason, 'undo-disabled', 'undo disabled constraint');
}

// ---------------------------------------------------------------------------
section('board overlay layout follows the projected trapezoid');
{
  // Synthetic perspective projection: rows get wider and more widely spaced
  // toward the viewer, exactly like the 3D board. The overlay must map every
  // projected cell center back to its own cell — a uniform grid cannot.
  const rows = 8, cols = 8;
  const centers = new Float32Array(rows * cols * 2);
  for (let r = 0; r < rows; r++) {
    const y = 100 + 70 * r * (1 + r * 0.07);        // perspective row stretch
    const rowW = 400 * (1 + r * 0.09);              // perspective widening
    for (let c = 0; c < cols; c++) {
      centers[(r * cols + c) * 2] = 640 + (c - (cols - 1) / 2) * (rowW / (cols - 1));
      centers[(r * cols + c) * 2 + 1] = y;
    }
  }
  const lay = overlayLayout(rows, cols, centers);
  eq(lay.cells.length, rows * cols, 'one overlay quad per cell');
  let hits = 0;
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const cx = centers[(r * cols + c) * 2], cy = centers[(r * cols + c) * 2 + 1];
      const hit = lay.cells.findIndex(q => cx >= q.left && cx < q.left + q.width && cy >= q.top && cy < q.top + q.height);
      if (hit === r * cols + c) hits++;
    }
  }
  eq(hits, rows * cols, 'every projected center hit-tests to its own cell');
  let tiled = true;
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols - 1; c++) {
      const a = lay.cells[r * cols + c], b = lay.cells[r * cols + c + 1];
      if (Math.abs(a.left + a.width - b.left) > 1e-6) tiled = false;
    }
  }
  ok(tiled, 'neighbor quads share edges — no dead zones between cells');
  eq(lay.colClues.length, cols, 'one column clue quad per column');
  eq(lay.rowClues.length, rows, 'one row clue quad per row');
  // uniform-grid fit (the old mapping) would misplace corner cells by > 1 cell
  const corner = lay.cells[(rows - 1) * cols + (cols - 1)];
  ok(corner.left > 500, `corner quad tracks the widened near row (left=${corner.left.toFixed(1)})`);
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
