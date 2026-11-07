// Picture Logic — what the engine's strings don't do: digit grouping and the
// generated picture names, in the locale native/i18n.ts sets. The tables are
// assets/strings.json. Pure, so the node tests use it as is.
'use strict';

import { NAME_WORDS } from './strings.js';

export const LOCALES = ['en-US', 'en-GB', 'es-419', 'es-ES', 'de-DE', 'fr-FR', 'fr-CA', 'pt-BR', 'it-IT'];

let locale = 'en-US';
export function getLocale() { return locale; }
export function setLocale(next) { locale = LOCALES.includes(next) ? next : 'en-US'; }

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
export function puzzleName(name, t = (s) => s) {
  const parts = String(name || '').split(' ');
  const words = NAME_WORDS[locale] || NAME_WORDS[locale.slice(0, 2)];
  if (parts.length !== 2 || !words || !(parts[0] in words.a) || !(parts[1] in words.b)) return t(name);
  return words.join(words.a[parts[0]], words.b[parts[1]]);
}
