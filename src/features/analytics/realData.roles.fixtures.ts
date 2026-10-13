import type { RawGame, RawGameDetail, RawVisit } from './api/parse';
import { parseSlotEvidence } from './api/parse';
import { buildSeasonData } from './seasonData';
import type { SeasonData } from './seasonData';
import { playerRow, season, teamRow, tournament } from './testFixtures';
import type { StatLine } from './types';

/**
 * Real n01 data, read through the n01 read API on 2026-10-13 and reduced to what the role
 * analytics reads. ATDO DARTS LEAGUE (`lg_l3hI_3397`):
 *
 *  - 2024 2nd `t_kY1n_6823`: no `match_type` anywhere; slot `8kxb` "クリケット" has
 *    `startScore: 0`. No match record exists for `8kxb` (`match/list?schid=8kxb` → []),
 *    yet `lg_result` counts 7 games per match: the Cricket results were entered without a
 *    match record. Team Desperado (`pzDR`, division 2) played 8 matches.
 *  - 2026 3rd `t_ABvC_5234`: explicit `match_type: "01"`; division 0 overrides the base with
 *    its own `schid`s and best-of-5 singles (`limit_leg_count: 3`).
 *
 * Nothing here is fetched in CI.
 */

/** `tournament/get` → `lg_setting` of 2024 2nd, as returned (fields the parser reads). */
export const RAW_2024_2ND = {
  result: 0,
  tournament: {
    tdid: 't_kY1n_6823',
    lg_setting: {
      startScore: 501,
      schedule: [
        { subTitle: 'チーム', startScore: 1001, limit_leg_count: 1, num_part: 4, schid: 'kwcg' },
        { subTitle: 'クリケット', startScore: 0, limit_leg_count: 2, num_part: 2, schid: '8kxb' },
        { subTitle: 'ダブルス2', startScore: 501, limit_leg_count: 2, num_part: 2, schid: 'rdsi' },
        { subTitle: 'シングルス1', startScore: 501, limit_leg_count: 2, num_part: 1, schid: 'fepq' },
        { subTitle: 'シングルス2', startScore: 501, limit_leg_count: 2, num_part: 1, schid: 'cvzb' },
        { subTitle: 'シングルス3', startScore: 501, limit_leg_count: 2, num_part: 1, schid: '6wav' },
        { subTitle: 'シングルス4', startScore: 501, limit_leg_count: 2, num_part: 1, schid: 'gsbe' },
      ],
      game_setting: [],
    },
  },
};

const slot26 = (subTitle: string, startScore: number, legs: number, numPart: number, schid: string) => ({ subTitle, startScore, match_type: '01', limit_leg_count: legs, num_part: numPart, schid });

/** `tournament/get` → `lg_setting` of 2026 3rd (division 0 override with Bo5 singles). */
export const RAW_2026_3RD = {
  result: 0,
  tournament: {
    tdid: 't_ABvC_5234',
    lg_setting: {
      match_type: '01',
      schedule: [
        slot26('チーム', 1001, 1, 4, 'kwcg'),
        slot26('ダブルス1', 501, 2, 2, '8kxb'),
        slot26('ダブルス2', 501, 2, 2, 'rdsi'),
        slot26('シングルス1', 501, 2, 1, 'fepq'),
        slot26('シングルス2', 501, 2, 1, 'cvzb'),
        slot26('シングルス3', 501, 2, 1, '6wav'),
        slot26('シングルス4', 501, 2, 1, 'gsbe'),
      ],
      game_setting: [
        {
          round: 0,
          match_type: '01',
          schedule: [
            slot26('チーム', 1001, 1, 4, 'qtrl'),
            slot26('ダブルス1', 501, 2, 2, '2gbr'),
            slot26('ダブルス2', 501, 2, 2, '0qf2'),
            slot26('シングルス1', 501, 3, 1, 'hvv5'),
            slot26('シングルス2', 501, 3, 1, 'h949'),
            slot26('シングルス3', 501, 3, 1, 'u27z'),
            slot26('シングルス4', 501, 3, 1, 'k39v'),
          ],
        },
      ],
    },
  },
};

export const TDID_2024_2ND = 't_kY1n_6823';
const SCHIDS = ['gsbe', '6wav', 'cvzb', 'fepq', 'rdsi', 'kwcg'] as const;

/**
 * Desperado's 48 recorded games of 2024 2nd: per match (opponent, lsid) and per game in the
 * order gsbe, 6wav, cvzb, fepq (singles), rdsi (doubles), kwcg (team 1001):
 * [pzDR players in order, pzDR score, pzDR darts, pzDR legs won, opponent legs won].
 */
type Row = [string[], number, number, number, number];
const MATCHES: { lsid: string; opponent: string; games: Row[] }[] = [
  { lsid: 'nvp1', opponent: '7v1X', games: [[['vxnn'], 1455, 95, 2, 1], [['g1vr'], 1492, 126, 1, 2], [['63Cz'], 1320, 88, 2, 1], [['MHv6'], 1002, 64, 2, 0], [['MHv6', 'g1vr'], 1465, 116, 2, 1], [['vxnn', 'MHv6', 'g1vr', '63Cz'], 1001, 83, 1, 0]] },
  { lsid: 'yly7', opponent: 'RcXE', games: [[['4wjn'], 1498, 106, 2, 1], [['63Cz'], 1002, 66, 2, 0], [['MHv6'], 1487, 110, 1, 2], [['vxnn'], 749, 54, 0, 2], [['MHv6', '63Cz'], 886, 81, 0, 2], [['4wjn', 'MHv6', 'g1vr', 'vxnn'], 1001, 69, 1, 0]] },
  { lsid: 'rodt', opponent: 'RrVa', games: [[['4wjn'], 612, 36, 0, 2], [['g1vr'], 685, 57, 0, 2], [['63Cz'], 636, 39, 0, 2], [['MHv6'], 1002, 52, 2, 0], [['MHv6', '4wjn'], 593, 60, 0, 2], [['4wjn', 'MHv6', 'g1vr', '63Cz'], 572, 39, 0, 1]] },
  { lsid: 'faok', opponent: 'rIdl', games: [[['4wjn'], 1479, 111, 2, 1], [['g1vr'], 1478, 130, 1, 2], [['63Cz'], 882, 63, 0, 2], [['MHv6'], 1361, 86, 2, 1], [['63Cz', 'g1vr'], 918, 99, 1, 2], [['4wjn', 'MHv6', 'g1vr', '63Cz'], 809, 60, 0, 1]] },
  { lsid: 'avvj', opponent: '7v1X', games: [[['vxnn'], 1002, 67, 2, 0], [['63Cz'], 1311, 108, 1, 2], [['4wjn'], 1002, 62, 2, 0], [['MHv6'], 1002, 61, 2, 0], [['63Cz', 'g1vr'], 955, 90, 0, 2], [['4wjn', '63Cz', 'g1vr', 'vxnn'], 1001, 62, 1, 0]] },
  { lsid: 'slwl', opponent: 'RcXE', games: [[['4wjn'], 1360, 104, 1, 2], [['63Cz'], 699, 57, 0, 2], [['g1vr'], 978, 84, 0, 2], [['MHv6'], 1435, 103, 2, 1], [['MHv6', '4wjn'], 1002, 65, 2, 0], [['4wjn', 'MHv6', 'g1vr', '63Cz'], 1001, 71, 1, 0]] },
  { lsid: 'w629', opponent: 'RrVa', games: [[['6s5w'], 812, 48, 0, 2], [['4wjn'], 858, 54, 0, 2], [['MHv6'], 948, 54, 0, 2], [['vxnn'], 988, 51, 0, 2], [['MHv6', 'g1vr'], 908, 108, 1, 2], [['4wjn', 'MHv6', 'g1vr', 'vxnn'], 1001, 48, 1, 0]] },
  { lsid: 'gbpf', opponent: 'rIdl', games: [[['6s5w'], 1002, 55, 2, 0], [['vhqF'], 1002, 59, 2, 0], [['4wjn'], 990, 72, 0, 2], [['MHv6'], 653, 42, 0, 2], [['4wjn', 'g1vr'], 588, 78, 0, 2], [['4wjn', 'g1vr', 'vhqF', 'MHv6'], 961, 66, 0, 1]] },
];

/** The game id used by the fixtures: `<lsid>_<schid>` (the real `mid`s are in {@link DETAILS}). */
export const gameIdOf = (lsid: string, schid: string): string => `${lsid}_${schid}`;

/** The 48 games as `match/list` rows. The opponent side carries its legs only (its players / totals are not needed here). */
export function desperadoGames(): RawGame[] {
  return MATCHES.flatMap(({ lsid, opponent, games }) =>
    games.map(([oids, score, darts, won, lost], index) => {
      const schid = SCHIDS[index];
      const realId = DETAIL_IDS[gameIdOf(lsid, schid)];
      const opponentPlayers = oids.map((_, i) => ({ oid: `${opponent}_${i}`, opid: null, name: null }));
      return {
        gameId: realId ?? gameIdOf(lsid, schid),
        matchId: `${TDID_2024_2ND}_lg_1_${lsid}_pzDR_${opponent}`,
        schid,
        matchType: null,
        finished: true,
        startTime: null,
        sides: [
          { teamId: 'pzDR', players: oids.map((oid) => ({ oid, opid: null, name: null })), legsWon: won, score, darts },
          { teamId: opponent, players: opponentPlayers, legsWon: lost, score: null, darts: null },
        ],
      } satisfies RawGame;
    }),
  );
}

/** n01's season totals (`player_stats_list` / `stats_list`) for Desperado, 2024 2nd. */
const off = (o: Partial<StatLine>): StatLine => ({
  score: null, darts: null, f9Score: null, f9Darts: null, leg: null, winLeg: null, set: null, winSet: null, breakLegs: null, breakWins: null,
  match: null, winMatch: null, ton00: null, ton40: null, ton70: null, ton80: null, highOut: null, bestLeg: null, ...o,
});
export const OFFICIAL_2024_2ND: Record<string, StatLine> = {
  pzDR: off({ score: 48844, darts: 3559, winLeg: 50, leg: 120, breakLegs: 54, breakWins: 21, winMatch: 2, match: 8, winSet: 23, set: 56, ton00: 41, ton40: 7, ton70: 0, ton80: 0, highOut: 70, bestLeg: 24, f9Score: 12879, f9Darts: 918 }),
  '4wjn': off({ score: 10774, darts: 756, winLeg: 15, leg: 32, breakLegs: 18, breakWins: 6, set: 18, winSet: 9, ton00: 10, ton40: 1, ton70: 0, ton80: 0, highOut: 70, bestLeg: 30, f9Score: 2788, f9Darts: 198, match: 7 }),
  MHv6: off({ score: 13572, darts: 907, winLeg: 25, leg: 45, breakLegs: 21, breakWins: 11, set: 23, winSet: 13, ton00: 19, ton40: 2, ton70: 0, ton80: 0, highOut: 58, bestLeg: 24, f9Score: 3733, f9Darts: 261, match: 8 }),
  g1vr: off({ score: 7981, darts: 754, winLeg: 11, leg: 37, breakLegs: 19, breakWins: 7, set: 20, winSet: 6, ton00: 0, ton40: 0, ton70: 0, ton80: 0, highOut: 68, bestLeg: 39, f9Score: 1787, f9Darts: 153, match: 8 }),
  '63Cz': off({ score: 8298, darts: 635, winLeg: 10, leg: 33, breakLegs: 16, breakWins: 6, set: 17, winSet: 5, ton00: 5, ton40: 2, ton70: 0, ton80: 0, highOut: 60, bestLeg: 30, f9Score: 2142, f9Darts: 165, match: 6 }),
  vxnn: off({ score: 5183, darts: 330, winLeg: 11, leg: 22, breakLegs: 7, breakWins: 5, set: 12, winSet: 7, ton00: 4, ton40: 1, ton70: 0, ton80: 0, highOut: 64, bestLeg: 28, f9Score: 1235, f9Darts: 84, match: 4 }),
  '6s5w': off({ score: 1814, darts: 103, winLeg: 3, leg: 9, breakLegs: 2, breakWins: 1, set: 4, winSet: 1, ton00: 2, ton40: 1, ton70: 0, ton80: 0, highOut: 32, bestLeg: 26, f9Score: 732, f9Darts: 36, match: 2 }),
  vhqF: off({ score: 1222, darts: 74, winLeg: 2, leg: 3, breakLegs: 2, breakWins: 1, set: 2, winSet: 1, ton00: 1, ton40: 0, ton70: 0, ton80: 0, highOut: 40, bestLeg: 29, f9Score: 462, f9Darts: 21, match: 1 }),
};

// ---- `match/get` legs ---------------------------------------------------------------------

/** A visit: points, or `[darts, 'out']` for a checkout with that many darts. */
type V = number | [number, 'out'];

function visits(start: number, raw: readonly V[]): RawVisit[] {
  let left = start;
  return raw.map((v) => {
    if (Array.isArray(v)) {
      left = 0;
      return { score: -v[0], left: 0 };
    }
    left -= v;
    return { score: v, left };
  });
}

interface LegSpec {
  first: 0 | 1;
  winner: 0 | 1;
  a: V[];
  b: V[];
}

interface DetailSpec {
  key: string;
  mid: string;
  start: number;
  sides: [{ team: string; oids: string[]; score: number; darts: number; won: number }, { team: string; oids: string[]; score: number; darts: number; won: number }];
  legs: LegSpec[];
}

const D: DetailSpec[] = [
  {
    key: 'nvp1_rdsi', mid: 'M71NBEQx_1726746793911', start: 501,
    sides: [{ team: 'pzDR', oids: ['MHv6', 'g1vr'], score: 1465, darts: 116, won: 2 }, { team: '7v1X', oids: ['44mm', 'vwq6'], score: 1445, darts: 116, won: 1 }],
    legs: [
      { first: 0, winner: 1, a: [0, 0, 0, 58, 41, 24, 70, 22, 60, 31, 85, 15, 63], b: [0, 0, 0, 77, 41, 86, 95, 20, 41, 45, 23, 37, [2, 'out']] },
      { first: 1, winner: 0, a: [88, 91, 81, 21, 45, 39, 60, 0, 44, 0, [2, 'out']], b: [2, 41, 30, 50, 52, 41, 28, 23, 100, 72, 54] },
      { first: 0, winner: 0, a: [48, 31, 24, 33, 100, 3, 43, 31, 44, 39, 39, 30, 30, 0, 0], b: [2, 55, 33, 73, 22, 7, 26, 22, 83, 58, 40, 0, 0, 0, 30] },
    ],
  },
  {
    key: 'yly7_rdsi', mid: 'IDnJ5lpQ_1726141072552', start: 501,
    sides: [{ team: 'pzDR', oids: ['MHv6', '63Cz'], score: 886, darts: 81, won: 0 }, { team: 'RcXE', oids: ['kn3v', 'i3te'], score: 1002, darts: 80, won: 2 }],
    legs: [
      { first: 0, winner: 1, a: [0, 0, 0, 41, 45, 59, 24, 5, 22, 43, 30, 41, 30, 37, 42], b: [0, 56, 36, 49, 47, 26, 57, 43, 98, 57, 0, 16, 0, 8, [1, 'out']] },
      { first: 1, winner: 1, a: [0, 0, 0, 2, 28, 11, 81, 73, 100, 39, 45, 88], b: [0, 17, 45, 66, 43, 76, 28, 60, 58, 45, 57, 0, [1, 'out']] },
    ],
  },
  {
    key: 'faok_rdsi', mid: 'VU6AjbQE_1724326953016', start: 501,
    sides: [{ team: 'pzDR', oids: ['63Cz', 'g1vr'], score: 918, darts: 99, won: 1 }, { team: 'rIdl', oids: ['QpJ7', '9w8h'], score: 1381, darts: 101, won: 2 }],
    legs: [
      { first: 1, winner: 0, a: [80, 6, 22, 23, 36, 52, 81, 60, 30, 29, 53, 0, [3, 'out']], b: [0, 0, 0, 12, 43, 81, 30, 26, 29, 30, 45, 42, 41] },
      { first: 0, winner: 1, a: [0, 0, 0, 0, 0, 22, 7, 17, 26, 27], b: [112, 60, 26, 67, 24, 45, 45, 50, 32, [3, 'out']] },
      { first: 1, winner: 1, a: [0, 0, 80, 26, 45, 26, 41, 24, 52, 24], b: [16, 50, 44, 60, 42, 24, 78, 45, 75, 32, [2, 'out']] },
    ],
  },
  {
    // Leg 2 as recorded: one side scored nothing in 15 rounds, yet n01 gives it the leg.
    key: 'avvj_rdsi', mid: 'KbzMhPtz_1723116985252', start: 501,
    sides: [{ team: '7v1X', oids: ['rtvo', '44mm'], score: 499, darts: 90, won: 2 }, { team: 'pzDR', oids: ['63Cz', 'g1vr'], score: 955, darts: 90, won: 0 }],
    legs: [
      { first: 0, winner: 0, a: [62, 22, 43, 75, 100, 21, 32, 22, 58, 26, 20, 10, 5, 3, 0], b: [0, 45, 26, 31, 9, 28, 39, 41, 43, 28, 14, 45, 18, 45, 49] },
      { first: 1, winner: 0, a: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0], b: [0, 0, 45, 45, 45, 10, 30, 22, 85, 60, 39, 28, 12, 24, 49] },
    ],
  },
  {
    key: 'rodt_kwcg', mid: 'DuLnRiIn_1725534127641', start: 1001,
    sides: [{ team: 'RrVa', oids: ['awzo', 't8jg', '3ome', 'h5xz'], score: 1001, darts: 41, won: 1 }, { team: 'pzDR', oids: ['4wjn', 'MHv6', 'g1vr', '63Cz'], score: 572, darts: 39, won: 0 }],
    legs: [{ first: 0, winner: 0, a: [100, 85, 100, 81, 96, 60, 13, 70, 85, 85, 32, 36, 126, [2, 'out']], b: [43, 60, 59, 45, 11, 41, 39, 60, 45, 60, 44, 7, 58] }],
  },
  {
    key: 'faok_kwcg', mid: '4jAYcZhO_1724324048336', start: 1001,
    sides: [{ team: 'pzDR', oids: ['4wjn', 'MHv6', 'g1vr', '63Cz'], score: 809, darts: 60, won: 0 }, { team: 'rIdl', oids: ['qdbh', 'QpJ7', '70fi', '9w8h'], score: 1001, darts: 61, won: 1 }],
    legs: [{ first: 1, winner: 1, a: [41, 15, 22, 60, 29, 55, 45, 45, 60, 24, 50, 26, 76, 11, 41, 21, 81, 55, 30, 22], b: [30, 100, 29, 30, 60, 55, 58, 45, 65, 45, 42, 81, 41, 83, 83, 70, 44, 30, 0, 0, [1, 'out']] }],
  },
  {
    key: 'avvj_kwcg', mid: '3Q67NKwR_1723114512738', start: 1001,
    sides: [{ team: '7v1X', oids: ['5R2Q', 'vwq6', 'rtvo', '44mm'], score: 969, darts: 60, won: 0 }, { team: 'pzDR', oids: ['4wjn', '63Cz', 'g1vr', 'vxnn'], score: 1001, darts: 62, won: 1 }],
    legs: [{ first: 1, winner: 1, a: [85, 26, 52, 85, 52, 3, 26, 65, 85, 16, 21, 45, 85, 37, 22, 22, 70, 76, 23, 73], b: [47, 38, 33, 25, 65, 17, 7, 85, 140, 62, 50, 83, 65, 14, 41, 45, 66, 80, 16, 14, [2, 'out']] }],
  },
  {
    key: 'slwl_kwcg', mid: 'o60HB8iW_1722509317072', start: 1001,
    sides: [{ team: 'RcXE', oids: ['kn3v', 'dqdn', 'i3te', 'WUnd'], score: 913, darts: 72, won: 0 }, { team: 'pzDR', oids: ['4wjn', 'MHv6', 'g1vr', '63Cz'], score: 1001, darts: 71, won: 1 }],
    legs: [{ first: 0, winner: 1, a: [41, 30, 55, 26, 22, 60, 45, 66, 29, 77, 41, 24, 68, 40, 30, 33, 43, 32, 37, 7, 17, 28, 38, 24], b: [9, 13, 29, 30, 41, 90, 36, 30, 60, 26, 88, 41, 66, 26, 81, 23, 46, 50, 34, 28, 9, 58, 47, [2, 'out']] }],
  },
  {
    key: 'nvp1_kwcg', mid: 'WJ4INlYl_1726742612593', start: 1001,
    sides: [{ team: 'pzDR', oids: ['vxnn', 'MHv6', 'g1vr', '63Cz'], score: 1001, darts: 83, won: 1 }, { team: '7v1X', oids: ['sm56', 'rtvo', '44mm', 'vwq6'], score: 997, darts: 84, won: 0 }],
    legs: [{ first: 1, winner: 0, a: [11, 41, 21, 40, 26, 55, 39, 28, 35, 60, 28, 26, 33, 83, 32, 100, 80, 83, 60, 39, 40, 37, 0, 0, 0, 0, 2, [2, 'out']], b: [50, 7, 39, 26, 90, 32, 26, 11, 24, 60, 78, 29, 38, 26, 28, 56, 81, 47, 28, 14, 40, 32, 24, 71, 12, 24, 4, 0] }],
  },
  {
    key: 'gbpf_kwcg', mid: '2knTgF17_1720695211940', start: 1001,
    sides: [{ team: 'rIdl', oids: ['qdbh', '9w8h', '70fi', 'mqFy'], score: 1001, darts: 68, won: 1 }, { team: 'pzDR', oids: ['4wjn', 'g1vr', 'vhqF', 'MHv6'], score: 961, darts: 66, won: 0 }],
    legs: [{ first: 0, winner: 0, a: [24, 60, 62, 55, 60, 81, 60, 29, 41, 13, 14, 60, 85, 27, 41, 67, 41, 93, 64, 18, 0, 0, [2, 'out']], b: [57, 31, 60, 45, 41, 26, 39, 39, 60, 15, 45, 100, 60, 33, 50, 85, 35, 35, 26, 44, 35, 0] }],
  },
  {
    key: 'gbpf_gsbe', mid: 'ddPShVZI_1720702983621', start: 501,
    sides: [{ team: 'rIdl', oids: ['mqFy'], score: 907, darts: 54, won: 0 }, { team: 'pzDR', oids: ['6s5w'], score: 1002, darts: 55, won: 2 }],
    legs: [
      { first: 1, winner: 1, a: [47, 95, 29, 39, 57, 41, 31, 45, 27], b: [37, 11, 35, 98, 80, 30, 68, 69, 41, [2, 'out']] },
      { first: 0, winner: 1, a: [41, 59, 41, 47, 95, 79, 57, 62, 15], b: [134, 55, 140, 80, 38, 34, 0, 10, [2, 'out']] },
    ],
  },
  {
    key: 'w629_gsbe', mid: 'wcDQJSji_1721911865826', start: 501,
    sides: [{ team: 'pzDR', oids: ['6s5w'], score: 812, darts: 48, won: 0 }, { team: 'RrVa', oids: ['t8jg'], score: 1002, darts: 49, won: 2 }],
    legs: [
      { first: 1, winner: 1, a: [66, 45, 85, 32, 40, 39, 24], b: [77, 43, 61, 96, 85, 34, 57, [3, 'out']] },
      { first: 0, winner: 1, a: [39, 45, 40, 30, 25, 118, 94, 40, 50], b: [57, 26, 43, 43, 81, 100, 69, 42, [1, 'out']] },
    ],
  },
];

const DETAIL_IDS: Record<string, string> = Object.fromEntries(D.map((d) => [d.key, d.mid]));

/** The 12 `match/get` responses, parsed (the trailing unplayed leg row n01 adds is included). */
export function details(): RawGameDetail[] {
  return D.map((d) => ({
    gameId: d.mid,
    matchId: `${TDID_2024_2ND}_lg_1_${d.key.split('_')[0]}`,
    schid: d.key.split('_')[1],
    matchType: null,
    startScore: d.start,
    finished: true,
    sides: d.sides.map((s) => ({ teamId: s.team, players: s.oids.map((oid) => ({ oid, opid: null, name: null })), legsWon: s.won, score: s.score, darts: s.darts })) as RawGameDetail['sides'],
    legs: [
      ...d.legs.map((leg) => ({ first: leg.first, winner: leg.winner, ended: true, visits: [visits(d.start, leg.a), visits(d.start, leg.b)] as [RawVisit[], RawVisit[]] })),
      { first: null, winner: null, ended: false, visits: [[], []] as [RawVisit[], RawVisit[]] },
    ],
  }));
}

/** The real opponent players of the reconstructed games, so the opponent side of those rows is exact too. */
export function withDetailSides(games: RawGame[]): RawGame[] {
  const byId = new Map(details().map((d) => [d.gameId, d]));
  return games.map((g) => {
    const d = byId.get(g.gameId);
    return d ? { ...g, sides: d.sides } : g;
  });
}

/** 2024 2nd as a season: Desperado's official rows and the real slots (other teams' rows omitted). */
export function season2024Data(): SeasonData {
  const t = tournament(TDID_2024_2ND, [{ id: 'pzDR', name: 'Desperado', division: 1 }, { id: '7v1X', name: 'X6', division: 1 }, { id: 'RcXE', name: '5★BANG', division: 1 }, { id: 'RrVa', name: '8chi-8chi', division: 1 }, { id: 'rIdl', name: 'ラムチョップ', division: 1 }]);
  const players = Object.entries(OFFICIAL_2024_2ND).filter(([id]) => id !== 'pzDR');
  return buildSeasonData(
    season({
      tournament: t,
      slots: parseSlotEvidence(RAW_2024_2ND),
      teamStats: [teamRow('pzDR', OFFICIAL_2024_2ND.pzDR, 1)],
      playerStats: players.map(([oid, line]) => playerRow(oid, null, 'pzDR', oid, line, 1)),
    }),
  );
}

/** A parsed game detail back in n01's wire shape (`match/get`), for fake transports. */
export function wireDetail(d: RawGameDetail): unknown {
  return {
    result: 0,
    match: {
      mid: d.gameId, tmid: d.matchId, schid: d.schid, startScore: d.startScore, endMatch: d.finished ? 1 : 0,
      legData: d.legs.map((leg) => ({ first: leg.first, winner: leg.winner, endFlag: leg.ended ? 1 : 0, playerData: leg.visits.map((v) => [{ score: 0, left: d.startScore }, ...v]) })),
      statsData: d.sides.map((side) => ({ tpid: side.teamId, order: side.players.map((p) => ({ oid: p.oid })), winLegs: side.legsWon, allScore: side.score, allDarts: side.darts })),
    },
  };
}

/** A `match/list` row in n01's wire shape. */
export function wireGame(g: RawGame): Record<string, unknown> {
  return {
    mid: g.gameId, tmid: g.matchId, schid: g.schid, endMatch: g.finished ? 1 : 0, ...(g.matchType ? { match_type: g.matchType } : {}),
    statsData: g.sides.map((side) => ({ tpid: side.teamId, order: side.players.map((p) => ({ oid: p.oid })), winLegs: side.legsWon, ...(side.score !== null ? { allScore: side.score } : {}), ...(side.darts !== null ? { allDarts: side.darts } : {}) })),
  };
}

/**
 * 2026 3rd (`t_ABvC_5234`, running), team ドリズム (`WpZb`, division 0 = A, which plays the
 * override slots with best-of-5 singles): its 14 recorded games after 2 matches, read
 * 2026-10-13, and n01's `stats_list` row for it at the same time.
 * [schid, WpZb players, score, darts, legs won, opponent legs won]
 */
export const TDID_2026_3RD = 't_ABvC_5234';
export const OFFICIAL_WPZB_2026_3RD = off({ score: 21657, darts: 1119, winLeg: 33, leg: 42, breakLegs: 19, breakWins: 15, winMatch: 2, match: 2, winSet: 13, set: 14, ton00: 44, ton40: 10, ton70: 0, ton80: 0, highOut: 119, bestLeg: 16, f9Score: 7710, f9Darts: 378 });
const WPZB: { lsid: string; opponent: string; games: [string, string[], number, number, number, number][] }[] = [
  { lsid: 'cxnb', opponent: 'M4bk', games: [['k39v', ['5o3z'], 1998, 104, 3, 1], ['u27z', ['z8rg'], 1493, 84, 3, 0], ['h949', ['gm3v'], 1503, 75, 3, 0], ['hvv5', ['xuh1'], 2339, 128, 3, 2], ['0qf2', ['gm3v', 'z8rg'], 1002, 41, 2, 0], ['2gbr', ['5o3z', 'xuh1'], 1002, 51, 2, 0], ['qtrl', ['5o3z', 'z8rg', 'gm3v', 'xuh1'], 1001, 51, 1, 0]] },
  { lsid: 'rqbd', opponent: 'GpiQ', games: [['k39v', ['5o3z'], 2002, 106, 3, 1], ['u27z', ['3oun'], 1979, 87, 3, 1], ['h949', ['gm3v'], 2399, 127, 3, 2], ['hvv5', ['xuh1'], 1994, 102, 3, 1], ['0qf2', ['5o3z', 'xuh1'], 1002, 57, 2, 0], ['2gbr', ['gm3v', 'o3ul'], 1002, 55, 2, 0], ['qtrl', ['gm3v', 'xuh1', '3oun', '5o3z'], 941, 51, 0, 1]] },
];

export function drizzumGames(): RawGame[] {
  return WPZB.flatMap(({ lsid, opponent, games }) =>
    games.map(([schid, oids, score, darts, won, lost]) => ({
      gameId: `${lsid}_${schid}`,
      matchId: `${TDID_2026_3RD}_lg_0_${lsid}_${opponent}_WpZb`,
      schid,
      matchType: '01',
      finished: true,
      startTime: null,
      sides: [
        { teamId: 'WpZb', players: oids.map((oid) => ({ oid, opid: null, name: null })), legsWon: won, score, darts },
        { teamId: opponent, players: oids.map((_, i) => ({ oid: `${opponent}${i}`, opid: null, name: null })), legsWon: lost, score: null, darts: null },
      ],
    })),
  );
}

/** n01's `player_stats_list` rows (2026 3rd, read 2026-10-13) for two ドリズム players. */
export const OFFICIAL_2026_3RD: Record<string, StatLine> = {
  // 灰田 裕一郎: one doubles game only — Best Leg 0 (none) although his pair won 2 legs.
  o3ul: off({ score: 473, darts: 26, winLeg: 2, leg: 2, breakLegs: 1, breakWins: 1, set: 1, winSet: 1, ton00: 1, ton40: 0, ton70: 0, ton80: 0, highOut: 54, bestLeg: null, f9Score: 96, f9Darts: 6, match: 1 }),
  // 柴田 圭介: one singles game (u27z, exact from its row) + the team game.
  '3oun': off({ score: 2117, darts: 99, winLeg: 3, leg: 5, breakLegs: 3, breakWins: 1, set: 2, winSet: 1, ton00: 6, ton40: 0, ton70: 0, ton80: 0, highOut: 119, bestLeg: 20, f9Score: 858, f9Darts: 39, match: 1 }),
};

const D2026: DetailSpec[] = [
  {
    key: 'rqbd_2gbr', mid: 'mfLrlWMg_1790853252790', start: 501,
    sides: [{ team: 'WpZb', oids: ['gm3v', 'o3ul'], score: 1002, darts: 55, won: 2 }, { team: 'GpiQ', oids: ['yhNs', 'uByO'], score: 805, darts: 54, won: 0 }],
    legs: [
      { first: 0, winner: 0, a: [0, 56, 42, 100, 84, 26, 139, [2, 'out']], b: [10, 60, 45, 100, 13, 41, 45] },
      { first: 1, winner: 0, a: [61, 40, 54, 60, 81, 95, 54, 36, 0, 6, [2, 'out']], b: [40, 3, 41, 45, 66, 30, 60, 60, 52, 60, 34] },
    ],
  },
  {
    key: 'rqbd_qtrl', mid: 'WCm59dFr_1790852350440', start: 1001,
    sides: [{ team: 'WpZb', oids: ['gm3v', 'xuh1', '3oun', '5o3z'], score: 941, darts: 51, won: 0 }, { team: 'GpiQ', oids: ['yhNs', 'uByO', '6vkf', 'h91h'], score: 1001, darts: 54, won: 1 }],
    legs: [{ first: 1, winner: 1, a: [9, 42, 30, 21, 140, 15, 7, 81, 27, 60, 41, 100, 42, 26, 60, 140, 100], b: [40, 22, 60, 40, 45, 100, 65, 87, 30, 85, 57, 60, 60, 100, 20, 26, 84, [3, 'out']] }],
  },
];

function toDetail(d: DetailSpec, tdid: string, division: number): RawGameDetail {
  return {
    gameId: d.mid,
    matchId: `${tdid}_lg_${division}_${d.key.split('_')[0]}`,
    schid: d.key.split('_')[1],
    matchType: '01',
    startScore: d.start,
    finished: true,
    sides: d.sides.map((s) => ({ teamId: s.team, players: s.oids.map((oid) => ({ oid, opid: null, name: null })), legsWon: s.won, score: s.score, darts: s.darts })) as RawGameDetail['sides'],
    legs: d.legs.map((leg) => ({ first: leg.first, winner: leg.winner, ended: true, visits: [visits(d.start, leg.a), visits(d.start, leg.b)] as [RawVisit[], RawVisit[]] })),
  };
}

export function details2026(): RawGameDetail[] {
  return D2026.map((d) => toDetail(d, TDID_2026_3RD, 0));
}

/** ドリズム's games with the two rebuilt games under their real `mid`s and full sides. */
export function drizzumGamesWithDetails(): RawGame[] {
  const byKey = new Map(D2026.map((d) => [d.key, toDetail(d, TDID_2026_3RD, 0)]));
  return drizzumGames().map((g) => {
    const d = byKey.get(g.gameId);
    return d ? { ...g, gameId: d.gameId, sides: d.sides } : g;
  });
}
