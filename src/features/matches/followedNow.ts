import type { GameRow } from './parse';

/**
 * 注目選手 (登録した選手名) が出場中の試合を、n01 で進行中の試合 (`MatchesApi.nowLive`、
 * 開始の新しい 100 試合) から探す。以前の一覧「いま n01 で進行中」と観戦の「注目選手の試合」が共有する。
 *
 * 照合は名前だけ: 各側の名前と、チーム戦・ダブルスのメンバー名 (前後の空白を除く)。同姓同名は区別できない。
 */

/** この試合に出ている注目選手の名前 (試合の中で 1 回ずつ)。 */
export function followedNamesIn(row: GameRow, followed: ReadonlySet<string>): string[] {
  const names = row.sides.flatMap((side) => [side.name, ...side.members.map((member) => member.name)]).map((name) => name.trim());
  return [...new Set(names)].filter((name) => followed.has(name));
}

export interface FollowedGame {
  row: GameRow;
  names: string[];
}

/** 注目選手が出ている試合だけを、n01 の並び (開始の新しい順) のまま。 */
export function followedGames(rows: readonly GameRow[], followed: ReadonlySet<string>): FollowedGame[] {
  if (followed.size === 0) return [];
  return rows.map((row) => ({ row, names: followedNamesIn(row, followed) })).filter((entry) => entry.names.length > 0);
}

export type NowKind = 'league' | 'tournament' | 'single';

/** `tmid` (`<tdid>_<ttype>_…`) から読める大会の ID。大会・リーグに属さない試合は `null`。 */
export function competitionOf(row: GameRow): string | null {
  const tdid = row.tmid?.split('_').slice(0, 3).join('_') ?? null;
  return tdid && /^t_[A-Za-z0-9]+_\d+$/u.test(tdid) ? tdid : null;
}

/** リーグ戦 (`_lg_` のカード)・大会・個別の試合 (n01 Online / Live など) のどれか。 */
export function nowKind(row: GameRow): NowKind {
  const tdid = competitionOf(row);
  if (!tdid) return 'single';
  return row.tmid!.startsWith(`${tdid}_lg_`) ? 'league' : 'tournament';
}

export const NOW_KIND_LABEL: Readonly<Record<NowKind, string>> = { league: 'リーグ', tournament: '大会', single: '個別の試合' };
