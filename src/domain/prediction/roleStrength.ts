import type { GameKind, GameSlotDef, Player, PlayerId, SkillLevel } from '../types';
import { familyOf, structureOf } from '../n01/signature';
import type { ConfidenceLevel } from './confidence';
import { byThreshold, lowerConfidence, minConfidence, PLAYER_CONFIDENCE_LEGS } from './confidence';

/**
 * Role-specific strength (docs/THROW_ORDER_MODEL.md §4).
 *
 * One overall PPR does not say how a player does in each kind of game: some win Singles and
 * struggle in Doubles, some carry a Gallon, some are much better at 01 than at Cricket. A
 * player's strength in a game is
 *
 *   role strength = base strength (history-corrected PPR, as today) + Δ(role)
 *
 * where the role is the game's structure (Singles / Doubles / Trios / Gallon-Team) and family
 * (01 / Cricket). Δ is estimated in this order, each level shrinking towards the next:
 *
 *   1. n01 games in exactly this role, played before the match            (`n01-role`)
 *   2. n01 games in the nearest roles: the other multi-player structures
 *      of the same family (Doubles ↔ Trios ↔ Gallon)                       (`n01-near`)
 *   3. the captain's aptitude for the game's kinds                         (`aptitude`)
 *   4. nothing: Δ = 0 and the role strength is the base strength           (`base`)
 *
 * Each level is a shrunk mean, `(W · mean + K · parent) / (W + K)`, with W the recency- and
 * attribution-weighted legs behind it and K = ROLE_PRIOR_LEGS (doubled for Cricket). A team
 * result is never credited in full to each member: a k-player game counts 1/k for each.
 * Missing data is never 0 — it is the next level, ultimately the base strength itself.
 */

export const ROLE_STRUCTURES = ['SINGLES', 'DOUBLES', 'TRIOS', 'GALLON'] as const;
export type RoleStructure = (typeof ROLE_STRUCTURES)[number];
export type RoleFamily = '01' | 'CRICKET' | 'OTHER';
export type RoleKey = `${RoleStructure}|${RoleFamily}`;

export const ROLE_STRUCTURE_LABELS: Record<RoleStructure, string> = {
  SINGLES: 'Singles',
  DOUBLES: 'Doubles',
  TRIOS: 'Trios',
  GALLON: 'Gallon / Team',
};

export const ROLE_FAMILY_LABELS: Record<RoleFamily, string> = {
  '01': '01',
  CRICKET: 'Cricket',
  OTHER: 'その他',
};

/** Legs of evidence the next level counts as (the same scale as a player's PPR prior). */
export const ROLE_PRIOR_LEGS = 30;
/** Cricket evidence is shrunk twice as hard: PPR says less about it. */
export const ROLE_CRICKET_PRIOR_FACTOR = 2;
/** No role adjustment exceeds this many PPR points either way. */
export const ROLE_DELTA_CAP = 8;
/** One aptitude step (1..5, 3 = neutral) is worth this many PPR points. */
export const APTITUDE_PPR_PER_LEVEL = 1;

export type RoleSource = 'n01-role' | 'n01-near' | 'aptitude' | 'base';

export const ROLE_SOURCE_LABELS: Record<RoleSource, string> = {
  'n01-role': 'n01 の同じ役割の成績',
  'n01-near': 'n01 の近い役割の成績 (縮約)',
  aptitude: 'ゲーム適性の入力',
  base: '総合の強さ (役割別データなし)',
};

/** Evidence of one player in one role: Σ weights (legs) and Σ weight · residual (PPR points). */
export interface RoleEvidenceCell {
  games: number;
  weight: number;
  sum: number;
}

export type RoleEvidence = Partial<Record<RoleKey, RoleEvidenceCell>>;

export interface RoleStrengthEntry {
  key: RoleKey;
  /** PPR points added to the base strength in this role. */
  delta: number;
  confidence: ConfidenceLevel;
  source: RoleSource;
  /** Games and weighted legs observed in exactly this role. */
  games: number;
  legs: number;
  /** Games in the nearest roles that the estimate was shrunk towards. */
  nearGames: number;
  /** The aptitude adjustment used as the prior (`null` = no aptitude given). */
  aptitude: number | null;
}

export function roleStructureOf(game: Pick<GameSlotDef, 'kinds' | 'playerCount'>): RoleStructure {
  const structure = structureOf(game);
  if (structure === 'SINGLES' || structure === 'DOUBLES' || structure === 'TRIOS') return structure;
  return 'GALLON';
}

export function roleFamilyOf(game: Pick<GameSlotDef, 'kinds'>): RoleFamily {
  return familyOf(game);
}

export function roleKeyOf(game: Pick<GameSlotDef, 'kinds' | 'playerCount'>): RoleKey {
  return `${roleStructureOf(game)}|${roleFamilyOf(game)}`;
}

export function roleKeyFromParts(structure: RoleStructure, family: RoleFamily): RoleKey {
  return `${structure}|${family}`;
}

export function describeRole(key: RoleKey): string {
  const [structure, family] = key.split('|') as [RoleStructure, RoleFamily];
  return `${ROLE_STRUCTURE_LABELS[structure]} ${ROLE_FAMILY_LABELS[family]}`;
}

const STRUCTURE_SKILL: Partial<Record<RoleStructure, GameKind>> = {
  SINGLES: 'SINGLES',
  DOUBLES: 'DOUBLES',
  TRIOS: 'TRIOS',
};
const FAMILY_SKILL: Partial<Record<RoleFamily, GameKind>> = { '01': 'G501', CRICKET: 'CRICKET' };

/**
 * The captain's aptitude for a game as PPR points: the mean of (level − 3) over the game's
 * structure and family aptitudes that were actually entered. `null` when none was — an
 * unspecified aptitude is neutral, not a reason to move anyone.
 */
export function aptitudeDelta(player: Pick<Player, 'skills'>, game: Pick<GameSlotDef, 'kinds' | 'playerCount'>): number | null {
  const key = roleKeyOf(game);
  const [structure, family] = key.split('|') as [RoleStructure, RoleFamily];
  const kinds = [STRUCTURE_SKILL[structure], FAMILY_SKILL[family]].filter((kind): kind is GameKind => kind !== undefined);
  const levels = kinds
    .map((kind) => player.skills?.[kind])
    .filter((level): level is SkillLevel => typeof level === 'number');
  if (levels.length === 0) return null;
  return (levels.reduce((acc, level) => acc + (level - 3), 0) / levels.length) * APTITUDE_PPR_PER_LEVEL;
}

function isMulti(structure: RoleStructure): boolean {
  return structure !== 'SINGLES';
}

function shrink(cell: { weight: number; sum: number }, parent: number, k: number): number {
  return (cell.sum + k * parent) / (cell.weight + k);
}

/** The role estimate for one player and one game role (see the module comment). */
export function estimateRole(
  evidence: RoleEvidence | undefined,
  key: RoleKey,
  aptitude: number | null,
  baseConfidence: ConfidenceLevel,
): RoleStrengthEntry {
  const [structure, family] = key.split('|') as [RoleStructure, RoleFamily];
  const cricket = family === 'CRICKET';
  const k = ROLE_PRIOR_LEGS * (cricket ? ROLE_CRICKET_PRIOR_FACTOR : 1);
  const prior = aptitude ?? 0;

  const exact = evidence?.[key];
  // The nearest roles: the other multi-player structures of the same family (never the role itself).
  const near = { games: 0, weight: 0, sum: 0 };
  if (isMulti(structure)) {
    for (const other of ROLE_STRUCTURES) {
      if (other === structure || !isMulti(other)) continue;
      const cell = evidence?.[roleKeyFromParts(other, family)];
      if (!cell || !(cell.weight > 0)) continue;
      near.games += cell.games;
      near.weight += cell.weight;
      near.sum += cell.sum;
    }
  }

  const nearDelta = near.weight > 0 ? shrink(near, prior, k) : prior;
  const raw = exact && exact.weight > 0 ? shrink(exact, nearDelta, k) : nearDelta;
  const delta = Math.max(-ROLE_DELTA_CAP, Math.min(ROLE_DELTA_CAP, raw));

  let source: RoleSource;
  let confidence: ConfidenceLevel;
  if (exact && exact.weight > 0) {
    source = 'n01-role';
    confidence = minConfidence(byThreshold(exact.weight, PLAYER_CONFIDENCE_LEGS), baseConfidence);
  } else if (near.weight > 0) {
    source = 'n01-near';
    confidence = minConfidence(lowerConfidence(byThreshold(near.weight, PLAYER_CONFIDENCE_LEGS)), baseConfidence);
  } else if (aptitude !== null) {
    source = 'aptitude';
    confidence = 'LOW';
  } else {
    source = 'base';
    confidence = baseConfidence;
  }
  if (cricket) confidence = lowerConfidence(confidence);

  return {
    key,
    delta,
    confidence,
    source,
    games: exact?.games ?? 0,
    legs: exact?.weight ?? 0,
    nearGames: near.games,
    aptitude,
  };
}

// ---------------------------------------------------------------------------
// The snapshot an order keeps
// ---------------------------------------------------------------------------

export interface RolePlayerContext {
  /** Role evidence from n01 games played before the match (absent = none). */
  evidence?: RoleEvidence;
}

/**
 * The role evidence an order was generated with, saved inside the order (`OrderInput.roleStrength`)
 * so a saved order is re-evaluated with exactly the evidence it was made with.
 */
export interface RoleStrengthContext {
  version: 1;
  generatedAt: number;
  /** Where the evidence came from: n01 games, or nothing beyond the roster. */
  source: 'n01' | 'none';
  /** n01 games read for the evidence (both teams), for the explanation. */
  gamesObserved: number;
  /** The date games had to be before (`YYYY-MM-DD`), when a match date was known. */
  before: string | null;
  players: Record<PlayerId, RolePlayerContext>;
}
