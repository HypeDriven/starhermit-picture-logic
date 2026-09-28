// Picture Logic — graphics quality model: presets, per-category overrides,
// GPU detection and a cost summary. Pure (no three.js) so the settings panel,
// the renderer and the unit tests agree on what a setting means.
'use strict';

export const PRESETS = ['low', 'balanced', 'high', 'ultra'];

// Category → allowed tiers, cheapest first.
export const CATEGORIES = {
  shadows: ['off', 'low', 'medium', 'high'],
  ao: ['off', 'on', 'high'],
  bloom: ['off', 'on'],
  grade: ['off', 'on'],
  antialias: ['off', 'fxaa', 'smaa', 'msaa'],
  reflections: ['off', 'on'],   // image-based lighting (room environment)
  particles: ['low', 'high'],   // burst pool size + ambient mote count
  background: ['static', 'animated'], // drifting motes, flora sway, title backdrop drift
  detail: ['plain', 'detailed'],      // bevelled clear-coat cells, textured slab, light rim, flora
};

// Each preset is a row of tiers plus a render scale (multiplies the capped
// device pixel ratio) and the pixel-ratio cap itself.
const TABLE = {
  low: { scale: 1, cap: 1, shadows: 'off', ao: 'off', bloom: 'off', grade: 'off', antialias: 'off', reflections: 'off', particles: 'low', background: 'static', detail: 'plain' },
  balanced: { scale: 1, cap: 1.5, shadows: 'low', ao: 'off', bloom: 'on', grade: 'on', antialias: 'msaa', reflections: 'on', particles: 'high', background: 'animated', detail: 'detailed' },
  high: { scale: 1, cap: 2, shadows: 'medium', ao: 'on', bloom: 'on', grade: 'on', antialias: 'smaa', reflections: 'on', particles: 'high', background: 'animated', detail: 'detailed' },
  ultra: { scale: 1.25, cap: 2, shadows: 'high', ao: 'high', bloom: 'on', grade: 'on', antialias: 'msaa', reflections: 'on', particles: 'high', background: 'animated', detail: 'detailed' },
};

export const SHADOW_MAP = { off: 0, low: 1024, medium: 2048, high: 4096 };
export const PARTICLE_POOL = { low: 160, high: 640 };
export const MOTE_COUNT = { low: 40, high: 120 };

export const DEFAULT_GRAPHICS = { preset: 'auto', render_scale: 1, adaptive: true, show_fps: false };

/** Best preset for this GPU, from the unmasked renderer string when the browser exposes it. */
export function detectPreset(gpu) {
  const g = String(gpu || '').toLowerCase();
  if (/swiftshader|llvmpipe|softpipe|software|basic render|microsoft basic/.test(g)) return 'low';
  if (/nvidia|geforce|rtx|gtx|quadro|radeon rx|radeon pro|amd radeon(?! graphics)|apple m\d/.test(g)) return 'high';
  return 'balanced';
}

/** Auto choice: the detected tier, capped at Balanced on touch/mobile devices. */
export function autoPreset(gpu, mobile = false) {
  const p = detectPreset(gpu);
  return mobile && PRESETS.indexOf(p) > PRESETS.indexOf('balanced') ? 'balanced' : p;
}

/**
 * Resolve saved settings into concrete tiers.
 * `saved`: { preset: 'auto'|preset, render_scale, adaptive, show_fps, <category>: 'preset'|tier }.
 */
export function resolve(saved, detected) {
  const s = saved || {};
  const auto = !PRESETS.includes(s.preset);
  const preset = auto ? (PRESETS.includes(detected) ? detected : 'balanced') : s.preset;
  const row = TABLE[preset];
  const userScale = clamp(Number(s.render_scale) || 1, 0.5, 2);
  const out = { preset, auto, cap: row.cap, userScale, scale: row.scale * userScale };
  for (const [cat, tiers] of Object.entries(CATEGORIES)) {
    out[cat] = tiers.includes(s[cat]) ? s[cat] : row[cat];
  }
  out.adaptive = s.adaptive !== false;
  out.showFps = !!s.show_fps;
  // Post-processing runs only when something needs it; otherwise render straight to the canvas.
  out.post = out.ao !== 'off' || out.bloom === 'on' || out.grade === 'on' || out.antialias === 'fxaa' || out.antialias === 'smaa';
  // Canvas MSAA is only worth a context flag when there is no post chain to carry it.
  out.canvasMsaa = out.antialias === 'msaa' && !out.post;
  return out;
}

/** Choosing a preset clears category overrides (render scale and toggles are kept). */
export function choosePreset(saved, preset) {
  const s = { ...DEFAULT_GRAPHICS, ...(saved || {}) };
  for (const cat of Object.keys(CATEGORIES)) delete s[cat];
  s.preset = PRESETS.includes(preset) ? preset : 'auto';
  return s;
}

/** The preset's own tier for a category (for "From preset (…)" labels). */
export function presetTier(preset, cat) {
  return TABLE[preset]?.[cat];
}

const EN = {
  noShadows: 'no shadows', shadows: '{n}² shadows', ao: 'ambient occlusion', aoHigh: 'full ambient occlusion',
  bloom: 'bloom', reflections: 'reflections', noAa: 'no anti-aliasing',
};

/** One-line cost summary; `words` localizes the fragments. */
export function describe(r, pixels, words = EN) {
  const w = { ...EN, ...words };
  const parts = [
    r.shadows === 'off' ? w.noShadows : w.shadows.replace('{n}', SHADOW_MAP[r.shadows]),
    r.ao === 'off' ? null : r.ao === 'high' ? w.aoHigh : w.ao,
    r.bloom === 'on' ? w.bloom : null,
    r.reflections === 'on' ? w.reflections : null,
    r.antialias === 'off' ? w.noAa : r.antialias.toUpperCase(),
    pixels ? `${pixels[0]}×${pixels[1]} px` : null,
  ];
  return parts.filter(Boolean).join(' · ');
}

function clamp(v, a, b) {
  return Math.min(b, Math.max(a, v));
}
