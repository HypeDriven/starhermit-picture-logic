// Every player-facing key used in markup (index.html data-i18n*), code
// (main.js / ui.js) and content (themes, presets, challenges, lessons,
// achievements, puzzle-name words) exists in all nine locales, with the same
// {placeholders} as the en-US text. Run with DUMP=1 to list the keys.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { STRINGS, EN, NAME_WORDS } from '../js/strings.js';
import { THEMES, PRACTICE_PRESETS, challengeSpecs, LESSONS, JOURNEY_STAGES, NAME_A, NAME_B } from '../js/content.js';
import { ACHIEVEMENTS } from '../js/store.js';
import { MODE_INFO } from '../js/ui.js';

const LOCALES = ['en-US', 'en-GB', 'es-419', 'es-ES', 'de-DE', 'fr-FR', 'fr-CA', 'pt-BR', 'it-IT'];
const read = (f) => readFileSync(new URL('../' + f, import.meta.url), 'utf8');
const unescape = (s) => s.replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
const lit = /'((?:[^'\\]|\\.)*)'/.source;

export function usedKeys() {
  const keys = new Set();
  const html = read('index.html');
  for (const m of html.matchAll(/data-i18n(?:-aria|-placeholder|-html)?="([^"]*)"/g)) keys.add(unescape(m[1]));
  const main = read('js/main.js');
  for (const re of [new RegExp(`\\btr\\(${lit}`, 'g'), new RegExp(`\\b[LH]\\(${lit}`, 'g'), new RegExp(`\\brow\\(${lit}`, 'g'),
    new RegExp(`,\\s*${lit}\\)\\}`, 'g'), new RegExp(`\\['[\\w-]+', ${lit}\\]`, 'g'), new RegExp(`tr\\([^()]*\\?\\s*${lit}\\s*:\\s*${lit}`, 'g')]) {
    for (const m of main.matchAll(re)) { keys.add(m[1]); if (m[2]) keys.add(m[2]); }
  }
  // message tables translated by lookup (explainInvalid, failText, sync notes)
  for (const block of [main.slice(main.indexOf('const messages = {'), main.indexOf("const msg = messages")),
    main.slice(main.indexOf('failText(reason) {'), main.indexOf('grant(key)')),
    main.slice(main.indexOf('const cloudKey = {'), main.indexOf('const cloudNote'))]) {
    for (const m of block.matchAll(new RegExp(`:\\s*${lit}`, 'g'))) keys.add(m[1]);
  }
  for (const m of main.matchAll(new RegExp(`note = ${lit}`, 'g'))) keys.add(m[1]);
  for (const m of main.matchAll(new RegExp(`note = this\\.hosted \\? ${lit} : ${lit}`, 'g'))) { keys.add(m[1]); keys.add(m[2]); }
  for (const m of main.matchAll(new RegExp(`unlocked\\.push\\(${lit}\\)`, 'g'))) keys.add(m[1]);
  const ui = read('js/ui.js');
  for (const m of ui.matchAll(new RegExp(`\\bt\\(${lit}`, 'g'))) keys.add(m[1]);
  for (const m of ui.matchAll(new RegExp(`\\bt\\([^()]*\\?\\s*${lit}\\s*:\\s*${lit}`, 'g'))) { keys.add(m[1]); keys.add(m[2]); }
  for (const m of ui.matchAll(new RegExp(`\\? \\(unlocked \\? ${lit} : ${lit}\\)`, 'g'))) { keys.add(m[1]); keys.add(m[2]); }
  for (const m of ui.matchAll(new RegExp(`: \\(unlocked \\? ${lit} : ${lit}\\)`, 'g'))) { keys.add(m[1]); keys.add(m[2]); }
  for (const m of ui.matchAll(new RegExp(`\\[${lit}, (?:comp\\.|-comp\\.|\`|keys\\()`, 'g'))) keys.add(m[1]);
  for (const m of MODE_INFO) { keys.add(m.name); keys.add(m.desc); }
  keys.add('Lesson'); keys.add('Custom');
  for (const th of THEMES) keys.add(th.name);
  for (const p of PRACTICE_PRESETS) { keys.add(p.name); keys.add(p.note); }
  for (const c of challengeSpecs('2026-W42')) { keys.add(c.name); keys.add(c.desc); }
  for (const l of LESSONS) { keys.add(l.name); keys.add(l.goal); for (const s of l.steps) keys.add(s.text); }
  for (const s of JOURNEY_STAGES) if (s.intro) keys.add(s.intro);
  for (const a of ACHIEVEMENTS) { keys.add(a.name); keys.add(a.desc); }
  for (const k of Object.keys(EN)) keys.add(k);
  // ids and numbers caught by the array/argument patterns are not strings
  for (const k of [...keys]) if (k === '' || /^(gfx|rail)-|^(tray|hint|\d+)$/.test(k)) keys.delete(k);
  return keys;
}

const ph = (s) => [...String(s).matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort().join(',');

test('every used key exists in every translated locale with matching placeholders', () => {
  const keys = usedKeys();
  if (process.env.DUMP) console.log([...keys].sort().map((k) => JSON.stringify(k)).join('\n'));
  assert.ok(keys.size > 250, 'key scan found ' + keys.size);
  const missing = [];
  for (const loc of LOCALES) {
    if (loc.startsWith('en-')) continue;
    for (const k of keys) {
      const v = STRINGS[loc][k];
      if (typeof v !== 'string' || !v) missing.push(loc + ': ' + k);
      else if (ph(v) !== ph(EN[k] ?? k)) missing.push(loc + ' placeholders: ' + k);
    }
  }
  assert.deepEqual(missing, []);
});

test('nine locales and puzzle-name word banks', () => {
  assert.deepEqual(Object.keys(STRINGS).sort(), [...LOCALES].sort());
  for (const loc of LOCALES) {
    const w = NAME_WORDS[loc] || NAME_WORDS[loc.slice(0, 2)];
    assert.ok(w, 'name words for ' + loc);
    for (const a of NAME_A) assert.ok(w.a[a], loc + ' name word ' + a);
    for (const b of NAME_B) assert.ok(w.b[b], loc + ' name word ' + b);
  }
});

test('en-GB overrides only real keys', () => {
  const keys = usedKeys();
  for (const k of Object.keys(STRINGS['en-GB'])) assert.ok(keys.has(k), 'unknown en-GB key ' + k);
});
