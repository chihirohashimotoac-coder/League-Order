import { renderHook, waitFor } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { AnalyticsApi } from './api/readApi';
import type { AnalyticsTransport } from './api/readApi';
import { parseGameList } from './api/parse';
import { AnalyticsCache } from './cache/analyticsCache';
import type { SlotEvidence } from './gameKind';
import { projectSeasons } from './projection';
import type { SeasonGames } from './roleGames';
import { buildSeasonData } from './seasonData';
import { detailKey, LEGACY_NO_ORDER_FAILURE, reconstructTeam } from './service/detailService';
import { fingerprint } from './service/gamesLoader';
import type { GamesLoad } from './service/gamesSession';
import { emptyLoad } from './service/periodService';
import type { PeriodLoad } from './service/periodService';
import { season as seasonInput, tournament } from './testFixtures';
import { gaugeOutcomeOf, teamLegStage } from './ui/LoadGauge';
import { useTeamDetail } from './ui/useRoleData';

/**
 * 2026-11-18: the team's leg read follows the content of a season's game list (the same season id read
 * again with other content), and reads again the failure an earlier version stored for a game whose
 * two sides had no throwing order.
 */

const TD = 't_side';
const slot: SlotEvidence = { schid: 'd1', division: null, numPart: 2, subtitle: 'ダブルス1', startScore: 501, limitLegCount: 1, matchType: '01', settingMatchType: null };
const season = buildSeasonData(seasonInput({ tournament: tournament(TD, [{ id: 'T1', name: 'One' }, { id: 'T2', name: 'Two' }]), slots: [slot] }));
const period: PeriodLoad = { ...emptyLoad({ mode: 'current', currentTournamentId: TD }, {}), seasons: [season], complete: true };

/** One leg: T1 threw first (three visits of `visit`), T2 checked out 501 in 9 darts. Neither side has its order. */
const row = (mid: string, visit = 60) => ({ mid, tdid: TD, tmid: `${TD}_lg_0_q_T1_T2`, schid: 'd1', endMatch: 1, statsData: [{ tpid: 'T1', order: null, winLegs: 0, allScore: visit * 3, allDarts: 9 }, { tpid: 'T2', order: null, winLegs: 1, allScore: 501, allDarts: 9 }] });
const detail = (mid: string, visit = 60) => ({
  result: 0,
  match: {
    ...row(mid, visit),
    startScore: 501,
    legData: [{ first: 0, winner: 1, endFlag: 1, playerData: [[{ score: 0, left: 501 }, { score: visit, left: 501 - visit }, { score: visit, left: 501 - 2 * visit }, { score: visit, left: 501 - 3 * visit }], [{ score: 0, left: 501 }, { score: 180, left: 321 }, { score: 180, left: 141 }, { score: -3, left: 0 }]] }],
  },
});
const list = (rows: ReturnType<typeof row>[]): Map<string, SeasonGames> => new Map([[TD, { tournamentId: TD, games: parseGameList({ result: 0, list: rows }).games, dropped: { unfinished: 0, unreadable: 0, nonLeague: 0 }, complete: true }]]);
const gamesLoad = (games: Map<string, SeasonGames>): GamesLoad => ({ games, failed: new Set(), failures: [], usedStaleCache: false, requestsSent: 0, pending: new Set(), progress: new Map(), units: 1 });
const servicesWith = (transport: AnalyticsTransport, cache = new AnalyticsCache({ memoryOnly: true })) => ({
  createApi: (signal: AbortSignal) => new AnalyticsApi({ transport, signal }),
  createRoleApi: (signal: AbortSignal, max: number) => new AnalyticsApi({ transport, signal, maxRequests: max }),
  cache,
  sleep: async () => undefined,
});
const teams = new Map([[TD, 'T1']]);

describe('1. the same season’s list read again with other content: the team’s legs are checked again', () => {
  it('list A / legs A (180) adopted → list B / legs B (240): reading again, then First 9 from 240 / 9; the unchanged game is not asked again', async () => {
    const legs: Record<string, ReturnType<typeof detail>> = { g1: detail('g1', 60), g2: detail('g2', 50) };
    const asked: string[] = [];
    const services = servicesWith({ request: async (_op, params) => { asked.push(params.mid); return legs[params.mid]; } });
    const A = gamesLoad(list([row('g1', 60), row('g2', 50)]));
    const hook = renderHook(({ g }) => useTeamDetail(services, period, g, 'doubles', teams, 0), { initialProps: { g: A } });
    await waitFor(() => expect(hook.result.current.phase).toBe('done'));
    expect(asked.sort()).toEqual(['g1', 'g2']);
    expect(hook.result.current.contributions.get('g1')?.get('T1')).toMatchObject({ f9Score: 180, f9Darts: 9 });

    // n01 corrects g1 (the row and its legs); g2 is unchanged.
    legs.g1 = detail('g1', 80);
    const B = gamesLoad(list([row('g1', 80), row('g2', 50)]));
    hook.rerender({ g: B });
    // Right away: the old figures are not shown for the new list, and the read is not "done".
    expect(hook.result.current.contributions.get('g1')).toBeUndefined();
    expect(hook.result.current.phase).toBe('running');
    expect(teamLegStage(hook.result.current).state).toBe('running');
    await waitFor(() => expect(hook.result.current.phase).toBe('done'));
    expect(asked).toEqual(['g1', 'g2', 'g1']); // only the corrected game
    expect(hook.result.current.contributions.get('g1')?.get('T1')).toMatchObject({ f9Score: 240, f9Darts: 9 });
    expect(hook.result.current.contributions.get('g2')?.get('T1')).toMatchObject({ f9Score: 150 });
    const total = hook.result.current.result!.seasons[0];
    expect(total).toMatchObject({ games: 2, rebuilt: 2 });
    expect(gaugeOutcomeOf([teamLegStage(hook.result.current)], true, false, 0).state).toBe('done');
    // The projection shows First 9 from the new legs: (240 + 150) × 3 / 18.
    const projected = projectSeasons(period.seasons, 'doubles', { games: B.games, failed: new Set() }, new Map(), hook.result.current.contributions);
    expect(projected.seasons[0].teams.find((t) => t.teamId === 'T1')!.line).toMatchObject({ f9Score: 390, f9Darts: 18 });
  });

  it('a late answer of the read for the old list never overwrites the new one', async () => {
    const pending: { mid: string; visit: number; resolve: (v: unknown) => void }[] = [];
    let visit = 60;
    const services = servicesWith({ request: (_op, params) => new Promise((resolve) => pending.push({ mid: params.mid, visit, resolve })) });
    const hook = renderHook(({ g }) => useTeamDetail(services, period, g, 'doubles', teams, 0), { initialProps: { g: gamesLoad(list([row('g1', 60)])) } });
    await waitFor(() => expect(pending).toHaveLength(1)); // the read for list A is under way
    visit = 80;
    hook.rerender({ g: gamesLoad(list([row('g1', 80)])) });
    await waitFor(() => expect(pending).toHaveLength(2)); // the read for list B
    pending[1].resolve(detail('g1', 80));
    await waitFor(() => expect(hook.result.current.phase).toBe('done'));
    expect(hook.result.current.contributions.get('g1')?.get('T1')).toMatchObject({ f9Score: 240 });
    pending[0].resolve(detail('g1', 60)); // the old read answers late
    await new Promise((r) => setTimeout(r, 20));
    expect(hook.result.current.phase).toBe('done');
    expect(hook.result.current.contributions.get('g1')?.get('T1')).toMatchObject({ f9Score: 240 });
  });
});

describe('2. the failure an earlier version stored for a game without any throwing order is read again', () => {
  async function readWith(stored: unknown, forTeam = 'T1') {
    const cache = new AnalyticsCache({ memoryOnly: true });
    const games = list([row('g1', 60)]);
    const game = games.get(TD)!.games[0];
    await cache.put(detailKey(TD), { v: 2, games: { g1: { r: stored, at: Date.now(), fp: fingerprint(game) } } }, 60 * 60 * 1000);
    const asked: string[] = [];
    const transport: AnalyticsTransport = { request: async (op) => { asked.push(op); return detail('g1', 60); } };
    const result = await reconstructTeam({ api: new AnalyticsApi({ transport, maxRequests: 60 }), cache, isOnline: () => true, now: () => Date.now() }, { seasons: [season], games, teams: new Map([[TD, forTeam]]), role: 'doubles', key: 'k' });
    return { result, asked, games };
  }

  it('the old "両チームの投順がありません" (same row, within its TTL) is read again; the team’s First 9 / Keep / Break are adopted, nothing for a player', async () => {
    const { result, asked, games } = await readWith({ gameId: 'g1', ok: false, reason: LEGACY_NO_ORDER_FAILURE });
    expect(asked).toEqual(['match/get']);
    expect(result.seasons[0]).toMatchObject({ games: 1, rebuilt: 1 });
    expect(result.contributions.get('g1')?.get('T1')).toEqual({ f9Score: 180, f9Darts: 9, breakLegs: 0, breakWins: 0 });
    const line = projectSeasons([season], 'doubles', { games, failed: new Set() }, new Map(), result.contributions).seasons[0];
    expect(line.teams.find((t) => t.teamId === 'T1')!.line).toMatchObject({ f9Score: 180, f9Darts: 9, leg: 1, winLeg: 0, breakLegs: 0, breakWins: 0 }); // Keep 0/1
    expect(line.players).toEqual([]); // nobody is credited
    const other = await readWith({ gameId: 'g1', ok: false, reason: LEGACY_NO_ORDER_FAILURE }, 'T2');
    expect(other.result.contributions.get('g1')?.get('T2')).toEqual({ f9Score: 501, f9Darts: 9, breakLegs: 1, breakWins: 1 }); // Break 1/1
  });

  it('a failure of the current rules and a valid stored reconstruction are kept (no request)', async () => {
    const failure = await readWith({ gameId: 'g1', ok: false, reason: '開始点数が不明です' });
    expect(failure.asked).toEqual([]);
    expect(failure.result.contributions.size).toBe(0);
    const valid = { gameId: 'g1', ok: true, startScore: 501, perPlayer: {}, sides: [{ f9Score: 180, f9Darts: 9, breakLegs: 0, breakWins: 0 }, { f9Score: 501, f9Darts: 9, breakLegs: 1, breakWins: 1 }], sideRows: [{ teamId: 'T1', legsWon: 0, score: 180, darts: 9 }, { teamId: 'T2', legsWon: 1, score: 501, darts: 9 }] };
    const kept = await readWith(valid);
    expect(kept.asked).toEqual([]);
    expect(kept.result.contributions.get('g1')?.get('T1')).toMatchObject({ f9Score: 180 });
  });
});
