# Known Issues — Picture Logic

QA pass 2026-08-20. Static review driven by Qwen3.8 27B on spark105 (OBLITERATED Q5_K_M),
alongside the game's own test suite and a headless-Chrome boot/mode/crawl sweep.

## Test results

| Check | Result |
| --- | --- |
| `npm test` | no `test` script; `node tests/run-tests.mjs` gives 253/253 pass |
| `node --check` on all modules | clean (8 modules + `server.js`) |
| `tests/e2e.mjs` (headless Chrome) | not present — replaced by an ad-hoc CDP boot/mode/crawl sweep (see below) |

Ad-hoc headless-Chrome coverage: boot with 0 console errors and 0 failed requests; the Practice
and Challenge mode paths opened and a puzzle started; fill/mark rail, hint, undo, camera reset,
pause and resume exercised; a **full 10×10 practice puzzle solved to completion** through the
app's own `doAction` command path, reaching the results screen and "Continue" with 0 console
errors; an **8×8 Daily Glow solved to completion** with its real leaderboard submission captured
and replayed against the server (defect 1); a 70-click random UI crawl (0 errors); and a
corrupt-`localStorage` reload matrix (`{"broken":`, `null`, `[]`, `{}`, non-JSON — all booted
cleanly). No `data/` directory was created — every submission was rejected before the write path.

## Confirmed defects

Defects below were each verified by reading the source, not just reported by the model.

### 1. Every ranked submission is rejected — the server replays with the wrong `parMs`

- **File:** `js/rules.js:658-661` (`validateReplay` → `createState`), `js/rules.js:79`
  (par default), `js/rules.js:462` (`timeBonus`), rejection at `server.js:100`
- **Trigger:** Finish today's Daily Glow (or any ranked content) and let the client submit.
- **Behaviour:** `validateReplay` rebuilds the state from the envelope:

  ```js
  const state = createState({ id: envelope.id, seed: envelope.seed,
                              rows: envelope.rows, cols: envelope.cols, solution });
  ```

  It passes no `parMs`, so `createState` falls back to
  `const parMs = spec.parMs ?? Math.round(rows * cols * 4000);` (`js/rules.js:79`). The daily's
  real par is `rows * cols * 3800` (`js/content.js:243`). Since `timeBonus` is
  `Math.round((state.parMs - state.elapsedMs) / 500)` (`js/rules.js:462`), the replay computes a
  larger bonus than the client did, the totals differ, and `server.js:100`
  (`verdict.score.total !== body.score`) returns 422 `score-mismatch`. The envelope carries no
  `parMs` field at all, so the server cannot recover the correct value — **no honest ranked run
  can ever be accepted**, and the global board stays permanently empty. Every piece of ranked
  content is affected, because none of them use the 4000 ms/cell default: the daily is
  `rows*cols*3800` (`js/content.js:243`) and the four weekly challenges are `150000`,
  `10*10*4200`, `10*10*4800` and `10*10*4200` (`js/content.js:278`, `285`, `292`, `299`).
- **Expected:** spec.md:204 — "For globally competitive boards, validate score claims through a
  lightweight authoritative script using replayable input logs and deterministic seeds." A valid
  replay of a completed daily must be accepted.
- **Evidence:** An 8×8 Daily Glow solved to `status: complete` in headless Chrome, with the real
  submission body captured from `fetch`. The server answered:

  ```
  POST /api/v1/leaderboard -> 422 {"error":"score-mismatch"}
  GET  /api/v1/leaderboard?board=daily-2026-08-20 -> {"entries":[]}
  ```

  Re-running the server's own validation locally over that exact body isolates the single
  differing component:

  ```
  solutionHash match: true    validateReplay: true (no error)
  server  score: {base:340, sizeBonus:64, timeBonus:512, cleanBonus:500, total:1416}
  client  score: {base:340, sizeBonus:64, timeBonus:486, cleanBonus:500, total:1390}
  client state parMs: 243200   (= 8*8*3800, the daily's par)
  server default parMs: 256000 (= 8*8*4000, js/rules.js:79)
  ```

### 2. Leaderboard tie-breaks use client-declared `mistakes` and `elapsedMs`

- **File:** `server.js:152-158` (`POST /api/v1/leaderboard`), with `validateSubmission` at
  `server.js:74-102` and `validateReplay` at `js/rules.js:657-681`
- **Trigger:** Submit a genuinely valid replay whose request body carries
  `"mistakes": 0, "elapsedMs": 0`.
- **Behaviour:** The submission is fully replay-validated for *score* only. The stored entry then
  takes the two tie-break fields straight from the request:

  ```js
  mistakes: body.mistakes ?? 0, elapsedMs: body.elapsedMs ?? 0,
  ```

  and the board is ordered by them:

  ```js
  entries.sort((a, b) => b.score - a.score || a.mistakes - b.mistakes || a.elapsedMs - b.elapsedMs);
  ```

  The authoritative values exist — `js/rules.js:90` and `js/rules.js:92` maintain
  `state.mistakes` and `state.elapsedMs` ("authoritative accumulated active time (via tick
  commands)") — but `validateReplay` returns only `{ valid, score }` (`js/rules.js:678`), so the
  server never sees them.
- **Expected:** spec.md:38 — "Ties use, in order: primary objective completion, fewer invalid
  actions, **lower authoritative elapsed time**, then stable session identifier." The rules module
  already documents exactly this ordering in `compareResults` (`js/rules.js:472-481`), which the
  server does not use.
- **Evidence:** The three quoted locations. `validateReplay`'s return value is the proof that the
  server cannot currently obtain authoritative values.

### 3. Unused import of `scoreComponents` in the server

- **File:** `server.js:12`
- **Trigger:** n/a (dead code).
- **Behaviour:** `import { validateReplay, scoreComponents } from './js/rules.js';` —
  `scoreComponents` is never referenced anywhere else in `server.js`. Harmless, but it is a
  leftover from the code path that should have re-derived the authoritative entry fields in
  defect 2.
- **Expected:** Either use it (to recompute the stored fields) or drop it.
- **Evidence:** `grep -n scoreComponents server.js` returns only line 12.

### 4. Results breakdown renders zero penalties as "+-0"

- **File:** `js/ui.js:522-526` (results breakdown table)
- **Trigger:** Finish any puzzle with no mistakes and no hints — i.e. every clean completion.
- **Behaviour:** The penalty rows are stored negated and the formatter adds a `+` for any
  non-negative value:

  ```js
  ['Mistakes', -comp.mistakePenalty, 'neg'],
  ['Hints', -comp.hintPenalty, 'neg'],
  …
  rows.map(([k, v, cls]) => `<tr class="${cls || ''}"><td>${k}</td><td>${v >= 0 ? '+' : ''}${v.toLocaleString()}</td></tr>`)
  ```

  When the penalty is `0`, `-comp.mistakePenalty` is `-0`. `-0 >= 0` is `true`, so the `+` is
  prepended, while `(-0).toLocaleString()` renders `"-0"` — producing `+-0`.
- **Expected:** spec.md:38 — "Results show a component breakdown rather than one unexplained
  total"; a clean run should read `0` (or `+0`), not `+-0`.
- **Evidence:** Live results screen after solving a practice puzzle in headless Chrome
  (all 48 filled cells applied through `doAction`, status `complete`):

  ```
  Picture cells+480  Board size+100  Time bonus+838  Clean board+500
  Mistakes+-0  Hints+-0  Total1,918
  ```

## Suspected — not confirmed

### 1. Ranked boards accept any `board` string from the client

- **File:** `server.js:145` (`const board = String(body.board || 'global').slice(0, 64);`)
- **Concern:** The board id is not tied to the validated content, so a genuine easy-puzzle replay
  can be filed under any board name, including one intended for a harder daily.
  `validateSubmission` checks the puzzle seed/size and the solution hash, but never that they
  match the board being written to.
- **Why unconfirmed:** spec.md does not define the board namespace, so it is unclear whether a
  free-form board id is intended (e.g. per-seed boards) or a bug.

## Checked, no defects found

- Suspend/resume: entered a round, performed an action, reloaded the page, and confirmed the
  game re-boots with its snapshot intact and no console errors or failed requests.
- `js/rules.js` (26 KB): clue derivation, `applyCommand` legality, mistake/hint accounting,
  `scoreComponents`, `enumerateLine`/solver, `stateHash`, `validateReplay` hash chain — all 253
  tests pass, including uniqueness of generated puzzles, deterministic replay, hint legality,
  undo-via-restore, and a malformed-command fuzz pass.
- `js/store.js` persistence: `picture-logic.settings.v1` and `picture-logic.progress.v1` survive
  five kinds of corruption without a boot failure.
- UI: 70 random clicks across title, mode cards, practice setup, in-round rail, pause overlay,
  results, settings and help produced zero console errors.
- `server.js` request handling: payload cap (512 KB → 413), per-IP rate limiting with
  `Retry-After`, score bounds (`0 … 10_000_000`), `..` traversal rejection, and 404 for unknown
  `/api/` paths.
- Determinism: no `Math.random` in `js/rules.js` or `js/content.js`; the only uses are a session
  id and a practice seed default in `js/main.js`, plus audio noise.

## Not tested

- `js/render3d.js` beyond "boots and draws without errors" — headless SwiftShader cannot judge
  the visual acceptance criteria in spec.md §4.
- Daily/Journey/Learn/Score-chase mode entry from the title screen: the crawl reached them, but a
  full stage completion (and therefore a real leaderboard submission end-to-end) was not driven,
  because solving a nonogram through synthetic clicks was out of scope for this pass.
- Touch and gamepad input paths.
