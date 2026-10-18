// Picture Logic — graphics quality model tests (node --test tests/gfx.test.mjs)
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
// js/gpu-level.js is a classic script in the page (window.StarHermitGpu); evaluate it the same way here.
new Function('window', 'module', readFileSync(new URL('../js/gpu-level.js', import.meta.url), 'utf8'))(globalThis, undefined);
const {
  PRESETS, CATEGORIES, LEVELS, BUDGETS, SPARK_MAX, MOTE_MAX, detectPreset, detectLevel, presetForLevel, autoPreset, budgetFor, particleCounts,
  resolve, choosePreset, presetTier, describe, DEFAULT_GRAPHICS,
} = await import('../js/gfx.js');
const { GFX_STRINGS, gfxLocale } = await import('../js/gfx-strings.js');
const { migrateGraphics } = await import('../js/store.js');

const DESK = { cores: 8, memoryGb: 8 };
const PHONE = { mobile: true, cores: 8, memoryGb: 8 };

test('hardware level picks the Auto preset (Low 0, Balanced 4, High 10, Ultra 17)', () => {
  assert.equal(detectPreset('ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device (Subzero) (0x0000C0DE)), SwiftShader driver)', DESK), 'low');
  assert.equal(detectLevel('llvmpipe (LLVM 15.0.7, 256 bits)', DESK), 0);
  assert.equal(detectPreset('', DESK), 'low', 'no WebGL');
  assert.equal(detectPreset('ANGLE (AMD, AMD Radeon(TM) Graphics Direct3D11 vs_5_0 ps_5_0, D3D11)', DESK), 'low');
  assert.equal(detectPreset('ANGLE (Intel, Intel(R) UHD Graphics 620 Direct3D11 vs_5_0 ps_5_0, D3D11)', DESK), 'low');
  assert.equal(detectPreset('ANGLE (Intel, Intel(R) Iris(R) Xe Graphics Direct3D11)', DESK), 'balanced');
  assert.equal(detectPreset('ANGLE (NVIDIA, NVIDIA GeForce GTX 1070 Direct3D11 vs_5_0 ps_5_0)', DESK), 'high');
  assert.equal(detectPreset('ANGLE (NVIDIA, NVIDIA GeForce RTX 4080 Direct3D11 vs_5_0 ps_5_0)', DESK), 'ultra');
  assert.equal(detectLevel('ANGLE (NVIDIA, NVIDIA GeForce RTX 5090 Direct3D11 vs_5_0 ps_5_0)', DESK), 20);
  assert.equal(detectPreset('ANGLE (NVIDIA, NVIDIA GeForce RTX 5090 Direct3D11 vs_5_0 ps_5_0)', DESK), 'ultra');
  for (const [p, lv] of Object.entries(LEVELS)) assert.equal(presetForLevel(lv), p);
  assert.equal(presetForLevel(3), 'low');
  assert.equal(presetForLevel(16), 'high');
});

test('phones and tablets are Balanced at most; software GPUs stay Low', () => {
  assert.equal(detectPreset('Adreno (TM) 740', PHONE), 'balanced');
  assert.ok(detectLevel('Adreno (TM) 740', PHONE) <= 9);
  assert.equal(autoPreset('Apple M2', true), 'balanced');
  assert.equal(autoPreset('SwiftShader', true), 'low');
});

test('per-preset budgets are explicit, grow from Low to Ultra and scale with the level', () => {
  const keys = ['material', 'bevel', 'grain', 'flora', 'sparks', 'motes', 'bloomRes', 'aoRes'];
  for (const p of PRESETS) for (const k of keys) assert.ok(BUDGETS[p][k] != null, `${p}.${k}`);
  for (let i = 1; i < PRESETS.length; i++) for (const k of keys) {
    if (typeof BUDGETS.low[k] === 'number') assert.ok(BUDGETS[PRESETS[i]][k] >= BUDGETS[PRESETS[i - 1]][k], `${PRESETS[i]}.${k}`);
  }
  assert.deepEqual(PRESETS.map((p) => BUDGETS[p].material), ['lambert', 'standard', 'physical', 'physical']);
  assert.deepEqual(PRESETS.map((p) => BUDGETS[p].bloomRes), [0.5, 0.5, 0.5, 1], 'half-res bloom below Ultra');
  assert.deepEqual(resolve({ preset: 'high' }, 'low', 10).budget, BUDGETS.high, 'floor level = the tuned budget');
  assert.deepEqual(resolve({ preset: 'ultra' }, 'low', 0).budget, resolve({ preset: 'ultra' }, 'ultra', 17).budget);
  assert.ok(budgetFor('balanced', 9).motes > budgetFor('balanced', 4).motes, 'counts scale up within the preset');
  assert.ok(budgetFor('ultra', 20).sparks <= SPARK_MAX && budgetFor('ultra', 20).motes <= MOTE_MAX);
  assert.deepEqual(particleCounts(resolve({ preset: 'high' }, 'low', 10)), { pool: 640, motes: 120 });
  assert.deepEqual(particleCounts(resolve({ preset: 'low' }, 'low', 0)), { pool: 160, motes: 40 }, 'Low: particles low');
  assert.equal(resolve({}, 'low', 0).budget.material, 'lambert', 'headless SwiftShader: Low, Lambert');
});

test('resolve: auto uses the detected preset; explicit presets win', () => {
  const a = resolve({ preset: 'auto' }, 'low');
  assert.equal(a.preset, 'low');
  assert.equal(a.auto, true);
  assert.equal(a.post, false, 'Low renders without a post chain');
  assert.equal(a.cap, 1);
  const u = resolve({ preset: 'ultra' }, 'low');
  assert.equal(u.preset, 'ultra');
  assert.equal(u.auto, false);
  assert.equal(u.shadows, 'high');
  assert.equal(u.post, true);
  for (const p of PRESETS) {
    const r = resolve({ preset: p }, 'low');
    for (const [cat, tiers] of Object.entries(CATEGORIES)) {
      assert.ok(tiers.includes(r[cat]), `${p}.${cat} is a valid tier`);
      assert.equal(presetTier(p, cat), r[cat]);
    }
  }
});

test('resolve: category overrides and invalid values', () => {
  const r = resolve({ preset: 'low', bloom: 'on', shadows: 'bogus' }, 'high');
  assert.equal(r.bloom, 'on');
  assert.equal(r.shadows, 'off', 'invalid override falls back to the preset tier');
  assert.equal(r.post, true, 'bloom needs the post chain');
  const m = resolve({ preset: 'low', antialias: 'msaa' }, 'low');
  assert.equal(m.canvasMsaa, true, 'MSAA without post uses the canvas context flag');
});

test('resolve: render scale is clamped to 50–200%', () => {
  assert.equal(resolve({ preset: 'high', render_scale: 5 }, 'low').scale, 2);
  assert.equal(resolve({ preset: 'high', render_scale: 0.1 }, 'low').scale, 0.5);
  assert.equal(resolve({ preset: 'ultra', render_scale: 1 }, 'low').scale, 1.25);
  assert.equal(resolve({ preset: 'high' }, 'low').adaptive, true);
  assert.equal(resolve({ preset: 'high', adaptive: false, show_fps: true }, 'low').showFps, true);
});

test('choosePreset clears category overrides but keeps scale and toggles', () => {
  const saved = { preset: 'high', bloom: 'off', detail: 'plain', render_scale: 1.5, show_fps: true };
  const next = choosePreset(saved, 'low');
  assert.equal(next.preset, 'low');
  assert.equal(next.bloom, undefined);
  assert.equal(next.detail, undefined);
  assert.equal(next.render_scale, 1.5);
  assert.equal(next.show_fps, true);
  assert.equal(choosePreset(saved, 'nonsense').preset, 'auto');
});

test('describe summarises cost', () => {
  const s = describe(resolve({ preset: 'high' }, 'low'), [1280, 720]);
  assert.match(s, /2048² shadows/);
  assert.match(s, /SMAA/);
  assert.match(s, /1280×720 px/);
  assert.match(describe(resolve({ preset: 'low' }, 'low')), /no shadows · no anti-aliasing/);
});

test('old graphics tier migrates to a preset', () => {
  assert.equal(migrateGraphics({ quality: 'medium', graphics: { ...DEFAULT_GRAPHICS } }).graphics.preset, 'balanced');
  const s = migrateGraphics({ quality: 'high', graphics: { ...DEFAULT_GRAPHICS } });
  assert.equal(s.graphics.preset, 'high');
  assert.equal('quality' in s, false);
  assert.equal(migrateGraphics({ quality: 'auto' }).graphics.preset, 'auto');
});

test('every locale has every graphics string', () => {
  const need = ['en-US', 'en-GB', 'es-419', 'es-ES', 'de-DE', 'fr-FR', 'fr-CA', 'pt-BR', 'it-IT'];
  const en = GFX_STRINGS['en-US'];
  for (const loc of need) {
    const t = GFX_STRINGS[loc];
    assert.ok(t, loc);
    for (const k of Object.keys(en)) {
      assert.ok(t[k], `${loc}.${k}`);
      if (typeof en[k] === 'object') for (const kk of Object.keys(en[k])) assert.ok(t[k][kk], `${loc}.${k}.${kk}`);
    }
    for (const p of PRESETS) assert.ok(t.tier[p]);
    for (const [cat, tiers] of Object.entries(CATEGORIES)) {
      assert.ok(t.cat[cat], `${loc} cat ${cat}`);
      for (const v of tiers) assert.ok(t.val[v], `${loc} val ${v}`);
    }
  }
  assert.equal(gfxLocale('fr-CA'), 'fr-CA');
  assert.equal(gfxLocale('es-MX'), 'es-419');
  assert.equal(gfxLocale('en-AU'), 'en-GB');
  assert.equal(gfxLocale('ja-JP'), 'en-US');
});
