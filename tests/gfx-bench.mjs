// Graphics benchmark hook for tools/gfx-bench.mjs (dev-only): picks a preset in Settings → Graphics,
// starts the largest practice puzzle and keeps lighting correct cells by clicking the on-screen cell
// buttons (a few per second), retrying from the results screen — cell lifts, glow pulses, bursts, motes
// and the flora sway run the whole time.
export const presets = ['low', 'balanced', 'high', 'ultra'];
export const levels = { low: 0, balanced: 4, high: 10, ultra: 17 };

export async function setPreset(page, preset) {
  await page.waitForFunction(() => window.__pictureLogic?.phase === 'title' && !!window.__pictureLogic.renderer, null, { timeout: 20000 });
  await page.click('#btn-settings');
  await page.waitForSelector('#overlay-settings.active');
  await page.selectOption('#gfx-preset', preset);
  await page.waitForFunction((p) => document.body.dataset.gfxPreset === p, preset);
  await page.click('#settings-close');
  await page.waitForFunction(() => !document.getElementById('overlay-settings').classList.contains('active'));
}

const nextCell = (page) => page.evaluate(() => {
  const g = window.__pictureLogic, s = g?.session?.state;
  if (document.getElementById('screen-results')?.classList.contains('active') || s?.status === 'complete') return { results: true };
  if (!s) return {};
  const i = s.solution.findIndex((v, k) => v === 1 && s.grid[k] !== 1);
  return i < 0 ? {} : { r: Math.floor(i / s.cols), c: i % s.cols };
});

async function step(page) {
  const m = await nextCell(page);
  if (m.results) {
    await page.click('#result-retry', { timeout: 3000 });
    return page.waitForSelector('#screen-play.active', { timeout: 5000 });
  }
  if (m.r == null) return;
  await page.click(`#cells-grid .cell-btn[data-r="${m.r}"][data-c="${m.c}"]`, { timeout: 2000, force: true });
}

export async function start(page) {
  await page.click('#btn-play');
  await page.waitForSelector('#screen-modes.active');
  await page.locator('#mode-list .row-btn', { hasText: 'Practice' }).click();
  await page.waitForSelector('#screen-practice.active');
  await page.locator('#practice-list .row-btn').last().click();
  await page.waitForSelector('#screen-play.active');
  let open = true;
  page.once('close', () => { open = false; });
  (async () => {
    while (open) {
      try { await step(page); } catch (e) { if (!open) return; if (process.env.BENCH_DEBUG) console.error(e.message); }
      await page.waitForTimeout(250).catch(() => {});
    }
  })();
  await page.waitForTimeout(1500);
}
