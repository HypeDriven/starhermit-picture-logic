// Picture Logic — graphics quality model tests (node --test tests/gfx.test.mjs)
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  PRESETS, CATEGORIES, detectPreset, autoPreset, resolve, choosePreset, presetTier, describe, DEFAULT_GRAPHICS,
} from '../js/gfx.js';
import { GFX_STRINGS, gfxLocale } from '../js/gfx-strings.js';
import { migrateGraphics } from '../js/store.js';

test('detectPreset maps GPU strings to tiers', () => {
  assert.equal(detectPreset('ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device (Subzero)), SwiftShader driver)'), 'low');
  assert.equal(detectPreset('llvmpipe (LLVM 15.0.7, 256 bits)'), 'low');
  assert.equal(detectPreset('ANGLE (NVIDIA, NVIDIA GeForce RTX 3070 Direct3D11 vs_5_0 ps_5_0)'), 'high');
  assert.equal(detectPreset('Apple M2'), 'high');
  assert.equal(detectPreset('ANGLE (Intel, Intel(R) UHD Graphics 620 Direct3D11)'), 'balanced');
  assert.equal(detectPreset('Adreno (TM) 650'), 'balanced');
  assert.equal(detectPreset(''), 'balanced');
});

test('autoPreset caps touch/mobile devices at balanced', () => {
  assert.equal(autoPreset('Apple M2', true), 'balanced');
  assert.equal(autoPreset('Apple M2', false), 'high');
  assert.equal(autoPreset('SwiftShader', true), 'low');
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
