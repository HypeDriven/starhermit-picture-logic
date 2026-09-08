import assert from 'node:assert/strict';
import { validateSubmission } from '../js/submission.js';
import { buildPuzzle, dailySpec, challengeSpecs, CONTENT_VERSION } from '../js/content.js';
import { createState, createReplayEnvelope, applyCommand, replayRecord, scoreComponents, STATUS } from '../js/rules.js';
for (const spec of [dailySpec('2026-09-08'), ...challengeSpecs('week-2957')]) {
  const puzzle = buildPuzzle(spec), state = createState(puzzle);
  const envelope = createReplayEnvelope(state, CONTENT_VERSION, 'test');
  const tick = {type:'tick', ms:21000};
  replayRecord(envelope, state, tick, applyCommand(state,tick));
  for (let i = 0; i < puzzle.solution.length && state.status === STATUS.ACTIVE; i++) {
    if (!puzzle.solution[i] || state.grid[i] === 1) continue;
    const cmd = {type:'fill', r:Math.floor(i/state.cols), c:i%state.cols};
    const result = applyCommand(state,cmd); assert.ok(result.ok);
    replayRecord(envelope,state,cmd,result);
  }
  assert.equal(state.status,STATUS.COMPLETE);
  const body = {board:spec.id,seed:puzzle.seed.toString(16),originSeed:spec.seed.toString(16),rows:spec.rows,cols:spec.cols,density:spec.density,score:scoreComponents(state).total,envelope};
  const verdict = validateSubmission(body); assert.ok(verdict.ok,JSON.stringify(verdict)); assert.equal(verdict.elapsedMs,21000);
  for (const alter of [b=>b.board='arbitrary',b=>b.envelope.parMs=99999999,b=>b.envelope.constraints.allowUndo=true,b=>b.envelope.seed++,b=>b.originSeed='abc',b=>b.envelope.content=999]) {
    const changed = structuredClone(body); alter(changed); assert.equal(validateSubmission(changed).ok,false);
  }
}
console.log('Submission contracts: five valid boards and 30 altered claims passed');
