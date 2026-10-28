// The look per graphics level: the browser build's four presets and budgets
// (js/gfx.js TABLE / BUDGETS, each tuned to hold 60 FPS on the weakest GPU
// its Auto gave it) keyed by the runtime's quality tier (frame().quality),
// with the spark pool and the ambient motes scaled within the tier by the
// level (frame().levelIndex, at most 2×), as the browser build scaled them
// by its hardware level. The runtime owns the rest of what the old Graphics
// panel did: Auto and the level choice, render scale and the pixel-ratio
// cap, adaptive resolution, the frame-rate limit and readout. The old
// panel's per-effect overrides are not offered (the runtime's Options choose
// a level).
import type { QualityTier } from "starhermit:engine";
import type { AntialiasMode } from "starhermit:scene";

export interface Budget {
  /** Cell shading with Board detail on: Lambert (Low), Standard (Balanced), clear-coated Physical (High/Ultra). */
  material: "lambert" | "standard" | "physical";
  /** Rounded-cell bevel segments. */
  bevel: number;
  /** Slab grain texture size in px. */
  grain: number;
  /** Flora pieces ringing the board (Board detail on; plain 3). */
  flora: number;
  /** Burst pool / ambient motes at Particles high. */
  sparks: number;
  motes: number;
  /** Bloom / GTAO resolution (fraction of the frame). */
  bloomRes: number;
  aoRes: number;
}
export interface Look {
  preset: QualityTier;
  /** Key-light shadow map size (0 = off). */
  shadows: 0 | 1024 | 2048 | 4096;
  ao: "off" | "on" | "high";
  bloom: boolean;
  grade: boolean;
  antialias: AntialiasMode;
  /** Image-based lighting (RoomEnvironment). */
  reflections: boolean;
  particles: "low" | "high";
  /** Ambient motion: drifting motes, flora sway, the title backdrop's drift. */
  ambient: boolean;
  /** Board detail Detailed: bevelled clear-coat cells, grained slab, light rim, ground pool, more flora. */
  detailed: boolean;
  budget: Budget;
}

/** gfx.js TABLE. */
const TABLE: Record<QualityTier, Omit<Look, "preset" | "budget">> = {
  low: { shadows: 0, ao: "off", bloom: false, grade: false, antialias: "off", reflections: false, particles: "low", ambient: false, detailed: false },
  balanced: { shadows: 1024, ao: "off", bloom: true, grade: true, antialias: "msaa", reflections: true, particles: "high", ambient: true, detailed: true },
  high: { shadows: 2048, ao: "on", bloom: true, grade: true, antialias: "smaa", reflections: true, particles: "high", ambient: true, detailed: true },
  ultra: { shadows: 4096, ao: "high", bloom: true, grade: true, antialias: "msaa", reflections: true, particles: "high", ambient: true, detailed: true },
};
/** gfx.js BUDGETS. */
const BUDGETS: Record<QualityTier, Budget> = {
  low: { material: "lambert", bevel: 2, grain: 128, flora: 3, sparks: 160, motes: 40, bloomRes: 0.5, aoRes: 0.5 },
  balanced: { material: "standard", bevel: 2, grain: 256, flora: 8, sparks: 400, motes: 80, bloomRes: 0.5, aoRes: 0.5 },
  high: { material: "physical", bevel: 3, grain: 256, flora: 12, sparks: 640, motes: 120, bloomRes: 0.5, aoRes: 0.5 },
  ultra: { material: "physical", bevel: 4, grain: 512, flora: 18, sparks: 960, motes: 180, bloomRes: 1, aoRes: 1 },
};
/** The first level index of each tier. */
const TIER_FLOOR: Record<QualityTier, number> = { low: 0, balanced: 2, high: 4, ultra: 7 };
export const SPARK_MAX = 1920, MOTE_MAX = 360;
/** gfx.js PARTICLE_POOL.low / MOTE_COUNT.low (Particles low). */
const LOW_POOL = 160, LOW_MOTES = 40;

/** The look for a quality tier at a level index (0 … 9). */
export function lookFor(preset: QualityTier, levelIndex: number): Look {
  const b = { ...BUDGETS[preset] };
  // Levels are about 1.64× apart in GPU throughput: budgets grow with the level above the tier's first, at most 2×.
  const k = Math.min(2, Math.pow(1.64, Math.max(0, levelIndex - TIER_FLOOR[preset])));
  b.sparks = Math.min(SPARK_MAX, Math.round(b.sparks * k));
  b.motes = Math.min(MOTE_MAX, Math.round(b.motes * k));
  return { preset, ...TABLE[preset], budget: b };
}
/** gfx.js particleCounts: the live burst pool and mote count. */
export function particleCounts(l: Look): { pool: number; motes: number } {
  return l.particles === "high" ? { pool: l.budget.sparks, motes: l.budget.motes }
    : { pool: Math.min(LOW_POOL, l.budget.sparks), motes: Math.min(LOW_MOTES, l.budget.motes) };
}
