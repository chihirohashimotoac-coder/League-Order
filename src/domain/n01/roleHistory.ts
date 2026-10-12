import { gameWinProbability } from '../prediction/matchup';
import type { RoleEvidence, RoleEvidenceCell, RoleFamily, RoleKey, RoleStructure } from '../prediction/roleStrength';
import { roleKeyFromParts } from '../prediction/roleStrength';
import { RECENCY_WEIGHTS, recencyWeight } from './recency';

/**
 * Role evidence from n01 games (docs/THROW_ORDER_MODEL.md §4).
 *
 * n01's player stats are one season total per person, whatever they played. A game record
 * (`match/list`) says, per game, who played it for each side and how the side did, so a person's
 * games can be grouped by role (Singles / Doubles / Trios / Gallon × 01 / Cricket).
 *
 * What a game says about a member, in PPR points:
 *
 *   01        performance   r = side PPR in the game − mean of the members' season PPR
 *   Cricket   result        r = (won − p̂) / (k · p̂ (1 − p̂)),  p̂ from the members' strengths,
 *                            counted at OUTCOME_EVIDENCE_FACTOR of a 01 game (a result says much
 *                            less than a scoring rate), capped at ±OUTCOME_RESIDUAL_CAP
 *
 * weighted by recency × legs played. A game of k players is credited 1/k to each member — the
 * side's result is never given in full to each of them — and the role estimate then shrinks
 * the sum towards the nearest roles and the aptitude (`roleStrength.ts`). Games on or after the
 * match day are dropped (no future data), and a game whose members' season PPR is unknown says
 * nothing (never 0).
 */

export const OUTCOME_EVIDENCE_FACTOR = 0.1;
export const OUTCOME_RESIDUAL_CAP = 15;
/** Slope of the leg model used for Cricket results (the prediction model's own). */
const CRICKET_LEG_K = 0.09;

export interface RoleGameMember {
  /** The person's key in the snapshot (who the evidence is credited to). */
  key: string;
  /** Their PPR that season (`null` = unknown: the game says nothing about the side). */
  base: number | null;
}

export interface RoleGameSide {
  teamId: string;
  members: RoleGameMember[];
  legsWon: number;
  score: number | null;
  darts: number | null;
}

export interface RoleGameRecord {
  gameId: string;
  seasonIndex: number;
  /** Epoch seconds, when n01 gave one. */
  startTime: number | null;
  structure: RoleStructure;
  family: RoleFamily;
  sides: [RoleGameSide, RoleGameSide];
}

export interface RoleHistoryResult {
  evidence: Record<string, RoleEvidence>;
  /** Games that contributed (for one team). */
  games: number;
  /** Games dropped because they were not strictly before the match day. */
  droppedFuture: number;
}

export function structureOfHeadCount(numPart: number): RoleStructure {
  if (numPart <= 1) return 'SINGLES';
  if (numPart === 2) return 'DOUBLES';
  if (numPart === 3) return 'TRIOS';
  return 'GALLON';
}

export function familyOfMatchType(matchType: string): RoleFamily {
  const type = matchType.trim().toLowerCase();
  if (type === '01' || /^\d+$/u.test(type) || type === '') return '01';
  if (type.includes('cricket') || type.includes('クリケット')) return 'CRICKET';
  return 'OTHER';
}

function add(evidence: Record<string, RoleEvidence>, key: string, role: RoleKey, weight: number, residual: number): void {
  const person = (evidence[key] ??= {});
  const cell: RoleEvidenceCell = person[role] ?? { games: 0, weight: 0, sum: 0 };
  cell.games += 1;
  cell.weight += weight;
  cell.sum += weight * residual;
  person[role] = cell;
}

function meanBase(side: RoleGameSide): number | null {
  if (side.members.length === 0 || side.members.some((member) => member.base === null || !Number.isFinite(member.base))) return null;
  return side.members.reduce((acc, member) => acc + (member.base as number), 0) / side.members.length;
}

/**
 * The evidence of one team's players: every record in which `teamOf(seasonIndex)` is a side.
 * `before`: epoch seconds of the match day's start (JST) — anything at or after it is dropped.
 */
export function aggregateRoleEvidence(
  records: readonly RoleGameRecord[],
  teamOf: (seasonIndex: number) => string | null,
  options: { before: number | null; leagueMean: number; weights?: readonly number[] },
): RoleHistoryResult {
  const weights = options.weights ?? RECENCY_WEIGHTS;
  const evidence: Record<string, RoleEvidence> = {};
  let games = 0;
  let droppedFuture = 0;
  const seen = new Set<string>();
  for (const record of records) {
    const teamId = teamOf(record.seasonIndex);
    if (!teamId) continue;
    const index = record.sides.findIndex((side) => side.teamId === teamId);
    if (index < 0) continue;
    const dedupe = `${record.seasonIndex}:${record.gameId}`;
    if (seen.has(dedupe)) continue;
    seen.add(dedupe);
    if (options.before !== null && (record.startTime === null || record.startTime >= options.before)) {
      droppedFuture += 1;
      continue;
    }
    const ours = record.sides[index];
    const theirs = record.sides[1 - index];
    const k = ours.members.length;
    const base = meanBase(ours);
    if (k === 0 || base === null) continue;
    const legs = Math.max(1, ours.legsWon + theirs.legsWon);
    const recency = recencyWeight(record.seasonIndex, weights);
    if (recency <= 0) continue;
    const role = roleKeyFromParts(record.structure, record.family);
    let residual: number | null = null;
    let weight = (recency * legs) / k;
    if (record.family === '01') {
      if (ours.darts !== null && ours.darts > 0 && ours.score !== null && ours.score >= 0) {
        residual = (3 * ours.score) / ours.darts - base;
      }
    } else {
      const opponent = meanBase(theirs) ?? options.leagueMean;
      const legsToWin = Math.max(1, ours.legsWon, theirs.legsWon);
      const expected = gameWinProbability(base, opponent, { legsToWin, cricket: record.family === 'CRICKET' }, CRICKET_LEG_K);
      const won = ours.legsWon > theirs.legsWon ? 1 : ours.legsWon < theirs.legsWon ? 0 : 0.5;
      const slope = CRICKET_LEG_K * Math.max(0.05, expected * (1 - expected));
      residual = Math.max(-OUTCOME_RESIDUAL_CAP, Math.min(OUTCOME_RESIDUAL_CAP, (won - expected) / slope));
      weight *= OUTCOME_EVIDENCE_FACTOR;
    }
    if (residual === null || !Number.isFinite(residual)) continue;
    games += 1;
    for (const member of ours.members) add(evidence, member.key, role, weight, residual);
  }
  return { evidence, games, droppedFuture };
}

/** Epoch seconds of 00:00 JST on a `YYYY-MM-DD` day (`null` for anything else). */
export function jstDayStart(date: string | null | undefined): number | null {
  if (!date || !/^\d{4}-\d{2}-\d{2}$/u.test(date)) return null;
  const ms = Date.parse(`${date}T00:00:00+09:00`);
  return Number.isFinite(ms) ? Math.floor(ms / 1000) : null;
}
