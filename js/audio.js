// Picture Logic — audio engine. All sounds are original procedural
// transients synthesized with WebAudio: no samples, no external assets.
// Buses: music / effects / ambience (independent sliders). A seeded
// variant stream keeps pitch choices consistent for a given game seed.
'use strict';

import { Rng } from './prng.js';

const SCALE = [0, 3, 5, 7, 10]; // minor pentatonic — gentle, always consonant
const BASE_FREQ = 220;

export class AudioEngine {
  constructor() {
    this.ctx = null;
    this.buses = {};
    this.volumes = { music: 0.5, effects: 0.8, ambience: 0.4 };
    this.muted = false;
    this.started = false;
    this.variantRng = new Rng(1, 'audio-variant');
    this._musicTimer = null;
    this._ambNodes = null;
    this._lastEventAt = new Map(); // per-event minimum gap (double-commit guard)
  }

  // Must be called from a user gesture at least once.
  ensure() {
    if (!this.ctx) {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return false;
      this.ctx = new AC();
      const master = this.ctx.createGain();
      master.gain.value = 1;
      master.connect(this.ctx.destination);
      this.master = master;
      for (const name of ['music', 'effects', 'ambience']) {
        const g = this.ctx.createGain();
        g.gain.value = this.muted ? 0 : this.volumes[name];
        g.connect(master);
        this.buses[name] = g;
      }
    }
    if (this.ctx.state === 'suspended') this.ctx.resume();
    return true;
  }

  setSeed(seed) {
    this.variantRng = new Rng((seed ^ 0xA0D10) >>> 0, 'audio-variant');
  }

  setVolume(bus, v) {
    this.volumes[bus] = v;
    if (this.buses[bus] && !this.muted) {
      this.buses[bus].gain.setTargetAtTime(v, this.ctx.currentTime, 0.03);
    }
  }

  setMuted(m) {
    this.muted = m;
    if (!this.ctx) return;
    for (const [name, g] of Object.entries(this.buses)) {
      g.gain.setTargetAtTime(m ? 0 : this.volumes[name], this.ctx.currentTime, 0.03);
    }
  }

  // Background tabs: hard-suspend so nothing keeps sounding.
  setHidden(hidden) {
    if (!this.ctx) return;
    if (hidden) this.ctx.suspend();
    else if (this.started) this.ctx.resume();
  }

  _tone({ bus = 'effects', freq = 440, dur = 0.12, type = 'sine', gain = 0.2, attack = 0.004, slide = 0, delay = 0 }) {
    if (!this.ctx || this.muted) return;
    const t0 = this.ctx.currentTime + delay;
    const osc = this.ctx.createOscillator();
    const g = this.ctx.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(freq, t0);
    if (slide) osc.frequency.exponentialRampToValueAtTime(Math.max(30, freq + slide), t0 + dur);
    g.gain.setValueAtTime(0, t0);
    g.gain.linearRampToValueAtTime(gain, t0 + attack);
    g.gain.exponentialRampToValueAtTime(0.0008, t0 + dur);
    osc.connect(g); g.connect(this.buses[bus]);
    osc.start(t0); osc.stop(t0 + dur + 0.05);
  }

  _noise({ bus = 'effects', dur = 0.08, gain = 0.12, freq = 1800, q = 0.8, delay = 0 }) {
    if (!this.ctx || this.muted) return;
    const t0 = this.ctx.currentTime + delay;
    const len = Math.max(1, Math.floor(this.ctx.sampleRate * dur));
    const buf = this.ctx.createBuffer(1, len, this.ctx.sampleRate);
    const data = buf.getChannelData(0);
    for (let i = 0; i < len; i++) data[i] = (this.variantRng.float() * 2 - 1) * (1 - i / len);
    const src = this.ctx.createBufferSource();
    src.buffer = buf;
    const f = this.ctx.createBiquadFilter();
    f.type = 'bandpass'; f.frequency.value = freq; f.Q.value = q;
    const g = this.ctx.createGain(); g.gain.value = gain;
    src.connect(f); f.connect(g); g.connect(this.buses[bus]);
    src.start(t0);
  }

  _variant(semitoneJitter = 2) {
    const step = SCALE[this.variantRng.int(0, SCALE.length - 1)];
    const oct = this.variantRng.pick([1, 1, 2]);
    return BASE_FREQ * Math.pow(2, (step + this.variantRng.int(0, semitoneJitter)) / 12) * oct;
  }

  // Event hierarchy: ack < legal move < combo/goal < round completion.
  // Returns a text caption for meaningful audio (accessibility cue) or null.
  event(name) {
    if (!this.ctx || this.muted) return caption(name);
    const now = performance.now();
    const last = this._lastEventAt.get(name) || 0;
    if (now - last < 40) return caption(name); // idempotent double-trigger guard
    this._lastEventAt.set(name, now);
    switch (name) {
      case 'ack': this._tone({ freq: 660, dur: 0.05, type: 'triangle', gain: 0.08 }); break;
      case 'focus': this._tone({ freq: 520, dur: 0.03, type: 'sine', gain: 0.04 }); break;
      case 'fill':
        this._tone({ freq: this._variant(), dur: 0.16, type: 'triangle', gain: 0.16 });
        this._noise({ dur: 0.05, gain: 0.05, freq: 2600 });
        break;
      case 'mark': this._tone({ freq: 340, dur: 0.09, type: 'square', gain: 0.06 }); break;
      case 'clear': this._tone({ freq: 300, dur: 0.07, type: 'sine', gain: 0.06, slide: -80 }); break;
      case 'error':
        this._tone({ freq: 160, dur: 0.18, type: 'sawtooth', gain: 0.1, slide: -40 });
        this._noise({ dur: 0.1, gain: 0.08, freq: 400, q: 1.5 });
        break;
      case 'line': // a row/column resolved
        this._tone({ freq: this._variant() * 1.5, dur: 0.2, type: 'triangle', gain: 0.14 });
        this._tone({ freq: this._variant() * 2, dur: 0.24, type: 'sine', gain: 0.1, delay: 0.07 });
        break;
      case 'hint': this._tone({ freq: 880, dur: 0.22, type: 'sine', gain: 0.1, slide: 220 }); break;
      case 'undo': this._tone({ freq: 420, dur: 0.1, type: 'triangle', gain: 0.08, slide: -120 }); break;
      case 'pause': this._tone({ freq: 240, dur: 0.12, type: 'sine', gain: 0.08 }); break;
      case 'win': {
        const steps = [0, 7, 12, 19, 24];
        steps.forEach((s, i) => this._tone({
          freq: BASE_FREQ * Math.pow(2, s / 12), dur: 0.5, type: 'triangle',
          gain: 0.14, delay: i * 0.09, bus: 'effects',
        }));
        this._noise({ dur: 0.5, gain: 0.05, freq: 5200, delay: 0.2 });
        break;
      }
      case 'fail':
        [12, 7, 3, 0].forEach((s, i) => this._tone({
          freq: BASE_FREQ * Math.pow(2, s / 12) / 2, dur: 0.4, type: 'sine', gain: 0.12, delay: i * 0.12,
        }));
        break;
      case 'tick': this._tone({ freq: 990, dur: 0.03, type: 'sine', gain: 0.03 }); break;
      case 'countdown': this._tone({ freq: 700, dur: 0.09, type: 'triangle', gain: 0.1 }); break;
    }
    return caption(name);
  }

  startMusic(themeId = 'dawn-garden') {
    if (!this.ensure()) return;
    this.started = true;
    this.stopMusic();
    // Adaptive two-stem loop: a slow pad plus a sparse seeded melody whose
    // density is raised by setMusicIntensity(0..1).
    this._intensity = this._intensity ?? 0.3;
    const themeShift = { 'dawn-garden': 0, 'tide-glass': -2, 'ember-night': -4, 'moss-archive': 3, 'snow-signal': 5 }[themeId] ?? 0;
    const pad = () => {
      if (!this.ctx || this.muted) return;
      const root = BASE_FREQ / 2 * Math.pow(2, themeShift / 12);
      [1, 1.5, 2].forEach(m => this._tone({ bus: 'music', freq: root * m, dur: 3.6, type: 'sine', gain: 0.05, attack: 1.2 }));
    };
    const melody = () => {
      if (this.ctx && !this.muted && this.variantRng.float() < 0.35 + this._intensity * 0.6) {
        this._tone({ bus: 'music', freq: this._variant() * 2, dur: 0.7, type: 'sine', gain: 0.045, attack: 0.05 });
      }
    };
    pad(); melody();
    this._musicTimer = setInterval(() => { pad(); }, 7200);
    this._melodyTimer = setInterval(melody, 1800);
  }

  setMusicIntensity(v) { this._intensity = Math.max(0, Math.min(1, v)); }

  stopMusic() {
    if (this._musicTimer) { clearInterval(this._musicTimer); this._musicTimer = null; }
    if (this._melodyTimer) { clearInterval(this._melodyTimer); this._melodyTimer = null; }
  }

  startAmbience() {
    if (!this.ensure() || this._ambNodes) return;
    // Quiet filtered-noise room tone.
    const len = this.ctx.sampleRate * 2;
    const buf = this.ctx.createBuffer(1, len, this.ctx.sampleRate);
    const data = buf.getChannelData(0);
    let v = 0;
    for (let i = 0; i < len; i++) { v = v * 0.98 + (Math.random() * 2 - 1) * 0.02; data[i] = v * 8; }
    const src = this.ctx.createBufferSource();
    src.buffer = buf; src.loop = true;
    const f = this.ctx.createBiquadFilter();
    f.type = 'lowpass'; f.frequency.value = 320;
    const g = this.ctx.createGain(); g.gain.value = 0.5;
    src.connect(f); f.connect(g); g.connect(this.buses.ambience);
    src.start();
    this._ambNodes = { src, g };
  }

  stopAmbience() {
    if (this._ambNodes) { try { this._ambNodes.src.stop(); } catch { /* already stopped */ } this._ambNodes = null; }
  }
}

function caption(name) {
  return {
    fill: 'Cell lit', mark: 'Cell crossed', clear: 'Mark cleared',
    error: 'That cell is empty — mistake counted', line: 'Line complete',
    hint: 'Hint revealed a cell', win: 'Puzzle complete', fail: 'Attempt ended',
    undo: 'Move undone', pause: 'Paused', countdown: 'Get ready',
  }[name] ?? null;
}
