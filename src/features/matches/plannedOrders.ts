import type { CardOrder, CardOrderMember } from './parse';
import { fixtureDate } from './parse';
import { jstToday } from '../../integrations/n01/scheduleResolver';

/**
 * 開始前のオーダー (予定). n01 の `team/order/list` (manual §4.9: (tmid, tpid, schid) ごとに 1 件、
 * `fix` = 1 で確定済み) を、1 つの対戦カードのゲームごとの「予定の出場者」に直す。
 *
 * 予定は実績ではない。ここで作るものは画面に「予定」として出すだけで、`MatchCard.games` の
 * `members` (実際の出場者) にも、勝敗・スタッツ・出場回数の集計にも入れない。
 *
 * 公開の条件 (League Order の判断。n01 の公式仕様に明記はない):
 * - 選手名を出すのは、そのゲームの **両チームの行がともに `fix` = 1** のときだけ。n01 の
 *   キャプテン画面は相手の確定まで相手のオーダーを見せない (「相手チームのオーダーが確定するまで
 *   お待ちください」) ので、片方だけ確定の間は、確定した側の名前も出さない (相手が先に見られない)。
 * - `fix` = 0 の行は、n01 が名前を返しても出さない (2026-11-27、AKDO で `fix` 0 に名前が入った行を確認)。
 * - `fix` が 0 / 1 以外 (横浜地区で 2 を確認、意味は未確認) は「確定状態を確認できない」として名前を出さない。
 * - 行は `tmid` (このカード)・`tpid` (このカードの 2 チーム)・`schid` (このカードのゲーム枠) が
 *   すべて一致するものだけを使う。名前だけで別のカード・チームの行と結び付けない。
 * - 同じチーム・ゲーム枠の行が 2 件以上あれば、どちらが正しいか分からないので、そのゲームは表示しない。
 */

/**
 * The `tmid` n01 gives a league card: `<tdid>_lg_<division>_<lsid>_<tpid>_<tpid>`, the two team
 * ids in code-unit order (not the fixture's home / away order). Checked against every card of
 * ATDO 2026 3rd (82 cards, 41 of them listed the other way round in the fixture) on 2026-11-27.
 * Used only for a card no game row has named yet; a game row's own `tmid` is preferred.
 */
export function leagueCardTmid(tournamentId: string, divisionIndex: number, lsid: string, teamIds: readonly [string, string]): string {
  const [a, b] = [...teamIds].sort((x, y) => (x < y ? -1 : x > y ? 1 : 0));
  return `${tournamentId}_lg_${divisionIndex}_${lsid}_${a}_${b}`;
}

export type SideOrderState = 'fixed' | 'unfixed' | 'unknownFix' | 'none' | 'duplicate';

export interface SideOrder {
  state: SideOrderState;
  /** The members in n01's order — only when the game's orders are published (both sides fixed). */
  members: CardOrderMember[] | null;
}

/**
 * - `published`: both teams' orders of the game are confirmed (`fix` 1): names are shown.
 * - `oneSide`: one team confirmed, the other not (or no row): waiting, no names.
 * - `unfixed`: rows exist, none confirmed.
 * - `unknown`: a row's `fix` is neither 0 nor 1 and nothing is confirmed on both sides.
 * - `none`: n01 returned no order for the game (not submitted, or not public — not told apart).
 * - `invalid`: n01 returned the same team's order of the game twice.
 */
export type PlannedState = 'published' | 'oneSide' | 'unfixed' | 'unknown' | 'none' | 'invalid';

export interface PlannedGame {
  schid: string;
  state: PlannedState;
  /** Card side order (`teams[0]`, `teams[1]`), never n01's row order. */
  sides: [SideOrder, SideOrder];
}

export interface PlannedCard {
  tmid: string;
  games: Map<string, PlannedGame>;
  /** Rows left out: another card, a team not in the card, a game not in its schedule. */
  ignored: number;
}

export function planCard(rows: readonly CardOrder[], card: { tmid: string; teamIds: readonly [string, string]; schids: readonly string[] }): PlannedCard {
  const schids = new Set(card.schids);
  const byKey = new Map<string, CardOrder[]>();
  let ignored = 0;
  for (const row of rows) {
    const side = row.teamId === card.teamIds[0] ? 0 : row.teamId === card.teamIds[1] ? 1 : null;
    if (row.tmid !== card.tmid || side === null || !schids.has(row.schid) || card.teamIds[0] === card.teamIds[1]) {
      ignored += 1;
      continue;
    }
    const key = `${side}:${row.schid}`;
    byKey.set(key, [...(byKey.get(key) ?? []), row]);
  }
  const games = new Map<string, PlannedGame>();
  for (const schid of card.schids) {
    const rowsOf = (side: 0 | 1): CardOrder[] => byKey.get(`${side}:${schid}`) ?? [];
    const stateOf = (list: readonly CardOrder[]): SideOrderState =>
      list.length === 0 ? 'none' : list.length > 1 ? 'duplicate' : list[0].fix === 1 ? 'fixed' : list[0].fix === 0 ? 'unfixed' : 'unknownFix';
    const states = [stateOf(rowsOf(0)), stateOf(rowsOf(1))] as const;
    const state: PlannedState = states.includes('duplicate')
      ? 'invalid'
      : states[0] === 'fixed' && states[1] === 'fixed'
        ? 'published'
        : states.includes('fixed')
          ? 'oneSide'
          : states.includes('unknownFix')
            ? 'unknown'
            : states.includes('unfixed')
              ? 'unfixed'
              : 'none';
    const side = (index: 0 | 1): SideOrder => ({
      state: states[index],
      members: state === 'published' ? rowsOf(index)[0].entries.map((entry) => ({ ...entry })) : null,
    });
    games.set(schid, { schid, state, sides: [side(0), side(1)] });
  }
  return { tmid: card.tmid, games, ignored };
}

/** What a game chip and the detail say about the planned order, including the read itself. */
export type PlanStatus = PlannedState | 'loading' | 'error';

/** The few characters a game chip has room for (the detail says it in full). */
export const PLAN_SHORT: Record<PlanStatus, string> = {
  published: '予定',
  oneSide: '未確定',
  unfixed: '未確定',
  unknown: '未確定',
  none: '—',
  invalid: '—',
  loading: '…',
  error: '失敗',
};

export const PLAN_TEXT: Record<PlanStatus, string> = {
  published: 'オーダー確定済み (両チーム)',
  oneSide: '片方のチームのみ確定 (選手名は両チームの確定後に表示)',
  unfixed: 'オーダー未確定',
  unknown: 'オーダーの確定状態を確認できません',
  none: 'n01 に公開されたオーダーはありません',
  invalid: 'n01 の応答に同じゲームのオーダーが重複していたため表示しません',
  loading: 'オーダーを取得中…',
  error: 'オーダーを取得できませんでした',
};

/** True when a fixture's title names today's date (JST, n01 is a Japanese service). A title without a date is never today. */
export function isFixtureToday(title: string, now: number): boolean {
  const date = fixtureDate(title);
  if (!date) return false;
  const today = jstToday(now);
  const [year, month, day] = today.split('-').map(Number);
  const iso = /(\d{4})-(\d{1,2})-(\d{1,2})/u.exec(title);
  if (iso && Number(iso[1]) !== year) return false;
  return date.month === month && date.day === day;
}
