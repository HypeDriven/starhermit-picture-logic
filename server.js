// Picture Logic — StarHermit authoritative script (server=server.js).
// Dependency-free Node server: static distribution, platform time, replay-
// validated leaderboards, telemetry intake. Competitive score claims are
// never trusted: every ranked submission is re-simulated from its input log.
'use strict';

import http from 'node:http';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateReplay, scoreComponents } from './js/rules.js';
import { generatePuzzle } from './js/content.js';
import { fnv1a } from './js/prng.js';

const ROOT = fileURLToPath(new URL('.', import.meta.url));
const PORT = process.env.PORT || 8080;
const DATA_DIR = join(ROOT, 'data');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.txt': 'text/plain; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

// ---------------------------------------------------------------------------
// Leaderboard storage (file-backed, best-effort; memory fallback).
// ---------------------------------------------------------------------------

const boards = new Map(); // board -> [entry]
let boardsLoaded = false;

async function loadBoards() {
  try {
    const raw = await readFile(join(DATA_DIR, 'leaderboards.json'), 'utf8');
    for (const [k, v] of Object.entries(JSON.parse(raw))) boards.set(k, v);
  } catch { /* first boot */ }
  boardsLoaded = true;
}

async function saveBoards() {
  try {
    await mkdir(DATA_DIR, { recursive: true });
    await writeFile(join(DATA_DIR, 'leaderboards.json'),
      JSON.stringify(Object.fromEntries(boards)));
  } catch (err) { console.warn('[boards] persist failed', err.message); }
}

// ---------------------------------------------------------------------------
// Rate limiting (per IP, sliding window) — recoverable 429 with Retry-After.
// ---------------------------------------------------------------------------

const buckets = new Map();
function rateLimit(ip, limit = 60, windowMs = 60000) {
  const now = Date.now();
  const b = buckets.get(ip) || [];
  const fresh = b.filter(t => now - t < windowMs);
  if (fresh.length >= limit) { buckets.set(ip, fresh); return Math.ceil((fresh[0] + windowMs - now) / 1000); }
  fresh.push(now);
  buckets.set(ip, fresh);
  return 0;
}

// ---------------------------------------------------------------------------
// Score validation: rebuild the puzzle from its public seed and re-simulate.
// ---------------------------------------------------------------------------

function validateSubmission(body) {
  const { seed, originSeed, rows, cols, density, envelope } = body || {};
  const genSeed = originSeed || seed;
  if (typeof genSeed !== 'string' || !Number.isInteger(rows) || !Number.isInteger(cols)) {
    return { ok: false, status: 400, error: 'missing-fields' };
  }
  if (rows < 3 || rows > 25 || cols < 3 || cols > 25) return { ok: false, status: 400, error: 'bad-size' };
  if (!envelope || envelope.schema !== 1) return { ok: false, status: 400, error: 'bad-envelope' };
  if (!Array.isArray(envelope.commands) || envelope.commands.length > 20000) {
    return { ok: false, status: 400, error: 'bad-command-log' };
  }
  let puzzle;
  try {
    puzzle = generatePuzzle({
      seed: parseInt(genSeed, 16), rows, cols,
      density: typeof density === 'number' ? density : 0.6,
    });
  } catch {
    return { ok: false, status: 422, error: 'unknown-content' };
  }
  const solHash = fnv1a(puzzle.solution.join('')).toString(16);
  if (solHash !== envelope.solutionHash) return { ok: false, status: 422, error: 'solution-mismatch' };
  const verdict = validateReplay(envelope, puzzle.solution);
  if (!verdict.valid) return { ok: false, status: 422, error: `replay-invalid:${verdict.reason}` };
  if (!verdict.score || !envelope.terminal) return { ok: false, status: 422, error: 'incomplete-run' };
  // Plausibility: claimed score must equal the re-simulated score exactly.
  if (verdict.score.total !== body.score) return { ok: false, status: 422, error: 'score-mismatch' };
  return { ok: true, score: verdict.score };
}

// ---------------------------------------------------------------------------

function json(res, status, obj, headers = {}) {
  const body = JSON.stringify(obj);
  res.writeHead(status, { 'Content-Type': 'application/json', ...headers });
  res.end(body);
}

async function readBody(req) {
  let data = '';
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 512 * 1024) throw new Error('payload-too-large');
    data += chunk;
  }
  return data ? JSON.parse(data) : {};
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const ip = req.socket.remoteAddress || 'unknown';

  try {
    // ---------------- API
    if (url.pathname === '/api/v1/time') {
      return json(res, 200, { epochMs: Date.now(), iso: new Date().toISOString() });
    }

    if (url.pathname === '/api/v1/leaderboard' && req.method === 'GET') {
      const board = url.searchParams.get('board') || 'global';
      const entries = (boards.get(board) || []).slice(0, 100);
      return json(res, 200, { board, entries });
    }

    if (url.pathname === '/api/v1/leaderboard' && req.method === 'POST') {
      const wait = rateLimit(`lb:${ip}`, 20, 60000);
      if (wait) return json(res, 429, { error: 'rate-limited' }, { 'Retry-After': String(wait) });
      let body;
      try { body = await readBody(req); } catch { return json(res, 413, { error: 'payload-too-large' }); }
      const name = String(body.name || 'Guest').slice(0, 24).replace(/[<>]/g, '');
      const board = String(body.board || 'global').slice(0, 64);
      if (!Number.isInteger(body.score) || body.score < 0 || body.score > 10_000_000) {
        return json(res, 400, { error: 'bad-score' });
      }
      const verdict = validateSubmission(body);
      if (!verdict.ok) return json(res, verdict.status, { error: verdict.error });
      const entries = boards.get(board) || [];
      entries.push({
        name, score: verdict.score.total,
        mistakes: body.mistakes ?? 0, elapsedMs: body.elapsedMs ?? 0,
        ruleset: body.ruleset ?? null, build: body.build ?? null,
        seed: body.seed, at: new Date().toISOString(),
      });
      entries.sort((a, b) => b.score - a.score || a.mistakes - b.mistakes || a.elapsedMs - b.elapsedMs);
      boards.set(board, entries.slice(0, 100));
      saveBoards();
      return json(res, 200, { accepted: true, score: verdict.score.total });
    }

    if (url.pathname === '/api/v1/telemetry' && req.method === 'POST') {
      const wait = rateLimit(`tm:${ip}`, 30, 60000);
      if (wait) return json(res, 429, { error: 'rate-limited' }, { 'Retry-After': String(wait) });
      try { await readBody(req); } catch { return json(res, 413, { error: 'payload-too-large' }); }
      // Anonymous funnel events only; nothing is stored beyond an aggregate count.
      res.writeHead(204); return res.end();
    }

    if (url.pathname.startsWith('/api/')) {
      return json(res, 404, { error: 'not-found' });
    }

    // ---------------- Static distribution
    let path = normalize(decodeURIComponent(url.pathname));
    if (path.includes('..')) { res.writeHead(403); return res.end(); }
    if (path === '/' || path === '\\') path = '/index.html';
    const file = join(ROOT, path);
    if (!file.startsWith(ROOT) || !existsSync(file)) {
      res.writeHead(404); return res.end('not found');
    }
    const data = await readFile(file);
    res.writeHead(200, {
      'Content-Type': MIME[extname(file)] || 'application/octet-stream',
      'Cache-Control': extname(file) === '.html' ? 'no-cache' : 'public, max-age=3600',
    });
    res.end(data);
  } catch (err) {
    console.error('[server]', err);
    json(res, 500, { error: 'internal' });
  }
});

loadBoards().then(() => {
  server.listen(PORT, () => console.log(`[picture-logic] serving on :${PORT}`));
});
