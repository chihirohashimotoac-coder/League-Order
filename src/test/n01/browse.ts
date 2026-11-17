/**
 * 観戦の「n01オンライン・n01トーナメント・n01リーグ」一覧のテスト用フィクスチャ (架空のデータ、通信なし)。
 * vitest と e2e (e2e/browseWorld.ts) が同じ応答を使う。
 *
 * 応答の形は 2026-11-17 に公開 API で確認したもの: `tournament/list`・`league/list` は `list` に
 * 更新の新しい順、`match/list` (オンライン) は開始の新しい順。n01 は全体の件数を返さない。
 *
 * 含めるもの: 英字・日本語・キリル文字・長い名前、同じ名前で ID が違う大会、2 ページ目の先頭に 1 ページ目の
 * 行が再び来る (ページの間に順位が動いた) 重複、`lgid` を持つ大会、開催日時が未登録 (0) の大会、
 * オンラインの一覧に紛れた大会の試合 (`tdid`) と現地中継 (`relayMode`)。
 */

export const BROWSE_JDO_EVENT = 't_Jdo0_0001';
export const BROWSE_JDO_LEAGUE = 'lg_Jdo0_0001';
export const BROWSE_ATDO = 'lg_l3hI_3397';
const NOW_MS = 1_800_000_000_000;

const T_TITLES = [
  'Sample Open メンズシングルス',
  'Самбар-26',
  'BeNe play  dinsdag  17/11',
  'Хантайшир самбар',
  '東京オープン ダーツトーナメント 2026 メンズシングルス 予選ラウンド ブロックA (長い名前の表示確認)',
  'Weekly Cup',
  'Weekly Cup',
  'Nexus 11.17',
  'ДДК самбарын тэмцээн',
  'Warm-up 2',
];
const STATUSES = [30, 30, 20, 30, 10, 30, 40, 25, 30, 40];

export interface RawTournament {
  tdid: string;
  title: string;
  status: number;
  lgid?: string;
  t_date: number;
  updateTime: number;
}

/** `tournament/list` の公式初期表示に相当する並び (更新の新しい順)。45 件 = 30 + 15。 */
export function browseTournamentRows(count = 45): RawTournament[] {
  return Array.from({ length: count }, (_, index) => {
    if (index === 0) return { tdid: BROWSE_JDO_EVENT, title: T_TITLES[0], status: 30, lgid: BROWSE_JDO_LEAGUE, t_date: 1_799_990_000, updateTime: NOW_MS - 1_000 };
    const title = index < T_TITLES.length ? T_TITLES[index] : `Open Event ${String(index).padStart(2, '0')}`;
    return {
      tdid: `t_Brw${String(index).padStart(2, '0')}_${1000 + index}`,
      title,
      status: STATUSES[index % STATUSES.length],
      ...(index === 3 ? { lgid: 'lg_Brw0_0003' } : {}),
      // 開催日時が未登録の大会 (0) を混ぜる。
      t_date: index % 4 === 2 ? 0 : 1_799_990_000 + index * 60,
      updateTime: NOW_MS - 1_000 - index * 7_000,
    };
  });
}

export interface RawLeague {
  lgid: string;
  title: string;
  updateTime: number;
}

const L_TITLES = ['ATDO', 'Žemberovce 2026', '新潟DOリーグ', '東京ダーツオーガニゼイション【TDO / Tokyo Darts Organization】', 'ONLINE BATTLE', 'ЗАДХ, ОНЧ ДАРТС клуб, Анхдугаар ДАРТС ЛИГ I тэмцээн'];

/** `league/list` (リーグ団体単位・更新の新しい順)。35 件 = 30 + 5。 */
export function browseLeagueRows(count = 35): RawLeague[] {
  return Array.from({ length: count }, (_, index) => ({
    lgid: index === 0 ? BROWSE_ATDO : `lg_Brw${String(index).padStart(2, '0')}_${2000 + index}`,
    title: index < L_TITLES.length ? L_TITLES[index] : `League ${String(index).padStart(2, '0')}`,
    updateTime: NOW_MS - 2_000 - index * 9_000,
  }));
}

const side = (name: string, legs: number): Record<string, unknown> => ({ name, winLegs: legs, allScore: 300 + legs * 50, allDarts: 18 + legs * 3 });

/** 単独の進行中の試合 (n01 Online) の `mid`。e2e が詳細を開く。 */
export const ONLINE_MID = 'Onl0Demo_1799999990000';

/** オンライン (`match/list` live=1) の行。開始の新しい順。大会の試合と現地中継を 1 行ずつ混ぜる。 */
export function browseOnlineRows(): Record<string, unknown>[] {
  const base = 1_799_999_990;
  return [
    { mid: ONLINE_MID, match_type: '01', startTime: base, endMatch: 0, updateTime: NOW_MS - 3_000, statsData: [side('LL', 1), side('鈴木 ニムラ', 2)] },
    { mid: 'Onl1Demo_1799999900000', match_type: 'cricket', startTime: base - 90, endMatch: 0, updateTime: NOW_MS - 6_000, statsData: [side('Олег Чернышов', 0), side('marco nondato', 1)] },
    // 本来は条件で除かれる大会の試合: 応答に紛れても掲載しない。
    { mid: 'Trn0Demo_1799999800000', tdid: 't_Leak_0001', tmid: 't_Leak_0001_t_0_a_b', match_type: '01', title: 'Leak Cup 1回戦', startTime: base - 190, endMatch: 0, updateTime: NOW_MS - 7_000, statsData: [side('大会 選手A', 0), side('大会 選手B', 0)] },
    // 現地中継 (relayMode)。
    { mid: 'Rly0Demo_1799999700000', relayMode: 1, scid: 'scid_Rly0_1799999700000', match_type: '01', title: '', startTime: base - 290, endMatch: 0, updateTime: NOW_MS - 8_000, statsData: [side('Left Team', 0), side('Right Team', 1)] },
    { mid: 'Onl2Demo_1799999600000', match_type: '01', startTime: base - 390, endMatch: 0, updateTime: NOW_MS - 9_000, statsData: [side('Patje COBRA (cam please)', 3), side('Jiggen Sisor', 2)] },
    { mid: 'Onl3Demo_1799999500000', match_type: '01', startTime: base - 490, endMatch: 0, updateTime: NOW_MS - 10_000, statsData: [side('青木 一郎', 0), side('Axel Strömberg', 0)] },
  ];
}

export interface BrowseReplyOptions {
  /** このカテゴリの読み込みを失敗させる (n01 がエラーを返す)。 */
  fail?: Partial<Record<'online' | 'tournament' | 'league', boolean>>;
}

const page = <T,>(rows: T[], params: Record<string, string>): T[] => {
  const skip = Number(params.skip ?? 0);
  const count = Number(params.count ?? 100);
  return rows.slice(skip, skip + count);
};

const matches = (title: string, keyword: string | undefined): boolean => !keyword || keyword.split(/\s+/u).every((word) => title.toLowerCase().includes(word.toLowerCase()));

/**
 * 3 つの一覧の応答。該当しない読み込みは `undefined` (呼び出し側が他の応答に回す)。2 ページ目の先頭は、
 * 1 ページ目の最後の行が再び来る (ページを読む間に更新順が動いた n01 と同じ重なり)。
 */
export function browseReply(operation: string, params: Record<string, string>, options: BrowseReplyOptions = {}): unknown {
  if (operation === 'tournament/list' && params.sort === 'updateTime' && params.league__ne === '1') {
    if (options.fail?.tournament) return { result: -54, error: 'query too slow' };
    const rows = browseTournamentRows().filter((row) => matches(row.title, params.keyword));
    const skip = Number(params.skip ?? 0);
    const list = skip > 0 ? [rows[skip - 1], ...page(rows, params)].slice(0, Number(params.count)) : page(rows, params);
    return { result: 0, list };
  }
  if (operation === 'league/list' && params.sort === 'updateTime') {
    if (options.fail?.league) return { result: -54, error: 'query too slow' };
    const rows = browseLeagueRows().filter((row) => matches(row.title, params.keyword));
    const skip = Number(params.skip ?? 0);
    const list = skip > 0 ? [rows[skip - 1], ...page(rows, params)].slice(0, Number(params.count)) : page(rows, params);
    return { result: 0, list };
  }
  if (operation === 'match/list' && params.live === '1' && params.tdid__exists === '0' && params.relayMode__exists === '0') {
    if (options.fail?.online) return { result: -54, error: 'query too slow' };
    return { result: 0, list: page(browseOnlineRows(), params) };
  }
  // The online game, read by its id (archive first: not there until it ends; then the live list).
  if (operation === 'match/list' && params.mid === ONLINE_MID) return { result: 0, list: params.live === '1' ? [browseOnlineRows()[0]] : [] };
  if (operation === 'match/live' && params.mid === ONLINE_MID) {
    return {
      result: 0,
      changed: 1,
      mid: ONLINE_MID,
      title: '',
      match_type: '01',
      updateTime: NOW_MS - 3_000,
      end_match: 0,
      end_schedule: 0,
      format: { limit_leg: 3, limit_set: 1, start_score: 501, draw_mode: 0 },
      sets: [0, 0],
      show_sets: 0,
      legs: [1, 2],
      current_set: 0,
      current_leg: 3,
      leg_count: 4,
      players: [{ name: 'LL' }, { name: '鈴木 ニムラ' }],
      stats: [{ avg: 50.1, score: 1002, darts: 60 }, { avg: 55.2, score: 1104, darts: 60 }],
      leg: { leg: 3, first: 1, end: 0, winner: null, time: NOW_MS - 3_000, thrower: 0, round: 2, throws: [], start: [501, 501], left: [501, 501], darts: [0, 0], scored: [0, 0] },
    };
  }
  if (operation === 'match/throws' && params.mid === ONLINE_MID) return { result: 0, changed: 1, mid: ONLINE_MID, match_type: '01', end_match: 0, updateTime: NOW_MS - 3_000, leg_data: [] };
  return undefined;
}
