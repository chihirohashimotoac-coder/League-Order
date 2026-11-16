import { act, cleanup, render, renderHook, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { AnalyticsApi } from './api/readApi';
import type { AnalyticsTransport } from './api/readApi';
import { AnalyticsSchemaError, parseGameDetail, parseGameList } from './api/parse';
import { AnalyticsCache } from './cache/analyticsCache';
import type { SlotEvidence } from './gameKind';
import AKDO_RAW from './realData.akdo.json';
import type { AkdoSnapshot } from './realData.akdo.fixtures';
import { classifyGames, linesFromGames } from './roleGames';
import type { SeasonGames } from './roleGames';
import { buildSeasonData } from './seasonData';
import { detailKey, reconstructTeam } from './service/detailService';
import { fingerprint } from './service/gamesLoader';
import type { GamesLoad } from './service/gamesSession';
import { emptyLoad } from './service/periodService';
import type { PeriodLoad } from './service/periodService';
import { periodStart } from './startRate';
import type { PeriodStart, SeasonStart } from './startRate';
import { season as seasonInput, tournament } from './testFixtures';
import { gaugeOutcomeOf, teamLegStage } from './ui/LoadGauge';
import { StartRateCard } from './ui/scopeParts';
import { useTeamDetail } from './ui/useRoleData';

/**
 * Follow-up of the 2026-11-16 audit (2026-11-17): 1. a missing team id is settled from the pair of
 * the `tmid`, never its position; 2. a side without its order is still compared with the list row;
 * 3. ダブルイン成功率's seasons and states; 4. the team read's phases and the gauge.
 */
afterEach(cleanup);

const SNAP = AKDO_RAW as unknown as AkdoSnapshot;
const REAL = '4SgVyGoI_1794310182072';

// ---- 1 ----------------------------------------------------------------------------------------------

describe('1. a missing team id is the other team of the tmid’s pair, not the tmid’s position', () => {
  it('the real AKDO row: tmid ends 5bve_9yvg, statsData is 9yvg, 5bve — and stays so with one id missing', () => {
    const row = SNAP.games.find((g) => g.mid === REAL)! as { tmid: string; statsData: Record<string, unknown>[] };
    expect(row.tmid.endsWith('5bve_9yvg')).toBe(true);
    expect(row.statsData.map((s) => s.tpid)).toEqual(['9yvg', '5bve']);
    for (const missing of [0, 1]) {
      const cut = { ...row, statsData: row.statsData.map((s, i) => (i === missing ? { ...s, tpid: undefined } : s)) };
      const [game] = parseGameList({ result: 0, list: [cut] }).games;
      expect(game.sides.map((s) => s.teamId)).toEqual(['9yvg', '5bve']);
      const detail = SNAP.details[REAL] as { match: { statsData: Record<string, unknown>[] } };
      const cutDetail = { ...detail, match: { ...detail.match, statsData: detail.match.statsData.map((s, i) => (i === missing ? { ...s, tpid: undefined } : s)) } };
      expect(parseGameDetail(cutDetail).sides.map((s) => s.teamId)).toEqual(['9yvg', '5bve']);
    }
  });

  const side = (tpid: string | undefined, score: number, darts: number, legs: number, order: unknown) => ({ ...(tpid ? { tpid } : {}), order, winLegs: legs, allScore: score, allDarts: darts });
  const AAAA = side('AAAA', 1602, 79, 1, null);

  it('the audit case: tmid AAAA_BBBB, statsData [BBBB, side without team and order] → that side is AAAA; BBBB keeps 1,002 / 40 and one set', () => {
    const row = { mid: 'x', tmid: 't_z_lg_0_q_AAAA_BBBB', schid: 's1', endMatch: 1, statsData: [side('BBBB', 1002, 40, 2, [{ oid: 'b1' }]), { ...AAAA, tpid: undefined }] };
    const [game] = parseGameList({ result: 0, list: [row] }).games;
    expect(game.sides.map((s) => s.teamId)).toEqual(['BBBB', 'AAAA']);
    expect(game.missingOrder).toEqual([false, true]);
    const s = buildSeasonData(seasonInput({ tournament: tournament('t_z', [{ id: 'AAAA', name: 'A' }, { id: 'BBBB', name: 'B' }]) }));
    const lines = linesFromGames(classifyGames(s, [game]), 'all01');
    expect(lines.teams.get('BBBB')).toMatchObject({ score: 1002, darts: 40, set: 1, winSet: 1 });
    expect(lines.teams.get('AAAA')).toMatchObject({ score: 1602, darts: 79, set: 1, winSet: 0 });
  });

  it('both ids missing, the same team on both sides, or a team outside the pair: unreadable in the list and in the legs', () => {
    const cases = [
      [{ ...AAAA, tpid: undefined }, side(undefined, 1002, 40, 2, null)],
      [side('BBBB', 1002, 40, 2, [{ oid: 'b1' }]), side('BBBB', 1602, 79, 1, [{ oid: 'b2' }])],
      [side('CCCC', 1002, 40, 2, [{ oid: 'c1' }]), { ...AAAA, tpid: undefined }],
      [side('CCCC', 1002, 40, 2, [{ oid: 'c1' }]), side('AAAA', 1602, 79, 1, [{ oid: 'a1' }])],
    ];
    for (const statsData of cases) {
      const page = parseGameList({ result: 0, list: [{ mid: 'x', tmid: 't_z_lg_0_q_AAAA_BBBB', schid: 's1', endMatch: 1, statsData }] });
      expect(page.games).toHaveLength(0);
      expect(page.unreadable).toBe(1);
      expect(() => parseGameDetail({ result: 0, match: { mid: 'x', tmid: 't_z_lg_0_q_AAAA_BBBB', statsData, legData: [] } })).toThrow(AnalyticsSchemaError);
    }
  });
});

// ---- 2 ----------------------------------------------------------------------------------------------

const TD = 't_side';
const slot: SlotEvidence = { schid: 'd1', division: null, numPart: 2, subtitle: 'ダブルス1', startScore: 501, limitLegCount: 1, matchType: '01', settingMatchType: null };
const s2 = buildSeasonData(seasonInput({ tournament: tournament(TD, [{ id: 'T1', name: 'One' }, { id: 'T2', name: 'Two' }]), slots: [slot] }));
/** One leg: T1 threw first (60, 60, 60 = 180 in 9 darts), T2 checked out 501 in 9 darts. Neither side has its order. */
const listRow = (t1Score = 180) => ({ mid: 'g1', tdid: TD, tmid: `${TD}_lg_0_q_T1_T2`, schid: 'd1', endMatch: 1, statsData: [{ tpid: 'T1', order: null, winLegs: 0, allScore: t1Score, allDarts: 9 }, { tpid: 'T2', order: null, winLegs: 1, allScore: 501, allDarts: 9 }] });
const detail = (visit = 60) => ({
  result: 0,
  match: {
    ...listRow(visit * 3),
    startScore: 501,
    legData: [{ first: 0, winner: 1, endFlag: 1, playerData: [[{ score: 0, left: 501 }, { score: visit, left: 501 - visit }, { score: visit, left: 501 - 2 * visit }, { score: visit, left: 501 - 3 * visit }], [{ score: 0, left: 501 }, { score: 180, left: 321 }, { score: 180, left: 141 }, { score: -3, left: 0 }]] }],
  },
});

async function teamRead(list: ReturnType<typeof listRow>, wire: unknown, cache = new AnalyticsCache({ memoryOnly: true })) {
  const games = new Map([[TD, { tournamentId: TD, games: parseGameList({ result: 0, list: [list] }).games, dropped: { unfinished: 0, unreadable: 0, nonLeague: 0 }, complete: true } satisfies SeasonGames]]);
  const asked: string[] = [];
  const transport: AnalyticsTransport = { request: async (operation) => { asked.push(operation); return wire; } };
  const result = await reconstructTeam({ api: new AnalyticsApi({ transport, maxRequests: 60 }), cache, isOnline: () => true, now: () => Date.now() }, { seasons: [s2], games, teams: new Map([[TD, 'T1']]), role: 'doubles', key: 'k' });
  return { result, asked, games };
}

describe('2. a side without its order is still checked against the list row; its side figures stand', () => {
  it('neither side has its order: the team’s First 9 and Keep/Break come from the legs that match the row', async () => {
    const { result } = await teamRead(listRow(), detail());
    expect(result.seasons[0]).toMatchObject({ games: 1, rebuilt: 1 });
    expect(result.contributions.get('g1')?.get('T1')).toEqual({ f9Score: 180, f9Darts: 9, breakLegs: 0, breakWins: 0 });
  });

  it('the list says 180 / 9, the legs say 240 / 9: the legs are not used (held, with the reason)', async () => {
    const { result } = await teamRead(listRow(180), detail(80));
    expect(result.seasons[0]).toMatchObject({ games: 1, rebuilt: 0 });
    expect(result.contributions.size).toBe(0);
  });

  it('an entry cached before side rows were kept (even with the row’s fingerprint) is read again, not reused', async () => {
    const cache = new AnalyticsCache({ memoryOnly: true });
    const [game] = parseGameList({ result: 0, list: [listRow(180)] }).games;
    // An old, inconsistent result: 240 / 9 rebuilt, no side rows, stored as if it were the row's.
    const old = { gameId: 'g1', ok: true, startScore: 501, perPlayer: {}, sides: [{ f9Score: 240, f9Darts: 9, breakLegs: 0, breakWins: 0 }, { f9Score: 501, f9Darts: 9, breakLegs: 1, breakWins: 1 }] };
    await cache.put(detailKey(TD), { v: 2, games: { g1: { r: old, at: Date.now(), fp: fingerprint(game) } } }, 60 * 60 * 1000);
    const { result, asked } = await teamRead(listRow(180), detail(60), cache);
    expect(asked).toEqual(['match/get']);
    expect(result.contributions.get('g1')?.get('T1')).toMatchObject({ f9Score: 180 });
  });
});

// ---- 3 ----------------------------------------------------------------------------------------------

describe('3. ダブルイン成功率: the seasons it uses, and why there is no figure', () => {
  const season = (p: Partial<SeasonStart>): SeasonStart => ({ tournamentId: 't', title: 't', doublesGames: 2, counted: 2, attempts: 3, successes: 2, legs: 2, excludedLegs: {}, excludedGames: {}, ruleNotes: [], highInAgreements: 0, ...p });

  it('the seasons with throws counted are the figure’s seasons; the card says 「3季分」 when that is not the common range', () => {
    const seasons = [season({}), season({}), season({}), ...Array.from({ length: 6 }, () => season({ counted: 0, attempts: 0, successes: 0, legs: 0, excludedGames: { 'rule-unknown': 2 } }))];
    const p = periodStart(seasons);
    expect(p).toMatchObject({ state: 'value', attempts: 9, successes: 6, seasonsCounted: 3 });
    render(<StartRateCard start={p} pendingText={null} seasonsUsed="3季分" />);
    expect(screen.getByTestId('metric-ダブルイン成功率').textContent).toContain('6/9スロー ・ 3季分');
  });

  it('straight-in only is 対象外, not ルール不明; an unknown rule, no attempt and a failed read are each their own state', () => {
    const cases: [Partial<SeasonStart>, PeriodStart['state'], string][] = [
      [{ counted: 0, attempts: 0, successes: 0, legs: 0, excludedGames: { 'straight-in': 2 } }, 'excluded', '対象外（ストレートイン）'],
      [{ counted: 0, attempts: 0, successes: 0, legs: 0, excludedGames: { 'rule-unknown': 2 } }, 'rule-unknown', 'ルール不明'],
      [{ attempts: 0, successes: 0 }, 'no-trials', '試技なし'],
      [{ counted: 0, attempts: 0, successes: 0, legs: 0, excludedGames: { 'not-fetched': 2 } }, 'failed', '取得失敗'],
    ];
    for (const [s, state, label] of cases) {
      const p = periodStart([season(s)]);
      expect(p.state).toBe(state);
      const { unmount } = render(<StartRateCard start={p} pendingText={null} />);
      expect(screen.getByTestId('metric-ダブルイン成功率').textContent).toContain(label);
      expect(screen.getByTestId('metric-ダブルイン成功率').textContent).not.toContain('0.0%');
      unmount();
    }
  });
});

// ---- 4 ----------------------------------------------------------------------------------------------

describe('4. the team read never stays "running" without reading, and the gauge never says 完了 for a failed read', () => {
  const period: PeriodLoad = { ...emptyLoad({ mode: 'current', currentTournamentId: TD }, {}), seasons: [s2], complete: true };
  const gamesLoad = (over: Partial<GamesLoad>): GamesLoad => ({ games: new Map(), failed: new Set(), failures: [], usedStaleCache: false, requestsSent: 0, pending: new Set(), progress: new Map(), units: 1, ...over });
  const servicesWith = (transport: AnalyticsTransport) => {
    const cache = new AnalyticsCache({ memoryOnly: true });
    return { createApi: (signal: AbortSignal) => new AnalyticsApi({ transport, signal }), createRoleApi: (signal: AbortSignal, max: number) => new AnalyticsApi({ transport, signal, maxRequests: max }), cache, sleep: async () => undefined };
  };

  it('lists still being read → waiting; every list failed → games-failed, no request, not running; the gauge stage fails', async () => {
    const asked: string[] = [];
    const services = servicesWith({ request: async (op) => { asked.push(op); throw new Error('x'); } });
    const teams = new Map([[TD, 'T1']]);
    const { result, rerender } = renderHook(({ g }) => useTeamDetail(services, period, g, 'doubles', teams, 0), { initialProps: { g: gamesLoad({ pending: new Set([TD]) }) } });
    expect(result.current.phase).toBe('waiting-games');
    expect(teamLegStage(result.current).state).toBe('waiting');
    rerender({ g: gamesLoad({ failed: new Set([TD]) }) });
    expect(result.current).toMatchObject({ phase: 'games-failed', running: false });
    expect(asked).toEqual([]);
    const stage = teamLegStage(result.current);
    expect(stage.state).toBe('failed');
    expect(gaugeOutcomeOf([stage], true, false, 0).state).toBe('partial');
  });

  it('no game of the kind → no-games (done, said so); a detail read that fails → failed, the gauge does not say 完了', async () => {
    const empty = new Map([[TD, { tournamentId: TD, games: [], dropped: { unfinished: 0, unreadable: 0, nonLeague: 0 }, complete: true } satisfies SeasonGames]]);
    const services = servicesWith({ request: async () => { throw new Error('down'); } });
    const teams = new Map([[TD, 'T1']]);
    const { result } = renderHook(() => useTeamDetail(services, period, gamesLoad({ games: empty }), 'doubles', teams, 0));
    await waitFor(() => expect(result.current.phase).toBe('no-games'));
    expect(teamLegStage(result.current)).toMatchObject({ state: 'done', text: 'この種別の対象試合がありません' });

    const withGame = new Map([[TD, { tournamentId: TD, games: parseGameList({ result: 0, list: [listRow()] }).games, dropped: { unfinished: 0, unreadable: 0, nonLeague: 0 }, complete: true } satisfies SeasonGames]]);
    const failing = renderHook(() => useTeamDetail(services, period, gamesLoad({ games: withGame }), 'doubles', teams, 0));
    await waitFor(() => expect(failing.result.current.phase).toBe('failed'));
    expect(failing.result.current.running).toBe(false);
    const stage = teamLegStage(failing.result.current);
    expect(stage.state).toBe('failed');
    expect(gaugeOutcomeOf([{ id: 'season', label: 'シーズン取得', state: 'done', count: null, text: '' }, stage], true, false, 0).state).not.toBe('done');
    act(() => failing.result.current.retry());
  });

  it('two seasons, one list read and one not: never done / no-games — partial or games-failed with the missing season said (Codex audit)', async () => {
    const other = { ...s2, tournamentId: 't_side_old', title: 'old' };
    const twoSeasons: PeriodLoad = { ...period, seasons: [s2, other] };
    const teams = new Map([[TD, 'T1'], ['t_side_old', 'T1']]);
    const services = servicesWith({ request: async () => detail() });
    // The read season has the team's game, the other season's list failed.
    const withGame = new Map([[TD, { tournamentId: TD, games: parseGameList({ result: 0, list: [listRow()] }).games, dropped: { unfinished: 0, unreadable: 0, nonLeague: 0 }, complete: true } satisfies SeasonGames]]);
    const a = renderHook(() => useTeamDetail(services, twoSeasons, gamesLoad({ games: withGame, failed: new Set(['t_side_old']) }), 'doubles', teams, 0));
    await waitFor(() => expect(a.result.current.phase).toBe('partial'));
    expect(teamLegStage(a.result.current).text).toContain('ゲーム一覧を取得できていない季が1季');
    // The read season has no game of the kind: "no games" cannot be said while the other is unknown.
    const empty = new Map([[TD, { tournamentId: TD, games: [], dropped: { unfinished: 0, unreadable: 0, nonLeague: 0 }, complete: true } satisfies SeasonGames]]);
    const b = renderHook(() => useTeamDetail(services, twoSeasons, gamesLoad({ games: empty, failed: new Set(['t_side_old']) }), 'doubles', teams, 0));
    await waitFor(() => expect(b.result.current.running).toBe(false));
    await waitFor(() => expect(b.result.current.phase).toBe('games-failed'));
    const c = renderHook(() => useTeamDetail(services, twoSeasons, gamesLoad({ games: empty, pending: new Set(['t_side_old']) }), 'doubles', teams, 0));
    await waitFor(() => expect(c.result.current.phase).toBe('waiting-games'));
  });
});
