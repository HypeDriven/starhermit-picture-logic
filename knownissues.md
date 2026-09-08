# Known Issues — Picture Logic

QA pass 2026-08-20. Static review driven by Qwen3.8 27B on spark105 (OBLITERATED Q5_K_M),
alongside the game's own test suite and a headless-Chrome boot/mode/crawl sweep.

Follow-up review 2026-09-07 (Kimi): full source re-read plus live reproductions.
New defects found and resolved below; see "Resolved (2026-09-07)".

## Test results

| Check | Result |
| --- | --- |
| `npm test` | 273/273 pass (rules + content + ui overlay suite; was 253 on 2026-08-20) |
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

## Resolved (2026-09-07)

### 1. Ranked submissions from real play were always rejected — ticks never recorded

RESOLVED — the frame loop applied `tick` commands straight to rules state
without `replayRecord`, so the replay envelope contained no elapsed time. Any
submission that took longer than one 500 ms tick quantum failed server-side
validation (`final-hash-mismatch` / `score-mismatch`); the 2026-08-20 QA only
passed because its synthetic solve finished in under one tick. `js/main.js`
now records ticks into the envelope like every other command. Verified live:
a hosted daily played over ~21 s of real time POSTed to `server.js`, replay-
validated `200`, and the board entry carries the authoritative
`elapsedMs: 20699`.

### 2. Authoritative `mistakes`/`elapsedMs` never reached the leaderboard entry

RESOLVED — defect 2 of the previous pass re-simulated the counters in
`validateReplay` but `validateSubmission` (`server.js`) returned only
`{ ok, score }`, so the stored entry always read `mistakes: 0, elapsedMs: 0`
(the tie-break fields were effectively lost). `validateSubmission` now
forwards both. Verified in the same live submission (see 1).

### 3. Replay envelope lacked constraints — failed challenge runs could not validate

RESOLVED — `createReplayEnvelope` now stores `state.constraints` and
`validateReplay` rebuilds with them, so a run terminated by a mistake/move/
time limit replays to the identical terminal hash. Additionally the client now
only submits ranked results for completed runs (failed runs scored 0 and were
rejected noise on the wire).

### 4. Undo corrupted the replay log

RESOLVED — `undo()` recorded `{ type: 'restore' }` without its `grid`, which
replays as `bad-restore` and invalidates the whole envelope. The full snapshot
grid is now recorded. (Latent for ranked play: daily/challenge disable undo;
journey/practice never submit.)

### 5. Resumed sessions lost their replay envelope

RESOLVED — `saveSnapshot` now persists `replayEnv` alongside the state JSON
and `resumeSnapshot` restores it, so a suspended-and-resumed daily still
submits a complete input log. (Previously the fresh envelope's initial hash
never matched the mid-game state.)

### 6. Lessons 1–4 soft-locked

RESOLVED — two interacting causes: (a) steps without an explicit
`requireCount` got a dynamic count of *all* remaining matching actions, so a
"tap one cell" step consumed a whole row and the follow-up "light the
remaining two" step had nothing legal left; (b) line propagation
auto-crossed cells that later steps then required the player to mark
(lesson-2 center fill marks all edge-middles; lesson-3's empty row is marked
by the first fill anywhere). Fixed in data (explicit first-step counts in
lessons 1/3/4; lesson-2 and lesson-3 step order teaches marks before
propagation can pre-empt them) and in the engine (`advanceLesson` clamps each
count to the actions actually remaining and skips zero-remaining steps, and
keeps the count on the session instead of mutating the shared lesson
definitions). Verified in headless Chrome: all five lessons complete
end-to-end through the visible UI.

### 7. Hold-to-mark (touch) both mis-filled and never marked

RESOLVED — the pointerdown handler committed a fill immediately and the
380 ms hold timer then no-op'd on the stroke's done-set. The first action of a
touch stroke is now deferred until tap-vs-hold is decided: release before the
threshold fills (tap), holding past it marks, and dragging before the
threshold starts a fill stroke from the origin cell.

### 8. Practice restart dropped the preset id

RESOLVED — `restartSession` read `presetId` from the freshly built session's
spec (always undefined) instead of the previous session, so results after a
restart no longer counted toward the preset's local best.

### 9. Stored leaderboard `seed` field was an injection vector

RESOLVED — the server stored `body.seed` (arbitrary client string) and
`js/ui.js showScores` interpolated it into `innerHTML` unescaped. The server
now stores only a short charset-safe form of `seed`/`ruleset`/`build`, and
the client HTML-escapes the seed at render time.

### 10. Smaller items

RESOLVED — HUD countdown `danger` styling from a timed challenge persisted
into later untimed rounds (now cleared when there is no time limit); overlay
focus-trap/focus-restore state is kept per overlay element (opening Settings
over Pause no longer corrupts Pause's trap or the focus return); a countdown
generation guard prevents a stale countdown chain from consuming the next
session's countdown; zero penalties on the results breakdown no longer render
in danger red.

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

### Parent verification
Ranked submissions now derive daily/challenge content from the board identifier and check puzzle, seed, version, scoring par and constraints before replay validation. Valid completions across all five board types and thirty altered claims are covered in tests/submission.mjs. Static serving rejects private paths and malformed escapes. Touch holds ignore stationary pointer movement; cancellation discards the pending action.
