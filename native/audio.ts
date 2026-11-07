// Sound, as the browser build's js/audio.js: the authored one-shots
// (sfx/<name>.opus) per game event, a SoundBank per event (a random variant,
// with the 40 ms double-trigger guard); the quiet room tone (looped noise
// lowpassed at 320 Hz) and the adaptive music (a slow three-sine pad every
// 7.2 s, rooted by the puzzle's theme, and a sparse pentatonic melody every
// 1.8 s whose density follows the board's progress). They are rendered once
// by OfflineAudioContext, one context a stem, and looped on the music bus —
// the melody's extra notes for a busy board are a second loop faded in by the
// intensity — as the runtime has no ambience bus. The browser build's bus
// levels (music 0.5 and ambience 0.35 against effects 0.8) are the voices'
// gains. The runtime's Options own the volumes, the mute and the voice limit.
// Clips load and stems render at once in onStart; the voices wait for the
// mixer (natively at once, in a browser after the first press). A cue whose
// clips are still loading is silent.
import { OfflineAudioContext, context, createClip, loadClip, play as playClip, SoundBank, type AudioClip, type Sound } from "starhermit:audio";
import { Rng } from "./game.ts";

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

const banks = new Map<string, SoundBank>();
let suspended = false;

/** Loads every clip and renders the stems at once (onStart). */
export function loadSfx(): void {
  for (const [event, names] of Object.entries(SAMPLE_MAP)) {
    void Promise.all(names.map((name) => loadClip(`sfx/${name}.opus`).catch((e: unknown) => { console.warn(`sfx ${name}: ${String(e)}`); return null; }))).then((loaded) => {
      const list = loaded.filter((c) => c !== null);
      if (list.length) banks.set(event, new SoundBank({ clips: list, bus: "effects", minGap: 0.04 }));
    });
  }
  renderStem(renderAmbience, (c) => { ambClip = c; });
  renderStem(() => renderNotes(MEL_S, calm), (c) => { aClip = c; });
  renderStem(() => renderNotes(MEL_S, dense), (c) => { bClip = c; });
}

/** audio.js event(): one clip of the event's group (none within 40 ms of the last). */
export function event(name: Sfx): void {
  if (suspended) return;
  try { banks.get(name)?.play(); } catch { /* the mixer is full this frame: skip it */ }
}

// -- the room tone and the music ------------------------------------------------------------------
const RATE = 22050;
/** Makes the biquads' level the old two one-poles' (rms 0.200). */
const AMB_MAKEUP = 3.153;
/** audio.js startAmbience: noise through v = 0.98 v + … (about 71 Hz), then the 320 Hz lowpass; periodic once settled, so the loop joins. */
async function renderAmbience(): Promise<AudioClip> {
  const n = 2 * RATE, settle = Math.round(0.25 * RATE);
  const off = new OfflineAudioContext(1, settle + n, RATE);
  const noise = off.createNoise({ seed: 24680, seconds: 2 });
  const lp1 = off.createBiquadFilter(); lp1.type = "lowpass"; lp1.frequency.value = 71;
  const lp2 = off.createBiquadFilter(); lp2.type = "lowpass"; lp2.frequency.value = 320;
  const g = off.createGain(); g.gain.value = AMB_MAKEUP;
  noise.connect(lp1).connect(lp2).connect(g).connect(off.destination); noise.start();
  const r = await off.startRendering();
  return createClip([r.getChannelData(0).slice(settle)], RATE);
}

const BASE = 220;
const SCALE = [0, 3, 5, 7, 10];
const THEME_SHIFT: Record<string, number> = { "dawn-garden": 0, "tide-glass": -2, "ember-night": -4, "moss-archive": 3, "snow-signal": 5 };
interface Note { t: number; f: number; dur: number; gain: number; attack: number }
/** audio.js _tone: linear attack, exponential decay to 0.0008 by `dur`; one context a stem. */
async function renderNotes(seconds: number, notes: readonly Note[]): Promise<AudioClip> {
  const off = new OfflineAudioContext(1, Math.round(seconds * RATE), RATE);
  for (const n of notes) {
    const o = off.createOscillator(); o.frequency.value = n.f;
    const g = off.createGain();
    g.gain.setValueAtTime(0, n.t);
    g.gain.linearRampToValueAtTime(n.gain, n.t + n.attack);
    g.gain.exponentialRampToValueAtTime(0.0008, n.t + n.dur);
    o.connect(g).connect(off.destination);
    o.start(n.t); o.stop(n.t + n.dur + 0.05);
  }
  return createClip(await off.startRendering());
}
function renderStem(render: () => Promise<AudioClip>, done: (c: AudioClip) => void): void {
  render().then(done, (e: unknown) => console.warn(`audio: ${String(e)}`));
}
/** The pad: three sines on the theme's root, 1.2 s attack, 3.6 s long, once per 7.2 s loop. */
const PAD_S = 7.2;
const pads = new Map<string, AudioClip>();
const padsAsked = new Set<string>();
function padNotes(theme: string): Note[] {
  const root = (BASE / 2) * Math.pow(2, (THEME_SHIFT[theme] ?? 0) / 12);
  return [1, 1.5, 2].map((m) => ({ t: 0, f: root * m, dur: 3.6, gain: 0.05, attack: 1.2 }));
}
/** The melody: a slot every 1.8 s; a note in a slot with chance 0.35 (calm) or, at full intensity, 0.95 (the dense loop's extras). */
const SLOTS = 16, SLOT_S = 1.8;
const MEL_S = SLOTS * SLOT_S;
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
/** Each frame: once the mixer runs, the room tone, the melody and the theme's pad as their stems are ready. */
export function update(): void {
  if (bVoice && !suspended && Math.abs(intensity - lastIntensity) > 0.02) {
    lastIntensity = intensity;
    try { bVoice.fade(MUSIC_GAIN * intensity, 0.6); } catch { /* gone */ }
  }
  if (context.state !== "running") return;
  if (ambClip && !ambVoice) {
    try { ambVoice = playClip(ambClip, { bus: "music", gain: suspended ? 0 : AMB_GAIN, loop: true }); } catch { ambVoice = null; }
  }
  if (aClip && !aVoice) {
    try { aVoice = playClip(aClip, { bus: "music", gain: suspended ? 0 : MUSIC_GAIN, loop: true }); } catch { aVoice = null; }
  }
  if (bClip && !bVoice) {
    try { bVoice = playClip(bClip, { bus: "music", gain: suspended ? 0 : MUSIC_GAIN * intensity, loop: true }); } catch { bVoice = null; }
  }
  // The theme's pad: rendered once per theme, swapped in when the puzzle's theme changes.
  if (voicePadTheme !== wantTheme) {
    const theme = wantTheme, clip = pads.get(theme);
    if (!clip) {
      if (!padsAsked.has(theme)) {
        padsAsked.add(theme);
        renderStem(() => renderNotes(PAD_S, padNotes(theme)), (c) => { pads.set(theme, c); });
      }
      return;
    }
    try { padVoice?.fade(0, 0.8); } catch { /* gone */ }
    const old = padVoice;
    if (old) setTimeout(() => { try { old.stop(); } catch { /* gone */ } }, 900);
    try { padVoice = playClip(clip, { bus: "music", gain: suspended ? 0 : MUSIC_GAIN, loop: true }); } catch { padVoice = null; }
    voicePadTheme = theme;
  }
}
