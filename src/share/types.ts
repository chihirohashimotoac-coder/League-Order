import type { PlayerId } from '../domain/types';

/**
 * Share layout model (docs/DESIGN.md 追補 §S1, §S4).
 *
 * A plain, renderer-independent description of what a shared order shows. The Canvas
 * renderer and the text renderers both consume it, which is what keeps the image and
 * the text saying exactly the same thing.
 */

/** Compact is for the team chat; detail is the captain's record. */
export type ShareImageVariant = 'compact' | 'detail';

export type ShareTextFormat = 'line' | 'simple' | 'detail';

export interface ShareHeader {
  /** League name when set, otherwise the generic title. */
  title: string;
  teamName: string;
  /** Empty when no opponent has been entered. */
  opponentName: string;
  /** Pre-formatted, e.g. `2026/10/08`. Empty when no date is set. */
  dateText: string;
}

export interface ShareGameRow {
  /** `G1`, `G2`, … */
  no: string;
  gameName: string;
  /** Players joined for display, e.g. `ちひろ / かいり`. */
  players: string;
}

export interface ShareTallyRow {
  name: string;
  /** `R14`, `R14*` (imputed) or `R-` when no rating exists at all. */
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
