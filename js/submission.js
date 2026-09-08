import { validateReplay, createState, createReplayEnvelope, STATUS } from './rules.js';
import { buildPuzzle, dailySpec, challengeSpecs, CONTENT_VERSION } from './content.js';
import { fnv1a } from './prng.js';

export function validateSubmission(body) {
  const { seed, originSeed, rows, cols, density, envelope } = body || {};
  const genSeed = originSeed || seed;
  if (typeof genSeed !== 'string' || !Number.isInteger(rows) || !Number.isInteger(cols)) {
    return { ok: false, status: 400, error: 'missing-fields' };
  }
  if (rows < 3 || rows > 25 || cols < 3 || cols > 25) return { ok: false, status: 400, error: 'bad-size' };
  if (!envelope || envelope.schema !== 1) return { ok: false, status: 400, error: 'bad-envelope' };
  if (!Array.isArray(envelope.commands) || envelope.commands.length > 20000) {
    return { ok: false, status: 400, error: 'bad-command-log' };
  }
  const board = body.board;
  let spec;
  if (typeof board === 'string' && /^daily-\d{4}-\d{2}-\d{2}$/.test(board)) {
    const date = board.slice(6);
    const epoch = Date.parse(date + 'T00:00:00Z');
    if (Number.isFinite(epoch) && epoch >= 0 && new Date(epoch).toISOString().slice(0, 10) === date) spec = dailySpec(date);
  } else if (typeof board === 'string') {
    const match = board.match(/^challenge-(?:blitz|precision|silent|ledger)-(week-\d{1,6})$/);
    if (match) spec = challengeSpecs(match[1]).find(s => s.id === board);
  }
  if (!spec) return { ok: false, status: 422, error: 'unknown-board' };
  let puzzle;
  try { puzzle = buildPuzzle(spec); }
  catch { return { ok: false, status: 422, error: 'unknown-content' }; }
  const expected = createReplayEnvelope(createState(puzzle), CONTENT_VERSION, envelope.build);
  const fields = ['id', 'seed', 'rows', 'cols', 'parMs', 'content', 'solutionHash', 'initialHash'];
  if (fields.some(k => envelope[k] !== expected[k]) ||
      Object.keys(expected.constraints).some(k => envelope.constraints?.[k] !== expected.constraints[k]) ||
      genSeed !== spec.seed.toString(16) || seed !== puzzle.seed.toString(16) ||
      rows !== spec.rows || cols !== spec.cols || density !== spec.density) {
    return { ok: false, status: 422, error: 'board-content-mismatch' };
  }
  const solHash = fnv1a(puzzle.solution.join('')).toString(16);
  if (solHash !== envelope.solutionHash) return { ok: false, status: 422, error: 'solution-mismatch' };
  const verdict = validateReplay(envelope, puzzle.solution);
  if (!verdict.valid) return { ok: false, status: 422, error: `replay-invalid:${verdict.reason}` };
  if (!verdict.score || verdict.status !== STATUS.COMPLETE) return { ok: false, status: 422, error: 'incomplete-run' };
  // Plausibility: claimed score must equal the re-simulated score exactly.
  if (verdict.score.total !== body.score) return { ok: false, status: 422, error: 'score-mismatch' };
  return { ok: true, score: verdict.score, mistakes: verdict.mistakes, elapsedMs: verdict.elapsedMs };
}
