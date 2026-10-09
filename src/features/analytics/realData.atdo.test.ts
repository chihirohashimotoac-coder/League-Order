import { describe, expect, it } from 'vitest';
import { aggregateTeams } from './aggregate';
import { parseStandings, parseTeamStats } from './api/parse';
import { rankTeams, buildTeamPopulationForTest } from './realData.helpers';
import { buildSeasonData } from './seasonData';
import { classifySeason } from './seasons';
import { season, tournament } from './testFixtures';
import { newestFirst } from '../../integrations/n01/seasonResolver';
import { parseLeagueTournaments } from '../../integrations/n01/validation';

/**
 * Real data: ATDO 2026 3rd (`t_ABvC_5234`), `stats_list` and `standings` as n01 returned them
 * on 2026-10-09 (via the n01 read API), reduced to the fields analytics uses. This is the
 * independent check of the parse → season → pool → rank pipeline against the live shape:
 * 18 registered teams, 3 divisions of 6, `r_g` counted from 1, tied official ranks.
 */
// tpid: [score, darts, winLeg, leg, f9Score, f9Darts, r_g]
const TEAMS: Record<string, [number, number, number, number, number, number, number]> = {
  M4bk: [16606, 926, 7, 38, 6518, 342, 1],
  RrVa: [19615, 870, 29, 38, 8917, 342, 1],
  '68wv': [20187, 1101, 22, 44, 8056, 396, 1],
  GpiQ: [20101, 1195, 14, 45, 6270, 405, 1],
  k18b: [19033, 936, 19, 41, 7291, 369, 1],
  WpZb: [21657, 1119, 33, 42, 7710, 378, 1],
  RHbq: [14830, 976, 11, 31, 4050, 279, 2],
  Vbse: [15940, 1027, 17, 32, 5083, 288, 2],
  XDvP: [17071, 1074, 19, 33, 4839, 297, 2],
  RcXE: [17030, 1144, 23, 33, 4717, 297, 2],
  X6iU: [14903, 1107, 11, 32, 3857, 288, 2],
  R1Jo: [15762, 1072, 16, 33, 4950, 297, 2],
  iTGA: [16378, 1136, 15, 33, 4699, 297, 3],
  rIdl: [16744, 1129, 18, 33, 4802, 297, 3],
  '7v1X': [13771, 961, 11, 27, 3972, 243, 3],
  UOBW: [13944, 952, 16, 28, 3853, 252, 3],
  Gi0h: [15032, 1036, 16, 30, 3920, 270, 3],
  pzDR: [14527, 1033, 14, 29, 4271, 261, 3],
};
const NAMES: Record<string, string> = {
  M4bk: 'HOLIC', RrVa: '8chi-8chi', '68wv': 'スピンコブラ', GpiQ: 'kalavinka', k18b: 'ALADDIN', WpZb: 'ドリズム',
  RHbq: 'MOA', Vbse: '暁STRIKERS', XDvP: '倒竜門', RcXE: '5★BANG', X6iU: 'ストロベリーガーリック', R1Jo: 'ZDO',
  iTGA: 'トリプ', rIdl: 'ラムチョップ', '7v1X': 'X6', UOBW: '雷', Gi0h: 'じゅーしーめろん', pzDR: 'Desperado',
};
// Official standings by division (index 0 = A), in n01's order: [tpid, rank, w, l, pts]
const OFFICIAL: [string, [string, number, number, number, number][]][] = [
  ['Aディビジョン', [['WpZb', 1, 2, 0, 17], ['RrVa', 2, 2, 0, 16], ['k18b', 3, 1, 1, 9], ['68wv', 4, 1, 1, 9], ['GpiQ', 5, 0, 2, 2], ['M4bk', 6, 0, 2, 1]]],
  ['Bディビジョン', [['RcXE', 1, 2, 0, 15], ['XDvP', 2, 1, 1, 11], ['R1Jo', 3, 1, 1, 9], ['Vbse', 4, 1, 1, 9], ['X6iU', 5, 1, 1, 6], ['RHbq', 6, 0, 2, 4]]],
  ['Cディビジョン', [['UOBW', 1, 2, 0, 12], ['rIdl', 2, 1, 1, 9], ['Gi0h', 2, 1, 1, 9], ['pzDR', 2, 1, 1, 9], ['iTGA', 2, 1, 1, 9], ['7v1X', 6, 0, 2, 6]]],
];

function rawStats() {
  const stats: Record<string, Record<string, number>> = {};
  for (const [tpid, [score, darts, winLeg, leg, f9Score, f9Darts, r_g]] of Object.entries(TEAMS)) {
    stats[tpid] = { score, darts, winLeg, leg, f9Score, f9Darts, r_g, match: 2, winMatch: 1, set: 14, winSet: 7, a_b: 10, w_b: 5, ton00: 10, ton40: 3, ton70: 0, ton80: 1, highOut: 90, best: 18 };
  }
  return { result: 0, kind: 'stats_list', stats };
}

function rawStandings() {
  return {
    result: 0,
    groups: OFFICIAL.map(([title, rows], index) => ({
      kind: 'lg', index, title,
      players: rows.map(([tpid, rank, w, l, pts]) => ({ tpid, name: NAMES[tpid], rank, p: 2, w, d: 0, l, diff: 0, diff_l: 0, pts, bh: 0, byes: 0 })),
    })),
  };
}

function build() {
  const t = tournament(
    't_ABvC_5234',
    OFFICIAL.flatMap(([, rows], division) => rows.map(([tpid]) => ({ id: tpid, name: NAMES[tpid], division }))),
    { title: '2026 3rd', status: 30 },
  );
  return buildSeasonData(season({ tournament: t, teamStats: parseTeamStats(rawStats()), standings: parseStandings(rawStandings()) }));
}

describe('real data: ATDO 2026 3rd team stats and standings', () => {
  const data = build();

  it('18 registered teams, all measured, in 3 divisions of 6', () => {
    expect(data.teams).toHaveLength(18);
    expect(data.teams.every((t) => t.line !== null)).toBe(true);
    expect(data.divisions.map((d) => d.teamIds.length)).toEqual([6, 6, 6]);
  });

  it('r_g (1-based) agrees with the league table (0-based) for every team', () => {
    const rows = parseTeamStats(rawStats());
    for (const row of rows) {
      const fromTable = data.divisions.find((d) => d.teamIds.includes(row.teamId))!.index;
      expect(row.divisionIndex, row.teamId).toBe(fromTable);
    }
  });

  it('official standings keep n01\'s ranks, including four teams tied at 2nd (next rank 6)', () => {
    const c = data.standings.find((g) => g.divisionIndex === 2)!;
    expect(c.rows.map((r) => r.rank)).toEqual([1, 2, 2, 2, 2, 6]);
    expect(data.standings.map((g) => g.rows.length)).toEqual([6, 6, 6]);
  });

  it('the own 3DA ranking equals an independent 3×score/darts sort, and is a different list from the official one', () => {
    const teams = aggregateTeams([data]);
    const ranking = rankTeams(teams.filter((t) => t.seasons[0].divisionIndex === 0), 'ppr');
    const expected = Object.entries(TEAMS)
      .filter(([, v]) => v[6] === 1)
      .map(([tpid, v]) => ({ name: NAMES[tpid], ppr: (3 * v[0]) / v[1] }))
      .sort((a, b) => b.ppr - a.ppr)
      .map((x) => x.name);
    expect(ranking.ranked.map((e) => e.label)).toEqual(expected);
    expect(ranking.population).toBe(6);
    // Official A division order: ドリズム, 8chi-8chi, ALADDIN, スピンコブラ, kalavinka, HOLIC.
    expect(expected).not.toEqual(['ドリズム', '8chi-8chi', 'ALADDIN', 'スピンコブラ', 'kalavinka', 'HOLIC']);
  });

  it('league-wide: 18 ranked on 3DA; kalavinka is 50.46 (design example) and 3DA of the pool is Σ/Σ', () => {
    const teams = aggregateTeams([data]);
    const league = rankTeams(teams, 'ppr');
    expect(league.population).toBe(18);
    const kala = league.ranked.find((e) => e.label === 'kalavinka')!;
    expect(kala.value!).toBeCloseTo(50.46, 2);
    const pooled = buildTeamPopulationForTest([data]);
    const sumScore = Object.values(TEAMS).reduce((s, v) => s + v[0], 0);
    const sumDarts = Object.values(TEAMS).reduce((s, v) => s + v[1], 0);
    expect(pooled.averages.ppr.value!).toBeCloseTo((3 * sumScore) / sumDarts, 10);
  });
});

// ---- TDO season list as n01 returned it (2026-10-09), fields reduced -------------------------------------
describe('real data: TDO season list', () => {
  const raw = {
    result: 0,
    list: [
      { tdid: 't_i3FQ_9507', title: 'TDO 2026/3rd', status: 30, t_date: 0, createTime: 1790122869 },
      { tdid: 't_q428_0541', title: 'TDO 2026/2nd', status: 40, t_date: 1774485960, createTime: 1781929970 },
      { tdid: 't_NHzT_6218', title: 'TDO 2026/1st', status: 40, t_date: 1774485960, createTime: 1774053956 },
      { tdid: 't_RlQN_7254', title: 'TDOイヤーズチャンピオンシップ2024', status: 40, t_date: 1768006800, createTime: 1767481857 },
      { tdid: 't_AMdg_3124', title: 'TDO 2025/4th', status: 40, t_date: 1767610800, createTime: 1765973333 },
      { tdid: 't_Aq5m_2340', title: 'TDO事務局検証作業用', status: 25, t_date: 1761970500, createTime: 1761884042 },
      { tdid: 't_6FUu_3339', title: 'TDOイヤーズチャンピオンシップ2023', status: 40, t_date: 1763953200, createTime: 1761483863 },
      { tdid: 't_Kny6_0292', title: 'TDO 2025/3rd', status: 40, t_date: 1758778980, createTime: 1758605950 },
      { tdid: 't_sJo6_5442', title: 'TDO 2025-2nd Season (Test運用)', status: 40, t_date: 1751217780, createTime: 1751045325 },
    ],
  };
  const { tournaments } = parseLeagueTournaments(raw, 'lg_3qgW_6619');

  it('championships, the verification event and the Test season are excluded; regular seasons are undecided until their details are read', () => {
    const kinds = Object.fromEntries(tournaments.map((t) => [t.title, classifySeason(t).kind]));
    expect(kinds).toMatchObject({
      'TDO 2026/3rd': 'unknown',
      'TDO 2026/2nd': 'unknown',
      'TDO 2026/1st': 'unknown',
      'TDO 2025/4th': 'unknown',
      'TDO 2025/3rd': 'unknown',
      'TDOイヤーズチャンピオンシップ2024': 'excluded',
      'TDOイヤーズチャンピオンシップ2023': 'excluded',
      'TDO事務局検証作業用': 'excluded',
      'TDO 2025-2nd Season (Test運用)': 'excluded',
    });
  });

  it('orders the regular seasons newest first (t_date, then createTime when the date is 0)', () => {
    const regular = newestFirst(tournaments).filter((t) => classifySeason(t).kind !== 'excluded');
    expect(regular.map((t) => t.title)).toEqual(['TDO 2026/3rd', 'TDO 2026/2nd', 'TDO 2026/1st', 'TDO 2025/4th', 'TDO 2025/3rd']);
  });
});
