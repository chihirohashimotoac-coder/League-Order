import type { HighInRecord } from './api/parse';
import { slotFamily, slotFor } from './gameKind';
import type { SlotEvidence } from './gameKind';
import type { ClassifiedGame } from './roleGames';
import type { SeasonData } from './seasonData';

/**
 * Is a doubles 01 game played **double-in**? n01 has no field for the in-rule (neither the
 * schedule slot, nor `match/get`, nor the API manual), so the verdict needs two independent
 * pieces of evidence, and a slot without both is "unknown" — never assumed:
 *
 * 1. The league is one whose doubles the organisers' rules make double-in ({@link DOUBLE_IN_LEAGUES}).
 *    A league is never matched by its name.
 * 2. The season's own public n01 records agree, slot by slot (`tournament/stats?kind=player_high_in`):
 *    n01 keeps "high in" records only where an in-rule is set. Read 2026-11-15:
 *      - ATDO 2026 3rd / 2nd, TDO 2026/3rd / 2nd, TDA 2026 前期 / 中期: records in the doubles
 *        slots only (from 19 to 143 per slot), none in any singles or team slot, highest 160–170
 *        (the double-in maximum is 170 = D-BULL T20 T20; a straight-in first visit reaches 180);
 *      - ATDO 2024 2nd: records in its doubles slot `rdsi` only (19, highest 156).
 *    So a doubles slot counts when it has at least one record, every record of the season is in
 *    1–170, and no record sits in a schedule slot that is not a doubles slot (records of a schid
 *    outside the schedule — TDA 2026 前期 has two, of its play-off — are ignored).
 * The records are evidence of the rule only: attempts and successes are never taken from them.
 */

export interface DoubleInLeague {
  leagueId: string;
  name: string;
  basis: string;
}

/** Leagues whose doubles are double-in by their rules (the user's statement, 2026-11-15). Matched by id only. */
export const DOUBLE_IN_LEAGUES: readonly DoubleInLeague[] = [
  { leagueId: 'lg_l3hI_3397', name: 'ATDO DARTS LEAGUE', basis: 'ダブルスはダブルイン（主催の規則。利用者の確認 2026-11-15）' },
  { leagueId: 'lg_3qgW_6619', name: '東京ダーツオーガニゼイション（TDO）', basis: 'ダブルスはダブルイン（主催の規則。利用者の確認 2026-11-15）' },
  { leagueId: 'lg_Ev9v_7379', name: '東京ダーツ協会（TDA）', basis: 'ダブルスはダブルイン（主催の規則。利用者の確認 2026-11-15）' },
];

/** The highest score a double-in first visit can make (D-BULL, T20, T20). */
export const DOUBLE_IN_MAX = 170;

export type StartRuleVerdict = { rule: 'double-in'; basis: string } | { rule: 'straight-in'; basis: string } | { rule: 'unknown'; reason: string };

export function declaredLeague(leagueId: string | null, leagues: readonly DoubleInLeague[] = DOUBLE_IN_LEAGUES): DoubleInLeague | null {
  return leagueId ? (leagues.find((l) => l.leagueId === leagueId) ?? null) : null;
}

/** What the season's high-in records say, slot by slot (`null` records: not available). */
export interface HighInEvidence {
  /** Records per schid (`null` schid is dropped). */
  bySlot: Map<string, { count: number; max: number }>;
  /** Why the records cannot support any slot of the season (`null` when they can). */
  contradiction: string | null;
}

export function highInEvidence(slots: readonly SlotEvidence[], records: readonly HighInRecord[]): HighInEvidence {
  const bySlot = new Map<string, { count: number; max: number }>();
  let contradiction: string | null = null;
  for (const r of records) {
    if (r.highIn === null || r.highIn <= 0 || r.highIn > DOUBLE_IN_MAX) {
      contradiction = `n01のハイイン記録に${r.highIn ?? '不明'}点があり、ダブルインの記録と確認できません`;
      continue;
    }
    if (!r.schid) continue;
    const slot = slots.find((s) => s.schid === r.schid) ?? null;
    if (slot && slot.numPart !== 2) contradiction = `ダブルス以外の枠（${slot.subtitle ?? slot.schid}）にハイイン記録があり、記録の意味を確認できません`;
    const entry = bySlot.get(r.schid) ?? { count: 0, max: 0 };
    entry.count += 1;
    entry.max = Math.max(entry.max, r.highIn);
    bySlot.set(r.schid, entry);
  }
  return { bySlot, contradiction };
}

/**
 * The verdict for one classified game. `highIns` is `null` when the season's records could not
 * be read (the slot is then unknown, not assumed).
 */
export function gameStartRule(
  season: Pick<SeasonData, 'leagueId' | 'slots'>,
  game: Pick<ClassifiedGame, 'schid' | 'division' | 'family' | 'role'>,
  highIns: HighInEvidence | null,
  leagues: readonly DoubleInLeague[] = DOUBLE_IN_LEAGUES,
): StartRuleVerdict {
  if (game.family.family !== '01' || game.role !== 'doubles') return { rule: 'unknown', reason: 'ダブルス01のゲームではありません' };
  const league = declaredLeague(season.leagueId, leagues);
  if (!league) return { rule: 'unknown', reason: 'このリーグのダブルスのイン規則を確認できていません' };
  const slot = slotFor(season.slots, game.schid, game.division);
  if (!slot || slot.numPart !== 2 || slotFamily(slot).family !== '01' || slot.startScore === null || slot.startScore <= 0) {
    return { rule: 'unknown', reason: 'ゲーム枠の設定（ダブルス・01・開始点数）を確認できません' };
  }
  if (!highIns) return { rule: 'unknown', reason: 'この季のn01ハイイン記録を取得できず、枠のイン規則を確認できません' };
  if (highIns.contradiction) return { rule: 'unknown', reason: highIns.contradiction };
  const evidence = highIns.bySlot.get(slot.schid);
  if (!evidence) return { rule: 'unknown', reason: `この季の「${slot.subtitle ?? slot.schid}」にn01のハイイン記録がなく、ダブルインと確認できません` };
  return { rule: 'double-in', basis: `${league.basis}。この季の「${slot.subtitle ?? slot.schid}」にn01のハイイン記録 ${evidence.count}件（最高 ${evidence.max}点）` };
}
