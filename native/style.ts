// The look of the menus, HUD, rails, tray and sheets: the browser build's
// css/style.css, rewritten class-based in tools/ui-style.css and converted
// once with `starhermit css` into assets/ui-style.json (`npm run css`),
// registered at start with the theme the runtime's own widgets (scroll bars,
// focus rings, selects, text fields) take. The colours the browser build set
// from JS (ui.js setThemeVars: --bg, --filled, --marked, --accent from
// Settings › Theme, or the colour-vision-safe palette) and body.high-contrast
// (the runtime's high contrast) are token sets applied here; the colour-mix()
// shades the sheet used are recomputed from them.
import { files } from "starhermit:engine";
import * as ui from "starhermit:ui";
import { Content } from "./game.ts";

type Tokens = Record<string, string>;
const BASE: Tokens = {
  bg: "#141a28", panel: "#1c2436", "panel-2": "#232d44", "panel-hover": "#2b3752", ink: "#e8ecf4", "ink-dim": "#9aa6bf", line: "#33405e",
  filled: "#e8a84b", marked: "#7b88a8", accent: "#8fd6a0", danger: "#ef6f6c", focus: "#ffd166", "on-accent": "#12202a",
};
/** body.high-contrast. */
const CONTRAST: Tokens = { line: "#6b7ba0", ink: "#ffffff", "ink-dim": "#c6d0e4" };

const alpha = (c: string, a: number): string => c.slice(0, 7) + Math.round(a * 255).toString(16).padStart(2, "0");
let current: Tokens = { ...BASE };

/** The tokens for a theme, palette and contrast (ui.js setThemeVars + applyAccessibilityClasses). */
export function tokensFor(themeId: string, palette: string, highContrast: boolean): Tokens {
  const th = Content.themeById(themeId);
  const t: Tokens = { ...BASE, bg: th.ui.bg, filled: th.ui.filled, marked: th.ui.marked, accent: th.ui.accent };
  if (palette === "cvd") {
    const p = Content.CVD_PALETTE;
    Object.assign(t, { filled: p.filled, marked: p.marked, accent: p.accent, danger: p.error });
  }
  if (highContrast) Object.assign(t, CONTRAST);
  t["panel-82"] = alpha(t.panel!, 0.82);
  t["panel-80"] = alpha(t.panel!, 0.8);
  t["accent-40"] = alpha(t.accent!, 0.4);
  return t;
}

export function initStyles(): void {
  const css = files.readJson("assets/ui-style.json") as unknown as ui.CssStyles;
  ui.setTheme({
    fontSize: 16, smallSize: 13.6, headingSize: 20, padding: 8, spacing: 8, radius: 12,
    text: BASE.ink!, muted: BASE["ink-dim"]!, panel: BASE.panel!, control: BASE["panel-2"]!, hovered: BASE["panel-hover"]!,
    pressed: BASE.line!, field: BASE["panel-2"]!, accent: BASE.accent!, focus: BASE.focus!, outline: BASE.line!,
  });
  ui.setTokens(css.tokens);
  ui.setStyles({
    ...css.styles,
    label: { text: { color: "$ink" } },
    paragraph: { text: { color: "$ink" } },
    heading: { text: { color: "$ink" } },
    widget: { focusRing: { color: "$focus", width: 3, offset: 2 } },
    scrollArea: { parts: { bar: { background: "$line", radius: 4 } } },
    tooltip: { background: "$panel-2", text: { color: "$ink" }, radius: 6, padding: 6 },
    // The overlays' dim (rgba(8, 12, 20, 0.72)) behind the sheets.
    dialog: { background: "#00000000", padding: 0, parts: { backdrop: { background: "#080c14b8" } } },
  });
  applyTokens("dawn-garden", "standard", false);
}

let key = "";
/** Applies the theme / palette / contrast tokens (cheap when unchanged). */
export function applyTokens(themeId: string, palette: string, highContrast: boolean): void {
  const k = `${themeId}:${palette}:${highContrast}`;
  if (k === key) return;
  key = k;
  current = tokensFor(themeId, palette, highContrast);
  ui.setTokens(current);
  ui.setTheme({
    text: current.ink!, muted: current["ink-dim"]!, panel: current.panel!, control: current["panel-2"]!, hovered: current["panel-hover"]!,
    pressed: current.line!, field: current["panel-2"]!, accent: current.accent!, focus: current.focus!, outline: current.line!,
  });
}
/** A token's current colour (for draw calls, which take real colours). */
export function token(name: string): string { return current[name] ?? "#000000"; }
