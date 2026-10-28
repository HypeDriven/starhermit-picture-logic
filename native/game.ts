// The browser build's pure game modules (shared with the node tests), typed
// for this client: the rules (js/rules.js: commands, legality, line
// propagation, hints, scoring, the replay envelope), the content
// (js/content.js: themes, the generator, the 40 Journey stages, the Daily,
// Practice presets, the weekly Challenges, the lessons; js/puzzles.js: the
// Journey stages precomputed), the save and progression (js/progress.js),
// the board overlay geometry (js/layout.js) and the strings (js/i18n.js).
import * as rules from "../js/rules.js";
import * as content from "../js/content.js";
import * as puzzles from "../js/puzzles.js";
import * as progress from "../js/progress.js";
import * as layout from "../js/layout.js";
import * as prng from "../js/prng.js";

export const CELL = { UNKNOWN: 0, FILLED: 1, MARKED: 2 } as const;
export interface Constraints {
  maxMistakes: number | null; timeLimitMs: number | null; moveLimit: number | null;
  allowMarks: boolean; allowHints: boolean; allowUndo: boolean;
}
export interface State {
  v: number; id: string; seed: number; rows: number; cols: number; solution: number[]; rowClues: number[][]; colClues: number[][];
  grid: number[]; turn: number; moves: number; mistakes: number; hints: number; elapsedMs: number; parMs: number;
  constraints: Constraints; status: "active" | "complete" | "failed"; reason: string | null; filledCount: number;
}
export interface Command { type: string; r?: number; c?: number; ms?: number; grid?: number[]; id?: string }
export interface GameEvent { type: string; r?: number; c?: number; cells?: { r: number; c: number }[]; status?: string; reason?: string; value?: number; via?: string; correct?: boolean }
export interface ApplyResult { ok: boolean; reason?: string; events: GameEvent[] }
export interface ScoreParts { base: number; sizeBonus: number; timeBonus: number; mistakePenalty: number; hintPenalty: number; cleanBonus: number; total: number }
export interface Envelope { commands: unknown[]; terminal: unknown }
export interface Spec {
  id: string; seed: number; rows: number; cols: number; density?: number; parMs: number; constraints?: Partial<Constraints>;
  theme?: string; ranked?: boolean; index?: number; mastery?: boolean; dateKey?: string; kind?: string; name?: string; desc?: string; intro?: string | null;
}
export interface Puzzle {
  id: string; seed: number; rows: number; cols: number; solution: number[]; constraints?: Partial<Constraints>; parMs?: number;
  name: string; theme: string; ranked?: boolean;
}
export interface Theme {
  id: string; name: string; sky: number; fog: number; ground: number; slab: number; cell: number; cellEdge: number;
  lit: number; litEmissive: number; accent: number; bloom: string[];
  ui: { filled: string; marked: string; accent: string; bg: string }; flora: string;
}
export interface LessonStep { text: string; require: { type: string; r?: number; c?: number }; requireCount?: number }
export interface Lesson { id: string; name: string; goal: string; board: { rows: number; cols: number; solution: number[] }; steps: LessonStep[] }
export interface Preset { id: string; name: string; rows: number; cols: number; density: number; note: string }
export interface JourneyRecord { stars: number; bestScore: number; bestMs: number | null; completed: boolean }
export interface BoardEntry { name?: string; score: number; mistakes: number; elapsedMs: number; mode?: string; presetId?: string; seed?: string; ruleset?: number; date?: string }
export interface Snapshot {
  savedAt: string; kind: string; label: string; spec: Spec; presetId?: string; puzzle: Puzzle; stateJson: string; stateElapsed: number;
  undoStack: number[][]; replayEnv: Envelope;
}
export interface Progress {
  journey: Record<string, JourneyRecord>; lessons: Record<string, boolean>;
  dailies: Record<string, { score: number; mistakes: number; elapsedMs: number; seed?: string }>;
  challenges: Record<string, { score: number; mistakes: number; elapsedMs: number }>;
  practicePlays: number; completions: number; cleanStreak: number; bestCleanStreak: number; dailyDates: string[];
  achievements: Record<string, string>; leaderboard: BoardEntry[]; lastSnapshot: Snapshot | null; excludedDailies: string[];
}
export interface SaveDoc { v: number; progress: Progress; name: string }
export interface Options { theme: string; palette: string; leftHanded: boolean; holdToMark: boolean; captions: boolean; inputMode: "fill" | "mark" }
export interface Achievement { key: string; name: string; desc: string }
export interface Quad { left: number; top: number; width: number; height: number }

interface RulesApi {
  createState(spec: Record<string, unknown>): State; serialize(s: State): string; deserialize(json: string): State;
  validate(s: State, cmd: Command): { ok: boolean; reason?: string };
  applyCommand(s: State, cmd: Command): ApplyResult; scoreComponents(s: State): ScoreParts;
  createReplayEnvelope(s: State, content: number, build: string): Envelope;
  replayRecord(env: Envelope, s: State, cmd: Command, res: ApplyResult): void;
  findForcedCell(s: State): { r: number; c: number; value: number } | null;
  REASON: Record<string, string>;
}
interface ContentApi {
  CONTENT_VERSION: number; THEMES: Theme[]; CVD_PALETTE: { filled: string; marked: string; accent: string; error: string };
  themeById(id: string): Theme; JOURNEY_STAGES: Spec[]; dailySpec(dateKey?: string): Spec; utcDateKey(d?: Date): string;
  challengeSpecs(weekKey?: string): Spec[]; utcWeekKey(d?: Date): string; PRACTICE_PRESETS: Preset[]; LESSONS: Lesson[];
  buildPuzzle(spec: Spec): Puzzle; namePuzzle(seed: number): string;
}
interface ProgressApi {
  ACHIEVEMENTS: Achievement[]; defaultSave(): SaveDoc; normalize(raw: unknown): SaveDoc; mergeSave(remote: unknown, local: unknown): SaveDoc;
  sameSave(a: unknown, b: unknown): boolean; readForeign(text: string): { save: SaveDoc; options: Partial<Options> } | null;
  DEFAULT_OPTIONS: Options; OPTION_KEYS: (keyof Options)[]; BROWSER_KEYS: string[]; THEME_IDS: string[]; PALETTES: string[];
  pickOptions(raw: unknown): Partial<Options>;
  recordJourney(p: Progress, id: string, r: { score: number; mistakes: number; hints: number; elapsedMs: number; parMs: number; completed: boolean }): JourneyRecord;
  journeyUnlocked(p: Progress, index: number, stages: Spec[]): boolean;
  recordDaily(p: Progress, dateKey: string, entry: { score: number; mistakes: number; elapsedMs: number; seed: string }): void;
  dailyStreak(p: Progress, todayKey: string): number; unlockAchievement(p: Progress, key: string, nowIso: string): boolean;
  addLeaderboard(p: Progress, entry: BoardEntry): void; practiceBests(p: Progress): Record<string, number>;
}

export const Rules = rules as unknown as RulesApi;
export const Content = content as unknown as ContentApi;
export const Progress = progress as unknown as ProgressApi;
export const journeyPuzzle = (puzzles as unknown as { journeyPuzzle(spec: Spec): Puzzle | null }).journeyPuzzle;
export const overlayLayout = (layout as unknown as { overlayLayout(rows: number, cols: number, centers: Float32Array | number[]): { cells: Quad[]; colClues: Quad[]; rowClues: Quad[]; cellW: number; cellH: number } }).overlayLayout;
export const formatMs = (layout as unknown as { formatMs(ms: number): string }).formatMs;
export const hashSeed = (prng as unknown as { hashSeed(text: string): number }).hashSeed;
export interface RngApi { float(): number; int(a: number, b: number): number; pick<T>(a: T[]): T }
export const Rng = (prng as unknown as { Rng: new (seed: number, label?: string) => RngApi }).Rng;
