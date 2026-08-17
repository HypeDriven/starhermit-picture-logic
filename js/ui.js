// Picture Logic — DOM shell: screens, overlays, board overlay, input,
// settings, accessibility mirror. UI state is kept separate from simulation
// state; closing a drawer can never affect a round.
'use strict';

import { CELL, STATUS, scoreComponents, legalTargets } from './rules.js';
import { THEMES, CVD_PALETTE } from './content.js';
import { ACHIEVEMENTS } from './store.js';

const $ = (id) => document.getElementById(id);

export const MODE_INFO = [
  { id: 'learn', name: 'Learn', desc: 'Five interactive lessons — one rule at a time.', ranked: false },
  { id: 'journey', name: 'Journey', desc: 'Forty authored stages with mastery gates.', ranked: false },
  { id: 'daily', name: 'Daily Glow', desc: 'One shared seed per UTC day. No undo.', ranked: true },
  { id: 'practice', name: 'Practice', desc: 'Pick a size, use undo and hints freely.', ranked: false },
  { id: 'challenge', name: 'Challenge', desc: 'Weekly constrained goals: clocks, move budgets, no marks.', ranked: true },
  { id: 'scores', name: 'Score Chase', desc: 'Leaderboards, streaks and achievements.', ranked: false },
];

export class UI {
  constructor() {
    this.screens = [...document.querySelectorAll('.screen')];
    this.current = 'screen-title';
    this.focusMemory = new Map();
    this.cellButtons = [];
    this.cursor = { r: 0, c: 0 };
    this.inputMode = 'fill';
    this.flat = false;
    this.onAction = () => {};      // (cmd) => {}
    this.onNavigate = () => {};    // (screenId) => {}
    this.onPauseRequest = () => {};
    this.onModeChange = () => {};
    this.onHoverCell = () => {};
    this.onCursorMove = () => {};
    this._paint = null;            // active drag stroke
    this._lastFocus = null;
    this._bindStatic();
  }

  // ---------------------------------------------------------------- screens

  show(screenId) {
    for (const s of this.screens) s.classList.toggle('active', s.id === screenId);
    const prev = this.current;
    this.current = screenId;
    // Focus first heading/control for screen readers and keyboard users.
    const el = $(screenId);
    const target = el.querySelector('h1, button.primary, button');
    if (target) requestAnimationFrame(() => {
      if (target.tabIndex < 0 && target.tagName === 'H1') target.tabIndex = -1;
      target.focus({ preventScroll: true });
    });
    this.onNavigate(screenId, prev);
  }

  overlay(id, open) {
    const el = $(id);
    if (open) {
      this._lastFocus = document.activeElement;
      el.classList.add('active');
      const first = el.querySelector('button.primary, button');
      requestAnimationFrame(() => first?.focus());
      // Simple focus trap.
      el.addEventListener('keydown', this._trap = (e) => {
        if (e.key !== 'Tab') return;
        const focusables = [...el.querySelectorAll('button, input, select, [tabindex]')]
          .filter(f => !f.disabled && f.offsetParent !== null);
        if (!focusables.length) return;
        const first = focusables[0], last = focusables[focusables.length - 1];
        if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
        else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
      });
    } else {
      el.classList.remove('active');
      el.removeEventListener('keydown', this._trap);
      if (this._lastFocus && document.contains(this._lastFocus)) {
        this._lastFocus.focus({ preventScroll: true });
      }
    }
  }

  toast(text, cls = '') {
    const t = document.createElement('div');
    t.className = `toast ${cls}`;
    t.textContent = text;
    $('toasts').appendChild(t);
    setTimeout(() => { t.style.opacity = '0'; t.style.transition = 'opacity 400ms'; }, 2600);
    setTimeout(() => t.remove(), 3100);
  }

  announce(text, urgent = false) {
    $(urgent ? 'live-urgent' : 'live').textContent = text;
  }

  // ------------------------------------------------------------ static wiring

  _bindStatic() {
    document.querySelectorAll('.back-btn').forEach(b => {
      b.addEventListener('click', () => this.show(b.dataset.target));
    });
    // Delegated keyboard for the play screen.
    document.addEventListener('keydown', (e) => this._onKey(e));
  }

  setThemeVars(theme, palette) {
    const root = document.documentElement.style;
    root.setProperty('--bg', theme.ui.bg);
    root.setProperty('--filled', palette === 'cvd' ? CVD_PALETTE.filled : theme.ui.filled);
    root.setProperty('--marked', palette === 'cvd' ? CVD_PALETTE.marked : theme.ui.marked);
    root.setProperty('--accent', palette === 'cvd' ? CVD_PALETTE.accent : theme.ui.accent);
    document.body.classList.toggle('palette-cvd', palette === 'cvd');
  }

  applyAccessibilityClasses(s) {
    document.body.classList.toggle('high-contrast', s.highContrast);
    document.body.classList.toggle('reduced-motion', s.reducedMotion);
    document.body.classList.toggle('left-handed', s.leftHanded);
    document.documentElement.style.setProperty('--font-scale', s.largeText ? '1.18' : '1');
  }

  // ------------------------------------------------------------ mode screens

  buildModeList(progress) {
    const list = $('mode-list');
    list.innerHTML = '';
    for (const m of MODE_INFO) {
      const btn = document.createElement('button');
      btn.className = 'row-btn';
      btn.innerHTML = `<span class="grow"><strong>${m.name}</strong><br>
        <span class="sub">${m.desc}</span></span>
        ${m.ranked ? '<span class="badge ranked">ranked</span>' : ''}`;
      btn.addEventListener('click', () => this.onModeSelect?.(m.id));
      list.appendChild(btn);
    }
  }

  buildJourneyGrid(stages, progress) {
    const grid = $('stage-grid');
    grid.innerHTML = '';
    let completedCount = 0;
    stages.forEach((s, i) => {
      const rec = progress.journey[s.id];
      if (rec?.completed) completedCount++;
      const unlocked = i === 0 || !!progress.journey[stages[i - 1].id]?.completed;
      const btn = document.createElement('button');
      btn.className = 'stage-btn' + (s.mastery ? ' mastery' : '') + (unlocked ? '' : ' locked');
      btn.disabled = !unlocked;
      const stars = rec ? '★'.repeat(rec.stars) + '☆'.repeat(3 - rec.stars) : '☆☆☆';
      btn.innerHTML = `<span>${i + 1}</span><span class="stars" aria-label="${rec?.stars || 0} of 3 stars">${stars}</span>`;
      btn.setAttribute('role', 'listitem');
      btn.setAttribute('aria-label', `Stage ${i + 1}${s.mastery ? ' (mastery)' : ''}, ${s.rows} by ${s.cols}${unlocked ? '' : ', locked'}`);
      if (unlocked) btn.addEventListener('click', () => this.onJourneyStage?.(s));
      grid.appendChild(btn);
    });
    $('journey-progress-badge').textContent = `${completedCount} / ${stages.length} done`;
  }

  buildPracticeList(presets, bests) {
    const list = $('practice-list');
    list.innerHTML = '';
    for (const p of presets) {
      const btn = document.createElement('button');
      btn.className = 'row-btn';
      const best = bests[p.id];
      btn.innerHTML = `<span class="grow"><strong>${p.name}</strong> · ${p.rows}×${p.cols}<br>
        <span class="sub">${p.note}${best ? ` · best ${best.toLocaleString()}` : ''}</span></span>`;
      btn.addEventListener('click', () => this.onPracticePreset?.(p));
      list.appendChild(btn);
    }
  }

  buildChallengeList(specs, progress) {
    const list = $('challenge-list');
    list.innerHTML = '';
    for (const c of specs) {
      const btn = document.createElement('button');
      btn.className = 'row-btn';
      const rec = progress.challenges[c.id];
      const rules = [];
      if (c.constraints.timeLimitMs) rules.push(`⏱ ${Math.round(c.constraints.timeLimitMs / 1000)}s limit`);
      if (c.constraints.maxMistakes) rules.push(`${c.constraints.maxMistakes} mistakes max`);
      if (c.constraints.allowMarks === false) rules.push('no marks');
      if (c.constraints.allowHints === false) rules.push('no hints');
      if (c.constraints.moveLimit) rules.push(`${c.constraints.moveLimit} moves max`);
      btn.innerHTML = `<span class="grow"><strong>${c.name}</strong> · ${c.rows}×${c.cols}<br>
        <span class="sub">${c.desc} · ${rules.join(' · ')}${rec ? ` · best ${rec.score.toLocaleString()}` : ''}</span></span>
        <span class="badge ranked">ranked</span>`;
      btn.addEventListener('click', () => this.onChallenge?.(c));
      list.appendChild(btn);
    }
  }

  buildLessonList(lessons, progress) {
    const list = $('lesson-list');
    list.innerHTML = '';
    lessons.forEach((l, i) => {
      const done = !!progress.lessons[l.id];
      const btn = document.createElement('button');
      btn.className = 'row-btn';
      btn.innerHTML = `<span class="grow"><strong>${i + 1}. ${l.name}</strong><br>
        <span class="sub">${l.goal}</span></span>${done ? '<span class="badge ranked">done</span>' : ''}`;
      btn.addEventListener('click', () => this.onLesson?.(l));
      list.appendChild(btn);
    });
  }

  buildHelpControls(gamepadMap) {
    const grid = $('controls-grid');
    const rows = [
      ['Move cursor', 'Arrow keys / D-pad / left stick'],
      ['Fill cell', `<kbd>Enter</kbd> / <kbd>Space</kbd> / gamepad button ${gamepadMap.fill}`],
      ['Mark ✕', `<kbd>X</kbd> / gamepad button ${gamepadMap.mark}`],
      ['Clear mark', '<kbd>C</kbd> or <kbd>Backspace</kbd>'],
      ['Hint', `<kbd>H</kbd> / gamepad button ${gamepadMap.hint}`],
      ['Undo', `<kbd>U</kbd> / gamepad button ${gamepadMap.undo}`],
      ['Pause', `<kbd>P</kbd> or <kbd>Esc</kbd> / gamepad button ${gamepadMap.pause}`],
      ['Reset camera', `<kbd>R</kbd> / gamepad button ${gamepadMap.camera}`],
    ];
    grid.innerHTML = rows.map(([k, v]) => `<div class="help-card"><h3>${k}</h3><p>${v}</p></div>`).join('');
  }

  // ------------------------------------------------------------ play board

  buildBoard(state, theme, flat) {
    this.flat = flat;
    $('playfield').classList.toggle('flat', flat);
    const { rows, cols, rowClues, colClues } = state;

    const colEl = $('col-clues');
    colEl.innerHTML = '';
    colEl.style.gridTemplateColumns = `repeat(${cols}, 1fr)`;
    for (let c = 0; c < cols; c++) {
      const line = document.createElement('div');
      line.className = 'clue-line';
      line.dataset.col = c;
      const clues = colClues[c].length ? colClues[c] : [0];
      for (const n of clues) {
        const s = document.createElement('span');
        s.className = 'clue'; s.textContent = n;
        line.appendChild(s);
      }
      colEl.appendChild(line);
    }

    const rowEl = $('row-clues');
    rowEl.innerHTML = '';
    rowEl.style.gridTemplateRows = `repeat(${rows}, 1fr)`;
    for (let r = 0; r < rows; r++) {
      const line = document.createElement('div');
      line.className = 'clue-line';
      line.dataset.row = r;
      const clues = rowClues[r].length ? rowClues[r] : [0];
      for (const n of clues) {
        const s = document.createElement('span');
        s.className = 'clue'; s.textContent = n;
        line.appendChild(s);
      }
      rowEl.appendChild(line);
    }

    const grid = $('cells-grid');
    grid.innerHTML = '';
    grid.style.gridTemplate = `repeat(${rows}, 1fr) / repeat(${cols}, 1fr)`;
    this.cellButtons = [];
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        const b = document.createElement('button');
        b.className = 'cell-btn';
        b.dataset.r = r; b.dataset.c = c;
        b.setAttribute('role', 'gridcell');
        b.setAttribute('aria-label', this._cellLabel(state, r, c));
        grid.appendChild(b);
        this.cellButtons.push(b);
      }
    }
    this.cursor = { r: 0, c: 0 };
    this._paintBound = this._paintBound || this._bindPainting(grid);
    this.maxRowClues = Math.max(...rowClues.map(x => x.length), 1);
    this.maxColClues = Math.max(...colClues.map(x => x.length), 1);
    this.syncBoard(state);
  }

  _cellLabel(state, r, c) {
    const v = state.grid[r * state.cols + c];
    const word = v === CELL.FILLED ? 'lit' : v === CELL.MARKED ? 'crossed' : 'unknown';
    return `Row ${r + 1}, column ${c + 1}, ${word}`;
  }

  // Pointer painting with a stroke set so a drag never double-commits a cell.
  _bindPainting(grid) {
    const cellFromEvent = (e) => {
      const el = document.elementFromPoint(e.clientX, e.clientY);
      return el?.closest?.('.cell-btn') || null;
    };
    grid.addEventListener('pointerdown', (e) => {
      const b = e.target.closest('.cell-btn');
      if (!b) return;
      e.preventDefault();
      const cell = { r: +b.dataset.r, c: +b.dataset.c };
      this.setCursor(cell.r, cell.c, false);
      let action = this._actionFor(e);
      // Hold-to-mark (touch): a press held past the threshold becomes a mark.
      if (this.holdToMark && e.pointerType === 'touch' && action === 'fill') {
        action = 'fill';
        this._holdTimer = setTimeout(() => {
          if (this._paint) {
            this._paint.action = 'mark';
            this._applyPaint(cell);
          }
        }, 380);
      }
      this._paint = { action, done: new Set() };
      this._applyPaint(cell);
      grid.setPointerCapture?.(e.pointerId);
    });
    grid.addEventListener('pointermove', (e) => {
      const b = cellFromEvent(e);
      if (b) {
        const cell = { r: +b.dataset.r, c: +b.dataset.c };
        this.onHoverCell(cell);
        if (this._paint) this._applyPaint(cell);
      } else {
        this.onHoverCell(null);
      }
    });
    const end = (e) => {
      if (this._holdTimer) { clearTimeout(this._holdTimer); this._holdTimer = null; }
      this._paint = null;
      grid.releasePointerCapture?.(e.pointerId);
    };
    grid.addEventListener('pointerup', end);
    grid.addEventListener('pointercancel', end);
    grid.addEventListener('lostpointercapture', () => { this._paint = null; });
    return true;
  }

  _actionFor(e) {
    // Hold-to-mark setting: right button / pen barrel / long-press marks.
    if (e.button === 2 || e.buttons === 2) return 'mark';
    return this.inputMode;
  }

  _applyPaint(cell) {
    const key = `${cell.r},${cell.c}`;
    if (this._paint.done.has(key)) return; // idempotent within a stroke
    this._paint.done.add(key);
    this.onAction({ type: this._paint.action, r: cell.r, c: cell.c, stroke: key });
  }

  // Position the DOM overlay exactly over the projected 3D board.
  layoutBoard(rect) {
    if (!rect || this.flat) return;
    const frame = $('board-frame');
    const clueFont = Math.min(17, Math.max(10, Math.min(rect.cellW, rect.cellH) * 0.42));
    const lineH = clueFont * 1.22;
    const ch = this.maxColClues * lineH + 6;
    const cw = this.maxRowClues * clueFont * 0.75 + 12;
    frame.style.left = `${rect.left - cw}px`;
    frame.style.top = `${rect.top - ch}px`;
    frame.style.width = `${rect.width + cw}px`;
    frame.style.height = `${rect.height + ch}px`;
    frame.style.gridTemplateColumns = `${cw}px 1fr`;
    frame.style.gridTemplateRows = `${ch}px 1fr`;
    frame.style.fontSize = `${clueFont}px`;
    const last = this._lastRect || {};
    if (Math.abs((last.w || 0) - rect.width) > 1) {
      this._lastRect = { w: rect.width };
    }
  }

  // Flat fallback sizing when WebGL is unavailable.
  layoutFlat(state) {
    if (!this.flat) return;
    const pf = $('playfield');
    const availW = pf.clientWidth - 24, availH = pf.clientHeight - 24;
    const clueW = this.maxRowClues * 1.1 + 1;
    const clueH = this.maxColClues * 1.3 + 1;
    const cell = Math.max(18, Math.min(48,
      Math.floor(Math.min(availW / (state.cols + clueW), availH / (state.rows + clueH)))));
    const frame = $('board-frame');
    frame.style.width = `${(state.cols + clueW) * cell}px`;
    frame.style.height = `${(state.rows + clueH) * cell}px`;
    frame.style.gridTemplateColumns = `${clueW * cell}px 1fr`;
    frame.style.gridTemplateRows = `${clueH * cell}px 1fr`;
    frame.style.fontSize = `${Math.max(10, cell * 0.4)}px`;
  }

  syncBoard(state) {
    const { rows, cols } = state;
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        const i = r * cols + c;
        const b = this.cellButtons[i];
        const v = state.grid[i];
        b.classList.toggle('filled', v === CELL.FILLED);
        b.classList.toggle('marked', v === CELL.MARKED);
        b.setAttribute('aria-label', this._cellLabel(state, r, c));
        b.setAttribute('aria-selected', this.cursor.r === r && this.cursor.c === c ? 'true' : 'false');
        b.classList.toggle('cursor', this.cursor.r === r && this.cursor.c === c);
      }
    }
    // Clue line completion: a line is done when all its filled cells are placed.
    for (let r = 0; r < rows; r++) {
      let done = true;
      for (let c = 0; c < cols; c++) {
        if (state.solution[r * cols + c] === 1 && state.grid[r * cols + c] !== CELL.FILLED) { done = false; break; }
      }
      document.querySelector(`#row-clues .clue-line[data-row="${r}"]`)?.classList.toggle('done', done);
    }
    for (let c = 0; c < cols; c++) {
      let done = true;
      for (let r = 0; r < rows; r++) {
        if (state.solution[r * cols + c] === 1 && state.grid[r * cols + c] !== CELL.FILLED) { done = false; break; }
      }
      document.querySelector(`#col-clues .clue-line[data-col="${c}"]`)?.classList.toggle('done', done);
    }
    // Active-line highlight for the cursor.
    document.querySelectorAll('.clue-line.active-line').forEach(el => el.classList.remove('active-line'));
    document.querySelector(`#row-clues .clue-line[data-row="${this.cursor.r}"]`)?.classList.add('active-line');
    document.querySelector(`#col-clues .clue-line[data-col="${this.cursor.c}"]`)?.classList.add('active-line');
  }

  setCursor(r, c, moveFocus = true) {
    if (!this.cellButtons.length) return;
    const rows = this._rows ?? 0, cols = this._cols ?? 0;
    this.cursor = { r, c };
    this.cellButtons.forEach(b => {
      const on = +b.dataset.r === r && +b.dataset.c === c;
      b.classList.toggle('cursor', on);
      b.setAttribute('aria-selected', on ? 'true' : 'false');
    });
    this.onCursorMove(r, c);
    if (moveFocus) this.cellButtons[r * cols + c]?.focus({ preventScroll: true });
  }

  noteBoardSize(rows, cols) { this._rows = rows; this._cols = cols; }

  // ------------------------------------------------------------ HUD & tray

  setHud(state, puzzleName, opts = {}) {
    $('hud-objective').textContent = puzzleName;
    const secs = Math.floor(state.elapsedMs / 1000);
    $('hud-time').textContent = `${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, '0')}`;
    const k = state.constraints;
    $('hud-mistakes').textContent = k.maxMistakes !== null ? `${state.mistakes}/${k.maxMistakes}` : String(state.mistakes);
    $('hud-mistakes-wrap').classList.toggle('danger', k.maxMistakes !== null && state.mistakes >= k.maxMistakes - 1);
    $('hud-moves').textContent = k.moveLimit !== null ? `${state.moves}/${k.moveLimit}` : String(state.moves);
    const lit = state.grid.filter((g, i) => g === CELL.FILLED && state.solution[i] === 1).length;
    $('hud-progress').textContent = `${Math.round(100 * lit / state.filledCount)}%`;
    if (k.timeLimitMs !== null) {
      const remain = Math.max(0, k.timeLimitMs - state.elapsedMs);
      const rs = Math.ceil(remain / 1000);
      $('hud-time').textContent = `−${Math.floor(rs / 60)}:${String(rs % 60).padStart(2, '0')}`;
      $('hud-time').parentElement.classList.toggle('danger', remain < 20000);
    }
    $('btn-undo').disabled = !opts.canUndo;
    $('btn-hint').disabled = !opts.canHint;
    $('rail-undo').disabled = !opts.canUndo;
    $('rail-hint').disabled = !opts.canHint;
  }

  setInputMode(mode) {
    this.inputMode = mode;
    for (const id of ['mode-fill', 'rail-mode-fill']) $(id).setAttribute('aria-pressed', mode === 'fill' ? 'true' : 'false');
    for (const id of ['mode-mark', 'rail-mode-mark']) $(id).setAttribute('aria-pressed', mode === 'mark' ? 'true' : 'false');
  }

  countdown(text) {
    const el = $('countdown');
    if (text === null) { el.classList.remove('active'); return; }
    el.classList.add('active');
    el.querySelector('.num').textContent = text;
  }

  lessonBanner(text, stepLabel) {
    const b = $('lesson-banner');
    if (text === null) { b.hidden = true; return; }
    b.hidden = false;
    $('lesson-step-k').textContent = stepLabel;
    $('lesson-text').textContent = text;
  }

  // ------------------------------------------------------------ results

  showResults({ state, puzzle, modeLabel, sub, progressText, achievements, nextLabel }) {
    const comp = scoreComponents(state);
    $('result-title').textContent = state.status === STATUS.COMPLETE ? 'Picture revealed' : 'The light faded';
    $('result-mode').textContent = modeLabel;
    $('result-sub').textContent = sub;
    const rows = [
      ['Picture cells', comp.base],
      ['Board size', comp.sizeBonus],
      ['Time bonus', comp.timeBonus],
      ['Clean board', comp.cleanBonus],
      ['Mistakes', -comp.mistakePenalty, 'neg'],
      ['Hints', -comp.hintPenalty, 'neg'],
    ];
    $('score-table').innerHTML =
      rows.map(([k, v, cls]) => `<tr class="${cls || ''}"><td>${k}</td><td>${v >= 0 ? '+' : ''}${v.toLocaleString()}</td></tr>`).join('') +
      `<tr class="total"><td>Total</td><td>${comp.total.toLocaleString()}</td></tr>`;
    $('result-progress').textContent = progressText;
    const ac = $('result-achv-card');
    if (achievements?.length) {
      ac.hidden = false;
      $('result-achv').textContent = achievements.join(' · ');
    } else ac.hidden = true;
    $('result-next').textContent = nextLabel;
    this.show('screen-results');
  }

  // ------------------------------------------------------------ scores

  showScores({ dailyEntries, localEntries, achievements, dailyNote, me }) {
    $('scores-daily-note').textContent = dailyNote;
    const table = (entries, empty) => {
      if (!entries.length) return `<p class="dim">${empty}</p>`;
      return `<table class="board-table"><thead><tr>
        <th>#</th><th>Who</th><th class="num">Score</th><th class="num">Mistakes</th><th class="num">Time</th><th>Seed</th></tr></thead><tbody>${
        entries.map((e, i) => `<tr class="${e.me ? 'me' : ''}"><td>${i + 1}</td><td>${escapeHtml(e.name)}</td>
          <td class="num">${e.score.toLocaleString()}</td><td class="num">${e.mistakes}</td>
          <td class="num">${Math.floor(e.elapsedMs / 60000)}:${String(Math.floor(e.elapsedMs / 1000) % 60).padStart(2, '0')}</td>
          <td class="dim small">${e.seed ?? ''}</td></tr>`).join('')}</tbody></table>`;
    };
    $('daily-board').innerHTML = table(dailyEntries, 'No validated scores yet today — be the first light.');
    $('local-board').innerHTML = table(localEntries, 'Finish any puzzle to post a local best.');
    $('achv-grid').innerHTML = ACHIEVEMENTS.map(a => {
      const got = achievements[a.key];
      return `<div class="help-card" style="${got ? '' : 'opacity:0.55'}">
        <h3>${got ? '🏅' : '🔒'} ${a.name}</h3><p class="small dim">${a.desc}</p>
        ${got ? `<p class="small" style="color:var(--accent)">Unlocked ${got.slice(0, 10)}</p>` : ''}</div>`;
    }).join('');
  }

  // ------------------------------------------------------------ keyboard

  _onKey(e) {
    if (this.current !== 'screen-play') {
      if (e.key === 'Escape' && this.current === 'screen-results') { /* results handles its own nav */ }
      return;
    }
    if ($('overlay-pause').classList.contains('active') || $('overlay-settings').classList.contains('active')) {
      if (e.key === 'Escape') this.onPauseToggle?.();
      return;
    }
    const { r, c } = this.cursor;
    const rows = this._rows ?? 0, cols = this._cols ?? 0;
    const move = (dr, dc) => {
      this.setCursor((r + dr + rows) % rows, (c + dc + cols) % cols);
      e.preventDefault();
    };
    switch (e.key) {
      case 'ArrowUp': move(-1, 0); break;
      case 'ArrowDown': move(1, 0); break;
      case 'ArrowLeft': move(0, -1); break;
      case 'ArrowRight': move(0, 1); break;
      case 'Enter': case ' ': case 'z': case 'Z':
        this.onAction({ type: 'fill', r, c }); e.preventDefault(); break;
      case 'x': case 'X': case 'm': case 'M':
        this.onAction({ type: 'mark', r, c }); e.preventDefault(); break;
      case 'c': case 'C': case 'Backspace': case 'Delete':
        this.onAction({ type: 'clear', r, c }); e.preventDefault(); break;
      case 'h': case 'H': this.onAction({ type: 'hint' }); e.preventDefault(); break;
      case 'u': case 'U': this.onUndo?.(); e.preventDefault(); break;
      case 'p': case 'P': this.onPauseToggle?.(); e.preventDefault(); break;
      case 'Escape': this.onPauseToggle?.(); e.preventDefault(); break;
      case 'r': case 'R': this.onCameraReset?.(); e.preventDefault(); break;
      case 'Tab': break; // allow normal tab navigation out of the grid
    }
  }
}

export function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
}

export function formatMs(ms) {
  const s = Math.floor(ms / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}
