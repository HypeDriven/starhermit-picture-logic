// Picture Logic — StarHermit platform adapter.
// Launch-token handshake (fragment #game_token, read once and stripped),
// Bearer auth on every REST call, 45-min token refresh, account nickname,
// cloud saves (single slot, stored zip + base64) and read-only leaderboards.
// Hosted mode activates iff a launch token was read; localStorage remains
// the offline cache. Tokens live in memory only, never in storage.
'use strict';

// Minimal ZIP writer/reader (stored entries only, no compression).
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(bytes) {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function zipStore(name, dataBytes) {
  const enc = new TextEncoder();
  const nameB = enc.encode(name);
  const crc = crc32(dataBytes);
  const out = [];
  const u16 = (v) => out.push(v & 0xff, (v >> 8) & 0xff);
  const u32 = (v) => out.push(v & 0xff, (v >> 8) & 0xff, (v >> 16) & 0xff, (v >>> 24) & 0xff);
  u32(0x04034b50); u16(20); u16(0); u16(0); u16(0); u16(0);
  u32(crc); u32(dataBytes.length); u32(dataBytes.length);
  u16(nameB.length); u16(0);
  const local = out.length;
  const head = new Uint8Array(out);
  const cd = [];
  const c16 = (v) => cd.push(v & 0xff, (v >> 8) & 0xff);
  const c32 = (v) => cd.push(v & 0xff, (v >> 8) & 0xff, (v >> 16) & 0xff, (v >>> 24) & 0xff);
  c32(0x02014b50); c16(20); c16(20); c16(0); c16(0); c16(0); c16(0);
  c32(crc); c32(dataBytes.length); c32(dataBytes.length);
  c16(nameB.length); c16(0); c16(0); c16(0); c16(0); c32(0); c32(0); // attrs + local-header offset
  const cdHead = new Uint8Array(cd);
  const cdOff = head.length + nameB.length + dataBytes.length;
  const parts = [head, nameB, dataBytes, cdHead, nameB];
  const eocd = [];
  const e32 = (v) => eocd.push(v & 0xff, (v >> 8) & 0xff, (v >> 16) & 0xff, (v >>> 24) & 0xff);
  const e16 = (v) => eocd.push(v & 0xff, (v >> 8) & 0xff);
  e32(0x06054b50); e16(0); e16(0); e16(1); e16(1);
  e32(cdHead.length + nameB.length); e32(cdOff); e16(0);
  parts.push(new Uint8Array(eocd));
  const total = parts.reduce((n, p) => n + p.length, 0);
  const buf = new Uint8Array(total);
  let o = 0;
  for (const p of parts) { buf.set(p, o); o += p.length; }
  return buf;
}
function unzipFirstEntry(zipBytes) {
  // Stored single-entry reader: scan local headers for compression 0.
  const dv = new DataView(zipBytes.buffer, zipBytes.byteOffset, zipBytes.byteLength);
  let off = 0;
  while (off + 30 <= zipBytes.length && dv.getUint32(off, true) === 0x04034b50) {
    const method = dv.getUint16(off + 8, true);
    const size = dv.getUint32(off + 18, true);
    const nameLen = dv.getUint16(off + 26, true);
    const extraLen = dv.getUint16(off + 28, true);
    const dataOff = off + 30 + nameLen + extraLen;
    if (method !== 0) throw new Error('unsupported zip entry');
    return zipBytes.slice(dataOff, dataOff + size);
  }
  throw new Error('bad zip');
}
function bytesToBase64(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000)
    s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(s);
}
function base64ToBytes(b64) {
  const s = atob(b64);
  const b = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) b[i] = s.charCodeAt(i);
  return b;
}

function decodeJwtPayload(token) {
  try {
    const part = token.split('.')[1];
    if (!part) return null;
    const b64 = part.replace(/-/g, '+').replace(/_/g, '/');
    return JSON.parse(atob(b64 + '='.repeat((4 - (b64.length % 4)) % 4)));
  } catch { return null; }
}

export class Platform {
  constructor() {
    this.token = null;        // launch token (memory only, never persisted)
    this.userId = null;       // JWT sub
    this.slug = null;         // JWT game_scope — never hard-coded
    this.hosted = false;      // true iff a launch token was read
    this.nickname = null;     // platform display name (never the username)
    this.syncState = 'offline'; // offline | loading | saving | synced | error
    this.docProvider = null;  // () => doc to cloud-save (wired by the game)
    this.onSyncChange = null; // syncState display hook
    this._saveTimer = null;
    this._refreshTimer = null;
    this._suspended = false;  // suppress saves while applying a remote doc
    this._profileCache = new Map();
  }

  // ------------------------------------------------------------------ launch

  init() {
    let token = null;
    const frag = window.location.hash;
    if (frag) {
      const params = new URLSearchParams(frag.startsWith('#') ? frag.slice(1) : frag);
      token = params.get('game_token');
      if (token) {
        params.delete('game_token');
        const rest = params.toString();
        history.replaceState(null, '',
          window.location.pathname + window.location.search + (rest ? `#${rest}` : ''));
      }
    }
    if (!token) {
      // Query fallbacks are local-dev conveniences only; the platform always
      // launches with the fragment form.
      const q = new URLSearchParams(window.location.search);
      token = q.get('game_token') || q.get('token') || q.get('launch');
    }
    if (!token) return;
    const claims = decodeJwtPayload(token);
    if (!claims || !claims.sub) return;
    this.token = token;
    this.userId = String(claims.sub);
    this.slug = claims.game_scope ? String(claims.game_scope) : null;
    this.hosted = true;
    this._scheduleRefresh(45 * 60 * 1000);
  }

  authHeaders() {
    return this.token ? { Authorization: `Bearer ${this.token}` } : {};
  }

  async api(path, { method = 'GET', body, timeoutMs = 6000 } = {}) {
    const headers = this.authHeaders();
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    const res = await fetch(path, {
      method, headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`api ${path} -> ${res.status}`);
    const ct = res.headers.get('content-type') || '';
    return ct.includes('application/json') ? res.json() : res;
  }

  _scheduleRefresh(ms) {
    clearTimeout(this._refreshTimer);
    this._refreshTimer = setTimeout(() => this.refreshToken(), ms);
  }

  async refreshToken() {
    if (!this.hosted || !this.slug) return;
    try {
      const res = await fetch(`/api/v1/games/${this.slug}/launch-token`, {
        method: 'POST',
        headers: this.authHeaders(),
        signal: AbortSignal.timeout(8000),
      });
      if (!res.ok) throw new Error(`refresh -> ${res.status}`);
      const data = await res.json();
      if (data && typeof data.token === 'string' && data.token) this.token = data.token;
      this._scheduleRefresh(45 * 60 * 1000);
    } catch {
      this._scheduleRefresh(60 * 1000); // retry failures ~60 s
    }
  }

  // ------------------------------------------------------------------ profile

  async loadProfile() {
    if (!this.hosted) return null;
    try {
      const data = await this.api(`/api/v1/users/${this.userId}/profile`);
      if (data && typeof data.nickname === 'string' && data.nickname.trim()) {
        this.nickname = data.nickname.trim();
      }
    } catch { /* fall back to the generated name below */ }
    if (!this.nickname) this.nickname = 'Player ' + this.userId.slice(0, 8);
    return this.nickname;
  }

  async profileFor(userId) {
    const id = String(userId ?? '');
    if (!this.hosted || !id) return null;
    if (this._profileCache.has(id)) return this._profileCache.get(id);
    let name = null;
    try {
      const data = await this.api(`/api/v1/users/${id}/profile`);
      if (data && typeof data.nickname === 'string' && data.nickname.trim()) name = data.nickname.trim();
    } catch { /* generated fallback below */ }
    if (!name) name = 'Player ' + id.slice(0, 8);
    this._profileCache.set(id, name);
    return name;
  }

  // ------------------------------------------------------------------ cloud saves

  setSync(state) {
    this.syncState = state;
    this.onSyncChange?.(state);
  }

  suspendSave(fn) {
    this._suspended = true;
    try { fn(); } finally { this._suspended = false; }
  }

  async cloudLoad() {
    if (!this.hosted || !this.slug) return null;
    this.setSync('loading');
    const res = await fetch(`/api/v1/me/cloud-saves/${this.slug}`, {
      headers: this.authHeaders(),
      signal: AbortSignal.timeout(8000),
    });
    if (res.status === 404) { this.setSync('synced'); return null; }
    if (!res.ok) throw new Error(`cloud load -> ${res.status}`);
    const bytes = new Uint8Array(await res.arrayBuffer());
    const raw = unzipFirstEntry(bytes);
    this.setSync('synced');
    return JSON.parse(new TextDecoder().decode(raw));
  }

  scheduleCloudSave() {
    if (!this.hosted || !this.slug || this._suspended || !this.docProvider) return;
    this.setSync('saving');
    clearTimeout(this._saveTimer);
    this._saveTimer = setTimeout(() => this.flushCloudSave(), 2000);
  }

  async flushCloudSave() {
    clearTimeout(this._saveTimer);
    this._saveTimer = null;
    if (!this.hosted || !this.slug || this._suspended || !this.docProvider) return;
    try {
      const doc = this.docProvider();
      const bytes = zipStore('save.json', new TextEncoder().encode(JSON.stringify(doc)));
      await fetch(`/api/v1/me/cloud-saves/${this.slug}`, {
        method: 'PUT',
        headers: { ...this.authHeaders(), 'Content-Type': 'application/json' },
        body: JSON.stringify({ dataBase64: bytesToBase64(bytes) }),
        signal: AbortSignal.timeout(8000),
      }).then(res => { if (!res.ok && res.status !== 404) throw new Error(`cloud save -> ${res.status}`); });
      this.setSync('synced');
    } catch {
      this.setSync('error'); // localStorage already holds the data; next save retries
    }
  }

  attachFlush() {
    const flush = () => this.flushCloudSave();
    window.addEventListener('pagehide', flush);
    document.addEventListener('visibilitychange', () => { if (document.hidden) flush(); });
  }

  // ------------------------------------------------------------------ leaderboards (read-only)

  async loadLeaderboard(pageSize = 20) {
    if (!this.hosted || !this.slug) return null;
    const game = await this.api(`/api/v1/games/${this.slug}`);
    const lbId = game && game.leaderboardId;
    if (!lbId) return null;
    const data = await this.api(
      `/api/v1/leaderboards/${lbId}/entries?page=1&pageSize=${pageSize}`);
    const rows = data && Array.isArray(data.entries) ? data.entries : [];
    return Promise.all(rows.map(async (e) => {
      const uid = e.userId ?? e.user?.id ?? '';
      return {
        name: await this.profileFor(uid),
        me: String(uid) === this.userId,
        score: e.score ?? 0,
        mistakes: e.mistakes ?? 0,
        elapsedMs: e.elapsedMs ?? 0,
        seed: e.seed ?? '',
      };
    }));
  }
}

export { zipStore, unzipFirstEntry, bytesToBase64, base64ToBytes };
