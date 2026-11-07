// Localization: assets/strings.json (US-English text as the keys, the nine
// StarHermit locales) through the engine's strings, with its starhermit.*
// account strings, in the interface language the runtime reports (Options ›
// Language, else the account's or the device's). Every string is drawn through
// T() each frame, so a change shows on the next frame and never restarts the round.
import { strings } from "starhermit:engine";
import * as ui from "starhermit:ui";
import { num as groupNum, puzzleName as localName, setLocale } from "../js/i18n.js";

strings.load("assets/strings.json");
strings.defaultLocale = "en-US";
function apply(locale: string): void { setLocale(locale); ui.setLanguage(locale); }
apply(strings.locale);
strings.onChange(apply);

export type Vars = Record<string, string | number>;
/** An English source string in the player's language; `{name}` placeholders from vars. A text with no entry is itself. */
export function T(key: string, vars?: Vars | null): string {
  const k = String(key);
  if (strings.has(k)) return strings.t(k, vars ?? undefined);
  return vars ? k.replace(/\{(\w+)\}/g, (m, n: string) => (n in vars ? String(vars[n]) : m)) : k;
}
/** Marks an English key that is translated with T() where it is shown. */
export const N = (s: string): string => s;
/** Scores with the locale's digit grouping. */
export function num(n: number): string { return groupNum(n) as string; }
/** A generated picture name ("Lantern Fox") in the player's language. */
export function puzzleName(name: string): string { return localName(name, T) as string; }
/** The engine's account strings. */
export function S(key: string, vars?: Vars): string { return strings.t(`starhermit.${key}`, vars); }
