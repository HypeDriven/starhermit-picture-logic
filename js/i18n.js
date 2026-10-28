// Picture Logic — the game language for every string module (this file and
// platform-i18n.js are read with getLocale()). The engine client sets the
// locale from the runtime's interface language (native/i18n.ts); the browser
// build's sh-language.js resolution and the DOM re-labelling are the
// runtime's now. Strings are keyed by their en-US text; EN holds the symbolic
// keys. Pure, so the node tests use it as is.
'use strict';

import { STRINGS, EN, NAME_WORDS } from './strings.js';

export const LOCALES = ['en-US', 'en-GB', 'es-419', 'es-ES', 'de-DE', 'fr-FR', 'fr-CA', 'pt-BR', 'it-IT'];

let locale = 'en-US';
let table = STRINGS['en-US'];

/** Translate an en-US string (or symbolic key); {name} placeholders filled from vars. */
export function t(key, vars) {
  let s = table[key] ?? STRINGS['en-US'][key] ?? EN[key] ?? key;
  if (vars) s = s.replace(/\{(\w+)\}/g, (m, k) => (k in vars ? String(vars[k]) : m));
  return s;
}

export function getLocale() { return locale; }

export function setLocale(next) {
  locale = LOCALES.includes(next) ? next : 'en-US';
  table = STRINGS[locale] || STRINGS['en-US'];
}

// Locale-aware digit grouping for scores, as the browser build's
// toLocaleString gave it (the native interpreter has no Intl): ',' in
// English and Latin-American Spanish, '.' in German, Italian, Portuguese and
// European Spanish (which leaves four-digit numbers ungrouped), a narrow
// no-break space in French.
const GROUP = { 'en-US': ',', 'en-GB': ',', 'es-419': ',', 'es-ES': '.', 'de-DE': '.', 'fr-FR': ' ', 'fr-CA': ' ', 'pt-BR': '.', 'it-IT': '.' };
export function num(n) {
  const v = Math.round(Number(n) || 0);
  const s = String(Math.abs(v));
  if (s.length <= 3 || (locale === 'es-ES' && s.length === 4)) return (v < 0 ? '-' : '') + s;
  const sep = GROUP[locale] || ',';
  return (v < 0 ? '-' : '') + s.replace(/\B(?=(\d{3})+(?!\d))/g, sep);
}

/** Generated picture names ("Lantern Fox") in the current language. */
export function puzzleName(name) {
  const parts = String(name || '').split(' ');
  const words = NAME_WORDS[locale] || NAME_WORDS[locale.slice(0, 2)];
  if (parts.length !== 2 || !words || !(parts[0] in words.a) || !(parts[1] in words.b)) return t(name);
  return words.join(words.a[parts[0]], words.b[parts[1]]);
}
