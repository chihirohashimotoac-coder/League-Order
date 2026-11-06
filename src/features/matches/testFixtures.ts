/**
 * Synthetic n01 payloads in the shapes the public read API returns (checked against live
 * responses on 2026-11-06: tournament/get, league/schedule/get, match/list, match/get,
 * match/live, tournament/standings). Names and ids are made up.
 */

export const TDID = 't_Test_0001';
export const LGID = 'lg_Test_0001';

export const SLOTS = [
  { subTitle: 'チーム', startScore: 1001, match_type: '01', num_part: 4, pt: 0, schid: 'tm01', limit_leg_count: 1 },
  { subTitle: 'ダブルス1', startScore: 501, match_type: '01', num_part: 2, pt: 0, schid: 'db01', limit_leg_count: 2 },
  { subTitle: 'ダブルス2', match_type: 'cricket', num_part: 2, pt: 0, schid: 'db02', limit_leg_count: 2 },
  { subTitle: 'シングルス1', startScore: 501, match_type: '01', num_part: 1, pt: 0, schid: 'sg01', limit_leg_count: 2 },
  { subTitle: 'シングルス2', startScore: 501, match_type: '01', num_part: 1, pt: 0, schid: 'sg02', limit_leg_count: 2 },
];

/** Teams AAAA, BBBB, CCCC, DDDD in one division. */
export function tournamentDoc(results: Record<string, Record<string, Record<string, { r: number; a?: number }>>> = {}, extra: Record<string, unknown> = {}): unknown {
  return {
    result: 0,
    url: `https://n01darts.com/n01/league/season.php?id=${TDID}`,
    tournament: {
      tdid: TDID,
      lgid: LGID,
      title: 'Test League 1st',
      status: 30,
      team_games: 1,
      entry_list: [
        { tpid: 'AAAA', name: 'Arrows' },
        { tpid: 'BBBB', name: 'Bulls' },
        { tpid: 'CCCC', name: 'Corks' },
        { tpid: 'DDDD', name: 'Doubles' },
      ],
      lg_title: ['A Division'],
      lg_table: [['AAAA', 'BBBB', 'CCCC', 'DDDD']],
      lg_setting: { league: 1, schedule: SLOTS, point_w: 2, point_d: 1, point_l: 0, include_set: 1, include_leg: 0, pt_setting: [] },
      lg_result: results,
      lg_pts: [],
      updateTime: 1_800_000_000_000,
      ...extra,
    },
  };
}

export function fixtures(): unknown {
  return {
    result: 0,
    tdid: TDID,
    swiss: 0,
    schedule: [
      [
        { p: ['AAAA', 'BBBB'], lsid: 'c001', t: '第1戦' },
        { p: ['CCCC', 'DDDD'], lsid: 'c002', t: '第1戦' },
        { p: ['AAAA', 'CCCC'], lsid: 'c003', t: '第2戦' },
        { p: ['BBBB', 'DDDD'], lsid: 'c004', t: '第2戦' },
        { p: ['AAAA', 'empty'], lsid: 'c005', t: 'bye' },
      ],
    ],
  };
}

export function side(tpid: string, members: [string, string][], legs: number, score: number, darts: number, marks = 0): unknown {
  return { name: tpid, tpid, order: members.map(([oid, oname]) => ({ oid, opid: `op-${oid}`, oname })), winLegs: legs, winSets: 0, allScore: score, allDarts: darts, allMarks: marks };
}

export function gameRow(lsid: string, a: string, b: string, schid: string, sides: [unknown, unknown], options: { finished?: boolean; start?: number; type?: string; mid?: string } = {}): unknown {
  return {
    mid: options.mid ?? `${lsid}_${schid}`,
    tdid: TDID,
    tmid: `${TDID}_lg_0_${lsid}_${a}_${b}`,
    schid,
    scid: `scid_${lsid}`,
    match_type: options.type ?? (schid === 'db02' ? 'cricket' : '01'),
    title: `Test League A Division ${schid}`,
    startTime: options.start ?? 1_800_000_000,
    updateTime: (options.start ?? 1_800_000_000) * 1000 + 5000,
    endMatch: options.finished === false ? 0 : 1,
    statsData: sides,
  };
}

export function list(rows: unknown[]): unknown {
  return { result: 0, list: rows };
}

/** Card c001 played completely: AAAA wins 3-2 (counted from the game rows). */
export function c001Rows(): unknown[] {
  return [
    gameRow('c001', 'BBBB', 'AAAA', 'tm01', [side('BBBB', [['b1', 'B1'], ['b2', 'B2'], ['b3', 'B3'], ['b4', 'B4']], 0, 900, 60), side('AAAA', [['a1', 'A1'], ['a2', 'A2'], ['a3', 'A3'], ['a4', 'A4']], 1, 1001, 57)], { start: 1_800_000_100 }),
    gameRow('c001', 'AAAA', 'BBBB', 'db01', [side('AAAA', [['a1', 'A1'], ['a2', 'A2']], 2, 1002, 48), side('BBBB', [['b1', 'B1'], ['b2', 'B2']], 1, 900, 51)], { start: 1_800_000_200 }),
    gameRow('c001', 'AAAA', 'BBBB', 'db02', [side('AAAA', [['a3', 'A3'], ['a4', 'A4']], 0, 0, 90, 150), side('BBBB', [['b3', 'B3'], ['b4', 'B4']], 2, 0, 90, 180)], { start: 1_800_000_300 }),
    gameRow('c001', 'AAAA', 'BBBB', 'sg01', [side('AAAA', [['a1', 'A1']], 2, 1002, 45), side('BBBB', [['b1', 'B1']], 0, 700, 42)], { start: 1_800_000_400 }),
    gameRow('c001', 'AAAA', 'BBBB', 'sg02', [side('AAAA', [['a2', 'A2']], 1, 900, 60), side('BBBB', [['b2', 'B2']], 2, 1002, 57)], { start: 1_800_000_500 }),
  ];
}

export function liveBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    result: 0,
    changed: 1,
    mid: 'c003_sg01',
    scid: 'scid_c003',
    tdid: TDID,
    tmid: `${TDID}_lg_0_c003_AAAA_CCCC`,
    schid: 'sg01',
    ttype: 'lg',
    title: 'Test League A Division シングルス1',
    match_type: '01',
    updateTime: 1_800_000_010_000,
    end_match: 0,
    end_schedule: 0,
    format: { limit_leg: 2, limit_set: 5, draw_mode: 0, schedule: 1, start_score: 501 },
    show_sets: 1,
    sets: [2, 1],
    legs: [1, 0],
    current_set: 3,
    current_leg: 1,
    leg_count: 2,
    players: [
      { name: 'Arrows', tpid: 'AAAA', order: [{ oid: 'a1', name: 'A1' }] },
      { name: 'Corks', tpid: 'CCCC', order: [{ oid: 'c1', name: 'C1' }] },
    ],
    stats: [{ avg: 60.1, score: 601, darts: 30 }, { avg: 50, score: 500, darts: 30 }],
    leg: {
      leg: 1,
      first: 1,
      end: 0,
      winner: null,
      time: 1_800_000_010_000,
      start: [501, 501],
      left: [321, 401],
      darts: [6, 6],
      scored: [180, 100],
      thrower: 1,
      round: 3,
      member: { oid: 'c1', name: 'C1' },
      throws: [
        { p: 1, r: 1, score: 60, left: 441, darts: 3, member: { oid: 'c1', name: 'C1' } },
        { p: 0, r: 1, score: 100, left: 401, darts: 3, member: { oid: 'a1', name: 'A1' } },
        { p: 1, r: 2, score: 40, left: 401, darts: 3, member: { oid: 'c1', name: 'C1' } },
        { p: 0, r: 2, score: 80, left: 321, darts: 3, member: { oid: 'a1', name: 'A1' } },
      ],
    },
    ...overrides,
  };
}
