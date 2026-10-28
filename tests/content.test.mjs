// The precomputed Journey table (js/puzzles.js) still equals the generator's
// output, and the board overlay geometry (node --test).
import test from 'node:test';
import assert from 'node:assert/strict';
import { JOURNEY_STAGES, buildPuzzle } from '../js/content.js';
import { journeyPuzzle, JOURNEY_TABLE } from '../js/puzzles.js';

test('the Journey table holds all 40 stages and equals buildPuzzle', () => {
  assert.equal(Object.keys(JOURNEY_TABLE).length, JOURNEY_STAGES.length);
  for (const s of JOURNEY_STAGES) {
    const a = journeyPuzzle(s), b = buildPuzzle(s);
    for (const k of ['id', 'seed', 'rows', 'cols', 'parMs', 'name', 'theme', 'ranked']) assert.deepEqual(a[k], b[k], `${s.id} ${k}`);
    assert.deepEqual(a.solution, b.solution, s.id);
    assert.deepEqual(a.constraints, b.constraints, s.id);
  }
});

test('boards outside the table are not taken from it', () => {
  assert.equal(journeyPuzzle({ id: 'daily-2026-10-28', rows: 10, cols: 10 }), null);
  assert.equal(journeyPuzzle({ ...JOURNEY_STAGES[0], rows: 6 }), null);
});
