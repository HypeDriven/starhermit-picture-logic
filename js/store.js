// Picture Logic — versioned, checksummed local persistence.
// Settings and progression live in separate documents; conflicts with cloud
// snapshots are resolved by the caller (both preserved, player decides).
'use strict';

import { fnv1a } from './prng.js';

const SETTINGS_KEY = 'picture-logic.settings.v1';
const PROGRESS_KEY = 'picture-logic.progress.v1';
const DOC_VERSION = 1;

function checksum(payload) {
  return fnv1a(JSON.stringify(payload)).toString(16).padStart(8, '0');
}

export const DEFAULT_SETTINGS = {
  theme: 'dawn-garden',
  palette: 'standard',       // 'standard' | 'cvd'
  quality: 'auto',           // 'auto' | 'low' | 'medium' | 'high'
  reducedMotion: false,
  highContrast: false,
  largeText: false,
  leftHanded: false,
  holdToMark: false,         // hold-vs-toggle: hold right-mouse/long-press to mark
  captions: true,
  volumes: { music: 0.5, effects: 0.8, ambience: 0.35 },
  muted: false,
  inputMode: 'fill',
  gamepadMap: { fill: 0, mark: 2, hint: 3, undo: 4, pause: 9, camera: 8 },
  consentTelemetry: false,
  profileName: '',
  tutorialsDone: {},
};

export const DEFAULT_PROGRESS = {
  journey: {},               // id -> { stars, bestScore, bestMs, completed }
  lessons: {},               // id -> true
  dailies: {},               // dateKey -> { score, mistakes, elapsedMs, clean }
  challenges: {},            // id -> { score, ... }
  practicePlays: 0,
  completions: 0,
  cleanStreak: 0,
  bestCleanStreak: 0,
  dailyDates: [],            // sorted UTC date keys played
  achievements: {},          // key -> unlockedAt ISO
  leaderboard: [],           // local score board entries
  lastSnapshot: null,        // last safe in-progress solo snapshot
  excludedDailies: [],       // defective days marked excluded from ranking
};

function readDoc(key, defaults) {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return structuredClone(defaults);
    const doc = JSON.parse(raw);
    if (doc.v !== DOC_VERSION) return migrate(doc, defaults);
    if (doc.sum !== checksum(doc.data)) {
      console.warn(`[store] checksum mismatch in ${key}; resetting to defaults`);
      return structuredClone(defaults);
    }
    return Object.assign(structuredClone(defaults), doc.data);
  } catch (err) {
    console.warn(`[store] failed to read ${key}`, err);
    return structuredClone(defaults);
  }
}

function migrate(doc, defaults) {
  // Versioned migration point. v1 is current; unknown/older docs fall back
  // to defaults while preserving any recognizable fields.
  const data = Object.assign(structuredClone(defaults), doc.data || {});
  return data;
}

function writeDoc(key, data) {
  try {
    const doc = { v: DOC_VERSION, data, sum: checksum(data) };
    localStorage.setItem(key, JSON.stringify(doc));
  } catch (err) {
    console.warn(`[store] failed to write ${key}`, err);
  }
}

export class Store {
  constructor() {
    this.settings = readDoc(SETTINGS_KEY, DEFAULT_SETTINGS);
    this.progress = readDoc(PROGRESS_KEY, DEFAULT_PROGRESS);
  }
  saveSettings() { writeDoc(SETTINGS_KEY, this.settings); }
  saveProgress() { writeDoc(PROGRESS_KEY, this.progress); }

  // Journey stars: 1 finish, +1 clean (no mistakes/hints), +1 under par.
  recordJourney(stageId, { score, mistakes, hints, elapsedMs, parMs, completed }) {
    const j = this.progress.journey;
    const prev = j[stageId] || { stars: 0, bestScore: 0, bestMs: null, completed: false };
    let stars = 0;
    if (completed) {
      stars = 1 + (mistakes === 0 && hints === 0 ? 1 : 0) + (elapsedMs <= parMs ? 1 : 0);
    }
    j[stageId] = {
      stars: Math.max(prev.stars, stars),
      bestScore: Math.max(prev.bestScore, score),
      bestMs: prev.bestMs === null ? (completed ? elapsedMs : null)
        : (completed ? Math.min(prev.bestMs, elapsedMs) : prev.bestMs),
      completed: prev.completed || completed,
    };
    this.saveProgress();
    return j[stageId];
  }

  journeyUnlocked(index, stages) {
    if (index === 0) return true;
    const prev = this.progress.journey[stages[index - 1].id];
    return !!(prev && prev.completed);
  }

  recordDaily(dateKey, entry) {
    const prev = this.progress.dailies[dateKey];
    if (!prev || entry.score > prev.score) this.progress.dailies[dateKey] = entry;
    if (!this.progress.dailyDates.includes(dateKey)) {
      this.progress.dailyDates.push(dateKey);
      this.progress.dailyDates.sort();
    }
    this.saveProgress();
  }

  dailyStreak(todayKey) {
    const dates = this.progress.dailyDates;
    if (!dates.length) return 0;
    let streak = 0;
    let cursor = new Date(todayKey + 'T00:00:00Z').getTime();
    // Allow the streak to start today or yesterday.
    if (!dates.includes(new Date(cursor).toISOString().slice(0, 10))) cursor -= 86400000;
    while (dates.includes(new Date(cursor).toISOString().slice(0, 10))) {
      streak++;
      cursor -= 86400000;
    }
    return streak;
  }

  unlockAchievement(key) {
    if (this.progress.achievements[key]) return false; // idempotent
    this.progress.achievements[key] = new Date().toISOString();
    this.saveProgress();
    return true;
  }

  addLeaderboard(entry) {
    const lb = this.progress.leaderboard;
    lb.push(entry);
    lb.sort((a, b) => b.score - a.score);
    this.progress.leaderboard = lb.slice(0, 50);
    this.saveProgress();
  }
}

export const ACHIEVEMENTS = [
  { key: 'first-light', name: 'First Light', desc: 'Complete your first picture.' },
  { key: 'clean-sweep', name: 'Clean Sweep', desc: 'Finish a puzzle with no mistakes and no hints.' },
  { key: 'streak-3', name: 'Steady Glow', desc: 'Three clean completions in a row.' },
  { key: 'daily-7', name: 'Week of Light', desc: 'Play the Daily Glow seven days in a row.' },
  { key: 'mastery', name: 'Mastery Bloom', desc: 'Complete a gold mastery stage.' },
  { key: 'century', name: 'Keeper of the Board', desc: 'Complete 100 puzzles.' },
];
