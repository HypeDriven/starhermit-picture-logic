// Picture Logic — bootstrap, session orchestration, platform integration.
// State machine: boot → title → mode-select → preparing → countdown →
// active ↔ paused → resolving → results → progression. Solo simulation
// pauses when backgrounded; the authoritative clock lives in rules ticks.
'use strict';

import {
  CELL, STATUS, REASON, createState, serialize, deserialize, stateHash,
  applyCommand, validate, scoreComponents, createReplayEnvelope, replayRecord,
} from './rules.js';
import {
  CONTENT_VERSION, THEMES, themeById, JOURNEY_STAGES, dailySpec, utcDateKey,
  challengeSpecs, utcWeekKey, PRACTICE_PRESETS, LESSONS, buildPuzzle, puzzleHash,
} from './content.js';
import { Store, ACHIEVEMENTS, migrateGraphics, DEFAULT_SETTINGS } from './store.js';
import { PRESETS, CATEGORIES, autoPreset, resolve, choosePreset, presetTier, describe } from './gfx.js';
import { gfxStrings } from './gfx-strings.js';
import { UI, MODE_INFO, formatMs, escapeHtml, FALLBACK_BINDINGS as DEFAULT_BINDINGS } from './ui.js';
import { AudioEngine } from './audio.js';
import { hashSeed } from './prng.js';
import { Platform } from './platform.js';
import { currentPlatformStrings } from './platform-i18n.js';


const BUILD_VERSION = '1.0.0';

// ---------------------------------------------------------------------------

class Game {
  constructor() {
    this.store = new Store();
    this.ui = new UI();
    this.ui.app = this;
    this.audio = new AudioEngine();
    this.renderer = null;
    this.flat = false;
    this.phase = 'boot';
    this.session = null;
    this.paused = false;
    this.hiddenAt = null;
    this.timeOffsetMs = 0;      // platform-time sync offset
    this.platform = new Platform();
    this.ownServer = false;     // local dev server (server.js) answering /api
    this.telemetryQueue = [];
    this.sessionId = `s-${Math.random().toString(36).slice(2, 10)}`;
    this._tickAcc = 0;
    this._lastFrame = 0;
    this.gpu = '';               // unmasked GPU renderer string, when exposed
    this.gfxAuto = 'balanced';   // Auto preset for this device
    this.gfxText = gfxStrings(navigator.language);
    this._gamepad = { prev: [], axisAt: 0 };
    this._remapTarget = null;
    this._layoutCounter = 0;
    this._countdownGen = 0;

    // Cloud mirror: every settings/progress write reschedules the debounced
    // upload; localStorage stays the offline cache.
    this.platform.docProvider = () => ({
      savedAt: new Date().toISOString(),
      settings: this.store.settings,
      progress: this.store.progress,
    });
    const saveProgress = this.store.saveProgress.bind(this.store);
    this.store.saveProgress = () => { saveProgress(); this.platform.scheduleCloudSave(); };
    const saveSettings = this.store.saveSettings.bind(this.store);
    this.store.saveSettings = () => { saveSettings(); this.platform.scheduleCloudSave(); this.platform.syncSettings(this.store.settings); };
  }

  get hosted() { return this.platform.hosted; }

  // ------------------------------------------------------------------ boot

  async boot() {
    this.telemetry('start', { v: BUILD_VERSION });
    this.platform.init();
    this.ui.setThemeVars(themeById(this.store.settings.theme), this.store.settings.palette);
    this.ui.applyAccessibilityClasses(this.store.settings);
    this.ui.holdToMark = this.store.settings.holdToMark;
    document.getElementById('title-version').textContent = `v${BUILD_VERSION} · content v${CONTENT_VERSION}`;

    this.flat = !this.detectWebGL();
    this.applyGraphics(false);
    if (this.flat) {
      document.getElementById('playfield').classList.add('flat');
      this.ui.toast('3D is unavailable in this browser — playing the accessible flat board.', '');
    } else {
      this.buildRenderer();
    }

    if (this.platform.hosted) {
      this.syncPlatformTime(); // round-trip offset for daily boundaries
      this.platform.onSyncChange = () => this.refreshTitle();
      this.platform.attachFlush();
      this.platform.loadProfile().then(() => this.refreshTitle());
      await this.loadCloudProgress();
      await this.loadRemoteSettings();
    }
    this.wirePlatform();
    this.buildSettingsPanel();
    this.wire();
    this.refreshTitle();
    this.ui.show('screen-title');
    this.phase = 'title';
    this.ui.buildHelpControls(this.store.settings.gamepadMap);

    document.addEventListener('visibilitychange', () => this.onVisibility());
    window.addEventListener('resize', () => this.onResize());
    window.addEventListener('pagehide', () => this.saveSnapshot());

    // First user gesture unlocks audio.
    const unlock = () => {
      if (this.audio.ensure()) {
        this.audio.setMuted(this.store.settings.muted);
        for (const [b, v] of Object.entries(this.store.settings.volumes)) this.audio.setVolume(b, v);
        this.audio.startAmbience();
      }
      window.removeEventListener('pointerdown', unlock);
      window.removeEventListener('keydown', unlock);
    };
    window.addEventListener('pointerdown', unlock);
    window.addEventListener('keydown', unlock);

    requestAnimationFrame((t) => { this._lastFrame = t; this.loop(t); });
  }

  // Probe WebGL once; the unmasked renderer string picks the Auto graphics preset.
  detectWebGL() {
    try {
      const c = document.createElement('canvas');
      const gl = c.getContext('webgl2') || c.getContext('webgl');
      if (!gl) return false;
      const ext = gl.getExtension('WEBGL_debug_renderer_info');
      this.gpu = String((ext && gl.getParameter(ext.UNMASKED_RENDERER_WEBGL)) || gl.getParameter(gl.RENDERER) || '');
      gl.getExtension('WEBGL_lose_context')?.loseContext();
      return true;
    } catch { return false; }
  }

  isMobileDevice() {
    return matchMedia('(pointer: coarse)').matches || Math.min(screen.width, screen.height) < 760;
  }

  resolveGraphics() {
    this.gfxAuto = autoPreset(this.gpu, this.isMobileDevice());
    return resolve(this.store.settings.graphics, this.gfxAuto);
  }

  // Apply graphics settings live: body data attributes (DOM effects + tests),
  // then the renderer — rebuilt only when the canvas MSAA context flag changes.
  applyGraphics(live = true) {
    const g = this.resolveGraphics();
    this.gfx = g;
    const b = document.body.dataset;
    b.gfxPreset = g.preset;
    b.gfxChoice = g.auto ? 'auto' : g.preset;
    b.gfxDetail = g.detail;
    b.gfxBackground = g.background;
    const canvas = document.getElementById('gl');
    if (canvas) canvas.dataset.gfxPreset = g.preset;
    if (!live || this.flat || !this.renderer) return;
    if (this.renderer.canvasMsaa !== g.canvasMsaa) this.buildRenderer(true);
    else this.renderer.setGraphics(g);
  }

  buildRenderer(freshCanvas = false) {
    let canvas = document.getElementById('gl');
    if (this.renderer) { this.renderer.dispose(); this.renderer = null; }
    if (freshCanvas) {
      // Context attributes (antialias) are fixed per canvas: swap in a new one.
      const next = canvas.cloneNode(false);
      canvas.replaceWith(next);
      canvas = next;
    }
    // Dynamic import keeps the flat fallback lightweight.
    import('./render3d.js').then(({ BoardRenderer }) => {
      if (this.flat) return;
      this.renderer = new BoardRenderer(canvas, {
        gfx: this.resolveGraphics(),
        gpu: this.gpu,
        reducedMotion: this.store.settings.reducedMotion,
        theme: themeById(this.store.settings.theme),
        onCellHover: (cell) => {
          if (cell) this.ui.setCursor(cell.r, cell.c, false);
          this.renderer?.setHover(cell?.r ?? -1, cell?.c ?? -1, this.ui.inputMode);
        },
        onCellActivate: (cell, e, drag) => {
          if (!cell || this.phase !== 'active' || this.paused) return;
          this.ui.setCursor(cell.r, cell.c, false);
          if (!drag) this.doAction({ type: this.ui.inputMode, r: cell.r, c: cell.c });
        },
      });
      this.renderer.onContextLost = () => this.onContextLost();
      this.onResize();
      if (this.session) {
        this.renderer.setBoard(this.session.state.rows, this.session.state.cols, this.session.state.seed);
        this.renderer.syncState(this.session.state.grid, this.session.state.rows, this.session.state.cols);
      }
    }).catch(() => {
      this.flat = true;
      document.getElementById('playfield').classList.add('flat');
    });
  }

  onContextLost() {
    this.ui.toast('Graphics context lost — rebuilding…');
    setTimeout(() => {
      if (this.flat) return;
      try { this.buildRenderer(); } catch {
        this.flat = true;
        document.getElementById('playfield').classList.add('flat');
        this.ui.toast('Recovered in compatibility mode; your progress is safe.');
      }
    }, 600);
  }

  async syncPlatformTime() {
    try {
      const t0 = Date.now();
      const res = await fetch('/api/v1/time', {
        headers: this.platform.authHeaders(),
        signal: AbortSignal.timeout(2500),
      });
      const t1 = Date.now();
      if (!res.ok) return;
      const data = await res.json();
      if (typeof data.epochMs === 'number') {
        this.timeOffsetMs = data.epochMs - Math.round((t0 + t1) / 2);
        this.ownServer = true; // local dev server (server.js) answering
      }
    } catch { /* offline/local play is fully supported */ }
  }

  now() { return Date.now() + this.timeOffsetMs; }

  async loadCloudProgress() {
    try {
      const remote = await this.platform.cloudLoad();
      if (!remote) return;
      // Remote wins on conflict: the cloud slot is the durable copy.
      this.platform.suspendSave(() => {
        if (remote.settings) { Object.assign(this.store.settings, remote.settings); migrateGraphics(this.store.settings); this.applyGraphics(); }
        if (remote.progress) Object.assign(this.store.progress, remote.progress);
        this.store.saveSettings();
        this.store.saveProgress();
      });
      this.ui.toast('Progress synced from your account.');
    } catch (err) {
      console.warn('[cloud] load failed, keeping local progress', err);
    }
  }

  // Platform settings KV wins over local values for known preference keys.
  async loadRemoteSettings() {
    const remote = await this.platform.loadRemoteSettings();
    const s = this.store.settings;
    let changed = false;
    this.platform.suspendSave(() => {
      for (const [k, v] of Object.entries(remote)) {
        if (!(k in DEFAULT_SETTINGS) || v == null || typeof v !== typeof DEFAULT_SETTINGS[k]) continue;
        if (JSON.stringify(s[k]) === JSON.stringify(v)) continue;
        s[k] = structuredClone(v);
        changed = true;
      }
      if (changed) {
        migrateGraphics(s);
        this.applyGraphics();
        this.ui.setThemeVars(themeById(s.theme), s.palette);
        this.ui.applyAccessibilityClasses(s);
        this.ui.holdToMark = s.holdToMark;
        this.store.saveSettings();
      }
    });
    this.platform.syncSettings(s);
  }

  // StarHermit account buttons (sign-in on the hosted domain without a token,
  // invite when signed in), keyboard bindings and sign-out handling.
  wirePlatform() {
    const t = currentPlatformStrings();
    const signIn = document.getElementById('btn-signin');
    const invite = document.getElementById('btn-invite');
    signIn.textContent = t.signIn;
    invite.textContent = t.invite;
    signIn.addEventListener('click', () => this.platform.signIn());
    invite.addEventListener('click', async () => {
      const link = this.platform.inviteLink();
      if (!link) return;
      try {
        await navigator.clipboard.writeText(link);
        this.ui.toast(t.inviteCopied);
      } catch {
        this.ui.toast(t.inviteFailed.replace('{link}', link));
      }
    });
    this.platform.onAuthChange = ({ signedIn }) => {
      if (!signedIn) this.ui.toast(t.signedOut);
      this.refreshTitle();
    };
    this.platform.loadBindings(DEFAULT_BINDINGS).then((b) => {
      this.ui.bindings = b;
      this.ui.buildHelpControls(this.store.settings.gamepadMap);
    });
  }

  // ------------------------------------------------------------------ wiring

  wire() {
    const $ = (id) => document.getElementById(id);
    const ui = this.ui;

    $('btn-play').addEventListener('click', () => {
      this.ui.buildModeList(this.store.progress);
      this.ui.show('screen-modes');
    });
    $('card-daily').addEventListener('click', () => this.startDaily());
    $('card-journey').addEventListener('click', () => { this.showJourney(); });
    $('card-learn').addEventListener('click', () => { this.showLearn(); });
    $('card-scores').addEventListener('click', () => this.showScores());
    $('btn-settings').addEventListener('click', () => this.openSettings());
    $('btn-help').addEventListener('click', () => this.ui.show('screen-help'));

    ui.onModeSelect = (id) => {
      this.audio.event('ack');
      if (id === 'journey') this.showJourney();
      else if (id === 'learn') this.showLearn();
      else if (id === 'daily') this.startDaily();
      else if (id === 'practice') this.showPractice();
      else if (id === 'challenge') this.showChallenge();
      else if (id === 'scores') this.showScores();
    };
    ui.onJourneyStage = (stage) => this.startJourney(stage);
    ui.onPracticePreset = (preset) => this.startPractice(preset);
    ui.onChallenge = (spec) => this.startChallenge(spec);
    ui.onLesson = (lesson) => this.startLesson(lesson);

    $('practice-seed-go').addEventListener('click', () => {
      const text = $('practice-seed').value.trim() || `seed-${Math.floor(Math.random() * 1e6)}`;
      const size = parseInt($('practice-size').value, 10);
      this.startPractice({ id: `practice-custom-${text}-${size}`, name: 'Custom', rows: size, cols: size, density: 0.6, note: '' }, text);
    });

    // Play screen controls.
    $('btn-pause').addEventListener('click', () => this.togglePause());
    $('pause-resume').addEventListener('click', () => this.togglePause(false));
    $('pause-restart').addEventListener('click', () => { this.togglePause(false); this.restartSession(); });
    $('pause-settings').addEventListener('click', () => this.openSettings());
    $('pause-help').addEventListener('click', () => { this.togglePause(false); this.leaveToTitle(); this.ui.show('screen-help'); });
    $('pause-leave').addEventListener('click', () => { this.togglePause(false); this.leaveToTitle(); });

    for (const id of ['mode-fill', 'rail-mode-fill']) $(id).addEventListener('click', () => this.setInputMode('fill'));
    for (const id of ['mode-mark', 'rail-mode-mark']) $(id).addEventListener('click', () => this.setInputMode('mark'));
    for (const id of ['btn-hint', 'rail-hint']) $(id).addEventListener('click', () => this.doAction({ type: 'hint' }));
    for (const id of ['btn-undo', 'rail-undo']) $(id).addEventListener('click', () => this.undo());
    for (const id of ['btn-camera', 'rail-camera']) $(id).addEventListener('click', () => { this.renderer?.resetCamera(); this.audio.event('ack'); });

    // Results.
    $('result-next').addEventListener('click', () => this.resultsNext());
    $('result-retry').addEventListener('click', () => this.restartSession());
    $('result-exit').addEventListener('click', () => this.leaveToTitle());

    $('settings-close').addEventListener('click', () => this.closeSettings());

    // UI → game callbacks.
    ui.onAction = (cmd) => this.doAction(cmd);
    ui.onUndo = () => this.undo();
    ui.onPauseToggle = () => this.togglePause();
    ui.onCameraReset = () => this.renderer?.resetCamera();
    ui.onHoverCell = (cell) => {
      if (!this.renderer) return;
      this.renderer.setHover(cell ? cell.r : -1, cell ? cell.c : -1, this.ui.inputMode);
    };
    ui.onCursorMove = (r, c) => {
      if (this.renderer && this.ui.inputMode) this.renderer.setFocusCell(r, c);
      if (this.phase === 'active') this.audio.event('focus');
    };
    ui.onNavigate = () => { this.audio.event('ack'); };

    // Block context menu on the board: right button is "mark".
    document.getElementById('cells-grid').addEventListener('contextmenu', e => e.preventDefault());
  }

  setInputMode(mode) {
    this.ui.setInputMode(mode);
    this.store.settings.inputMode = mode;
    this.store.saveSettings();
    this.audio.event('ack');
  }

  // ------------------------------------------------------------------ title

  refreshTitle() {
    const p = this.store.progress;
    const done = Object.values(p.journey).filter(j => j.completed).length;
    document.getElementById('journey-sub').textContent = done
      ? `${done} of ${JOURNEY_STAGES.length} stages lit` : '40 stages of growing light';
    const key = utcDateKey(new Date(this.now()));
    const todayDone = p.dailies[key];
    document.getElementById('daily-sub').textContent = todayDone
      ? `Today: scored ${todayDone.score.toLocaleString()}` : 'One shared puzzle per UTC day';
    const name = this.platform.nickname || this.store.settings.profileName;
    const cloudNote = {
      loading: ' · syncing…', saving: ' · saving…',
      synced: ' · cloud synced', error: ' · sync failed — kept on this device',
    }[this.platform.syncState] || '';
    document.getElementById('btn-signin').hidden = !this.platform.canSignIn();
    document.getElementById('btn-invite').hidden = !this.platform.inviteLink();
    document.getElementById('profile-line').textContent =
      `${name ? name : 'Guest profile'} · progress saved on this device${this.hosted ? ` · connected${cloudNote}` : ' · offline'}`;
    // Resume affordance for the last safe snapshot.
    let resumeBtn = document.getElementById('btn-resume');
    if (p.lastSnapshot && !resumeBtn) {
      resumeBtn = document.createElement('button');
      resumeBtn.id = 'btn-resume';
      resumeBtn.className = 'ghost';
      resumeBtn.addEventListener('click', () => this.resumeSnapshot());
      document.getElementById('btn-play').parentElement.append(' ', resumeBtn);
    }
    if (resumeBtn) {
      if (p.lastSnapshot) {
        resumeBtn.hidden = false;
        resumeBtn.textContent = `Resume ${p.lastSnapshot.label} (${formatMs(p.lastSnapshot.stateElapsed)})`;
      } else resumeBtn.hidden = true;
    }
  }

  // ------------------------------------------------------------------ screens

  showJourney() {
    this.ui.buildJourneyGrid(JOURNEY_STAGES, this.store.progress);
    this.ui.show('screen-journey');
  }

  showLearn() {
    this.ui.buildLessonList(LESSONS, this.store.progress);
    this.ui.show('screen-learn');
  }

  showPractice() {
    const bests = {};
    for (const e of this.store.progress.leaderboard) {
      if (e.mode === 'practice') bests[e.presetId] = Math.max(bests[e.presetId] || 0, e.score);
    }
    this.ui.buildPracticeList(PRACTICE_PRESETS, bests);
    this.ui.show('screen-practice');
  }

  showChallenge() {
    const week = utcWeekKey(new Date(this.now()));
    document.getElementById('challenge-week').textContent = `ranked · ${week}`;
    this.ui.buildChallengeList(challengeSpecs(week), this.store.progress);
    this.ui.show('screen-challenge');
  }

  async showScores() {
    const p = this.store.progress;
    const key = utcDateKey(new Date(this.now()));
    const meName = this.platform.nickname || this.store.settings.profileName || 'You';
    let dailyEntries = [];
    let note = 'Local board (offline).';
    if (this.hosted) {
      try {
        const board = await this.platform.loadLeaderboard(20);
        if (board) {
          dailyEntries = board;
          note = 'Global board · platform-owned, read-only.';
        }
      } catch { /* fall through to local */ }
    }
    if (!dailyEntries.length) {
      const mine = p.dailies[key];
      if (mine) dailyEntries = [{ name: meName, me: true, ...mine }];
      note = this.hosted ? 'No global scores yet — be the first light.' : 'Local board (offline). Your daily results appear here.';
    }
    const localEntries = p.leaderboard.slice(0, 15).map(e => ({ ...e, me: true, name: e.name || meName }));
    this.ui.showScores({
      dailyEntries, localEntries,
      achievements: p.achievements,
      dailyNote: `${note} Streak: ${this.store.dailyStreak(key)} day(s).`,
    });
    this.ui.show('screen-scores');
  }

  // ------------------------------------------------------------------ sessions

  makeSession(kind, spec, label, opts = {}) {
    const puzzle = opts.puzzle || buildPuzzle(spec);
    const state = createState({
      id: puzzle.id, seed: puzzle.seed, rows: puzzle.rows, cols: puzzle.cols,
      solution: puzzle.solution, parMs: spec.parMs, constraints: spec.constraints,
    });
    return {
      kind, spec, puzzle, state, label,
      ranked: !!spec.ranked,
      undoStack: [],
      lesson: opts.lesson || null,
      replayEnv: createReplayEnvelope(state, CONTENT_VERSION, BUILD_VERSION),
      saveAt: 0,
    };
  }

  startJourney(stage) {
    this.session = this.makeSession('journey', stage, `Journey ${stage.index + 1}`);
    this.beginPlay();
  }

  startDaily() {
    const key = utcDateKey(new Date(this.now()));
    if (this.store.progress.excludedDailies.includes(key)) {
      this.ui.toast('Today’s board was marked defective and excluded from ranking — playing unranked.');
    }
    this.session = this.makeSession('daily', dailySpec(key), `Daily Glow ${key}`);
    this.beginPlay();
  }

  startPractice(preset, seedText) {
    const seed = seedText ? hashSeed(`practice:${seedText}:${preset.rows}x${preset.cols}`) : (hashSeed(preset.id) ^ (Date.now() % 0xFFFFFF)) >>> 0;
    const spec = {
      id: `${preset.id}-${seed.toString(16)}`, seed, rows: preset.rows, cols: preset.cols,
      density: preset.density, parMs: preset.rows * preset.cols * 4200,
      theme: this.store.settings.theme,
    };
    this.session = this.makeSession('practice', spec, `Practice · ${preset.name}`);
    this.session.presetId = preset.id;
    this.beginPlay();
  }

  startChallenge(spec) {
    this.session = this.makeSession('challenge', spec, spec.name);
    this.beginPlay();
  }

  startLesson(lesson) {
    const puzzle = {
      id: lesson.id, seed: hashSeed(lesson.id), rows: lesson.board.rows, cols: lesson.board.cols,
      solution: lesson.board.solution, name: lesson.name, theme: this.store.settings.theme,
    };
    const spec = {
      id: lesson.id, parMs: 10 * 60 * 1000,
      constraints: { allowHints: lesson.id === 'lesson-5', allowUndo: true },
    };
    this.session = this.makeSession('lesson', spec, `Lesson · ${lesson.name}`, {
      puzzle, lesson: { def: lesson, step: -1, count: 0 },
    });
    this.beginPlay();
  }

  beginPlay() {
    const s = this.session;
    this.phase = 'preparing';
    this.paused = false;
    this.ui.lessonBanner(null);
    this.ui.noteBoardSize(s.state.rows, s.state.cols);
    this.ui.buildBoard(s.state, themeById(s.puzzle.theme), this.flat);
    this.ui.setInputMode(this.store.settings.inputMode || 'fill');
    this.audio.setSeed(s.state.seed);
    if (this.audio.ctx && !this.audio.started) this.audio.startMusic(s.puzzle.theme);
    this.ui.show('screen-play');
    document.getElementById('rail-objective').textContent = this.objectiveText();
    document.getElementById('rail-par').textContent = `Par ${formatMs(s.state.parMs)}`;
    document.getElementById('rail-seed').textContent = `${s.puzzle.seed.toString(16)} · ${s.puzzle.rows}×${s.puzzle.cols} · ${s.puzzle.name}`;

    if (this.renderer) {
      this.renderer._applyTheme?.(themeById(s.puzzle.theme));
      this.renderer.setBoard(s.state.rows, s.state.cols, s.state.seed);
      this.renderer.syncState(s.state.grid, s.state.rows, s.state.cols);
    }
    this.onResize();
    this.updateHud();

    if (s.lesson) {
      this.phase = 'active'; // lessons guide through gating, no countdown
      this.advanceLesson();
    } else {
      this.runCountdown();
    }
    this.telemetry('round-start', { kind: s.kind, id: s.puzzle.id, rows: s.state.rows, cols: s.state.cols });
  }

  objectiveText() {
    const k = this.session.state.constraints;
    const parts = ['Reveal the hidden picture.'];
    if (k.timeLimitMs !== null) parts.push(`Finish within ${formatMs(k.timeLimitMs)}.`);
    if (k.maxMistakes !== null) parts.push(`At most ${k.maxMistakes} mistakes.`);
    if (k.moveLimit !== null) parts.push(`At most ${k.moveLimit} moves.`);
    if (k.allowMarks === false) parts.push('Marks are disabled.');
    if (k.allowHints === false) parts.push('Hints are disabled.');
    return parts.join(' ');
  }

  runCountdown() {
    const rm = this.store.settings.reducedMotion;
    this.phase = 'countdown';
    const gen = ++this._countdownGen; // stale chains from a previous session die here
    const steps = rm ? ['Glow'] : ['3', '2', '1', 'Glow'];
    let i = 0;
    const next = () => {
      if (!this.session || this.phase !== 'countdown' || gen !== this._countdownGen) return;
      if (i >= steps.length) {
        this.ui.countdown(null);
        this.phase = 'active';
        this._tickAcc = 0;
        return;
      }
      this.ui.countdown(steps[i]);
      this.audio.event(steps[i] === 'Glow' ? 'line' : 'countdown');
      i++;
      setTimeout(next, rm ? 500 : 620);
    };
    next();
  }

  restartSession() {
    if (!this.session) return;
    const { kind } = this.session;
    this.telemetry('retry', { kind });
    if (kind === 'journey') this.startJourney(this.session.spec);
    else if (kind === 'daily') this.startDaily();
    else if (kind === 'practice') {
      const prev = this.session;
      this.session = this.makeSession('practice', prev.spec, prev.label);
      this.session.presetId = prev.presetId;
      this.beginPlay();
    }
    else if (kind === 'challenge') this.startChallenge(this.session.spec);
    else if (kind === 'lesson') this.startLesson(this.session.lesson.def);
  }

  leaveToTitle() {
    if (this.session && this.phase === 'active') this.saveSnapshot();
    this.session = null;
    this.phase = 'title';
    this.ui.countdown(null);
    this.ui.lessonBanner(null);
    this.ui.overlay('overlay-pause', false);
    this.refreshTitle();
    this.ui.show('screen-title');
  }

  // ------------------------------------------------------------------ lessons

  advanceLesson() {
    const L = this.session.lesson;
    L.step++;
    L.count = 0;
    if (L.step >= L.def.steps.length) { this.ui.lessonBanner(null); return; }
    const st = L.def.steps[L.step];
    // Dynamic requirement count: when the step targets a row/column without a
    // count, count remaining matching actions from the live board. Clamp every
    // count (explicit or dynamic) to what is actually still possible — line
    // propagation can legitimately pre-satisfy a step (e.g. auto-crossed
    // empties), and a step with nothing left to do is skipped, never a wall.
    // The count lives on the session, never on the shared lesson definition.
    L.reqCount = st.requireCount ?? null;
    if (st.require.type === 'fill' || st.require.type === 'mark') {
      const remaining = st.require.type === 'fill'
        ? this.countRemaining(st.require) : this.countRemainingMark(st.require);
      if (remaining === 0) { this.advanceLesson(); return; }
      L.reqCount = Math.min(L.reqCount ?? remaining, remaining);
    }
    this.ui.lessonBanner(st.text, `${L.def.name} · step ${L.step + 1}/${L.def.steps.length}`);
    this.ui.announce(st.text);
    this.telemetry('tutorial-step', { lesson: L.def.id, step: L.step });
  }

  countRemaining(req) {
    const s = this.session.state;
    let n = 0;
    for (let i = 0; i < s.solution.length; i++) {
      const r = Math.floor(i / s.cols), c = i % s.cols;
      if (req.r !== undefined && req.r !== r) continue;
      if (req.c !== undefined && req.c !== c) continue;
      if (s.solution[i] === 1 && s.grid[i] !== CELL.FILLED) n++;
    }
    return n;
  }

  countRemainingMark(req) {
    const s = this.session.state;
    let n = 0;
    for (let i = 0; i < s.solution.length; i++) {
      const r = Math.floor(i / s.cols), c = i % s.cols;
      if (req.r !== undefined && req.r !== r) continue;
      if (req.c !== undefined && req.c !== c) continue;
      if (s.solution[i] === 0 && s.grid[i] === CELL.UNKNOWN) n++;
    }
    return n;
  }

  lessonGate(cmd) {
    const L = this.session?.lesson;
    if (!L || L.step < 0 || L.step >= L.def.steps.length) return true;
    const req = L.def.steps[L.step].require;
    const match = cmd.type === req.type &&
      (req.r === undefined || req.r === cmd.r) &&
      (req.c === undefined || req.c === cmd.c);
    if (!match) {
      this.audio.event('error');
      this.ui.toast('The lesson asks for a different move — follow the banner.');
      return false;
    }
    return true;
  }

  lessonProgress(cmd) {
    const L = this.session?.lesson;
    if (!L || L.step < 0 || L.step >= L.def.steps.length) return;
    L.count++;
    if (L.count >= (L.reqCount || 1)) this.advanceLesson();
  }

  // ------------------------------------------------------------------ actions

  doAction(cmd) {
    if (!this.session || this.phase !== 'active' || this.paused) return;
    const s = this.session.state;

    // Map UI "mark on a marked cell" to clear for toggle feel.
    if ((cmd.type === 'mark') && s.grid[cmd.r * s.cols + cmd.c] === CELL.MARKED) cmd = { ...cmd, type: 'clear' };

    if (!this.lessonGate(cmd)) return;

    const v = validate(s, cmd);
    if (!v.ok) {
      this.explainInvalid(v.reason);
      return;
    }
    // Undo snapshot (session-level, rules-validated on restore).
    if (['fill', 'mark', 'clear', 'hint'].includes(cmd.type) && s.constraints.allowUndo) {
      this.session.undoStack.push(s.grid.slice());
      if (this.session.undoStack.length > 200) this.session.undoStack.shift();
    }
    const res = applyCommand(s, { ...cmd, id: `${this.sessionId}-t${s.turn}` });
    replayRecord(this.session.replayEnv, s, cmd, res);
    this.lessonProgress(cmd);
    this.handleEvents(res.events);
    this.ui.syncBoard(s);
    this.renderer?.syncState(s.grid, s.rows, s.cols, res.events);
    this.updateHud();
    this.maybeSaveSnapshot();
    const term = res.events.find(e => e.type === 'terminal');
    if (term) this.onTerminal();
  }

  explainInvalid(reason) {
    const messages = {
      'not-active': 'The round is not active.',
      'out-of-bounds': 'That cell is outside the board.',
      'cell-locked': 'That cell is already lit — lit cells are certain.',
      'cell-not-unknown': 'Only untouched cells can be crossed.',
      'cell-not-marked': 'Only crossed cells can be cleared.',
      'marks-disabled': 'Marks are disabled in this challenge.',
      'hints-disabled': 'Hints are disabled here.',
      'move-limit': 'The move budget is spent.',
      'undo-disabled': 'Undo is not allowed in ranked play.',
      'nothing-to-reveal': 'Nothing left to reveal.',
    };
    const msg = messages[reason] || `That move is not legal (${reason}).`;
    this.ui.announce(msg, true);
    this.ui.toast(msg);
    this.audio.event('error');
  }

  handleEvents(events) {
    const s = this.session.state;
    for (const ev of events) {
      switch (ev.type) {
        case 'fill': this.audio.event('fill'); if (this.store.settings.captions) this.ui.announce('Cell lit'); break;
        case 'mark': this.audio.event('mark'); break;
        case 'clear': this.audio.event('clear'); break;
        case 'restore': this.audio.event('undo'); break;
        case 'propagate': this.audio.event('line'); this.ui.announce('A line resolved — certain cells crossed for you.'); break;
        case 'mistake':
          this.audio.event('error');
          this.ui.announce(`That cell is empty. Mistake ${s.mistakes}${s.constraints.maxMistakes !== null ? ` of ${s.constraints.maxMistakes}` : ''}.`, true);
          if (this.store.settings.captions) this.ui.toast('✕ That cell is empty — mistake counted');
          break;
        case 'hint': this.audio.event('hint'); this.ui.announce(`Hint revealed row ${ev.r + 1}, column ${ev.c + 1}.`); break;
        case 'terminal': break; // handled by onTerminal
      }
    }
  }

  undo() {
    if (!this.session || this.phase !== 'active' || this.paused) return;
    const s = this.session.state;
    const snap = this.session.undoStack.pop();
    if (!snap) { this.ui.toast('Nothing to undo.'); return; }
    const res = applyCommand(s, { type: 'restore', grid: snap });
    if (!res.ok) { this.explainInvalid(res.reason); return; }
    replayRecord(this.session.replayEnv, s, { type: 'restore', grid: snap }, res);
    this.handleEvents(res.events);
    this.ui.syncBoard(s);
    this.renderer?.syncState(s.grid, s.rows, s.cols, res.events);
    this.updateHud();
  }

  updateHud() {
    if (!this.session) return;
    const s = this.session.state;
    this.ui.setHud(s, `${this.session.label} — ${this.session.puzzle.name}`, {
      canUndo: s.constraints.allowUndo && this.session.undoStack.length > 0 && s.status === STATUS.ACTIVE,
      canHint: s.constraints.allowHints && s.status === STATUS.ACTIVE,
    });
  }

  // ------------------------------------------------------------------ pause

  togglePause(force) {
    if (!this.session) return;
    const want = force !== undefined ? force : !this.paused;
    if (want === this.paused) return;
    if (this.phase !== 'active' && want) return;
    this.paused = want;
    this.ui.overlay('overlay-pause', want);
    this.audio.event('pause');
    if (want) this.saveSnapshot();
    else this._tickAcc = 0;
  }

  onVisibility() {
    const hidden = document.hidden;
    this.audio.setHidden(hidden);
    if (hidden) {
      this.hiddenAt = Date.now();
      if (this.phase === 'active' && !this.paused) this.togglePause(true);
      this.saveSnapshot();
    } else {
      if (this.hiddenAt && Date.now() - this.hiddenAt > 4000 && this.session) {
        const away = Math.round((Date.now() - this.hiddenAt) / 1000);
        this.ui.toast(`Welcome back — away ${Math.floor(away / 60)}:${String(away % 60).padStart(2, '0')}. Solo play paused while you were gone.`);
      }
      this.hiddenAt = null;
    }
  }

  // ------------------------------------------------------------------ snapshots

  maybeSaveSnapshot() {
    const now = Date.now();
    if (now - this.session.saveAt > 4000) this.saveSnapshot();
  }

  saveSnapshot() {
    if (!this.session || this.phase === 'results') return;
    const s = this.session;
    if (s.state.status !== STATUS.ACTIVE) return;
    if (s.kind === 'lesson') return; // lessons are short; no snapshots
    this.store.progress.lastSnapshot = {
      savedAt: new Date().toISOString(),
      kind: s.kind, label: s.label,
      spec: s.spec, presetId: s.presetId,
      puzzle: { id: s.puzzle.id, seed: s.puzzle.seed, rows: s.puzzle.rows, cols: s.puzzle.cols, solution: s.puzzle.solution, name: s.puzzle.name, theme: s.puzzle.theme },
      stateJson: serialize(s.state),
      stateElapsed: s.state.elapsedMs,
      undoStack: s.undoStack.slice(-50),
      replayEnv: s.replayEnv, // ranked resumes must keep their full input log
    };
    s.saveAt = Date.now();
    this.store.saveProgress();
  }

  resumeSnapshot() {
    const snap = this.store.progress.lastSnapshot;
    if (!snap) return;
    try {
      const state = deserialize(snap.stateJson);
      this.session = {
        kind: snap.kind, spec: snap.spec, puzzle: snap.puzzle, state,
        label: snap.label, ranked: !!snap.spec.ranked,
        undoStack: snap.undoStack || [],
        lesson: null,
        replayEnv: snap.replayEnv || createReplayEnvelope(state, CONTENT_VERSION, BUILD_VERSION),
        saveAt: 0,
        presetId: snap.presetId,
      };
      this.beginPlay();
      this.ui.toast('Restored your last safe snapshot.');
    } catch (err) {
      console.warn('snapshot restore failed', err);
      this.store.progress.lastSnapshot = null;
      this.store.saveProgress();
    }
  }

  // ------------------------------------------------------------------ terminal

  onTerminal() {
    const s = this.session;
    const st = s.state;
    this.phase = 'resolving';
    this.ui.countdown(null);
    const won = st.status === STATUS.COMPLETE;
    this.audio.event(won ? 'win' : 'fail');
    if (won) this.audio.setMusicIntensity(1);

    const comp = scoreComponents(st);
    const clean = st.mistakes === 0 && st.hints === 0;
    const p = this.store.progress;
    const unlocked = [];

    // ---- progression recording (idempotent where applicable)
    if (won) {
      p.completions++;
      p.cleanStreak = clean ? p.cleanStreak + 1 : 0;
      p.bestCleanStreak = Math.max(p.bestCleanStreak, p.cleanStreak);
      if (this.grant('first-light')) unlocked.push('First Light');
      if (clean && this.grant('clean-sweep')) unlocked.push('Clean Sweep');
      if (p.cleanStreak >= 3 && this.grant('streak-3')) unlocked.push('Steady Glow');
      if (p.completions >= 100 && this.grant('century')) unlocked.push('Keeper of the Board');
    } else {
      p.cleanStreak = 0;
    }

    let progressText = '';
    if (s.kind === 'journey') {
      const rec = this.store.recordJourney(s.spec.id, {
        score: comp.total, mistakes: st.mistakes, hints: st.hints,
        elapsedMs: st.elapsedMs, parMs: st.parMs, completed: won,
      });
      const stars = '★'.repeat(rec.stars) + '☆'.repeat(3 - rec.stars);
      progressText = `Stage stars: ${stars}. ${won && s.spec.mastery ? 'Mastery stage cleared.' : ''}`;
      if (won && s.spec.mastery && this.grant('mastery')) unlocked.push('Mastery Bloom');
    } else if (s.kind === 'daily') {
      const key = s.spec.dateKey;
      if (won) {
        this.store.recordDaily(key, { score: comp.total, mistakes: st.mistakes, elapsedMs: st.elapsedMs, seed: st.seed.toString(16) });
        const streak = this.store.dailyStreak(key);
        progressText = `Daily streak: ${streak} day(s).`;
        if (streak >= 7 && this.grant('daily-7')) unlocked.push('Week of Light');
      } else progressText = 'The daily board keeps your best attempt — try again.';
      if (won) this.platform.flushCloudSave(); // ranked result mirrored to the cloud slot
    } else if (s.kind === 'challenge') {
      const prev = p.challenges[s.spec.id];
      if (won && (!prev || comp.total > prev.score)) {
        p.challenges[s.spec.id] = { score: comp.total, mistakes: st.mistakes, elapsedMs: st.elapsedMs };
        progressText = 'New personal best for this challenge.';
      } else progressText = won ? 'Challenge complete.' : 'Challenge failed — the constraint held.';
      this.store.saveProgress();
      if (won) this.platform.flushCloudSave();
    } else if (s.kind === 'practice') {
      p.practicePlays++;
      this.store.saveProgress();
      progressText = 'Practice is unranked — undo and hints were free.';
    } else if (s.kind === 'lesson') {
      p.lessons[s.lesson.def.id] = true;
      this.store.saveProgress();
      const done = LESSONS.filter(l => p.lessons[l.id]).length;
      progressText = `Lessons complete: ${done}/${LESSONS.length}.`;
      this.ui.lessonBanner(null);
    }

    this.postToLeaderboard(won && ['journey', 'daily', 'challenge'].includes(s.kind) ? comp.total : null);

    if (won && s.kind !== 'lesson') {
      this.store.addLeaderboard({
        name: this.platform.nickname || this.store.settings.profileName || 'You',
        score: comp.total, mistakes: st.mistakes, elapsedMs: st.elapsedMs,
        mode: s.kind, presetId: s.presetId, seed: st.seed.toString(16),
        ruleset: CONTENT_VERSION, date: new Date(this.now()).toISOString().slice(0, 10),
      });
    }

    this.telemetry('round-end', {
      kind: s.kind, won, score: comp.total, mistakes: st.mistakes,
      hints: st.hints, ms: st.elapsedMs,
    });

    // Clear snapshot: the round is over.
    p.lastSnapshot = null;
    this.store.saveProgress();

    // Cosmetic bloom may run longer than logic; results wait for it (skippable
    // via reduced motion, which settles instantly into the deterministic end).
    const wait = this.store.settings.reducedMotion ? 350 : 2100;
    setTimeout(() => {
      this.phase = 'results';
      const nextLabel = s.kind === 'journey' && won && s.spec.index < JOURNEY_STAGES.length - 1
        ? `Next stage ${s.spec.index + 2}` : 'Continue';
      this.ui.showResults({
        state: st, puzzle: s.puzzle,
        modeLabel: `${MODE_INFO.find(m => m.id === s.kind)?.name || s.kind}${s.ranked ? ' · ranked' : ''}`,
        sub: won
          ? `“${s.puzzle.name}” in ${formatMs(st.elapsedMs)} with ${st.mistakes} mistake(s), ${st.hints} hint(s).`
          : this.failText(st.reason),
        progressText, achievements: unlocked, nextLabel,
      });
      // Unlocks are listed on the results screen itself; a toast here would cover its buttons.
      this.audio.setMusicIntensity(0.3);
    }, wait);
  }

  // Hosted play only: post a won journey, daily or challenge round to the
  // platform high-score board; the results Progress card shows the rank.
  postToLeaderboard(total) {
    const line = document.getElementById('result-lb');
    const token = this.lbToken = {};
    line.hidden = true;
    if (total == null || !this.platform.hosted) return;
    const t = currentPlatformStrings();
    line.textContent = t.lbPosting;
    line.hidden = false;
    this.platform.submitScore(total).then((r) => {
      if (token !== this.lbToken) return;
      line.textContent = !r.posted ? t.lbFailed : r.rank ? t.lbRank.replace('{rank}', r.rank) : t.lbPosted;
    });
  }

  failText(reason) {
    return {
      [REASON.MISTAKES]: 'Too many wrong cells — the board went dark.',
      [REASON.TIME]: 'Time ran out.',
      [REASON.MOVES]: 'The move budget ran out.',
      [REASON.ABANDONED]: 'Attempt abandoned.',
    }[reason] || 'Attempt ended.';
  }

  grant(key) { return this.store.unlockAchievement(key); }

  resultsNext() {
    const s = this.session;
    if (s?.kind === 'journey' && s.state.status === STATUS.COMPLETE) {
      const next = JOURNEY_STAGES[s.spec.index + 1];
      if (next) { this.startJourney(next); return; }
    }
    if (s?.kind === 'lesson') { this.showLearn(); return; }
    this.leaveToTitle();
  }

  // ------------------------------------------------------------------ settings

  openSettings() {
    this.buildSettingsPanel();
    this.ui.overlay('overlay-settings', true);
    clearInterval(this._gfxTimer);
    this._gfxTimer = setInterval(() => this.refreshGraphicsSummary(), 1000);
  }

  closeSettings() {
    clearInterval(this._gfxTimer);
    this.ui.overlay('overlay-settings', false);
    this.store.saveSettings();
    this.telemetry('settings-change', {});
  }

  buildSettingsPanel() {
    const s = this.store.settings;
    const body = document.getElementById('settings-body');
    const row = (label, control, hint = '') => `
      <div class="set-row"><label>${label}${hint ? `<span class="hint">${hint}</span>` : ''}</label>${control}</div>`;
    const sel = (id, opts, val) => `<select id="${id}">${opts.map(([v, t]) => `<option value="${v}" ${v === val ? 'selected' : ''}>${t}</option>`).join('')}</select>`;
    const chk = (id, val) => `<input type="checkbox" id="${id}" ${val ? 'checked' : ''} role="switch" aria-checked="${val}">`;
    const rng = (id, val) => `<input type="range" id="${id}" min="0" max="1" step="0.05" value="${val}">`;

    body.innerHTML = `
      <h3 class="set-group">Profile</h3>
      ${row('Display name', `<input id="set-name" type="text" maxlength="24" value="${escapeHtml(this.platform.nickname || s.profileName)}" placeholder="Guest" ${this.platform.nickname ? 'disabled' : ''} style="background:var(--panel-2);border:1px solid var(--line);border-radius:8px;padding:8px">`, this.platform.nickname ? `Signed in as ${escapeHtml(this.platform.nickname)} — the platform account name is shown.` : 'Shown on boards. Account sign-in is offered by the host when available.')}
      <h3 class="set-group">Visual</h3>
      ${row('Theme', sel('set-theme', THEMES.map(t => [t.id, t.name]), s.theme))}
      ${row('Palette', sel('set-palette', [['standard', 'Standard'], ['cvd', 'Color-vision safe']], s.palette), 'Marks always use shapes as well as color.')}
      ${row('Reduced motion', chk('set-motion', s.reducedMotion), 'No camera swoops, shake or large scaling.')}
      ${row('High contrast', chk('set-contrast', s.highContrast))}
      ${row('Larger text', chk('set-text', s.largeText))}
      <div id="gfx-section"></div>
      <h3 class="set-group">Audio</h3>
      ${row('Mute all', chk('set-mute', s.muted))}
      ${row('Music', rng('set-vol-music', s.volumes.music))}
      ${row('Effects', rng('set-vol-effects', s.volumes.effects))}
      ${row('Ambience', rng('set-vol-ambience', s.volumes.ambience))}
      ${row('Captions', chk('set-captions', s.captions), 'Text cues for meaningful audio.')}
      <h3 class="set-group">Controls</h3>
      ${row('Left-handed tray', chk('set-lefty', s.leftHanded))}
      ${row('Hold to mark', chk('set-hold', s.holdToMark), 'When on, press-and-hold a cell to cross it (touch).')}
      <h3 class="set-group">Gamepad</h3>
      <div id="gamepad-map"></div>
      <h3 class="set-group">Privacy</h3>
      ${row('Anonymous usage stats', chk('set-telemetry', s.consentTelemetry), 'Only funnel events: start, tutorial step, round end, retry, settings, errors.')}
      <div class="set-row"><label>Replay tutorials<span class="hint">Reset lesson completion.</span></label><button id="set-reset-lessons" class="ghost">Reset</button></div>`;

    const $ = (id) => document.getElementById(id);
    $('set-name').addEventListener('change', () => {
      if ($('set-name').disabled) return; // hosted: platform account name wins
      s.profileName = $('set-name').value.trim();
      this.refreshTitle();
    });
    $('set-theme').addEventListener('change', () => {
      s.theme = $('set-theme').value;
      this.ui.setThemeVars(themeById(s.theme), s.palette);
      this.renderer?._applyTheme(themeById(s.theme));
    });
    $('set-palette').addEventListener('change', () => { s.palette = $('set-palette').value; this.ui.setThemeVars(themeById(s.theme), s.palette); });
    $('set-motion').addEventListener('change', () => { s.reducedMotion = $('set-motion').checked; this.ui.applyAccessibilityClasses(s); this.renderer?.setReducedMotion(s.reducedMotion); });
    $('set-contrast').addEventListener('change', () => { s.highContrast = $('set-contrast').checked; this.ui.applyAccessibilityClasses(s); });
    $('set-text').addEventListener('change', () => { s.largeText = $('set-text').checked; this.ui.applyAccessibilityClasses(s); });
    $('set-mute').addEventListener('change', () => { s.muted = $('set-mute').checked; this.audio.setMuted(s.muted); });
    for (const bus of ['music', 'effects', 'ambience']) {
      $(`set-vol-${bus}`).addEventListener('input', () => {
        s.volumes[bus] = parseFloat($(`set-vol-${bus}`).value);
        this.audio.ensure(); this.audio.setVolume(bus, s.volumes[bus]);
        if (bus === 'music' && !this.audio.started) this.audio.startMusic(s.theme);
      });
    }
    $('set-captions').addEventListener('change', () => { s.captions = $('set-captions').checked; });
    $('set-lefty').addEventListener('change', () => { s.leftHanded = $('set-lefty').checked; this.ui.applyAccessibilityClasses(s); });
    $('set-hold').addEventListener('change', () => { s.holdToMark = $('set-hold').checked; this.ui.holdToMark = s.holdToMark; });
    $('set-telemetry').addEventListener('change', () => { s.consentTelemetry = $('set-telemetry').checked; });
    $('set-reset-lessons').addEventListener('click', () => {
      this.store.progress.lessons = {}; this.store.saveProgress();
      this.ui.toast('Lessons reset — replay them from Learn.');
    });
    this.buildGamepadMap();
    this.buildGraphicsSection();
  }

  // Graphics: quality preset, render scale, per-category overrides, toggles.
  buildGraphicsSection() {
    const host = document.getElementById('gfx-section');
    if (!host) return;
    const T = this.gfxText;
    const saved = this.store.settings.graphics;
    const g = this.resolveGraphics();
    const opt = (v, label, cur) => `<option value="${v}" ${v === cur ? 'selected' : ''}>${escapeHtml(label)}</option>`;
    const row = (id, label, control, hint = '') => `
      <div class="set-row"><label for="${id}">${escapeHtml(label)}${hint ? `<span class="hint">${escapeHtml(hint)}</span>` : ''}</label>${control}</div>`;
    const presetSel = `<select id="gfx-preset" data-gfx="preset">${
      opt('auto', T.auto.replace('{tier}', T.tier[this.gfxAuto]), PRESETS.includes(saved.preset) ? saved.preset : 'auto')
    }${PRESETS.map(p => opt(p, T.tier[p], saved.preset)).join('')}</select>`;
    const pct = Math.round((Number(saved.render_scale) || 1) * 100);
    const scale = `<span class="gfx-scale"><input type="range" id="gfx-scale" data-gfx="render_scale" min="50" max="200" step="5" value="${pct}" aria-valuetext="${pct}%"><output id="gfx-scale-val" for="gfx-scale">${pct}%</output></span>`;
    const cats = Object.entries(CATEGORIES).map(([cat, tiers]) => {
      const cur = tiers.includes(saved[cat]) ? saved[cat] : 'preset';
      const control = `<select id="gfx-cat-${cat}" data-gfx-cat="${cat}">${
        opt('preset', T.fromPreset.replace('{tier}', T.val[presetTier(g.preset, cat)]), cur)
      }${tiers.map(t => opt(t, T.val[t], cur)).join('')}</select>`;
      return row(`gfx-cat-${cat}`, T.cat[cat], control);
    }).join('');
    const chk = (id, key, val) => `<input type="checkbox" id="${id}" data-gfx="${key}" role="switch" ${val ? 'checked' : ''} aria-checked="${!!val}">`;
    host.innerHTML = `
      <h3 class="set-group" id="gfx-h">${escapeHtml(T.section)}</h3>
      <div class="gfx-panel" role="group" aria-labelledby="gfx-h">
        ${row('gfx-preset', T.quality, presetSel, T.qualityHint)}
        ${row('gfx-scale', T.renderScale, scale, T.renderScaleHint)}
        ${cats}
        ${row('gfx-adaptive', T.adaptive, chk('gfx-adaptive', 'adaptive', g.adaptive), T.adaptiveHint)}
        ${row('gfx-fps', T.showFps, chk('gfx-fps', 'show_fps', g.showFps))}
        <p class="gfx-summary small dim" id="gfx-summary" aria-live="polite"></p>
        <p class="gfx-note small" id="gfx-note" hidden></p>
      </div>`;

    const $ = (id) => document.getElementById(id);
    const commit = (rebuild) => {
      this.applyGraphics();
      this.store.saveSettings();
      if (rebuild) this.buildGraphicsSection();
      else this.refreshGraphicsSummary();
    };
    $('gfx-preset').addEventListener('change', () => {
      this.store.settings.graphics = choosePreset(this.store.settings.graphics, $('gfx-preset').value);
      commit(true);
      $('gfx-preset').focus();
    });
    $('gfx-scale').addEventListener('input', () => {
      const v = parseInt($('gfx-scale').value, 10);
      $('gfx-scale-val').textContent = `${v}%`;
      $('gfx-scale').setAttribute('aria-valuetext', `${v}%`);
      this.store.settings.graphics.render_scale = v / 100;
      commit(false);
    });
    host.querySelectorAll('[data-gfx-cat]').forEach(sel => sel.addEventListener('change', () => {
      const gs = this.store.settings.graphics;
      if (sel.value === 'preset') delete gs[sel.dataset.gfxCat];
      else gs[sel.dataset.gfxCat] = sel.value;
      commit(false);
    }));
    for (const id of ['gfx-adaptive', 'gfx-fps']) {
      $(id).addEventListener('change', () => {
        this.store.settings.graphics[$(id).dataset.gfx] = $(id).checked;
        $(id).setAttribute('aria-checked', String($(id).checked));
        commit(false);
      });
    }
    this.refreshGraphicsSummary();
  }

  // "GPU name · cost summary · W×H px", plus a note when post-processing failed.
  refreshGraphicsSummary() {
    const el = document.getElementById('gfx-summary');
    if (!el) return;
    const T = this.gfxText;
    const info = this.renderer?.graphicsInfo();
    const g = this.gfx || this.resolveGraphics();
    const px = info && info.pixels[0] ? info.pixels : null;
    el.textContent = [this.gpu || T.unknownGpu, describe(g, px, T.words)].join(' · ');
    const note = document.getElementById('gfx-note');
    const msg = this.flat ? T.flat : info?.postFailed ? T.postFailed : '';
    note.hidden = !msg;
    note.textContent = msg;
  }

  buildGamepadMap() {
    const map = this.store.settings.gamepadMap;
    const host = document.getElementById('gamepad-map');
    if (!host) return;
    const actions = [['fill', 'Fill'], ['mark', 'Mark'], ['hint', 'Hint'], ['undo', 'Undo'], ['pause', 'Pause'], ['camera', 'Camera reset']];
    host.innerHTML = actions.map(([k, label]) => `
      <div class="set-row"><label>${label}</label>
      <button class="ghost" data-remap="${k}">Button ${map[k]}</button></div>`).join('');
    host.querySelectorAll('[data-remap]').forEach(btn => {
      btn.addEventListener('click', () => {
        this._remapTarget = btn.dataset.remap;
        btn.textContent = 'Press a gamepad button…';
      });
    });
  }

  // ------------------------------------------------------------------ gamepad

  pollGamepad() {
    const pads = navigator.getGamepads?.() || [];
    const gp = [...pads].find(p => p && p.connected);
    if (!gp) return;
    const map = this.store.settings.gamepadMap;
    const pressed = gp.buttons.map(b => b.pressed);
    const edge = (i) => pressed[i] && !this._gamepad.prev[i];

    if (this._remapTarget !== null) {
      const idx = pressed.findIndex(p => p);
      if (idx >= 0) {
        map[this._remapTarget] = idx;
        this.store.saveSettings();
        this._remapTarget = null;
        this.buildGamepadMap();
        this.ui.buildHelpControls(map);
        this.ui.toast(`Mapped to button ${idx}.`);
      }
    } else if (this.phase === 'active' && !this.paused) {
      // Focus navigation: dpad + left stick with repeat gating.
      const now = performance.now();
      const ax = gp.axes[0] || 0, ay = gp.axes[1] || 0;
      const dpad = [edge(14), edge(15), edge(12), edge(13)]; // L R U D
      let dr = 0, dc = 0;
      if (dpad[0] || ax < -0.6) dc = -1;
      else if (dpad[1] || ax > 0.6) dc = 1;
      if (dpad[2] || ay < -0.6) dr = -1;
      else if (dpad[3] || ay > 0.6) dr = 1;
      if ((dr || dc) && now - this._gamepad.axisAt > 170) {
        this._gamepad.axisAt = now;
        const { r, c } = this.ui.cursor;
        const rows = this.session.state.rows, cols = this.session.state.cols;
        this.ui.setCursor((r + dr + rows) % rows, (c + dc + cols) % cols, false);
      }
      const { r, c } = this.ui.cursor;
      if (edge(map.fill)) this.doAction({ type: 'fill', r, c });
      if (edge(map.mark)) this.doAction({ type: 'mark', r, c });
      if (edge(map.hint)) this.doAction({ type: 'hint' });
      if (edge(map.undo)) this.undo();
      if (edge(map.camera)) this.renderer?.resetCamera();
    }
    if (edge(map.pause) && this.session && (this.phase === 'active')) this.togglePause();
    this._gamepad.prev = pressed;
  }

  // ------------------------------------------------------------------ loop

  loop(t) {
    requestAnimationFrame((tt) => this.loop(tt));
    const dt = Math.min(0.1, (t - this._lastFrame) / 1000);
    this._lastFrame = t;

    this.pollGamepad();

    if (this.session && this.phase === 'active' && !this.paused && !document.hidden) {
      // Quantized authoritative ticks (500 ms quanta).
      this._tickAcc += dt * 1000;
      if (this._tickAcc >= 500) {
        const ms = Math.floor(this._tickAcc);
        this._tickAcc -= ms;
        const cmd = { type: 'tick', ms };
        const res = applyCommand(this.session.state, cmd);
        if (res.ok) {
          // Ticks are authoritative inputs: they belong in the replay log or
          // the server's re-simulation diverges (elapsed time, score, hashes).
          replayRecord(this.session.replayEnv, this.session.state, cmd, res);
          this.updateHud();
          const term = res.events.find(e => e.type === 'terminal');
          if (term) { this.onTerminal(); }
        }
      }
      // Music intensity follows progress.
      if (this.session.state.filledCount) {
        const lit = this.session.state.grid.filter((g, i) => g === CELL.FILLED && this.session.state.solution[i] === 1).length;
        this.audio.setMusicIntensity(0.25 + 0.6 * (lit / this.session.state.filledCount));
      }
    }

    if (this.renderer && this.session && (this.phase !== 'title')) {
      this.renderer.update(dt, this.session.state.grid);
      // Keep DOM controls aligned with projected 3D targets.
      this._layoutCounter++;
      if (this._layoutCounter % 2 === 0 || this.renderer.transition) {
        const proj = this.renderer.projectCells();
        if (proj) this.ui.layoutBoard(proj);
      }
    } else if (this.renderer && this.phase === 'title') {
      this.renderer.update(dt, null);
    }
  }

  onResize() {
    const pf = document.getElementById('playfield');
    if (this.renderer && pf.clientWidth) this.renderer.resize(pf.clientWidth, pf.clientHeight);
    if (this.flat && this.session) this.ui.layoutFlat(this.session.state);
    this.syncSafeInsets();
  }

  // Chrome overlaying the playfield (lesson banner, tray) is carved out of the
  // board's safe area so no required cell hides beneath it.
  syncSafeInsets() {
    if (!this.renderer) return;
    const pf = document.getElementById('playfield');
    if (!pf || !pf.clientWidth) return;
    const cr = pf.getBoundingClientRect();
    const W = cr.width, H = cr.height;
    const ins = { left: 0, right: 0, top: 0, bottom: 0 };
    for (const id of ['lesson-banner', 'tray']) {
      const el = document.getElementById(id);
      if (!el || el.hidden || !el.offsetParent) continue;
      const r = el.getBoundingClientRect();
      if (!r.width || !r.height) continue;
      const e = { l: (r.left - cr.left) / W, t: (r.top - cr.top) / H, r: (r.right - cr.left) / W, b: (r.bottom - cr.top) / H };
      if (e.b <= 0 || e.t >= 1) continue; // outside the playfield
      if (e.r - e.l < 0.5 && e.r <= 0.5) ins.left = Math.max(ins.left, e.r);
      else if (e.r - e.l < 0.5 && e.l >= 0.5) ins.right = Math.max(ins.right, 1 - e.l);
      else if (e.t >= 0.5) ins.bottom = Math.max(ins.bottom, 1 - e.t);
      else ins.top = Math.max(ins.top, e.b);
    }
    // Row clues sit left of the cell grid; reserve their pixel width so the
    // camera fit keeps them on screen (narrow portrait views clipped them).
    const clue = document.querySelector('#row-clues .clue');
    const font = clue ? parseFloat(getComputedStyle(clue).fontSize) || 12 : 12;
    const nr = this.ui.maxRowClues || 1;
    ins.clueLeftPx = nr * 1.15 * font + (nr - 1) * 4 + 6 + 4;
    this.renderer.setSafeInsets(ins);
  }

  // ------------------------------------------------------------------ telemetry

  telemetry(type, data) {
    if (!this.store.settings.consentTelemetry) return;
    this.telemetryQueue.push({ type, data, at: Date.now(), sid: this.sessionId });
    if (this.telemetryQueue.length >= 5) this.flushTelemetry();
  }

  async flushTelemetry() {
    // The platform has no client-reachable telemetry endpoint; the funnel
    // intake below is this repo's own dev server (server.js) only.
    if (this.hosted || !this.ownServer || !this.telemetryQueue.length) return;
    const events = this.telemetryQueue.splice(0);
    try {
      await fetch('/api/v1/telemetry', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ events }), signal: AbortSignal.timeout(3000),
      });
    } catch { this.telemetryQueue.unshift(...events); }
  }
}

// ---------------------------------------------------------------------------

const game = new Game();
game.boot().catch(err => {
  console.error('[boot]', err);
  document.body.innerHTML = `<p style="padding:2em">Picture Logic failed to start: ${escapeHtml(err.message)}. Your saved progress is untouched.</p>`;
});
window.__pictureLogic = game; // debug/validation handle
