/**
 * Core domain types for the Darts League Order Optimizer.
 *
 * This module is intentionally free of any React / DOM / IndexedDB dependency so
 * that the domain and the optimizer stay pure and testable in isolation
 * (see docs/DESIGN.md §12).
 */

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
  skills: PlayerSkills;
  note?: string;
  /** Season-cumulative appearance count. */
  seasonAppearances: number;
  /** Season-cumulative appearance count broken down by game kind. */
  seasonAppearancesByKind: Partial<Record<GameKind, number>>;
  archived: boolean;
  createdAt: number;
}

export interface Team {
  id: TeamId;
  name: string;
  /** League this team plays in. Used on shared orders; purely descriptive. */
  leagueName?: string;
  note?: string;
  createdAt: number;
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
}

export interface LeagueFormat {
  id: FormatId;
  /** `null` = shared across all teams. */
  teamId: TeamId | null;
  name: string;
  note?: string;
  games: GameSlotDef[];
  createdAt: number;
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
  'WIN_FIRST',
  'BALANCED',
  'FAIRNESS_FIRST',
  'DEVELOPMENT',
  'NEW_PAIR',
  'CUSTOM',
] as const;

export type PresetKey = (typeof PRESET_KEYS)[number];

export const PRESET_LABELS: Record<PresetKey, string> = {
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
  novelty: number;
  consecutive: number;
  season: number;
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
  | 'novelty'
  | 'consecutive'
  | 'season'
  | 'constraint'
  | 'lock';

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
  /** Longest run of consecutive games for this player. */
  maxConsecutive: number;
  countByKind: Partial<Record<GameKind, number>>;
}

export interface ScoreBreakdown {
  strength: number;
  gameFit: number;
  pairFit: number;
  fairness: number;
  novelty: number;
  consecutivePenalty: number;
  seasonImbalance: number;
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
  /** True when at least one participant's rating was imputed. */
  hasImputedRating: boolean;
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
}

export interface OrderSolution {
  assignments: GameAssignment[];
  tallies: PlayerTally[];
  score: ScoreBreakdown;
  metrics: OrderMetrics;
  explanation: OrderExplanation;
  warnings: OrderWarning[];
  meta: SolutionMeta;
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

export interface AppSettings {
  activeTeamId: TeamId | null;
  optimizer: OptimizerSettings;
  lastPreset: PresetKey;
  customWeights: ScoreWeights;
}
