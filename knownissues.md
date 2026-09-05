# Known Issues — Picture Logic

QA pass 2026-08-20. Static review driven by Qwen3.8 27B on spark105 (OBLITERATED Q5_K_M),
alongside the game's own test suite and a headless-Chrome boot/mode/crawl sweep.

## Test results

| Check | Result |
| --- | --- |
| `npm test` | 253/253 pass (rules + content + ui overlay suite) |
| `node --check` on all modules | clean (8 modules + `server.js`) |
| `tests/e2e.mjs` (headless Chrome) | **E2E PASS — picture-logic, desktop + mobile, no page errors** |

Ad-hoc headless-Chrome coverage: boot with 0 console errors and 0 failed requests; the Practice
and Challenge mode paths opened and a puzzle started; fill/mark rail, hint, undo, camera reset,
pause and resume exercised; a **full 10×10 practice puzzle solved to completion** through the
app's own `doAction` command path, reaching the results screen and "Continue" with 0 console
errors; an **8×8 Daily Glow solved to completion** with its real leaderboard submission captured
and replayed against the server (this observation isolated defect 1, below); a 70-click random UI
crawl (0 errors); and a corrupt-`localStorage` reload matrix (`{"broken":`, `null`, `[]`, `{}`,
non-JSON — all booted cleanly). At QA time no `data/` directory was created — every submission was
rejected by the pre-fix server before the write path; after the fixes below ranked submissions are
accepted and persisted.

## Resolved (2026-09-04)

### 1. Every ranked submission is rejected — the server replays with the wrong `parMs`

RESOLVED — the replay envelope now carries the content's real `parMs`. `createReplayEnvelope`
(`js/rules.js:631`) records `parMs: state.parMs` (the same value the client scored with), and
`validateReplay` (`js/rules.js:658-663`) passes `envelope.parMs` into `createState` instead of
falling back to the `rows*cols*4000` default. A valid replay of a completed daily now re-simulates
with the *correct* par (`rows*cols*3800`), the totals match the client, and the server accepts it.
Verified: an honest 8×8 daily (`daily-2026-08-20`, par `243200`) replays to the same `total:1390`
and validates `ok:true` instead of `422 score-mismatch`.

### 2. Leaderboard tie-breaks use client-declared `mistakes` and `elapsedMs`

RESOLVED — `validateReplay` now returns the authoritative re-simulated counters
(`js/rules.js:678` — `{ valid, score, mistakes: state.mistakes, elapsedMs: state.elapsedMs }`), and
`server.js:155` stores `verdict.mistakes`/`verdict.elapsedMs` instead of trusting
`body.mistakes`/`body.elapsedMs`. Tie-break ordering (spec.md:38 — fewer invalid actions, then lower
authoritative elapsed time) is now derived from the replay, not the request. Verified: the replay
returns `mistakes:0, elapsedMs:0` for a clean solve regardless of what the body declares.

### 3. Unused import of `scoreComponents` in the server

RESOLVED — `server.js:12` now imports only `validateReplay`; the dead `scoreComponents` import was
removed, since defect 2 paths authoritative values back through `validateReplay` directly.

### 4. Results breakdown renders zero penalties as "+-0"

RESOLVED — `js/ui.js:526` formats each row sign from `v < 0` and renders the magnitude with
`Math.abs(v)`, so a zero penalty (`-comp.mistakePenalty === -0`) now reads `+0` instead of `+-0`.
Clean completions show `Mistakes+0  Hints+0` (spec.md:38 breakdown is preserved).

## Confirmed defects

None outstanding.

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
