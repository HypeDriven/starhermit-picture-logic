// Picture Logic — the save document, its merge, the progression bookkeeping
// (journey stars, daily results and streaks, achievements, the local board,
// the in-progress snapshot) and the game's own options. Pure (no storage, no
// platform): the engine client (native/platform.ts) and the node tests share
// it. Moved here from the browser build's js/store.js, unchanged in what it
// decides.
//
// The engine save is { v, progress, name }:
//  - progress: the browser build's progression document
//    (picture-logic.progress.v1 in localStorage, mirrored with the settings
//    to the cloud slot game:<slug>), the in-progress snapshot included;
//  - name: the guest's display name (the old settings.profileName).
// The browser build's cloud slot held { savedAt, settings, progress }:
// readForeign() reads that text (the progress, the name and the options).
'use strict';

export const SAVE_VERSION = 1;

const obj = (v) => (v && typeof v === 'object' && !Array.isArray(v) ? v : null);
const arr = (v) => (Array.isArray(v) ? v : []);
const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
const clone = (x) => JSON.parse(JSON.stringify(x));

export const ACHIEVEMENTS = [
  { key: 'first-light', name: 'First Light', desc: 'Complete your first picture.' },
  { key: 'clean-sweep', name: 'Clean Sweep', desc: 'Finish a puzzle with no mistakes and no hints.' },
  { key: 'streak-3', name: 'Steady Glow', desc: 'Three clean completions in a row.' },
  { key: 'daily-7', name: 'Week of Light', desc: 'Play the Daily Glow seven days in a row.' },
  { key: 'mastery', name: 'Mastery Bloom', desc: 'Complete a gold mastery stage.' },
  { key: 'century', name: 'Keeper of the Board', desc: 'Complete 100 puzzles.' },
];

/** store.js DEFAULT_PROGRESS. */
export function emptyProgress() {
  return {
    journey: {},               // id -> { stars, bestScore, bestMs, completed }
    lessons: {},               // id -> true
    dailies: {},               // dateKey -> { score, mistakes, elapsedMs, seed }
    challenges: {},            // id -> { score, mistakes, elapsedMs }
    practicePlays: 0,
    completions: 0,
    cleanStreak: 0,
    bestCleanStreak: 0,
    dailyDates: [],            // sorted UTC date keys played
    achievements: {},          // key -> unlockedAt ISO
    leaderboard: [],           // local score board entries (top 50)
    lastSnapshot: null,        // last safe in-progress solo snapshot
    excludedDailies: [],       // defective days marked excluded from ranking
  };
}

export function defaultSave() {
  return { v: SAVE_VERSION, progress: emptyProgress(), name: '' };
}

/** A progress document from anything (missing fields from the empty one). */
export function normalizeProgress(raw) {
  const p = obj(raw) ? clone(raw) : {};
  const out = { ...emptyProgress(), ...p };
  for (const k of ['journey', 'lessons', 'dailies', 'challenges', 'achievements']) out[k] = obj(out[k]) || {};
  for (const k of ['dailyDates', 'leaderboard', 'excludedDailies']) out[k] = arr(out[k]);
  for (const k of ['practicePlays', 'completions', 'cleanStreak', 'bestCleanStreak']) out[k] = num(out[k]);
  out.lastSnapshot = obj(out.lastSnapshot);
  return out;
}

/** A save document from anything. */
export function normalize(raw) {
  const d = obj(raw) || {};
  return {
    v: SAVE_VERSION,
    progress: normalizeProgress(d.progress),
    name: typeof d.name === 'string' ? d.name.slice(0, 24) : '',
  };
}

// Cloud-save merge (store.js mergeProgress, run by the browser build on its
// start-up load and on `saveconflict`): neither side's progress is dropped.
// Best values win per record; sets are unioned; the in-progress snapshot and
// the current clean streak are this device's.
export function mergeProgress(remote, local) {
  const r = obj(remote) || {};
  const l = obj(local) || {};
  const o = (v) => obj(v) || {};
  const journey = { ...o(r.journey) };
  for (const [id, b] of Object.entries(o(l.journey))) {
    const a = journey[id];
    if (!a) { journey[id] = b; continue; }
    const ms = [a.bestMs, b.bestMs].filter((x) => typeof x === 'number');
    journey[id] = {
      stars: Math.max(num(a.stars), num(b.stars)),
      bestScore: Math.max(num(a.bestScore), num(b.bestScore)),
      bestMs: ms.length ? Math.min(...ms) : null,
      completed: !!(a.completed || b.completed),
    };
  }
  const better = (x, y) => (!x ? y : !y ? x : num(y.score) > num(x.score) ? y : x);
  const dailies = { ...o(r.dailies) };
  for (const [k, v] of Object.entries(o(l.dailies))) dailies[k] = better(dailies[k], v);
  const challenges = { ...o(r.challenges) };
  for (const [k, v] of Object.entries(o(l.challenges))) challenges[k] = better(challenges[k], v);
  const achievements = { ...o(r.achievements) };
  for (const [k, v] of Object.entries(o(l.achievements))) {
    achievements[k] = achievements[k] && String(achievements[k]) < String(v) ? achievements[k] : v;
  }
  const seen = new Set();
  const leaderboard = [...arr(l.leaderboard), ...arr(r.leaderboard)]
    .filter((e) => { const k = JSON.stringify(e); if (seen.has(k)) return false; seen.add(k); return true; })
    .sort((a, b) => num(b.score) - num(a.score)).slice(0, 50);
  return normalizeProgress({
    ...r, ...l,
    journey,
    lessons: { ...o(r.lessons), ...o(l.lessons) },
    dailies, challenges, achievements, leaderboard,
    practicePlays: Math.max(num(r.practicePlays), num(l.practicePlays)),
    completions: Math.max(num(r.completions), num(l.completions)),
    cleanStreak: num(l.cleanStreak),
    bestCleanStreak: Math.max(num(r.bestCleanStreak), num(l.bestCleanStreak)),
    dailyDates: [...new Set([...arr(r.dailyDates), ...arr(l.dailyDates)])].sort(),
    excludedDailies: [...new Set([...arr(r.excludedDailies), ...arr(l.excludedDailies)])],
    lastSnapshot: l.lastSnapshot || r.lastSnapshot || null,
  });
}

/** Two saves merged: the progress as above, this device's name (else the other's). */
export function mergeSave(remote, local) {
  const a = normalize(remote), b = normalize(local);
  return { v: SAVE_VERSION, progress: mergeProgress(a.progress, b.progress), name: b.name || a.name };
}

export function sameSave(a, b) {
  return JSON.stringify(normalize(a)) === JSON.stringify(normalize(b));
}

// --- the game's own options (the browser build's settings the runtime does not own) -----------
export const THEME_IDS = ['dawn-garden', 'tide-glass', 'ember-night', 'moss-archive', 'snow-signal'];
export const PALETTES = ['standard', 'cvd'];
export const DEFAULT_OPTIONS = { theme: 'dawn-garden', palette: 'standard', leftHanded: false, holdToMark: false, captions: true, inputMode: 'fill' };
export const OPTION_KEYS = Object.keys(DEFAULT_OPTIONS);
/** Every key the browser build mirrored to the account's settings KV (store.js DEFAULT_SETTINGS). */
export const BROWSER_KEYS = ['theme', 'palette', 'graphics', 'reducedMotion', 'highContrast', 'largeText', 'leftHanded', 'holdToMark',
  'captions', 'volumes', 'muted', 'inputMode', 'gamepadMap', 'consentTelemetry', 'profileName', 'tutorialsDone', 'quality'];

/** The valid options in `raw` (others left out). */
export function pickOptions(raw) {
  const r = obj(raw) || {};
  const out = {};
  if (THEME_IDS.includes(r.theme)) out.theme = r.theme;
  if (PALETTES.includes(r.palette)) out.palette = r.palette;
  for (const k of ['leftHanded', 'holdToMark', 'captions']) if (typeof r[k] === 'boolean') out[k] = r[k];
  if (r.inputMode === 'fill' || r.inputMode === 'mark') out.inputMode = r.inputMode;
  return out;
}

/** The browser build's cloud slot text ({ savedAt, settings, progress }) → { save, options }, or null. */
export function readForeign(text) {
  if (typeof text !== 'string' || !text) return null;
  let d;
  try { d = JSON.parse(text); } catch { return null; }
  if (!obj(d)) return null;
  const progress = obj(d.progress) ? d.progress : ('journey' in d || 'achievements' in d ? d : null);
  const settings = obj(d.settings) || {};
  if (!progress && !obj(d.settings)) return null;
  return {
    save: normalize({ progress: progress || {}, name: typeof settings.profileName === 'string' ? settings.profileName : '' }),
    options: pickOptions(settings),
  };
}

// --- progression (store.js Store methods, on a progress document) ------------------------------

/** Journey stars: 1 finish, +1 clean (no mistakes/hints), +1 under par. Returns the record. */
export function recordJourney(p, stageId, { score, mistakes, hints, elapsedMs, parMs, completed }) {
  const prev = p.journey[stageId] || { stars: 0, bestScore: 0, bestMs: null, completed: false };
  let stars = 0;
  if (completed) stars = 1 + (mistakes === 0 && hints === 0 ? 1 : 0) + (elapsedMs <= parMs ? 1 : 0);
  p.journey[stageId] = {
    stars: Math.max(prev.stars, stars),
    bestScore: Math.max(prev.bestScore, score),
    bestMs: prev.bestMs === null || prev.bestMs === undefined ? (completed ? elapsedMs : null)
      : (completed ? Math.min(prev.bestMs, elapsedMs) : prev.bestMs),
    completed: !!prev.completed || completed,
  };
  return p.journey[stageId];
}

export function journeyUnlocked(p, index, stages) {
  if (index === 0) return true;
  const prev = p.journey[stages[index - 1].id];
  return !!(prev && prev.completed);
}

export function recordDaily(p, dateKey, entry) {
  const prev = p.dailies[dateKey];
  if (!prev || entry.score > prev.score) p.dailies[dateKey] = entry;
  if (!p.dailyDates.includes(dateKey)) {
    p.dailyDates.push(dateKey);
    p.dailyDates.sort();
  }
}

export function dailyStreak(p, todayKey) {
  const dates = p.dailyDates;
  if (!dates.length) return 0;
  let streak = 0;
  let cursor = new Date(todayKey + 'T00:00:00Z').getTime();
  // The streak may start today or yesterday.
  if (!dates.includes(new Date(cursor).toISOString().slice(0, 10))) cursor -= 86400000;
  while (dates.includes(new Date(cursor).toISOString().slice(0, 10))) {
    streak++;
    cursor -= 86400000;
  }
  return streak;
}

/** Idempotent: true when newly unlocked. */
export function unlockAchievement(p, key, nowIso) {
  if (p.achievements[key]) return false;
  p.achievements[key] = nowIso;
  return true;
}

export function addLeaderboard(p, entry) {
  p.leaderboard.push(entry);
  p.leaderboard.sort((a, b) => b.score - a.score);
  p.leaderboard = p.leaderboard.slice(0, 50);
}

/** Best practice score per preset id (main.js practiceBests). */
export function practiceBests(p) {
  const bests = {};
  for (const e of p.leaderboard) if (e.mode === 'practice') bests[e.presetId] = Math.max(bests[e.presetId] || 0, e.score);
  return bests;
}
