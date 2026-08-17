// Picture Logic — Three.js presentation layer.
// A minimalist light-board that blooms into a tiny scene. Rendering consumes
// immutable snapshots plus events; it never mutates rules state. Layers:
// environment / gameplay cells / selection+ghosts / effects / UI anchors.
'use strict';

import * as THREE from './vendor/three.module.js';
import { Rng } from './prng.js';
import { CELL } from './rules.js';

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

const QUALITY = {
  low:    { shadows: 0,    pixelRatioCap: 1.0, flora: 4,  particles: 160, envDetail: 0.4 },
  medium: { shadows: 1024, pixelRatioCap: 1.5, flora: 9,  particles: 320, envDetail: 0.7 },
  high:   { shadows: 2048, pixelRatioCap: 2.0, flora: 16, particles: 640, envDetail: 1.0 },
};

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
    this.quality = QUALITY[opts.quality] || QUALITY.medium;
    this.qualityName = opts.quality || 'medium';
    this.reducedMotion = !!opts.reducedMotion;
    this.theme = opts.theme;
    this.onCellHover = opts.onCellHover || (() => {});
    this.onCellActivate = opts.onCellActivate || (() => {});
    this.renderScale = 1.0;

    this.renderer = new THREE.WebGLRenderer({
      canvas, antialias: this.qualityName !== 'low', alpha: false,
      powerPreference: 'default',
    });
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.05;
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    if (this.quality.shadows) {
      this.renderer.shadowMap.enabled = true;
      this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    }

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
    this._buildSelectionAids();
    this._applyTheme(opts.theme);

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
    const q = this.quality;
    this.keyLight = new THREE.DirectionalLight(0xfff2dd, 2.6);
    this.keyLight.position.set(6, 12, 4);
    if (q.shadows) {
      this.keyLight.castShadow = true;
      this.keyLight.shadow.mapSize.set(q.shadows, q.shadows);
      this.keyLight.shadow.camera.left = -12; this.keyLight.shadow.camera.right = 12;
      this.keyLight.shadow.camera.top = 12; this.keyLight.shadow.camera.bottom = -12;
      this.keyLight.shadow.bias = -0.0004;
    }
    this.scene.add(this.keyLight);
    this.hemi = new THREE.HemisphereLight(0x8fa3c8, 0x1c2233, 0.85);
    this.scene.add(this.hemi);
    this.rim = new THREE.DirectionalLight(0x88aaff, 0.5);
    this.rim.position.set(-6, 4, -8);
    this.scene.add(this.rim);

    // Ground disc — contact grounding for the slab.
    const groundGeo = new THREE.CircleGeometry(40, 48);
    this.groundMat = new THREE.MeshStandardMaterial({ color: 0x232c40, roughness: 0.95, metalness: 0 });
    this.ground = new THREE.Mesh(groundGeo, this.groundMat);
    this.ground.rotation.x = -Math.PI / 2;
    this.ground.position.y = -0.55;
    this.ground.receiveShadow = !!q.shadows;
    this.scene.add(this.ground);

    this.scene.fog = new THREE.Fog(0x2a3550, 26, 70);
    this.floraGroup = new THREE.Group();
    this.scene.add(this.floraGroup);
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
    if (this.cellMat) this._refreshAllCellColors();
  }

  // Original procedural flora — small sculptures ringing the board.
  _buildFlora(theme) {
    // Dispose previous flora explicitly.
    this.floraGroup.traverse(o => { if (o.geometry) o.geometry.dispose(); if (o.material) o.material.dispose(); });
    this.floraGroup.clear();
    const rng = new Rng((this.boardSeed ?? 7) ^ 0xF10A, 'decor');
    const n = Math.round(this.quality.flora * this.quality.envDetail) || 2;
    const radius = () => Math.max(this.cols || 8, this.rows || 8) * 0.72 + 2.2;
    for (let i = 0; i < n; i++) {
      const ang = (i / n) * Math.PI * 2 + rng.float() * 0.5;
      const dist = radius() + rng.float() * 2.5;
      const g = makeFlora(theme, rng);
      g.position.set(Math.cos(ang) * dist, -0.55, Math.sin(ang) * dist);
      g.rotation.y = rng.float() * Math.PI * 2;
      const s = 0.7 + rng.float() * 0.7;
      g.scale.setScalar(s);
      g.userData.swayPhase = rng.float() * Math.PI * 2;
      this.floraGroup.add(g);
    }
  }

  // -------------------------------------------------------------------------
  // Board construction
  // -------------------------------------------------------------------------

  setBoard(rows, cols, seed) {
    this.rows = rows; this.cols = cols; this.boardSeed = seed;
    if (this.cells) {
      this.scene.remove(this.cells);
      this.cells.geometry.dispose(); this.cells.material.dispose();
      this.scene.remove(this.slab);
      this.slab.geometry.dispose(); this.slab.material.dispose();
    }
    const q = this.quality;
    // Slab the cells sit in.
    const w = cols + FRAMING.boardPad * 2, h = rows + FRAMING.boardPad * 2;
    this.slabMat = new THREE.MeshStandardMaterial({ color: this.theme?.slab ?? 0x2e3852, roughness: 0.6, metalness: 0.08 });
    this.slab = new THREE.Mesh(new THREE.BoxGeometry(w, 0.5, h), this.slabMat);
    this.slab.position.y = -0.26;
    this.slab.receiveShadow = !!q.shadows;
    this.scene.add(this.slab);

    const cellGeo = new THREE.BoxGeometry(0.84, 0.34, 0.84);
    this.cellMat = new THREE.MeshStandardMaterial({
      color: 0xffffff, roughness: 0.45, metalness: 0.05,
      emissive: 0x000000,
    });
    this.cells = new THREE.InstancedMesh(cellGeo, this.cellMat, rows * cols);
    this.cells.castShadow = !!q.shadows;
    this.cells.receiveShadow = !!q.shadows;
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
    this.bloomT = -1;

    // Reframe camera for the new board size.
    const maxDim = Math.max(rows, cols);
    const dist = Math.max(FRAMING.minDistance, maxDim * FRAMING.distancePerCell + 2.5);
    const to = { dist, pitch: FRAMING.pitch, yaw: 0, y: 0 };
    if (this.reducedMotion) {
      this.cameraPose = to;
    } else {
      this._startTransition({ ...to, dist: dist * 1.35, pitch: FRAMING.pitch + 0.35 }, to, FRAMING.introDuration, easeOutCubic);
    }
    this._updateCamera();
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
    const max = this.quality.particles;
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
    const mat = new THREE.PointsMaterial({
      size: 0.09, vertexColors: true, transparent: true, opacity: 0.9,
      depthWrite: false, sizeAttenuation: true,
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
    const dist = Math.max(FRAMING.minDistance, Math.max(this.rows, this.cols) * FRAMING.distancePerCell + 4.5);
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
    const maxDim = Math.max(this.rows || 8, this.cols || 8);
    const dist = Math.max(FRAMING.minDistance, maxDim * FRAMING.distancePerCell + 2.5);
    this._startTransition({ ...this.cameraPose }, { dist, pitch: FRAMING.pitch, yaw: 0, y: 0 }, 0.6, easeOutCubic);
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

    // Flora sway.
    for (const f of this.floraGroup.children) {
      f.rotation.z = this.reducedMotion ? 0 : Math.sin(this.time * 0.8 + f.userData.swayPhase) * 0.03;
    }

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
      }
      this.cells.instanceMatrix.needsUpdate = true;
      if (this.cells.instanceColor) this.cells.instanceColor.needsUpdate = true;
      // Emissive pulse on lit cells via material (cheap, no per-instance cost).
      this.cellMat.emissive.set(this.theme?.litEmissive ?? 0x000000);
      this.cellMat.emissiveIntensity = this.reducedMotion ? 0.25 : 0.22 + Math.sin(this.time * 2.1) * 0.08;
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

    this.renderer.render(this.scene, this.camera);
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

  // Board bounds in CSS px (corners of the outer cell grid).
  boardScreenRect() {
    if (!this.cells) return null;
    const tl = this.projectCell(0, 0);
    const br = this.projectCell(this.rows - 1, this.cols - 1);
    const tr = this.projectCell(0, this.cols - 1);
    const bl = this.projectCell(this.rows - 1, 0);
    const cellW = Math.abs(tr.x - tl.x) / Math.max(1, this.cols - 1 || 1);
    const cellH = Math.abs(bl.y - tl.y) / Math.max(1, this.rows - 1 || 1);
    const left = Math.min(tl.x, bl.x) - cellW / 2;
    const top = Math.min(tl.y, tr.y) - cellH / 2;
    return {
      left, top,
      width: Math.abs(tr.x - tl.x) + cellW,
      height: Math.abs(bl.y - tl.y) + cellH,
      cellW, cellH,
    };
  }

  resize(width, height) {
    this.renderer.setSize(width, height, false);
    const pr = Math.min(window.devicePixelRatio || 1, this.quality.pixelRatioCap) * this.renderScale;
    this.renderer.setPixelRatio(pr);
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
    this._updateCamera();
  }

  setRenderScale(s) {
    this.renderScale = Math.max(0.5, Math.min(1, s));
    const size = this.renderer.getSize(new THREE.Vector2());
    this.resize(size.x, size.y);
  }

  setReducedMotion(v) { this.reducedMotion = v; }

  setQuality(name) {
    if (name === this.qualityName) return;
    // Quality changes are applied by main via a rebuild (antialias is an
    // init-time flag), never mid-round visual truth changes.
    this.qualityName = name;
    this.quality = QUALITY[name] || QUALITY.medium;
  }

  dispose() {
    this.disposed = true;
    this.scene.traverse(o => {
      if (o.geometry) o.geometry.dispose();
      if (o.material) {
        if (Array.isArray(o.material)) o.material.forEach(m => m.dispose());
        else o.material.dispose();
      }
    });
    this.renderer.dispose();
  }
}

// ---------------------------------------------------------------------------
// Procedural flora builders — original authored shapes per theme.
// ---------------------------------------------------------------------------

function makeFlora(theme, rng) {
  const group = new THREE.Group();
  const bloomColors = (theme?.bloom || ['#ffc978']).map(c => new THREE.Color(c));
  const pick = () => bloomColors[rng.int(0, bloomColors.length - 1)];
  const mat = (color, emissive = 0) => new THREE.MeshStandardMaterial({
    color, roughness: 0.7, metalness: 0.05,
    emissive: color, emissiveIntensity: emissive,
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
