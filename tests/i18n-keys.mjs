// Key extraction for the i18n coverage test (run directly to list the keys).
// Keys are the US-English source strings: literal T('…') / N('…') calls in the
// engine client (native/*.ts), and the content tables' display text (themes,
// practice presets, challenges, lessons, the first stage's intro,
// achievements) plus the symbolic help keys.
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { THEMES, PRACTICE_PRESETS, challengeSpecs, LESSONS, JOURNEY_STAGES } from '../js/content.js';
import { ACHIEVEMENTS } from '../js/progress.js';
import { EN } from '../js/strings.js';

const ROOT = new URL('..', import.meta.url).pathname;
const SKIP = new Set(['i18n.ts']);
const unescape = (s) => s.replace(/\\(['"`\\])/g, '$1');

export function sourceKeys() {
  const keys = new Set();
  const call = /(?<![\w.$])(?:T|N)\(\s*(?:'((?:[^'\\\n]|\\.)*)'|"((?:[^"\\\n]|\\.)*)")/g;
  for (const f of readdirSync(join(ROOT, 'native'))) {
    if (!/\.ts$/.test(f) || SKIP.has(f)) continue;
    const src = readFileSync(join(ROOT, 'native', f), 'utf8');
    for (const m of src.matchAll(call)) keys.add(unescape(m[1] ?? m[2]));
  }
  // Labels translated at display from the sessions' stored English (screens.ts sessionLabelFor).
  for (const k of ['Daily Glow {date}', 'Journey {n}', 'Practice · {name}', 'Custom']) keys.add(k);
  return keys;
}

export function contentKeys() {
  const keys = new Set();
  const add = (s) => { if (typeof s === 'string' && s) keys.add(s); };
  for (const t of THEMES) add(t.name);
  for (const p of PRACTICE_PRESETS) { add(p.name); add(p.note); }
  for (const c of challengeSpecs('week-1')) { add(c.name); add(c.desc); }
  for (const l of LESSONS) { add(l.name); add(l.goal); for (const s of l.steps) add(s.text); }
  for (const s of JOURNEY_STAGES) add(s.intro);
  for (const a of ACHIEVEMENTS) { add(a.name); add(a.desc); }
  for (const k of Object.keys(EN)) add(k);
  return keys;
}

export const ALL = new Set([...sourceKeys(), ...contentKeys()]);

if (process.argv[1] && process.argv[1].endsWith('i18n-keys.mjs')) console.log(JSON.stringify([...ALL], null, 1));
