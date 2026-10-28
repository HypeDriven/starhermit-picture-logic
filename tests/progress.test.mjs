// The save document (js/progress.js): normalizing, the cloud merge, the old
// cloud slot, the options, and the progression bookkeeping (node --test).
import test from 'node:test';
import assert from 'node:assert/strict';
import * as P from '../js/progress.js';

test('normalize fills a save from anything', () => {
  const s = P.normalize(null);
  assert.equal(s.v, 1);
  assert.deepEqual(s.progress.journey, {});
  assert.equal(s.progress.lastSnapshot, null);
  assert.equal(P.normalize({ name: 'x'.repeat(40) }).name.length, 24);
  assert.deepEqual(P.normalize({ progress: { journey: 3, dailyDates: 'x' } }).progress.dailyDates, []);
});

test('mergeProgress keeps the best of both sides', () => {
  const remote = {
    journey: { 'journey-01': { stars: 3, bestScore: 500, bestMs: 9000, completed: true } },
    dailies: { '2026-10-01': { score: 100 } }, achievements: { 'first-light': '2026-10-01T00:00:00Z' },
    completions: 4, cleanStreak: 9, dailyDates: ['2026-10-01'], lessons: { 'lesson-1': true },
    leaderboard: [{ score: 10 }], lastSnapshot: { kind: 'daily' },
  };
  const local = {
    journey: { 'journey-01': { stars: 1, bestScore: 700, bestMs: 12000, completed: true }, 'journey-02': { stars: 2, bestScore: 1, bestMs: null, completed: true } },
    dailies: { '2026-10-01': { score: 300 } }, achievements: { 'first-light': '2026-10-05T00:00:00Z', 'clean-sweep': '2026-10-05T00:00:00Z' },
    completions: 2, cleanStreak: 1, dailyDates: ['2026-10-02'], leaderboard: [{ score: 20 }], lastSnapshot: null,
  };
  const m = P.mergeProgress(remote, local);
  assert.deepEqual(m.journey['journey-01'], { stars: 3, bestScore: 700, bestMs: 9000, completed: true });
  assert.ok(m.journey['journey-02'].completed);
  assert.equal(m.dailies['2026-10-01'].score, 300);
  assert.equal(m.achievements['first-light'], '2026-10-01T00:00:00Z');
  assert.ok(m.achievements['clean-sweep']);
  assert.equal(m.completions, 4);
  assert.equal(m.cleanStreak, 1);
  assert.deepEqual(m.dailyDates, ['2026-10-01', '2026-10-02']);
  assert.deepEqual(m.leaderboard.map((e) => e.score), [20, 10]);
  assert.deepEqual(m.lastSnapshot, { kind: 'daily' });
  assert.ok(m.lessons['lesson-1']);
});

test('mergeSave keeps this device\'s name and is stable', () => {
  const a = P.mergeSave({ progress: { completions: 3 }, name: 'Old' }, { progress: { completions: 1 }, name: 'New' });
  assert.equal(a.name, 'New');
  assert.equal(a.progress.completions, 3);
  assert.ok(P.sameSave(a, P.mergeSave(a, a)));
});

test('the browser build\'s cloud document reads as progress, name and options', () => {
  const text = JSON.stringify({
    savedAt: '2026-10-01', settings: { theme: 'ember-night', palette: 'cvd', leftHanded: true, holdToMark: 'yes', inputMode: 'mark', profileName: 'Lumen', graphics: {} },
    progress: { journey: { 'journey-01': { stars: 2, bestScore: 1, bestMs: 1, completed: true } } },
  });
  const r = P.readForeign(text);
  assert.equal(r.save.name, 'Lumen');
  assert.equal(r.save.progress.journey['journey-01'].stars, 2);
  assert.deepEqual(r.options, { theme: 'ember-night', palette: 'cvd', leftHanded: true, inputMode: 'mark' });
  assert.equal(P.readForeign('nope'), null);
  assert.equal(P.readForeign(JSON.stringify([1])), null);
});

test('options: only valid values pass', () => {
  assert.deepEqual(P.pickOptions({ theme: 'x', palette: 'standard', captions: false, inputMode: 'erase' }), { palette: 'standard', captions: false });
  assert.ok(P.BROWSER_KEYS.includes('volumes'));
  for (const k of P.OPTION_KEYS) assert.ok(P.BROWSER_KEYS.includes(k), k);
});

test('journey stars, daily streaks, achievements and the local board', () => {
  const p = P.emptyProgress();
  assert.equal(P.recordJourney(p, 'journey-01', { score: 100, mistakes: 0, hints: 0, elapsedMs: 10, parMs: 100, completed: true }).stars, 3);
  assert.equal(P.recordJourney(p, 'journey-01', { score: 50, mistakes: 1, hints: 0, elapsedMs: 200, parMs: 100, completed: true }).stars, 3);
  assert.equal(p.journey['journey-01'].bestMs, 10);
  const stages = [{ id: 'journey-01' }, { id: 'journey-02' }, { id: 'journey-03' }];
  assert.ok(P.journeyUnlocked(p, 1, stages));
  assert.ok(!P.journeyUnlocked(p, 2, stages));
  for (const d of ['2026-10-01', '2026-10-02', '2026-10-03']) P.recordDaily(p, d, { score: 5, mistakes: 0, elapsedMs: 1, seed: 'a' });
  assert.equal(P.dailyStreak(p, '2026-10-03'), 3);
  assert.equal(P.dailyStreak(p, '2026-10-04'), 3);
  assert.equal(P.dailyStreak(p, '2026-10-06'), 0);
  assert.ok(P.unlockAchievement(p, 'first-light', 'now'));
  assert.ok(!P.unlockAchievement(p, 'first-light', 'later'));
  for (let i = 0; i < 60; i++) P.addLeaderboard(p, { score: i, mode: i % 2 ? 'practice' : 'daily', presetId: 'practice-calm' });
  assert.equal(p.leaderboard.length, 50);
  assert.equal(p.leaderboard[0].score, 59);
  assert.equal(P.practiceBests(p)['practice-calm'], 59);
});
