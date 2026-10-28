// Picture Logic on the StarHermit engine: the entry module (starhermit.txt
// engine.entry), played natively by the StarHermit client and in browsers by
// the engine's web runtime. The rules (js/rules.js), content (js/content.js,
// js/puzzles.js) and progression (js/progress.js) are the browser build's,
// unchanged in what they decide; this module is what js/main.js did around
// them — the screen flow (title → modes → preparing → countdown → active ⇄
// paused → resolving → results), starting every mode (Learn, Journey, Daily
// Glow, Practice with a custom seed, the weekly Challenges, Score Chase),
// resuming the last safe snapshot, the lesson gating, the commands (fill,
// mark, clear, hint, undo-by-restore) with their sounds, bursts,
// announcements and captions, the quantized authoritative clock ticks
// recorded in the replay envelope, the results with stars, streaks,
// achievements, the local board and the high-score post, and the lifecycle
// (a hidden window pauses the round, as visibilitychange did). Input: the
// board takes taps, clicks (right button marks), drags that paint a stroke
// and the hold-to-mark long press; keys and pads move the cell cursor and act
// on it. Screens are drawn by screens.ts (starhermit:ui), the board by
// render.ts (starhermit:scene).
//
// Time is the runtime's fixed steps: the round's clock ticks advance 1000/60
// ms a step (the browser build read requestAnimationFrame's time), and the
// countdown, the hold-to-mark delay and the pause before the results run on
// it too, so a hidden window and slow frames never move them and play
// scripts replay exactly.
import { clipboard, frame, onFixedUpdate, onPreferencesChange, onRender, onResume, onStart, onSuspend, onUpdate, preferences, setFixedRate } from "starhermit:engine";
import { onAction, onPointerButton, onPointerMove, onTouch, primaryPointer } from "starhermit:input";
import * as ui from "starhermit:ui";
import { onSessionEnded, requestSignIn } from "starhermit:platform";
import {
  CELL, Content, Progress, Rules, formatMs, hashSeed, type Command, type Envelope, type GameEvent, type Lesson, type Preset, type Puzzle,
  type Spec, type State,
} from "./game.ts";
import * as audio from "./audio.ts";
import { N, S, T, num, puzzleName } from "./i18n.ts";
import * as platform from "./platform.ts";
import * as gen from "./generate.ts";
import { lookFor } from "./quality.ts";
import * as render from "./render.ts";
import { drawScreens } from "./screens.ts";
import { applyTokens, initStyles } from "./style.ts";

export const BUILD_VERSION = "1.0.0";
export type ScreenName = "title" | "modes" | "journey" | "practice" | "challenge" | "learn" | "scores" | "help" | "settings" | "results";
export interface LessonRun { def: Lesson; step: number; count: number; reqCount: number | null }
export interface Session {
  kind: "journey" | "daily" | "practice" | "challenge" | "lesson";
  spec: Spec; puzzle: Puzzle; state: State; label: string; ranked: boolean; undoStack: number[][];
  lesson: LessonRun | null; replayEnv: Envelope; saveAt: number; presetId?: string;
}
export interface Results {
  state: State; puzzle: Puzzle; kind: string; ranked: boolean; won: boolean;
  progress: () => string; achievements: string[]; hasNext: boolean; nextN: number;
}

// ------------------------------------------------------------------ app state
let clockMs = 0;
export const app = {
  /** The full-page screen, or null on the play screen. */
  screen: "title" as ScreenName | null,
  /** Settings opened from the pause card return there. */
  settingsFromPause: false,
  /** Frame the screen opened on (the press that opened it must not also act on it). */
  openedFrame: 0,
  focusNext: null as string | null,
  phase: "title" as "title" | "preparing" | "countdown" | "active" | "resolving" | "results",
  paused: false,
  session: null as Session | null,
  /** A board being generated on the worker (Daily, Practice, Challenge). */
  preparing: null as { cancel: () => void; label: string } | null,
  /** The keyboard / pad cell cursor (the old DOM cell buttons' focus). */
  cursor: { r: 0, c: 0 },
  hover: null as { r: number; c: number } | null,
  /** The countdown: its start on the clock and its steps ("3", "2", "1", "Glow"; "Glow" alone with reduced motion). */
  countdown: null as { at: number; steps: string[]; step: number } | null,
  resultsAt: null as number | null,
  results: null as Results | null,
  lb: null as platform.Posted | "posting" | null,
  toasts: [] as { text: string; until: number }[],
  /** The lesson banner (step label and text), or null. */
  lesson: null as { step: string; text: string } | null,
  hiddenAt: 0,
};
const now = (): number => clockMs / 1000;
export const fresh = (): boolean => frame().frame !== app.openedFrame;
let sessionSeq = 0;
const sessionId = `s-${Date.now().toString(36)}`;

// ------------------------------------------------------------------ helpers
export function announce(text: string, assertive = false): void {
  if (text && text.trim()) ui.announce(text.slice(0, 500), { politeness: assertive ? "assertive" : "polite" });
}
export function toast(text: string): void {
  const same = app.toasts.find((x) => x.text === text);
  if (same) { same.until = now() + 3.1; return; } // the same note again refreshes its toast
  app.toasts.push({ text, until: now() + 3.1 });
  if (app.toasts.length > 4) app.toasts.shift();
}
export function inputMode(): "fill" | "mark" { return platform.options.inputMode; }
export function playing(): boolean { return !!app.session && app.phase === "active" && !app.paused && app.screen === null; }

// ------------------------------------------------------------------ screens
/** ui.js show(): a screen opens with its first control focused, for keyboard and pad players. */
const FIRST_FOCUS: Partial<Record<ScreenName, string>> = {
  title: "btn-play", modes: "mode-learn", journey: "stage-1", practice: "preset-practice-calm", challenge: "challenge-blitz",
  learn: "lesson-1", scores: "btn-back", help: "btn-back", settings: "btn-back", results: "result-next",
};
export function openScreen(name: ScreenName | null): void {
  app.screen = name;
  app.openedFrame = frame().frame;
  ui.setFocus(null);
  // (A browser focused it without a visible ring after a tap: here touch players get no ring.)
  app.focusNext = name && primaryPointer() !== "coarse" ? FIRST_FOCUS[name] ?? null : null;
  render.setActive(name === null);
}
export function goTitle(): void { openScreen("title"); }
/** The back buttons: modes and their lists go back to the modes / title; Settings over the pause card returns to it. */
export function back(): void {
  const s = app.screen;
  if (s === "settings" && app.settingsFromPause && app.session) { app.settingsFromPause = false; openScreen(null); return; }
  if (s === "journey" || s === "practice" || s === "challenge" || s === "learn") { openScreen("modes"); return; }
  goTitle();
}
export function openSettings(fromPause: boolean): void { app.settingsFromPause = fromPause; openScreen("settings"); }

// ------------------------------------------------------------------ starting rounds (main.js start*)
/** Display label of a session (or saved snapshot) in the current language (main.js sessionLabel). */
export function sessionLabel(s: { kind: string; spec?: Spec; presetId?: string; lesson?: LessonRun | null; label?: string } | null): string {
  if (!s) return "";
  if (s.kind === "journey" && s.spec) return T("Journey {n}", { n: (s.spec.index ?? 0) + 1 });
  if (s.kind === "daily" && s.spec) return T("Daily Glow {date}", { date: s.spec.dateKey ?? "" });
  if (s.kind === "practice") {
    const preset = Content.PRACTICE_PRESETS.find((x) => x.id === s.presetId);
    return T("Practice · {name}", { name: T(preset ? preset.name : N("Custom")) });
  }
  if (s.kind === "challenge" && s.spec) return T(s.spec.name ?? "");
  if (s.kind === "lesson") return T("Lesson · {name}", { name: T(s.lesson?.def?.name ?? "") });
  return s.label ?? "";
}
function makeSession(kind: Session["kind"], spec: Spec, puzzle: Puzzle, label: string, lesson: LessonRun | null = null): Session {
  const state = Rules.createState({
    id: puzzle.id, seed: puzzle.seed, rows: puzzle.rows, cols: puzzle.cols, solution: puzzle.solution, parMs: spec.parMs, constraints: spec.constraints,
  });
  return {
    kind, spec, puzzle, state, label, ranked: !!spec.ranked, undoStack: [], lesson,
    replayEnv: Rules.createReplayEnvelope(state, Content.CONTENT_VERSION, BUILD_VERSION), saveAt: clockMs,
  };
}
function cancelPreparing(): void { app.preparing?.cancel(); app.preparing = null; }
/** A board from the table or the worker, then the round (a "Preparing…" card meanwhile). */
function prepare(kind: Session["kind"], spec: Spec, label: string, presetId?: string): void {
  cancelPreparing();
  let done = false;
  const cancel = gen.puzzleFor(spec, (p, err) => {
    done = true;
    app.preparing = null;
    if (!p) { toast(T("The board could not be prepared.")); if (err) console.warn(`puzzle: ${err}`); return; }
    const s = makeSession(kind, spec, p, label);
    if (presetId) s.presetId = presetId;
    beginPlay(s);
  });
  if (!done) app.preparing = { cancel, label };
}
export function startJourney(stage: Spec): void { prepare("journey", stage, `Journey ${(stage.index ?? 0) + 1}`); }
export function todayKey(): string { return Content.utcDateKey(new Date(platform.nowMs())); }
export function startDaily(): void {
  const key = todayKey();
  if (platform.save().progress.excludedDailies.includes(key)) toast(T("Today’s board was marked defective and excluded from ranking — playing unranked."));
  prepare("daily", Content.dailySpec(key), `Daily Glow ${key}`);
}
/** main.js startPractice: a preset (seeded from its id and the clock) or a custom text seed. */
export function startPractice(preset: Preset, seedText?: string): void {
  const seed = seedText ? hashSeed(`practice:${seedText}:${preset.rows}x${preset.cols}`) : (hashSeed(preset.id) ^ (Date.now() % 0xffffff)) >>> 0;
  const spec: Spec = {
    id: `${preset.id}-${seed.toString(16)}`, seed, rows: preset.rows, cols: preset.cols, density: preset.density,
    parMs: preset.rows * preset.cols * 4200, theme: platform.options.theme,
  };
  prepare("practice", spec, `Practice · ${preset.name}`, preset.id);
}
export function startCustomPractice(text: string, size: number): void {
  const t = text.trim() || `seed-${Math.floor(Math.random() * 1e6)}`;
  startPractice({ id: `practice-custom-${t}-${size}`, name: "Custom", rows: size, cols: size, density: 0.6, note: "" }, t);
}
export function startChallenge(spec: Spec): void { prepare("challenge", spec, spec.name ?? ""); }
export function startLesson(lesson: Lesson): void {
  cancelPreparing();
  const puzzle: Puzzle = {
    id: lesson.id, seed: hashSeed(lesson.id), rows: lesson.board.rows, cols: lesson.board.cols, solution: lesson.board.solution,
    name: lesson.name, theme: platform.options.theme,
  };
  const spec: Spec = { id: lesson.id, seed: puzzle.seed, rows: puzzle.rows, cols: puzzle.cols, parMs: 10 * 60 * 1000, constraints: { allowHints: lesson.id === "lesson-5", allowUndo: true } };
  beginPlay(makeSession("lesson", spec, puzzle, `Lesson · ${lesson.name}`, { def: lesson, step: -1, count: 0, reqCount: null }));
}

/** main.js beginPlay: the board, the camera's swoop, then the countdown (lessons start at once). */
function beginPlay(s: Session): void {
  app.session = s;
  app.phase = "preparing";
  app.paused = false;
  app.results = null;
  app.resultsAt = null;
  app.lb = null;
  app.lesson = null;
  app.cursor = { r: 0, c: 0 };
  app.hover = null;
  tickAcc = 0;
  audio.setSeed(s.state.seed);
  audio.setTheme(s.puzzle.theme);
  audio.setSuspended(false);
  render.setTheme(s.puzzle.theme);
  render.setBoard(s.state.rows, s.state.cols, s.state.seed);
  render.syncState(s.state.grid, s.state.rows, s.state.cols);
  render.setFocusCell(0, 0);
  render.setHover(-1, -1, inputMode());
  openScreen(null);
  if (s.lesson) {
    app.phase = "active"; // lessons guide through gating, no countdown
    advanceLesson();
  } else runCountdown();
}
function runCountdown(): void {
  const rm = preferences().reducedMotion;
  app.phase = "countdown";
  app.countdown = { at: clockMs, steps: rm ? ["Glow"] : ["3", "2", "1", "Glow"], step: -1 };
}
export function restartSession(): void {
  const s = app.session;
  if (!s) return;
  if (s.kind === "lesson") { startLesson(s.lesson!.def); return; }
  if (s.kind === "daily") { startDaily(); return; }
  // Journey, Practice (the same board) and Challenge restart on their puzzle without generating it again.
  const next = makeSession(s.kind, s.spec, s.puzzle, s.label);
  next.presetId = s.presetId;
  beginPlay(next);
}
export function leaveToTitle(): void {
  if (app.session && app.phase === "active") saveSnapshot();
  app.session = null;
  app.phase = "title";
  app.paused = false;
  app.countdown = null;
  app.lesson = null;
  app.resultsAt = null;
  render.clearBoard();
  audio.setSuspended(false);
  goTitle();
}
export function resumeSnapshot(): void {
  const snap = platform.save().progress.lastSnapshot;
  if (!snap) return;
  try {
    const state = Rules.deserialize(snap.stateJson);
    const s: Session = {
      kind: snap.kind as Session["kind"], spec: snap.spec, puzzle: snap.puzzle, state, label: snap.label, ranked: !!snap.spec.ranked,
      undoStack: snap.undoStack || [], lesson: null,
      replayEnv: snap.replayEnv || Rules.createReplayEnvelope(state, Content.CONTENT_VERSION, BUILD_VERSION), saveAt: clockMs,
    };
    if (snap.presetId) s.presetId = snap.presetId;
    beginPlay(s);
    toast(T("Restored your last safe snapshot."));
  } catch (err) {
    console.warn(`snapshot restore failed: ${String(err)}`);
    platform.save().progress.lastSnapshot = null;
    platform.persist();
  }
}

// ------------------------------------------------------------------ lessons (main.js advanceLesson / lessonGate)
function countRemaining(req: { r?: number; c?: number }, mark: boolean): number {
  const s = app.session!.state;
  let n = 0;
  for (let i = 0; i < s.solution.length; i++) {
    const r = Math.floor(i / s.cols), c = i % s.cols;
    if (req.r !== undefined && req.r !== r) continue;
    if (req.c !== undefined && req.c !== c) continue;
    if (mark ? s.solution[i] === 0 && s.grid[i] === CELL.UNKNOWN : s.solution[i] === 1 && s.grid[i] !== CELL.FILLED) n++;
  }
  return n;
}
function advanceLesson(): void {
  const L = app.session!.lesson!;
  L.step++;
  L.count = 0;
  if (L.step >= L.def.steps.length) { app.lesson = null; return; }
  const st = L.def.steps[L.step]!;
  // A step targeting a line without a count counts what is left on the live board; every count is clamped to what is
  // still possible (line propagation can pre-satisfy a step), and a step with nothing left is skipped.
  L.reqCount = st.requireCount ?? null;
  if (st.require.type === "fill" || st.require.type === "mark") {
    const remaining = countRemaining(st.require, st.require.type === "mark");
    if (remaining === 0) { advanceLesson(); return; }
    L.reqCount = Math.min(L.reqCount ?? remaining, remaining);
  }
  refreshLessonBanner();
  announce(T(st.text));
}
function refreshLessonBanner(): void {
  const L = app.session?.lesson;
  if (!L || L.step < 0 || L.step >= L.def.steps.length) return;
  app.lesson = {
    step: T("{lesson} · step {n}/{total}", { lesson: T(L.def.name), n: L.step + 1, total: L.def.steps.length }),
    text: T(L.def.steps[L.step]!.text),
  };
}
function lessonGate(cmd: Command): boolean {
  const L = app.session?.lesson;
  if (!L || L.step < 0 || L.step >= L.def.steps.length) return true;
  const req = L.def.steps[L.step]!.require;
  const match = cmd.type === req.type && (req.r === undefined || req.r === cmd.r) && (req.c === undefined || req.c === cmd.c);
  if (!match) {
    audio.event("error");
    toast(T("The lesson asks for a different move — follow the banner."));
    return false;
  }
  return true;
}
function lessonProgress(): void {
  const L = app.session?.lesson;
  if (!L || L.step < 0 || L.step >= L.def.steps.length) return;
  L.count++;
  if (L.count >= (L.reqCount || 1)) advanceLesson();
}

// ------------------------------------------------------------------ actions (main.js doAction / undo)
export function doAction(cmd: Command): void {
  const sess = app.session;
  if (!sess || app.phase !== "active" || app.paused) return;
  const s = sess.state;
  // "Mark" on a marked cell clears it (toggle feel).
  if (cmd.type === "mark" && cmd.r != null && cmd.c != null && s.grid[cmd.r * s.cols + cmd.c] === CELL.MARKED) cmd = { ...cmd, type: "clear" };
  if (!lessonGate(cmd)) return;
  const v = Rules.validate(s, cmd);
  if (!v.ok) { explainInvalid(v.reason ?? ""); return; }
  if (["fill", "mark", "clear", "hint"].includes(cmd.type) && s.constraints.allowUndo) {
    sess.undoStack.push(s.grid.slice());
    if (sess.undoStack.length > 200) sess.undoStack.shift();
  }
  const res = Rules.applyCommand(s, { ...cmd, id: `${sessionId}-t${s.turn}` });
  Rules.replayRecord(sess.replayEnv, s, cmd, res);
  lessonProgress();
  handleEvents(res.events);
  render.syncState(s.grid, s.rows, s.cols, res.events);
  if (clockMs - sess.saveAt > 4000) saveSnapshot();
  if (res.events.some((e) => e.type === "terminal")) onTerminal();
}
export function undo(): void {
  const sess = app.session;
  if (!sess || app.phase !== "active" || app.paused) return;
  const s = sess.state;
  const snap = sess.undoStack.pop();
  if (!snap) { toast(T("Nothing to undo.")); return; }
  const cmd: Command = { type: "restore", grid: snap };
  const res = Rules.applyCommand(s, cmd);
  if (!res.ok) { explainInvalid(res.reason ?? ""); return; }
  Rules.replayRecord(sess.replayEnv, s, cmd, res);
  handleEvents(res.events);
  render.syncState(s.grid, s.rows, s.cols, res.events);
}
export function hint(): void { doAction({ type: "hint" }); }
const INVALID: Record<string, string> = {
  "not-active": N("The round is not active."),
  "out-of-bounds": N("That cell is outside the board."),
  "cell-locked": N("That cell is already lit — lit cells are certain."),
  "cell-not-unknown": N("Only untouched cells can be crossed."),
  "cell-not-marked": N("Only crossed cells can be cleared."),
  "marks-disabled": N("Marks are disabled in this challenge."),
  "hints-disabled": N("Hints are disabled here."),
  "move-limit": N("The move budget is spent."),
  "undo-disabled": N("Undo is not allowed in ranked play."),
  "nothing-to-reveal": N("Nothing left to reveal."),
};
function explainInvalid(reason: string): void {
  const msg = INVALID[reason] ? T(INVALID[reason]!) : T("That move is not legal ({reason}).", { reason });
  announce(msg, true);
  toast(msg);
  audio.event("error");
}
function handleEvents(events: GameEvent[]): void {
  const s = app.session!.state;
  const captions = platform.options.captions;
  for (const ev of events) {
    switch (ev.type) {
      case "fill": audio.event("fill"); if (captions) announce(T("Cell lit")); break;
      case "mark": audio.event("mark"); break;
      case "clear": audio.event("clear"); break;
      case "restore": audio.event("undo"); break;
      case "propagate": audio.event("line"); announce(T("A line resolved — certain cells crossed for you.")); break;
      case "mistake":
        audio.event("error");
        announce(s.constraints.maxMistakes !== null
          ? T("That cell is empty. Mistake {n} of {max}.", { n: s.mistakes, max: s.constraints.maxMistakes })
          : T("That cell is empty. Mistake {n}.", { n: s.mistakes }), true);
        if (captions) toast(T("✕ That cell is empty — mistake counted"));
        break;
      case "hint": audio.event("hint"); announce(T("Hint revealed row {r}, column {c}.", { r: (ev.r ?? 0) + 1, c: (ev.c ?? 0) + 1 })); break;
    }
  }
}

// ------------------------------------------------------------------ pause and snapshots
export function togglePause(force?: boolean): void {
  if (!app.session) return;
  const want = force !== undefined ? force : !app.paused;
  if (want === app.paused) return;
  if (app.phase !== "active" && want) return;
  app.paused = want;
  audio.event("pause");
  audio.setSuspended(want);
  app.openedFrame = frame().frame;
  if (want) { saveSnapshot(); if (primaryPointer() !== "coarse") app.focusNext = "pause-resume"; }
  else { tickAcc = 0; ui.setFocus(null); }
}
export function saveSnapshot(): void {
  const s = app.session;
  if (!s || app.phase === "results" || s.state.status !== "active" || s.kind === "lesson") return;
  platform.save().progress.lastSnapshot = {
    savedAt: new Date(platform.nowMs()).toISOString(), kind: s.kind, label: s.label, spec: s.spec, ...(s.presetId ? { presetId: s.presetId } : {}),
    puzzle: { id: s.puzzle.id, seed: s.puzzle.seed, rows: s.puzzle.rows, cols: s.puzzle.cols, solution: s.puzzle.solution, name: s.puzzle.name, theme: s.puzzle.theme },
    stateJson: Rules.serialize(s.state), stateElapsed: s.state.elapsedMs, undoStack: s.undoStack.slice(-50), replayEnv: s.replayEnv,
  };
  s.saveAt = clockMs;
  platform.persist();
}

// ------------------------------------------------------------------ the end of a round (main.js onTerminal)
function onTerminal(): void {
  const s = app.session!;
  const st = s.state;
  app.phase = "resolving";
  app.countdown = null;
  const won = st.status === "complete";
  audio.event(won ? "win" : "fail");
  if (won) audio.setMusicIntensity(1);
  const comp = Rules.scoreComponents(st);
  const clean = st.mistakes === 0 && st.hints === 0;
  const save = platform.save();
  const p = save.progress;
  const unlocked: string[] = [];
  const iso = new Date(platform.nowMs()).toISOString();
  const grant = (key: string, name: string): void => { if (Progress.unlockAchievement(p, key, iso)) unlocked.push(name); };
  if (won) {
    p.completions++;
    p.cleanStreak = clean ? p.cleanStreak + 1 : 0;
    p.bestCleanStreak = Math.max(p.bestCleanStreak, p.cleanStreak);
    grant("first-light", N("First Light"));
    if (clean) grant("clean-sweep", N("Clean Sweep"));
    if (p.cleanStreak >= 3) grant("streak-3", N("Steady Glow"));
    if (p.completions >= 100) grant("century", N("Keeper of the Board"));
  } else p.cleanStreak = 0;

  let progressText: () => string = () => "";
  if (s.kind === "journey") {
    const rec = Progress.recordJourney(p, s.spec.id, { score: comp.total, mistakes: st.mistakes, hints: st.hints, elapsedMs: st.elapsedMs, parMs: st.parMs, completed: won });
    const stars = "★".repeat(rec.stars) + "☆".repeat(3 - rec.stars);
    const mastered = won && !!s.spec.mastery;
    progressText = () => T("Stage stars: {stars}.", { stars }) + (mastered ? " " + T("Mastery stage cleared.") : "");
    if (mastered) grant("mastery", N("Mastery Bloom"));
  } else if (s.kind === "daily") {
    const key = s.spec.dateKey ?? todayKey();
    if (won) {
      Progress.recordDaily(p, key, { score: comp.total, mistakes: st.mistakes, elapsedMs: st.elapsedMs, seed: st.seed.toString(16) });
      const streak = Progress.dailyStreak(p, key);
      progressText = () => T("Daily streak: {n} day(s).", { n: streak });
      if (streak >= 7) grant("daily-7", N("Week of Light"));
    } else progressText = () => T("The daily board keeps your best attempt — try again.");
  } else if (s.kind === "challenge") {
    const prev = p.challenges[s.spec.id];
    if (won && (!prev || comp.total > prev.score)) {
      p.challenges[s.spec.id] = { score: comp.total, mistakes: st.mistakes, elapsedMs: st.elapsedMs };
      progressText = () => T("New personal best for this challenge.");
    } else progressText = () => (won ? T("Challenge complete.") : T("Challenge failed — the constraint held."));
  } else if (s.kind === "practice") {
    p.practicePlays++;
    progressText = () => T("Practice is unranked — undo and hints were free.");
  } else if (s.kind === "lesson") {
    p.lessons[s.lesson!.def.id] = true;
    const done = Content.LESSONS.filter((l) => p.lessons[l.id]).length;
    progressText = () => T("Lessons complete: {done}/{total}.", { done, total: Content.LESSONS.length });
    app.lesson = null;
  }
  if (won && s.kind !== "lesson") {
    Progress.addLeaderboard(p, {
      name: platform.displayName() || save.name || T("You"), score: comp.total, mistakes: st.mistakes, elapsedMs: st.elapsedMs,
      mode: s.kind, ...(s.presetId ? { presetId: s.presetId } : {}), seed: st.seed.toString(16), ruleset: Content.CONTENT_VERSION,
      date: iso.slice(0, 10),
    });
  }
  p.lastSnapshot = null;
  platform.persist();
  if (won && (s.kind === "daily" || s.kind === "challenge")) platform.flush(); // ranked results mirrored to the cloud slot
  postToLeaderboard(won && ["journey", "daily", "challenge"].includes(s.kind) ? comp.total : null);
  const hasNext = s.kind === "journey" && won && (s.spec.index ?? 0) < Content.JOURNEY_STAGES.length - 1;
  app.results = {
    state: st, puzzle: s.puzzle, kind: s.kind, ranked: s.ranked, won, progress: progressText, achievements: unlocked,
    hasNext, nextN: (s.spec.index ?? 0) + 2,
  };
  // The cosmetic bloom runs longer than the logic; the results wait for it (reduced motion settles at once).
  app.resultsAt = clockMs + (preferences().reducedMotion ? 350 : 2100);
}
function showResults(): void {
  const r = app.results;
  if (!r) return;
  app.phase = "results";
  openScreen("results");
  audio.setMusicIntensity(0.3);
  announce(`${r.won ? T("Picture revealed") : T("The light faded")}. ${T("Total")} ${num(Rules.scoreComponents(r.state).total)}.`, true);
}
/** Signed in only: a won Journey, Daily or Challenge round posts its total to the high-score board. */
function postToLeaderboard(total: number | null): void {
  app.lb = null;
  if (total == null || !platform.signedIn()) return;
  app.lb = "posting";
  const r0 = app.session;
  void platform.postScore(total).then((r) => { if (app.session === r0) app.lb = r; });
}
export function leaderboardLine(): string | null {
  const r = app.lb;
  if (!r) return null;
  if (r === "posting") return S("lbPosting");
  return !r.posted ? S("lbFailed") : r.rank ? S("lbRank", { rank: r.rank }) : S("lbPosted");
}
export function failText(reason: string | null): string {
  const R = Rules.REASON;
  const map: Record<string, string> = {
    [R.MISTAKES!]: N("Too many wrong cells — the board went dark."),
    [R.TIME!]: N("Time ran out."),
    [R.MOVES!]: N("The move budget ran out."),
    [R.ABANDONED!]: N("Attempt abandoned."),
  };
  return T(map[reason ?? ""] ?? N("Attempt ended."));
}
export function resultsNext(): void {
  const s = app.session;
  if (s?.kind === "journey" && s.state.status === "complete") {
    const next = Content.JOURNEY_STAGES[(s.spec.index ?? 0) + 1];
    if (next) { startJourney(next); return; }
  }
  if (s?.kind === "lesson") { app.session = null; app.phase = "title"; render.clearBoard(); openScreen("learn"); return; }
  leaveToTitle();
}

// ------------------------------------------------------------------ misc actions
export function setInputMode(mode: "fill" | "mark"): void {
  platform.setOption("inputMode", mode);
  audio.event("ack");
}
export function resetCamera(): void { render.resetCamera(); audio.event("ack"); }
export function signIn(): void { void requestSignIn().catch(() => undefined); }
export function copyInvite(): void {
  const link = platform.inviteLink();
  if (!link) return;
  try { clipboard.writeText(link); toast(S("inviteCopied")); } catch { toast(S("inviteFailed", { link })); }
}
export function resetLessons(): void {
  platform.save().progress.lessons = {};
  platform.persist();
  toast(T("Lessons reset — replay them from Learn."));
}
export function ack(): void { audio.event("ack"); }

// ------------------------------------------------------------------ keys and pads (ui.js _onKey, main.js pollGamepad)
function setCursor(r: number, c: number): void {
  app.cursor = { r, c };
  render.setFocusCell(r, c);
  if (app.phase === "active") audio.event("focus");
  const s = app.session?.state;
  if (s) announce(cellLabel(s, r, c));
}
export function cellLabel(s: State, r: number, c: number): string {
  const v = s.grid[r * s.cols + c];
  const key = v === CELL.FILLED ? N("Row {r}, column {c}, lit") : v === CELL.MARKED ? N("Row {r}, column {c}, crossed") : N("Row {r}, column {c}, unknown");
  return T(key, { r: r + 1, c: c + 1 });
}
onAction((e) => {
  if (!e.pressed || ui.capturingKeys()) return;
  const a = e.action;
  if (a === "pause") {
    if (!fresh()) return;
    // Escape is Back on an open screen (Settings over the pause card returns to it).
    if (app.screen) { if (app.screen !== "title" && app.screen !== "results") back(); return; }
    if (app.preparing) { cancelPreparing(); return; }
    if (app.paused) return; // the pause card's own close resumes
    if (app.session && app.phase === "active") togglePause(true);
    return;
  }
  if (!playing()) return;
  const s = app.session!.state;
  const { r, c } = app.cursor;
  switch (a) {
    case "cursor_up": case "cursor_down": case "cursor_left": case "cursor_right": {
      ui.setFocus(null);
      const dr = a === "cursor_up" ? -1 : a === "cursor_down" ? 1 : 0, dc = a === "cursor_left" ? -1 : a === "cursor_right" ? 1 : 0;
      setCursor((r + dr + s.rows) % s.rows, (c + dc + s.cols) % s.cols);
      break;
    }
    case "fill": if (ui.focused() === null) doAction({ type: "fill", r, c }); break; // Enter / Space on a focused button is the button's
    case "mark": doAction({ type: "mark", r, c }); break;
    case "clear": doAction({ type: "clear", r, c }); break;
    case "hint": hint(); break;
    case "undo": undo(); break;
    case "camera": resetCamera(); break;
  }
});

// ------------------------------------------------------------------ the board by pointer and touch (ui.js _bindPainting)
/** Rectangles (window pixels) where a press belongs to the UI, set by screens.ts each frame. */
export const hudRects: { x: number; y: number; width: number; height: number }[] = [];
/** The playfield (window px), set by screens.ts. */
export const field: render.Rect = { x: 0, y: 0, width: 0, height: 0 };
const onHud = (x: number, y: number): boolean => hudRects.some((q) => x >= q.x && y >= q.y && x <= q.x + q.width && y <= q.y + q.height);
const inField = (x: number, y: number): boolean => x >= field.x && y >= field.y && x <= field.x + field.width && y <= field.y + field.height;
type PEvent = { kind: "down" | "move" | "up" | "cancel"; x: number; y: number; id: number; button: number; touch: boolean };
const events: PEvent[] = [];
let lastTouch = -1e9;
/** The active stroke: its action, the cells it already did, and a press waiting to tell a tap from a hold (hold to mark). */
let paint: { id: number; action: "fill" | "mark"; done: Set<string>; pending: { r: number; c: number } | null; at: number } | null = null;
onTouch((e) => {
  lastTouch = now();
  if (e.control) return;
  const kind = e.phase === "start" ? "down" : e.phase === "move" ? "move" : e.phase === "end" ? "up" : "cancel";
  events.push({ kind, x: e.x, y: e.y, id: e.id, button: 0, touch: true });
});
onPointerButton((e) => {
  if (now() - lastTouch < 0.6 || (e.button !== 0 && e.button !== 2)) return;
  events.push({ kind: e.pressed ? "down" : "up", x: e.x, y: e.y, id: -1, button: e.button, touch: false });
});
onPointerMove((x, y) => { if (now() - lastTouch >= 0.6) events.push({ kind: "move", x, y, id: -1, button: 0, touch: false }); });
function applyPaint(cell: { r: number; c: number }): void {
  if (!paint) return;
  const key = `${cell.r},${cell.c}`;
  if (paint.done.has(key)) return; // idempotent within a stroke
  paint.done.add(key);
  doAction({ type: paint.action, r: cell.r, c: cell.c });
}
function pointerInput(): void {
  for (const ev of events.splice(0)) {
    const over = playing() && inField(ev.x, ev.y) && !onHud(ev.x, ev.y);
    if (ev.kind === "move") {
      const cell = over ? render.pickCell(ev.x, ev.y) : null;
      if (!ev.touch) { app.hover = cell; render.setHover(cell?.r ?? -1, cell?.c ?? -1, inputMode()); }
      if (paint && paint.id === ev.id && cell) {
        if (paint.pending && (cell.r !== paint.pending.r || cell.c !== paint.pending.c)) {
          // Dragged before the hold threshold: a fill stroke.
          const origin = paint.pending;
          paint.pending = null;
          applyPaint(origin);
        }
        if (!paint.pending) applyPaint(cell);
      }
      continue;
    }
    if (ev.kind === "down") {
      paint = null;
      if (!over) continue;
      const cell = render.pickCell(ev.x, ev.y);
      if (!cell) continue;
      ui.setFocus(null);
      app.cursor = cell;
      render.setFocusCell(cell.r, cell.c);
      const action = ev.button === 2 ? "mark" : inputMode();
      paint = { id: ev.id, action, done: new Set(), pending: null, at: clockMs };
      // Hold to mark (touch): the first action waits until tap or hold is decided.
      if (platform.options.holdToMark && ev.touch && action === "fill") paint.pending = cell;
      else applyPaint(cell);
      continue;
    }
    if (!paint || paint.id !== ev.id) continue;
    if (ev.kind === "up" && paint.pending) applyPaint(paint.pending); // released before the hold threshold: a plain tap fills
    paint = null;
  }
  // The hold threshold (380 ms) on the round's clock.
  if (paint?.pending && clockMs - paint.at >= 380) {
    const cell = paint.pending;
    paint.pending = null;
    paint.action = "mark";
    applyPaint(cell);
  }
  if (!playing()) { paint = null; if (app.hover) { app.hover = null; render.setHover(-1, -1, inputMode()); } }
}

// ------------------------------------------------------------------ the clock
let hidden = false;
let tickAcc = 0;
onFixedUpdate(() => {
  if (hidden) return;
  const step = 1000 / 60;
  clockMs += step;
  // The countdown (3, 2, 1, Glow at 620 ms each; Glow alone for 500 ms with reduced motion).
  const cd = app.countdown;
  if (cd && app.phase === "countdown") {
    const per = cd.steps.length === 1 ? 500 : 620;
    const k = Math.floor((clockMs - cd.at) / per);
    if (k !== cd.step) {
      cd.step = k;
      if (k >= cd.steps.length) { app.countdown = null; app.phase = "active"; tickAcc = 0; }
      else { audio.event(cd.steps[k] === "Glow" ? "line" : "countdown"); announce(cd.steps[k] === "Glow" ? T("Glow") : cd.steps[k]!); }
    }
  }
  if (app.resultsAt !== null && clockMs >= app.resultsAt) { app.resultsAt = null; showResults(); }
  // Quantized authoritative ticks (500 ms quanta), recorded in the replay envelope.
  const sess = app.session;
  if (sess && app.phase === "active" && !app.paused) {
    tickAcc += step;
    if (tickAcc >= 500) {
      const ms = Math.floor(tickAcc);
      tickAcc -= ms;
      const cmd: Command = { type: "tick", ms };
      const res = Rules.applyCommand(sess.state, cmd);
      if (res.ok) {
        Rules.replayRecord(sess.replayEnv, sess.state, cmd, res);
        if (res.events.some((e) => e.type === "terminal")) onTerminal();
      }
    }
    // The music's intensity follows the progress.
    const s = sess.state;
    if (s.filledCount) {
      let lit = 0;
      for (let i = 0; i < s.grid.length; i++) if (s.grid[i] === CELL.FILLED && s.solution[i] === 1) lit++;
      audio.setMusicIntensity(0.25 + 0.6 * (lit / s.filledCount));
    }
  }
});

// ------------------------------------------------------------------ boot and lifecycle
let lookKey = "";
function applyLook(): void {
  const f = frame();
  const k = `${f.quality}:${f.levelIndex}`;
  if (k === lookKey) return;
  lookKey = k;
  render.applyLook(lookFor(f.quality, f.levelIndex));
}
export function currentLook(): ReturnType<typeof lookFor> { const f = frame(); return lookFor(f.quality, f.levelIndex); }

onStart(() => {
  setFixedRate(60);
  initStyles();
  platform.initPlatform();
  audio.loadSfx();
  gen.warm();
  render.setReducedMotion(preferences().reducedMotion);
  applyLook();
  goTitle();
  void sessionSeq;
});
onPreferencesChange((p) => render.setReducedMotion(p.reducedMotion));
platform.onProgressMerged(() => toast(T("Progress synced from your account.")));
onSessionEnded(() => toast(S("signedOut"))); // keep playing locally
onSuspend(() => {
  hidden = true;
  app.hiddenAt = Date.now();
  // Backgrounding pauses solo play (the player resumes from the pause card).
  if (app.session && app.phase === "active" && !app.paused) togglePause(true);
  saveSnapshot();
  audio.setSuspended(true);
  platform.flush();
});
onResume(() => {
  hidden = false;
  if (app.hiddenAt && Date.now() - app.hiddenAt > 4000 && app.session) {
    const away = Math.round((Date.now() - app.hiddenAt) / 1000);
    toast(T("Welcome back — away {time}. Solo play paused while you were gone.", { time: `${Math.floor(away / 60)}:${String(away % 60).padStart(2, "0")}` }));
  }
  app.hiddenAt = 0;
  if (!app.paused) audio.setSuspended(false);
});

let frameDt = 0;
onUpdate((dt) => {
  frameDt = dt;
  applyLook();
  const o = platform.options;
  const th = app.session && app.screen === null ? app.session.puzzle.theme : o.theme;
  applyTokens(o.theme, o.palette, ui.preferences().highContrast);
  void th;
  audio.update(dt);
  const t = now();
  app.toasts = app.toasts.filter((x) => x.until >= t);
});
const pending: (() => void)[] = [];
/** A widget's press, run once the frame's UI is built (state changes mid-build would break later widgets). */
export function later(fn: () => void): void { pending.push(fn); }
onRender(() => {
  hudRects.length = 0;
  // The board moves first, so the overlay drawn over it (clues, crosses, named cells) projects this frame's camera.
  const f = frame();
  render.update(frameDt, f.width, f.height);
  drawScreens();
  for (const fn of pending.splice(0)) fn();
  pointerInput();
});
export { formatMs, puzzleName };
