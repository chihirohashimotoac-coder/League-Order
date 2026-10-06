import type { GameAssignment, PlayerId, PlayerTally } from '../domain/types';

/**
 * Share layout model (docs/DESIGN.md 追補 §S1, §S4).
 *
 * A plain, renderer-independent description of what a shared order shows. The Canvas
 * renderer and the text renderers both consume it, which is what keeps the image and
 * the text saying exactly the same thing.
 */

/** Compact is for the team chat; detail is the captain's record. */
export type ShareImageVariant = 'compact' | 'detail';

export type ShareTextFormat = 'line' | 'simple' | 'detail' | 'updateDiff' | 'updateFull';

/**
 * Version badge carried on every shared form (追加要件 §6, §7).
 *
 * Kept deliberately small on the image — one muted line — so it does not compete with
 * the order itself, while still telling a member which copy they are looking at.
 */
export interface ShareVersionInfo {
  /** Finalized version number, or 0 while the order is still a draft. */
  version: number;
  /** True for v2 and later: the team has already seen an earlier copy. */
  isUpdate: boolean;
  /** True when nothing has been finalized yet. */
  draft: boolean;
}

/**
 * The parts of an order the share layer reads.
 *
 * `OrderSolution` satisfies this structurally, and so does a stored `OrderVersion` (via
 * `shareableFromVersion`), which is how a past version can be re-shared exactly as it
 * was finalized.
 */
export interface ShareableOrder {
  assignments: readonly GameAssignment[];
  tallies: readonly PlayerTally[];
  metrics: { hasImputedRating: boolean };
  meta: { label: string };
}

export interface ShareHeader {
  /** League name when set, otherwise the generic title. */
  title: string;
  teamName: string;
  /** Empty when no opponent has been entered. */
  opponentName: string;
  /** Pre-formatted, e.g. `2026/10/08`. Empty when no date is set. */
  dateText: string;
  /** e.g. `ORDER v2 · 更新版`, or `未確定 (DRAFT)`. Empty when not applicable. */
  versionText: string;
  /** Drives the badge colour on the image: amber draft, green v1, orange update. */
  versionTone: 'draft' | 'finalized' | 'updated' | 'none';
}

export interface ShareGameRow {
  /** `G1`, `G2`, … */
  no: string;
  gameName: string;
  /** Players joined for display, e.g. `ちひろ / かいり`. */
  players: string;
  /** The same players one per entry, for layouts that stack them. */
  playerNames: string[];
}

export interface ShareTallyRow {
  name: string;
  /** `Rt.14`, `Rt.14*` (imputed) or `Rt.—` when no rating exists at all. */
  rating: string;
  count: number;
  seasonTotal: number;
}

export interface ShareLayout {
  variant: ShareImageVariant;
  header: ShareHeader;
  games: ShareGameRow[];
  /** Detail variant only. */
  tally: ShareTallyRow[];
  /** Detail variant only: the preset that produced the order. */
  orderTypeLabel: string;
  /** Detail variant only: short captions such as the imputed-rating note. */
  notes: string[];
}

export interface PlayerScheduleEntry {
  no: string;
  gameName: string;
  /** Other players in the same game. Empty for singles. */
  partners: string[];
}

export interface PlayerSchedule {
  playerId: PlayerId;
  name: string;
  entries: PlayerScheduleEntry[];
}
