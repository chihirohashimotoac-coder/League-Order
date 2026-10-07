import type { FixtureLeagueSpec, FixturePerson, FixtureTeamSpec, RawSlot } from './generator';
import { generateLeague, type GeneratedLeague } from './generator';

/**
 * Three fixture leagues shaped like the leagues League Order ships Quick Choices for.
 *
 * Test data only. The real leagues' seasons and teams are resolved live and are never
 * hard-coded in production code; these ids exist so the tests can tell the outcome.
 *
 * - **ATDO-like** (steel): four seasons, two divisions with a division-specific format,
 *   a five-team division (so every round has a bye), kalavinka moving up from B to A,
 *   a player transferring between teams, and a registered player with no stats. Today
 *   (2026-10-07) four rounds are played; the next fixture is kalavinka vs スピンコブラ.
 * - **TDO-like** (soft): two tournaments running at the same time; the team is in one.
 * - **TDA-like** (no `softdarts`): the current season is open for entry with nothing
 *   played; a player without an opid, two players with the same name, a zero-dart row.
 */

export const FIXTURE_TODAY = '2026-10-07';
/** 2026-10-07 12:00 JST. */
export const FIXTURE_NOW = Date.parse('2026-10-07T03:00:00Z');

const SURNAMES = ['青木', '石井', '上田', '大野', '岡田', '川口', '木村', '工藤', '小山', '斎藤', '坂本', '清水', '杉山', '田中', '千葉', '中島', '西村', '野口', '橋口', '原田', '平野', '福田', '藤井', '前田', '松井', '宮崎', '村上', '森', '安田', '山口'];
const GIVEN = ['翔太', '美穂', '健一', '彩', '直樹', '恵', '亮', '真央', '修', '舞'];

/** Builds `count` filler people for a team, with PPRs spread around `base`. */
function filler(people: Record<string, FixturePerson>, key: string, count: number, base: number, offset: number): string[] {
  const opids: string[] = [];
  for (let i = 0; i < count; i += 1) {
    const opid = `op_${key}_${i}`;
    const surname = SURNAMES[(offset + i * 7) % SURNAMES.length];
    const given = GIVEN[(offset * 3 + i) % GIVEN.length];
    people[opid] = { name: `${surname} ${given}`, ppr: Math.round((base + ((i * 37 + offset * 11) % 17) - 8) * 10) / 10 };
    opids.push(opid);
  }
  return opids;
}

function team(tpid: string, name: string, members: string[], benched?: string[]): FixtureTeamSpec {
  return { tpid, name, members, benched };
}

// ---------------------------------------------------------------------------
// ATDO-like
// ---------------------------------------------------------------------------

const ATDO_FORMAT = (prefix: string): RawSlot[] => [
  { schid: `${prefix}1`, num_part: 4, match_type: '01', start_score: 1001, limit_leg_count: 1, subtitle: 'Team' },
  { schid: `${prefix}2`, num_part: 2, match_type: '01', start_score: 501, limit_leg_count: 2 },
  { schid: `${prefix}3`, num_part: 1, match_type: '01', start_score: 501, limit_leg_count: 2 },
  { schid: `${prefix}4`, num_part: 1, match_type: '01', start_score: 501, limit_leg_count: 2 },
  { schid: `${prefix}5`, num_part: 2, match_type: '01', start_score: 501, limit_leg_count: 2 },
  { schid: `${prefix}6`, num_part: 1, match_type: '01', start_score: 501, limit_leg_count: 2 },
  { schid: `${prefix}7`, num_part: 1, match_type: '01', start_score: 501, limit_leg_count: 2 },
];

const ATDO_B_FORMAT = (prefix: string): RawSlot[] => [
  { schid: `${prefix}b1`, num_part: 2, match_type: 'cricket', limit_leg_count: 1 },
  { schid: `${prefix}b2`, num_part: 1, match_type: '01', start_score: 501, limit_leg_count: 2 },
  { schid: `${prefix}b3`, num_part: 1, match_type: '01', start_score: 501, limit_leg_count: 2 },
  { schid: `${prefix}b4`, num_part: 1, match_type: '01', start_score: 501, limit_leg_count: 2 },
  { schid: `${prefix}b5`, num_part: 3, match_type: '01', start_score: 701, limit_leg_count: 1 },
];

export function atdoSpec(): FixtureLeagueSpec {
  const people: Record<string, FixturePerson> = {
    op_hashimoto: { name: '橋本 千尋', ppr: 62 },
    op_sato: { name: '佐藤 健', ppr: 55 },
    op_suzuki: { name: '鈴木 美咲', ppr: 48 },
    op_takahashi: { name: '高橋 大輔', ppr: 58 },
    op_ito: { name: '伊藤 由佳', ppr: 44 },
    op_watanabe: { name: '渡辺 拓', ppr: 51 },
    op_nakamura: { name: '中村 蓮', ppr: 40 },
    op_yamamoto: { name: '山本 剛', ppr: 66 },
    op_tamura: { name: '田村 翔', ppr: 60 },
    op_kobayashi: { name: '小林 葵', ppr: 52 },
    op_kato: { name: '加藤 誠', ppr: 47 },
    op_yoshida: { name: '吉田 茜', ppr: 45 },
    op_matsumoto: { name: '松本 隼', ppr: 57 },
  };
  const kalavinka = ['op_hashimoto', 'op_sato', 'op_suzuki', 'op_takahashi', 'op_ito', 'op_watanabe'];
  const cobra = ['op_yamamoto', 'op_kobayashi', 'op_kato', 'op_yoshida', 'op_matsumoto'];
  const bulls = filler(people, 'bulls', 5, 54, 1);
  const nine = filler(people, 'nine', 6, 50, 2);
  const ton = filler(people, 'ton', 5, 49, 3);
  const red = filler(people, 'red', 5, 44, 4);
  const hat = filler(people, 'hat', 5, 42, 5);
  const phx = filler(people, 'phx', 6, 46, 6);
  const dbl = filler(people, 'dbl', 5, 40, 7);

  const current = {
    tournamentId: 't_ABvC_5234',
    title: '2026 3rd',
    status: 30 as const,
    startDate: '2026-09-10',
    schedule: ATDO_FORMAT('c'),
    gameSettings: [{ round: 1, schedule: ATDO_B_FORMAT('c') }],
    divisions: [
      {
        title: 'A',
        teams: [
          team('GpiQ', 'kalavinka', [...kalavinka, 'op_nakamura'], ['op_nakamura']),
          team('68wv', 'スピンコブラ', [...cobra, 'op_tamura']),
          team('BEyE', 'ブルズアイ', bulls),
          team('N9dt', 'ナインダーツ', nine),
          team('T180', 'トンエイティ', ton),
        ],
      },
      {
        title: 'B',
        teams: [
          team('Rbrl', 'レッドバレル', red),
          team('HtTk', 'ハットトリック', hat),
          team('Phnx', 'フェニックス', phx),
          team('DbTp', 'ダブルトップ', dbl),
        ],
      },
    ],
    rounds: [
      { date: '2026-09-10', pairs: [['GpiQ', 'BEyE'], ['68wv', 'N9dt'], ['T180', null], ['Rbrl', 'HtTk'], ['Phnx', 'DbTp']] },
      { date: '2026-09-17', pairs: [['GpiQ', 'N9dt'], ['BEyE', 'T180'], ['68wv', null], ['Rbrl', 'Phnx'], ['HtTk', 'DbTp']] },
      { date: '2026-09-24', pairs: [['GpiQ', 'T180'], ['68wv', 'BEyE'], ['N9dt', null], ['Rbrl', 'DbTp'], ['HtTk', 'Phnx']] },
      { date: '2026-10-01', pairs: [['GpiQ', null], ['68wv', 'T180'], ['N9dt', 'BEyE'], ['Rbrl', 'HtTk'], ['Phnx', 'DbTp']] },
      { date: '2026-10-08', pairs: [['GpiQ', '68wv'], ['T180', 'N9dt'], ['BEyE', null], ['Rbrl', 'Phnx'], ['HtTk', 'DbTp']] },
      { date: '2026-10-15', pairs: [['BEyE', 'GpiQ'], ['N9dt', '68wv'], ['T180', null], ['HtTk', 'Rbrl'], ['DbTp', 'Phnx']] },
    ] as { date: string; pairs: [string, string | null][] }[],
  };

  // Last season kalavinka was in B; 田村 played for ブルズアイ.
  const previous = (tournamentId: string, title: string, startDate: string, prefix: string, tags: string) => ({
    tournamentId,
    title,
    status: 40 as const,
    startDate,
    schedule: ATDO_FORMAT(prefix),
    gameSettings: [{ round: 1, schedule: ATDO_B_FORMAT(prefix) }],
    divisions: [
      {
        title: 'A',
        teams: [
          team(`${tags}cb`, 'スピンコブラ', cobra),
          team(`${tags}be`, 'ブルズアイ', [...bulls.slice(0, 4), 'op_tamura']),
          team(`${tags}n9`, 'ナインダーツ', nine),
          team(`${tags}rb`, 'レッドバレル', red),
        ],
      },
      {
        title: 'B',
        teams: [
          team(`${tags}kv`, 'kalavinka', kalavinka),
          team(`${tags}tn`, 'トンエイティ', ton),
          team(`${tags}ht`, 'ハットトリック', hat),
          team(`${tags}px`, 'フェニックス', phx),
        ],
      },
    ],
    intervalDays: 7,
  });

  return {
    leagueId: 'lg_l3hI_3397',
    title: 'ATDO',
    softdarts: 0,
    people,
    // As on real ATDO, no season has its t_date set: createTime alone orders them.
    seasons: [
      current,
      previous('t_ATp2_5101', '2026 2nd', '2026-05-07', 'p', 'P2'),
      previous('t_ATp1_4988', '2026 1st', '2026-02-05', 'q', 'P1'),
      previous('t_ATp0_4870', '2025 4th', '2025-11-06', 'r', 'P0'),
    ].map((season) => ({ ...season, noTDate: true })),
    seed: 3397,
    today: FIXTURE_TODAY,
    shape: 'n01',
  };
}

// ---------------------------------------------------------------------------
// TDO-like (soft; two tournaments running at once)
// ---------------------------------------------------------------------------

const TDO_FORMAT = (prefix: string): RawSlot[] => [
  { schid: `${prefix}1`, num_part: 1, match_type: '01', start_score: 501, limit_leg_count: 1 },
  { schid: `${prefix}2`, num_part: 1, match_type: 'cricket', limit_leg_count: 1 },
  { schid: `${prefix}3`, num_part: 2, match_type: '01', start_score: 701, limit_leg_count: 1 },
  { schid: `${prefix}4`, num_part: 2, match_type: 'cricket', limit_leg_count: 1 },
  { schid: `${prefix}5`, num_part: 4, match_type: '01', start_score: 1501, limit_leg_count: 1, subtitle: 'Gallon' },
];

export function tdoSpec(): FixtureLeagueSpec {
  const people: Record<string, FixturePerson> = {};
  const owls = filler(people, 'owls', 6, 70, 8);
  const comets = filler(people, 'comets', 5, 66, 9);
  const arrows = filler(people, 'arrows', 5, 64, 10);
  const tigers = filler(people, 'tigers', 5, 68, 11);
  const season = (tournamentId: string, title: string, status: 30 | 40, startDate: string, prefix: string, teams: FixtureTeamSpec[]) => ({
    tournamentId,
    title,
    status,
    startDate,
    schedule: TDO_FORMAT(prefix),
    divisions: [{ title: 'Premier', teams }],
    intervalDays: 7,
  });
  return {
    leagueId: 'lg_3qgW_6619',
    title: 'TDO',
    softdarts: 1,
    people,
    seasons: [
      season('t_TDtu_7001', '2026 秋 火曜', 30, '2026-09-08', 't', [
        team('Ow1t', 'ナイトオウルズ', owls),
        team('Cm1t', 'コメッツ', comets),
        team('Ar1t', 'アローズ', arrows),
      ]),
      season('t_TDth_7002', '2026 秋 木曜', 30, '2026-09-10', 'h', [
        team('Tg1h', 'タイガース', tigers),
        team('Cm1h', 'コメッツB', comets.slice(0, 4)),
      ]),
      season('t_TDsp_6900', '2026 春', 40, '2026-04-07', 's', [
        team('Ow0s', 'ナイトオウルズ', owls),
        team('Cm0s', 'コメッツ', comets),
        team('Tg0s', 'タイガース', tigers),
      ]),
    ],
    seed: 6619,
    today: FIXTURE_TODAY,
    shape: 'n01',
  };
}

// ---------------------------------------------------------------------------
// TDA-like (no softdarts; open season; identity edge cases)
// ---------------------------------------------------------------------------

export function tdaSpec(): FixtureLeagueSpec {
  const people: Record<string, FixturePerson> = {
    op_sato_a: { name: '佐藤 優', ppr: 50 },
    op_sato_b: { name: '佐藤 優', ppr: 41 },
    op_noid: { name: '匿名 太郎', ppr: 46, noOpid: true },
    op_zero: { name: '新人 花子', ppr: 30 },
  };
  const stars = ['op_sato_a', 'op_sato_b', 'op_noid', ...filler(people, 'stars', 3, 47, 12), 'op_zero'];
  const moons = filler(people, 'moons', 6, 45, 13);
  const suns = filler(people, 'suns', 5, 43, 14);
  return {
    leagueId: 'lg_Ev9v_7379',
    title: 'TDA',
    softdarts: null,
    people,
    seasons: [
      {
        tournamentId: 't_TAop_8101',
        title: '2026 Winter',
        status: 20,
        startDate: '2026-11-05',
        schedule: ATDO_FORMAT('w'),
        divisions: [{ title: '1部', teams: [team('St3w', 'スターズ', stars), team('Mn3w', 'ムーンズ', moons), team('Sn3w', 'サンズ', suns)] }],
        intervalDays: 7,
      },
      {
        tournamentId: 't_TAsu_8000',
        title: '2026 Summer',
        status: 40,
        startDate: '2026-06-04',
        schedule: ATDO_FORMAT('u'),
        divisions: [{ title: '1部', teams: [team('St2u', 'スターズ', stars.slice(0, 6)), team('Mn2u', 'ムーンズ', moons), team('Sn2u', 'サンズ', suns)] }],
        intervalDays: 7,
      },
    ],
    seed: 7379,
    today: FIXTURE_TODAY,
    zeroDarts: ['op_zero'],
  };
}

let cache: { atdo: GeneratedLeague; tdo: GeneratedLeague; tda: GeneratedLeague } | null = null;

/** The three leagues, generated once per process (generation is deterministic). */
export function fixtureLeagues(): { atdo: GeneratedLeague; tdo: GeneratedLeague; tda: GeneratedLeague } {
  if (!cache) {
    cache = { atdo: generateLeague(atdoSpec()), tdo: generateLeague(tdoSpec()), tda: generateLeague(tdaSpec()) };
  }
  return cache;
}

/** League search results served by the fixture server. */
export const FIXTURE_LEAGUE_SEARCH = [
  { lgid: 'lg_l3hI_3397', title: 'ATDO' },
  { lgid: 'lg_3qgW_6619', title: 'TDO' },
  { lgid: 'lg_Ev9v_7379', title: 'TDA' },
];
