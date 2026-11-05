// The look per graphics level. The engine's level (levelSettings()) owns the
// effects: shadow map, AO, bloom, grade and anti-aliasing. The browser build's
// art per preset (js/gfx.js TABLE / BUDGETS: materials, bevel, grain, flora,
// detail) stays keyed by the quality tier, with the spark pool and the ambient
// motes scaled by the level's particle budget against the tier's anchor level
// (at most 2×) and the grain texture held to the level's maximum. The runtime
// owns the rest of what the old Graphics panel did: Auto and the level choice,
// render scale and the pixel-ratio cap, adaptive resolution, the frame-rate
// limit and readout. The old panel's per-effect overrides are not offered (the
// runtime's Options choose a level).
import { levelSettings, type GraphicsLevel, type LevelSettings, type QualityTier } from "starhermit:engine";
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
}
export interface Look {
  preset: QualityTier;
  /** Key-light shadow map: the level's size (0 = off). */
  shadows: number;
  ao: { resolution: number; samples: number; denoiseSamples: number } | null;
  /** The level's bloom resolution (null = off). */
  bloom: number | null;
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

/** gfx.js TABLE, without the effects. */
type Art = Omit<Look, "preset" | "budget" | "shadows" | "ao" | "bloom" | "grade" | "antialias">;
const ART: Record<QualityTier, Art> = {
  low: { reflections: false, particles: "low", ambient: false, detailed: false },
  balanced: { reflections: true, particles: "high", ambient: true, detailed: true },
  high: { reflections: true, particles: "high", ambient: true, detailed: true },
  ultra: { reflections: true, particles: "high", ambient: true, detailed: true },
};
/** gfx.js BUDGETS. */
const BUDGETS: Record<QualityTier, Budget> = {
  low: { material: "lambert", bevel: 2, grain: 128, flora: 3, sparks: 160, motes: 40 },
  balanced: { material: "standard", bevel: 2, grain: 256, flora: 8, sparks: 400, motes: 80 },
  high: { material: "physical", bevel: 3, grain: 256, flora: 12, sparks: 640, motes: 120 },
  ultra: { material: "physical", bevel: 4, grain: 512, flora: 18, sparks: 960, motes: 180 },
};
/** The level whose particle budget is each tier's own. */
const ANCHOR: Record<QualityTier, GraphicsLevel> = { low: "quantum", balanced: "molecular", high: "terrestrial", ultra: "galactic" };
export const SPARK_MAX = 1920, MOTE_MAX = 360;
/** gfx.js PARTICLE_POOL.low / MOTE_COUNT.low (Particles low). */
const LOW_POOL = 160, LOW_MOTES = 40;

/** The look at a graphics level. Plain data: applyLook compares it by JSON. */
export function lookFor(s: LevelSettings = levelSettings()): Look {
  const preset = s.quality;
  const b = { ...BUDGETS[preset] };
  const k = Math.min(2, s.particles / levelSettings(ANCHOR[preset]).particles);
  b.sparks = Math.min(SPARK_MAX, Math.round(b.sparks * k));
  b.motes = Math.min(MOTE_MAX, Math.round(b.motes * k));
  b.grain = Math.min(b.grain, s.maxTextureSize);
  return {
    preset, ...ART[preset],
    shadows: s.shadows ? s.shadowMapSize : 0,
    ao: s.ao && { resolution: s.ao.resolution, samples: s.ao.samples, denoiseSamples: s.ao.denoiseSamples },
    bloom: s.bloom ? s.bloom.resolution : null,
    grade: s.grade,
    antialias: s.antialias,
    budget: b,
  };
}
/** gfx.js particleCounts: the live burst pool and mote count. */
export function particleCounts(l: Look): { pool: number; motes: number } {
  return l.particles === "high" ? { pool: l.budget.sparks, motes: l.budget.motes }
    : { pool: Math.min(LOW_POOL, l.budget.sparks), motes: Math.min(LOW_MOTES, l.budget.motes) };
}
