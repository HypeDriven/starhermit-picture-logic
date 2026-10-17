// Picture Logic — game language. One source for every string module (this
// file, gfx-strings.js and platform-i18n.js are read with getLocale()):
// sh-language.js resolves the Language setting — explicit game choice
// (ui.language) → for Automatic the StarHermit account's preferred language →
// navigator.languages → en-US. Strings are keyed by their en-US text; EN holds
// the symbolic keys. A change re-applies static markup (data-i18n,
// data-i18n-html, data-i18n-aria, data-i18n-placeholder) and fires listeners.
'use strict';

import { STRINGS, EN, NAME_WORDS } from './strings.js';

export const LOCALES = ['en-US', 'en-GB', 'es-419', 'es-ES', 'de-DE', 'fr-FR', 'fr-CA', 'pt-BR', 'it-IT'];

let locale = 'en-US';
let table = STRINGS['en-US'];
const listeners = new Set();

/** Translate an en-US string (or symbolic key); {name} placeholders filled from vars. */
export function t(key, vars) {
  let s = table[key] ?? STRINGS['en-US'][key] ?? EN[key] ?? key;
  if (vars) s = s.replace(/\{(\w+)\}/g, (m, k) => (k in vars ? String(vars[k]) : m));
  return s;
}

export function getLocale() { return locale; }

/** Locale-aware number grouping (scores). */
export function num(n) { return Number(n).toLocaleString(locale); }

/** fn(locale) after every language change. */
export function onLocaleChange(fn) { listeners.add(fn); return () => listeners.delete(fn); }

/** Re-apply static markup under root. */
export function applyStatic(root = document) {
  for (const n of root.querySelectorAll('[data-i18n-html]')) n.innerHTML = t(n.dataset.i18nHtml);
  for (const n of root.querySelectorAll('[data-i18n]')) n.textContent = t(n.dataset.i18n);
  for (const n of root.querySelectorAll('[data-i18n-aria]')) n.setAttribute('aria-label', t(n.dataset.i18nAria));
  for (const n of root.querySelectorAll('[data-i18n-placeholder]')) n.setAttribute('placeholder', t(n.dataset.i18nPlaceholder));
}

export function setLocale(next) {
  const resolved = LOCALES.includes(next) ? next : 'en-US';
  const changed = resolved !== locale;
  locale = resolved;
  table = STRINGS[locale] || STRINGS['en-US'];
  if (typeof document === 'undefined') return;
  document.documentElement.lang = locale;
  if (document.readyState !== 'loading') applyStatic();
  if (changed) for (const fn of listeners) { try { fn(locale); } catch (e) { console.error(e); } }
}

/** Generated picture names ("Lantern Fox") in the current language. */
export function puzzleName(name) {
  const parts = String(name || '').split(' ');
  const words = NAME_WORDS[locale] || NAME_WORDS[locale.slice(0, 2)];
  if (parts.length !== 2 || !words || !(parts[0] in words.a) || !(parts[1] in words.b)) return t(name);
  return words.join(words.a[parts[0]], words.b[parts[1]]);
}

// sh-language.js (classic script before the modules) owns resolution, storage
// and the Settings → Language selector; it calls apply() now and on changes.
export const language = (typeof window !== 'undefined' && window.StarHermitLanguage)
  ? window.StarHermitLanguage.create({ game: 'picture-logic', supported: LOCALES, apply: setLocale })
  : null;
if (!language) setLocale('en-US');
if (typeof document !== 'undefined' && document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => applyStatic(), { once: true });
}
