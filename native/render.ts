// The light-board on starhermit:scene, as the browser build's js/render3d.js
// drew it with three.js r160: the slab with its cells (an instanced mesh:
// per-cell lift springs, colours and the per-instance glow that makes only
// lit cells emit — the old onBeforeCompile patch as WGSL hooks), the
// bevelled clear-coat cells, grained slab, light rim, ground pool and fuller
// flora ring of Board detail Detailed, the procedural flora per theme, the
// selection ring and hover ghost, the pooled bursts, the drifting motes and
// flora sway (Ambient motion), the win bloom that turns the picture into
// the theme's colours, the authored perspective camera (intro swoop, win
// orbit, reset, the fit that keeps every cell and the row clues on screen,
// panning the board right when the clues need room), the camera shake, and
// the warm key light with soft shadows, the hemisphere fill and the cool
// rim. The old canvas filled the play area between the HUD, rails and tray:
// here the scene spans the window and the camera's view offset puts the
// board's view in that rectangle (the playfield); a probe camera of the
// playfield's own aspect does the fitting, projection and picking.
//
// From three.js r160 (physically based lights): colours as written, the
// punctual and hemisphere lights' intensities, shadow box and bias as the page
// set them (engine.minor 28). r160's composer drew the scene in linear half floats,
// GTAO, UnrealBloomPass (0.4 / 0.45 / threshold 0.85), the OutputPass (ACES
// at 1.05), then GradeShader in display space and SMAA / FXAA; the runtime's
// renderer.ao / bloom / grade ("display") / antialias do the same in that
// order. Per-material envMapIntensity with scene.environment is not applied
// at minor 20, so each lit material carries the environment map itself with
// its old intensity. Adaptive resolution, the pixel-ratio cap and the
// frame-rate readout are the runtime's. Rendering never touches the rules
// state.
import {
  ACESFilmicToneMapping, AdditiveBlending, BoxGeometry, BufferAttribute, BufferGeometry, CanvasTexture, CircleGeometry, Color,
  ConeGeometry, CylinderGeometry, DirectionalLight, DoubleSide, Fog, Group, HemisphereLight, IcosahedronGeometry, InstancedMesh,
  Matrix4, Mesh, MeshBasicMaterial, MeshLambertMaterial, MeshPhysicalMaterial, MeshStandardMaterial, OctahedronGeometry,
  OrthographicCamera, PerspectiveCamera, PMREMGenerator, Points, PointsMaterial, RepeatWrapping, RingGeometry, RoomEnvironment, RoundedBoxGeometry,
  SRGBColorSpace, SphereGeometry, Vector2, Vector3, Vector4, renderer, scene, type Material, type MaterialHooks, type Texture,
} from "starhermit:scene";
import { OffscreenCanvas, type OffscreenCanvasRenderingContext2D } from "starhermit:canvas";
import { CELL, Content, Rng, type GameEvent, type Theme } from "./game.ts";
import { particleCounts, type Look } from "./quality.ts";

/** render3d.js FRAMING: the authored framing constants. */
export const FRAMING = {
  fov: 32,
  pitch: 0.86,          // camera elevation (radians)
  shortPitch: 1.12,     // short landscape playfields (≤ 480 px tall): steeper, so far rows keep their height
  distancePerCell: 1.06,
  minDistance: 7.5,
  lookAhead: 0.35,      // bias toward the board's far edge
  boardPad: 1.15,       // world units of slab beyond the cell grid
  introDuration: 1.1,
  winDuration: 2.2,
};
/** render3d.js (r160) intensities as set (key 2.6 / 2.05 with reflections, hemisphere 0.85 / 0.5, rim 0.5). */
const LIGHT = { key: 2.6, keyIbl: 2.05, hemi: 0.85, hemiIbl: 0.5, rim: 0.5, exposure: 1.05 };
const FLORA_PLAIN = 3;


// ---------------------------------------------------------------- the fixed parts
const camera = new PerspectiveCamera(FRAMING.fov, 1, 0.1, 200);
const probe = new PerspectiveCamera(FRAMING.fov, 1, 0.1, 200);
const keyLight = new DirectionalLight(0xfff2dd, LIGHT.key);
keyLight.position.set(6, 12, 4);
keyLight.shadow.bias = -0.0004;
keyLight.shadow.normalBias = 0.02;
/** render3d.js's shadow frustum, fitted to the board plus its ring of flora. */
function fitShadowCamera(): void {
  const extent = Math.max(rows || 8, cols || 8) * 0.72 + 5.2;
  const cam = keyLight.shadow.camera as OrthographicCamera;
  Object.assign(cam, { left: -extent, right: extent, top: extent, bottom: -extent, near: 2, far: 34 });
  cam.updateProjectionMatrix();
}
const hemi = new HemisphereLight(0x8fa3c8, 0x1c2233, LIGHT.hemi);
const rim = new DirectionalLight(0x88aaff, LIGHT.rim);
rim.position.set(-6, 4, -8);
scene.add(keyLight, keyLight.target, hemi, rim);
scene.fog = new Fog(0x2a3550, 26, 70);

let look: Look | null = null;
let theme: Theme = Content.THEMES[0]!;
let reducedMotion = false;
let animTime = 0;
let ambientTime = 0;
let shake = 0;

// ---------------------------------------------------------------- canvas textures (render3d.js, unchanged drawing)
type Ctx = OffscreenCanvasRenderingContext2D;
function canvasTexture(size: number, drawFn: (g: Ctx, n: number) => void): CanvasTexture {
  const cv = new OffscreenCanvas(size, size);
  drawFn(cv.getContext("2d")!, size);
  const t = new CanvasTexture(cv);
  t.colorSpace = SRGBColorSpace;
  return t;
}
const spriteTex = canvasTexture(64, (g, n) => {
  const r = g.createRadialGradient(n / 2, n / 2, 0, n / 2, n / 2, n / 2);
  r.addColorStop(0, "rgba(255,255,255,1)");
  r.addColorStop(0.35, "rgba(255,255,255,0.55)");
  r.addColorStop(1, "rgba(255,255,255,0)");
  g.fillStyle = r; g.fillRect(0, 0, n, n);
});
/** Fine mottled grain for the slab (tinted by the material colour), authored at 256 px. */
function makeGrainTexture(size: number): Texture {
  const rng = new Rng(0x51ab, "decor");
  const t = canvasTexture(size, (g, sz) => {
    const n = 256;
    g.scale(sz / n, sz / n);
    g.fillStyle = "#d8d8d8"; g.fillRect(0, 0, n, n);
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
  t.wrapS = t.wrapT = RepeatWrapping;
  return t;
}
/** The soft pool of light under the board. */
const groundTex = canvasTexture(256, (g, n) => {
  const r = g.createRadialGradient(n / 2, n / 2, 0, n / 2, n / 2, n / 2);
  r.addColorStop(0, "#ffffff");
  r.addColorStop(0.28, "#c9c9c9");
  r.addColorStop(1, "#6a6a6a");
  g.fillStyle = r; g.fillRect(0, 0, n, n);
});
let grainTex: Texture | null = null;
let grainSize = 0;

// ---------------------------------------------------------------- the environment
let envTex: Texture | null = null;
function envMap(): Texture | null {
  if (!envTex) {
    // r160's page built the room without the renderer (the 5-candela room in r155–r162).
    try { const pageRoom = new RoomEnvironment(); pageRoom.position.y = 0; /* the page's three r160 (pre-r183) builds the room at the origin */ envTex = new PMREMGenerator(renderer).fromScene(pageRoom, 0.04).texture; }
    catch (e) { console.warn(`environment: ${e instanceof Error ? e.message : String(e)}`); }
  }
  return envTex;
}
/** The material's own environment map at its r160 intensity (reflections on), else none. */
function withEnv<M extends MeshStandardMaterial>(m: M, intensity: number): M {
  const on = !!look?.reflections;
  m.envMap = on ? envMap() : null;
  m.envMapIntensity = intensity;
  return m;
}
const groundMat = new MeshStandardMaterial({ color: 0x232c40, roughness: 0.95, metalness: 0 });
const ground = new Mesh(new CircleGeometry(40, 48), groundMat);
ground.rotation.x = -Math.PI / 2;
ground.position.y = -0.55;
scene.add(ground);
const floraGroup = new Group();
scene.add(floraGroup);

// ---------------------------------------------------------------- the board
let rows = 0, cols = 0, boardSeed = 7;
fitShadowCamera();
let grid: number[] | null = null;
let cells: InstancedMesh | null = null;
let cellGeoPlain: BufferGeometry | null = null, cellGeoDetailed: BufferGeometry | null = null;
let cellMatPlain: MeshStandardMaterial | MeshLambertMaterial | null = null, cellMatDetailed: MeshStandardMaterial | MeshLambertMaterial | null = null;
let cellMat: MeshStandardMaterial | MeshLambertMaterial | null = null;
let slab: Mesh | null = null, slabMat: MeshStandardMaterial | null = null;
let rimStrips: Group | null = null, rimMat: MeshStandardMaterial | null = null;
interface CellView {
  lift: number; liftVel: number; targetLift: number; glow: number; glowVel: number; targetGlow: number;
  flash: number; flashColor: Color; color: Color; targetColor: Color; phase: number; bloomed: boolean;
}
let cellState: CellView[] = [];
let bloomT = -1;

/** patchCellGlow: lit cells glow in their own colour (instance colour × the instance's glow), unlit cells never. */
const GLOW_HOOKS: MaterialHooks = {
  vertex: "fn vertex(v: Vertex) -> Vertex { var o = v; o.v0 = vec4f(v.instance.x, 0.0, 0.0, 0.0); return o; }",
  surface: "fn surface(s: Surface) -> Surface { var o = s; o.emissive = s.emissive * s.color.rgb * max(s.v0.x, 0.0); return o; }",
};

const cellPos = (r: number, c: number, out = new Vector3()): Vector3 => out.set(c - (cols - 1) / 2, 0, r - (rows - 1) / 2);

/** _buildCellAssets: bevel segments on detailed cells; Lambert on Low, Standard on Balanced (and plain cells), clear-coated Physical on High/Ultra. */
function buildCellAssets(): void {
  const b = look!.budget;
  const old: { dispose(): void }[] = [cellGeoPlain, cellGeoDetailed, cellMatPlain, cellMatDetailed].filter((x): x is NonNullable<typeof x> => !!x);
  cellGeoPlain = new BoxGeometry(0.84, 0.34, 0.84);
  cellGeoDetailed = new RoundedBoxGeometry(0.84, 0.34, 0.84, b.bevel, 0.07);
  const lambert = (): MeshLambertMaterial => new MeshLambertMaterial({ color: 0xffffff, emissive: 0xffffff, hooks: GLOW_HOOKS });
  const standard = (): MeshStandardMaterial => withEnv(new MeshStandardMaterial({ color: 0xffffff, roughness: 0.45, metalness: 0.05, emissive: 0xffffff, hooks: GLOW_HOOKS }), 1);
  cellMatPlain = b.material === "lambert" ? lambert() : standard();
  cellMatDetailed = b.material === "lambert" ? lambert()
    : b.material === "standard" ? withEnv(new MeshStandardMaterial({ color: 0xffffff, roughness: 0.4, metalness: 0.02, emissive: 0xffffff, hooks: GLOW_HOOKS }), 0.4)
      : withEnv(new MeshPhysicalMaterial({
        color: 0xffffff, roughness: 0.38, metalness: 0.02, emissive: 0xffffff, clearcoat: 0.7, clearcoatRoughness: 0.22, hooks: GLOW_HOOKS,
      }), 0.4);
  if (cells) {
    const detailed = look!.detailed;
    cells.geometry = detailed ? cellGeoDetailed : cellGeoPlain;
    cells.material = cellMat = detailed ? cellMatDetailed : cellMatPlain;
  }
  for (const o of old) o.dispose();
}

/** _rebuildSlab: the slab the cells sit in; detailed adds bevels, grain and the thin light rim. */
function rebuildSlab(): void {
  if (!rows || !look) return;
  if (slab) { scene.remove(slab); slab.geometry.dispose(); slabMat?.dispose(); slab = null; }
  if (rimStrips) {
    scene.remove(rimStrips);
    for (const m of rimStrips.children) (m as Mesh).geometry.dispose();
    rimMat?.dispose();
    rimStrips = null;
  }
  const detailed = look.detailed;
  const w = cols + FRAMING.boardPad * 2, h = rows + FRAMING.boardPad * 2;
  slabMat = withEnv(new MeshStandardMaterial({ color: own(theme.slab), roughness: detailed ? 0.72 : 0.6, metalness: 0.08 }), 0.35);
  if (detailed && grainTex) {
    slabMat.map = grainTex;
    slabMat.roughnessMap = grainTex;
    grainTex.repeat.set(w / 6, h / 6);
  }
  const geo = detailed ? new RoundedBoxGeometry(w, 0.5, h, 3, 0.16) : new BoxGeometry(w, 0.5, h);
  slab = new Mesh(geo, slabMat);
  slab.position.y = -0.26;
  scene.add(slab);
  if (detailed) {
    rimMat = new MeshStandardMaterial({ color: 0x000000, emissive: own(theme.accent), emissiveIntensity: 0.6, roughness: 0.5 });
    rimStrips = new Group();
    const gx = cols / 2 + 0.34, gz = rows / 2 + 0.34, t = 0.045;
    const strip = (sx: number, sz: number, x: number, z: number): void => {
      const m = new Mesh(new BoxGeometry(sx, 0.03, sz), rimMat!);
      m.position.set(x, 0, z);
      rimStrips!.add(m);
    };
    strip(gx * 2 + t, t, 0, -gz); strip(gx * 2 + t, t, 0, gz);
    strip(t, gz * 2 + t, -gx, 0); strip(t, gz * 2 + t, gx, 0);
    scene.add(rimStrips);
  }
  applyShadowFlags();
}

function applyShadowFlags(): void {
  const on = renderer.shadowMap.enabled;
  ground.receiveShadow = on;
  if (slab) slab.receiveShadow = on;
  if (cells) { cells.castShadow = on; cells.receiveShadow = on; }
  // Flora stays out of the shadow map: its floating puffs cast distracting blots.
}

/** Clears the board (back to the menus). */
export function clearBoard(): void {
  if (cells) { scene.remove(cells); cells = null; }
  if (slab) slab.visible = false;
  if (rimStrips) rimStrips.visible = false;
  rows = 0; cols = 0; grid = null;
  cellState = [];
  bloomT = -1;
  ring.visible = false;
  ghost.visible = false;
}

/** setBoard: a new board (size and seed), the camera swooping in from above. */
export function setBoard(r: number, c: number, seed: number): void {
  rows = r; cols = c; boardSeed = seed;
  fitShadowCamera();
  if (cells) scene.remove(cells);
  cells = null;
  if (!look) return;
  rebuildSlab();
  buildCellAssets();
  const detailed = look.detailed;
  cellMat = detailed ? cellMatDetailed! : cellMatPlain!;
  cells = new InstancedMesh(detailed ? cellGeoDetailed! : cellGeoPlain!, cellMat, r * c);
  cells.customSlots = 1;
  cells.frustumCulled = false;
  scene.add(cells);
  cellState = [];
  for (let i = 0; i < r * c; i++) {
    cellState.push({
      lift: 0, liftVel: 0, targetLift: 0, glow: 0, glowVel: 0, targetGlow: 0, flash: 0, flashColor: new Color(0xffffff),
      color: new Color(theme.cell), targetColor: new Color(theme.cell), phase: (i * 0.6180339) % 1, bloomed: false,
    });
  }
  writeCells(0);
  buildFlora();
  applyShadowFlags();
  bloomT = -1;
  // Reframe for the new board size.
  const dist = preferredDistance();
  const to = { dist, pitch: restPitch(), yaw: 0, y: 0 };
  if (reducedMotion) { pose = to; transition = null; }
  else startTransition({ ...to, dist: dist * 1.35, pitch: Math.min(1.35, to.pitch + 0.35) }, to, FRAMING.introDuration, easeOutCubic);
  updateCamera();
}

/** syncState: views follow a rules snapshot plus presentation events. */
export function syncState(g: number[], r: number, c: number, events: GameEvent[] = []): void {
  grid = g;
  if (!cells || r !== rows || c !== cols) return;
  for (let i = 0; i < g.length; i++) {
    const st = cellState[i]!;
    const v = g[i];
    if (v === CELL.FILLED) { st.targetLift = 0.16; st.targetGlow = 1; st.targetColor.set(theme.lit); }
    else if (v === CELL.MARKED) { st.targetLift = -0.06; st.targetGlow = 0; st.targetColor.set(theme.cell).multiplyScalar(0.55); }
    else { st.targetLift = 0; st.targetGlow = 0; st.targetColor.set(theme.cell); }
  }
  const tmp = new Vector3();
  for (const ev of events) {
    if (ev.type === "fill" && ev.r != null && ev.c != null) {
      const st = cellState[ev.r * cols + ev.c]!;
      st.flash = 1; st.flashColor.set(theme.litEmissive);
      spawnBurst(cellPos(ev.r, ev.c, tmp), theme.lit, 8);
    } else if (ev.type === "mistake" && ev.r != null && ev.c != null) {
      const st = cellState[ev.r * cols + ev.c]!;
      st.flash = 1; st.flashColor.set(0xff4444);
      if (!reducedMotion) shake = Math.min(0.5, shake + 0.22);
    } else if (ev.type === "propagate") {
      for (const cell of ev.cells ?? []) spawnBurst(cellPos(cell.r, cell.c, tmp), theme.accent, 2);
    } else if (ev.type === "hint" && ev.r != null && ev.c != null) {
      const st = cellState[ev.r * cols + ev.c]!;
      st.flash = 1; st.flashColor.set(theme.accent);
      spawnBurst(cellPos(ev.r, ev.c, tmp), theme.accent, 10);
    } else if (ev.type === "terminal" && ev.status === "complete") startBloom();
  }
}

/** Copies Color objects so materials never share one (three copies; the engine keeps the object). */
function own<T>(v: T): T { return v && typeof (v as { clone?: unknown }).clone === "function" ? (v as unknown as { clone(): T }).clone() : v; }
// ---------------------------------------------------------------- flora (render3d.js makeFlora: original shapes per theme)
function makeFlora(rng: InstanceType<typeof Rng>, detailed: boolean): Group {
  const group = new Group();
  const bloomColors = theme.bloom.map((c) => new Color(c));
  const pick = (): Color => bloomColors[rng.int(0, bloomColors.length - 1)]!;
  const mat = (color: Color, emissive = 0): MeshStandardMaterial => withEnv(new MeshStandardMaterial({
    color: own(color), roughness: detailed ? 0.5 : 0.7, metalness: 0.05, emissive: own(color), emissiveIntensity: detailed ? emissive * 1.25 : emissive, flatShading: detailed,
  }), 0.4);
  switch (theme.flora) {
    case "blossom": {
      const trunk = new Mesh(new CylinderGeometry(0.06, 0.1, 1.1, 6), mat(new Color(theme.slab).multiplyScalar(0.7)));
      trunk.position.y = 0.55;
      group.add(trunk);
      for (let i = 0; i < 4; i++) {
        const puff = new Mesh(new IcosahedronGeometry(0.28 + rng.float() * 0.14, 0), mat(pick(), 0.25));
        puff.position.set((rng.float() - 0.5) * 0.6, 1.1 + rng.float() * 0.5, (rng.float() - 0.5) * 0.6);
        group.add(puff);
      }
      break;
    }
    case "coral": {
      let y = 0, x = 0, z = 0;
      for (let i = 0; i < 4; i++) {
        const seg = new Mesh(new CylinderGeometry(0.05, 0.08, 0.5, 5), mat(pick(), 0.3));
        x += (rng.float() - 0.5) * 0.3; z += (rng.float() - 0.5) * 0.3; y += 0.32;
        seg.position.set(x, y, z);
        seg.rotation.set((rng.float() - 0.5) * 0.7, 0, (rng.float() - 0.5) * 0.7);
        group.add(seg);
      }
      break;
    }
    case "lantern": {
      const pole = new Mesh(new CylinderGeometry(0.03, 0.05, 1.3, 5), mat(new Color(theme.slab)));
      pole.position.y = 0.65;
      group.add(pole);
      const bulb = new Mesh(new SphereGeometry(0.2, 10, 8), mat(pick(), 0.9));
      bulb.position.y = 1.35;
      group.add(bulb);
      break;
    }
    case "fern": {
      for (let i = 0; i < 3; i++) {
        const tier = new Mesh(new ConeGeometry(0.42 - i * 0.11, 0.34, 7), mat(pick(), 0.15));
        tier.position.y = 0.3 + i * 0.3;
        group.add(tier);
      }
      break;
    }
    default: {
      const c = new Mesh(new OctahedronGeometry(0.32 + rng.float() * 0.12, 0), mat(pick(), 0.55));
      c.position.y = 0.45;
      c.rotation.set(rng.float(), rng.float(), rng.float());
      group.add(c);
      const c2 = new Mesh(new OctahedronGeometry(0.18, 0), mat(pick(), 0.55));
      c2.position.set(0.3, 0.2, 0.1);
      group.add(c2);
      break;
    }
  }
  return group;
}
function buildFlora(): void {
  for (const g of [...floraGroup.children]) {
    g.traverse((o) => { const m = o as Mesh; if (m.geometry) m.geometry.dispose(); if (m.material) (m.material as Material).dispose(); });
    floraGroup.remove(g);
  }
  if (!look) return;
  const rng = new Rng((boardSeed ^ 0xf10a) >>> 0, "decor");
  const detailed = look.detailed;
  const n = detailed ? look.budget.flora : FLORA_PLAIN;
  const radius = Math.max(cols || 8, rows || 8) * 0.72 + 2.2;
  for (let i = 0; i < n; i++) {
    const ang = (i / n) * Math.PI * 2 + rng.float() * 0.5;
    const dist = radius + rng.float() * 2.5;
    const g = makeFlora(rng, detailed);
    g.position.set(Math.cos(ang) * dist, -0.55, Math.sin(ang) * dist);
    g.rotation.y = rng.float() * Math.PI * 2;
    g.scale.setScalar(0.7 + rng.float() * 0.7);
    g.userData.swayPhase = rng.float() * Math.PI * 2;
    floraGroup.add(g);
  }
}

// ---------------------------------------------------------------- selection aids
const ring = new Mesh(new RingGeometry(0.42, 0.52, 40), new MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.85, side: DoubleSide }));
ring.rotation.x = -Math.PI / 2;
ring.visible = false;
scene.add(ring);
const ghost = new Mesh(new BoxGeometry(0.84, 0.36, 0.84), new MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.35, depthWrite: false }));
ghost.visible = false;
scene.add(ghost);
let hover = { r: -1, c: -1 };
let focusCell = { r: -1, c: -1 };
let ghostMode: "fill" | "mark" = "fill";
export function setHover(r: number, c: number, mode: "fill" | "mark"): void { hover = { r, c }; ghostMode = mode; }
export function setFocusCell(r: number, c: number): void { focusCell = { r, c }; }

// ---------------------------------------------------------------- particles (one pooled cloud) and motes
let points: Points | null = null;
let pMax = 0, pHead = 0;
let pPos = new Float32Array(0), pVel = new Float32Array(0), pLife = new Float32Array(0), pCol = new Float32Array(0);
let pRng = new Rng(0xbeef, "fx");
function buildParticles(): void {
  const max = particleCounts(look!).pool;
  if (points && max === pMax) return;
  if (points) { scene.remove(points); points.geometry.dispose(); (points.material as Material).dispose(); }
  pMax = max;
  pPos = new Float32Array(max * 3); pVel = new Float32Array(max * 3); pLife = new Float32Array(max); pCol = new Float32Array(max * 3);
  pHead = 0;
  for (let i = 0; i < max; i++) pPos[i * 3 + 1] = -50; // parked out of view
  const geo = new BufferGeometry();
  geo.setAttribute("position", new BufferAttribute(pPos, 3));
  geo.setAttribute("color", new BufferAttribute(pCol, 3));
  points = new Points(geo, new PointsMaterial({
    size: 0.16, map: spriteTex, vertexColors: true, transparent: true, opacity: 0.95, depthWrite: false, sizeAttenuation: true, blending: AdditiveBlending,
  }));
  points.frustumCulled = false;
  scene.add(points);
  pRng = new Rng(0xbeef, "fx");
}
function spawnBurst(pos: Vector3, color: number | string, count: number): void {
  if (!points || !pMax) return;
  const c = new Color(color);
  const n = Math.min(count, Math.floor(pMax / 4));
  for (let k = 0; k < n; k++) {
    const i = pHead = (pHead + 1) % pMax;
    pPos[i * 3] = pos.x; pPos[i * 3 + 1] = pos.y + 0.25; pPos[i * 3 + 2] = pos.z;
    const a = pRng.float() * Math.PI * 2;
    const sp = 0.6 + pRng.float() * 1.6;
    pVel[i * 3] = Math.cos(a) * sp * 0.6;
    pVel[i * 3 + 1] = 1.2 + pRng.float() * 1.6;
    pVel[i * 3 + 2] = Math.sin(a) * sp * 0.6;
    pLife[i] = 0.7 + pRng.float() * 0.5;
    pCol[i * 3] = c.r; pCol[i * 3 + 1] = c.g; pCol[i * 3 + 2] = c.b;
  }
}
function updateParticles(dt: number): void {
  if (!points) return;
  let any = false;
  for (let i = 0; i < pMax; i++) {
    if (pLife[i]! <= 0) continue;
    any = true;
    pLife[i]! -= dt;
    pVel[i * 3 + 1]! -= 4.5 * dt;
    pPos[i * 3]! += pVel[i * 3]! * dt;
    pPos[i * 3 + 1]! += pVel[i * 3 + 1]! * dt;
    pPos[i * 3 + 2]! += pVel[i * 3 + 2]! * dt;
    if (pLife[i]! <= 0) pPos[i * 3 + 1] = -50;
  }
  if (any) {
    points.geometry.getAttribute("position")!.needsUpdate = true;
    points.geometry.getAttribute("color")!.needsUpdate = true;
  }
}
let motes: Points | null = null;
let moteN = -1;
let moteSeed = new Float32Array(0);
function buildMotes(): void {
  const n = particleCounts(look!).motes;
  const on = look!.ambient;
  if (motes && moteN === n) { motes.visible = on; return; }
  if (motes) { scene.remove(motes); motes.geometry.dispose(); (motes.material as Material).dispose(); }
  moteN = n;
  const rng = new Rng(0x40735, "decor");
  moteSeed = new Float32Array(n * 4);
  for (let i = 0; i < n; i++) {
    moteSeed[i * 4] = rng.float() * Math.PI * 2;
    moteSeed[i * 4 + 1] = 0.7 + rng.float() * 0.6;
    moteSeed[i * 4 + 2] = rng.float();
    moteSeed[i * 4 + 3] = 0.6 + rng.float() * 0.8;
  }
  const geo = new BufferGeometry();
  geo.setAttribute("position", new BufferAttribute(new Float32Array(Math.max(1, n) * 3), 3));
  geo.setAttribute("color", new BufferAttribute(new Float32Array(Math.max(1, n) * 3), 3));
  motes = new Points(geo, new PointsMaterial({
    size: 0.16, map: spriteTex, vertexColors: true, transparent: true, opacity: 0.75, depthWrite: false, blending: AdditiveBlending, sizeAttenuation: true,
  }));
  motes.frustumCulled = false;
  motes.visible = on;
  geo.setDrawRange(0, n);
  scene.add(motes);
  tintMotes();
  updateMotes(0, true);
}
function tintMotes(): void {
  if (!motes) return;
  const col = motes.geometry.getAttribute("color")!;
  const pal = theme.bloom.map((c) => new Color(c));
  for (let i = 0; i < moteN; i++) { const c = pal[i % pal.length]!; col.setXYZ(i, c.r, c.g, c.b); }
  col.needsUpdate = true;
}
function updateMotes(t: number, force = false): void {
  if (!motes || (!motes.visible && !force)) return;
  const pos = motes.geometry.getAttribute("position")!;
  const base = Math.max(cols || 8, rows || 8) * 0.72 + 1.2;
  const s = moteSeed;
  for (let i = 0; i < moteN; i++) {
    const a = s[i * 4]! + t * 0.03 * s[i * 4 + 3]!;
    const r = base * s[i * 4 + 1]! + 1.6 + Math.sin(t * 0.4 + s[i * 4]! * 3) * 0.3;
    const h = (s[i * 4 + 2]! + t * 0.035 * s[i * 4 + 3]!) % 1;
    pos.setXYZ(i, Math.cos(a) * r, -0.3 + h * 4.2, Math.sin(a) * r);
  }
  pos.needsUpdate = true;
}

// ---------------------------------------------------------------- the win bloom
function startBloom(): void {
  if (reducedMotion) { bloomT = 1; applyBloomFinal(); return; }
  bloomT = 0;
  const dist = preferredDistance() + 2;
  startTransition({ ...pose }, { dist, pitch: Math.min(1.35, restPitch() + 0.12), yaw: 0.35, y: 0 }, FRAMING.winDuration, easeInOut);
}
function applyBloomFinal(): void {
  for (let i = 0; i < cellState.length; i++) {
    const st = cellState[i]!;
    if (st.targetGlow > 0) { st.glow = 1.2; st.color.set(theme.bloom[i % theme.bloom.length]!); }
  }
}
const tmpC = new Color();
function updateBloom(dt: number): void {
  if (bloomT < 0 || bloomT >= 1) return;
  bloomT = Math.min(1, bloomT + dt / FRAMING.winDuration);
  const tmp = new Vector3();
  for (let i = 0; i < cellState.length; i++) {
    const st = cellState[i]!;
    if (st.targetGlow <= 0) continue;
    const local = Math.max(0, Math.min(1, bloomT * 1.6 - st.phase * 0.6));
    st.glow = 1 + local * 0.5;
    st.lift = st.targetLift + local * 0.22 * Math.sin(st.phase * Math.PI);
    const bc = theme.bloom[i % theme.bloom.length]!;
    if (local > 0.01) st.color.set(theme.lit).lerp(tmpC.set(bc), local * 0.8);
    if (local > 0.5 && !st.bloomed) {
      st.bloomed = true;
      spawnBurst(cellPos(Math.floor(i / cols), i % cols, tmp), bc, 3);
    }
  }
  if (bloomT >= 1) for (const st of cellState) st.bloomed = false;
}

// ---------------------------------------------------------------- the camera
interface Pose { dist: number; pitch: number; yaw: number; y: number }
let pose: Pose = { dist: 12, pitch: FRAMING.pitch, yaw: 0, y: 0 };
let transition: { from: Pose; to: Pose; t: number; duration: number; ease: (t: number) => number } | null = null;
let framePan = 0;
const easeOutCubic = (t: number): number => 1 - Math.pow(1 - t, 3);
const easeInOut = (t: number): number => (t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2);
function startTransition(from: Pose, to: Pose, duration: number, ease: (t: number) => number): void {
  if (reducedMotion || duration <= 0) { pose = { ...to }; transition = null; updateCamera(); return; }
  transition = { from: { ...from }, to: { ...to }, t: 0, duration, ease };
}
/** The camera reset action: back to the authored rest framing. */
export function resetCamera(): void {
  if (!rows) return;
  startTransition({ ...pose }, { dist: preferredDistance(), pitch: restPitch(), yaw: 0, y: 0 }, 0.6, easeOutCubic);
}
const target = new Vector3();
function updateCamera(): void {
  const d = pose.dist;
  const y = Math.sin(pose.pitch) * d;
  const hz = Math.cos(pose.pitch) * d;
  probe.position.set(Math.sin(pose.yaw) * hz + framePan, y + pose.y, Math.cos(pose.yaw) * hz);
  target.set(framePan, 0, -FRAMING.lookAhead);
  probe.lookAt(target);
  probe.updateMatrixWorld();
  // Narrow views of big boards pull the camera far back: the fog band slides with it (no change up to 40 units).
  const fog = scene.fog as Fog;
  const extra = Math.max(0, d - 40);
  fog.near = 26 + extra;
  fog.far = 70 + extra;
}

export interface Rect { x: number; y: number; width: number; height: number }
/** The playfield (window px), the safe insets carved out by the lesson banner (fractions of it) and the row clues' pixel width. */
let field: Rect = { x: 0, y: 0, width: 1, height: 1 };
let insets = { left: 0, right: 0, top: 0, bottom: 0, clueLeftPx: 0 };
function restPitch(): number {
  const w = field.width / scale, h = field.height / scale;
  return h && h <= 480 && w > h ? FRAMING.shortPitch : FRAMING.pitch;
}
let scale = 1;
function preferredDistance(): number {
  const maxDim = Math.max(rows || 8, cols || 8);
  const base = Math.max(FRAMING.minDistance, maxDim * FRAMING.distancePerCell + 2.5);
  return Math.max(base, fitDistance());
}
const tmpV = new Vector3();
/** _fitDistance: the smallest distance at which every outer cell corner projects inside the playfield's safe margins. */
function fitDistance(): number {
  const r = rows || 8, c = cols || 8;
  const corners: [number, number, number][] = [[-c / 2, 0.2, -r / 2], [c / 2, 0.2, -r / 2], [-c / 2, 0.2, r / 2], [c / 2, 0.2, r / 2]];
  const ins = insets;
  const xMin = -0.86 + 2 * ins.left, xMax = 0.86 - 2 * ins.right;
  const yMax = Math.min(0.58, 1 - 2 * ins.top - 0.04), yMin = Math.max(-0.92, -1 + 2 * ins.bottom + 0.04);
  const cw = field.width;
  const clueXMin = cw ? -1 + (2 * ins.clueLeftPx) / cw : -1;
  const saved = pose.dist;
  const fits = (dist: number): boolean => {
    pose.dist = dist;
    framePan = 0;
    updateCamera();
    const nl = tmpV.set(-c / 2, 0.2, r / 2).project(probe).x;
    const nr = tmpV.set(c / 2, 0.2, r / 2).project(probe).x;
    const need = Math.max(0, clueXMin - nl);
    if (need > 0 && nr > nl) { framePan = -need / ((nr - nl) / c); updateCamera(); }
    for (const [x, y, z] of corners) {
      const p = tmpV.set(x, y, z).project(probe);
      const xHi = framePan ? Math.max(xMax, 0.94 - 2 * ins.right) : xMax;
      if (p.x < xMin || p.x > xHi || p.y > yMax || p.y < yMin) return false;
      if (x < 0 && p.x < clueXMin - 0.005) return false;
    }
    return true;
  };
  let result = FRAMING.minDistance;
  if (!fits(result)) {
    let lo = FRAMING.minDistance, hi = 90;
    for (let i = 0; i < 24; i++) {
      const mid = (lo + hi) / 2;
      if (fits(mid)) hi = mid; else lo = mid;
    }
    result = hi;
  }
  fits(result); // leaves framePan set for the fitted distance
  pose.dist = saved;
  updateCamera();
  return result;
}
let fieldKey = "";
let lastRest = FRAMING.pitch;
/** The playfield rectangle (window px), the UI scale, the safe insets: refits the camera when they change (render3d.js resize / setSafeInsets). */
export function setField(rect: Rect, uiScale: number, ins: { left: number; right: number; top: number; bottom: number; clueLeftPx: number }): void {
  const key = `${Math.round(rect.x)}:${Math.round(rect.y)}:${Math.round(rect.width)}:${Math.round(rect.height)}:${uiScale}:${ins.left.toFixed(3)}:${ins.right.toFixed(3)}:${ins.top.toFixed(3)}:${ins.bottom.toFixed(3)}:${Math.round(ins.clueLeftPx)}:${rows}x${cols}`;
  if (key === fieldKey || rect.width < 2 || rect.height < 2) return;
  fieldKey = key;
  field = { ...rect };
  scale = uiScale;
  insets = { ...ins };
  probe.aspect = rect.width / rect.height;
  probe.updateProjectionMatrix();
  // Follow a rest-pitch change (rotation) unless the player's view moved off it.
  const restAfter = restPitch();
  if (restAfter !== lastRest) {
    if (transition && Math.abs(transition.to.pitch - lastRest) < 1e-6) transition.to.pitch = restAfter;
    else if (!transition && Math.abs(pose.pitch - lastRest) < 1e-6) pose.pitch = restAfter;
    lastRest = restAfter;
  }
  if (!rows) return;
  const fit = fitDistance();
  if (transition) transition.to.dist = Math.max(transition.to.dist, fit);
  else if (pose.dist < fit) pose.dist = fit;
  updateCamera();
}
let win = { w: 1, h: 1 };
/** The render camera: the probe's pose (plus the shake), its view offset placing the playfield in the window. */
function placeCamera(): void {
  camera.position.copy(probe.position);
  camera.quaternion.copy(probe.quaternion);
  if (shake > 0.001) {
    const s = shake * 0.05;
    camera.position.x += Math.sin(animTime * 47) * s;
    camera.position.y += Math.cos(animTime * 39) * s;
  }
  camera.aspect = field.width / field.height;
  camera.setViewOffset(field.width, field.height, -field.x, -field.y, win.w, win.h);
  camera.updateProjectionMatrix();
}

// ---------------------------------------------------------------- picking and projection
const ndc = new Vector2();
/** The cell under a window point (the board's top plane, y = 0.2, as the old cell buttons covered it), or null. */
export function pickCell(x: number, y: number): { r: number; c: number } | null {
  if (!rows || !cells) return null;
  ndc.set(((x - field.x) / field.width) * 2 - 1, -(((y - field.y) / field.height) * 2 - 1));
  if (Math.abs(ndc.x) > 1 || Math.abs(ndc.y) > 1) return null;
  const o = probe.position;
  const p = new Vector3(ndc.x, ndc.y, 0.5).unproject(probe).sub(o).normalize();
  if (Math.abs(p.y) < 1e-6) return null;
  const t = (0.2 - o.y) / p.y;
  if (t <= 0) return null;
  const wx = o.x + p.x * t, wz = o.z + p.z * t;
  const c = Math.round(wx + (cols - 1) / 2), r = Math.round(wz + (rows - 1) / 2);
  if (r < 0 || c < 0 || r >= rows || c >= cols) return null;
  return { r, c };
}
/** projectCells: every cell centre (top face) in window px, for the board overlay (clues, crosses, focus, named targets). */
export function projectCells(): { rows: number; cols: number; centers: Float32Array } | null {
  if (!rows || !cells) return null;
  const centers = new Float32Array(rows * cols * 2);
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      cellPos(r, c, tmpV);
      tmpV.y = 0.2;
      tmpV.project(probe);
      const i = (r * cols + c) * 2;
      centers[i] = field.x + (tmpV.x * 0.5 + 0.5) * field.width;
      centers[i + 1] = field.y + (-tmpV.y * 0.5 + 0.5) * field.height;
    }
  }
  return { rows, cols, centers };
}
/** Whether the camera is still moving (the overlay follows every frame then). */
export function moving(): boolean { return !!transition || shake > 0.001; }

/** _applyTheme: background, fog, ground, fill tint, flora, slab, rim and cell colours. */
function applyThemeColors(): void {
  // The post tiers tone-map the background through the post chain (engine.minor 29), as r160's composer did.
  scene.background = new Color(theme.sky);
  (scene.fog as Fog).color.set(theme.fog);
  groundMat.color.set(theme.ground);
  hemi.color.set(theme.cellEdge).lerp(new Color(0xffffff), 0.4);
  if (slabMat) slabMat.color.set(theme.slab);
  if (rimMat) rimMat.emissive.set(theme.accent);
  (ring.material as MeshBasicMaterial).color.set(theme.accent);
  if (grid) syncState(grid, rows, cols);
  for (const st of cellState) st.color.copy(st.targetColor);
  tintMotes();
}
/** The puzzle's theme (each Journey chapter and Daily has its own; Practice and lessons follow Settings › Theme). */
export function setTheme(id: string): void {
  const t = Content.themeById(id);
  if (t === theme) return;
  theme = t;
  if (!look) return;
  applyThemeColors();
  buildFlora();
}
export function setReducedMotion(on: boolean): void { reducedMotion = on; }
/** setGraphics: the runtime's quality tier applied live (no reload). */
export function applyLook(next: Look): void {
  if (look && JSON.stringify(look) === JSON.stringify(next)) return;
  const prev = look;
  look = next;
  renderer.toneMapping = ACESFilmicToneMapping;
  renderer.toneMappingExposure = LIGHT.exposure;
  renderer.shadowMap.enabled = next.shadows > 0;
  keyLight.castShadow = next.shadows > 0;
  if (next.shadows > 0) keyLight.shadow.mapSize = next.shadows;
  // The environment carries the fill, so the hemisphere eases off.
  hemi.intensity = next.reflections ? LIGHT.hemiIbl : LIGHT.hemi;
  keyLight.intensity = next.reflections ? LIGHT.keyIbl : LIGHT.key;
  // UnrealBloomPass(0.4, 0.45, 0.85) on r160's linear composer target (before the tone mapping, as here).
  // three r160 page: bloom model "r160" with the page's strength 0.4 (engine.minor 30).
  renderer.bloom = next.bloom ? { model: "r160", strength: 0.4, radius: 0.45, threshold: 0.85, resolution: next.budget.bloomRes } : null;
  // GTAOPass: blend 0.75, radius 0.5, distance exponent 1.4, thickness 1.2; 16 / 8 samples and the denoise per tier.
  renderer.ao = next.ao === "off" ? null : {
    blendIntensity: 0.75, radius: 0.5, distanceExponent: 1.4, thickness: 1.2, scale: 1, samples: next.ao === "high" ? 16 : 8, resolution: next.budget.aoRes,
    denoise: { lumaPhi: 10, depthPhi: 2, normalPhi: 3, radius: next.ao === "high" ? 6 : 4, rings: 2, samples: next.ao === "high" ? 16 : 8, radiusExponent: 2 },
  };
  // GradeShader after the OutputPass (display space): an 0.18 S-curve, saturation 1.1, cool shadows / warm highlights by a
  // smoothstep of luma from 0.2 to 0.8, a 0.26 vignette from 0.38 to 0.9 (y × 0.85).
  renderer.grade = next.grade ? {
    space: "display", contrastCurve: "s", contrast: 0.18, saturation: 1.1, split: [0.2, 0.8], shadows: [0.97, 0.99, 1.05], highlights: [1.04, 1.0, 0.95],
    vignette: { amount: 0.26, inner: 0.38, outer: 0.9, scale: [1, 0.85] },
  } : null;
  renderer.antialias = next.antialias;
  groundMat.map = next.detailed ? groundTex : null;
  withEnv(groundMat, 0.15);
  if (grainSize !== next.budget.grain) {
    grainTex?.dispose();
    grainTex = makeGrainTexture(next.budget.grain);
    grainSize = next.budget.grain;
  }
  buildParticles();
  buildMotes();
  const pb = prev?.budget, b = next.budget;
  const rebuild = !prev || prev.detailed !== next.detailed || prev.reflections !== next.reflections || pb!.material !== b.material
    || pb!.bevel !== b.bevel || pb!.grain !== b.grain || pb!.flora !== b.flora;
  if (rebuild) {
    if (rows) {
      rebuildSlab();
      buildCellAssets();
      if (cells) { cells.geometry = next.detailed ? cellGeoDetailed! : cellGeoPlain!; cells.material = cellMat = next.detailed ? cellMatDetailed! : cellMatPlain!; }
    }
    buildFlora();
  }
  applyShadowFlags();
  applyThemeColors();
}
/** Whether the board draws (full-page screens cover the window). */
export function setActive(on: boolean): void { renderer.camera = on ? camera : null; }

// ---------------------------------------------------------------- the frame
/** Critically damped spring integrator (deterministic per dt). */
function springStep(cur: number, vel: number, tgt: number, dt: number, omega = 14): [number, number] {
  const f = 1 + 2 * dt * omega;
  const oo = omega * omega, hoo = dt * oo, hhoo = dt * hoo;
  const detInv = 1 / (f + hhoo);
  return [(f * cur + dt * vel + hhoo * tgt) * detInv, (vel + hoo * (tgt - cur)) * detInv];
}
const mtx = new Matrix4();
const glowV = new Vector4();
/** Each frame: the camera transition and shake, ambient motion, the cell springs, the bloom, particles and the selection aids. */
export function update(dt: number, w: number, h: number): void {
  dt = Math.min(0.1, dt);
  win = { w: Math.max(1, w), h: Math.max(1, h) };
  animTime += dt;
  if (transition) {
    const tr = transition;
    tr.t += dt;
    const k = tr.ease(Math.min(1, tr.t / tr.duration));
    pose = {
      dist: tr.from.dist + (tr.to.dist - tr.from.dist) * k,
      pitch: tr.from.pitch + (tr.to.pitch - tr.from.pitch) * k,
      yaw: tr.from.yaw + (tr.to.yaw - tr.from.yaw) * k,
      y: tr.from.y + (tr.to.y - tr.from.y) * k,
    };
    if (tr.t >= tr.duration) transition = null;
    updateCamera();
  }
  if (shake > 0.001) shake *= Math.pow(0.0015, dt);
  else shake = 0;
  placeCamera();
  // Attenuated points: three sized them by the canvas (the playfield) height; the engine by the window's.
  const k = field.height / win.h;
  if (points) (points.material as PointsMaterial).size = 0.16 * k;
  if (motes) (motes.material as PointsMaterial).size = 0.16 * k;

  const ambient = !!look?.ambient && !reducedMotion;
  if (ambient) ambientTime += dt;
  for (const f of floraGroup.children) f.rotation.z = ambient ? Math.sin(ambientTime * 0.8 + (f.userData.swayPhase as number)) * 0.03 : 0;
  if (motes) motes.visible = !!look?.ambient;
  if (ambient) updateMotes(ambientTime);

  if (cells && grid) writeCells(dt);
  updateBloom(dt);
  updateParticles(dt);

  const sel = hover.r >= 0 ? hover : focusCell;
  if (cells && sel.r >= 0 && sel.r < rows && sel.c < cols) {
    const p = cellPos(sel.r, sel.c, tmpV);
    ring.visible = true;
    ring.position.set(p.x, 0.24 + (cellState[sel.r * cols + sel.c]?.lift ?? 0), p.z);
    ring.scale.setScalar(reducedMotion ? 1 : 1 + Math.sin(animTime * 5) * 0.06);
    const v = grid ? grid[sel.r * cols + sel.c] : 0;
    ghost.visible = v === CELL.UNKNOWN;
    if (ghost.visible) {
      ghost.position.set(p.x, 0.05, p.z);
      (ghost.material as MeshBasicMaterial).color.set(ghostMode === "fill" ? theme.lit : 0x8899bb);
    }
  } else { ring.visible = false; ghost.visible = false; }
}
function writeCells(dt: number): void {
  if (!cells) return;
  const tmp = new Vector3();
  for (let i = 0; i < cellState.length; i++) {
    const st = cellState[i]!;
    [st.lift, st.liftVel] = springStep(st.lift, st.liftVel, st.targetLift, dt);
    [st.glow, st.glowVel] = springStep(st.glow, st.glowVel, st.targetGlow, dt, 10);
    st.flash = Math.max(0, st.flash - dt * 3);
    st.color.lerp(st.targetColor, Math.min(1, dt * 8));
    const r = Math.floor(i / cols), c = i % cols;
    const idle = reducedMotion ? 0 : Math.sin(animTime * 1.4 + st.phase * Math.PI * 2) * 0.008 * st.glow;
    cellPos(r, c, tmp);
    mtx.makeTranslation(tmp.x, st.lift + idle, tmp.z);
    cells.setMatrixAt(i, mtx);
    tmpC.copy(st.color);
    if (st.flash > 0) tmpC.lerp(st.flashColor, st.flash * 0.7);
    cells.setColorAt(i, tmpC);
    cells.setCustomAt(i, glowV.set(Math.max(0, st.glow) + st.flash * 0.8, 0, 0, 0));
  }
  cells.instanceMatrix.needsUpdate = true;
  if (cells.instanceColor) cells.instanceColor.needsUpdate = true;
  if (cells.instanceCustom) cells.instanceCustom.needsUpdate = true;
  // The emissive pulse: only instances with glow emit (per-instance glow).
  if (cellMat) cellMat.emissiveIntensity = reducedMotion ? 0.24 : 0.22 + Math.sin(animTime * 2.1) * 0.05;
}
