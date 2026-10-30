# Picture Logic — Product and Game Specification

**Document status:** running specification of the shipped game.
**Game index:** 35
**Genre:** Constraint picture puzzle (nonogram)
**Players:** 1 player; asynchronous score comparison
**Runtime:** a StarHermit engine script game (engine 1.28.0, host API 1.30, `engine.minor=30`), played natively by the StarHermit client and in browsers by the engine's web runtime
**Targets:** desktop, phones and tablets, portrait and landscape

## 1. Product vision

Picture Logic is a game in which players use row and column run clues to mark cells and reveal a pixel illustration. Its signature setting is a minimalist light-board that blooms into a tiny scene. The product should feel immediately understandable, responsive within one input, and polished enough that the board or playfield itself is the visual hero. Sessions should begin quickly, make the next useful action obvious without solving the game for the player, and end with a clear explanation of score and progress.

The experience must be original. Do not copy names, layouts, characters, iconography, writing, audio, progression maps, or level data from an existing title. Use an original visual language, original procedural assets, and internally authored content.

### Design pillars

1. **Readable before spectacular:** legal actions, hazards, selection, ownership, and goals remain legible with effects disabled.
2. **One-input confidence:** every press, tap, drag, key, or pointer action gives immediate visual and sonic acknowledgment.
3. **Short path to play:** a returning player reaches the primary playfield in at most two deliberate actions.
4. **Fair mastery:** randomness is seeded and inspectable; outcomes never depend on hidden purchases or invisible stat boosts.
5. **Scalable beauty:** the same art direction survives low-power mobile hardware and high-resolution desktop displays.

## 2. Core game design

### Objective and rules contract

Use row and column run clues to mark cells and reveal a pixel illustration.

The rules engine must represent legal actions independently from rendering. It must expose legal-action queries, deterministic resolution, serializable state, a monotonically increasing turn/tick number, and a terminal-state reason. Tutorials and hints call the same legal-action API used by play rather than duplicating rules.

### Core loop

The repeated loop is: **read run clues, mark known filled or empty cells, propagate certainty, and reveal the image**. Input is locked only during the shortest non-interruptible resolution phase. Cosmetic animation may continue after the logical state is ready, but skip/fast-forward must settle every object into the exact deterministic end state.

### Scoring and victory

Track clean completion and hint usage; logical puzzles must have a unique solution. Results show a component breakdown rather than one unexplained total. Store integers for score and simulation units; format values only in presentation. Ties use, in order: primary objective completion, fewer invalid actions, lower authoritative elapsed time, then stable session identifier.

### Modes

- **Learn:** interactive lessons introduce one rule at a time and require the player to perform the action.
- **Journey:** authored progression with gradually combined mechanics and periodic mastery stages.
- **Daily:** one shared seed and ruleset per UTC day, synchronized to platform time.
- **Practice:** selectable difficulty, restart, undo where rules permit, and no effect on competitive rating.
- **Challenge:** constrained goals such as move limits, speed targets, altered layouts, or restricted tools.
- **Score chase:** asynchronous global and friends comparisons using validated seeds and rulesets.

### Difficulty and content generation

- Represent content as versioned data: identifier, seed, initial state, goals, allowed mechanics, par values, tutorial flags, and presentation theme.
- Run offline validators to prove basic legality, reachable goals, bounded duration, and absence of soft locks. Logic puzzles additionally require a unique or explicitly accepted solution class.
- Difficulty is measured from solution depth, branching factor, time pressure, motor precision, hidden information, and recovery options—not merely larger numbers.
- Introduce one new concept in isolation, combine it with one known concept, then test mastery before adding another.
- Daily seeds are immutable after publication. If content is defective, mark the day excluded from ranking rather than silently replacing it.

### Game-state model

`boot → title → profile-ready → mode-select → preparing → tutorial/countdown → active ↔ paused/reconnecting → resolving → results → progression`.

Every transition has one owner and an explicit reason. Backgrounding (the runtime's suspend) pauses solo play and saves the snapshot; returning after more than 4 s toasts a “while you were away” note.

## 3. Interface (starhermit:ui)

The screens are immediate-mode `starhermit:ui`, drawn every frame by `native/screens.ts`; their look is the browser build's style sheet rewritten class-based in `tools/ui-style.css` and converted with `starhermit css` into `assets/ui-style.json` (`npm run css`). The theme colours (Settings › Theme: `--bg`, `--filled`, `--marked`, `--accent`), the colour-vision-safe palette and the runtime's high contrast are token sets (`native/style.ts`).

### Screens

- **Title:** version line, the two-colour logo, tagline, **Play**, **Resume {label} ({time})** when a safe snapshot exists, the four home cards (Daily Glow with today's score, Journey with stages lit, Learn, Score Chase), Settings, How to play, **Invite a friend** (signed in) or **Sign in with StarHermit** (signed out), and the profile line (name · saved on this device · connected / offline · cloud state). With Board detail on (Balanced and up) a faint glowing cell grid lies behind it, drifting slowly with ambient motion.
- **Choose a mode:** Learn, Journey, Daily Glow (ranked), Practice, Challenge (ranked), Score Chase.
- **Journey:** 40 stages in a grid with stars (☆☆☆–★★★), gold-bordered mastery stages, locked stages disabled; a “{done} / {total} done” badge.
- **Practice:** the four presets (Calm 8×8, Steady 10×10, Bold 12×12, Peak 15×15) with personal bests, and a custom seed (text field, board size, **Grow**).
- **Challenges:** the four weekly constrained boards with their rules and bests; a “ranked · week-N” badge.
- **Learn:** the five lessons with a “done” badge.
- **Score Chase:** today's board (signed in: the high-score leaderboard, read-only; otherwise this device's Daily result), the streak, the local bests (top 15 of 50) and the six achievements.
- **How to play:** the rule paragraph and cards, and the controls with the effective keys and pad controls (the runtime's rebinds included).
- **Settings:** display name (guests; signed in the account name is shown), Theme, Palette (standard / colour-vision safe), **Open Options** and **Key bindings** (the runtime's Options: sound, graphics, language, larger text, high contrast, reduced motion, rebinding), Captions, Left-handed tray, Hold to mark, Replay tutorials (reset lesson completion), Done. Opened from the pause sheet, Back returns to it.
- **Play:** the HUD (Puzzle — session label and picture name, Time — counting down under a time limit, red under 20 s, Mistakes — n or n/max, red at max − 1, Moves — n or n/limit, Lit %, Pause), on wide windows the left rail (Objective with the constraints, Par, Seed · size · name) and the right rail (Mode Fill / Mark ✕, Hint, Undo, Reset camera), the tray (▮ Fill / ✕ Mark, 💡 Hint, ↩ Undo, ◎ Reset camera; Undo and Hint disabled where the rules forbid them), the 3 · 2 · 1 · Glow countdown (Glow alone with reduced motion), the lesson banner and toasts.
- **Pause sheet:** Resume, Restart puzzle, Settings, How to play, Leave puzzle (Escape or the pause key also resumes).
- **Preparing the board…:** shown while a Daily, Practice or Challenge board is generated (Cancel).
- **Results:** mode (· ranked), Picture revealed / The light faded, the summary or the fail reason, the score breakdown (picture cells, board size, time bonus, clean board, mistakes, hints, total), the Progress card (stars, streak, best, lessons) with the leaderboard line, the achievements unlocked, Next stage n / Continue, Retry this puzzle, Back to title.

### Board overlay

Over the projected board the overlay draws the run clues beside each row and above each column (0 for an empty line; done lines in the accent colour, struck through; the cursor's row and column highlighted), a ✕ on crossed cells, an outline on lit cells, the hover wash and the cell cursor. Every cell is a named target for screen readers and play scripts (“Row 1, column 2, unknown / lit / crossed”). The clue size follows the old `clamp(10px, 2.4vmin, 17px)`; the camera fit reserves the row clues' width and pans the board right when the left margin is too narrow.

### Layouts

Picked by the window's logical size: **wide** (≥ 1024 px and taller than 480: both rails), **compact** (the HUD wraps above the board, the tray below), **phone** (≤ 720 px wide: compact HUD items, the tray wraps into two rows when its row does not fit), **short landscape** (≤ 480 px tall: the HUD is a 132 px status column at the left with Pause at its foot, the tray a column at the right — swapped when left-handed — and the lesson banner docks top-left; the camera rests at a steeper pitch). Left-handed mirrors the tray's order. The lesson banner is carved out of the board's safe area, so the camera fit keeps every cell clear of it. Toasts sit above the tray in play and at the top on menus; they never take the pointer.

### Input

- **Pointer / touch:** a press on a cell applies the current mode (Fill or Mark; marking a crossed cell clears it); the right mouse button marks; dragging paints the same action across cells, each cell once per stroke; with Hold to mark, a touch held 380 ms on a cell crosses it, a quick tap fills, a drag before then paints fills. Hovering a cell shows the ring and the fill / mark ghost.
- **Keyboard** (`control.*`, rebindable in the runtime's Options): arrows move the cursor (wrapping), Enter / Space / Z fill, X / M mark, C / Backspace / Delete clear, H hint, U undo, P / Escape pause (Escape is Back on menu screens), R reset camera. Screens open with their first control focused for keyboard and pad players (no ring after touch).
- **Gamepad** (`engine.gamepad.*`): D-pad or left stick moves the cursor, South fills, West marks, East clears, North hints, the left shoulder undoes, Start pauses, Select resets the camera; the runtime's focus navigation drives the menus.

### Accessibility

Screen readers get every widget, the named cells and announcements (cell under the cursor, lit cells with captions on, line resolutions, mistakes, hints, lesson steps, the countdown, results). Colour is backed by shape (✕ crosses, outlines). The runtime's Options provide larger text, high contrast (token set) and reduced motion (no camera swoops, shake, idle bob, flora sway or motes; the win settles at once).

## 4. Visual and audio design

### The light-board (starhermit:scene, `native/render.ts`)

The browser build's three.js r160 scene ported: a slab with instanced cells (springs lift lit cells, sink crossed ones; lit cells glow in their own colour through a per-instance glow read by WGSL material hooks — unlit and crossed cells never emit), with Board detail bevelled clear-coat cells, a grained slab, four thin emissive rim strips, a soft pool of light on the ground and a fuller ring of procedural flora per theme (blossom, coral, lantern, fern, crystal). A warm key light with soft shadows, a hemisphere fill tinted by the theme and a cool rim light; lights ÷ π for r160's physical units; the room environment on each lit material at its old intensity (scaled to the old look). The selection ring and the hover ghost, pooled additive bursts (fills, hints, line propagation, the bloom), drifting motes, the win bloom that lifts the picture into the theme's bloom colours with a slow camera orbit, the intro swoop, the camera reset and a small shake on mistakes. The camera is a perspective camera whose view offset places the board in the playfield between the HUD, rails and tray; a probe camera of the playfield's aspect fits the distance (every corner inside the safe margins), projects the overlay and picks cells on the board's top plane.

### Graphics tiers (`native/quality.ts`)

The runtime's quality tier (`frame().quality`) picks the old preset; the level (`levelIndex`) scales sparks and motes within it (≤ 2×). Render scale, the pixel-ratio cap, adaptive resolution and the frame-rate limit and readout are the runtime's.

| Tier | Shadows | AO | Bloom / grade | AA | Reflections | Detail / ambient | Cells | Bevel | Grain | Flora | Sparks / motes |
|---|---|---|---|---|---|---|---|---|---|---|---|
| Low | off | off | off | off | off | plain / static | Lambert | 2 | 128 | 3 | 160 / 40 |
| Balanced | 1024 | off | on | MSAA | on | detailed / animated | Standard | 2 | 256 | 8 | 400 / 80 |
| High | 2048 | on | on | SMAA | on | detailed / animated | clear-coat | 3 | 256 | 12 | 640 / 120 |
| Ultra | 4096 | high | on | MSAA | on | detailed / animated | clear-coat | 4 | 512 | 18 | 960 / 180 |

Post effects follow r160's composer order: GTAO, UnrealBloom (0.4 / 0.45 / threshold 0.85, half resolution below Ultra), ACES at exposure 1.05, the display-space grade (S-curve, saturation 1.1, cool shadows / warm highlights, vignette), SMAA or FXAA. The background colour is the tone-mapped sky on the post tiers, as r160's composer drew it.

### Audio (`native/audio.ts`)

The authored one-shots (`sfx/*.opus`) per event (ack, focus, fill, mark, clear, error, line, hint, undo, pause, win, fail, countdown), one clip of each group by the puzzle-seeded variant stream, with a 40 ms double-trigger guard; a quiet room tone (filtered noise) and the adaptive music — a three-sine pad every 7.2 s rooted by the puzzle's theme and a sparse pentatonic melody whose density follows the lit share of the picture — rendered once into looped clips on the music bus. The runtime's Options own volumes, mute and the voice limit; a hidden window and the pause sheet silence the loops.

## 5. Technical architecture

- `js/rules.js`, `js/prng.js`, `js/content.js` — the browser build's pure rules, seeded streams and content, unchanged (shared with the node tests).
- `js/puzzles.js` — the 40 Journey puzzles precomputed by `tools/gen-puzzles.mjs` (`tests/content.test.mjs` checks they equal the generator's): the unique-solution generator takes up to ~0.4 s a stage and ~1 s for a large Daily natively.
- `native/gen-worker.js` + `native/generate.ts` — Daily, Practice and Challenge boards generated by `content.js` on a `starhermit:script` module worker (on the game's thread if the worker cannot start).
- `js/progress.js` — the save document and progression (from `store.js`), pure.
- `js/layout.js` — the overlay geometry, `js/i18n.js` + `js/strings.js` + `js/platform-i18n.js` — strings.
- `native/main.ts` (session flow, commands, lessons, clock, input), `native/screens.ts` (UI), `native/render.ts` (scene), `native/platform.ts` (saves, options, platform), `native/audio.ts`, `native/quality.ts`, `native/style.ts`, `native/i18n.ts`, `native/game.ts` (typed facade).
- `js/submission.js` — the replay validator of ranked boards (kept with its contract test; no client posts replays).

The round's authoritative clock is the runtime's fixed steps (60 Hz): 500 ms tick commands are applied and recorded in the replay envelope, and the countdown, hold-to-mark and results delay run on the same clock, so play scripts replay exactly.

## 6. StarHermit integration

- **Manifest** (`starhermit.txt`): `launch=index.html` (the engine's web loader from `npm run package`), `engine.entry=native/main.ts`, `engine.version=1.28.0`, `engine.minor=30`, capabilities platform, storage, clipboard, `server=score-script.js`, `control.*` and `engine.gamepad.*` for every action.
- **Save** (`starhermit:storage` saves, schema 1, device and cloud): `{ v, progress, name }`; another device's save merges on a conflict (`mergeSave`: journey records keep the most stars, best score and fastest time; dailies and challenges the better score; lessons, achievements (earliest date), daily dates and excluded dailies unioned; the local board merged to its top 50; completions, practice plays and best clean streak the larger; this device's clean streak, in-progress snapshot and name). The browser build's cloud slot (`game:<slug>`, `{ savedAt, settings, progress }`) shows as foreign: its progress, display name and game options are merged in and the slot is replaced once.
- **Options** (engine settings, synced): theme, palette, leftHanded, holdToMark, captions, inputMode. The browser build's settings KV keys are adopted where they are game options (unless set here since), then all of them (and `ui.*`) are removed; volumes, mute, graphics, reduced motion, contrast, larger text, gamepad map and language are the runtime's Options.
- **Clock:** the Daily date and the Challenge week come from the platform's clock (`serverNow`), else the device's UTC date.
- **Leaderboard:** signed in, a won Journey, Daily or Challenge round posts its total through `score-script.js` (a practice session carrying `{ type: 'result', scores: { 'high-score': n } }`, range-checked 0–20,000 by the script, unchanged) and the results show the rank (“Leaderboard rank: #N”, posted, or not posted). Practice and lessons post nothing; guests post nothing. Score Chase reads the high-score board read-only.
- **Account:** sign-in request, the invite link copied to the clipboard, the signed-out toast.
- **Language:** the runtime's interface language picks one of the nine locales (en-US, en-GB, es-419, es-ES, de-DE, fr-FR, fr-CA, pt-BR, it-IT); every string is drawn through it each frame, so a change applies at once without touching the round. Scores use the locale's digit grouping; picture names come from translated word banks.

## 7. Content and retention

40 Journey stages in five chapters (5×5 to 15×15, a gold mastery stage every eighth without hints), the Daily Glow (one seed per UTC day, no undo, ranked), four Practice presets plus custom seeds, four weekly Challenges (Blitz Lamp 150 s limit, Steady Hand 3 mistakes, Silent Marks no marks or hints, Counted Steps 78 moves), five lessons, six achievements, five themes.

## 8. Checks

- `npm test`: the rules and content suite (273 checks), the submission contracts, `tests/content.test.mjs`, `tests/progress.test.mjs`, `tests/i18n.test.mjs`, and `tests/native.mjs`: the web index matches the files, `tsc`, `starhermit check` with zero warnings, and the play scripts in `tests/native/` as signed-out render checks — `journey-1.play` and `learn-phone.play` (generated by `tools/gen-plays.mjs` from the rules), `landscape.play` (phone landscape, DPR 3: a worker-generated Practice board, mark, hint, a swiped stroke, pause, the docked lesson banner) and `keys-daily.play` (the menus and today's Daily by keys, solved with the hint key, to its results).
- `npm run test:browser`: `tools/browser-play.mjs` plays the packaged loader in Chrome on the GPU at desktop, phone (DPR 3) and landscape (DPR 3) through the page's accessibility mirror, failing on console errors.
- `npm run package` after every change (the web runtime refuses a stale `starhermit-files.json`).

## 9. Port differences and known limitations

- The flat no-WebGL fallback board, the graphics context-loss rebuild and the in-game Graphics, Sound and Language panels are the runtime's concern now; per-effect graphics overrides are not offered (the Options choose a level).
- The in-game gamepad button remapping became the runtime's rebinding (Settings › Key bindings).
- Anonymous telemetry (sent only to the old dev server) and the dev `server.js` with its replay-validated local boards are gone; the high-score post stays range-checked by `score-script.js` (server-side replay validation is not built, per the leaderboard policy for solo boards).
- Guests' old browser localStorage progress does not migrate (signed-in cloud progress does).
- The room environment is built without the renderer, as the r160 page did (the 5-candela room), with the old envMapIntensity values unchanged.
- Practice preset boards are seeded from the clock as before, so each Practice round is a new picture.
