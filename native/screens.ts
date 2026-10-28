// The browser build's DOM shell (index.html + js/ui.js) as starhermit:ui,
// built every frame over the board: the play screen (the HUD row of Puzzle,
// Time, Mistakes, Moves, Lit and Pause; the Objective / Par / Seed rail and
// the Mode / Actions rail on wide windows; the action tray with the Fill /
// Mark segment, Hint, Undo and Reset camera; the countdown; the lesson
// banner; the toasts), the board overlay the old page laid over the
// projected 3D cells (the run clues beside each row and above each column,
// done lines struck through and the cursor's lines highlighted, the crosses,
// the cell cursor and hover, and each cell as a named target: screen
// readers and play scripts find "Row 1, column 2, unknown"), the pause sheet,
// the "Preparing…" sheet while a board is generated, and every full-page
// screen (title with its light-board backdrop, modes, Journey, Practice with
// the custom seed, Challenges, Learn, Score Chase, How to play, Settings,
// results). The old media queries are layouts picked by the window's
// logical size: wide (≥ 1024 px: both rails), compact (the board between
// the HUD and the tray), portrait phones (≤ 720 px: compact HUD items) and
// short landscape (≤ 480 px tall: the HUD as a status column at the left and
// the tray as a column at the right, swapped when left-handed, the lesson
// banner docked top-left). The playfield they leave is the board's
// (main.ts field → render.ts setField).
import { frame, openMenu } from "starhermit:engine";
import { bindings, requestRebind } from "starhermit:input";
import * as draw from "starhermit:draw";
import * as ui from "starhermit:ui";
import { CELL, Content, Progress, Rules, formatMs, overlayLayout, type State } from "./game.ts";
import { N, S, T, num, puzzleName } from "./i18n.ts";
import * as platform from "./platform.ts";
import * as render from "./render.ts";
import {
  BUILD_VERSION, ack, app, back, cellLabel, copyInvite, currentLook, failText, field, fresh, hint, hudRects,
  inputMode, later, leaderboardLine, leaveToTitle, openScreen, openSettings, resetCamera, resetLessons, restartSession, resultsNext,
  resumeSnapshot, sessionLabel, setInputMode, signIn, startChallenge, startCustomPractice, startDaily, startJourney, startLesson,
  startPractice, todayKey, togglePause, undo,
} from "./main.ts";
import { token } from "./style.ts";

// ------------------------------------------------------------------ layout
interface Layout { lw: number; lh: number; sc: number; wide: boolean; phone: boolean; short: boolean }
function layoutNow(): Layout {
  const f = frame();
  const sc = ui.preferences().scale;
  const sa = f.safeArea;
  const lw = Math.max(1, (f.width - sa.left - sa.right) / sc), lh = Math.max(1, (f.height - sa.top - sa.bottom) / sc);
  return { lw, lh, sc, wide: lw >= 1024 && lh > 480, phone: lw <= 720, short: lh <= 480 && lw > lh };
}
const lastSize = new Map<string, ui.Rect>();
function textWidth(text: string, style: string, kind?: "button" | "heading"): number {
  return ui.measureText(text, { ...(kind ? { kind } : {}), style: [style] }).width / ui.preferences().scale;
}
/** Text up to `width` wide: one label when it fits, else a paragraph. */
function para(text: string, width: number, cls = "text", id?: string, size?: number): void {
  if (!text) return;
  let u = size ? ui.style(cls, { text: { size } }) : ui.style(cls);
  if (id) u = u.id(id);
  if (ui.measureText(text, { style: [cls], ...(size ? { size } : {}) }).width / ui.preferences().scale <= width) u.label(text);
  else u.paragraph(text, Math.max(20, width));
}
/** One line cut with an ellipsis at `width` (the HUD's puzzle name: text-overflow ellipsis). */
function clipText(text: string, width: number, cls: string): string {
  if (textWidth(text, cls) <= width) return text;
  let s = text;
  while (s.length > 1 && textWidth(`${s}…`, cls) > width) s = s.slice(0, -1);
  return `${s.trimEnd()}…`;
}
interface Btn { id: string; text: string; style?: string; act: () => void; disabled?: boolean; name?: string; selected?: boolean; content?: () => void; width?: number; height?: number }
const buttonWidth = (text: string, style: string): number => textWidth(text, style, "button") + 2;
function button(b: Btn): void {
  const style = b.style ?? "btn";
  const opts: ui.ButtonOptions = {};
  if (b.disabled) opts.disabled = true;
  if (b.selected !== undefined) opts.selected = b.selected;
  if (b.content) opts.content = b.content;
  else if (b.name && b.name !== b.text) opts.content = () => { ui.label(b.text); };
  const s: ui.Style = {};
  if (b.width != null) s.width = b.width;
  if (b.height != null) s.height = b.height;
  if (ui.style(style, s).id(b.id).button(b.name ?? b.text, opts) && fresh()) later(b.act);
}
/** Buttons at their own widths in rows that wrap at `width` (flex-wrap). */
function flow(label: string, list: Btn[], width: number, gap = 8, justify: "start" | "center" | "end" = "center"): void {
  const rows: Btn[][] = [[]];
  let used = 0;
  const bw = (b: Btn): number => Math.min(width, b.width ?? buttonWidth(b.text, b.style ?? "btn"));
  for (const b of list) {
    const w = bw(b);
    if (rows[rows.length - 1]!.length && used + gap + w > width) { rows.push([]); used = 0; }
    used += (rows[rows.length - 1]!.length ? gap : 0) + w;
    rows[rows.length - 1]!.push(b);
  }
  ui.column(label, () => {
    rows.forEach((row, ri) => ui.row(`${label}-r${ri}`, () => { for (const b of row) button(b); }, { spacing: gap, width, justify, align: "center" }));
  }, { spacing: gap, width });
}
function rect(r: ui.Rect): void { hudRects.push({ x: r.x, y: r.y, width: r.width, height: r.height }); }
/** A window rectangle (window px) drawn by a placed role-none widget (its draw paints it; it takes no pointer). */
function paint(id: string, x: number, y: number, w: number, h: number, drawFn: (r: ui.Rect) => void): void {
  if (w <= 0 || h <= 0) return;
  const sc = ui.preferences().scale, sa = frame().safeArea;
  ui.place(id, { anchor: "top-start", x: (x - sa.left) / sc, y: (y - sa.top) / sc }, () => {
    ui.widget("", { role: "none", size: { width: w / sc, height: h / sc }, draw: drawFn });
  });
}
/** The window rectangle of a logical one. */
function toWindow(x: number, y: number, w: number, h: number): ui.Rect {
  const sc = ui.preferences().scale, sa = frame().safeArea;
  return { x: sa.left + x * sc, y: sa.top + y * sc, width: w * sc, height: h * sc };
}
/** CSS repeat(auto-fit, minmax(min, 1fr)). */
function cardGrid(id: string, count: number, w: number, min: number, gap: number, cell: (i: number, cw: number) => void): void {
  const cols = Math.max(1, Math.min(count, Math.floor((w + gap) / (min + gap))));
  const cw = (w - (cols - 1) * gap) / cols;
  ui.column(id, () => {
    for (let r = 0; r * cols < count; r++) {
      ui.row(`${id}-r${r}`, () => { for (let i = r * cols; i < Math.min(count, (r + 1) * cols); i++) cell(i, cw); }, { spacing: gap, align: "stretch" });
    }
  }, { spacing: gap, width: w });
}
const upper = (s: string): string => s.toUpperCase();
function badge(id: string, text: string, ranked = false): void {
  ui.row(id, () => ui.style(ranked ? "badge-ranked-text" : "badge-text").label(upper(text)), { style: ranked ? "badge-ranked" : "badge" });
}
/** Strips the rich help paragraphs' markup (<strong>, <kbd>): the engine's text has no inline styles. */
const plain = (s: string): string => s.replace(/<[^>]+>/g, "");

// ------------------------------------------------------------------ the frame
export function drawScreens(): void {
  const L = layoutNow();
  const f = frame();
  if (app.screen) fullScreen(L);
  else if (app.session) {
    playScreen(L);
    if (app.paused) pauseSheet(L);
  }
  if (app.preparing) preparingSheet(L);
  toasts(L);
  if (app.focusNext) {
    const age = f.frame - app.openedFrame;
    if (age >= 1) ui.setFocus(app.focusNext);
    if (age >= 3) app.focusNext = null;
  }
}

// ------------------------------------------------------------------ the play screen (index.html #screen-play)
interface HudItem { id: string; k: string; v: string; cls: string; w: number }
function hudItems(s: State, compact: boolean, maxNameW: number): HudItem[] {
  const sess = app.session!;
  const k = s.constraints;
  const secs = Math.floor(s.elapsedMs / 1000);
  let time = `${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, "0")}`;
  let timeDanger = false;
  if (k.timeLimitMs !== null) {
    const remain = Math.max(0, k.timeLimitMs - s.elapsedMs);
    const rs = Math.ceil(remain / 1000);
    time = `−${Math.floor(rs / 60)}:${String(rs % 60).padStart(2, "0")}`;
    timeDanger = remain < 20000;
  }
  let lit = 0;
  for (let i = 0; i < s.grid.length; i++) if (s.grid[i] === CELL.FILLED && s.solution[i] === 1) lit++;
  const name = `${sessionLabel(sess)} — ${puzzleName(sess.puzzle.name)}`;
  const pad = compact ? 18 + 2 : 24 + 2;
  const item = (id: string, kk: string, v: string, cls: string, maxW = 9999): HudItem => {
    const vv = cls === "hud-v-strong" ? clipText(v, maxW, cls) : v;
    return { id, k: kk, v: vv, cls, w: Math.max(textWidth(kk, "hud-k"), textWidth(vv, cls)) + pad };
  };
  return [
    item("hud-objective", upper(T("Puzzle")), name, "hud-v-strong", maxNameW),
    item("hud-time", upper(T("Time")), time, timeDanger ? "hud-v-danger" : "hud-v"),
    item("hud-mistakes", upper(T("Mistakes")), k.maxMistakes !== null ? `${s.mistakes}/${k.maxMistakes}` : String(s.mistakes),
      k.maxMistakes !== null && s.mistakes >= k.maxMistakes - 1 ? "hud-v-danger" : "hud-v"),
    item("hud-moves", upper(T("Moves")), k.moveLimit !== null ? `${s.moves}/${k.moveLimit}` : String(s.moves), "hud-v"),
    item("hud-progress", upper(T("Lit")), `${Math.round((100 * lit) / s.filledCount)}%`, "hud-v"),
  ];
}
function hudItem(it: HudItem, compact: boolean, width?: number): void {
  ui.column(it.id, () => {
    ui.style("hud-k").label(it.k);
    ui.style(it.cls).id(`${it.id}-v`).label(it.v);
  }, { style: compact ? "hud-item-compact" : "hud-item", spacing: 0, ...(width ? { width } : {}) });
}
interface TrayBtn { id: string; text: string; name: string; act: () => void; disabled: boolean }
function canUndo(): boolean { const s = app.session; return !!s && s.state.constraints.allowUndo && s.undoStack.length > 0 && s.state.status === "active"; }
function canHint(): boolean { const s = app.session; return !!s && s.state.constraints.allowHints && s.state.status === "active"; }
function playScreen(L: Layout): void {
  const sess = app.session!;
  const s = sess.state;
  const sc = L.sc;
  const live = app.phase === "active" && !app.paused;
  const lefty = platform.options.leftHanded;
  const pauseBtn: Btn = { id: "btn-pause", text: T("❚❚ Pause"), name: T("Pause game"), act: () => togglePause(true), disabled: !live, style: "btn" };

  // ---- the stage: the HUD, the rails and the tray around the playfield
  let fx = 0, fy = 0, fw = L.lw, fh = L.lh;
  const hudPrev = lastSize.get("hud");
  const trayPrev = lastSize.get("tray");
  if (L.short) {
    // The HUD as a 132 px status column, the tray as a column (left-handed: swapped).
    const hudW = 132;
    const trayW = (trayPrev?.width ?? 104 * sc) / sc;
    fx = lefty ? trayW : hudW;
    fw = L.lw - hudW - trayW;
  } else {
    const hudH = (hudPrev?.height ?? 64 * sc) / sc;
    const trayH = (trayPrev?.height ?? 64 * sc) / sc;
    fy = hudH;
    fh = L.lh - hudH - trayH;
    if (L.wide) { fx = 230; fw = L.lw - 460; }
  }
  fw = Math.max(40, fw); fh = Math.max(40, fh);
  const fWin = toWindow(fx, fy, fw, fh);
  Object.assign(field, fWin);

  // ---- the page around the playfield (#screen-play's background; the scene shows only in the playfield)
  const f = frame();
  const bg = token("bg");
  paint("bg-top", 0, 0, f.width, fWin.y, (r) => draw.rect(r.x, r.y, r.width, r.height, bg));
  paint("bg-bottom", 0, fWin.y + fWin.height, f.width, f.height - fWin.y - fWin.height, (r) => draw.rect(r.x, r.y, r.width, r.height, bg));
  paint("bg-left", 0, fWin.y, fWin.x, fWin.height, (r) => draw.rect(r.x, r.y, r.width, r.height, bg));
  paint("bg-right", fWin.x + fWin.width, fWin.y, f.width - fWin.x - fWin.width, fWin.height, (r) => draw.rect(r.x, r.y, r.width, r.height, bg));

  // ---- the board overlay (clues, crosses, cursor, named cells) over the playfield
  boardOverlay(L, s);

  // ---- the HUD (#hud: a wrapping row; a status column on short landscape)
  if (L.short) {
    const w = 132;
    const items = hudItems(s, true, w - 30);
    const hud = ui.place("hud", { anchor: lefty ? "top-end" : "top-start", x: 0, y: 0 }, () => {
      ui.column("hud-col", () => {
        for (const it of items) hudItem(it, true, w - 12);
        ui.spacer();
        button({ ...pauseBtn, width: w - 12 });
      }, { width: w, height: L.lh, spacing: 6, padding: 6 });
    });
    lastSize.set("hud", hud);
    rect(hud);
  } else {
    const avail = L.lw - 24;
    const items = hudItems(s, L.phone, L.phone ? 0.46 * L.lw : 0.34 * L.lw);
    const gap = L.phone ? 6 : 10;
    const rows: (HudItem | "pause")[][] = [[]];
    let used = 0;
    const pw = buttonWidth(pauseBtn.text, "btn");
    for (const it of [...items, "pause" as const]) {
      const w = it === "pause" ? pw + gap : it.w;
      if (rows[rows.length - 1]!.length && used + gap + w > avail) { rows.push([]); used = 0; }
      used += (rows[rows.length - 1]!.length ? gap : 0) + w;
      rows[rows.length - 1]!.push(it);
    }
    const hud = ui.place("hud", { anchor: "top-start", x: 0, y: 0 }, () => {
      ui.column("hud-col", () => {
        rows.forEach((row, ri) => ui.row(`hud-r${ri}`, () => {
          for (const it of row) {
            if (it === "pause") { if (row.length > 1) ui.spacer(0.0001); button(pauseBtn); }
            else hudItem(it, L.phone);
          }
        }, { spacing: gap, align: "center", width: avail }));
      }, { spacing: gap, padding: { top: 8, bottom: 8, start: 12, end: 12 } });
    });
    lastSize.set("hud", hud);
    rect(hud);
  }

  // ---- the rails (wide)
  if (L.wide) {
    const top = fy;
    const left = ui.place("rail-left", { anchor: "top-start", x: 0, y: top }, () => ui.column("rail-left-col", () => leftRail(206), { width: 230, spacing: 10, padding: { top: 14, bottom: 14, start: 12, end: 12 } }));
    const right = ui.place("rail-right", { anchor: "top-end", x: 0, y: top }, () => ui.column("rail-right-col", () => rightRail(206, live), { width: 230, spacing: 10, padding: { top: 14, bottom: 14, start: 12, end: 12 } }));
    rect(left); rect(right);
  }

  // ---- the tray (#tray)
  const mode = inputMode();
  const items: TrayBtn[] = [
    { id: "btn-hint", text: T("💡 Hint"), name: T("Hint"), act: hint, disabled: !live || !canHint() },
    { id: "btn-undo", text: T("↩ Undo"), name: T("Undo"), act: undo, disabled: !live || !canUndo() },
    { id: "btn-camera", text: "◎", name: T("Reset camera"), act: resetCamera, disabled: !app.session },
  ];
  const seg = (vertical: boolean, w?: number): void => {
    const build = (): void => {
      button({ id: "mode-fill", text: T("▮ Fill"), name: T("Fill"), style: "seg-btn", selected: mode === "fill", act: () => setInputMode("fill"), ...(w ? { width: w } : {}) });
      button({ id: "mode-mark", text: T("✕ Mark"), name: T("Mark"), style: "seg-btn", selected: mode === "mark", act: () => setInputMode("mark"), ...(w ? { width: w } : {}) });
    };
    if (vertical) ui.column("tray-seg", build, { style: "seg", spacing: 0, role: "radiogroup", clip: true });
    else ui.row("tray-seg", build, { style: "seg", spacing: 0, role: "radiogroup", clip: true });
  };
  if (L.short) {
    const bw = 92;
    const tray = ui.place("tray", { anchor: lefty ? "top-start" : "top-end", x: 0, y: 0 }, () => {
      ui.column("tray-col", () => {
        ui.spacer();
        seg(true, bw);
        for (const b of items) button({ ...b, width: bw });
        ui.spacer();
      }, { height: L.lh, spacing: 6, padding: 6, align: "center" });
    });
    lastSize.set("tray", tray);
    rect(tray);
  } else {
    // Left-handed: the row reversed (body.left-handed #tray { flex-direction: row-reverse }).
    const list = (): void => {
      const parts: (() => void)[] = [() => seg(false), () => { ui.widget("", { role: "none", size: { width: 8, height: 1 } }); }, ...items.map((b) => () => button(b))];
      for (const part of lefty ? parts.reverse() : parts) part();
    };
    // #tray wraps (flex-wrap) when its one row would not fit the window.
    const segW = Math.max(64, buttonWidth(T("▮ Fill"), "seg-btn")) + Math.max(64, buttonWidth(T("✕ Mark"), "seg-btn")) + 2;
    const rowW = segW + 8 + 8 + items.reduce((n, b) => n + Math.max(44, buttonWidth(b.text, "btn")) + 8, 0) + 24;
    const fits = rowW <= L.lw;
    const tray = ui.place("tray", { anchor: "bottom", x: 0, y: 0 }, () => {
      if (fits) ui.row("tray-row", list, { spacing: 8, align: "center", padding: { top: 10, bottom: 10, start: 12, end: 12 } });
      else ui.column("tray-wrap", () => {
        ui.row("tray-r0", () => { seg(false); button(items[0]!); }, { spacing: 8, align: "center" });
        ui.row("tray-r1", () => { button(items[1]!); button(items[2]!); }, { spacing: 8, align: "center" });
      }, { spacing: 8, align: "center", padding: { top: 10, bottom: 10, start: 12, end: 12 } });
    });
    lastSize.set("tray", tray);
    rect(tray);
  }

  // ---- the lesson banner (#lesson-banner), carved out of the board's safe area
  const ins = { left: 0, right: 0, top: 0, bottom: 0, clueLeftPx: clueLeftPx(L, s) };
  if (app.lesson) {
    const side = L.short;
    const prev = lastSize.get("lesson");
    let bx: number, by: number, bw: number;
    if (side) { bw = Math.min(0.3 * L.lw, 220); bx = fx + 8; by = fy + 8; }
    else {
      bw = L.phone ? L.lw - 16 : Math.min(0.92 * L.lw, 560);
      bx = fx + fw / 2 - bw / 2;
      // #lesson-banner: low in the playfield, above the tray's thumb zone.
      by = fy + fh - (prev ? prev.height / sc : 90) - 12;
    }
    const banner = ui.place("lesson", { anchor: "top-start", x: bx, y: by }, () => {
      ui.column("lesson-banner", () => {
        para(upper(app.lesson!.step), bw - 36, "step-k", "lesson-step");
        para(app.lesson!.text, bw - (side ? 22 : 38), side ? "small" : "lesson-text", "lesson-text");
      }, { style: side ? "lesson-banner-compact" : "lesson-banner", width: bw, spacing: 4 });
    });
    lastSize.set("lesson", banner);
    rect(banner);
    const e = { l: (banner.x - fWin.x) / fWin.width, t: (banner.y - fWin.y) / fWin.height, r: (banner.x + banner.width - fWin.x) / fWin.width, b: (banner.y + banner.height - fWin.y) / fWin.height };
    if (side) ins.left = Math.max(0, Math.min(0.5, e.r));
    else if (e.t >= 0.5) ins.bottom = Math.max(0, Math.min(0.5, 1 - e.t));
    else ins.top = Math.max(0, Math.min(0.5, e.b));
  }
  render.setField(fWin, sc, ins);

  // ---- the countdown (#countdown)
  if (app.countdown && app.countdown.step >= 0 && app.countdown.step < app.countdown.steps.length) {
    const st = app.countdown.steps[app.countdown.step]!;
    const text = st === "Glow" ? T("Glow") : st;
    const size = Math.max(64, Math.min(144, 0.18 * Math.min(L.lw, L.lh)));
    ui.place("countdown", { anchor: "top-start", x: fx, y: fy + fh / 2 - size * 0.7 }, () => {
      ui.column("countdown-col", () => { ui.style("countdown", { text: { size } }).id("countdown").label(text); }, { width: fw, align: "center" });
    });
  }
}
function leftRail(w: number): void {
  const sess = app.session!;
  const card = (id: string, title: string, body: () => void): void => {
    ui.column(id, () => { para(title, w - 34, "card-h3"); body(); }, { style: "rail-card", width: w, spacing: 8 });
  };
  card("rail-objective", T("Objective"), () => para(objectiveText(sess.state), w - 34, "dim-small", "rail-objective-text"));
  card("rail-par", T("Par"), () => para(T("Par {time}", { time: formatMs(sess.state.parMs) }), w - 34, "small", "rail-par-text"));
  card("rail-seed", T("Seed"), () => para(`${sess.puzzle.seed.toString(16)} · ${sess.puzzle.rows}×${sess.puzzle.cols} · ${puzzleName(sess.puzzle.name)}`, w - 34, "dim-small", "rail-seed-text"));
}
function rightRail(w: number, live: boolean): void {
  const mode = inputMode();
  ui.column("rail-mode", () => {
    para(T("Mode"), w - 34, "card-h3");
    ui.row("rail-seg", () => {
      button({ id: "rail-mode-fill", text: T("Fill"), style: "seg-btn", selected: mode === "fill", act: () => setInputMode("fill") });
      button({ id: "rail-mode-mark", text: T("Mark ✕"), style: "seg-btn", selected: mode === "mark", act: () => setInputMode("mark") });
    }, { spacing: 4, role: "radiogroup" });
  }, { style: "rail-card", width: w, spacing: 8 });
  ui.column("rail-actions", () => {
    para(T("Actions"), w - 34, "card-h3");
    button({ id: "rail-hint", text: T("💡 Hint"), name: T("Hint"), act: hint, disabled: !live || !canHint(), width: w - 34 });
    button({ id: "rail-undo", text: T("↩ Undo"), name: T("Undo"), act: undo, disabled: !live || !canUndo(), width: w - 34 });
    button({ id: "rail-camera", text: T("◎ Reset camera"), name: T("Reset camera"), act: resetCamera, width: w - 34 });
  }, { style: "rail-card", width: w, spacing: 6 });
}
/** main.js objectiveText. */
function objectiveText(s: State): string {
  const k = s.constraints;
  const parts = [T("Reveal the hidden picture.")];
  if (k.timeLimitMs !== null) parts.push(T("Finish within {time}.", { time: formatMs(k.timeLimitMs) }));
  if (k.maxMistakes !== null) parts.push(T("At most {n} mistakes.", { n: k.maxMistakes }));
  if (k.moveLimit !== null) parts.push(T("At most {n} moves.", { n: k.moveLimit }));
  if (k.allowMarks === false) parts.push(T("Marks are disabled."));
  if (k.allowHints === false) parts.push(T("Hints are disabled."));
  return parts.join(" ");
}

// ------------------------------------------------------------------ the board overlay (ui.js layoutBoard + the cell buttons' CSS)
let clueFont = 12; // window px, the last frame's
/** main.js syncSafeInsets: the row clues' width (window px) so the camera fit keeps them on screen. */
function clueLeftPx(L: Layout, s: State): number {
  const nr = Math.max(1, ...s.rowClues.map((x) => x.length));
  return nr * 1.15 * clueFont + (nr - 1) * 4 * L.sc + 6 * L.sc + 4 * L.sc;
}
const lineDone = (s: State, isRow: boolean, i: number): boolean => {
  const n = isRow ? s.cols : s.rows;
  for (let k = 0; k < n; k++) {
    const idx = isRow ? i * s.cols + k : k * s.cols + i;
    if (s.solution[idx] === 1 && s.grid[idx] !== CELL.FILLED) return false;
  }
  return true;
};
function boardOverlay(L: Layout, s: State): void {
  const proj = render.projectCells();
  if (!proj || proj.rows !== s.rows || proj.cols !== s.cols) return;
  const lay = overlayLayout(proj.rows, proj.cols, proj.centers);
  const sc = L.sc;
  // style.css .clue: clamp(10px, 2.4vmin, 17px × the UI scale); the crosses clamp(9px, 2vmin, 15px × the UI scale).
  const vmin = Math.min(L.lw, L.lh) * sc;
  clueFont = Math.min(17 * sc, Math.max(10 * sc, 0.024 * vmin));
  const font = clueFont;
  const cur = app.cursor, hv = app.hover;
  const markFont = Math.max(9 * sc, Math.min(15 * sc, 0.02 * vmin));
  const hc = ui.preferences().highContrast;
  const ink = token("ink"), accent = token("accent"), focus = token("focus"), marked = token("marked"), filled = token("filled");
  const shadow = hc ? undefined : { color: "#000000cc", x: 0, y: Math.max(1, sc) };
  const active = !app.paused && app.phase !== "results";
  paint("board-overlay", field.x, field.y, field.width, field.height, () => {
    // Cells: hover wash, filled outline, the cross, the cursor.
    for (let r = 0; r < s.rows; r++) {
      for (let c = 0; c < s.cols; c++) {
        const q = lay.cells[r * s.cols + c]!;
        const v = s.grid[r * s.cols + c];
        if (hv && hv.r === r && hv.c === c && active) draw.roundRect(q.left, q.top, q.width, q.height, 4, "#ffffff14");
        if (v === CELL.FILLED) draw.strokeRoundRect(q.left, q.top, q.width, q.height, 4, filled + (hc ? "" : "99"), hc ? 2 : 1);
        else if (v === CELL.MARKED) {
          draw.text("✕", q.left + q.width / 2, q.top + q.height / 2 - markFont * 0.62, { size: markFont, color: marked, align: "center", weight: "800", ...(shadow ? { shadow } : {}) });
        }
        if (cur.r === r && cur.c === c && active) draw.strokeRoundRect(q.left, q.top, q.width, q.height, 4, focus, 2);
      }
    }
    // Run clues: right-aligned beside each row, stacked above each column (0 for an empty line).
    const clue = (n: number, cx: number, top: number, color: string, done: boolean): void => {
      draw.text(String(n), cx, top, { size: font, color, weight: "bold", align: "center", ...(shadow ? { shadow } : {}) });
      if (done) {
        const w = draw.measureText(String(n), { size: font, weight: "bold" }).width;
        draw.line(cx - w / 2 - 1, top + font * 0.62, cx + w / 2 + 1, top + font * 0.62, color, Math.max(1, font / 14));
      }
    };
    const cw = 1.15 * font, gap = 4 * sc;
    for (let r = 0; r < s.rows; r++) {
      const q = lay.rowClues[r]!;
      const clues = s.rowClues[r]!.length ? s.rowClues[r]! : [0];
      const done = lineDone(s, true, r);
      const color = done ? accent + "8c" : r === cur.r && active ? focus : ink;
      let x = q.left + q.width - 6 * sc - cw / 2;
      const top = q.top + q.height / 2 - font * 0.6;
      for (let k = clues.length - 1; k >= 0; k--) { clue(clues[k]!, x, top, color, done); x -= cw + gap; }
    }
    for (let c = 0; c < s.cols; c++) {
      const q = lay.colClues[c]!;
      const clues = s.colClues[c]!.length ? s.colClues[c]! : [0];
      const done = lineDone(s, false, c);
      const color = done ? accent + "8c" : c === cur.c && active ? focus : ink;
      const lineH = font * 1.2 + gap;
      let top = q.top + q.height - 4 * sc - font * 1.2;
      for (let k = clues.length - 1; k >= 0; k--) { clue(clues[k]!, q.left + q.width / 2, top, color, done); top -= lineH; }
    }
  });
  // Each cell as a named target (the old cell buttons' accessible names).
  if (!app.paused && app.phase !== "results") {
    for (let r = 0; r < s.rows; r++) {
      for (let c = 0; c < s.cols; c++) {
        const q = lay.cells[r * s.cols + c]!;
        ui.target(cellLabel(s, r, c), { x: q.left, y: q.top, width: q.width, height: q.height }, { role: "button" });
      }
    }
  }
}

// ------------------------------------------------------------------ toasts (#toasts)
function toasts(L: Layout): void {
  if (!app.toasts.length) return;
  // Drawn by role-none widgets in an unstyled column: toasts never take the pointer (#toasts { pointer-events: none }).
  const sc = L.sc;
  const maxW = Math.min(L.lw - 24, 520);
  const inPlay = !app.screen && !!app.session;
  const at = inPlay ? { anchor: "bottom" as const, x: 0, y: L.short ? 12 : 90 } : { anchor: "top" as const, x: 0, y: 12 };
  ui.place("toast-stack", at, () => {
    ui.column("toast-col", () => {
      app.toasts.forEach((t) => {
        const m = draw.measureText(t.text, { size: 16 * sc, maxWidth: (maxW - 36) * sc });
        const w = m.width / sc + 36, h = m.height / sc + 16;
        ui.widget("", {
          role: "none", size: { width: w, height: h },
          draw: (r) => {
            draw.box(r.x, r.y, r.width, r.height, "toast");
            draw.text(t.text, r.x + r.width / 2, r.y + 8 * sc, { size: 16 * sc, color: token("ink"), align: "center", maxWidth: (maxW - 36) * sc });
          },
        });
      });
    }, { spacing: 8, align: "center" });
  });
}

// ------------------------------------------------------------------ the pause sheet (#overlay-pause) and the preparing sheet
function sheetWidth(L: Layout, max = 560): number { return Math.min(max, L.lw - 32); }
function pauseSheet(L: Layout): void {
  const w = sheetWidth(L);
  const inner = w - 46;
  const compact = L.lh < 560;
  const open = ui.dialog(T("Paused"), "", true, () => {
    ui.column("pause-sheet", () => {
      para(T("Paused"), inner, "h2", "pause-h");
      para(T("The board waits for you."), inner, "dim-small", "pause-sub");
      const list: Btn[] = [
        { id: "pause-resume", text: T("Resume"), style: "btn-sheet-primary", act: () => togglePause(false) },
        { id: "pause-restart", text: T("Restart puzzle"), style: "btn-sheet", act: () => { togglePause(false); restartSession(); } },
        { id: "pause-settings", text: T("Settings"), style: "btn-sheet", act: () => openSettings(true) },
        { id: "pause-help", text: T("How to play"), style: "btn-sheet", act: () => { togglePause(false); leaveToTitle(); openScreen("help"); } },
        { id: "pause-leave", text: T("Leave puzzle"), style: "btn-sheet-ghost", act: () => { togglePause(false); leaveToTitle(); } },
      ];
      if (compact) {
        button({ ...list[0]!, width: inner });
        flow("pause-links", list.slice(1).map((b) => ({ ...b, style: b.style === "btn-sheet-ghost" ? "btn-ghost" : "btn" })), inner, 6);
      } else ui.column("pause-actions", () => { for (const b of list) button({ ...b, width: inner }); }, { spacing: 8, padding: { top: 6 } });
    }, { style: "sheet", width: w, spacing: compact ? 6 : 8, ...(compact ? { padding: 14 } : {}) });
  });
  // Escape / Back closes the sheet: resume (not on the frame it opened).
  if (!open && fresh()) later(() => togglePause(false));
}
function preparingSheet(L: Layout): void {
  const w = sheetWidth(L, 420);
  const open = ui.dialog(T("Preparing the board…"), "", true, () => {
    ui.column("preparing-sheet", () => {
      para(T("Preparing the board…"), w - 46, "preparing", "preparing-text");
      para(T(app.preparing ? sessionLabelFor(app.preparing.label) : ""), w - 46, "dim-small", "preparing-sub");
      button({ id: "preparing-cancel", text: T("Cancel"), style: "btn-sheet-ghost", width: w - 46, act: () => { app.preparing?.cancel(); app.preparing = null; } });
    }, { style: "sheet", width: w, spacing: 10, align: "center" });
  });
  if (!open && app.preparing) later(() => { app.preparing?.cancel(); app.preparing = null; });
}
/** The generator's round label ("Daily Glow 2026-10-28", "Practice · Steady", a challenge name) in the player's language. */
function sessionLabelFor(label: string): string {
  let m: RegExpExecArray | null;
  if ((m = /^Daily Glow (.+)$/.exec(label))) return T("Daily Glow {date}", { date: m[1]! });
  if ((m = /^Journey (\d+)$/.exec(label))) return T("Journey {n}", { n: m[1]! });
  if ((m = /^Practice · (.+)$/.exec(label))) return T("Practice · {name}", { name: T(m[1]!) });
  return T(label);
}

// ------------------------------------------------------------------ full-page screens (index.html .screen)
function fullScreen(L: Layout): void {
  const f = frame();
  const look = currentLook();
  const hc = ui.preferences().highContrast;
  paint("page", 0, 0, f.width, f.height, (r) => {
    draw.rect(r.x, r.y, r.width, r.height, token("bg"));
    if (app.screen === "title" && look.detailed && !hc) titleBackdrop(r, L, look.ambient && !ui.preferences().reducedMotion);
  });
  const name = app.screen!;
  const bar = name !== "title" && name !== "results";
  const barH = bar ? (lastSize.get("topbar")?.height ?? 64 * L.sc) / L.sc : 0;
  const bodyH = L.lh - barH;
  const cw = Math.min(L.lw - 40, contentWidth(name));
  const key = `screen-${name}`;
  const prev = lastSize.get(key);
  const scroll = !!prev && prev.height / L.sc > bodyH + 1;
  const opening = f.frame - app.openedFrame <= 6;
  ui.place("screen", { anchor: "top-start", x: 0, y: barH }, () => {
    ui.column("screen-col", () => {
      const body = (): void => {
        const r = ui.column(`${key}-body`, () => {
          ui.column(`${key}-inner`, () => buildScreen(name, cw - (scroll ? 14 : 0), L), { width: cw - (scroll ? 14 : 0), spacing: 12, align: name === "title" || name === "results" ? "center" : "start" });
        }, { width: L.lw - (scroll ? 14 : 0), align: "center", padding: { top: 20, bottom: 24 } });
        lastSize.set(key, r);
      };
      if (scroll) ui.scrollArea(`${key}-scroll`, { width: L.lw, height: bodyH }, body, opening ? { scrollTo: { top: 0 } } : undefined);
      else if (name === "title") ui.column("title-centre", () => { ui.spacer(); body(); ui.spacer(); }, { width: L.lw, height: bodyH });
      else body();
    }, { width: L.lw, height: bodyH, spacing: 0 });
  });
  if (bar) topbar(name, L);
}
function contentWidth(name: string): number {
  switch (name) {
    case "title": return 720;
    case "results": return 620;
    case "modes": case "practice": case "challenge": case "learn": return 640;
    default: return 1060;
  }
}
const TITLES: Record<string, string> = {
  modes: N("Choose a mode"), journey: N("Journey"), practice: N("Practice"), challenge: N("Challenges"), learn: N("Learn"),
  scores: N("Score Chase"), help: N("How to play"), settings: N("Settings"),
};
function topbar(name: string, L: Layout): void {
  const backTo = name === "journey" || name === "practice" || name === "challenge" || name === "learn" ? T("← Modes") : T("← Back");
  const r = ui.place("topbar", { anchor: "top-start", x: 0, y: 0 }, () => {
    ui.row("topbar-row", () => {
      button({ id: "btn-back", text: backTo, style: "btn-ghost", act: () => { ack(); back(); } });
      para(T(TITLES[name] ?? ""), Math.max(80, L.lw - 260), "topbar-h1", `${name}-h`);
      ui.spacer();
      if (name === "journey") {
        const done = Content.JOURNEY_STAGES.filter((s) => platform.save().progress.journey[s.id]?.completed).length;
        badge("journey-progress-badge", T("{done} / {total} done", { done, total: Content.JOURNEY_STAGES.length }));
      } else if (name === "practice") badge("practice-badge", T("unranked"));
      else if (name === "challenge") badge("challenge-week", T("ranked · {week}", { week: Content.utcWeekKey(new Date(platform.nowMs())) }), true);
    }, { style: "topbar", width: L.lw, spacing: 12, align: "center" });
  });
  lastSize.set("topbar", r);
}
function buildScreen(name: string, w: number, L: Layout): void {
  switch (name) {
    case "title": titleScreen(w, L); break;
    case "modes": modesScreen(w); break;
    case "journey": journeyScreen(w); break;
    case "practice": practiceScreen(w); break;
    case "challenge": challengeScreen(w); break;
    case "learn": learnScreen(w); break;
    case "scores": scoresScreen(w); break;
    case "help": helpScreen(w); break;
    case "settings": settingsScreen(w); break;
    case "results": resultsScreen(w); break;
  }
}

// ------------------------------------------------------------------ title (#screen-title)
/** The title's light-board backdrop (Board detail Detailed): soft glows over a faint cell grid, drifting with Ambient motion. */
function titleBackdrop(r: ui.Rect, L: Layout, drift: boolean): void {
  const sc = L.sc;
  const t = frame().time;
  const k = drift ? 0.5 - 0.5 * Math.cos((t / 36) * Math.PI) : 0;
  const dx = -36 * sc * k, dy = -18 * sc * k;
  const bg = token("bg");
  const mixA = (c: string, a: number): string => c.slice(0, 7) + Math.round(a * 255).toString(16).padStart(2, "0");
  const line = mixA(token("line"), 0.26);
  const step = 36 * sc;
  for (let x = r.x + ((dx % step) + step) % step - step; x < r.x + r.width; x += step) draw.rect(x + 34 * sc, r.y, 2 * sc, r.height, line);
  for (let y = r.y + ((dy % step) + step) % step - step; y < r.y + r.height; y += step) draw.rect(r.x, y + 34 * sc, r.width, 2 * sc, line);
  draw.box(r.x + dx, r.y + dy, r.width, r.height, {
    background: [
      { type: "radial", center: { x: 0.5, y: 0.38 }, radius: { x: 0.6, y: 0.45 }, stops: [mixA(token("filled"), 0.16), { color: "#00000000", at: 0.7 }] },
      { type: "radial", center: { x: 0.18, y: 0.85 }, radius: { x: 0.4, y: 0.35 }, stops: [mixA(token("accent"), 0.12), { color: "#00000000", at: 0.7 }] },
      { type: "radial", center: { x: 0.85, y: 0.12 }, radius: { x: 0.35, y: 0.3 }, stops: ["#9db8ff1a", { color: "#00000000", at: 0.7 }] },
    ],
    radius: 0,
  });
  // The mask: the grid fades out toward the edges.
  draw.box(r.x, r.y, r.width, r.height, {
    background: { type: "radial", center: { x: 0.5, y: 0.45 }, radius: { x: 0.75, y: 0.7 }, stops: [{ color: mixA(bg, 0), at: 0.3 }, { color: bg, at: 0.85 }] },
    radius: 0,
  });
}
function titleScreen(w: number, L: Layout): void {
  const save = platform.save();
  const p = save.progress;
  para(T("v{build} · content v{content}", { build: BUILD_VERSION, content: Content.CONTENT_VERSION }), w, "dim-small", "title-version");
  const size = Math.max(35.2, Math.min(64, 0.07 * L.lw));
  ui.row("title-logo", () => {
    ui.style("logo-a", { text: { size } }).id("title-h").label("Picture");
    ui.style("logo-b", { text: { size } }).label(" Logic");
  }, { spacing: 0, align: "center" });
  para(T("Read the clues. Light the cells. Watch the board bloom."), w, "tagline", "tagline");
  ui.row("title-play", () => {
    button({ id: "btn-play", text: T("Play"), style: "btn-play", act: () => { ack(); openScreen("modes"); } });
    if (p.lastSnapshot) {
      const label = T("Resume {label} ({time})", { label: sessionLabel(p.lastSnapshot), time: formatMs(p.lastSnapshot.stateElapsed) });
      button({ id: "btn-resume", text: label, style: "btn-ghost", act: resumeSnapshot });
    }
  }, { spacing: 10, align: "center" });
  // The home cards (.home-cards: auto-fit, 190 px).
  const done = Object.values(p.journey).filter((j) => j.completed).length;
  const today = p.dailies[todayKey()];
  const cards: [string, string, string, string, () => void][] = [
    ["card-daily", T("Daily Glow"), today ? T("Today: scored {score}", { score: num(today.score) }) : T("One shared puzzle per UTC day"), T("Today’s puzzle →"), startDaily],
    ["card-journey", T("Journey"), done ? T("{done} of {total} stages lit", { done, total: Content.JOURNEY_STAGES.length }) : T("40 stages of growing light"), T("Continue →"), () => openScreen("journey")],
    ["card-learn", T("Learn"), T("Five short interactive lessons"), T("Start lesson 1 →"), () => openScreen("learn")],
    ["card-scores", T("Score Chase"), T("Boards, streaks and achievements"), T("Compare →"), () => openScreen("scores")],
  ];
  ui.column("home-cards-pad", () => {
    cardGrid("home-cards", cards.length, w, 190, 12, (i, cw) => {
      const [id, title, sub, cta, act] = cards[i]!;
      cardButton(id, title, title, sub, cta, cw, () => { ack(); act(); });
    });
  }, { padding: { top: 16 } });
  const links: Btn[] = [
    { id: "btn-settings", text: T("Settings"), style: "btn-ghost", act: () => openSettings(false) },
    { id: "btn-help", text: T("How to play"), style: "btn-ghost", act: () => openScreen("help") },
  ];
  if (platform.inviteLink()) links.push({ id: "btn-invite", text: S("invite"), style: "btn-ghost", act: copyInvite });
  if (!platform.signedIn()) links.push({ id: "btn-signin", text: S("signIn"), style: "btn-ghost", act: signIn });
  ui.column("title-links", () => flow("title-links-flow", links, w, 8), { padding: { top: 14 } });
  const name = platform.displayName() || save.name;
  const st = platform.syncState();
  const cloud = st === "saving" ? N("saving…") : st === "synced" ? N("cloud synced") : st === "error" ? N("sync failed — kept on this device") : "";
  const line = `${name || T("Guest profile")} · ${T("progress saved on this device")}${platform.signedIn() ? ` · ${T("connected")}${cloud ? ` · ${T(cloud)}` : ""}` : ` · ${T("offline")}`}`;
  para(line, w, "dim-small", "profile-line");
}
/** A card button: a title, a dim line and a call to action (button.card). */
function cardButton(id: string, name: string, title: string, sub: string, cta: string, cw: number, act: () => void): void {
  const inner = cw - 34;
  button({
    id, text: name, name, style: "card-btn", width: cw, act,
    content: () => ui.column(`${id}-face`, () => {
      para(title, inner, "card-h3");
      para(sub, inner, "dim-small");
      if (cta) para(cta, inner, "cta");
    }, { spacing: 6, width: inner }),
  });
}
/** A list row button (.row-btn): a bold title, a dim line, an optional badge. */
function rowButton(id: string, title: string, sub: string, w: number, act: () => void, badgeText?: string, ranked = false): void {
  const bw = badgeText ? textWidth(upper(badgeText), ranked ? "badge-ranked-text" : "badge-text") + 22 : 0;
  const inner = w - 34 - (bw ? bw + 12 : 0);
  button({
    id, text: title, name: title, style: "card-btn", width: w, act: () => { ack(); act(); },
    content: () => ui.row(`${id}-face`, () => {
      ui.column(`${id}-text`, () => { para(title, inner, "text-bold"); para(sub, inner, "dim-small"); }, { width: inner, spacing: 2 });
      if (badgeText) badge(`${id}-badge`, badgeText, ranked);
    }, { spacing: 12, align: "center" }),
  });
}

// ------------------------------------------------------------------ modes and their lists
const MODE_INFO = [
  { id: "learn", name: N("Learn"), desc: N("Five interactive lessons — one rule at a time."), ranked: false },
  { id: "journey", name: N("Journey"), desc: N("Forty authored stages with mastery gates."), ranked: false },
  { id: "daily", name: N("Daily Glow"), desc: N("One shared seed per UTC day. No undo."), ranked: true },
  { id: "practice", name: N("Practice"), desc: N("Pick a size, use undo and hints freely."), ranked: false },
  { id: "challenge", name: N("Challenge"), desc: N("Weekly constrained goals: clocks, move budgets, no marks."), ranked: true },
  { id: "scores", name: N("Score Chase"), desc: N("Leaderboards, streaks and achievements."), ranked: false },
];
function modesScreen(w: number): void {
  const lw = Math.min(w, 640);
  ui.column("mode-list", () => {
    for (const m of MODE_INFO) {
      rowButton(`mode-${m.id}`, T(m.name), T(m.desc), lw, () => {
        if (m.id === "daily") startDaily();
        else openScreen(m.id as "learn" | "journey" | "practice" | "challenge" | "scores");
      }, m.ranked ? T("ranked") : undefined, true);
    }
  }, { spacing: 10, width: lw });
}
function journeyScreen(w: number): void {
  const p = platform.save().progress;
  para(T("Forty authored light-boards. Mastery stages (gold) allow no hints. Earn up to three stars per stage: finish, finish clean, beat par."), w, "dim", "journey-intro");
  const gap = 10, min = 86;
  const cols = Math.max(1, Math.floor((w + gap) / (min + gap)));
  const size = (w - (cols - 1) * gap) / cols;
  const stages = Content.JOURNEY_STAGES;
  ui.column("stage-grid", () => {
    for (let r = 0; r * cols < stages.length; r++) {
      ui.row(`stage-row-${r}`, () => {
        for (let i = r * cols; i < Math.min(stages.length, (r + 1) * cols); i++) {
          const s = stages[i]!;
          const rec = p.journey[s.id];
          const unlocked = Progress.journeyUnlocked(p, i, stages);
          const stars = rec ? "★".repeat(rec.stars) + "☆".repeat(3 - rec.stars) : "☆☆☆";
          const label = T(s.mastery ? (unlocked ? N("Stage {n} (mastery), {rows} by {cols}") : N("Stage {n} (mastery), {rows} by {cols}, locked"))
            : (unlocked ? N("Stage {n}, {rows} by {cols}") : N("Stage {n}, {rows} by {cols}, locked")), { n: i + 1, rows: s.rows, cols: s.cols });
          button({
            id: `stage-${i + 1}`, text: label, name: label, style: s.mastery ? "stage-mastery" : "stage-btn", width: size, height: size, disabled: !unlocked,
            act: () => { ack(); startJourney(s); },
            content: () => ui.column(`stage-${i + 1}-face`, () => {
              ui.style(unlocked ? "stage-n" : "stage-n-locked").label(String(i + 1));
              ui.style("stars").label(stars);
            }, { align: "center", spacing: 4 }),
          });
        }
      }, { spacing: gap });
    }
  }, { spacing: gap, width: w, padding: { top: 2 } });
}
let seedDraft = "";
let sizeIdx = 1;
const SIZES = [8, 10, 12, 15];
function practiceScreen(w: number): void {
  const lw = Math.min(w, 640);
  para(T("Undo and hints are free here. Nothing affects your ratings. Seeds are shown so every board can be replayed and verified."), lw, "dim", "practice-intro");
  const bests = Progress.practiceBests(platform.save().progress);
  ui.column("practice-list", () => {
    for (const pr of Content.PRACTICE_PRESETS) {
      const best = bests[pr.id];
      rowButton(`preset-${pr.id}`, `${T(pr.name)} · ${pr.rows}×${pr.cols}`, `${T(pr.note)}${best ? ` · ${T("best {score}", { score: num(best) })}` : ""}`, lw, () => startPractice(pr));
    }
  }, { spacing: 10, width: lw });
  ui.column("custom-seed", () => {
    para(T("Custom seed"), lw - 34, "card-h3");
    para(T("Enter any text seed — the same seed always grows the same picture."), lw - 34, "dim-small");
    const inner = lw - 34;
    const narrow = inner < 420;
    const fieldW = narrow ? inner : inner - 130 - 90 - 16;
    const controls = (): void => {
      seedDraft = ui.id("practice-seed").textField(T("Custom seed"), seedDraft, { maxChars: 48, width: fieldW, placeholder: T("e.g. firefly-7") });
      const row2 = (): void => {
        const pick = ui.id("practice-size").select(T("Board size"), sizeIdx, SIZES.map((n) => `${n} × ${n}`), { width: 130 } as ui.WidgetOptions);
        if (pick !== sizeIdx) later(() => { sizeIdx = pick; });
        button({ id: "practice-seed-go", text: T("Grow"), style: "btn-primary", act: () => startCustomPractice(seedDraft, SIZES[sizeIdx]!) });
      };
      if (narrow) ui.row("seed-r2", row2, { spacing: 8, align: "center" });
      else row2();
    };
    if (ui.submitted(T("Custom seed")) && fresh()) later(() => startCustomPractice(seedDraft, SIZES[sizeIdx]!));
    if (narrow) ui.column("seed-controls", controls, { spacing: 8 });
    else ui.row("seed-controls", controls, { spacing: 8, align: "center" });
  }, { style: "card", width: lw, spacing: 8 });
}
function challengeScreen(w: number): void {
  const lw = Math.min(w, 640);
  para(T("Constrained goals with fixed weekly seeds. Ranked: no undo, validated scores."), lw, "dim", "challenge-intro");
  const specs = Content.challengeSpecs(Content.utcWeekKey(new Date(platform.nowMs())));
  const p = platform.save().progress;
  ui.column("challenge-list", () => {
    for (const c of specs) {
      const k = c.constraints ?? {};
      const rules: string[] = [];
      if (k.timeLimitMs) rules.push("⏱ " + T("{n}s limit", { n: Math.round(k.timeLimitMs / 1000) }));
      if (k.maxMistakes) rules.push(T("{n} mistakes max", { n: k.maxMistakes }));
      if (k.allowMarks === false) rules.push(T("no marks"));
      if (k.allowHints === false) rules.push(T("no hints"));
      if (k.moveLimit) rules.push(T("{n} moves max", { n: k.moveLimit }));
      const rec = p.challenges[c.id];
      rowButton(`challenge-${c.kind}`, `${T(c.name ?? "")} · ${c.rows}×${c.cols}`,
        `${T(c.desc ?? "")} · ${rules.join(" · ")}${rec ? ` · ${T("best {score}", { score: num(rec.score) })}` : ""}`, lw, () => startChallenge(c), T("ranked"), true);
    }
  }, { spacing: 10, width: lw });
}
function learnScreen(w: number): void {
  const lw = Math.min(w, 640);
  para(T("One rule at a time. You perform every action yourself — the board only accepts the move the lesson asks for."), lw, "dim", "learn-intro");
  const p = platform.save().progress;
  ui.column("lesson-list", () => {
    Content.LESSONS.forEach((l, i) => {
      rowButton(`lesson-${i + 1}`, `${i + 1}. ${T(l.name)}`, T(l.goal), lw, () => startLesson(l), p.lessons[l.id] ? T("done") : undefined, true);
    });
  }, { spacing: 10, width: lw });
}

// ------------------------------------------------------------------ Score Chase (#screen-scores)
let hosted: platform.HostedRow[] | null | undefined;
let hostedFor = -1;
interface Row { name: string; score: number; mistakes: number | null; elapsedMs: number | null; seed: string; me: boolean }
function scoresScreen(w: number): void {
  const p = platform.save().progress;
  const key = todayKey();
  const meName = platform.displayName() || platform.save().name || T("You");
  let daily: Row[] = [];
  let note: string = N("Local board (offline).");
  if (platform.signedIn()) {
    if (hostedFor !== app.openedFrame) { hostedFor = app.openedFrame; hosted = undefined; void platform.hostedBoard(20).then((r) => { hosted = r; }); }
    if (hosted) {
      daily = hosted.map((e) => ({ name: e.name, score: e.score, mistakes: null, elapsedMs: null, seed: "", me: e.me }));
      note = N("Global board · platform-owned, read-only.");
    }
  }
  if (!daily.length) {
    const mine = p.dailies[key];
    if (mine) daily = [{ name: meName, score: mine.score, mistakes: mine.mistakes, elapsedMs: mine.elapsedMs, seed: mine.seed ?? "", me: true }];
    note = platform.signedIn() ? (hosted === undefined ? N("Global board · platform-owned, read-only.") : N("No global scores yet — be the first light.")) : N("Local board (offline). Your daily results appear here.");
  }
  ui.row("scores-daily-h", () => { para(T("Today’s board"), w - 100, "h2"); badge("scores-daily-badge", T("daily"), true); }, { spacing: 10, align: "center" });
  para(`${T(note)} ${T("Streak: {n} day(s).", { n: Progress.dailyStreak(p, key) })}`, w, "dim-small", "scores-daily-note");
  boardTable("daily-board", daily, w, T("No global scores yet."));
  ui.column("local-h", () => para(T("Local bests"), w, "h2"), { padding: { top: 14 } });
  const local: Row[] = p.leaderboard.slice(0, 15).map((e) => ({ name: e.name || meName, score: e.score, mistakes: e.mistakes, elapsedMs: e.elapsedMs, seed: e.seed ?? "", me: true }));
  boardTable("local-board", local, w, T("Finish any puzzle to post a local best."));
  ui.column("achv-h", () => para(T("Achievements"), w, "h2"), { padding: { top: 14 } });
  cardGrid("achv-grid", Progress.ACHIEVEMENTS.length, w, 230, 12, (i, cw) => {
    const a = Progress.ACHIEVEMENTS[i]!;
    const got = p.achievements[a.key];
    ui.column(`achv-${a.key}`, () => {
      para(`${got ? "🏅" : "🔒"} ${T(a.name)}`, cw - 30, "card-h3");
      para(T(a.desc), cw - 30, "dim-small");
      if (got) para(T("Unlocked {date}", { date: String(got).slice(0, 10) }), cw - 30, "ach-got");
    }, { style: got ? "help-card" : "help-card-off", width: cw, spacing: 6 });
  });
}
function boardTable(id: string, rows: Row[], w: number, empty: string): void {
  if (!rows.length) { para(empty, w, "dim", `${id}-empty`); return; }
  const heads = ["#", T("Who"), T("Score"), T("Mistakes"), T("Time"), T("Seed")];
  const shares = [0.6, 3, 1.6, 1.6, 1.4, 1.8];
  const word = (t: string): number => Math.max(...t.split(" ").map((x) => textWidth(x, "th"))) + 12;
  const widths = shares.map((s, i) => Math.max(word(heads[i]!), (w * s) / shares.reduce((a, b) => a + b, 0)));
  const k = w / widths.reduce((a, b) => a + b, 0);
  const cw = widths.map((x) => x * k);
  const numeric = [false, false, true, true, true, false];
  const row = (rid: string, cells: string[], head: boolean, me: boolean): void => {
    ui.row(rid, () => cells.forEach((c, i) => ui.column(`${rid}-${i}`, () => para(c, cw[i]! - 10, head ? "th" : i === 5 ? "td-dim" : me ? "td-me" : "td"),
      { width: cw[i]!, align: numeric[i] ? "end" : "start", padding: { start: 3, end: 3 } })), { style: "table-row", width: w, spacing: 0, align: "center" });
  };
  ui.column(id, () => {
    row(`${id}-h`, heads.map(upper), true, false);
    rows.forEach((e, i) => row(`${id}-${i}`, [String(i + 1), e.name, num(e.score), e.mistakes == null ? "—" : String(e.mistakes),
      e.elapsedMs == null ? "—" : `${Math.floor(e.elapsedMs / 60000)}:${String(Math.floor(e.elapsedMs / 1000) % 60).padStart(2, "0")}`, e.seed || ""], false, e.me));
  }, { width: w, spacing: 0 });
}

// ------------------------------------------------------------------ How to play (#screen-help)
function keysFor(...actions: string[]): string {
  const GLYPH: Record<string, string> = { "Arrow Up": "↑", "Arrow Down": "↓", "Arrow Left": "←", "Arrow Right": "→", Escape: "Esc" };
  const out: string[] = [];
  for (const a of actions) {
    try { for (const b of bindings(a)) if (b.device === "keyboard") out.push(GLYPH[b.label] ?? b.label); } catch { /* not yet */ }
  }
  return [...new Set(out)].join(" / ");
}
function padFor(...actions: string[]): string {
  const out: string[] = [];
  for (const a of actions) {
    try {
      for (const b of bindings(a)) {
        if (b.device !== "gamepad") continue;
        out.push(b.label.startsWith("Dpad") ? T("D-pad") : b.label.startsWith("LeftStick") ? T("left stick") : b.label);
      }
    } catch { /* not yet */ }
  }
  return [...new Set(out)].join(" / ");
}
/** Key caps wrapped at `w` (the help cards' <kbd> runs). */
function kbdFlow(id: string, keys: string[], w: number): void {
  const rows: string[][] = [[]];
  let used = 0;
  for (const k of keys) {
    const kw = textWidth(k, "kbd-text") + 16;
    if (rows[rows.length - 1]!.length && used + 6 + kw > w) { rows.push([]); used = 0; }
    used += (rows[rows.length - 1]!.length ? 6 : 0) + kw;
    rows[rows.length - 1]!.push(k);
  }
  ui.column(id, () => rows.forEach((row, ri) => ui.row(`${id}-r${ri}`, () => {
    for (const [j, k] of row.entries()) ui.row(`${id}-r${ri}-${j}`, () => ui.style("kbd-text").label(k), { style: "kbd" });
  }, { spacing: 6 })), { spacing: 6 });
}
function helpScreen(w: number): void {
  para(plain(T("help.intro")), w, "text", "help-intro");
  const cards: [string, string][] = [
    [N("Light cells"), plain(T("help.fill"))],
    [N("Cross empties"), plain(T("help.mark"))],
    [N("Finish lines"), T("When every lit cell of a line is placed, the board crosses the rest of the line for you. Complete every lit cell to reveal the picture.")],
    [N("Scoring"), T("Points for lit cells, finishing under par, and clean boards. Mistakes cost 50, hints cost 25. A flawless board earns +500.")],
  ];
  cardGrid("help-cards", cards.length, w, 230, 12, (i, cw) => {
    const [t, p] = cards[i]!;
    ui.column(`help-${i}`, () => { para(T(t), cw - 30, "card-h3"); para(p, cw - 30, "text"); }, { style: "help-card", width: cw, spacing: 6 });
  });
  ui.column("controls-h", () => para(T("Controls"), w, "h2"), { padding: { top: 14 } });
  // The effective keys and pad controls (the runtime's rebinds included).
  const rows: [string, string, string][] = [
    [N("Move cursor"), keysFor("cursor_up", "cursor_left", "cursor_down", "cursor_right"), padFor("cursor_up", "cursor_left", "cursor_down", "cursor_right")],
    [N("Fill cell"), keysFor("fill"), padFor("fill")],
    [N("Mark ✕"), keysFor("mark"), padFor("mark")],
    [N("Clear mark"), keysFor("clear"), padFor("clear")],
    [N("Hint"), keysFor("hint"), padFor("hint")],
    [N("Undo"), keysFor("undo"), padFor("undo")],
    [N("Pause"), keysFor("pause"), padFor("pause")],
    [N("Reset camera"), keysFor("camera"), padFor("camera")],
  ];
  cardGrid("controls-grid", rows.length, w, 230, 12, (i, cw) => {
    const [t, keys, pad] = rows[i]!;
    ui.column(`ctl-${i}`, () => {
      para(T(t), cw - 30, "card-h3");
      kbdFlow(`ctl-${i}-keys`, keys.split(" / ").filter(Boolean), cw - 30);
      if (pad) para(`${T("Gamepad")}: ${pad}`, cw - 30, "dim-small");
    }, { style: "help-card", width: cw, spacing: 6 });
  });
}

// ------------------------------------------------------------------ Settings (#overlay-settings)
function group(text: string, w: number): void { ui.column(`group-${text}`, () => para(upper(T(text)), w, "set-group"), { width: w, padding: { top: 14 } }); }
function selectRow(id: string, label: string, hintText: string, idx: number, options: string[], w: number, set: (i: number) => void): void {
  const sw = Math.min(w * 0.5, 240);
  ui.row(`${id}-row`, () => {
    ui.column(`${id}-l`, () => { para(label, w - sw - 20, "text", `${id}-label`); if (hintText) para(hintText, w - sw - 20, "dim-small"); }, { width: w - sw - 14, spacing: 2 });
    ui.spacer();
    const pick = ui.id(id).select(label, idx, options, { width: sw } as ui.WidgetOptions);
    if (pick !== idx) later(() => set(pick));
  }, { style: "set-row", width: w, align: "center" });
}
/** A settings row with a switch (a role "checkbox" widget: the built-in check box's label doesn't wrap). */
function toggleRow(id: string, label: string, hintText: string, on: boolean, w: number, set: (v: boolean) => void): void {
  ui.row(`${id}-row`, () => {
    ui.column(`${id}-l`, () => { para(T(label), w - 70, "text", `${id}-label`); if (hintText) para(T(hintText), w - 70, "dim-small"); }, { width: w - 64, spacing: 2 });
    ui.spacer();
    const res = ui.id(id).widget(T(label), {
      role: "checkbox", checked: on, size: { width: 44, height: 44 },
      draw: (r, st) => {
        const s = st.scale, box = 24 * s, bx = r.x + (r.width - box) / 2, by = r.y + (r.height - box) / 2;
        draw.roundRect(bx, by, box, box, 5, on ? token("accent") : token("panel-2"));
        draw.strokeRoundRect(bx, by, box, box, 5, on ? token("accent") : token("line"), 2);
        if (on) draw.text("✓", bx + box / 2, by + 2 * s, { size: 18 * s, color: token("on-accent"), align: "center", weight: "bold" });
      },
    });
    if (res.activated && fresh()) later(() => set(!on));
  }, { style: "set-row", width: w, align: "center" });
}
let nameDraft: string | null = null;
function settingsScreen(w: number): void {
  const lw = Math.min(w, 640);
  const o = platform.options;
  const save = platform.save();
  ui.column("settings-body", () => {
    group(N("Profile"), lw);
    ui.row("set-name-row", () => {
      const nick = platform.displayName();
      ui.column("set-name-l", () => {
        para(T("Display name"), lw * 0.45, "text");
        para(nick ? T("Signed in as {name} — the platform account name is shown.", { name: nick }) : T("Shown on boards. Account sign-in is offered by the host when available."), lw * 0.45, "dim-small", "set-name-hint");
      }, { width: lw * 0.48, spacing: 2 });
      ui.spacer();
      if (nick) { ui.style("text-bold").label(nick); return; }
      if (nameDraft === null) nameDraft = save.name;
      nameDraft = ui.id("set-name").textField(T("Display name"), nameDraft, { maxChars: 24, width: Math.min(lw * 0.48, 220), placeholder: T("Guest") });
      const commit = nameDraft.trim().slice(0, 24);
      if (commit !== save.name && (ui.submitted(T("Display name")) || ui.focused() !== T("Display name"))) later(() => { save.name = commit; platform.persist(); });
    }, { style: "set-row", width: lw, align: "center" });
    group(N("Visual"), lw);
    selectRow("set-theme", T("Theme"), "", Math.max(0, Content.THEMES.findIndex((t) => t.id === o.theme)), Content.THEMES.map((t) => T(t.name)), lw,
      (i) => platform.setOption("theme", Content.THEMES[i]!.id));
    selectRow("set-palette", T("Palette"), T("Marks always use shapes as well as color."), o.palette === "cvd" ? 1 : 0, [T("Standard"), T("Color-vision safe")], lw,
      (i) => platform.setOption("palette", i === 1 ? "cvd" : "standard"));
    para(T("Sound, graphics, language, larger text, high contrast and reduced motion are in the StarHermit Options."), lw, "dim-small", "options-note");
    flow("settings-runtime", [
      { id: "btn-options", text: T("Open Options"), style: "btn", act: () => openMenu() },
      { id: "btn-rebind", text: T("Key bindings"), style: "btn", act: () => requestRebind() },
    ], lw, 8, "start");
    group(N("Audio"), lw);
    toggleRow("set-captions", N("Captions"), N("Text cues for meaningful audio."), o.captions, lw, (v) => platform.setOption("captions", v));
    group(N("Controls"), lw);
    toggleRow("set-lefty", N("Left-handed tray"), "", o.leftHanded, lw, (v) => platform.setOption("leftHanded", v));
    toggleRow("set-hold", N("Hold to mark"), N("When on, press-and-hold a cell to cross it (touch)."), o.holdToMark, lw, (v) => platform.setOption("holdToMark", v));
    group(N("Privacy"), lw);
    ui.row("set-reset-row", () => {
      ui.column("set-reset-l", () => { para(T("Replay tutorials"), lw - 140, "text"); para(T("Reset lesson completion."), lw - 140, "dim-small"); }, { width: lw - 130, spacing: 2 });
      ui.spacer();
      button({ id: "set-reset-lessons", text: T("Reset"), style: "btn-ghost", act: resetLessons });
    }, { style: "set-row", width: lw, align: "center" });
    ui.column("settings-done", () => button({ id: "settings-close", text: T("Done"), style: "btn-primary", width: lw, act: () => { ack(); back(); } }), { padding: { top: 14 } });
  }, { spacing: 0, width: lw });
}

// ------------------------------------------------------------------ results (#screen-results)
function resultsScreen(w: number): void {
  const R = app.results;
  if (!R) return;
  const st = R.state;
  const comp = Rules.scoreComponents(st);
  const MODE_NAMES: Record<string, string> = { learn: N("Learn"), journey: N("Journey"), daily: N("Daily Glow"), practice: N("Practice"), challenge: N("Challenge") };
  para(`${T(MODE_NAMES[R.kind] ?? N("Lesson"))}${R.ranked ? " · " + T("ranked") : ""}`, w, "result-mode", "result-mode");
  para(R.won ? T("Picture revealed") : T("The light faded"), w, "result-big", "result-title");
  para(R.won ? T("“{name}” in {time} with {mistakes} mistake(s), {hints} hint(s).", { name: puzzleName(R.puzzle.name), time: formatMs(st.elapsedMs), mistakes: st.mistakes, hints: st.hints })
    : failText(st.reason), w, "result-sub", "result-sub");
  const rows: [string, number][] = [
    [N("Picture cells"), comp.base], [N("Board size"), comp.sizeBonus], [N("Time bonus"), comp.timeBonus], [N("Clean board"), comp.cleanBonus],
    [N("Mistakes"), -comp.mistakePenalty], [N("Hints"), -comp.hintPenalty],
  ];
  const inner = w - 34;
  ui.column("score-card", () => {
    rows.forEach(([k, v], i) => ui.row(`score-${i}`, () => {
      para(T(k), inner - 110, "score-k");
      ui.spacer();
      ui.style(v < 0 ? "score-v-neg" : "score-v").id(`score-${i}-v`).label(`${v < 0 ? "-" : "+"}${num(Math.abs(v))}`);
    }, { style: "score-row", width: inner, align: "center" }));
    ui.row("score-total", () => {
      para(T("Total"), inner - 110, "total-k");
      ui.spacer();
      ui.style("total-v").id("score-total-v").label(num(comp.total));
    }, { style: "score-row-last", width: inner, align: "center" });
  }, { style: "card", width: w, spacing: 0 });
  ui.column("result-progress-card", () => {
    para(T("Progress"), inner, "card-h3");
    para(R.progress(), inner, "small", "result-progress");
    const lb = leaderboardLine();
    if (lb) para(lb, inner, "small", "result-lb");
  }, { style: "card", width: w, spacing: 8 });
  if (R.achievements.length) {
    ui.column("result-achv-card", () => {
      para(T("Achievements unlocked"), inner, "card-h3");
      para(R.achievements.map((a) => T(a)).join(" · "), inner, "small", "result-achv");
    }, { style: "card", width: w, spacing: 8 });
  }
  ui.column("result-actions", () => {
    button({ id: "result-next", text: R.hasNext ? T("Next stage {n}", { n: R.nextN }) : T("Continue"), style: "btn-primary", width: w, act: resultsNext });
    button({ id: "result-retry", text: T("Retry this puzzle"), style: "btn", width: w, act: restartSession });
    button({ id: "result-exit", text: T("Back to title"), style: "btn-ghost", width: w, act: leaveToTitle });
  }, { spacing: 8, padding: { top: 4 } });
}

