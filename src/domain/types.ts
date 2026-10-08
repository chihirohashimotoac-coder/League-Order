/**
 * Core domain types for the Darts League Order Optimizer.
 *
 * This module is intentionally free of any React / DOM / IndexedDB dependency so
 * that the domain and the optimizer stay pure and testable in isolation
 * (see docs/DESIGN.md §12).
 */

import type {
  N01FormatSource,
  N01GameMeta,
  N01PlayerBinding,
  N01TeamBinding,
  PprSource,
} from './n01/types';
import type { OpponentContext } from './prediction/opponentContext';
import type { MatchPrediction } from './prediction/predictOrder';
import type { ConfidenceLevel } from './prediction/confidence';
import type { StrengthBasis } from './n01/historyStrength';

export type TeamId = string;
export type PlayerId = string;
export type GameId = string;
export type FormatId = string;
export type OrderId = string;
export type PairId = string;

/**
 * A darts Rating.
 *
 * `null` means **Unknown** — the value was never entered. It is NEVER equivalent
 * to `0`; see `resolveRatings()` in `domain/players/rating.ts` for how Unknown is
 * handled during scoring (design record D-06).
 */
export type Rating = number | null;

/**
 * A PPR (points per round) average.
 *
 * Like {@link Rating}, `null` means **Unknown** and is never read as `0`. The
 * theoretical maximum is 180 (three treble-20s every round).
 */
export type Ppr = number | null;

/** Inclusive bounds accepted for a PPR average. */
export const PPR_MIN = 0;
export const PPR_MAX = 180;

/**
 * Which kind of darts a league is played in.
 *
 * Stored on the format, not the team: one team can enter a soft league and a steel
 * league at the same time. `UNSPECIFIED` is what every format created before the field
 * existed reads back as — it is never guessed from the format's name.
 */
export const DARTS_DISCIPLINES = ['SOFT', 'STEEL', 'UNSPECIFIED'] as const;

export type DartsDiscipline = (typeof DARTS_DISCIPLINES)[number];

export const DARTS_DISCIPLINE_LABELS: Record<DartsDiscipline, string> = {
  SOFT: 'Soft Darts',
  STEEL: 'Steel Darts',
  UNSPECIFIED: '未設定',
};

/** Short badge text (`SOFT` / `STEEL` / `未設定`). */
export const DARTS_DISCIPLINE_TAGS: Record<DartsDiscipline, string> = {
  SOFT: 'SOFT',
  STEEL: 'STEEL',
  UNSPECIFIED: '未設定',
};

/** Reads a stored value back as a discipline; anything unknown is `UNSPECIFIED`. */
export function asDiscipline(value: unknown): DartsDiscipline {
  return value === 'SOFT' || value === 'STEEL' ? value : 'UNSPECIFIED';
}

/** Game aptitude on a 1..5 scale. `undefined` means "not specified" (neutral), not 0. */
export type SkillLevel = 1 | 2 | 3 | 4 | 5;

export const GAME_KINDS = [
  'G501',
  'CRICKET',
  'SINGLES',
  'DOUBLES',
  'TRIOS',
  'GALLON',
  'TEAM',
  'CUSTOM',
] as const;

export type GameKind = (typeof GAME_KINDS)[number];

export const GAME_KIND_LABELS: Record<GameKind, string> = {
  G501: '501',
  CRICKET: 'Cricket',
  SINGLES: 'Singles',
  DOUBLES: 'Doubles',
  TRIOS: 'Trios',
  GALLON: 'Gallon',
  TEAM: 'Team Game',
  CUSTOM: 'Custom',
};

/**
 * Labels for the kind toggles in the format editor.
 *
 * The 01 game is shown as `01` there (the family name, which covers 301 / 501 / 701),
 * while the stored identifier stays `G501` so saved data and game names are untouched.
 */
export const FORMAT_KIND_CHIP_LABELS: Record<GameKind, string> = {
  ...GAME_KIND_LABELS,
  G501: '01',
};

/**
 * Kinds that describe how many players share a game — the "role" a player fills.
 * `G501` / `CRICKET` describe the game played, not the role, and are never one.
 */
export const STRUCTURAL_KINDS = ['SINGLES', 'DOUBLES', 'TRIOS', 'GALLON', 'TEAM'] as const;

export type StructuralKind = (typeof STRUCTURAL_KINDS)[number];

/** Kinds for which a per-player aptitude can be stored and scored. */
export const SKILL_KINDS: readonly GameKind[] = [
  'G501',
  'CRICKET',
  'SINGLES',
  'DOUBLES',
  'TRIOS',
];

export type PlayerSkills = Partial<Record<GameKind, SkillLevel>>;

export interface Player {
  id: PlayerId;
  teamId: TeamId;
  name: string;
  /** `null` = Unknown rating. */
  rating: Rating;
  /**
   * PPR average. `null` = Unknown. Players stored before the field existed are read
   * back with `null` (see `domain/normalise.ts`); scoring also treats a missing value
   * as `null`, never as `0`.
   */
  ppr: Ppr;
  skills: PlayerSkills;
  note?: string;
  /** Season-cumulative appearance count. */
  seasonAppearances: number;
  /** Season-cumulative appearance count broken down by game kind. */
  seasonAppearancesByKind: Partial<Record<GameKind, number>>;
  archived: boolean;
  createdAt: number;
  /**
   * Where the roster entry comes from on n01 (docs/N01_MASTER_DESIGN.md §2). Absent on
   * players created by hand. A sync rewrites only this record and the name — never the
   * Rating, aptitudes, notes or season counts.
   */
  n01?: N01PlayerBinding;
  /**
   * Which PPR the optimizer uses. Absent means the default: `n01` for a linked player,
   * `manual` otherwise (see `domain/n01/effectivePpr.ts`).
   */
  pprSource?: PprSource;
}

export interface Team {
  id: TeamId;
  name: string;
  /** League this team plays in. Used on shared orders; purely descriptive. */
  leagueName?: string;
  note?: string;
  /**
   * True for the bundled sample team, so the UI can label it as demo data and nobody
   * mistakes it for a real roster. Absent on every team a captain creates.
   */
  demo?: boolean;
  createdAt: number;
  /** Present when the team is linked to an n01 league team. */
  n01?: N01TeamBinding;
}

/**
 * Context about the match itself: who it is against, when, and in which league.
 *
 * This is deliberately NOT part of `OrderInput`. It has no effect on constraints,
 * scoring or search — it only appears on the shared image and text — so keeping it out
 * of the optimizer's input leaves the engine's behaviour untouched.
 */
export interface MatchInfo {
  /** Empty string when unset. */
  leagueName: string;
  teamName: string;
  opponentName: string;
  /** `YYYY-MM-DD`, or an empty string when unset. */
  matchDate: string;
}

export function createMatchInfo(teamName = '', leagueName = ''): MatchInfo {
  return { leagueName, teamName, opponentName: '', matchDate: '' };
}

/** One game (one row of the order sheet) inside a league format. */
export interface GameSlotDef {
  id: GameId;
  /** 1-based display order. Also defines adjacency for consecutive-appearance rules. */
  order: number;
  name: string;
  /**
   * One or more kinds. A "Doubles 501" game carries `['DOUBLES', 'G501']` so that
   * both aptitudes are scored and either kind can be used in an exclusion rule.
   */
  kinds: GameKind[];
  /** Required number of players for this game. */
  playerCount: number;
  /** What n01 says about the game, on formats managed by n01. */
  n01?: N01GameMeta;
}

export interface LeagueFormat {
  id: FormatId;
  /** `null` = shared across all teams. */
  teamId: TeamId | null;
  name: string;
  note?: string;
  /**
   * Soft or steel. Formats stored before the field existed are read back as
   * `UNSPECIFIED` (see `domain/normalise.ts`); it is never guessed.
   */
  discipline: DartsDiscipline;
  games: GameSlotDef[];
  createdAt: number;
  /**
   * Set on formats that n01 manages: they are rewritten by each sync and are read-only
   * in the editor ("copy to a manual format" makes an editable one).
   */
  source?: N01FormatSource;
}

export function formatDiscipline(format: Pick<LeagueFormat, 'discipline'> | null | undefined): DartsDiscipline {
  return asDiscipline(format?.discipline);
}

export const PAIR_AFFINITIES = [
  'VERY_GOOD',
  'GOOD',
  'NEUTRAL',
  'DISCOURAGED',
  'FORBIDDEN',
] as const;

export type PairAffinity = (typeof PAIR_AFFINITIES)[number];

export const PAIR_AFFINITY_LABELS: Record<PairAffinity, string> = {
  VERY_GOOD: '非常に良い',
  GOOD: '良い',
  NEUTRAL: '普通',
  DISCOURAGED: '非推奨',
  FORBIDDEN: '禁止',
};

/** Soft score contribution per affinity. FORBIDDEN is a hard constraint, not a score. */
export const PAIR_AFFINITY_VALUES: Record<Exclude<PairAffinity, 'FORBIDDEN'>, number> = {
  VERY_GOOD: 1,
  GOOD: 0.75,
  NEUTRAL: 0.5,
  DISCOURAGED: 0.15,
};

export interface PairSetting {
  id: PairId;
  teamId: TeamId;
  /** Canonically ordered so that `a < b` lexicographically. */
  a: PlayerId;
  b: PlayerId;
  affinity: PairAffinity;
  /** How many times this pair has already played together (drives the "new pair" preset). */
  pastTogetherCount: number;
}

// ---------------------------------------------------------------------------
// Order input
// ---------------------------------------------------------------------------

/** Inclusive range of game display orders in which a player may be fielded. */
export interface AppearanceWindow {
  /** Earliest allowed game `order` (inclusive). `undefined` = no lower bound. */
  fromOrder?: number;
  /** Latest allowed game `order` (inclusive). `undefined` = no upper bound. */
  toOrder?: number;
}

export interface ParticipantConfig {
  playerId: PlayerId;
  /** Players with `include: false` are never fielded (hard). */
  include: boolean;
  /** Hard: specific games this player cannot play. */
  excludedGameIds: GameId[];
  /** Hard: kinds this player cannot play (matches if the game carries the kind). */
  excludedKinds: GameKind[];
  /** Hard: window of game orders this player is available for. */
  window?: AppearanceWindow;
  /** Minimum appearances. Hard or soft per `OptimizerSettings.minAppearanceMode`. */
  minAppearances?: number;
  /** Maximum appearances. Always hard. */
  maxAppearances?: number;
  /** Max consecutive games. Hard or soft per `OptimizerSettings.consecutiveMode`. */
  maxConsecutive?: number;
  /**
   * Per-order rating override (e.g. a guest whose rating differs today).
   * `undefined` = use the player's stored rating. `null` = force Unknown.
   */
  ratingOverride?: Rating;
}

/** A pinned assignment that re-generation must preserve (hard). */
export interface LockEntry {
  gameId: GameId;
  /** 0-based slot index inside the game. */
  slotIndex: number;
  playerId: PlayerId;
}

export type FairnessScope = 'today' | 'season';
export type ConstraintMode = 'hard' | 'soft';

export const PRESET_KEYS = [
  'OPPONENT_OPTIMIZED',
  'WIN_FIRST',
  'BALANCED',
  'FAIRNESS_FIRST',
  'DEVELOPMENT',
  'NEW_PAIR',
  'CUSTOM',
] as const;

export type PresetKey = (typeof PRESET_KEYS)[number];

export const PRESET_LABELS: Record<PresetKey, string> = {
  OPPONENT_OPTIMIZED: '対戦相手最適化',
  WIN_FIRST: '勝利優先',
  BALANCED: 'バランス',
  FAIRNESS_FIRST: '公平性優先',
  DEVELOPMENT: '育成重視',
  NEW_PAIR: '新ペア試行',
  CUSTOM: 'カスタム',
};

export interface ScoreWeights {
  strength: number;
  gameFit: number;
  pairFit: number;
  fairness: number;
  /**
   * Spread of each structural role (Singles, Doubles, …) across players. Weights stored
   * before it existed are completed by `normaliseWeights()`.
   */
  roleFairness: number;
  novelty: number;
  consecutive: number;
  season: number;
  /**
   * Estimated chance of winning each game against the predicted opponent line-ups
   * (docs/OPPONENT_OPTIMIZER.md). Only the opponent-optimised preset uses it; absent or
   * 0 everywhere else, which leaves every other preset exactly as it was.
   */
  opponentWin?: number;
}

export interface OptimizerSettings {
  /** Default max consecutive games when a participant does not override it. */
  defaultMaxConsecutive: number;
  consecutiveMode: ConstraintMode;
  minAppearanceMode: ConstraintMode;
  fairnessScope: FairnessScope;
  timeLimitMs: number;
  nodeLimit: number;
  maxCombosPerGame: number;
  beamWidth: number;
}

export interface OrderInput {
  teamId: TeamId;
  formatId: FormatId;
  /** Snapshot of the games, so a saved order stays reproducible if the format changes. */
  games: GameSlotDef[];
  players: Player[];
  participants: ParticipantConfig[];
  pairs: PairSetting[];
  locks: LockEntry[];
  preset: PresetKey;
  weights: ScoreWeights;
  settings: OptimizerSettings;
  /**
   * Snapshot of the format's discipline at generation time, so a saved order is scored
   * the same way after the format is edited. Orders saved before it existed read back
   * as `UNSPECIFIED`.
   */
  discipline: DartsDiscipline;
  /**
   * The opponent the order is made against (Phase 4): our players' predicted strengths
   * and, per game, the distribution of the opponent side. Self-contained, so a saved
   * order can always be re-evaluated as it was generated. Absent = no opponent data.
   */
  opponent?: OpponentContext;
  /**
   * Where each player's PPR in `players` came from (hand-entered, this season, earlier
   * seasons, carried over) and how well the data behind it stands. Absent on orders made
   * before it existed, which are read as "no evidence" wherever evidence is required.
   */
  strengthBasis?: StrengthBasis;
}

// ---------------------------------------------------------------------------
// Order output
// ---------------------------------------------------------------------------

export interface GameAssignment {
  gameId: GameId;
  /** Players assigned to this game, in slot order. */
  playerIds: PlayerId[];
}

export type ExplanationTone = 'positive' | 'neutral' | 'negative';

export type ExplanationKey =
  | 'strength'
  | 'gameFit'
  | 'pairFit'
  | 'fairness'
  | 'roleFairness'
  | 'novelty'
  | 'consecutive'
  | 'season'
  | 'constraint'
  | 'lock'
  | 'opponent';

export interface ExplanationFactor {
  key: ExplanationKey;
  label: string;
  /** Normalised 0..1 value when the factor is a scored component. */
  value?: number;
  detail: string;
  tone: ExplanationTone;
}

export interface GameExplanation {
  gameId: GameId;
  playerIds: PlayerId[];
  factors: ExplanationFactor[];
}

export interface OrderExplanation {
  games: GameExplanation[];
  overall: ExplanationFactor[];
}

export interface PlayerTally {
  playerId: PlayerId;
  /** Appearances in this order. */
  count: number;
  /** Season-cumulative appearances BEFORE this order. */
  seasonBefore: number;
  /** Season-cumulative appearances including this order. */
  seasonTotal: number;
  /** Effective rating used for scoring (`null` only if there is no rating at all). */
  effectiveRating: number | null;
  /** True when `effectiveRating` was imputed because the stored rating is Unknown. */
  ratingImputed: boolean;
  /** Effective PPR used for scoring. Absent on orders saved before PPR existed. */
  effectivePpr?: number | null;
  /** True when `effectivePpr` was imputed because the stored PPR is Unknown. */
  pprImputed?: boolean;
  /** Longest run of consecutive games for this player. */
  maxConsecutive: number;
  countByKind: Partial<Record<GameKind, number>>;
}

export interface ScoreBreakdown {
  strength: number;
  gameFit: number;
  pairFit: number;
  fairness: number;
  /** Absent on solutions saved before role fairness existed. */
  roleFairness?: number;
  novelty: number;
  consecutivePenalty: number;
  seasonImbalance: number;
  /** Mean estimated game win probability against the opponent (opponent-aware runs). */
  opponentWin?: number;
  /** Raw weighted sum. */
  total: number;
  /** `total` mapped linearly onto 0..100 for display. */
  display: number;
}

export interface OrderMetrics {
  totalSlots: number;
  participantCount: number;
  /** max(count) - min(count) across participants. */
  appearanceSpread: number;
  appearanceStdDev: number;
  /** Excess sum-of-squared-deviation above the achievable minimum (0 = ideal). */
  fairnessExcess: number;
  maxConsecutive: number;
  /** Mean effective rating across all filled slots. */
  averageRating: number | null;
  /** Mean effective PPR across all filled slots. Absent on old solutions. */
  averagePpr?: number | null;
  /** True when at least one participant's rating was imputed. */
  hasImputedRating: boolean;
  /**
   * The share of Rating and PPR in the strength term actually used (each 0..1, summing
   * to 1, or both 0 when neither carried any information). Absent on old solutions.
   */
  strengthWeights?: StrengthWeights;
  /** Discipline the order was scored for. Absent on old solutions. */
  discipline?: DartsDiscipline;
  /**
   * Largest number of games one player plays inside any one structural role
   * (e.g. 3 = somebody plays three of the Singles). Absent on old solutions.
   */
  maxRoleConcentration?: number;
}

/** Composition of the strength term: how much Rating and PPR each contribute. */
export interface StrengthWeights {
  rating: number;
  ppr: number;
}

export interface OrderWarning {
  severity: 'warning' | 'info';
  code: string;
  message: string;
  gameId?: GameId;
  playerId?: PlayerId;
}

export interface SolutionMeta {
  /** Which generation stage produced the returned assignment. */
  stage: 'dfs' | 'beam' | 'dfs+polish' | 'beam+polish';
  /** True when the branch-and-bound search completed without hitting a limit. */
  exhaustive: boolean;
  nodesVisited: number;
  elapsedMs: number;
  /** Candidate label shown in the comparison UI. */
  label: string;
  presetKey: PresetKey;
  /**
   * Set when this preset's own optimum is a line-up already shown as an earlier
   * candidate (named here): the candidate is then the preset's best *different* order,
   * and the UI says so rather than presenting a near-copy as the preset's choice.
   */
  alternativeTo?: string;
  /** How opponent data was used by this run (opponent-optimised preset only). */
  opponent?: {
    /** `applied` at full weight, `reduced` for weaker data, `fallback` when there was none. */
    mode: 'applied' | 'reduced' | 'fallback';
    baseWeight: number;
    effectiveWeight: number;
    confidence: ConfidenceLevel | null;
  };
}

export interface OrderSolution {
  assignments: GameAssignment[];
  tallies: PlayerTally[];
  score: ScoreBreakdown;
  metrics: OrderMetrics;
  explanation: OrderExplanation;
  warnings: OrderWarning[];
  meta: SolutionMeta;
  /**
   * Estimated match outcome against the opponent (推定勝率), when the order input carries
   * opponent data. A model estimate, never a certainty.
   */
  prediction?: MatchPrediction;
}

// ---------------------------------------------------------------------------
// Diagnostics (unsatisfiable inputs — see spec §31)
// ---------------------------------------------------------------------------

export type DiagnosticCode =
  | 'NO_PARTICIPANTS'
  | 'NO_GAMES'
  | 'GAME_INSUFFICIENT_ELIGIBLE'
  | 'GAME_ALL_COMBOS_FORBIDDEN'
  | 'CAPACITY_TOO_LOW'
  | 'MIN_TOTAL_TOO_HIGH'
  | 'MIN_UNREACHABLE'
  | 'LOCK_INVALID'
  | 'LOCK_CONFLICT'
  | 'SEARCH_EXHAUSTED'
  | 'INVALID_GAME';

export interface DiagnosticSuggestion {
  /** Human-readable remedy. */
  message: string;
  kind:
    | 'allowPlayerInGame'
    | 'addParticipant'
    | 'raiseMaxAppearances'
    | 'lowerMinAppearances'
    | 'relaxConsecutive'
    | 'relaxForbiddenPair'
    | 'removeLock'
    | 'reduceGames'
    | 'other';
  playerId?: PlayerId;
  gameId?: GameId;
  value?: number;
}

export interface Diagnostic {
  code: DiagnosticCode;
  message: string;
  gameId?: GameId;
  playerIds?: PlayerId[];
  suggestions: DiagnosticSuggestion[];
}

export type GenerateResult =
  | { ok: true; candidates: OrderSolution[]; diagnostics: Diagnostic[] }
  | { ok: false; candidates: []; diagnostics: Diagnostic[] };

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------

/**
 * Lifecycle of a saved order (追加要件 §2).
 *
 * The state is **derived**, never stored: it is a pure function of the finalized
 * versions and the content of the working copy (see `domain/orders/lifecycle.ts`).
 * That makes the transitions unambiguous and impossible to leave stale — opening the
 * share screen or regenerating an image cannot change it, while any edit that changes
 * what the team would see flips FINALIZED to UPDATED on its own.
 */
export type OrderLifecycleState = 'DRAFT' | 'FINALIZED' | 'UPDATED';

export const ORDER_STATE_LABELS: Record<OrderLifecycleState, string> = {
  DRAFT: '未確定',
  FINALIZED: '確定済み',
  UPDATED: '変更あり (再確定が必要)',
};

/** Appearances a single player accrued in one version of an order. */
export interface AppearanceRecord {
  playerId: PlayerId;
  count: number;
  byKind: Partial<Record<GameKind, number>>;
}

/**
 * An immutable snapshot taken when an order is finalized (追加要件 §4, §5).
 *
 * It carries its own copies of the games, players, participants and match context, so a
 * later rename, roster change or format edit can never rewrite what was already shared.
 */
export interface OrderVersion {
  /** 1-based, incrementing per finalization of the same order. */
  version: number;
  finalizedAt: number;
  /** Canonical digest of the shared content; drives the lifecycle state. */
  fingerprint: string;
  assignments: GameAssignment[];
  games: GameSlotDef[];
  players: Player[];
  participants: ParticipantConfig[];
  match: MatchInfo;
  tallies: PlayerTally[];
  /** Appearances this version contributes to season totals. */
  appearances: AppearanceRecord[];
  /** Order type (preset label) that produced it. */
  label: string;
  hasImputedRating: boolean;
  /** Discipline the version was generated for. Absent on versions made before it existed. */
  discipline?: DartsDiscipline;
}

/**
 * Ledger entry recording exactly what a saved order has contributed to season totals
 * (追加要件 §12). The ledger — not a flag and not a dialog — is what makes committing
 * idempotent: re-committing applies the difference against this record, which is zero
 * when nothing changed.
 */
export interface SeasonCommit {
  /** Keyed by order: one active commit per order. */
  id: OrderId;
  teamId: TeamId;
  committedVersion: number;
  committedAt: number;
  /** The exact amounts currently reflected in the players' season totals. */
  appearances: AppearanceRecord[];
}

export type SeasonCommitStatus = 'none' | 'current' | 'outdated';

export interface SavedOrder {
  id: OrderId;
  teamId: TeamId;
  title: string;
  createdAt: number;
  updatedAt: number;
  /** Full input snapshot so the order can be reopened and re-optimised. */
  input: OrderInput;
  solution: OrderSolution;
  /** Match context captured alongside the order, for re-sharing it later. */
  match?: MatchInfo;
  /** Finalized snapshots, oldest first. Empty while the order is still a draft. */
  versions: OrderVersion[];
  /**
   * Legacy cache of "has been committed to the season".
   * The `seasonCommits` ledger is the source of truth; this is kept in step for
   * backups written by, and readable by, older builds.
   */
  seasonApplied: boolean;
}

/** n01 integration preferences (MASTER SPEC Phase 5 §10). Kept deliberately small. */
export interface N01Settings {
  /** Sync with n01 before building the next match's order. */
  autoSync: boolean;
  /** Previous seasons read for history (current + this many). */
  historyDepth: number;
  /** Show estimated win probabilities on the result screen. */
  showPredictions: boolean;
}

export const DEFAULT_N01_SETTINGS: N01Settings = {
  autoSync: true,
  historyDepth: 2,
  showPredictions: true,
};

export interface AppSettings {
  activeTeamId: TeamId | null;
  optimizer: OptimizerSettings;
  lastPreset: PresetKey;
  customWeights: ScoreWeights;
  /** Absent on settings stored before the n01 integration; read back with the defaults. */
  n01?: N01Settings;
}
