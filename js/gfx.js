// Picture Logic — graphics quality model: presets, per-category overrides,
// StarHermit hardware-level detection, per-preset budgets and a cost summary. Pure (no three.js) so the settings panel,
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

// Auto picks the preset from the StarHermit hardware level (0 = Galaxy S20 / Intel UHD or weaker, 20 = RTX
// 5090; js/gpu-level.js → window.StarHermitGpu, a classic script loaded before the game): Low from 0,
// Balanced from 4, High from 10, Ultra from 17. Phones, tablets and ≤ 4 GB machines are capped at level 9.
export const LEVELS = { low: 0, balanced: 4, high: 10, ultra: 17 };
const gpuApi = () => globalThis.StarHermitGpu;

/** Hardware level 0–20 for an unmasked renderer string plus StarHermitGpu.detectSystem() facts. */
export function detectLevel(gpu, system) {
  const G = gpuApi();
  const sys = { webgl: true, webgl2: true, ...(system || {}), gpu: String(gpu || '') };
  if (!gpu) sys.webgl = false; // no renderer string: no usable WebGL
  return G ? G.detectLevel(sys) : (gpu ? LEVELS.balanced : 0);
}

/** The preset Auto starts from for a hardware level. */
export function presetForLevel(level) {
  const G = gpuApi();
  return G ? G.presetForLevel(level, LEVELS) : PRESETS.filter((p) => LEVELS[p] <= level).pop() || 'low';
}

/** Best preset for this GPU (the hardware level already caps phones/tablets at Balanced). */
export function detectPreset(gpu, system) {
  return presetForLevel(detectLevel(gpu, system));
}

/** Auto choice for a renderer string and device facts (`mobile` caps the level at 9 → Balanced). */
export function autoPreset(gpu, system) {
  return detectPreset(gpu, typeof system === 'boolean' ? { mobile: system } : system);
}

/*
 * Per-preset asset and effect budget. Each preset holds 60 FPS on the weakest GPU Auto gives it (Low →
 * level 0, Balanced → 4, High → 10, Ultra → 17; measured with tests/gfx-bench.mjs). Board, clues, cell
 * hit areas and rules are identical on every preset — only visuals change.
 *   material  cell shading: lambert (Low) / standard (Balanced) / clear-coated physical (High, Ultra;
 *             Board detail on — plain cells are Standard, Lambert on Low)
 *   bevel     rounded-cell bevel segments (Board detail on)
 *   grain     slab grain texture size in px (Board detail on)
 *   flora     flora pieces ringing the board (Board detail on; plain: 3)
 *   sparks    burst pool at Particles high (low: ≤ 160), scaled with the level
 *   motes     ambient motes at Particles high (low: ≤ 40), scaled with the level
 *   bloomRes / aoRes  bloom and GTAO resolution as a fraction of the frame
 */
export const BUDGETS = {
  low: { material: 'lambert', bevel: 2, grain: 128, flora: 3, sparks: 160, motes: 40, bloomRes: 0.5, aoRes: 0.5 },
  balanced: { material: 'standard', bevel: 2, grain: 256, flora: 8, sparks: 400, motes: 80, bloomRes: 0.5, aoRes: 0.5 },
  high: { material: 'physical', bevel: 3, grain: 256, flora: 12, sparks: 640, motes: 120, bloomRes: 0.5, aoRes: 0.5 },
  ultra: { material: 'physical', bevel: 4, grain: 512, flora: 18, sparks: 960, motes: 180, bloomRes: 1, aoRes: 1 },
};
export const SPARK_MAX = 1920;
export const MOTE_MAX = 360;

/** A preset's concrete budget for a hardware level (spark and mote counts scale ≤ 2× within the preset). */
export function budgetFor(preset, level) {
  const b = { ...(BUDGETS[preset] || BUDGETS.balanced) };
  const G = gpuApi(), floor = LEVELS[preset] || 0;
  const lv = Math.max(Number.isFinite(level) ? level : floor, floor);
  const k = G ? Math.min(2, G.scaleBudget(1, lv, floor)) : 1;
  b.sparks = Math.min(SPARK_MAX, Math.round(b.sparks * k));
  b.motes = Math.min(MOTE_MAX, Math.round(b.motes * k));
  return b;
}

/** Live burst-pool and mote counts for a resolved setting (Particles tier within the preset's budget). */
export function particleCounts(r) {
  const b = r.budget;
  return r.particles === 'high' ? { pool: b.sparks, motes: b.motes }
    : { pool: Math.min(PARTICLE_POOL.low, b.sparks), motes: Math.min(MOTE_COUNT.low, b.motes) };
}

/**
 * Resolve saved settings into concrete tiers.
 * `saved`: { preset: 'auto'|preset, render_scale, adaptive, show_fps, <category>: 'preset'|tier }.
 */
export function resolve(saved, detected, level) {
  const s = saved || {};
  const auto = !PRESETS.includes(s.preset);
  const preset = auto ? (PRESETS.includes(detected) ? detected : 'balanced') : s.preset;
  const row = TABLE[preset];
  const userScale = clamp(Number(s.render_scale) || 1, 0.5, 2);
  const out = { preset, auto, cap: row.cap, userScale, scale: row.scale * userScale };
  for (const [cat, tiers] of Object.entries(CATEGORIES)) {
    out[cat] = tiers.includes(s[cat]) ? s[cat] : row[cat];
  }
  out.level = Number.isFinite(level) ? level : LEVELS[preset];
  out.budget = budgetFor(preset, out.level);
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
