import type { HighInRecord } from './api/parse';
import { slotFamily, slotFor } from './gameKind';
import type { ClassifiedGame } from './roleGames';
import type { SeasonData } from './seasonData';

/**
 * Is a doubles 01 game played **double-in**? In order of evidence:
 *
 * 1. An explicit setting of the match or the leg. n01 has none: neither the schedule slot, nor
 *    `match/get`, `match/throws`, nor the API manual (read 2026-11-15) carries an in-rule.
 * 2. The organiser's rule, for a league identified by its **id** and a **scope** that was checked:
 *    {@link DOUBLE_IN_RULES}. A league is never matched by its name, and a season before the
 *    checked range (or one whose date is unknown) is out of scope.
 * 3. Otherwise "unknown" — never assumed double-in, never straight-in turned into double-in.
 *
 * n01's high-in records (`tournament/stats?kind=player_high_in`) are not needed for a verdict:
 * a season's first weeks have none, and the request can fail. They only cross-check what they
 * can cover — the same slot (a record no double-in start can make, above 170 or not positive,
 * puts that slot out) and the same leg of a game (`seasonStartOf` in `detailService.ts`).
 * Records of other slots never exclude a slot the rule covers. Attempts and successes are
 * never taken from them.
 */

export interface DoubleInRule {
  leagueId: string;
  name: string;
  /** Seasons in scope: league seasons that start at or after this time (epoch ms). */
  fromStartedAt: number;
  /** The first season of the checked range, for the details panel. */
  fromSeason: string;
  /** Where the rule comes from, and what of it was read. */
  source: string;
}

/**
 * Leagues whose doubles 01 games are double-in by the organiser's rule (the user's statement,
 * 2026-11-15: ATDO, TDO, TDA — "JDO 団体や TDA もダブルスはダブルイン"). The rule texts
 * (TDO RuleBook 第8条 on www.tokyodarts.org, TDA「ルールとマナー」on tdaofficial180.wixsite.com)
 * could not be read from this environment (blocked by its network policy).
 *
 * Scope = the regular league seasons whose public n01 records were checked on 2026-11-15
 * (docs/ANALYTICS_ROLES.md §8), from the first of them onward — the organisers' rule covers the
 * seasons still to come, which is why a new season counts before it has any high-in record.
 * Each season starts at its own `startedAt` (t_date / start date / createTime, as n01's league
 * list gives it); the bounds below are the first checked seasons' `createTime`.
 */
export const DOUBLE_IN_RULES: readonly DoubleInRule[] = [
  {
    leagueId: 'lg_l3hI_3397',
    name: 'ATDO DARTS LEAGUE',
    fromStartedAt: 1_680_417_958_000,
    fromSeason: '2023 ATDO DARTS LEAGUE 1st（t_on2l_8357）',
    source: 'ダブルスはダブルイン（主催の規則として利用者が確認、2026-11-15）。2023 1st〜2026 3rd の通常シーズン14季で、n01のハイイン記録がダブルスの枠だけにあり最高160点',
  },
  {
    leagueId: 'lg_3qgW_6619',
    name: '東京ダーツオーガニゼイション（TDO）',
    fromStartedAt: 1_751_045_325_000,
    fromSeason: 'TDO 2025-2nd Season（t_sJo6_5442）',
    source: 'ダブルスはダブルイン（TDOリーグ競技規則 第8条。本文はこの環境から取得できず未読。利用者の確認、2026-11-15）。2025-2nd〜2026/3rd の通常シーズン5季で、ハイイン記録がダブルスの枠だけにあり最高170点',
  },
  {
    leagueId: 'lg_Ev9v_7379',
    name: '東京ダーツ協会（TDA）',
    fromStartedAt: 1_699_879_474_000,
    fromSeason: '2023年度 後期リーグ戦（t_UlDS_4948）',
    source: 'ダブルスはダブルイン（TDA公式「ルールとマナー」のリーグ戦のゲーム構成。本文はこの環境から取得できず未読。利用者の確認、2026-11-15）。2023年度後期〜2026年度中期の通常シーズン8季で、ハイイン記録がダブルスの枠だけにあり最高170点',
  },
];

/** The highest score a double-in first visit can make (D-BULL, T20, T20). */
export const DOUBLE_IN_MAX = 170;

export type StartRuleVerdict = { rule: 'double-in'; basis: string } | { rule: 'straight-in'; basis: string } | { rule: 'unknown'; reason: string };

export function declaredLeague(leagueId: string | null, rules: readonly DoubleInRule[] = DOUBLE_IN_RULES): DoubleInRule | null {
  return leagueId ? (rules.find((r) => r.leagueId === leagueId) ?? null) : null;
}

/** The organiser's rule that covers this season, or why none does. */
export function seasonRule(season: Pick<SeasonData, 'leagueId' | 'startedAt'>, rules: readonly DoubleInRule[] = DOUBLE_IN_RULES): { rule: DoubleInRule } | { reason: string } {
  const rule = declaredLeague(season.leagueId, rules);
  if (!rule) return { reason: 'このリーグのダブルスのイン規則を確認できていません' };
  if (typeof season.startedAt !== 'number') return { reason: 'シーズンの開始日を確認できず、主催者規則の対象範囲か判断できません' };
  if (season.startedAt < rule.fromStartedAt) return { reason: `主催者規則を確認した範囲（${rule.fromSeason}以降）より前のシーズンです` };
  return { rule };
}

/** n01's high-in records of a season, per slot (`null`: not read). */
export interface HighInEvidence {
  bySlot: Map<string, { count: number; max: number; impossible: number }>;
}

export function highInEvidence(records: readonly HighInRecord[]): HighInEvidence {
  const bySlot = new Map<string, { count: number; max: number; impossible: number }>();
  for (const r of records) {
    if (!r.schid) continue;
    const entry = bySlot.get(r.schid) ?? { count: 0, max: 0, impossible: 0 };
    entry.count += 1;
    if (r.highIn === null || r.highIn <= 0 || r.highIn > DOUBLE_IN_MAX) entry.impossible += 1;
    else entry.max = Math.max(entry.max, r.highIn);
    bySlot.set(r.schid, entry);
  }
  return { bySlot };
}

/**
 * The verdict for one classified game. `highIns` is `null` when the season's records were not
 * read: that only removes the cross-check, never the verdict.
 */
export function gameStartRule(
  season: Pick<SeasonData, 'leagueId' | 'slots' | 'startedAt'>,
  game: Pick<ClassifiedGame, 'schid' | 'division' | 'family' | 'role'>,
  highIns: HighInEvidence | null,
  rules: readonly DoubleInRule[] = DOUBLE_IN_RULES,
): StartRuleVerdict {
  if (game.family.family !== '01' || game.role !== 'doubles') return { rule: 'unknown', reason: 'ダブルス01のゲームではありません' };
  const covered = seasonRule(season, rules);
  if ('reason' in covered) return { rule: 'unknown', reason: covered.reason };
  const slot = slotFor(season.slots, game.schid, game.division);
  if (!slot || slot.numPart !== 2 || slotFamily(slot).family !== '01' || slot.startScore === null || slot.startScore <= 0) {
    return { rule: 'unknown', reason: 'ゲーム枠の設定（ダブルス・01・開始点数）を確認できません' };
  }
  const label = slot.subtitle ?? slot.schid;
  const records = highIns?.bySlot.get(slot.schid);
  if (records && records.impossible > 0) {
    return { rule: 'unknown', reason: `「${label}」にダブルインでは出ない点数のハイイン記録が${records.impossible}件あり、この枠のイン規則を確認できません` };
  }
  const evidence = !highIns ? 'この季のハイイン記録は取得できず、枠の照合はしていません' : records ? `この季の「${label}」のハイイン記録 ${records.count}件（最高 ${records.max}点）と矛盾なし` : `この季の「${label}」にハイイン記録はまだありません`;
  return { rule: 'double-in', basis: `${covered.rule.name}: ${covered.rule.source}。${evidence}` };
}
