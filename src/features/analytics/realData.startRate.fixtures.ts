import type { HighInRecord } from './api/parse';

/**
 * Measured n01 data behind the ダブルイン成功率 (read 2026-11-15 through the n01 read API,
 * anonymous GET; reduced to the fields analytics reads, player names left out). Nothing here is
 * fetched in CI. What each piece showed:
 *
 *  - `ATDO_2026_3RD_DOUBLES` — ATDO DARTS LEAGUE 2026 3rd (`t_ABvC_5234`), A division,
 *    ダブルス1 (`2gbr`), `pHd61gnc_1794481807166`: the losing pair needs four `0` visits before
 *    its first points in leg 1 and one in leg 2; the legs add up to n01's `allScore`/`allDarts`.
 *  - `TDO_2026_3RD_DOUBLES` — TDO 2026/3rd (`t_i3FQ_9507`), ダブルス1 (`5ywh`),
 *    `zKJTVRK7_1794482065566`: in leg 1 the pair `l3ds`/`9vpt` throws `0` then `105`. n01's
 *    high-in record for that leg ({@link HIGH_IN_TDO_PAIRS}: `9vpt`, 105, the leg's `time`)
 *    names the **second** player of the order: the `0` row is a real throw of `order[0]`, and
 *    the rotation restarts at `order[0]` each leg — the rule `reconstruct.ts` verified.
 *  - The high-in records of each season (`player_high_in`, compact `schid:points`): only the
 *    doubles slots carry any, highest 160 (≤ 170, the double-in maximum).
 */

export const ATDO_2026_3RD_DOUBLES = {"result": 0, "match": {"mid": "pHd61gnc_1794481807166", "tmid": "t_ABvC_5234_lg_0_kaaa_68wv_GpiQ", "schid": "2gbr", "match_type": "01", "startScore": 501, "endMatch": 1, "legData": [{"time": 1794482251088, "first": 0, "endFlag": 1, "winner": 0, "playerData": [[{"score": 0, "left": 501}, {"score": 41, "left": 460}, {"score": 60, "left": 400}, {"score": 41, "left": 359}, {"score": 30, "left": 329}, {"score": 59, "left": 270}, {"score": 60, "left": 210}, {"score": 94, "left": 116}, {"score": 100, "left": 16}, {"score": -2, "left": 0}], [{"score": 0, "left": 501}, {"score": 0, "left": 501}, {"score": 0, "left": 501}, {"score": 0, "left": 501}, {"score": 0, "left": 501}, {"score": 50, "left": 451}, {"score": 60, "left": 391}, {"score": 59, "left": 332}, {"score": 81, "left": 251}]]}, {"time": 1794482472974, "first": 1, "endFlag": 1, "winner": 0, "middleForDiddle": 0, "playerData": [[{"score": 0, "left": 501}, {"score": 50, "left": 451}, {"score": 60, "left": 391}, {"score": 180, "left": 211}, {"score": 61, "left": 150}, {"score": 126, "left": 24}, {"score": -1, "left": 0}], [{"score": 0, "left": 501}, {"score": 0, "left": 501}, {"score": 41, "left": 460}, {"score": 44, "left": 416}, {"score": 45, "left": 371}, {"score": 58, "left": 313}, {"score": 9, "left": 304}]]}], "statsData": [{"tpid": "68wv", "order": [{"oid": "msco"}, {"oid": "8Ch8"}], "winLegs": 2, "allScore": 1002, "allDarts": 42}, {"tpid": "GpiQ", "order": [{"oid": "49ib"}, {"oid": "uByO"}], "winLegs": 0, "allScore": 447, "allDarts": 42}]}} as const;

export const TDO_2026_3RD_DOUBLES = {"result": 0, "match": {"mid": "zKJTVRK7_1794482065566", "tmid": "t_i3FQ_9507_lg_2_h63l_YKeJ_fSrN", "schid": "5ywh", "match_type": "01", "startScore": 501, "endMatch": 1, "legData": [{"time": 1794482491668, "first": 0, "endFlag": 1, "winner": 1, "playerData": [[{"score": 0, "left": 501}, {"score": 0, "left": 501}, {"score": 105, "left": 396}, {"score": 140, "left": 256}, {"score": 100, "left": 156}, {"score": 120, "left": 36}, {"score": 27, "left": 9}, {"score": 1, "left": 8}, {"score": 6, "left": 2}], [{"score": 0, "left": 501}, {"score": 80, "left": 421}, {"score": 140, "left": 281}, {"score": 43, "left": 238}, {"score": 84, "left": 154}, {"score": 40, "left": 114}, {"score": 58, "left": 56}, {"score": 16, "left": 40}, {"score": -3, "left": 0}]]}, {"time": 1794482766406, "first": 1, "endFlag": 1, "winner": 0, "middleForDiddle": 0, "playerData": [[{"score": 0, "left": 501}, {"score": 0, "left": 501}, {"score": 80, "left": 421}, {"score": 45, "left": 376}, {"score": 100, "left": 276}, {"score": 27, "left": 249}, {"score": 59, "left": 190}, {"score": 150, "left": 40}, {"score": -3, "left": 0}], [{"score": 0, "left": 501}, {"score": 14, "left": 487}, {"score": 60, "left": 427}, {"score": 85, "left": 342}, {"score": 60, "left": 282}, {"score": 57, "left": 225}, {"score": 83, "left": 142}, {"score": 51, "left": 91}, {"score": 55, "left": 36}]]}, {"time": 1794483119237, "first": 0, "endFlag": 1, "winner": 1, "middleForDiddle": 0, "playerData": [[{"score": 0, "left": 501}, {"score": 96, "left": 405}, {"score": 45, "left": 360}, {"score": 60, "left": 300}, {"score": 28, "left": 272}, {"score": 57, "left": 215}, {"score": 125, "left": 90}, {"score": 27, "left": 63}, {"score": 23, "left": 40}, {"score": 20, "left": 20}], [{"score": 0, "left": 501}, {"score": 0, "left": 501}, {"score": 52, "left": 449}, {"score": 60, "left": 389}, {"score": 60, "left": 329}, {"score": 83, "left": 246}, {"score": 41, "left": 205}, {"score": 80, "left": 125}, {"score": 89, "left": 36}, {"score": -2, "left": 0}]]}], "statsData": [{"tpid": "YKeJ", "order": [{"oid": "l3ds"}, {"oid": "9vpt"}], "winLegs": 1, "allScore": 1481, "allDarts": 75}, {"tpid": "fSrN", "order": [{"oid": "ijhg"}, {"oid": "3nya"}], "winLegs": 2, "allScore": 1467, "allDarts": 74}]}} as const;

export const RAW_TDO_2026_3RD = {"result": 0, "tournament": {"tdid": "t_i3FQ_9507", "lgid": "lg_3qgW_6619", "lg_setting": {"match_type": "01", "startScore": 501, "schedule": [{"subTitle": "チーム", "startScore": 1001, "match_type": "01", "limit_leg_count": 1, "num_part": 4, "schid": "bel5"}, {"subTitle": "ダブルス1", "startScore": 501, "match_type": "01", "limit_leg_count": 2, "num_part": 2, "schid": "5ywh"}, {"subTitle": "ダブルス2", "startScore": 501, "match_type": "01", "limit_leg_count": 2, "num_part": 2, "schid": "kwgs"}, {"subTitle": "シングルス1", "startScore": 501, "match_type": "01", "limit_leg_count": 2, "num_part": 1, "schid": "rqq9"}, {"subTitle": "シングルス2", "startScore": 501, "match_type": "01", "limit_leg_count": 2, "num_part": 1, "schid": "j6zw"}, {"subTitle": "シングルス3", "startScore": 501, "match_type": "01", "limit_leg_count": 2, "num_part": 1, "schid": "hrnk"}, {"subTitle": "シングルス4", "startScore": 501, "match_type": "01", "limit_leg_count": 2, "num_part": 1, "schid": "gv4c"}], "game_setting": []}}};

const HIGH_IN_ATDO_2026_3RD_COMPACT = '2gbr:160 8kxb:160 8kxb:160 0qf2:156 8kxb:152 rdsi:148 rdsi:124 rdsi:122 0qf2:120 0qf2:120 2gbr:120 2gbr:120 2gbr:120 2gbr:120 2gbr:120 8kxb:120 8kxb:120 8kxb:120 rdsi:120 rdsi:120 8kxb:115 2gbr:114 8kxb:112 8kxb:112 rdsi:112 rdsi:112 rdsi:108 2gbr:107 8kxb:107 0qf2:105 2gbr:105 0qf2:101 0qf2:101 0qf2:100 2gbr:100 2gbr:100 2gbr:100 2gbr:100 8kxb:100 8kxb:100 8kxb:100 rdsi:100 rdsi:100 rdsi:100';

const HIGH_IN_TDO_2026_3RD_COMPACT = '5ywh:160 5ywh:160 5ywh:160 5ywh:160 5ywh:160 5ywh:160 5ywh:160 5ywh:160 kwgs:160 kwgs:160 kwgs:160 kwgs:160 kwgs:160 kwgs:160 kwgs:160 kwgs:152 kwgs:152 kwgs:152 kwgs:152 kwgs:152 kwgs:148 5ywh:130 5ywh:130 5ywh:120 5ywh:120 5ywh:120 5ywh:120 5ywh:120 5ywh:120 5ywh:120 5ywh:120 5ywh:120 5ywh:120 5ywh:120 5ywh:120 5ywh:120 5ywh:120 5ywh:120 5ywh:120 5ywh:120 5ywh:120 5ywh:120 5ywh:120 5ywh:120 5ywh:120 5ywh:120 5ywh:120 5ywh:120 5ywh:120 5ywh:120 5ywh:120 5ywh:120 5ywh:120 kwgs:120 kwgs:120 kwgs:120 kwgs:120 kwgs:120 kwgs:120 kwgs:120 kwgs:120 kwgs:120 kwgs:120 kwgs:120 kwgs:120 kwgs:120 kwgs:120 kwgs:120 kwgs:120 kwgs:120 kwgs:120 kwgs:120 kwgs:120 kwgs:120 kwgs:120 kwgs:120 kwgs:120 5ywh:118 kwgs:118 5ywh:116 5ywh:116 5ywh:116 kwgs:116 kwgs:116 5ywh:115 5ywh:115 5ywh:115 kwgs:115 kwgs:115 5ywh:114 kwgs:114 5ywh:112 5ywh:112 5ywh:112 5ywh:112 5ywh:112 5ywh:112 5ywh:112 5ywh:112 5ywh:112 kwgs:112 kwgs:112 kwgs:112 kwgs:112 kwgs:112 kwgs:112 kwgs:112 kwgs:112 kwgs:112 kwgs:112 5ywh:109 kwgs:109 5ywh:108 5ywh:108 kwgs:108 kwgs:107 5ywh:106 kwgs:106 5ywh:105 5ywh:105 5ywh:105 5ywh:105 5ywh:105 5ywh:105 5ywh:105 5ywh:105 5ywh:105 5ywh:105 kwgs:105 kwgs:105 kwgs:105 kwgs:105 kwgs:105 kwgs:105 kwgs:104 kwgs:103 5ywh:102 5ywh:102 5ywh:102 kwgs:102 5ywh:101 5ywh:101 5ywh:101 5ywh:101 kwgs:101 kwgs:101 kwgs:101 kwgs:101 kwgs:101 kwgs:101 kwgs:101 kwgs:101 5ywh:100 5ywh:100 5ywh:100 5ywh:100 5ywh:100 5ywh:100 5ywh:100 5ywh:100 5ywh:100 5ywh:100 5ywh:100 5ywh:100 5ywh:100 5ywh:100 5ywh:100 5ywh:100 5ywh:100 5ywh:100 5ywh:100 5ywh:100 5ywh:100 5ywh:100 5ywh:100 kwgs:100 kwgs:100 kwgs:100 kwgs:100 kwgs:100 kwgs:100 kwgs:100 kwgs:100 kwgs:100 kwgs:100 kwgs:100 kwgs:100 kwgs:100 kwgs:100 kwgs:100 kwgs:100 kwgs:100 kwgs:100 kwgs:100';

const HIGH_IN_ATDO_2024_2ND_COMPACT = 'rdsi:156 rdsi:120 rdsi:120 rdsi:116 rdsi:116 rdsi:115 rdsi:112 rdsi:112 rdsi:110 rdsi:109 rdsi:108 rdsi:108 rdsi:105 rdsi:105 rdsi:102 rdsi:101 rdsi:100 rdsi:100 rdsi:100';

export const HIGH_IN_TDO_PAIRS = [{"schid": "5ywh", "oid": "l3ds", "highIn": 160, "time": 1793878028046}, {"schid": "5ywh", "oid": "9vpt", "highIn": 105, "time": 1794482491668}, {"schid": "5ywh", "oid": "l3ds", "highIn": 101, "time": 1792063171899}, {"schid": "5ywh", "oid": "9vpt", "highIn": 100, "time": 1793273283520}];

const expand = (compact: string): HighInRecord[] =>
  compact.split(' ').map((entry) => {
    const [schid, points] = entry.split(':');
    return { schid, oid: null, highIn: Number(points), time: null };
  });

/** Every high-in record of the season (who and when left out: only the slot and the points matter here). */
export const HIGH_IN_ATDO_2026_3RD = expand(HIGH_IN_ATDO_2026_3RD_COMPACT);
export const HIGH_IN_TDO_2026_3RD = expand(HIGH_IN_TDO_2026_3RD_COMPACT);
export const HIGH_IN_ATDO_2024_2ND = expand(HIGH_IN_ATDO_2024_2ND_COMPACT);

export const LEAGUE_ATDO = 'lg_l3hI_3397';
export const LEAGUE_TDO = 'lg_3qgW_6619';
export const TDID_TDO_2026_3RD = 't_i3FQ_9507';

/** n01 league-list `createTime` (seconds) of the two seasons, as their `startedAt` (no `t_date` is set). */
export const STARTED_AT_ATDO_2026_3RD = 1_789_829_175_000;
export const STARTED_AT_TDO_2026_3RD = 1_790_122_869_000;

/**
 * 「TDO事務局検証作業用」(`t_Aq5m_2340`, status 25, created 2025-10-31 — inside TDO's checked
 * date range): its doubles slots have the same `schid`s as the season and carry 180-point
 * high-in records, which no double-in start can make. The real case of a same-slot contradiction.
 */
export const TDO_TEST_TOURNAMENT = { tournamentId: 't_Aq5m_2340', startedAt: 1_761_884_042_000 } as const;
export const HIGH_IN_TDO_TEST_TOURNAMENT = expand('5ywh:180 5ywh:180 5ywh:180 5ywh:180 kwgs:180 kwgs:180 kwgs:180 kwgs:180 5ywh:120');
/** ATDO 2024 2nd (`t_kY1n_6823`): its league-list `createTime`, inside ATDO's checked range. */
export const STARTED_AT_ATDO_2024_2ND = 1_720_440_506_000;
