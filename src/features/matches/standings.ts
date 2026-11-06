import type { OfficialStandingGroup } from '../analytics/types';
import type { MatchCard } from './cards';
import type { PointRule } from './parse';

/**
 * Standings what-if (順位シミュレーション).
 *
 * The official table is n01's (`tournament/standings`) and is shown as it is. A what-if is
 * offered only when League Order can reproduce n01's points *exactly* from the official card
 * results with the season's own rule (`lg_setting`):
 *
 *   points = win × W + draw × D + loss × L (+ games won, when `include_set` is on)
 *
 * for every team of the division. Anything the formula cannot see — manual points, per-game
 * points, a leg-based rule — or any team whose points differ, and the what-if is withheld
 * with the reason. Ties after the what-if are shown as ties: n01's tie-breakers
 * (Buchholz, game / leg difference, head-to-head) are not re-implemented.
 */

export interface ReproductionCheck {
  ok: boolean;
  reason: string | null;
  /** Teams whose computed points differ from n01's. */
  mismatches: { teamId: string; official: number; computed: number }[];
}

export function cardPoints(rule: PointRule, mine: number, theirs: number): number | null {
  const base = mine > theirs ? rule.win : mine < theirs ? rule.loss : rule.draw;
  if (base === null) return null;
  return base + (rule.includeGames ? mine : 0);
}

/** Official points computed from the official card results of a division. */
export function computedPoints(rule: PointRule, cards: readonly MatchCard[]): Map<string, number> | null {
  const points = new Map<string, number>();
  for (const card of cards) {
    if (!card.official) continue;
    for (const side of [0, 1] as const) {
      const value = cardPoints(rule, card.official[side], card.official[1 - side]);
      if (value === null) return null;
      points.set(card.teams[side].id, (points.get(card.teams[side].id) ?? 0) + value);
    }
  }
  return points;
}

export function checkReproduction(rule: PointRule, group: OfficialStandingGroup, cards: readonly MatchCard[]): ReproductionCheck {
  const fail = (reason: string): ReproductionCheck => ({ ok: false, reason, mismatches: [] });
  if (rule.win === null || rule.loss === null || rule.draw === null) return fail('勝ち点の設定 (勝ち・引き分け・負け) を n01 から読めませんでした。');
  if (rule.includeLegs) return fail('この大会は Leg 数を勝ち点に含めるため、対戦結果だけでは勝ち点を再現できません。');
  if (rule.extras.manualPoints) return fail('管理者が手動で加えた勝ち点があるため、再現できません。');
  if (rule.extras.gamePoints || rule.extras.ptSetting) return fail('ゲームごとの加点があるため、再現できません。');
  const computed = computedPoints(rule, cards);
  if (!computed) return fail('勝ち点を計算できませんでした。');
  const mismatches = group.rows
    .filter((row) => row.rank > 0 || row.played > 0)
    .map((row) => ({ teamId: row.teamId, official: row.points, computed: computed.get(row.teamId) ?? 0 }))
    .filter((row) => row.official !== row.computed);
  if (mismatches.length > 0) {
    return { ok: false, reason: `${mismatches.length} チームで n01 の公式勝ち点と計算結果が一致しないため、シミュレーションを表示しません。`, mismatches };
  }
  return { ok: true, reason: null, mismatches: [] };
}

export interface ProjectedRow {
  teamId: string;
  name: string;
  officialPoints: number;
  projectedPoints: number;
  officialRank: number;
  /** Position by points after the what-if; tied teams share the best position. */
  projectedPosition: number;
  tied: boolean;
}

/** The division after `card` ends `score` (card side order). Only call after `checkReproduction` passed. */
export function projectStandings(rule: PointRule, group: OfficialStandingGroup, card: MatchCard, score: [number, number]): ProjectedRow[] {
  const add = new Map<string, number>();
  for (const side of [0, 1] as const) add.set(card.teams[side].id, cardPoints(rule, score[side], score[1 - side]) ?? 0);
  const rows = group.rows.map((row) => ({
    teamId: row.teamId,
    name: row.name,
    officialPoints: row.points,
    projectedPoints: row.points + (add.get(row.teamId) ?? 0),
    officialRank: row.rank,
  }));
  return rows
    .sort((a, b) => b.projectedPoints - a.projectedPoints)
    .map((row, _, all) => {
      const better = all.filter((other) => other.projectedPoints > row.projectedPoints).length;
      const tied = all.filter((other) => other.projectedPoints === row.projectedPoints).length > 1;
      return { ...row, projectedPosition: better + 1, tied };
    });
}

/** The division if every listed card ended as given (card side order). Only after `checkReproduction` passed. */
export function projectMany(rule: PointRule, group: OfficialStandingGroup, results: readonly { card: MatchCard; score: [number, number] }[]): ProjectedRow[] {
  const add = new Map<string, number>();
  for (const { card, score } of results) {
    for (const side of [0, 1] as const) {
      const id = card.teams[side].id;
      add.set(id, (add.get(id) ?? 0) + (cardPoints(rule, score[side], score[1 - side]) ?? 0));
    }
  }
  const rows = group.rows.map((row) => ({
    teamId: row.teamId,
    name: row.name,
    officialPoints: row.points,
    projectedPoints: row.points + (add.get(row.teamId) ?? 0),
    officialRank: row.rank,
  }));
  return rows
    .sort((a, b) => b.projectedPoints - a.projectedPoints)
    .map((row, _, all) => ({
      ...row,
      projectedPosition: all.filter((other) => other.projectedPoints > row.projectedPoints).length + 1,
      tied: all.filter((other) => other.projectedPoints === row.projectedPoints).length > 1,
    }));
}
