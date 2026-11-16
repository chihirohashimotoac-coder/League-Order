import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { AnalyticsApi } from './api/readApi';
import type { AnalyticsTransport } from './api/readApi';
import { parseGameList } from './api/parse';
import { AnalyticsCache } from './cache/analyticsCache';
import { aggregatePlayers, aggregateTeams } from './aggregate';
import { projectSeasons } from './projection';
import type { SeasonGames } from './roleGames';
import { buildSeasonData } from './seasonData';
import type { SeasonData } from './seasonData';
import { needsRetry, reconstructPerson } from './service/detailService';
import { emptyLoad } from './service/periodService';
import type { PeriodLoad } from './service/periodService';
import type { PeriodStart } from './startRate';
import { line, playerRow, roster, season, simpleLine, teamRow, tournament } from './testFixtures';
import type { SlotEvidence } from './gameKind';
import { LoadGauge } from './ui/LoadGauge';
import { PlayerAnalytics } from './ui/PlayerAnalytics';
import type { Team } from '../../domain/types';
import { AnalysisSummary, StartRateCard } from './ui/scopeParts';
import type { GamesState } from './ui/useRoleData';

/**
 * Audit 2026-11-16 (League Order 分析の欠損・誤集計): ③ a game row whose throwing order n01 left
 * out, ⑤ the season's roster and the proof that an id names one person, ⑥ the common range of a
 * multi-season period, ⑦ ダブルイン成功率, ⑧ the loading gauge. ①②④ are in `realData.akdo.test.ts`.
 */

afterEach(cleanup);

// ---- ③ ------------------------------------------------------------------------------------------

const TD = 't_wOVS_6783';
/** The three real TDA 2026年度 前期 rows (2026-11-16) of B division, team sA9C without its order (names replaced). */
const DEFECT_ROWS = [
  { mid: 'Igtg4WOy_1776167732037', tdid: TD, tmid: `${TD}_lg_1_kotl_PJP3_sA9C`, schid: 'ykby', endMatch: 1, statsData: [{ tpid: 'PJP3', order: [{ oid: 'jr1r', opid: 't-1', oname: '選手A' }], winLegs: 2, allScore: 0, allDarts: 0 }, { tpid: 'sA9C', order: null, winLegs: 0, allScore: 0, allDarts: 0 }] },
  { mid: 'JEoiso7d_1776165678204', tdid: TD, tmid: `${TD}_lg_1_kotl_PJP3_sA9C`, schid: 'ckrs', endMatch: 1, statsData: [{ tpid: 'PJP3', order: ['jr1r', 'hsk7', 't5mf', 'dba9'].map((oid) => ({ oid, opid: `t-${oid}`, oname: oid })), winLegs: 1, allScore: 0, allDarts: 0 }, { tpid: 'sA9C', order: null, winLegs: 0, allScore: 0, allDarts: 0 }] },
  { mid: '2wp5gIvb_1776165577276', tdid: TD, tmid: `${TD}_lg_1_kotl_PJP3_sA9C`, schid: 'uoc9', endMatch: 1, statsData: [{ tpid: 'PJP3', order: [{ oid: 'hsk7', opid: 't-hsk7', oname: '選手B' }, { oid: 't5mf', opid: 't-t5mf', oname: '選手C' }], winLegs: 1, allScore: 1424, allDarts: 113 }, { tpid: 'sA9C', order: null, winLegs: 2, allScore: 1473, allDarts: 110 }] },
];
const singlesRow = (mid: string, a: string, oa: string, b: string, ob: string, legs: [number, number], division = 0) => ({
  mid,
  tdid: TD,
  tmid: `${TD}_lg_${division}_x_${a}_${b}`,
  schid: 'ykby',
  endMatch: 1,
  statsData: [
    { tpid: a, order: [{ oid: oa, opid: `t-${oa}`, oname: oa }], winLegs: legs[0], allScore: 600, allDarts: 30 },
    { tpid: b, order: [{ oid: ob, opid: `t-${ob}`, oname: ob }], winLegs: legs[1], allScore: 500, allDarts: 30 },
  ],
});

function tdaSeason(): SeasonData {
  const t = tournament(TD, [
    { id: 'DRZ', name: 'ドリズ', division: 0 },
    { id: 'OPP', name: 'Opp', division: 0 },
    { id: 'PJP3', name: 'Hurricane', division: 1 },
    { id: 'sA9C', name: 'side-R', division: 1 },
  ]);
  const slot = (schid: string, numPart: number): SlotEvidence => ({ schid, division: null, numPart, subtitle: schid, startScore: 501, limitLegCount: 2, matchType: '01', settingMatchType: null });
  return buildSeasonData(
    season({
      tournament: t,
      slots: [slot('ykby', 1), slot('uoc9', 2), slot('ckrs', 4)],
      playerStats: [
        playerRow('d1', 'op-d1', 'DRZ', 'D1', simpleLine(600, 30, 2, 3)),
        playerRow('o1', 'op-o1', 'OPP', 'O1', simpleLine(500, 30, 1, 3)),
        playerRow('jr1r', 'op-jr1r', 'PJP3', 'J', simpleLine(600, 30, 2, 2)),
        playerRow('s1', 'op-s1', 'sA9C', 'S1', simpleLine(500, 30, 1, 3)),
      ],
    }),
  );
}

describe('③ a row whose throwing order n01 left out (TDA 2026年度 前期)', () => {
  it('is kept with its teams, legs and totals; a row without any team is still unreadable', () => {
    const page = parseGameList({ result: 0, list: [...DEFECT_ROWS, { mid: 'noTeams', schid: 'ykby', endMatch: 1, statsData: [{ order: null, winLegs: 1 }, { order: null, winLegs: 0 }] }] });
    expect(page.games.map((g) => g.gameId)).toEqual(DEFECT_ROWS.map((r) => r.mid));
    expect(page.unreadable).toBe(1);
    const doubles = page.games[2];
    expect(doubles.missingOrder).toEqual([false, true]);
    expect(doubles.sides[1]).toMatchObject({ teamId: 'sA9C', players: [], legsWon: 2, score: 1473, darts: 110 });
  });

  it('only side-R’s players are held; its team results and every other team and player count', () => {
    const s = tdaSeason();
    const page = parseGameList({ result: 0, list: [...DEFECT_ROWS, singlesRow('g1', 'DRZ', 'd1', 'OPP', 'o1', [2, 1]), singlesRow('g2', 'sA9C', 's1', 'PJP3', 'jr1r', [1, 2], 1)] });
    const games: SeasonGames = { tournamentId: TD, games: page.games, dropped: { unfinished: 0, unreadable: 0, nonLeague: 0 }, complete: true };
    const source = { games: new Map([[TD, games]]), failed: new Set<string>() };
    const singles = projectSeasons([s], 'singles', source);
    const players = new Map(singles.seasons[0].players.map((p) => [p.oid, p.line]));
    expect(players.get('d1')).toMatchObject({ score: 600, darts: 30, leg: 3, winLeg: 2 });
    expect(players.get('jr1r')).toMatchObject({ leg: 5, winLeg: 4 }); // its own known games, the defect row included
    expect(players.get('s1')!.leg).toBeNull(); // held: one of side-R's singles games has no thrower
    const teams = new Map(singles.seasons[0].teams.map((t) => [t.teamId, t.line]));
    expect(teams.get('sA9C')).toMatchObject({ leg: 5, winLeg: 1, set: 2, winSet: 0 }); // the team's results count
    expect(singles.adoption[0].held).toEqual([expect.objectContaining({ teamId: 'sA9C', players: true, team: false, games: 1 })]);
    expect(singles.adoption[0].metrics.legSet.state).toBe('recomputed');
    // A multi-season pool keeps ドリズ's season (A division is not affected).
    expect(aggregatePlayers(singles.seasons).find((p) => p.seasons[0].teamId === 'DRZ')!.metrics.legRate).toMatchObject({ num: 2, den: 3 });
    // The doubles view: side-R's pair game holds its players there too, its team keeps 2 legs won.
    const doubles = projectSeasons([s], 'doubles', source);
    expect(doubles.seasons[0].teams.find((t) => t.teamId === 'sA9C')!.line).toMatchObject({ leg: 3, winLeg: 2, score: 1473, darts: 110 });
    expect(aggregateTeams(doubles.seasons).find((t) => t.name === 'Hurricane')!.metrics.legRate).toMatchObject({ num: 1, den: 3 });
  });

  it('a player of side-R is not checked against n01 (their games are not known), no retry is offered for it, and their own singles legs still count', async () => {
    const s = tdaSeason();
    // 選手 s1's own singles game: one leg, s1 threw first (50, 50, 50), jr1r checked out 501 in 9 darts.
    const g2 = { mid: 'g2', tdid: TD, tmid: `${TD}_lg_1_x_sA9C_PJP3`, schid: 'ykby', endMatch: 1, statsData: [{ tpid: 'sA9C', order: [{ oid: 's1', opid: 't-s1', oname: 's1' }], winLegs: 0, allScore: 150, allDarts: 9 }, { tpid: 'PJP3', order: [{ oid: 'jr1r', opid: 't-jr1r', oname: 'jr1r' }], winLegs: 1, allScore: 501, allDarts: 9 }] };
    const detail = { result: 0, match: { ...g2, startScore: 501, legData: [{ first: 0, winner: 1, endFlag: 1, playerData: [[{ score: 0, left: 501 }, { score: 50, left: 451 }, { score: 50, left: 401 }, { score: 50, left: 351 }], [{ score: 0, left: 501 }, { score: 180, left: 321 }, { score: 180, left: 141 }, { score: -3, left: 0 }]] }] } };
    const page = parseGameList({ result: 0, list: [...DEFECT_ROWS, g2] });
    const games = new Map([[TD, { tournamentId: TD, games: page.games, dropped: { unfinished: 0, unreadable: 0, nonLeague: 0 }, complete: true } satisfies SeasonGames]]);
    const asked: string[] = [];
    const transport: AnalyticsTransport = {
      request: async (operation, params) => {
        asked.push(operation);
        if (operation === 'match/get' && params.mid === 'g2') return detail;
        throw new Error(`unexpected ${operation}`);
      },
    };
    const me = s.players.find((p) => p.oid === 's1')!;
    const result = await reconstructPerson({ api: new AnalyticsApi({ transport, maxRequests: 60 }), cache: new AnalyticsCache({ memoryOnly: true }), isOnline: () => true, now: () => Date.now() }, { seasons: [s], games, personKey: me.personKey });
    expect(asked).toEqual(['match/get']); // no n01 totals, no high-in records: nothing to check them with
    expect(result.checks[0]).toMatchObject({ state: 'incomplete', byRecord: true, reason: expect.stringContaining('投順が記録されていない') });
    expect(needsRetry(result)).toBe(false);
    expect(result.contributions.get('g2')?.get('s1')).toMatchObject({ score: 150, darts: 9, f9Score: 150, f9Darts: 9, breakLegs: 0 });
    // The singles view still holds s1 (side-R's missing singles game may be theirs); the legs wait in the result.
    expect(projectSeasons([s], 'singles', { games, failed: new Set() }, result.contributions).seasons[0].players.find((p) => p.oid === 's1')!.line.f9Score).toBeNull();
  });
});

// ---- ⑤ ------------------------------------------------------------------------------------------

describe('⑤ the season roster: who is registered, and when an id names one person', () => {
  const t = tournament('s1', [
    { id: 'MCB', name: 'MC-B', division: 0 },
    { id: 'OTH', name: 'Other', division: 0 },
    { id: 'BYE', name: 'bye', division: 0 },
  ]);
  const standings = [{ divisionIndex: 0, title: 'A', rows: [{ teamId: 'MCB', name: 'MC-B', rank: 1, played: 3, won: 2, drawn: 0, lost: 1, points: 4 }, { teamId: 'OTH', name: 'Other', rank: 2, played: 3, won: 1, drawn: 0, lost: 2, points: 2 }, { teamId: 'BYE', name: 'bye', rank: 0, played: 0, won: 0, drawn: 0, lost: 0, points: 0 }] }];
  const rows = [
    { oid: 'h1', opid: '112', team: 'MCB', name: 'Hiraga' },
    { oid: 'x1', opid: '200', team: 'MCB', name: 'Former' },
    { oid: 'o1', opid: '300', team: 'OTH', name: 'Other1' },
    // A team n01 returns that the tournament does not list, repeating ids under other oids.
    { oid: 'h9', opid: '112', team: 'ZZZ', name: 'Hiraga' },
    { oid: 'o9', opid: '300', team: 'ZZZ', name: 'Other1' },
  ];
  const stats = [playerRow('h1', '112', 'MCB', 'Hiraga', simpleLine(900, 50, 2, 4)), playerRow('o1', '300', 'OTH', 'Other1', simpleLine(800, 50, 1, 4))];

  it('rows of unregistered teams and an empty bye entry (no roster, no stats, 0 played) do not hide anyone: ids link', () => {
    const data = buildSeasonData(season({ tournament: t, roster: roster(rows), playerStats: stats, standings }));
    expect(data.emptyEntries).toEqual(['BYE']);
    expect(data.coverage?.complete).toBe(true);
    expect(data.players.find((p) => p.oid === 'h1')).toMatchObject({ linkable: true, personKey: 'opid:112' });
    // The season's registered roster, former members without a stats row included.
    expect(data.roster?.filter((r) => r.teamId === 'MCB').map((r) => r.oid)).toEqual(['h1', 'x1']);
  });

  it('a team merely missing from the roster (it played) still proves nothing; a real duplicate stays shared', () => {
    const played = standings.map((g) => ({ ...g, rows: g.rows.map((r) => (r.teamId === 'BYE' ? { ...r, played: 1 } : r)) }));
    expect(buildSeasonData(season({ tournament: t, roster: roster(rows), playerStats: stats, standings: played })).players.find((p) => p.oid === 'h1')!.linkable).toBe(false);
    const dup = [...rows, { oid: 'h2', opid: '112', team: 'OTH', name: 'Hiraga' }];
    expect(buildSeasonData(season({ tournament: t, roster: roster(dup), playerStats: stats, standings })).players.find((p) => p.oid === 'h1')!.linkable).toBe(false);
  });
});

describe('⑤ 指定季: the player list is that season’s registered roster', () => {
  const t = tournament('s_past', [
    { id: 'MCB', name: 'MC-B', division: 0 },
    { id: 'OTH', name: 'Other', division: 0 },
  ]);
  const data = buildSeasonData(
    season({
      tournament: t,
      roster: roster([
        { oid: 'h1', opid: '112', team: 'MCB', name: 'Hiraga' },
        { oid: 'x1', opid: '200', team: 'MCB', name: 'Former' },
        { oid: 'o1', opid: '112b', team: 'OTH', name: 'Hiraga' },
      ]),
      playerStats: [playerRow('h1', '112', 'MCB', 'Hiraga', simpleLine(900, 50, 2, 4)), playerRow('o1', '112b', 'OTH', 'Hiraga', simpleLine(300, 50, 0, 4))],
    }),
  );
  const team = { id: 'team1', name: 'MC-B', createdAt: 0, n01: { provider: 'n01', leagueId: 'lg', leagueTitle: 'L', stableIdentity: { kind: 'name', value: 'mc-b' }, lastTournamentId: 's_now', lastTournamentTitle: 'now', lastTeamId: 'NOW', lastTeamName: 'MC-B', lastDivisionIndex: 0, lastDivisionTitle: 'A', discipline: 'SOFT', managedFormatId: null, linkedAt: 0, lastSuccessfulSyncAt: 0 } } as unknown as Team;

  it('lists everyone registered (a former member without a stats row is 出場なし) and opens that season’s own player — not the namesake of another team', () => {
    const load: PeriodLoad = { ...emptyLoad({ mode: 'specified', currentTournamentId: 's_now', specifiedTournamentId: 's_past' }, {}), seasons: [data], complete: true };
    render(<PlayerAnalytics team={team} players={[]} load={load} baseTournamentId="s_past" />);
    const rows = screen.getAllByRole('button').filter((b) => b.classList.contains('list-row'));
    expect(rows.map((r) => r.textContent)).toEqual([expect.stringContaining('Hiraga'), expect.stringContaining('成績記録なし')]);
    expect(rows[0].textContent).toContain('3DA 54.00');
    expect((rows[1] as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByTestId('season-roster-note').textContent).toContain('MC-B');
    expect(screen.getByTestId('analytics-detail').textContent).toContain('Hiraga');
  });

  it('with the season’s whole game list read, a member with no game is 出場なし (not a missing record)', () => {
    const load: PeriodLoad = { ...emptyLoad({ mode: 'specified', currentTournamentId: 's_now', specifiedTournamentId: 's_past' }, {}), seasons: [data], complete: true };
    const games = new Map([['s_past', { tournamentId: 's_past', games: parseGameList({ result: 0, list: [{ mid: 'm1', tmid: 's_past_lg_0_x_MCB_OTH', schid: 's1', endMatch: 1, statsData: [{ tpid: 'MCB', order: [{ oid: 'h1' }], winLegs: 2, allScore: 900, allDarts: 50 }, { tpid: 'OTH', order: [{ oid: 'o1' }], winLegs: 0, allScore: 300, allDarts: 50 }] }] }).games, dropped: { unfinished: 0, unreadable: 0, nonLeague: 0 }, complete: true } satisfies SeasonGames]]);
    const role = { scope: 'all01' as const, adoption: [], games: gamesState(['s_past'], games), detail: { running: null, results: new Map(), contributions: new Map(), partial: new Set<string>(), run: () => undefined, focus: () => undefined, ensure: () => undefined } };
    render(<PlayerAnalytics team={team} players={[]} load={load} baseTournamentId="s_past" role={role} />);
    const rows = screen.getAllByRole('button').filter((b) => b.classList.contains('list-row'));
    expect(rows[1].textContent).toContain('出場なし');
  });
});

// ---- ⑥ ⑦ ⑧ --------------------------------------------------------------------------------------

function seasons(n: number): SeasonData[] {
  return Array.from({ length: n }, (_, i) => buildSeasonData(season({ tournament: tournament(`s${i}`, [{ id: 'A', name: 'A' }]), teamStats: [teamRow('A', line({ score: 600, darts: 30, leg: 2, winLeg: 1, set: 1, winSet: 1 }))] })));
}

const gamesState = (needed: string[], games: Map<string, SeasonGames>, failed = new Set<string>()): GamesState => ({
  status: 'done',
  load: { games, failed, failures: [], usedStaleCache: false, requestsSent: 0, pending: new Set(), progress: new Map(), units: 1 },
  needed,
  retry: () => undefined,
});

describe('⑥ the common range of a multi-season period', () => {
  it('TDO-like: 直近12季 of a league with 5 seasons → 対象5季・5季取得済み, nothing reported missing', () => {
    const list = seasons(5);
    const load: PeriodLoad = { ...emptyLoad({ mode: 'last12', currentTournamentId: 's0' }, {}), seasons: list, available: 5, complete: true, window: list.map((s) => ({ tournamentId: s.tournamentId, title: s.title, state: 'loaded' as const })) };
    const projection = projectSeasons(list, 'all01', { games: new Map(), failed: new Set() });
    render(<AnalysisSummary load={load} projection={projection} scope="all01" games={gamesState([], new Map())} />);
    expect(screen.getByTestId('summary-range').textContent).toBe('対象5季・5季取得済み');
    expect(screen.queryByTestId('summary-missing')).toBeNull();
    expect(screen.getByTestId('summary-fewer').textContent).toContain('このリーグの対象シーズンは5季');
  });

  it('TDA-like: 9 seasons, game lists of 7 → 対象9季・ゲーム記録7季分で集計', () => {
    const list = seasons(9);
    const games = new Map(list.slice(0, 7).map((s) => [s.tournamentId, { tournamentId: s.tournamentId, games: [], dropped: { unfinished: 0, unreadable: 0, nonLeague: 0 }, complete: true } satisfies SeasonGames]));
    const failed = new Set(list.slice(7).map((s) => s.tournamentId));
    const load: PeriodLoad = { ...emptyLoad({ mode: 'last12', currentTournamentId: 's0' }, {}), seasons: list, available: 9, complete: true, window: list.map((s) => ({ tournamentId: s.tournamentId, title: s.title, state: 'loaded' as const })) };
    const projection = projectSeasons(list, 'singles', { games, failed });
    render(<AnalysisSummary load={load} projection={projection} scope="singles" games={gamesState(list.map((s) => s.tournamentId), games, failed)} />);
    expect(screen.getByTestId('summary-range').textContent).toBe('対象9季・ゲーム記録7季分で集計');
  });
});

describe('⑦ ダブルイン成功率', () => {
  const start = (p: Partial<PeriodStart>): PeriodStart => ({ state: 'value', attempts: 0, successes: 0, value: null, partial: false, counted: 1, legs: 1, doublesGames: 1, excludedGames: {}, excludedLegs: {}, seasonsMissing: [], ruleNotes: [], highInAgreements: 0, ...p });
  it('66.7%（6/9スロー）, 0.0%（0/4スロー） and 試技なし — never 0% for no attempt', () => {
    const { rerender } = render(<StartRateCard start={start({ attempts: 9, successes: 6, value: 6 / 9 })} pendingText={null} />);
    const card = (): string => screen.getByTestId('metric-ダブルイン成功率').textContent ?? '';
    expect(card()).toContain('ダブルイン成功率');
    expect(card()).toContain('66.7%');
    expect(card()).toContain('6/9スロー');
    rerender(<StartRateCard start={start({ attempts: 4, successes: 0, value: 0 })} pendingText={null} />);
    expect(card()).toContain('0.0%');
    expect(card()).toContain('0/4スロー');
    rerender(<StartRateCard start={start({ state: 'no-trials', reason: '分母が0です' })} pendingText={null} />);
    expect(card()).toContain('試技なし');
    expect(card()).not.toContain('0.0%');
    rerender(<StartRateCard start={start({ state: 'rule-unknown', reason: 'ダブルインと確認できたゲーム枠の出場がないため算出しません' })} pendingText={null} />);
    expect(card()).toContain('ルール不明');
    rerender(<StartRateCard start={null} pendingText="Leg明細を取得中…" />);
    expect(card()).toContain('取得待ち');
  });
});

describe('⑧ the loading gauge', () => {
  it('a known size is a determinate bar with its count; an unknown one moves, without a value', () => {
    render(
      <LoadGauge
        stages={[
          { id: 'season', label: 'シーズン取得', state: 'done', count: { done: 3, total: 3, unit: '季' }, text: '' },
          { id: 'games', label: 'ゲーム一覧取得', state: 'running', count: { done: 1, total: 3, unit: '季' }, text: '取得中' },
          { id: 'legs', label: 'Leg明細の照合', state: 'running', count: null, text: '照合中' },
        ]}
        outcome={null}
        previous={null}
      />,
    );
    const bars = screen.getAllByRole('progressbar');
    expect(bars.map((b) => b.getAttribute('aria-label'))).toEqual(['シーズン取得', 'ゲーム一覧取得', 'Leg明細の照合']);
    expect(bars[1].getAttribute('aria-valuenow')).toBe('33');
    expect(bars[1].getAttribute('aria-valuetext')).toBe('取得中：1/3季');
    expect(bars[2].getAttribute('aria-valuenow')).toBeNull();
    expect(bars[2].className).toContain('indeterminate');
    expect(screen.getByTestId('load-gauge-live').textContent).toContain('ゲーム一覧取得：取得中 1/3季');
  });

  it('the same condition read again says the figures are the previous ones and when they were read; the end says partial', () => {
    const at = Date.UTC(2026, 10, 16, 0, 5); // 09:05 in Japan
    const { rerender } = render(<LoadGauge stages={[{ id: 'season', label: 'シーズン取得', state: 'running', count: null, text: '' }]} outcome={null} previous={at} />);
    expect(screen.getByTestId('load-gauge-previous').textContent).toContain('前回（09:05 取得）');
    rerender(<LoadGauge stages={[{ id: 'games', label: 'ゲーム一覧取得', state: 'partial', count: { done: 3, total: 3, unit: '季' }, text: '1季を取得できませんでした' }]} outcome={{ state: 'partial', at }} previous={null} />);
    expect(screen.getByTestId('load-gauge-outcome').textContent).toContain('部分集計');
    rerender(<LoadGauge stages={[{ id: 'season', label: 'シーズン取得', state: 'done', count: { done: 1, total: 1, unit: '季' }, text: '' }]} outcome={{ state: 'done', at }} previous={null} />);
    expect(screen.getByTestId('load-gauge').textContent).toBe('取得完了（09:05）');
  });
});
