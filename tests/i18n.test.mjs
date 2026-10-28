// Every player-facing string exists in all nine locales (node --test). Keys
// are the US-English source strings of the engine client (native/*.ts) and
// the content (see tests/i18n-keys.mjs); the generated picture names come
// from translated word banks; the account strings are in js/platform-i18n.js.
import test from 'node:test';
import assert from 'node:assert/strict';
import { STRINGS, EN, NAME_WORDS } from '../js/strings.js';
import { LOCALES, t, setLocale, num, puzzleName } from '../js/i18n.js';
import { platformStrings } from '../js/platform-i18n.js';
import { NAME_A, NAME_B } from '../js/content.js';
import { ALL } from './i18n-keys.mjs';

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

test('picture-name word banks and account strings in every locale', () => {
  for (const loc of LOCALES) {
    const w = NAME_WORDS[loc] || NAME_WORDS[loc.slice(0, 2)];
    assert.ok(w, loc);
    for (const a of NAME_A) assert.ok(w.a[a], `${loc} ${a}`);
    for (const b of NAME_B) assert.ok(w.b[b], `${loc} ${b}`);
    const sh = platformStrings(loc);
    for (const k of ['signIn', 'invite', 'inviteCopied', 'inviteFailed', 'signedOut', 'lbPosting', 'lbRank', 'lbPosted', 'lbFailed']) assert.ok(sh[k], `${loc} ${k}`);
    assert.match(sh.lbRank, /\{rank\}/);
  }
});

test('t() falls back and fills placeholders; regional variants; grouping and picture names', () => {
  setLocale('de-DE');
  assert.equal(t('Not a key {x}', { x: 1 }), 'Not a key 1');
  assert.equal(t('Row {r}, column {c}, lit', { r: 2, c: 3 }), 'Zeile 2, Spalte 3, leuchtet');
  assert.equal(num(1882), '1.882');
  assert.equal(puzzleName('Lantern Fox'), 'Laternen-Fuchs');
  setLocale('es-ES');
  assert.equal(num(1882), '1882');
  assert.equal(num(12345), '12.345');
  assert.equal(t('Gamepad'), 'Mando');
  setLocale('fr-FR');
  assert.equal(num(1882), '1 882');
  assert.equal(puzzleName('Lantern Fox'), 'Renard Lanterne');
  setLocale('fr-CA');
  assert.equal(t('Score'), 'Pointage');
  setLocale('en-GB');
  assert.equal(t('Color-vision safe'), 'Colour-vision safe');
  setLocale('en-US');
  assert.equal(num(1785), '1,785');
  assert.equal(t('Hint'), 'Hint');
});
