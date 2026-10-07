// Picture Logic — StarHermit platform adapter.
// Thin layer over the shared SDK (starhermit-sdk.js, loaded as a classic
// script before the game modules): launch token + renewal, sign-in, account
// nickname, cloud save (slot game:<slug>), per-player settings KV, keyboard
// bindings, invite link and read-only leaderboards. Hosted mode is "the SDK
// holds a token"; without one every call resolves locally with no network
// request. localStorage remains the offline cache.
'use strict';

const SAVE_DEBOUNCE_MS = 2000;

/** The SDK instance (window.StarHermit; tests may inject one on globalThis). */
function sdk() { return globalThis.StarHermit || null; }

export class Platform {
  constructor() {
    this.nickname = null;     // platform display name (never the username)
    this.syncState = 'offline'; // offline | loading | saving | synced | error
    this.docProvider = null;  // () => doc to cloud-save (wired by the game)
    this.onSyncChange = null; // syncState display hook
    this.onAuthChange = null; // ({ signedIn }) after the platform session ends
    this._suspended = false;  // suppress saves while applying a remote doc
    this._sentSettings = {};  // key -> JSON last mirrored to the settings KV
  }

  get hosted() { return !!(sdk() && sdk().signedIn); }
  get userId() { return this.hosted ? String(sdk().userId) : null; }
  get slug() { return this.hosted ? sdk().slug : null; }

  // ------------------------------------------------------------------ launch

  init() {
    const sh = sdk();
    if (!sh) return;
    if (!sh.signedIn) sh.init();
    sh.on('saved', (ok) => this.setSync(ok ? 'synced' : 'error'));
    sh.on('auth', (a) => {
      if (!a.signedIn) { this.nickname = null; this.setSync('offline'); }
      this.onAuthChange?.({ signedIn: !!a.signedIn });
    });
  }

  authHeaders() {
    return this.hosted && sdk().token ? { Authorization: `Bearer ${sdk().token}` } : {};
  }

  canSignIn() { return !!(sdk() && sdk().canSignIn()); }
  signIn() { return !!(sdk() && sdk().signIn()); }
  inviteLink() { return this.hosted ? sdk().inviteLink() : null; }
  // Post a winning ranked round to the high-score board (score-script.js);
  // resolves { posted, rank } — rank on that board, or null.
  async submitScore(total) {
    if (!this.hosted) return { posted: false, rank: null };
    const sh = sdk();
    const keys = await sh.submitScores({ 'high-score': total });
    if (keys.indexOf('high-score') < 0) return { posted: false, rank: null };
    try {
      const r = await sh.leaderboard('high-score', { pageSize: 100 });
      const me = (r.items || []).find((i) => i.userId === sh.userId);
      return { posted: true, rank: me ? me.rank : null };
    } catch { return { posted: true, rank: null }; }
  }

  // ------------------------------------------------------------------ profile

  async loadProfile() {
    if (!this.hosted) return null;
    const p = await sdk().profile();
    this.nickname = p ? p.displayName : 'Player ' + this.userId.slice(0, 6);
    return this.nickname;
  }

  async profileFor(userId) {
    const id = String(userId ?? '');
    if (!this.hosted || !id) return null;
    const p = await sdk().profile(id);
    return p ? p.displayName : 'Player ' + id.slice(0, 6);
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
    if (!this.hosted) return null;
    this.setSync('loading');
    const doc = await sdk().loadJSON();
    this.setSync('synced');
    return doc && typeof doc === 'object' ? doc : null;
  }

  scheduleCloudSave() {
    if (!this.hosted || this._suspended || !this.docProvider) return;
    this.setSync('saving');
    sdk().saveJSON(this.docProvider(), SAVE_DEBOUNCE_MS);
  }

  async flushCloudSave(keepalive = false) {
    if (!this.hosted || this._suspended || !this.docProvider) return false;
    sdk().saveJSON(this.docProvider(), SAVE_DEBOUNCE_MS);
    return sdk().flushSave(keepalive);
  }

  attachFlush() {
    const flush = () => { if (this.hosted) sdk().flushSave(true); };
    window.addEventListener('pagehide', flush);
    document.addEventListener('visibilitychange', () => { if (document.hidden) flush(); });
  }

  // ------------------------------------------------------------------ settings KV

  /** Platform-stored preferences ({} when signed out / none). */
  async loadRemoteSettings() {
    if (!this.hosted) return {};
    const s = (await sdk().getSettings()) || {};
    this._settingsLoaded = true; // no PATCH before the platform values were read
    for (const [k, v] of Object.entries(s)) this._sentSettings[k] = JSON.stringify(v);
    return s;
  }

  /** Mirror changed top-level preference keys with one PATCH. */
  syncSettings(prefs) {
    if (!this.hosted || !this._settingsLoaded || this._suspended) return Promise.resolve(null);
    const patch = {};
    for (const [k, v] of Object.entries(prefs || {})) {
      const json = JSON.stringify(v);
      if (this._sentSettings[k] !== json) { patch[k] = v; this._sentSettings[k] = json; }
    }
    return Object.keys(patch).length ? sdk().patchSettings(patch) : Promise.resolve(null);
  }

  // ------------------------------------------------------------------ controls

  /** { action: codes[] } with the player's platform overrides applied. */
  loadBindings(defaults) {
    const copy = () => Object.fromEntries(Object.entries(defaults).map(([k, v]) => [k, v.slice()]));
    if (!this.hosted) return Promise.resolve(copy());
    return sdk().loadBindings(defaults).catch(copy);
  }

  // ------------------------------------------------------------------ leaderboards (read-only)

  async loadLeaderboard(pageSize = 20) {
    if (!this.hosted) return null;
    const r = await sdk().leaderboard(null, { pageSize });
    if (!r || !r.board) return null;
    return Promise.all((r.items || []).map(async (e) => {
      const uid = e.userId ?? '';
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
