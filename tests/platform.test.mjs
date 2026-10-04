// StarHermit adapter (js/platform.js) over the shared SDK with a stubbed fetch.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// The SDK is a classic browser script: evaluate it the way a <script> tag
// would, against a stand-in global.
const holder = {};
new Function('self', 'module', readFileSync(new URL('../starhermit-sdk.js', import.meta.url), 'utf8'))(holder, undefined);
const SDK = holder.StarHermit;

const b64u = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
const TOKEN = `h.${b64u({ sub: 'user-abcdef99', game_scope: 'pl-slug', exp: Math.floor(Date.now() / 1000) + 3600 })}.s`;

function install(href) {
  const calls = [];
  const saves = {};
  const kv = { theme: 'night-market' };
  const fetch = async (url, init = {}) => {
    calls.push({ url, method: init.method || 'GET', init });
    const r = (status, body) => new Response(body, { status });
    const j = (o) => r(200, JSON.stringify(o));
    if (url.endsWith('/profile')) return j({ username: 'hidden', nickname: url.includes('user-abcdef99') ? 'Lumen' : '' });
    if (url.includes('/cloud-saves/')) {
      const key = decodeURIComponent(url.split('/cloud-saves/')[1]);
      if (init.method === 'PUT') { saves[key] = Buffer.from(JSON.parse(init.body).dataBase64, 'base64'); return j({}); }
      return saves[key] ? r(200, saves[key]) : r(404, '');
    }
    if (url.endsWith('/settings') && init.method === 'PATCH') { Object.assign(kv, JSON.parse(init.body).settings); return j({}); }
    if (url.endsWith('/settings')) return j({ settings: kv });
    if (url.endsWith('/controls')) return j({ actions: [{ action: 'fill', codes: ['KeyF'] }] });
    if (url.endsWith('/leaderboards')) return j([{ id: 'lb1', key: 'score' }]);
    if (url.includes('/leaderboards/lb1/entries')) return j({ items: [{ userId: 'u-other-1', score: 900 }, { userId: 'user-abcdef99', score: 800 }] });
    return r(404, '');
  };
  const u = new URL(href);
  const win = { location: { hash: u.hash, search: u.search, pathname: u.pathname, origin: u.origin, hostname: u.hostname, href }, history: { replaceState() {} } };
  globalThis.window = { addEventListener() {} };
  globalThis.document = { addEventListener() {}, hidden: false };
  globalThis.StarHermit = SDK.create({ window: win, fetch, setTimeout: () => 0, clearTimeout: () => {} });
  return { calls, saves, kv };
}

test('hosted: token, nickname, cloud save game:<slug>, settings, bindings, board', async () => {
  const h = install(`https://x.test/#game_token=${TOKEN}`);
  const { Platform } = await import('../js/platform.js?hosted');
  const p = new Platform();
  p.init();
  assert.equal(p.hosted, true);
  assert.equal(p.userId, 'user-abcdef99');
  assert.equal(p.slug, 'pl-slug');
  assert.equal(await p.loadProfile(), 'Lumen');
  assert.equal(p.authHeaders().Authorization, `Bearer ${TOKEN}`);

  const doc = { settings: { theme: 'a' }, progress: { completions: 3 } };
  p.docProvider = () => doc;
  assert.equal(await p.flushCloudSave(), true);
  assert.deepEqual(Object.keys(h.saves), ['game:pl-slug']);
  assert.ok(h.calls.some((c) => c.method === 'PUT' && c.url === '/api/v1/me/cloud-saves/game%3Apl-slug'));
  assert.deepEqual(await p.cloudLoad(), doc);
  assert.equal(p.syncState, 'synced');

  assert.deepEqual(await p.loadRemoteSettings(), { theme: 'night-market' });
  await p.syncSettings({ theme: 'night-market', muted: true });
  const patches = h.calls.filter((c) => c.method === 'PATCH');
  assert.equal(patches.length, 1);
  assert.deepEqual(JSON.parse(patches[0].init.body), { settings: { muted: true } });

  assert.deepEqual(await p.loadBindings({ fill: ['Enter'], hint: ['KeyH'] }), { fill: ['KeyF'], hint: ['KeyH'] });
  const board = await p.loadLeaderboard();
  assert.deepEqual(board.map((e) => [e.name, e.me, e.score]), [['Player u-othe', false, 900], ['Lumen', true, 800]]);
  assert.match(p.inviteLink(), /\/game-invite\/user-abcdef99\/pl-slug$/);
});

test('standalone: no request at all', async () => {
  const h = install('http://localhost:8080/index.html');
  const { Platform } = await import('../js/platform.js?standalone');
  const p = new Platform();
  p.init();
  p.docProvider = () => ({});
  assert.equal(p.hosted, false);
  assert.equal(await p.loadProfile(), null);
  assert.equal(await p.cloudLoad(), null);
  p.scheduleCloudSave();
  assert.equal(await p.flushCloudSave(), false);
  assert.deepEqual(await p.loadRemoteSettings(), {});
  assert.deepEqual(await p.loadBindings({ fill: ['Enter'] }), { fill: ['Enter'] });
  assert.equal(await p.loadLeaderboard(), null);
  assert.equal(p.inviteLink(), null);
  assert.equal(p.canSignIn(), false);
  assert.deepEqual(p.authHeaders(), {});
  assert.equal(h.calls.length, 0);
});
