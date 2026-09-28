// Picture Logic — Three.js presentation layer.
// A minimalist light-board that blooms into a tiny scene. Rendering consumes
// immutable snapshots plus events; it never mutates rules state. Layers:
// environment / gameplay cells / selection+ghosts / effects / UI anchors.
'use strict';

import * as THREE from './vendor/three.module.js';
// Post-processing / IBL addons vendored from the same three.js release (r160).
import { EffectComposer } from './vendor/addons/postprocessing/EffectComposer.js';
import { RenderPass } from './vendor/addons/postprocessing/RenderPass.js';
import { ShaderPass } from './vendor/addons/postprocessing/ShaderPass.js';
import { OutputPass } from './vendor/addons/postprocessing/OutputPass.js';
import { GTAOPass } from './vendor/addons/postprocessing/GTAOPass.js';
import { UnrealBloomPass } from './vendor/addons/postprocessing/UnrealBloomPass.js';
import { SMAAPass } from './vendor/addons/postprocessing/SMAAPass.js';
import { FXAAShader } from './vendor/addons/shaders/FXAAShader.js';
import { RoomEnvironment } from './vendor/addons/environments/RoomEnvironment.js';
import { RoundedBoxGeometry } from './vendor/addons/geometries/RoundedBoxGeometry.js';
import { Rng } from './prng.js';
import { CELL } from './rules.js';
import { SHADOW_MAP, PARTICLE_POOL, MOTE_COUNT } from './gfx.js';

// Framing constants (no magic offsets scattered through the code).
export const FRAMING = {
  fov: 32,
  pitch: 0.86,          // camera elevation angle (radians)
  distancePerCell: 1.06,
  minDistance: 7.5,
  lookAhead: 0.35,      // bias toward the board's far edge
  boardPad: 1.15,       // world units of slab beyond the cell grid
  introDuration: 1.1,   // seconds
  winDuration: 2.2,
};

// Resolved graphics settings (see gfx.js resolve()) used until main applies
// the player's choice — the cheapest tier.
const LOW_GFX = {
  preset: 'low', auto: true, cap: 1, scale: 1, shadows: 'off', ao: 'off', bloom: 'off', grade: 'off',
  antialias: 'off', reflections: 'off', particles: 'low', background: 'static', detail: 'plain',
  adaptive: true, showFps: false, post: false, canvasMsaa: false,
};
const FLORA_COUNT = { plain: 3, detailed: 12 };

// Colour grade + vignette, applied after OutputPass (display-space in and out).
const GradeShader = {
  uniforms: { tDiffuse: { value: null }, uAmount: { value: 1.0 }, uVignette: { value: 0.26 } },
  vertexShader: 'varying vec2 vUv; void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
  fragmentShader: `
    uniform sampler2D tDiffuse; uniform float uAmount; uniform float uVignette;
    varying vec2 vUv;
    void main() {
      vec4 src = texture2D(tDiffuse, vUv);
      vec3 c = clamp(src.rgb, 0.0, 1.0);
      // Gentle S-curve, a touch of saturation, warm highlights / cool shadows.
      vec3 s = mix(c, c * c * (3.0 - 2.0 * c), 0.18);
      float l = dot(s, vec3(0.299, 0.587, 0.114));
      s = mix(vec3(l), s, 1.1);
      s *= mix(vec3(0.97, 0.99, 1.05), vec3(1.04, 1.0, 0.95), smoothstep(0.2, 0.8, l));
      c = mix(c, s, uAmount);
      float d = length((vUv - 0.5) * vec2(1.0, 0.85));
      c *= 1.0 - uVignette * smoothstep(0.38, 0.9, d);
      gl_FragColor = vec4(c, src.a);
    }`,
};

// Per-instance emission: lit cells glow in their own colour, unlit cells never
// do (the material-wide emissive used to tint every cell).
function patchCellGlow(mat) {
  mat.onBeforeCompile = (sh) => {
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\nattribute float aGlow;\nvarying float vGlow;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvGlow = aGlow;');
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', '#include <common>\nvarying float vGlow;')
      .replace('#include <emissivemap_fragment>', `#include <emissivemap_fragment>
#ifdef USE_COLOR
totalEmissiveRadiance *= vColor * vGlow;
#else
totalEmissiveRadiance *= vGlow;
#endif`);
  };
  mat.customProgramCacheKey = () => 'pl-cell-glow';
  return mat;
}

// Small deterministic canvas textures (no image assets).
function canvasTexture(size, draw, srgb = true) {
  const c = document.createElement('canvas');
  c.width = c.height = size;
  draw(c.getContext('2d'), size);
  const t = new THREE.CanvasTexture(c);
  if (srgb) t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

function makeSpriteTexture() {
  return canvasTexture(64, (g, n) => {
    const r = g.createRadialGradient(n / 2, n / 2, 0, n / 2, n / 2, n / 2);
    r.addColorStop(0, 'rgba(255,255,255,1)');
    r.addColorStop(0.35, 'rgba(255,255,255,0.55)');
    r.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = r; g.fillRect(0, 0, n, n);
  });
}

// Fine mottled grain for the slab (tinted by the material colour).
function makeGrainTexture() {
  const rng = new Rng(0x51AB, 'decor');
  const t = canvasTexture(256, (g, n) => {
    g.fillStyle = '#d8d8d8'; g.fillRect(0, 0, n, n);
    for (let i = 0; i < 5200; i++) {
      const v = 190 + Math.floor(rng.float() * 65);
      g.fillStyle = `rgba(${v},${v},${v},0.5)`;
      g.fillRect(rng.float() * n, rng.float() * n, 1 + rng.float() * 2.5, 1 + rng.float() * 2.5);
    }
    for (let i = 0; i < 40; i++) {
      g.strokeStyle = `rgba(255,255,255,${0.04 + rng.float() * 0.05})`;
      g.lineWidth = 1;
      const y = rng.float() * n;
      g.beginPath(); g.moveTo(0, y); g.lineTo(n, y + (rng.float() - 0.5) * 20); g.stroke();
    }
  });
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  return t;
}

// Soft pool of light under the board that fades into the fog.
function makeGroundTexture() {
  return canvasTexture(256, (g, n) => {
    const r = g.createRadialGradient(n / 2, n / 2, 0, n / 2, n / 2, n / 2);
    r.addColorStop(0, '#ffffff');
    r.addColorStop(0.28, '#c9c9c9');
    r.addColorStop(1, '#6a6a6a');
    g.fillStyle = r; g.fillRect(0, 0, n, n);
  });
}

const easeOutCubic = t => 1 - Math.pow(1 - t, 3);
const easeInOut = t => t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;

// Critically damped spring integrator (deterministic per dt).
function springStep(cur, vel, target, dt, omega = 14) {
  const f = 1 + 2 * dt * omega;
  const oo = omega * omega;
  const hoo = dt * oo;
  const hhoo = dt * hoo;
  const detInv = 1 / (f + hhoo);
  const detX = f * cur + dt * vel + hhoo * target;
  const detV = vel + hoo * (target - cur);
  return [detX * detInv, detV * detInv];
}

export class BoardRenderer {
  constructor(canvas, opts = {}) {
    this.canvas = canvas;
    this.gfx = opts.gfx || LOW_GFX;
    this.gpu = opts.gpu || '';
    this.reducedMotion = !!opts.reducedMotion;
    this.theme = opts.theme;
    this.onCellHover = opts.onCellHover || (() => {});
    this.onCellActivate = opts.onCellActivate || (() => {});
    this.adaptiveScale = 1;
    this.pixelRatio = 0;
    this.size = [0, 0];
    this._frames = [];
    this.fps = 0;
    this.composer = null;
    this.postKey = null;
    this.postFailed = false;

    // Canvas MSAA is a context flag: main rebuilds the renderer when it changes.
    this.canvasMsaa = !!this.gfx.canvasMsaa;
    this.renderer = new THREE.WebGLRenderer({
      canvas, antialias: this.canvasMsaa, alpha: false,
      powerPreference: 'default',
    });
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.05;
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this._sprite = makeSpriteTexture();

    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(FRAMING.fov, 1, 0.1, 200);
    this.cameraPose = { dist: 12, pitch: FRAMING.pitch, yaw: 0, y: 0 };
    this.cameraTarget = new THREE.Vector3(0, 0, 0);
    this.transition = null;
    this.shake = 0;

    this.cells = null;         // InstancedMesh
    this.cellState = [];       // per-cell anim state
    this.rows = 0; this.cols = 0;
    this.hover = { r: -1, c: -1 };
    this.focusCell = { r: -1, c: -1 };
    this.ghostMode = 'fill';
    this.time = 0;
    this.disposed = false;
    this._raycaster = new THREE.Raycaster();
    this._pointer = new THREE.Vector2();
    this._tmpM = new THREE.Matrix4();
    this._tmpV = new THREE.Vector3();
    this._tmpC = new THREE.Color();
    this._projectCallbacks = [];
    this.bloomT = -1; // win bloom progress, -1 idle

    this._buildEnvironment();
    this._buildParticles();
    this._buildMotes();
    this._buildSelectionAids();
    this._applyTheme(opts.theme);
    this.setGraphics(this.gfx);

    canvas.addEventListener('webglcontextlost', (e) => {
      e.preventDefault();
      if (this.onContextLost) this.onContextLost();
    });

    this._bindPointer();
  }

  // -------------------------------------------------------------------------
  // Environment & lighting
  // -------------------------------------------------------------------------

  _buildEnvironment() {
    this.keyLight = new THREE.DirectionalLight(0xfff2dd, 2.6);
    this.keyLight.position.set(6, 12, 4);
    this.keyLight.shadow.bias = -0.0004;
    this.keyLight.shadow.normalBias = 0.02;
    this.scene.add(this.keyLight);
    this.scene.add(this.keyLight.target); // aimed at the board centre
    this.hemi = new THREE.HemisphereLight(0x8fa3c8, 0x1c2233, 0.85);
    this.scene.add(this.hemi);
    this.rim = new THREE.DirectionalLight(0x88aaff, 0.5);
    this.rim.position.set(-6, 4, -8);
    this.scene.add(this.rim);

    // Ground disc — contact grounding for the slab.
    const groundGeo = new THREE.CircleGeometry(40, 48);
    this.groundMat = new THREE.MeshStandardMaterial({ color: 0x232c40, roughness: 0.95, metalness: 0, envMapIntensity: 0.15 });
    this.ground = new THREE.Mesh(groundGeo, this.groundMat);
    this.ground.rotation.x = -Math.PI / 2;
    this.ground.position.y = -0.55;
    this.scene.add(this.ground);
    this._groundTex = makeGroundTexture();
    this._grainTex = makeGrainTexture();

    this.scene.fog = new THREE.Fog(0x2a3550, 26, 70);
    this.floraGroup = new THREE.Group();
    this.scene.add(this.floraGroup);
    this._fitShadowCamera();
  }

  // Shadow frustum fitted to the board plus its ring of flora.
  _fitShadowCamera() {
    const maxDim = Math.max(this.rows || 8, this.cols || 8);
    const extent = maxDim * 0.72 + 5.2;
    const cam = this.keyLight.shadow.camera;
    Object.assign(cam, { left: -extent, right: extent, top: extent, bottom: -extent, near: 2, far: 34 });
    cam.updateProjectionMatrix();
  }

  // ---------------------------------------------------------------- graphics settings

  /** Apply resolved graphics settings (gfx.js resolve()) live, without a reload. */
  setGraphics(g) {
    const prev = this._applied;
    this.gfx = g;
    const size = SHADOW_MAP[g.shadows] || 0;
    this.renderer.shadowMap.enabled = size > 0;
    this.keyLight.castShadow = size > 0;
    if (size > 0 && this.keyLight.shadow.mapSize.x !== size) {
      this.keyLight.shadow.mapSize.set(size, size);
      this.keyLight.shadow.map?.dispose();
      this.keyLight.shadow.map = null;
    }
    // Image-based lighting: the environment carries the fill, so the hemisphere eases off.
    const ibl = g.reflections === 'on';
    this.scene.environment = ibl ? this._envMap() : null;
    this.hemi.intensity = ibl ? 0.5 : 0.85;
    this.keyLight.intensity = ibl ? 2.05 : 2.6;
    if (PARTICLE_POOL[g.particles] !== this.pMax) this._buildParticles();
    this._buildMotes();
    if (!prev || prev.detail !== g.detail) this._applyDetail();
    this._applyShadowFlags();
    // Materials pick up shadow/environment changes on recompile.
    this.scene.traverse(o => {
      if (!o.material) return;
      for (const m of Array.isArray(o.material) ? o.material : [o.material]) m.needsUpdate = true;
    });
    this.adaptiveScale = 1;
    this._frames = [];
    this.postKey = null; // rebuild the post chain on the next frame
    this._fpsVisible(g.showFps);
    this._applied = { ...g };
  }

  _envMap() {
    if (!this._env) {
      const pmrem = new THREE.PMREMGenerator(this.renderer);
      this._env = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
      pmrem.dispose();
    }
    return this._env;
  }

  _applyShadowFlags() {
    const on = this.renderer.shadowMap.enabled;
    this.ground.receiveShadow = on;
    if (this.slab) this.slab.receiveShadow = on;
    if (this.cells) { this.cells.castShadow = on; this.cells.receiveShadow = on; }
    // Flora stays out of the shadow map: its floating puffs cast distracting blots.
  }

  // Board detail: bevelled clear-coat cells, grained slab with a light rim,
  // lit ground pool and a fuller ring of flora — or the plain originals.
  _applyDetail() {
    const detailed = this.gfx.detail === 'detailed';
    this.groundMat.map = detailed ? this._groundTex : null;
    if (this.cells) {
      this._rebuildSlab();
      this.cells.geometry = detailed ? this.cellGeoDetailed : this.cellGeoPlain;
      this.cells.material = detailed ? this.cellMatDetailed : this.cellMatPlain;
      this.cellMat = this.cells.material;
    }
    if (this.theme) this._buildFlora(this.theme);
  }

  _fpsVisible(on) {
    let el = document.getElementById('fps-meter');
    if (on && !el) {
      el = document.createElement('div');
      el.id = 'fps-meter';
      el.setAttribute('aria-hidden', 'true');
      el.textContent = '… fps';
      document.body.append(el);
    }
    if (el) el.hidden = !on;
  }

  /** What the settings panel shows: GPU, resolved tiers, drawn pixels, frame rate. */
  graphicsInfo() {
    return {
      gpu: this.gpu,
      resolved: this.gfx,
      pixels: [Math.round(this.size[0] * this.pixelRatio), Math.round(this.size[1] * this.pixelRatio)],
      fps: Math.round(this.fps || 0),
      adaptiveScale: Math.round(this.adaptiveScale * 100) / 100,
      postFailed: this.postFailed,
    };
  }

  _postKey(w, h) {
    const g = this.gfx;
    return g.post ? [g.ao, g.bloom, g.grade, g.antialias, w, h, this.pixelRatio].join('|') : 'none';
  }

  _buildPost(w, h) {
    const g = this.gfx;
    this.composer?.dispose();
    this.composer = null;
    if (!g.post || this.postFailed) return;
    try {
      const pr = this.pixelRatio;
      const target = new THREE.WebGLRenderTarget(Math.round(w * pr), Math.round(h * pr), {
        type: THREE.HalfFloatType, samples: g.antialias === 'msaa' ? 4 : 0,
      });
      const composer = new EffectComposer(this.renderer, target);
      composer.setPixelRatio(pr);
      composer.setSize(w, h);
      composer.addPass(new RenderPass(this.scene, this.camera));
      if (g.ao !== 'off') {
        const ao = new GTAOPass(this.scene, this.camera, Math.round(w * pr), Math.round(h * pr));
        ao.output = GTAOPass.OUTPUT.Default;
        ao.blendIntensity = 0.75;
        ao.updateGtaoMaterial({ radius: 0.5, distanceExponent: 1.4, thickness: 1.2, scale: 1.0, samples: g.ao === 'high' ? 16 : 8 });
        ao.updatePdMaterial({ lumaPhi: 10, depthPhi: 2, normalPhi: 3, radius: g.ao === 'high' ? 6 : 4, rings: 2, samples: g.ao === 'high' ? 16 : 8 });
        composer.addPass(ao);
      }
      if (g.bloom === 'on') {
        // High threshold: only lit cells, the light rim and glowing flora bloom.
        composer.addPass(new UnrealBloomPass(new THREE.Vector2(w, h), 0.4, 0.45, 0.85));
      }
      composer.addPass(new OutputPass());
      if (g.grade === 'on') composer.addPass(new ShaderPass(GradeShader));
      if (g.antialias === 'smaa') composer.addPass(new SMAAPass(Math.round(w * pr), Math.round(h * pr)));
      if (g.antialias === 'fxaa') {
        const fxaa = new ShaderPass(FXAAShader);
        fxaa.material.uniforms.resolution.value.set(1 / (w * pr), 1 / (h * pr));
        composer.addPass(fxaa);
      }
      this.composer = composer;
    } catch (e) {
      // Post-processing is an enhancement: render directly (the panel shows a note).
      this.postFailed = true;
      this.composer = null;
    }
  }

  // Adaptive resolution: ~90-frame average; step down when slow, back up when fast.
  _adapt(dtMs) {
    const f = this._frames;
    f.push(dtMs);
    if (f.length < 90) return false;
    const avg = f.reduce((a, b) => a + b, 0) / f.length;
    f.length = 0;
    this.fps = 1000 / avg;
    const el = document.getElementById('fps-meter');
    if (el && !el.hidden) el.textContent = `${Math.round(this.fps)} fps · ${Math.round(this.pixelRatio * 100) / 100}×`;
    if (!this.gfx.adaptive) {
      if (this.adaptiveScale !== 1) { this.adaptiveScale = 1; return true; }
      return false;
    }
    const before = this.adaptiveScale;
    if (avg > 26) this.adaptiveScale = Math.max(0.6, this.adaptiveScale - 0.1);
    else if (avg < 14 && this.adaptiveScale < 1) this.adaptiveScale = Math.min(1, this.adaptiveScale + 0.05);
    return before !== this.adaptiveScale;
  }

  // Pixel ratio = min(dpr, preset cap) × render scale × adaptive scale.
  _applySize(w, h) {
    const g = this.gfx;
    const ratio = Math.min(window.devicePixelRatio || 1, g.cap) * g.scale * this.adaptiveScale;
    if (w !== this.size[0] || h !== this.size[1] || ratio !== this.pixelRatio) {
      this.size = [w, h];
      this.pixelRatio = ratio;
      this.renderer.setPixelRatio(ratio);
      this.renderer.setSize(w, h, false);
    }
  }

  // -------------------------------------------------------------------------
  // Ambient motes — slow drifting points of light around the board
  // (background: animated). Cosmetic, never pickable, frozen by reduced motion.
  // -------------------------------------------------------------------------

  _buildMotes() {
    const n = MOTE_COUNT[this.gfx?.particles] || MOTE_COUNT.low;
    const on = this.gfx?.background === 'animated';
    if (this.motes && this.motes.userData.n === n) {
      this.motes.visible = on;
      return;
    }
    if (this.motes) { this.scene.remove(this.motes); this.motes.geometry.dispose(); this.motes.material.dispose(); }
    const rng = new Rng(0x40735, 'decor');
    const pos = new Float32Array(n * 3), col = new Float32Array(n * 3);
    this.moteSeed = new Float32Array(n * 4);
    for (let i = 0; i < n; i++) {
      this.moteSeed[i * 4] = rng.float() * Math.PI * 2;      // angle
      this.moteSeed[i * 4 + 1] = 0.7 + rng.float() * 0.6;   // radius factor
      this.moteSeed[i * 4 + 2] = rng.float();                // height phase
      this.moteSeed[i * 4 + 3] = 0.6 + rng.float() * 0.8;    // speed
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
    const mat = new THREE.PointsMaterial({
      size: 0.16, map: this._sprite, vertexColors: true, transparent: true, opacity: 0.75,
      depthWrite: false, blending: THREE.AdditiveBlending, sizeAttenuation: true,
    });
    this.motes = new THREE.Points(geo, mat);
    this.motes.userData.n = n;
    this.motes.raycast = () => {};
    this.motes.frustumCulled = false;
    this.motes.visible = on;
    this.scene.add(this.motes);
    this._tintMotes();
    this._updateMotes(0);
  }

  _tintMotes() {
    if (!this.motes || !this.theme) return;
    const col = this.motes.geometry.attributes.color;
    const pal = (this.theme.bloom || ['#ffc978']).map(c => new THREE.Color(c));
    for (let i = 0; i < col.count; i++) {
      const c = pal[i % pal.length];
      col.setXYZ(i, c.r, c.g, c.b);
    }
    col.needsUpdate = true;
  }

  _updateMotes(t) {
    if (!this.motes || !this.motes.visible) return;
    const pos = this.motes.geometry.attributes.position;
    const base = Math.max(this.cols || 8, this.rows || 8) * 0.72 + 1.2;
    const s = this.moteSeed;
    for (let i = 0; i < pos.count; i++) {
      const a = s[i * 4] + t * 0.03 * s[i * 4 + 3];
      const r = base * s[i * 4 + 1] + 1.6 + Math.sin(t * 0.4 + s[i * 4] * 3) * 0.3;
      const h = (s[i * 4 + 2] + t * 0.035 * s[i * 4 + 3]) % 1;
      pos.setXYZ(i, Math.cos(a) * r, -0.3 + h * 4.2, Math.sin(a) * r);
    }
    pos.needsUpdate = true;
  }

  _applyTheme(theme) {
    if (!theme) return;
    this.theme = theme;
    this.scene.background = new THREE.Color(theme.sky);
    this.scene.fog.color.set(theme.fog);
    this.groundMat.color.set(theme.ground);
    this.hemi.color.set(theme.cellEdge).lerp(new THREE.Color(0xffffff), 0.4);
    this._buildFlora(theme);
    if (this.slabMat) this.slabMat.color.set(theme.slab);
    if (this.rimMat) this.rimMat.emissive.set(theme.accent);
    if (this.cellMat) this._refreshAllCellColors();
    this._tintMotes();
  }

  // Original procedural flora — small sculptures ringing the board.
  _buildFlora(theme) {
    // Dispose previous flora explicitly.
    this.floraGroup.traverse(o => { if (o.geometry) o.geometry.dispose(); if (o.material) o.material.dispose(); });
    this.floraGroup.clear();
    const rng = new Rng((this.boardSeed ?? 7) ^ 0xF10A, 'decor');
    const detailed = this.gfx?.detail === 'detailed';
    const n = FLORA_COUNT[detailed ? 'detailed' : 'plain'];
    const radius = () => Math.max(this.cols || 8, this.rows || 8) * 0.72 + 2.2;
    for (let i = 0; i < n; i++) {
      const ang = (i / n) * Math.PI * 2 + rng.float() * 0.5;
      const dist = radius() + rng.float() * 2.5;
      const g = makeFlora(theme, rng, detailed);
      g.position.set(Math.cos(ang) * dist, -0.55, Math.sin(ang) * dist);
      g.rotation.y = rng.float() * Math.PI * 2;
      const s = 0.7 + rng.float() * 0.7;
      g.scale.setScalar(s);
      g.userData.swayPhase = rng.float() * Math.PI * 2;
      this.floraGroup.add(g);
    }
    if (this.renderer) this._applyShadowFlags();
  }

  // -------------------------------------------------------------------------
  // Board construction
  // -------------------------------------------------------------------------

  setBoard(rows, cols, seed) {
    this.rows = rows; this.cols = cols; this.boardSeed = seed;
    if (this.cells) {
      this.scene.remove(this.cells);
      this.cellGeoPlain.dispose(); this.cellGeoDetailed.dispose();
      this.cellMatPlain.dispose(); this.cellMatDetailed.dispose();
    }
    this._fitShadowCamera();
    this._rebuildSlab();

    // Both cell looks share one per-instance glow attribute, so the detail
    // setting swaps geometry/material in place without touching cell state.
    this.glowAttr = new THREE.InstancedBufferAttribute(new Float32Array(rows * cols), 1);
    this.glowAttr.setUsage(THREE.DynamicDrawUsage);
    this.cellGeoPlain = new THREE.BoxGeometry(0.84, 0.34, 0.84);
    this.cellGeoDetailed = new RoundedBoxGeometry(0.84, 0.34, 0.84, 3, 0.07);
    this.cellGeoPlain.setAttribute('aGlow', this.glowAttr);
    this.cellGeoDetailed.setAttribute('aGlow', this.glowAttr);
    this.cellMatPlain = patchCellGlow(new THREE.MeshStandardMaterial({
      color: 0xffffff, roughness: 0.45, metalness: 0.05, emissive: 0xffffff,
    }));
    this.cellMatDetailed = patchCellGlow(new THREE.MeshPhysicalMaterial({
      color: 0xffffff, roughness: 0.38, metalness: 0.02, emissive: 0xffffff,
      clearcoat: 0.7, clearcoatRoughness: 0.22, envMapIntensity: 0.4,
    }));
    const detailed = this.gfx.detail === 'detailed';
    this.cellMat = detailed ? this.cellMatDetailed : this.cellMatPlain;
    this.cells = new THREE.InstancedMesh(detailed ? this.cellGeoDetailed : this.cellGeoPlain, this.cellMat, rows * cols);
    this.cells.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.scene.add(this.cells);

    this.cellState = [];
    for (let i = 0; i < rows * cols; i++) {
      this.cellState.push({
        lift: 0, liftVel: 0, targetLift: 0,
        glow: 0, glowVel: 0, targetGlow: 0,
        flash: 0, flashColor: new THREE.Color(0xffffff),
        color: new THREE.Color(this.theme?.cell ?? 0x3a4666),
        targetColor: new THREE.Color(this.theme?.cell ?? 0x3a4666),
        phase: (i * 0.6180339) % 1, // deterministic golden-ratio phase
      });
    }
    this._refreshAllCellColors();
    this._buildFlora(this.theme);
    this._applyShadowFlags();
    this.bloomT = -1;

    // Reframe camera for the new board size.
    const dist = this._preferredDistance();
    const to = { dist, pitch: FRAMING.pitch, yaw: 0, y: 0 };
    if (this.reducedMotion) {
      this.cameraPose = to;
    } else {
      this._startTransition({ ...to, dist: dist * 1.35, pitch: FRAMING.pitch + 0.35 }, to, FRAMING.introDuration, easeOutCubic);
    }
    this._updateCamera();
  }

  // Slab the cells sit in; detailed adds bevels, grain and a thin light rim.
  _rebuildSlab() {
    if (!this.rows) return;
    if (this.slab) {
      this.scene.remove(this.slab);
      this.slab.geometry.dispose(); this.slabMat.dispose();
    }
    if (this.rimStrips) {
      this.scene.remove(this.rimStrips);
      this.rimStrips.children.forEach(m => m.geometry.dispose());
      this.rimMat.dispose();
      this.rimStrips = null;
    }
    const detailed = this.gfx.detail === 'detailed';
    const w = this.cols + FRAMING.boardPad * 2, h = this.rows + FRAMING.boardPad * 2;
    this.slabMat = new THREE.MeshStandardMaterial({
      color: this.theme?.slab ?? 0x2e3852, roughness: detailed ? 0.72 : 0.6, metalness: 0.08, envMapIntensity: 0.35,
    });
    if (detailed) {
      this.slabMat.map = this._grainTex;
      this.slabMat.roughnessMap = this._grainTex;
      this._grainTex.repeat.set(w / 6, h / 6);
    }
    const geo = detailed ? new RoundedBoxGeometry(w, 0.5, h, 3, 0.16) : new THREE.BoxGeometry(w, 0.5, h);
    this.slab = new THREE.Mesh(geo, this.slabMat);
    this.slab.position.y = -0.26;
    this.slab.receiveShadow = this.renderer.shadowMap.enabled;
    this.scene.add(this.slab);

    if (detailed) {
      // Minimal light-board rim: four thin emissive strips framing the cells.
      this.rimMat = new THREE.MeshStandardMaterial({
        color: 0x000000, emissive: this.theme?.accent ?? 0x8fd6a0, emissiveIntensity: 0.6, roughness: 0.5,
      });
      this.rimStrips = new THREE.Group();
      const gx = this.cols / 2 + 0.34, gz = this.rows / 2 + 0.34, t = 0.045;
      const strip = (sx, sz, x, z) => {
        const m = new THREE.Mesh(new THREE.BoxGeometry(sx, 0.03, sz), this.rimMat);
        m.position.set(x, 0.0, z);
        m.raycast = () => {};
        this.rimStrips.add(m);
      };
      strip(gx * 2 + t, t, 0, -gz); strip(gx * 2 + t, t, 0, gz);
      strip(t, gz * 2 + t, -gx, 0); strip(t, gz * 2 + t, gx, 0);
      this.scene.add(this.rimStrips);
    }
  }

  cellPos(r, c, out = new THREE.Vector3()) {
    out.set(c - (this.cols - 1) / 2, 0, r - (this.rows - 1) / 2);
    return out;
  }

  _refreshAllCellColors() {
    if (!this.cells) return;
    for (let i = 0; i < this.cellState.length; i++) {
      const st = this.cellState[i];
      this.cells.setColorAt(i, st.color);
    }
    if (this.cells.instanceColor) this.cells.instanceColor.needsUpdate = true;
  }

  // Synchronize visuals with a rules snapshot + presentation events.
  syncState(grid, rows, cols, events = []) {
    if (!this.cells || rows !== this.rows || cols !== this.cols) return;
    const t = this.theme;
    for (let i = 0; i < grid.length; i++) {
      const st = this.cellState[i];
      const v = grid[i];
      if (v === CELL.FILLED) {
        st.targetLift = 0.16;
        st.targetGlow = 1;
        st.targetColor.set(t?.lit ?? 0xffc978);
      } else if (v === CELL.MARKED) {
        st.targetLift = -0.06;
        st.targetGlow = 0;
        st.targetColor.set(t?.cell ?? 0x3a4666).multiplyScalar(0.55);
      } else {
        st.targetLift = 0;
        st.targetGlow = 0;
        st.targetColor.set(t?.cell ?? 0x3a4666);
      }
    }
    for (const ev of events) {
      if (ev.type === 'fill') {
        const st = this.cellState[ev.r * cols + ev.c];
        st.flash = 1; st.flashColor.set(t?.litEmissive ?? 0xffb347);
        this.spawnBurst(this.cellPos(ev.r, ev.c, this._tmpV), t?.lit ?? 0xffc978, 8);
      } else if (ev.type === 'mistake') {
        const st = this.cellState[ev.r * cols + ev.c];
        st.flash = 1; st.flashColor.set(0xff4444);
        if (!this.reducedMotion) this.shake = Math.min(0.5, this.shake + 0.22);
      } else if (ev.type === 'propagate') {
        for (const cell of ev.cells) this.spawnBurst(this.cellPos(cell.r, cell.c, this._tmpV), t?.accent ?? 0x8fd6a0, 2);
      } else if (ev.type === 'hint') {
        const st = this.cellState[ev.r * cols + ev.c];
        st.flash = 1; st.flashColor.set(t?.accent ?? 0x8fd6a0);
        this.spawnBurst(this.cellPos(ev.r, ev.c, this._tmpV), t?.accent ?? 0x8fd6a0, 10);
      } else if (ev.type === 'terminal' && ev.status === 'complete') {
        this._startBloom();
      }
    }
  }

  // -------------------------------------------------------------------------
  // Selection aids: ring marker + hover ghost (selection/ghost layer).
  // -------------------------------------------------------------------------

  _buildSelectionAids() {
    this.ring = new THREE.Mesh(
      new THREE.RingGeometry(0.42, 0.52, 40),
      new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.85, side: THREE.DoubleSide })
    );
    this.ring.rotation.x = -Math.PI / 2;
    this.ring.visible = false;
    this.scene.add(this.ring);

    this.ghost = new THREE.Mesh(
      new THREE.BoxGeometry(0.84, 0.36, 0.84),
      new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.35, depthWrite: false })
    );
    this.ghost.visible = false;
    this.scene.add(this.ghost);
  }

  setHover(r, c, mode = 'fill') {
    this.hover = { r, c };
    this.ghostMode = mode;
  }

  setFocusCell(r, c) { this.focusCell = { r, c }; }

  // -------------------------------------------------------------------------
  // Particles — single pooled Points cloud; effects never intercept raycasts.
  // -------------------------------------------------------------------------

  _buildParticles() {
    if (this.points) { this.scene.remove(this.points); this.pGeo.dispose(); this.points.material.dispose(); }
    const max = PARTICLE_POOL[this.gfx?.particles] || PARTICLE_POOL.low;
    this.pMax = max;
    this.pPos = new Float32Array(max * 3);
    this.pVel = new Float32Array(max * 3);
    this.pLife = new Float32Array(max);
    this.pCol = new Float32Array(max * 3);
    this.pHead = 0;
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(this.pPos, 3));
    geo.setAttribute('color', new THREE.BufferAttribute(this.pCol, 3));
    this.pGeo = geo;
    for (let i = 0; i < max; i++) this.pPos[i * 3 + 1] = -50; // parked out of view
    const mat = new THREE.PointsMaterial({
      size: 0.16, map: this._sprite, vertexColors: true, transparent: true, opacity: 0.95,
      depthWrite: false, sizeAttenuation: true, blending: THREE.AdditiveBlending,
    });
    this.points = new THREE.Points(geo, mat);
    this.points.raycast = () => {}; // cosmetic: never pickable
    this.points.frustumCulled = false;
    this.scene.add(this.points);
    this._pRng = new Rng(0xBEEF, 'fx');
  }

  spawnBurst(pos, color, count) {
    const c = new THREE.Color(color);
    const n = Math.min(count, Math.floor(this.pMax / 4));
    for (let k = 0; k < n; k++) {
      const i = this.pHead = (this.pHead + 1) % this.pMax;
      this.pPos[i * 3] = pos.x; this.pPos[i * 3 + 1] = pos.y + 0.25; this.pPos[i * 3 + 2] = pos.z;
      const a = this._pRng.float() * Math.PI * 2;
      const sp = 0.6 + this._pRng.float() * 1.6;
      this.pVel[i * 3] = Math.cos(a) * sp * 0.6;
      this.pVel[i * 3 + 1] = 1.2 + this._pRng.float() * 1.6;
      this.pVel[i * 3 + 2] = Math.sin(a) * sp * 0.6;
      this.pLife[i] = 0.7 + this._pRng.float() * 0.5;
      this.pCol[i * 3] = c.r; this.pCol[i * 3 + 1] = c.g; this.pCol[i * 3 + 2] = c.b;
    }
  }

  _updateParticles(dt) {
    let any = false;
    for (let i = 0; i < this.pMax; i++) {
      if (this.pLife[i] <= 0) continue;
      any = true;
      this.pLife[i] -= dt;
      this.pVel[i * 3 + 1] -= 4.5 * dt;
      this.pPos[i * 3] += this.pVel[i * 3] * dt;
      this.pPos[i * 3 + 1] += this.pVel[i * 3 + 1] * dt;
      this.pPos[i * 3 + 2] += this.pVel[i * 3 + 2] * dt;
      if (this.pLife[i] <= 0) { this.pPos[i * 3 + 1] = -50; }
    }
    if (any) {
      this.pGeo.attributes.position.needsUpdate = true;
      this.pGeo.attributes.color.needsUpdate = true;
    }
  }

  // -------------------------------------------------------------------------
  // Win bloom — the board blooms into a tiny scene.
  // -------------------------------------------------------------------------

  _startBloom() {
    if (this.reducedMotion) { this.bloomT = 1; this._applyBloomFinal(); return; }
    this.bloomT = 0;
    const dist = this._preferredDistance() + 2;
    this._startTransition({ ...this.cameraPose }, { dist, pitch: FRAMING.pitch + 0.12, yaw: 0.35, y: 0 }, FRAMING.winDuration, easeInOut);
  }

  _applyBloomFinal() {
    const t = this.theme;
    for (let i = 0; i < this.cellState.length; i++) {
      const st = this.cellState[i];
      if (st.targetGlow > 0) {
        st.glow = 1.2;
        st.color.set(t?.bloom?.[i % t.bloom.length] ?? '#ffc978');
      }
    }
  }

  _updateBloom(dt) {
    if (this.bloomT < 0) return;
    if (this.bloomT < 1) {
      this.bloomT = Math.min(1, this.bloomT + dt / FRAMING.winDuration);
      const t = this.theme;
      for (let i = 0; i < this.cellState.length; i++) {
        const st = this.cellState[i];
        if (st.targetGlow <= 0) continue;
        const local = Math.max(0, Math.min(1, (this.bloomT * 1.6 - st.phase * 0.6)));
        st.glow = 1 + local * 0.5;
        st.lift = st.targetLift + local * 0.22 * Math.sin(st.phase * Math.PI);
        if (local > 0.01) {
          st.color.set(t?.lit ?? 0xffc978).lerp(this._tmpC.set(t?.bloom?.[i % (t?.bloom?.length || 1)] ?? '#ffffff'), local * 0.8);
        }
        if (local > 0.5 && !st.bloomed) {
          st.bloomed = true;
          this.spawnBurst(this.cellPos(Math.floor(i / this.cols), i % this.cols, this._tmpV), t?.bloom?.[i % (t?.bloom?.length || 1)] ?? 0xffffff, 3);
        }
      }
      if (this.bloomT >= 1) for (const st of this.cellState) st.bloomed = false;
    }
  }

  // -------------------------------------------------------------------------
  // Camera
  // -------------------------------------------------------------------------

  _startTransition(from, to, duration, ease) {
    if (this.reducedMotion || duration <= 0) {
      this.cameraPose = { ...to };
      this.transition = null;
      this._updateCamera();
      return;
    }
    this.transition = { from: { ...from }, to: { ...to }, t: 0, duration, ease };
  }

  resetCamera() {
    const dist = this._preferredDistance();
    this._startTransition({ ...this.cameraPose }, { dist, pitch: FRAMING.pitch, yaw: 0, y: 0 }, 0.6, easeOutCubic);
  }

  // Preferred rest distance: the authored linear framing, but never closer
  // than what fits the whole board in the current view.
  _preferredDistance() {
    const maxDim = Math.max(this.rows || 8, this.cols || 8);
    const base = Math.max(FRAMING.minDistance, maxDim * FRAMING.distancePerCell + 2.5);
    return Math.max(base, this._fitDistance());
  }

  // Smallest distance at which every outer cell corner projects inside the
  // view's safe margins (binary search against the live camera). Without
  // this the near edge leaves the frustum on tight viewports and those
  // cells become unreachable by pointer.
  // Safe NDC bounds: the default margins, tightened by whatever HUD chrome
  // (lesson banner, tray) overlays the canvas — see setSafeInsets.
  setSafeInsets(ins) {
    this.safeInsets = ins || null;
    const fit = this._fitDistance();
    if (this.transition) this.transition.to.dist = Math.max(this.transition.to.dist, fit);
    else if (this.cameraPose.dist < fit) this.cameraPose.dist = fit;
    this._updateCamera();
  }

  _fitDistance() {
    const rows = this.rows || 8, cols = this.cols || 8;
    const corners = [
      [-cols / 2, 0.2, -rows / 2], [cols / 2, 0.2, -rows / 2],
      [-cols / 2, 0.2, rows / 2], [cols / 2, 0.2, rows / 2],
    ];
    const ins = this.safeInsets || {};
    const xMin = -0.86 + 2 * (ins.left || 0), xMax = 0.86 - 2 * (ins.right || 0);
    const yMax = Math.min(0.58, 1 - 2 * (ins.top || 0) - 0.04), yMin = Math.max(-0.92, -1 + 2 * (ins.bottom || 0) + 0.04);
    const fits = (dist) => {
      this.cameraPose.dist = dist;
      this._updateCamera();
      this.camera.updateMatrixWorld();
      for (const [x, y, z] of corners) {
        const p = this._tmpV.set(x, y, z).project(this.camera);
        if (p.x < xMin || p.x > xMax || p.y > yMax || p.y < yMin) return false;
      }
      return true;
    };
    const saved = this.cameraPose.dist;
    let result = FRAMING.minDistance;
    if (!fits(result)) {
      let lo = FRAMING.minDistance, hi = 90;
      for (let i = 0; i < 24; i++) {
        const mid = (lo + hi) / 2;
        if (fits(mid)) hi = mid; else lo = mid;
      }
      result = hi;
    }
    this.cameraPose.dist = saved;
    this._updateCamera();
    return result;
  }

  nudgeCamera(dYaw, dPitch) {
    const p = this.cameraPose;
    this.transition = null;
    p.yaw = THREE.MathUtils.clamp(p.yaw + dYaw, -0.9, 0.9);
    p.pitch = THREE.MathUtils.clamp(p.pitch + dPitch, 0.5, 1.35);
    this._updateCamera();
  }

  _updateCamera() {
    const p = this.cameraPose;
    const d = p.dist;
    const y = Math.sin(p.pitch) * d;
    const hz = Math.cos(p.pitch) * d;
    this.camera.position.set(Math.sin(p.yaw) * hz, y + p.y, Math.cos(p.yaw) * hz);
    this.cameraTarget.set(0, 0, -FRAMING.lookAhead);
    this.camera.lookAt(this.cameraTarget);
  }

  // -------------------------------------------------------------------------
  // Pointer: raycast only against the cells' interaction layer.
  // -------------------------------------------------------------------------

  _bindPointer() {
    let downAt = null, downPos = null, captured = false;
    this.canvas.addEventListener('pointerdown', (e) => {
      downAt = performance.now(); downPos = [e.clientX, e.clientY];
      captured = true;
      this.canvas.setPointerCapture?.(e.pointerId);
    });
    this.canvas.addEventListener('pointermove', (e) => {
      const cell = this._pick(e);
      this.onCellHover(cell, e);
      // Drag painting: same intent dragged across cells.
      if (captured && downPos) {
        const dx = e.clientX - downPos[0], dy = e.clientY - downPos[1];
        if (Math.hypot(dx, dy) > 14 && performance.now() - downAt > 120) {
          this.onCellActivate(cell, e, /*drag*/ true);
        }
      }
    });
    const release = (e) => {
      if (!captured) return;
      captured = false;
      this.canvas.releasePointerCapture?.(e.pointerId);
      const dt = performance.now() - (downAt ?? 0);
      const moved = downPos ? Math.hypot(e.clientX - downPos[0], e.clientY - downPos[1]) : 99;
      if (dt < 500 && moved <= 14) this.onCellActivate(this._pick(e), e, false);
      downPos = null;
    };
    this.canvas.addEventListener('pointerup', release);
    this.canvas.addEventListener('pointercancel', () => { captured = false; downPos = null; });
    this.canvas.addEventListener('lostpointercapture', () => { captured = false; downPos = null; });
  }

  _pick(e) {
    if (!this.cells) return null;
    const rect = this.canvas.getBoundingClientRect();
    this._pointer.set(((e.clientX - rect.left) / rect.width) * 2 - 1, -((e.clientY - rect.top) / rect.height) * 2 + 1);
    this._raycaster.setFromCamera(this._pointer, this.camera);
    const hits = this._raycaster.intersectObject(this.cells);
    if (!hits.length || hits[0].instanceId === undefined) return null;
    const id = hits[0].instanceId;
    return { r: Math.floor(id / this.cols), c: id % this.cols };
  }

  // -------------------------------------------------------------------------
  // Frame update — animation derives from sim state + dt, never frame count.
  // -------------------------------------------------------------------------

  update(dt, grid) {
    if (this.disposed) return;
    this.time += dt;

    // Camera transition.
    if (this.transition) {
      const tr = this.transition;
      tr.t += dt;
      const k = tr.ease(Math.min(1, tr.t / tr.duration));
      this.cameraPose = {
        dist: tr.from.dist + (tr.to.dist - tr.from.dist) * k,
        pitch: tr.from.pitch + (tr.to.pitch - tr.from.pitch) * k,
        yaw: tr.from.yaw + (tr.to.yaw - tr.from.yaw) * k,
        y: tr.from.y + (tr.to.y - tr.from.y) * k,
      };
      if (tr.t >= tr.duration) this.transition = null;
      this._updateCamera();
    }

    // Event-tiered shake (never affects raycast truth: applied post-pick,
    // amplitude is tiny and decays fast).
    if (this.shake > 0.001) {
      const s = this.shake * 0.05;
      this.camera.position.x += Math.sin(this.time * 47) * s;
      this.camera.position.y += Math.cos(this.time * 39) * s;
      this.shake *= Math.pow(0.0015, dt);
    } else this.shake = 0;

    // Ambient motion (background: animated): flora sway + drifting motes.
    const ambient = this.gfx.background === 'animated' && !this.reducedMotion;
    if (ambient) this.ambientTime = (this.ambientTime || 0) + dt;
    for (const f of this.floraGroup.children) {
      f.rotation.z = ambient ? Math.sin(this.ambientTime * 0.8 + f.userData.swayPhase) * 0.03 : 0;
    }
    if (ambient) this._updateMotes(this.ambientTime);

    // Cells.
    if (this.cells && grid) {
      const mat = this._tmpM;
      for (let i = 0; i < this.cellState.length; i++) {
        const st = this.cellState[i];
        [st.lift, st.liftVel] = springStep(st.lift, st.liftVel, st.targetLift, dt);
        [st.glow, st.glowVel] = springStep(st.glow, st.glowVel, st.targetGlow, dt, 10);
        st.flash = Math.max(0, st.flash - dt * 3);
        st.color.lerp(st.targetColor, Math.min(1, dt * 8));
        const r = Math.floor(i / this.cols), c = i % this.cols;
        const idle = this.reducedMotion ? 0 : Math.sin(this.time * 1.4 + st.phase * Math.PI * 2) * 0.008 * st.glow;
        mat.makeTranslation(0, st.lift + idle, 0);
        mat.setPosition(this.cellPos(r, c, this._tmpV).x, st.lift + idle, this.cellPos(r, c, this._tmpV).z);
        this.cells.setMatrixAt(i, mat);
        this._tmpC.copy(st.color);
        if (st.flash > 0) this._tmpC.lerp(st.flashColor, st.flash * 0.7);
        this.cells.setColorAt(i, this._tmpC);
        this.glowAttr.array[i] = Math.max(0, st.glow) + st.flash * 0.8;
      }
      this.cells.instanceMatrix.needsUpdate = true;
      if (this.cells.instanceColor) this.cells.instanceColor.needsUpdate = true;
      this.glowAttr.needsUpdate = true;
      // Emissive pulse: only instances with glow emit (per-instance aGlow).
      this.cellMat.emissiveIntensity = this.reducedMotion ? 0.24 : 0.22 + Math.sin(this.time * 2.1) * 0.05;
    }

    this._updateBloom(dt);
    this._updateParticles(dt);

    // Selection ring + ghost follow hover/focus.
    const sel = this.hover.r >= 0 ? this.hover : this.focusCell;
    if (this.cells && sel.r >= 0) {
      const p = this.cellPos(sel.r, sel.c, this._tmpV);
      this.ring.visible = true;
      this.ring.position.set(p.x, 0.24 + (this.cellState[sel.r * this.cols + sel.c]?.lift || 0), p.z);
      const pulse = this.reducedMotion ? 1 : 1 + Math.sin(this.time * 5) * 0.06;
      this.ring.scale.setScalar(pulse);
      this.ring.material.color.set(this.theme?.accent ?? 0xffffff);
      const cellVal = grid ? grid[sel.r * this.cols + sel.c] : 0;
      this.ghost.visible = cellVal === CELL.UNKNOWN;
      if (this.ghost.visible) {
        this.ghost.position.set(p.x, 0.05, p.z);
        this.ghost.material.color.set(this.ghostMode === 'fill' ? (this.theme?.lit ?? 0xffc978) : 0x8899bb);
      }
    } else {
      this.ring.visible = false;
      this.ghost.visible = false;
    }

    // Nothing to draw while the playfield is hidden (title and menus).
    const w = this.canvas.clientWidth, h = this.canvas.clientHeight;
    if (!w || !h) return;
    const rescale = this._adapt(dt * 1000);
    if (rescale) this.size = [0, 0];
    this._applySize(w, h);
    const key = this._postKey(w, h);
    if (key !== this.postKey) {
      this.postKey = key;
      this._buildPost(w, h);
    }
    if (this.composer) {
      try { this.composer.render(dt); } catch (e) {
        this.postFailed = true;
        this.composer = null;
        this.renderer.setRenderTarget(null);
        this.renderer.render(this.scene, this.camera);
      }
    } else this.renderer.render(this.scene, this.camera);
  }

  // Project a board cell to CSS-pixel coordinates relative to the canvas.
  // The DOM layer uses this to keep semantic controls aligned with the 3D board.
  projectCell(r, c) {
    const rect = this.canvas.getBoundingClientRect();
    const p = this.cellPos(r, c, this._tmpV).clone();
    p.y = 0.2;
    p.project(this.camera);
    return {
      x: (p.x * 0.5 + 0.5) * rect.width,
      y: (-p.y * 0.5 + 0.5) * rect.height,
    };
  }

  // Project every cell center to CSS px relative to the canvas. The DOM layer
  // positions its semantic controls per cell: perspective makes the projected
  // board a trapezoid, so a single uniform rect can never line up with it.
  projectCells() {
    if (!this.cells) return null;
    const rect = this.canvas.getBoundingClientRect();
    const centers = new Float32Array(this.rows * this.cols * 2);
    const p = this._tmpV;
    for (let r = 0; r < this.rows; r++) {
      for (let c = 0; c < this.cols; c++) {
        this.cellPos(r, c, p);
        p.y = 0.2;
        p.project(this.camera);
        const i = (r * this.cols + c) * 2;
        centers[i] = (p.x * 0.5 + 0.5) * rect.width;
        centers[i + 1] = (-p.y * 0.5 + 0.5) * rect.height;
      }
    }
    return { rows: this.rows, cols: this.cols, centers };
  }

  resize(width, height) {
    this._applySize(width, height);
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
    // A narrower view may no longer fit the board: pull back until it does.
    const fit = this._fitDistance();
    if (this.transition) this.transition.to.dist = Math.max(this.transition.to.dist, fit);
    else if (this.cameraPose.dist < fit) this.cameraPose.dist = fit;
    this._updateCamera();
  }

  setReducedMotion(v) { this.reducedMotion = v; }

  dispose() {
    this.disposed = true;
    this.scene.traverse(o => {
      if (o.geometry) o.geometry.dispose();
      if (o.material) {
        if (Array.isArray(o.material)) o.material.forEach(m => m.dispose());
        else o.material.dispose();
      }
    });
    this.composer?.dispose();
    this._env?.dispose();
    for (const k of ['cellGeoPlain', 'cellGeoDetailed', 'cellMatPlain', 'cellMatDetailed']) this[k]?.dispose();
    this._sprite.dispose(); this._grainTex.dispose(); this._groundTex.dispose();
    this.renderer.dispose();
  }
}

// ---------------------------------------------------------------------------
// Procedural flora builders — original authored shapes per theme.
// ---------------------------------------------------------------------------

function makeFlora(theme, rng, detailed = false) {
  const group = new THREE.Group();
  const bloomColors = (theme?.bloom || ['#ffc978']).map(c => new THREE.Color(c));
  const pick = () => bloomColors[rng.int(0, bloomColors.length - 1)];
  // Detailed flora: satin surfaces with a touch more inner light (reads through bloom).
  const mat = (color, emissive = 0) => new THREE.MeshStandardMaterial({
    color, roughness: detailed ? 0.5 : 0.7, metalness: 0.05, envMapIntensity: 0.4,
    emissive: color, emissiveIntensity: detailed ? emissive * 1.25 : emissive,
    flatShading: detailed,
  });

  switch (theme?.flora) {
    case 'blossom': {
      const trunk = new THREE.Mesh(new THREE.CylinderGeometry(0.06, 0.1, 1.1, 6), mat(new THREE.Color(theme.slab).multiplyScalar(0.7)));
      trunk.position.y = 0.55;
      group.add(trunk);
      for (let i = 0; i < 4; i++) {
        const puff = new THREE.Mesh(new THREE.IcosahedronGeometry(0.28 + rng.float() * 0.14, 0), mat(pick(), 0.25));
        puff.position.set((rng.float() - 0.5) * 0.6, 1.1 + rng.float() * 0.5, (rng.float() - 0.5) * 0.6);
        group.add(puff);
      }
      break;
    }
    case 'coral': {
      let y = 0, x = 0, z = 0;
      for (let i = 0; i < 4; i++) {
        const seg = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.08, 0.5, 5), mat(pick(), 0.3));
        x += (rng.float() - 0.5) * 0.3; z += (rng.float() - 0.5) * 0.3; y += 0.32;
        seg.position.set(x, y, z);
        seg.rotation.set((rng.float() - 0.5) * 0.7, 0, (rng.float() - 0.5) * 0.7);
        group.add(seg);
      }
      break;
    }
    case 'lantern': {
      const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.03, 0.05, 1.3, 5), mat(new THREE.Color(theme.slab)));
      pole.position.y = 0.65;
      group.add(pole);
      const bulb = new THREE.Mesh(new THREE.SphereGeometry(0.2, 10, 8), mat(pick(), 0.9));
      bulb.position.y = 1.35;
      group.add(bulb);
      break;
    }
    case 'fern': {
      for (let i = 0; i < 3; i++) {
        const tier = new THREE.Mesh(new THREE.ConeGeometry(0.42 - i * 0.11, 0.34, 7), mat(pick(), 0.15));
        tier.position.y = 0.3 + i * 0.3;
        group.add(tier);
      }
      break;
    }
    case 'crystal':
    default: {
      const c = new THREE.Mesh(new THREE.OctahedronGeometry(0.32 + rng.float() * 0.12, 0), mat(pick(), 0.55));
      c.position.y = 0.45;
      c.rotation.set(rng.float(), rng.float(), rng.float());
      group.add(c);
      const c2 = new THREE.Mesh(new THREE.OctahedronGeometry(0.18, 0), mat(pick(), 0.55));
      c2.position.set(0.3, 0.2, 0.1);
      group.add(c2);
      break;
    }
  }
  return group;
}
