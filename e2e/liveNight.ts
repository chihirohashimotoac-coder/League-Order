import type { Page } from '@playwright/test';
import { N01_API_BASE_URL } from '../src/integrations/n01/endpoints';
import { TDID, c001Rows, fixtures, gameRow, list, liveBody, side, tournamentDoc } from '../src/features/matches/testFixtures';

/**
 * A league night in full swing (canned n01, no network): two cards in progress. Card c003
 * (Arrows – Corks) has three games finished and Singles 1 in its third leg (1-1); card c004
 * (Bulls – Doubles) is in Doubles 1. Every game answers `match/throws` with its own legs, so a
 * test can tell one game's (and one leg's) score sheet from another's.
 *
 * `JDO_LEAGUE` is a league whose only event is a knockout tournament (no league table), the way
 * JDO keeps its open tournaments on n01 (shape checked against n01 on 2026-11-10).
 */
export const JDO_LEAGUE = 'lg_Jdo0_0001';
export const JDO_EVENT = 't_Jdo0_0001';
type Throw = { p: 0 | 1; r: number; score: number; left: number; darts?: number; finish?: number };

function leg(index: number, first: 0 | 1, scores: [number[], number[]], winner: 0 | 1 | null, start = 501): { leg: number; first: number; end: number; winner: number | null; darts: [number, number]; start: [number, number]; left: [number, number]; throws: Throw[] } {
  const left: [number, number] = [start, start];
  const throws: Throw[] = [];
  const rounds = Math.max(scores[0].length, scores[1].length);
  for (let r = 0; r < rounds; r += 1) {
    for (const p of first === 0 ? ([0, 1] as const) : ([1, 0] as const)) {
      const score = scores[p][r];
      if (score === undefined) continue;
      left[p] -= score;
      const done = left[p] === 0;
      throws.push({ p, r: r + 1, score, left: left[p], darts: done ? 2 : 3, ...(done ? { finish: 1 } : {}) });
    }
  }
  return { leg: index, first, end: winner === null ? 0 : 1, winner, darts: [scores[0].length * 3, scores[1].length * 3], start: [start, start], left, throws };
}

const SG01 = [
  leg(0, 0, [[100, 140, 60, 100, 61, 40], [60, 81, 45, 100, 60]], 0),
  leg(1, 1, [[45, 60, 85, 41, 100], [140, 100, 95, 100, 34, 32]], 1),
];
const SG01_LIVE = leg(2, 0, [[60, 100, 140, 81], [85, 60, 100]], null);
const GAMES: Record<string, ReturnType<typeof leg>[]> = {
  c003_tm01: [leg(0, 0, [[100, 85, 140, 60, 100, 95, 121, 100, 60, 100, 40], [60, 60, 81, 100, 45, 60, 100, 85, 41, 60]], 0, 1001)],
  c003_db01: [leg(0, 0, [[60, 45, 81, 60, 100], [100, 100, 81, 140, 48, 32]], 1), leg(1, 1, [[100, 140, 100, 121, 40], [60, 60, 45, 100]], 0), leg(2, 0, [[45, 60, 60, 81, 60], [100, 60, 140, 100, 61, 40]], 1)],
  c003_sg01: SG01,
  c004_tm01: [leg(0, 1, [[60, 60, 81, 100, 45, 60, 100, 85, 41, 60], [100, 85, 140, 60, 100, 95, 121, 100, 60, 100, 40]], 1, 1001)],
};

const today = (): unknown[] => [
  gameRow('c003', 'AAAA', 'CCCC', 'tm01', [side('AAAA', [['a1', '青木 一郎'], ['a2', '井上 次郎'], ['a3', '上田 三郎'], ['a4', '遠藤 四郎']], 1, 1001, 33), side('CCCC', [['c1', '加藤 健'], ['c2', '木村 守'], ['c3', '工藤 仁'], ['c4', '小林 学']], 0, 692, 30)], { start: 1_800_000_000, mid: 'c003_tm01' }),
  gameRow('c003', 'AAAA', 'CCCC', 'db01', [side('AAAA', [['a1', '青木 一郎'], ['a2', '井上 次郎']], 1, 1153, 45), side('CCCC', [['c1', '加藤 健'], ['c2', '木村 守']], 2, 1267, 48)], { start: 1_800_000_900, mid: 'c003_db01' }),
  gameRow('c003', 'AAAA', 'CCCC', 'db02', [side('AAAA', [['a3', '上田 三郎'], ['a4', '遠藤 四郎']], 2, 0, 90, 190), side('CCCC', [['c3', '工藤 仁'], ['c4', '小林 学']], 0, 0, 90, 150)], { start: 1_800_001_800, mid: 'c003_db02' }),
  gameRow('c003', 'AAAA', 'CCCC', 'sg01', [side('AAAA', [['a1', '青木 一郎']], 1, 1213, 60), side('CCCC', [['c1', '加藤 健']], 1, 1092, 57)], { start: 1_800_002_700, finished: false, mid: 'c003_sg01' }),
  gameRow('c004', 'BBBB', 'DDDD', 'tm01', [side('BBBB', [['b1', '佐藤 B1'], ['b2', '鈴木 B2'], ['b3', '瀬川 B3'], ['b4', '曽根 B4']], 0, 692, 30), side('DDDD', [['d1', '田中 D1'], ['d2', '千葉 D2'], ['d3', '津田 D3'], ['d4', '寺田 D4']], 1, 1001, 33)], { start: 1_800_000_100, mid: 'c004_tm01' }),
  gameRow('c004', 'BBBB', 'DDDD', 'db01', [side('BBBB', [['b1', '佐藤 B1'], ['b2', '鈴木 B2']], 0, 300, 18), side('DDDD', [['d1', '田中 D1'], ['d2', '千葉 D2']], 1, 501, 18)], { start: 1_800_001_000, finished: false, mid: 'c004_db01' }),
];

export interface NightOptions {
  /**
   * True once Singles 1 has ended and Singles 2 has started — as `match/live` says it. The
   * game list (today's board) is left as it was: it is read less often than the live game, so
   * for a few seconds it still calls Singles 1 unfinished and does not hold Singles 2.
   */
  nextGameStarted?: () => boolean;
}

export async function serveNight(page: Page, options: NightOptions = {}): Promise<string[]> {
  const log: string[] = [];
  const c001 = c001Rows().map((row) => ({ ...(row as object), tmid: `${TDID}_lg_0_c001_AAAA_BBBB` }));
  await page.route(`${N01_API_BASE_URL}/**`, async (route) => {
    const url = new URL(route.request().url());
    const operation = url.pathname.replace(/^.*\/api\/v1\//u, '');
    const q = url.searchParams;
    log.push(`${operation}?${q.toString()}`);
    let body: unknown = null;
    if (operation === 'league/list') body = { result: 0, list: [{ lgid: JDO_LEAGUE, title: '【JDO2026】 Sample Open Darts Tournament' }] };
    else if (operation === 'tournament/list') body = { result: 0, list: [] };
    else if (operation === 'league/tournament/list' && q.get('lgid') === JDO_LEAGUE) body = { result: 0, league: { lgid: JDO_LEAGUE, title: 'JDO Open' }, list: [{ tdid: JDO_EVENT, title: 'Sample Open メンズシングルス', status: 30, t_date: 1_800_000_000, createTime: 1_790_000_000 }] };
    else if (operation === 'tournament/get' && q.get('tdid') === JDO_EVENT)
      body = { result: 0, url: `https://n01darts.com/n01/league/season.php?id=${JDO_EVENT}`, tournament: { tdid: JDO_EVENT, lgid: JDO_LEAGUE, title: 'Sample Open メンズシングルス', status: 30, team_games: 0, league: 1, entry_list: [{ tpid: 'p1', name: '山田 太郎' }, { tpid: 'p2', name: '田中 花子' }], t_setting: { tournament: 1 }, t_table: [['p1', 'p2'], ['p1']] } };
    else if (operation === 'league/schedule/get' && q.get('tdid') === JDO_EVENT) body = { result: 0, tdid: JDO_EVENT, swiss: 0, schedule: [] };
    else if (operation === 'tournament/standings' && q.get('tdid') === JDO_EVENT) body = { result: 0, tdid: JDO_EVENT, groups: [] };
    else if (operation === 'match/list' && q.get('tdid') === JDO_EVENT)
      body = q.get('tmid__regex')
        ? list([])
        : list([{ mid: 'jdo_1', tdid: JDO_EVENT, tmid: `${JDO_EVENT}_t_0_p1_p2`, schid: '', match_type: '01', title: 'Sample Open 1回戦', startTime: 1_800_000_000, endMatch: 1, statsData: [{ name: '山田 太郎', tpid: 'p1', winLegs: 3, allScore: 1503, allDarts: 60 }, { name: '田中 花子', tpid: 'p2', winLegs: 1, allScore: 1200, allDarts: 60 }] }]);
    else if (operation === 'league/tournament/list') body = { result: 0, league: { lgid: 'lg_l3hI_3397', title: 'ATDO' }, list: [{ tdid: TDID, title: 'Test League 1st', status: 30, t_date: 1_800_000_000, createTime: 1_790_000_000 }] };
    else if (operation === 'tournament/get') body = tournamentDoc({ '0_c001': { AAAA: { BBBB: { r: 3, a: 55.5 } }, BBBB: { AAAA: { r: 2, a: 50.1 } } } });
    else if (operation === 'league/schedule/get') body = fixtures();
    else if (operation === 'tournament/standings')
      body = { result: 0, tdid: TDID, groups: [{ kind: 'lg', index: 0, title: 'A Division', players: [{ tpid: 'AAAA', name: 'Arrows', rank: 1, p: 1, w: 1, d: 0, l: 0, pts: 5 }, { tpid: 'BBBB', name: 'Bulls', rank: 2, p: 1, w: 0, d: 0, l: 1, pts: 2 }, { tpid: 'CCCC', name: 'Corks', rank: 0, p: 0, w: 0, d: 0, l: 0, pts: 0 }, { tpid: 'DDDD', name: 'Doubles', rank: 0, p: 0, w: 0, d: 0, l: 0, pts: 0 }] }] };
    else if (operation === 'match/list' && q.get('startTime__gte')) body = list(today());
    else if (operation === 'match/list') body = list([...c001, ...today()]);
    else if (operation === 'match/throws') {
      const mid = q.get('mid') ?? '';
      const live = mid === 'c003_sg01';
      body = { result: 0, changed: 1, mid, match_type: mid.endsWith('db02') ? 'cricket' : '01', end_match: live ? 0 : 1, current_leg: live ? 2 : undefined, updateTime: 1_800_000_500_000, leg_data: live ? [...SG01, SG01_LIVE] : (GAMES[mid] ?? []) };
    } else if (operation === 'match/live' && q.get('tmid')?.includes('c003') && options.nextGameStarted?.())
      body = liveBody({
        mid: 'c003_sg02',
        schid: 'sg02',
        title: 'Test League A Division シングルス2',
        updateTime: 1_800_000_020_000,
        sets: [3, 1],
        legs: [0, 0],
        current_leg: 0,
        players: [{ name: 'Arrows', tpid: 'AAAA', order: [{ oid: 'a2', name: '井上 次郎' }] }, { name: 'Corks', tpid: 'CCCC', order: [{ oid: 'c2', name: '木村 守' }] }],
        leg: { ...leg(0, 0, [[60], []], null), thrower: 1, round: 1, member: { oid: 'c2', name: '木村 守' } },
      });
    else if (operation === 'match/live' && q.get('tmid')?.includes('c003'))
      body = liveBody({
        mid: 'c003_sg01',
        schid: 'sg01',
        title: 'Test League A Division シングルス1',
        sets: [2, 1],
        legs: [1, 1],
        current_leg: 2,
        players: [{ name: 'Arrows', tpid: 'AAAA', order: [{ oid: 'a1', name: '青木 一郎' }] }, { name: 'Corks', tpid: 'CCCC', order: [{ oid: 'c1', name: '加藤 健' }] }],
        leg: { ...SG01_LIVE, thrower: 1, round: 4, member: { oid: 'c1', name: '加藤 健' } },
      });
    else if (operation === 'match/live')
      body = liveBody({ mid: 'c004_db01', scid: 'scid_c004', tmid: `${TDID}_lg_0_c004_BBBB_DDDD`, schid: 'db01', title: 'Test League A Division ダブルス1', sets: [0, 1], legs: [0, 1], current_leg: 1, players: [{ name: 'Bulls', tpid: 'BBBB', order: [{ oid: 'b1', name: '佐藤 B1' }, { oid: 'b2', name: '鈴木 B2' }] }, { name: 'Doubles', tpid: 'DDDD', order: [{ oid: 'd1', name: '田中 D1' }, { oid: 'd2', name: '千葉 D2' }] }] });
    else if (operation === 'team/order/list')
      body = { result: 0, list: [{ tpid: 'AAAA', schid: 'sg02', fix: 1, order: [{ oid: 'a2', oname: '井上 次郎' }] }, { tpid: 'CCCC', schid: 'sg02', fix: 1, order: [{ oid: 'c2', oname: '木村 守' }] }] };
    else if (operation === 'tournament/stats')
      body = { result: 0, stats: { a1: { tpid: 'AAAA', score: 9018, darts: 360, leg: 30, winLeg: 21, ton80: 2, highOut: 120, best: 15 }, a2: { tpid: 'AAAA', score: 6600, darts: 330, leg: 24, winLeg: 12 }, c1: { tpid: 'CCCC', score: 7200, darts: 360, leg: 30, winLeg: 13, ton80: 0 }, c2: { tpid: 'CCCC', score: 5400, darts: 330, leg: 22, winLeg: 8 } } };
    else if (operation === 'team/player/list')
      body = { result: 0, list: [{ tpid: 'AAAA', oid: 'a1', oname: '青木 一郎' }, { tpid: 'AAAA', oid: 'a2', oname: '井上 次郎' }, { tpid: 'CCCC', oid: 'c1', oname: '加藤 健' }, { tpid: 'CCCC', oid: 'c2', oname: '木村 守' }] };
    if (body === null) return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ result: -1, error: 'not found' }) });
    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body), headers: { 'access-control-allow-origin': '*' } });
  });
  return log;
}
