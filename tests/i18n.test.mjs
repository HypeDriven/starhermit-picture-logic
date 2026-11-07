// Every player-facing string exists in all nine locales (node --test). Keys
// are the US-English source strings of the engine client (native/*.ts) and
// the content (see tests/i18n-keys.mjs); the generated picture names come
// from translated word banks; the account strings are the engine's.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { NAME_WORDS } from '../js/strings.js';
import { LOCALES, setLocale, num, puzzleName } from '../js/i18n.js';
import { NAME_A, NAME_B } from '../js/content.js';
import { ALL, EN } from './i18n-keys.mjs';

const STRINGS = JSON.parse(readFileSync(new URL('../assets/strings.json', import.meta.url), 'utf8'));

const ph = (s) => [...String(s).matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort().join(',');
const tags = (s) => (String(s).match(/<[^>]+>/g) || []).join('');

test('the key set is non-trivial', () => { assert.ok(ALL.size > 250, `only ${ALL.size} keys`); });

for (const loc of LOCALES.filter((l) => !l.startsWith('en-'))) {
  test(`${loc}: every key is translated with the same placeholders and markup`, () => {
    const d = STRINGS[loc];
    const missing = [...ALL].filter((k) => typeof d[k] !== 'string' || !d[k]);
    assert.deepEqual(missing, [], `${missing.length} missing`);
    assert.deepEqual([...ALL].filter((k) => ph(d[k]) !== ph(EN[k] ?? k)), [], 'placeholder mismatch');
    assert.deepEqual([...ALL].filter((k) => tags(d[k]) !== tags(EN[k] ?? k)), [], 'markup mismatch');
  });
}

test('no locale carries keys that no longer exist', () => {
  for (const loc of LOCALES) assert.deepEqual(Object.keys(STRINGS[loc]).filter((k) => !ALL.has(k)), [], loc);
});

test('picture-name word banks in every locale', () => {
  for (const loc of LOCALES) {
    const w = NAME_WORDS[loc] || NAME_WORDS[loc.slice(0, 2)];
    assert.ok(w, loc);
    for (const a of NAME_A) assert.ok(w.a[a], `${loc} ${a}`);
    for (const b of NAME_B) assert.ok(w.b[b], `${loc} ${b}`);
  }
});

let cur = 'en-US';
const t = (k, vars) => { const s = STRINGS[cur][k] ?? STRINGS['en-US'][k] ?? k; return vars ? s.replace(/\{(\w+)\}/g, (m, n) => (n in vars ? String(vars[n]) : m)) : s; };
const use = (l) => { cur = l; setLocale(l); };
test('tables: fallback and placeholders; regional variants; grouping and picture names', () => {
  use('de-DE');
  assert.equal(t('Not a key {x}', { x: 1 }), 'Not a key 1');
  assert.equal(t('Row {r}, column {c}, lit', { r: 2, c: 3 }), 'Zeile 2, Spalte 3, leuchtet');
  assert.equal(num(1882), '1.882');
  assert.equal(puzzleName('Lantern Fox'), 'Laternen-Fuchs');
  use('es-ES');
  assert.equal(num(1882), '1882');
  assert.equal(num(12345), '12.345');
  assert.equal(t('Gamepad'), 'Mando');
  use('fr-FR');
  assert.equal(num(1882), '1 882');
  assert.equal(puzzleName('Lantern Fox'), 'Renard Lanterne');
  use('fr-CA');
  assert.equal(t('Score'), 'Pointage');
  use('en-GB');
  assert.equal(t('Color-vision safe'), 'Colour-vision safe');
  use('en-US');
  assert.equal(num(1785), '1,785');
  assert.equal(t('Hint'), 'Hint');
});
