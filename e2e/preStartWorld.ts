import type { Page } from '@playwright/test';
import { N01_API_BASE_URL } from '../src/integrations/n01/endpoints';
import { TDID, gameRow, list, liveBody, side, tournamentDoc } from '../src/features/matches/testFixtures';

/**
 * A league night with cards before their first game (canned n01, no network), seven games a card:
 * ガロン, ダブルス1・2, シングルス1〜4.
 *
 * - c003 Arrows – Corks (today): ガロン・ダブルス1・ダブルス2 finished, シングルス1 in progress,
 *   シングルス2〜4 to come with both orders confirmed.
 * - c004 Bulls – Doubles (today): no game started; its orders as `options.c004` says. Started
 *   (`options.c004Started`): ガロン in progress — in the game list and in `match/live`.
 * - c006 Arrows – Doubles (next week): orders confirmed, never shown on the live tab.
 *
 * The orders are n01's shape (`tmid`, `tpid`, `schid`, `fix`, `order[]` of `oid` `opid` `oname`),
 * the team ids of a `tmid` in code-unit order, as n01 writes them (checked 2026-11-27).
 */

export const SLOTS7 = [
  { subTitle: 'ガロン', startScore: 1001, match_type: '01', num_part: 4, pt: 0, schid: 'tm01', limit_leg_count: 1 },
  { subTitle: 'ダブルス1', startScore: 501, match_type: '01', num_part: 2, pt: 0, schid: 'db01', limit_leg_count: 2 },
  { subTitle: 'ダブルス2', match_type: 'cricket', num_part: 2, pt: 0, schid: 'db02', limit_leg_count: 2 },
  { subTitle: 'シングルス1', startScore: 501, match_type: '01', num_part: 1, pt: 0, schid: 'sg01', limit_leg_count: 2 },
  { subTitle: 'シングルス2', startScore: 501, match_type: '01', num_part: 1, pt: 0, schid: 'sg02', limit_leg_count: 2 },
  { subTitle: 'シングルス3', startScore: 501, match_type: '01', num_part: 1, pt: 0, schid: 'sg03', limit_leg_count: 2 },
  { subTitle: 'シングルス4', startScore: 501, match_type: '01', num_part: 1, pt: 0, schid: 'sg04', limit_leg_count: 2 },
];

const PEOPLE: Record<string, [string, string][]> = {
  AAAA: [['a1', '青木 一郎'], ['a2', '井上 次郎'], ['a3', '上田 三郎'], ['a4', '遠藤 四郎']],
  BBBB: [['b1', '佐藤 B1'], ['b2', '鈴木 B2'], ['b3', '瀬川 B3'], ['b4', '曽根 B4（助っ人）']],
  CCCC: [['c1', '加藤 健'], ['c2', '木村 守'], ['c3', '工藤 仁'], ['c4', '小林 学']],
  DDDD: [['d1', '田中 D1'], ['d2', '千葉 D2'], ['d3', '津田 D3'], ['d4', '寺田 とても長い名前の選手ですね']],
};
/** Who plays which game, by index into PEOPLE (n01 order kept). */
const LINEUP: Record<string, number[]> = { tm01: [0, 1, 2, 3], db01: [0, 1], db02: [2, 3], sg01: [0], sg02: [1], sg03: [2], sg04: [3] };

/** Today's date in JST as a fixture title (`第2戦 11月27日`), or a week later. */
export function jstTitle(round: string, offsetDays = 0, now = Date.now()): string {
  const d = new Date(now + 9 * 3_600_000 + offsetDays * 86_400_000);
  return `${round} ${d.getUTCMonth() + 1}月${d.getUTCDate()}日`;
}

const tmidOf = (lsid: string, a: string, b: string): string => `${TDID}_lg_0_${lsid}_${[a, b].sort().join('_')}`;
export const C003 = tmidOf('c003', 'AAAA', 'CCCC');
export const C004 = tmidOf('c004', 'BBBB', 'DDDD');
export const C006 = tmidOf('c006', 'AAAA', 'DDDD');

export type OrderStage = 'fixed' | 'unfixed' | 'oneSide' | 'none' | 'changed' | 'fail' | 'duplicate' | 'foreign';

function orderRows(tmid: string, teams: [string, string], schids: readonly string[], stage: OrderStage): Record<string, unknown>[] {
  if (stage === 'none') return [];
  return schids.flatMap((schid) =>
    teams.map((tpid, index) => {
      const people = LINEUP[schid].map((i) => PEOPLE[tpid][i]);
      // 「changed」: Bulls' シングルス2 player is swapped for the helper.
      const swapped = stage === 'changed' && tpid === 'BBBB' && schid === 'sg02' ? [PEOPLE.BBBB[3]] : people;
      const fix = stage === 'unfixed' ? 0 : stage === 'oneSide' ? (index === 0 ? 1 : 0) : 1;
      return {
        tmid: stage === 'foreign' ? tmidOf('c999', teams[0], teams[1]) : tmid,
        tpid,
        schid,
        fix,
        order: swapped.map(([oid, oname]) => ({ oid, opid: oid === 'b4' ? '' : `op-${oid}`, oname })),
      };
    }),
  ).concat(stage === 'duplicate' ? [{ tmid, tpid: teams[0], schid: 'sg02', fix: 1, order: [{ oid: 'x', opid: '', oname: '重複 太郎' }] }] : []);
}

export interface PreStartOptions {
  /** The orders n01 returns for c004 (read on every request). */
  c004?: () => OrderStage;
  /** c004's ガロン has started. */
  c004Started?: () => boolean;
  /** Fail every order read (HTTP 503). */
  ordersDown?: () => boolean;
  /**
   * c003 between games: シングルス1 over in the game list and in `match/live` (`break`), then
   * シングルス2 started in `match/live` only (`next`, the list a step behind), then シングルス3
   * started (`after`: シングルス2 over, still not in the list).
   */
  c003Break?: () => 'break' | 'next' | 'after';
}

const c003Rows = (sg01Finished = false): unknown[] => [
  gameRow('c003', 'AAAA', 'CCCC', 'tm01', [side('AAAA', PEOPLE.AAAA, 1, 1001, 33), side('CCCC', PEOPLE.CCCC, 0, 692, 30)], { start: 1_800_000_000, mid: 'c003_tm01' }),
  // n01 lists Corks first in this row: the plan and the record must still sit on the right side.
  gameRow('c003', 'CCCC', 'AAAA', 'db01', [side('CCCC', [PEOPLE.CCCC[0], PEOPLE.CCCC[1]], 2, 1267, 48), side('AAAA', [PEOPLE.AAAA[0], PEOPLE.AAAA[1]], 1, 1153, 45)], { start: 1_800_000_900, mid: 'c003_db01' }),
  gameRow('c003', 'AAAA', 'CCCC', 'db02', [side('AAAA', [PEOPLE.AAAA[2], PEOPLE.AAAA[3]], 2, 0, 90, 190), side('CCCC', [PEOPLE.CCCC[2], PEOPLE.CCCC[3]], 0, 0, 90, 150)], { start: 1_800_001_800, mid: 'c003_db02' }),
  // シングルス1 in progress: played by 上田 三郎 (not the planned 青木 一郎) — the record wins.
  gameRow('c003', 'AAAA', 'CCCC', 'sg01', [side('AAAA', [PEOPLE.AAAA[2]], sg01Finished ? 2 : 1, 1213, 60), side('CCCC', [PEOPLE.CCCC[0]], 1, 1092, 57)], { start: 1_800_002_700, finished: sg01Finished, mid: 'c003_sg01' }),
].map((row) => ({ ...(row as object), tmid: C003 }));

const c004Live = (): unknown =>
  gameRow('c004', 'BBBB', 'DDDD', 'tm01', [side('BBBB', PEOPLE.BBBB, 0, 300, 9), side('DDDD', PEOPLE.DDDD, 0, 260, 9)], { start: 1_800_003_000, finished: false, mid: 'c004_tm01' });

export async function servePreStart(page: Page, options: PreStartOptions = {}): Promise<string[]> {
  const log: string[] = [];
  const now = Date.now();
  const fixtureBody = {
    result: 0,
    tdid: TDID,
    swiss: 0,
    schedule: [
      [
        { p: ['AAAA', 'CCCC'], lsid: 'c003', t: jstTitle('第2戦', 0, now) },
        { p: ['BBBB', 'DDDD'], lsid: 'c004', t: jstTitle('第2戦', 0, now) },
        { p: ['AAAA', 'DDDD'], lsid: 'c006', t: jstTitle('第3戦', 7, now) },
        { p: ['CCCC', 'BBBB'], lsid: 'c007', t: jstTitle('第3戦', 7, now) },
      ],
    ],
  };
  await page.route(`${N01_API_BASE_URL}/**`, async (route) => {
    const url = new URL(route.request().url());
    const operation = url.pathname.replace(/^.*\/api\/v1\//u, '');
    const q = url.searchParams;
    log.push(`${operation}?${q.toString()}`);
    const started = options.c004Started?.() ?? false;
    const c004Rows = (): unknown[] => (started ? [{ ...(c004Live() as object), tmid: C004 }] : []);
    let body: unknown = null;
    let status = 200;
    if (operation === 'league/list') body = { result: 0, list: [] };
    else if (operation === 'tournament/list') body = { result: 0, list: [] };
    else if (operation === 'league/tournament/list') body = { result: 0, league: { lgid: 'lg_l3hI_3397', title: 'ATDO' }, list: [{ tdid: TDID, title: 'Test League 1st', status: 30, t_date: 1_800_000_000, createTime: 1_790_000_000 }] };
    else if (operation === 'tournament/get') body = tournamentDoc({}, { lg_setting: { league: 1, schedule: SLOTS7, point_w: 2, point_d: 1, point_l: 0, include_set: 1, include_leg: 0, pt_setting: [] } });
    else if (operation === 'league/schedule/get') body = fixtureBody;
    else if (operation === 'tournament/standings')
      body = { result: 0, tdid: TDID, groups: [{ kind: 'lg', index: 0, title: 'A Division', players: ['AAAA', 'BBBB', 'CCCC', 'DDDD'].map((tpid) => ({ tpid, name: tpid, rank: 0, p: 0, w: 0, d: 0, l: 0, pts: 0 })) }] };
    else if (operation === 'match/list') body = list([...c003Rows(!!options.c003Break), ...c004Rows()]);
    else if (operation === 'match/throws') body = { result: 0, changed: 1, mid: q.get('mid'), match_type: '01', end_match: 1, updateTime: 1_800_000_500_000, leg_data: [] };
    else if (operation === 'match/live' && q.get('tmid') === C003 && options.c003Break?.() === 'after')
      body = liveBody({
        mid: 'c003_sg03',
        tmid: C003,
        schid: 'sg03',
        title: 'Test League A Division シングルス3',
        updateTime: 1_800_005_000_000,
        sets: [4, 1],
        legs: [0, 0],
        current_set: 5,
        current_leg: 0,
        format: { limit_leg: 2, limit_set: 7, draw_mode: 0, schedule: 1, start_score: 501 },
        players: [{ name: 'Arrows', tpid: 'AAAA', order: [{ oid: 'a3', name: '上田 三郎' }] }, { name: 'Corks', tpid: 'CCCC', order: [{ oid: 'c3', name: '工藤 仁' }] }],
      });
    else if (operation === 'match/live' && q.get('tmid') === C003 && options.c003Break?.() === 'next')
      body = liveBody({
        mid: 'c003_sg02',
        tmid: C003,
        schid: 'sg02',
        title: 'Test League A Division シングルス2',
        updateTime: 1_800_004_000_000,
        sets: [3, 1],
        legs: [0, 0],
        current_set: 4,
        current_leg: 0,
        format: { limit_leg: 2, limit_set: 7, draw_mode: 0, schedule: 1, start_score: 501 },
        players: [{ name: 'Arrows', tpid: 'AAAA', order: [{ oid: 'a2', name: '井上 次郎' }] }, { name: 'Corks', tpid: 'CCCC', order: [{ oid: 'c2', name: '木村 守' }] }],
      });
    else if (operation === 'match/live' && q.get('tmid') === C003 && options.c003Break?.() === 'break')
      body = liveBody({
        mid: 'c003_sg01',
        tmid: C003,
        schid: 'sg01',
        title: 'Test League A Division シングルス1',
        updateTime: 1_800_003_500_000,
        end_match: 1,
        sets: [3, 1],
        legs: [2, 1],
        current_leg: 2,
        format: { limit_leg: 2, limit_set: 7, draw_mode: 0, schedule: 1, start_score: 501 },
        players: [{ name: 'Arrows', tpid: 'AAAA', order: [{ oid: 'a3', name: '上田 三郎' }] }, { name: 'Corks', tpid: 'CCCC', order: [{ oid: 'c1', name: '加藤 健' }] }],
      });
    else if (operation === 'match/live' && q.get('tmid') === C003)
      body = liveBody({
        mid: 'c003_sg01',
        tmid: C003,
        schid: 'sg01',
        title: 'Test League A Division シングルス1',
        sets: [2, 1],
        legs: [1, 1],
        current_leg: 2,
        format: { limit_leg: 2, limit_set: 7, draw_mode: 0, schedule: 1, start_score: 501 },
        players: [{ name: 'Arrows', tpid: 'AAAA', order: [{ oid: 'a3', name: '上田 三郎' }] }, { name: 'Corks', tpid: 'CCCC', order: [{ oid: 'c1', name: '加藤 健' }] }],
      });
    else if (operation === 'match/live' && q.get('tmid') === C004 && started)
      body = liveBody({
        mid: 'c004_tm01',
        tmid: C004,
        schid: 'tm01',
        title: 'Test League A Division ガロン',
        sets: [0, 0],
        legs: [0, 0],
        current_set: 0,
        current_leg: 0,
        format: { limit_leg: 1, limit_set: 7, draw_mode: 0, schedule: 1, start_score: 1001 },
        players: [{ name: 'Bulls', tpid: 'BBBB', order: PEOPLE.BBBB.map(([oid, name]) => ({ oid, name })) }, { name: 'Doubles', tpid: 'DDDD', order: PEOPLE.DDDD.map(([oid, name]) => ({ oid, name })) }],
        leg: { leg: 0, first: 0, end: 0, winner: null, time: 1_800_003_000_000, start: [1001, 1001], left: [701, 741], darts: [9, 9], scored: [300, 260], thrower: 0, round: 4, throws: [] },
      });
    else if (operation === 'match/live') {
      status = 404;
      body = { result: -1, error: 'match not found' };
    } else if (operation === 'team/order/list') {
      if (options.ordersDown?.()) {
        status = 503;
        body = { result: -1, error: 'unavailable' };
      } else {
        const tmid = q.get('tmid');
        const schids = SLOTS7.map((slot) => slot.schid);
        const stage = options.c004?.() ?? 'fixed';
        if (stage === 'fail' && tmid === C004) {
          status = 503;
          body = { result: -1, error: 'unavailable' };
        } else
          body = {
            result: 0,
            list:
              tmid === C003
                ? orderRows(C003, ['CCCC', 'AAAA'], schids, 'fixed')
                : tmid === C004
                  ? orderRows(C004, ['BBBB', 'DDDD'], schids, stage)
                  : tmid === C006
                    ? orderRows(C006, ['AAAA', 'DDDD'], schids, 'fixed')
                    : [],
          };
      }
    } else if (operation === 'tournament/stats') body = { result: 0, stats: {} };
    else if (operation === 'team/player/list') body = { result: 0, list: [] };
    if (body === null) return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ result: -1, error: 'not found' }) });
    return route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body), headers: { 'access-control-allow-origin': '*' } });
  });
  return log;
}
