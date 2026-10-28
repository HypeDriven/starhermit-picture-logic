// Sound, as the browser build's js/audio.js: the authored one-shots
// (sfx/<name>.opus) per game event, one clip of each event's group picked by
// the seeded variant stream (setSeed: the puzzle's seed), with the 40 ms
// double-trigger guard; the quiet room tone (looped noise lowpassed at
// 320 Hz) and the adaptive music (a slow three-sine pad every 7.2 s, rooted
// by the puzzle's theme, and a sparse pentatonic melody every 1.8 s whose
// density follows the board's progress). The browser build ran the music
// and room tone live (oscillators on timers, a noise loop); here they are
// rendered once into clips (createClip, a slice a frame) and looped on the
// music bus — the melody's extra notes for a busy board are a second loop
// faded in by the intensity — as the runtime has no ambience bus. The
// browser build's bus levels (music 0.5 and ambience 0.35 against effects
// 0.8) are the voices' gains. The runtime's Options own the volumes, the
// mute and the voice limit. The oscillator stand-ins the browser build
// synthesized while a sample decoded are not ported (a live synthesis graph
// makes clip loads fail on the web runtime): a clip still loading is silent.
// Clips load once the mixer runs (natively at once, in a browser after the
// first press), one at a time.
import { context, createClip, loadClip, play as playClip, type AudioClip, type Sound } from "starhermit:audio";
import { Rng, type RngApi } from "./game.ts";

/** audio.js SAMPLE_MAP. */
const SAMPLE_MAP: Record<string, string[]> = {
  ack: ["ui-click", "ui-confirm", "ui-back", "ui-tab-switch", "ui-scroll-tick", "ui-drawer-open", "ui-modal-open", "ui-panel-close",
    "ui-toast-notify", "ui-settings-saved", "ui-toggle", "ui-resume", "daily-ready"],
  focus: ["ui-hover"],
  fill: ["cell-fill", "drag-start", "drag-sweep"],
  mark: ["cell-cross"],
  clear: ["board-reset"],
  error: ["ui-error"],
  line: ["clue-complete", "row-complete", "column-complete", "tutorial-step"],
  hint: ["hint-reveal"],
  undo: ["undo-move"],
  pause: ["ui-pause"],
  win: ["win-stinger", "puzzle-reveal", "new-record", "streak-milestone", "ui-success", "journey-unlock"],
  fail: ["level-fail"],
  tick: ["ui-timer-warning"],
  countdown: ["ui-countdown-tick"],
};
export type Sfx = keyof typeof SAMPLE_MAP;

const clips = new Map<string, AudioClip>();
const queue: string[] = [];
let loading = false;
let wantClips = false;
let suspended = false;
let variant: RngApi = new Rng(1, "audio-variant");
const lastAt = new Map<string, number>();
let clock = 0;

/** Asks for the clips; they load once the mixer runs (see update). */
export function loadSfx(): void { wantClips = true; }
/** audio.js setSeed: the variant stream follows the puzzle. */
export function setSeed(seed: number): void { variant = new Rng((seed ^ 0xa0d10) >>> 0, "audio-variant"); }

/** audio.js event(): one clip of the event's group (none within 40 ms of the last). */
export function event(name: Sfx): void {
  if (suspended) return;
  const last = lastAt.get(name) ?? -1;
  if (last >= 0 && clock - last < 0.04) return;
  lastAt.set(name, clock);
  const group = SAMPLE_MAP[name];
  if (!group) return;
  const file = group.length === 1 ? group[0]! : variant.pick(group);
  const clip = clips.get(file);
  if (!clip) return;
  try { playClip(clip, { bus: "effects" }); } catch { clips.delete(file); if (!queue.includes(file)) queue.push(file); }
}

// -- the room tone and the music ------------------------------------------------------------------
const RATE = 22050;
const AMB_N = RATE * 2;
const amb = new Float32Array(AMB_N);
let ambPos = 0, ambV = 0, ambS = 24680, ambY = 0;
/** audio.js startAmbience: v = 0.98 v + noise × 0.02 (× 8), then the 320 Hz lowpass (run twice round so the loop joins). */
function renderAmbience(count: number): boolean {
  const k = 1 - Math.exp((-2 * Math.PI * 320) / RATE);
  const end = Math.min(2 * AMB_N, ambPos + count);
  for (; ambPos < end; ambPos++) {
    const i = ambPos % AMB_N;
    if (ambPos < AMB_N) {
      ambS = (ambS * 1103515245 + 12345) & 0x7fffffff;
      ambV = ambV * 0.98 + (ambS / 0x3fffffff - 1) * 0.02;
      amb[i] = ambV * 8;
    } else {
      ambY += k * (amb[i]! - ambY);
      amb[i] = ambY * 0.5;
    }
  }
  return ambPos >= 2 * AMB_N;
}

const BASE = 220;
const SCALE = [0, 3, 5, 7, 10];
const THEME_SHIFT: Record<string, number> = { "dawn-garden": 0, "tide-glass": -2, "ember-night": -4, "moss-archive": 3, "snow-signal": 5 };
interface Note { t: number; f: number; dur: number; gain: number; attack: number }
/** audio.js _tone: linear attack, exponential decay to 0.0008 by `dur`, wrapping round the loop. */
function renderNote(buf: Float32Array, n: Note): void {
  const len = Math.round((n.dur + 0.05) * RATE), start = Math.round(n.t * RATE);
  for (let i = 0; i < len; i++) {
    const t = i / RATE;
    const env = t < n.attack ? (t / n.attack) * n.gain : n.gain * Math.pow(0.0008 / n.gain, Math.min(1, (t - n.attack) / Math.max(0.001, n.dur - n.attack)));
    buf[(start + i) % buf.length]! += Math.sin(2 * Math.PI * n.f * t) * env;
  }
}
/** The pad: three sines on the theme's root, 1.2 s attack, 3.6 s long, once per 7.2 s loop. */
const PAD_N = Math.round(RATE * 7.2);
const pads = new Map<string, AudioClip>();
let padBuf: Float32Array | null = null, padNote = 0, padTheme = "";
function padNotes(theme: string): Note[] {
  const root = (BASE / 2) * Math.pow(2, (THEME_SHIFT[theme] ?? 0) / 12);
  return [1, 1.5, 2].map((m) => ({ t: 0, f: root * m, dur: 3.6, gain: 0.05, attack: 1.2 }));
}
/** The melody: a slot every 1.8 s; a note in a slot with chance 0.35 (calm) or, at full intensity, 0.95 (the dense loop's extras). */
const SLOTS = 16, SLOT_S = 1.8;
const MEL_N = Math.round(RATE * SLOTS * SLOT_S);
const calm: Note[] = [], dense: Note[] = [];
{
  const r = new Rng(0x3e10d, "audio-variant");
  const freq = (): number => {
    const step = SCALE[r.int(0, SCALE.length - 1)]!;
    const oct = r.pick([1, 1, 2]);
    return BASE * Math.pow(2, (step + r.int(0, 2)) / 12) * oct * 2;
  };
  for (let s = 0; s < SLOTS; s++) {
    const roll = r.float();
    const note = { t: s * SLOT_S, f: freq(), dur: 0.7, gain: 0.045, attack: 0.05 };
    if (roll < 0.35) calm.push(note);
    else if (roll < 0.95) dense.push(note);
  }
}
const melA = new Float32Array(MEL_N), melB = new Float32Array(MEL_N);
let noteA = 0, noteB = 0;
function renderMelody(): boolean {
  if (noteA < calm.length) { renderNote(melA, calm[noteA++]!); return false; }
  if (noteB < dense.length) { renderNote(melB, dense[noteB++]!); return false; }
  return true;
}

let ambClip: AudioClip | null = null, aClip: AudioClip | null = null, bClip: AudioClip | null = null;
let ambVoice: Sound | null = null, aVoice: Sound | null = null, bVoice: Sound | null = null, padVoice: Sound | null = null;
let voicePadTheme = "";
const EFFECTS = 0.8, MUSIC_GAIN = 0.5 / EFFECTS, AMB_GAIN = 0.35 / EFFECTS;
let intensity = 0.3;
let wantTheme = "dawn-garden";
/** audio.js setMusicIntensity: the melody's density (0–1). */
export function setMusicIntensity(v: number): void { intensity = Math.max(0, Math.min(1, v)); }
/** audio.js startMusic(theme): the pad follows the puzzle's theme. */
export function setTheme(theme: string): void { wantTheme = THEME_SHIFT[theme] !== undefined ? theme : "dawn-garden"; }
/** audio.js setHidden: a hidden window (and the pause card) silences the room tone and music. */
export function setSuspended(on: boolean): void {
  if (on === suspended) return;
  suspended = on;
  try {
    ambVoice?.fade(on ? 0 : AMB_GAIN, 0.2);
    padVoice?.fade(on ? 0 : MUSIC_GAIN, 0.2);
    aVoice?.fade(on ? 0 : MUSIC_GAIN, 0.2);
    bVoice?.fade(on ? 0 : MUSIC_GAIN * intensity, 0.2);
  } catch { /* gone */ }
}

let lastIntensity = -1;
/** Each frame: the clips once the mixer runs (one at a time), then the room tone, the melody and the theme's pad. */
export function update(dt: number): void {
  clock += dt;
  if (bVoice && !suspended && Math.abs(intensity - lastIntensity) > 0.02) {
    lastIntensity = intensity;
    try { bVoice.fade(MUSIC_GAIN * intensity, 0.6); } catch { /* gone */ }
  }
  if (context.state !== "running") return;
  if (wantClips) {
    wantClips = false;
    for (const g of Object.values(SAMPLE_MAP)) for (const n of g) if (!queue.includes(n)) queue.push(n);
  }
  if (!loading && queue.length) {
    const name = queue.shift()!;
    if (!clips.has(name)) {
      loading = true;
      loadClip(`sfx/${name}.opus`).then((c) => { clips.set(name, c); loading = false; }, (e: unknown) => { console.warn(`sfx ${name}: ${String(e)}`); loading = false; });
    }
    return;
  }
  if (loading) return;
  if (!ambClip) {
    if (!renderAmbience(8000)) return;
    try { ambClip = createClip([amb], RATE); } catch (e) { console.warn(`audio: ${String(e)}`); ambPos = 0; }
    return;
  }
  if (!ambVoice) {
    try { ambVoice = playClip(ambClip, { bus: "music", gain: suspended ? 0 : AMB_GAIN, loop: true }); } catch { ambVoice = null; }
    return;
  }
  if (!aClip || !bClip) {
    if (!renderMelody()) return;
    try { aClip = createClip([melA], RATE); bClip = createClip([melB], RATE); } catch (e) { console.warn(`audio: ${String(e)}`); }
    return;
  }
  if (!aVoice) {
    try { aVoice = playClip(aClip, { bus: "music", gain: suspended ? 0 : MUSIC_GAIN, loop: true }); } catch { aVoice = null; }
    return;
  }
  if (!bVoice) {
    try { bVoice = playClip(bClip, { bus: "music", gain: suspended ? 0 : MUSIC_GAIN * intensity, loop: true }); } catch { bVoice = null; }
    return;
  }
  // The theme's pad: rendered once per theme (a note a frame), swapped in when the puzzle's theme changes.
  if (voicePadTheme !== wantTheme) {
    let clip = pads.get(wantTheme);
    if (!clip) {
      if (padTheme !== wantTheme || !padBuf) { padTheme = wantTheme; padBuf = new Float32Array(PAD_N); padNote = 0; }
      const notes = padNotes(wantTheme);
      if (padNote < notes.length) { renderNote(padBuf, notes[padNote++]!); return; }
      try { clip = createClip([padBuf], RATE); pads.set(wantTheme, clip); } catch (e) { console.warn(`audio: ${String(e)}`); voicePadTheme = wantTheme; return; }
      padBuf = null;
    }
    try { padVoice?.fade(0, 0.8); } catch { /* gone */ }
    const old = padVoice;
    if (old) setTimeout(() => { try { old.stop(); } catch { /* gone */ } }, 900);
    try { padVoice = playClip(clip, { bus: "music", gain: suspended ? 0 : MUSIC_GAIN, loop: true }); } catch { padVoice = null; }
    voicePadTheme = wantTheme;
  }
}
