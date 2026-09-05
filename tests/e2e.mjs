/**
 * Picture Logic — end-to-end playthrough test (dev only, not shipped).
 *
 * Drives the real visible UI in headless Chrome via playwright-core:
 *   title → mode select → Practice (Calm 8×8) → board plays to a real win
 *   by lighting the cells the clues describe → results ("Picture revealed")
 *   with score breakdown + persisted progress. Also exercises pause/resume,
 *   the Hint button and the Undo button through the visible controls.
 * A second pass runs the load → practice → tap-a-few-cells flow on a
 * mobile touch viewport.
 *
 * The game exposes a debug/validation handle `window.__pictureLogic`
 * (main.js: `window.__pictureLogic = game;`). The test reads that handle
 * ONLY to observe round state and to pick which visible cell is a correct
 * fill next (the same legality knowledge the player gets from the clues).
 * It never calls the game's own move API — every action is a real
 * click/tap on the on-screen board buttons or HUD buttons (main.js proves
 * cell buttons dispatch through its normal painter → doAction path).
 * No game code is modified.
 *
 * Serving: the repo ships `server.js` (the StarHermit authoritative script
 * declared by starhermit.txt). The game is fully playable offline — when
 * `/api/v1/time` is unavailable it sets `hosted=false` and every screen
 * (practice, journey, daily, challenge, learn, results) works locally. So,
 * per the test conventions of the sibling titles (blockstead/balance-spire),
 * this test embeds a minimal node:http static server on an ephemeral port
 * and answers /api/* probes with 200 `{}` so the client degrades to its
 * documented offline path with zero console noise. If the UI ever starts
 * requiring the real backend this can be swapped for spawning `server.js`;
 * today it is not needed.
 *
 * Run: npm run test:e2e  (or: node tests/e2e.mjs)
 */
import { chromium } from 'playwright-core';
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SHOT = (stage, vp) => `/tmp/picture-logic-e2e-${stage}-${vp}.png`;

// benign GPU/swiftshader noise (mirrors tools/production_game_audit.mjs)
const browserNoise = /GL Driver Message|GPU stall due to ReadPixels|Automatic fallback to software WebGL|EnableWebGLDeveloperExtensions/i;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.mjs': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.wav': 'audio/wav',
  '.mp3': 'audio/mpeg',
  '.ogg': 'audio/ogg',
  '.opus': 'audio/ogg',
  '.glb': 'model/gltf-binary',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
};

const server = http.createServer(async (req, res) => {
  try {
    let p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    if (p === '/') p = '/index.html';
    // No StarHermit backend here: answer API probes with empty JSON (200) so
    // the platform adapter degrades to offline mode without console noise.
    if (p.startsWith('/api/')) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end('{}');
      return;
    }
    const file = path.normalize(path.join(ROOT, p));
    if (!file.startsWith(ROOT)) { res.writeHead(403).end('forbidden'); return; }
    const data = await readFile(file);
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream' });
    res.end(data);
  } catch {
    res.writeHead(404).end('not found');
  }
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const BASE = `http://127.0.0.1:${server.address().port}`;

let failures = 0;
const ok = (name) => console.log(`ok - ${name}`);

// ---------- read-only observation of the debug handle ----------

// window.__pictureLogic is the game's own validation handle (main.js).
// Read only: round kind/phase, the grid + solution used to pick the next
// correct visible cell, and the counters used to verify UI actions.
const readState = (page) => page.evaluate(() => {
  const g = window.__pictureLogic;
  const s = g?.session?.state;
  if (!s) return null;
  let unfilled = null;
  for (let i = 0; i < s.grid.length; i++) {
    if (s.solution[i] === 1 && s.grid[i] === 0) { unfilled = { r: Math.floor(i / s.cols), c: i % s.cols, idx: i }; break; }
  }
  let nonUnknown = 0;
  for (let i = 0; i < s.grid.length; i++) if (s.grid[i] !== 0) nonUnknown++;
  return {
    phase: g.phase, kind: g.session.kind,
    rows: s.rows, cols: s.cols,
    grid: s.grid.slice(), solution: s.solution.slice(),
    status: s.status, turn: s.turn, moves: s.moves, mistakes: s.mistakes,
    hints: s.hints, nonUnknown, unfilled,
  };
});

const waitPlayActive = (page) =>
  page.waitForFunction(() => window.__pictureLogic?.phase === 'active', null, { timeout: 15000 });

const cellButton = (page, r, c) => page.locator(`#cells-grid .cell-btn[data-r="${r}"][data-c="${c}"]`);

// Click a visible cell through the real painter (pointer events), then wait
// for the engine to accept it and flip that cell, before moving on.
async function clickCell(page, r, c) {
  const before = (await readState(page))?.nonUnknown ?? 0;
  await cellButton(page, r, c).click();
  try {
    await page.waitForFunction((rc) => {
      const s = window.__pictureLogic?.session?.state;
      if (!s) return false;
      return s.grid[rc.r * s.cols + rc.c] !== 0;
    }, { r, c }, { timeout: 2500 });
  } catch {
    // A correct fill is always accepted; a no-op just means a re-read.
    const after = (await readState(page))?.nonUnknown ?? 0;
    if (after <= before) throw new Error(`cell (${r},${c}) click did not register`);
  }
}

// Light every correct (solution==1) cell via the visible board so the round
// actually terminates in a win. Filling only confirmed-correct cells means
// zero mistakes and no hints, so the run stays clean and deterministic.
async function solveToCompletion(page) {
  for (let guard = 0; guard < 512; guard++) {
    const st = await readState(page);
    if (!st) throw new Error('state handle missing while solving');
    if (st.status === 'complete') return st;
    if (st.status === 'failed') throw new Error('round failed while solving: ' + JSON.stringify({ reason: st.status, mistakes: st.mistakes }));
    if (!st.unfilled) throw new Error('no unfilled solution cell but round not terminal');
    await clickCell(page, st.unfilled.r, st.unfilled.c);
  }
  throw new Error('solve loop did not reach completion within guard limit');
}

async function startPractice(page) {
  await page.click('#btn-play');
  await page.waitForSelector('#screen-modes.active');
  await page.locator('#mode-list .row-btn', { hasText: 'Practice' }).click();
  await page.waitForSelector('#screen-practice.active');
  await page.locator('#practice-list .row-btn').first().click(); // Calm, 8×8
  await page.waitForSelector('#screen-play.active');
}

// ---------- one full pass ----------
async function runPass(browser, name, ctxOpts, { full }) {
  const errors = [];
  const context = await browser.newContext(ctxOpts);
  const page = await context.newPage();
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  page.on('console', (m) => {
    if (m.type() !== 'error' || browserNoise.test(m.text())) return;
    const url = m.location()?.url || '';
    if (/Failed to load resource/.test(m.text()) && /\/api\/|\/favicon/.test(url)) return;
    errors.push(`console: ${m.text()}`);
  });
  page.on('response', (r) => {
    const p = r.url();
    if (r.status() >= 400 && !/\/api\/|\/favicon/.test(p)) errors.push(`http ${r.status()}: ${p}`);
  });

  try {
    // load + title
    await page.goto(BASE, { waitUntil: 'load' });
    await page.waitForSelector('#screen-title.active', { timeout: 15000 });
    await page.waitForFunction(() => !!window.__pictureLogic && window.__pictureLogic.phase === 'title');
    await page.screenshot({ path: SHOT('title', name) });
    ok(`${name}: title screen visible`);

    // mode select → Practice
    await startPractice(page);
    await page.waitForFunction(() => !!(window.__pictureLogic?.session?.state));
    await waitPlayActive(page);
    const st0 = await readState(page);
    if (st0.rows !== 8 || st0.cols !== 8) throw new Error(`expected 8×8 practice, got ${st0.rows}×${st0.cols}`);
    const cells = await page.locator('#cells-grid .cell-btn').count();
    if (cells !== 64) throw new Error(`expected 64 board cells, got ${cells}`);
    if (st0.mistakes !== 0) throw new Error('unexpected starting mistakes: ' + st0.mistakes);
    await page.screenshot({ path: SHOT('play', name) });
    ok(`${name}: practice board active ("${(await page.textContent('#hud-objective')).trim()}", ${st0.rows}×${st0.cols}, ${cells} cells)`);

    if (full) {
      // pause / resume via the visible buttons
      await page.click('#btn-pause');
      await page.waitForSelector('#overlay-pause.active');
      await page.screenshot({ path: SHOT('pause', name) });
      await page.click('#pause-resume');
      await page.waitForFunction(() => !document.getElementById('overlay-pause').classList.contains('active'));
      await waitPlayActive(page);
      ok(`${name}: pause (❚❚ Pause) and resume work`);

      // hint: reveals one cell through the visible Hint button; hints++ and
      // the revealed cell leaves the unknown set (and becomes locked — the
      // rules never let a restore un-fill it).
      const beforeHint = await readState(page);
      await page.click('#btn-hint');
      await page.waitForFunction((n) => (window.__pictureLogic?.session?.state?.hints ?? 0) > n, beforeHint.hints, { timeout: 3000 });
      const afterHint = await readState(page);
      if (afterHint.nonUnknown <= beforeHint.nonUnknown) throw new Error('hint did not reveal a cell');
      if (afterHint.hints !== beforeHint.hints + 1) throw new Error(`hint counter wrong: ${beforeHint.hints} -> ${afterHint.hints}`);
      await page.screenshot({ path: SHOT('hint', name) });
      ok(`${name}: hint button reveals a cell (hints ${beforeHint.hints}→${afterHint.hints})`);

      // undo: a cross-mark is a note and IS restorable, so mark one unknown
      // cell in Mark mode, then undo it and confirm the grid returns. (Directly
      // undoing the hint is intentionally not asserted: rules keep a filled
      // cell locked, so the restore would be rejected — surfaced as a toast,
      // which is correct game behavior, not a test target.)
      await page.click('#mode-mark'); // switch to ✕ Mark
      const markTarget = afterHint.grid
        .findIndex((v) => v === 0);
      const mr = Math.floor(markTarget / afterHint.cols), mc = markTarget % afterHint.cols;
      await clickCell(page, mr, mc); // cross it (note, not a mistake)
      const afterMark = await readState(page);
      if (afterMark.nonUnknown !== afterHint.nonUnknown + 1) {
        throw new Error(`mark did not add a cross: ${afterHint.nonUnknown} -> ${afterMark.nonUnknown}`);
      }
      await page.click('#btn-undo');
      await page.waitForFunction((n) => {
        const s = window.__pictureLogic?.session?.state;
        if (!s) return false;
        let non = 0; for (let i = 0; i < s.grid.length; i++) if (s.grid[i] !== 0) non++;
        return non === n;
      }, afterHint.nonUnknown, { timeout: 3000 });
      const afterUndo = await readState(page);
      if (afterUndo.nonUnknown !== afterHint.nonUnknown) throw new Error('undo did not clear the cross');
      if (afterUndo.hints !== afterHint.hints) throw new Error('undo unexpectedly reset hint count');
      if (afterUndo.mistakes !== 0) throw new Error('mark/undo caused a mistake: ' + afterUndo.mistakes);
      await page.screenshot({ path: SHOT('undo', name) });
      ok(`${name}: mark a cell → undo restores the previous board state (back to ${afterUndo.nonUnknown} lit)`);
      await page.click('#mode-fill'); // back to ▮ Fill for the real solve

      // solve the round for real on the visible board
      const done = await solveToCompletion(page);
      if (done.status !== 'complete') throw new Error('round did not complete: ' + done.status);

      // results screen
      await page.waitForSelector('#screen-results.active', { timeout: 8000 });
      const title = (await page.textContent('#result-title')) || '';
      if (!/Picture revealed/i.test(title)) throw new Error(`unexpected results title: "${title}"`);
      const tableRows = await page.locator('#score-table tbody tr').count();
      if (tableRows < 1) throw new Error('score breakdown table is empty');
      await page.screenshot({ path: SHOT('results', name) });
      ok(`${name}: puzzle solved on the visible board — results shown ("${title}", ${tableRows} score rows)`);

      // persistence: practice play counted and a local board entry added
      const pr = await page.evaluate(() => {
        const raw = localStorage.getItem('picture-logic.progress.v1');
        return raw ? JSON.parse(raw).data : null;
      });
      if (!pr || !(pr.practicePlays > 0)) throw new Error('practice completion not persisted: ' + JSON.stringify(pr));
      if (!Array.isArray(pr.leaderboard) || pr.leaderboard.length < 1) throw new Error('local leaderboard entry not recorded');
      ok(`${name}: progress persisted (practicePlays: ${pr.practicePlays}, board entries: ${pr.leaderboard.length})`);
    } else {
      // mobile: set a few cells via touchscreen.tap
      let tapped = 0;
      for (let i = 0; i < 3; i++) {
        const st = await readState(page);
        const t = st.unfilled;
        if (!t) throw new Error('no correct cell to tap');
        const bb = await cellButton(page, t.r, t.c).boundingBox();
        if (!bb || bb.width < 1 || bb.height < 1) throw new Error(`tap target (${t.r},${t.c}) too small: ` + JSON.stringify(bb));
        await page.touchscreen.tap(bb.x + bb.width / 2, bb.y + bb.height / 2);
        await page.waitForFunction((rc) => {
          const s = window.__pictureLogic?.session?.state;
          return s && s.grid[rc.r * s.cols + rc.c] !== 0;
        }, { r: t.r, c: t.c }, { timeout: 3000 });
        tapped++;
      }
      const stFinal = await readState(page);
      if (stFinal.nonUnknown < tapped) throw new Error(`expected >=${tapped} cells set, got ${stFinal.nonUnknown}`);
      await page.screenshot({ path: SHOT('mobile-play', name) });
      ok(`${name}: started practice and set ${tapped} cells via touchscreen.tap`);
    }
  } finally {
    await context.close();
  }

  if (errors.length) throw new Error(`${name} pass had page errors:\n  ${errors.join('\n  ')}`);
  console.log(`ok - ${name}: no page errors`);
}

// ---------- main ----------
let browser = null;
try {
  browser = await chromium.launch({
    executablePath: '/usr/bin/google-chrome',
    args: ['--no-sandbox', '--enable-unsafe-swiftshader', '--mute-audio'],
  });
  console.log(`serving ${ROOT} at ${BASE}`);
  await runPass(browser, 'desktop', { viewport: { width: 1280, height: 800 } }, { full: true });
  await runPass(browser, 'mobile',
    { viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true }, { full: false });
  console.log('\nE2E PASS — picture-logic, desktop + mobile, no page errors');
} catch (e) {
  failures++;
  console.error('\nE2E FAIL:', e.message || e);
  process.exitCode = 1;
} finally {
  if (browser) await browser.close();
  server.close();
}
if (failures) process.exit(1);
