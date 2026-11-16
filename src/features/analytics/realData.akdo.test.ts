// @vitest-environment jsdom
import { renderHook, waitFor, act } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { useTeamDetail } from './ui/useRoleData';
import { aggregateTeams } from './aggregate';
import { AnalyticsApi } from './api/readApi';
import { AnalyticsCache } from './cache/analyticsCache';
import { buildPopulation } from './playerView';
import { projectSeasons } from './projection';
import { AKDO_TDID, AKDO_TEAM, AkdoN01, HIRAGA, TAKEUCHI, underLeague } from './realData.akdo.fixtures';
import type { AkdoSnapshot } from './realData.akdo.fixtures';
import AKDO_RAW from './realData.akdo.json';
import { reconstructPerson, reconstructTeam, singlesCoverage, doublesCoverage } from './service/detailService';
import { GamesSession } from './service/gamesSession';
import type { GamesLoad } from './service/gamesSession';
import { loadPeriod } from './service/periodService';
import { formatStart, periodStart } from './startRate';
import { DOUBLE_IN_RULES, gameStartRule, seasonRule } from './startRule';
import type { DoubleInRule } from './startRule';
import { classifyGames } from './roleGames';

/**
 * Audit 2026-11-16 (AKDO), on the real season (`realData.akdo.fixtures.ts`), through the normal path:
 * period → game list → leg details → projection. Live n01 is never contacted.
 *
 * ① the organiser's double-in rule applies to the checked season and slots only;
 * ② n01's official averages leave the `ignore_avg` slots out, so each metric is checked over the
 *    games n01 counts in it, and a singles game's legs stand on their own;
 * ④ a team's singles First 9 / Keep / Break from its own legs.
 */
const SNAP = AKDO_RAW as unknown as AkdoSnapshot;

async function loaded(snap: AkdoSnapshot = SNAP) {
  const fake = new AkdoN01(snap);
  const cache = new AnalyticsCache({ memoryOnly: true });
  const period = await loadPeriod({ api: new AnalyticsApi({ transport: fake }), cache, leagueId: snap.league.lgid, request: { mode: 'current', currentTournamentId: AKDO_TDID } });
  const games = await new Promise<GamesLoad>((resolve) => {
    const session = new GamesSession({ createApi: (signal, max) => new AnalyticsApi({ transport: fake, signal, maxRequests: max }), cache, isOnline: () => true, now: () => Date.now(), sleep: async () => undefined }, (load, running) => {
      if (!running && load.pending.size === 0) resolve(load);
    });
    session.want(period.seasons.map((s) => ({ tournamentId: s.tournamentId, status: s.status })));
  });
  const ctx = () => ({ api: new AnalyticsApi({ transport: fake, maxRequests: 60 }), cache, isOnline: () => true, now: () => Date.now(), sleep: async () => undefined });
  return { fake, cache, period, games, ctx };
}

const personOf = (period: Awaited<ReturnType<typeof loaded>>['period'], oid: string) => period.seasons[0].players.find((p) => p.oid === oid)!;

describe('AKDO 2026/2nd: ② each metric against the games n01 counts in it', () => {
  it('the slots carry ignore_avg: doubles and gallon are left out of the averages, singles are not', async () => {
    const { period } = await loaded();
    const bySchid = Object.fromEntries(period.seasons[0].slots.map((s) => [s.schid, s.ignoreAvg === true]));
    expect(bySchid).toMatchObject({ hcgs: true, jwps: true, il25: true, cpvh: false, '3wfs': false, wzq9: false, ymrs: false });
  });

  it('竹内 淳: all nine games rebuilt give 6,311 / 286, n01 counts 3,370 / 148 (singles) — the season is verified', async () => {
    const { period, games, ctx } = await loaded();
    const me = personOf(period, TAKEUCHI);
    const result = await reconstructPerson(ctx(), { seasons: period.seasons, games: games.games, personKey: me.personKey });
    const check = result.checks[0];
    expect(check).toMatchObject({ state: 'verified', games: 9, reconstructed: 9, avgExcludedGames: 6 });
    expect(check.compared).toMatchObject({ score: [3370, 3370], darts: [148, 148], f9Score: [1651, 1651], f9Darts: [63, 63] });
    expect(check.verified).toEqual({ score: true, f9: true, tons: true, highOut: true, break: true, outsideAvg: true });
    expect(check.multi).toEqual({ score: true, f9: true });
    expect(doublesCoverage(result)).toMatchObject({ seasons: 1, scoreVerified: 1, f9Verified: 1 });
    // The doubles view: his share of the pair's games, from the legs (n01 has no average for them).
    const projection = projectSeasons(period.seasons, 'doubles', games, result.contributions);
    const person = buildPopulation(projection.seasons, { kind: 'league' }, AKDO_TDID).people.find((p) => p.personKey === me.personKey)!;
    expect(person.metrics.ppr).toMatchObject({ num: 5760, den: 97 });
    expect(person.metrics.legRate).toMatchObject({ num: 3, den: 8 });
  });

  it('① ダブルイン成功率 of 竹内 淳: 66.7%（6/9スロー）, all three ダブルス2 games counted, no high-in conflict', async () => {
    const { period, games, ctx } = await loaded();
    const result = await reconstructPerson(ctx(), { seasons: period.seasons, games: games.games, personKey: personOf(period, TAKEUCHI).personKey });
    const start = periodStart(result.starts);
    expect(start).toMatchObject({ state: 'value', attempts: 9, successes: 6, counted: 3, partial: false });
    expect(formatStart(start)).toEqual({ value: '66.7%', sample: '6/9スロー' });
    expect(start.highInAgreements).toBeGreaterThan(0);
  });

  it('平賀 正弘 singles: 3DA 49.20, First 9 47.50, Keep 0.0% (0/1), Break 0.0% (0/1)', async () => {
    const { period, games, ctx } = await loaded();
    const me = personOf(period, HIRAGA);
    const result = await reconstructPerson(ctx(), { seasons: period.seasons, games: games.games, personKey: me.personKey });
    expect(singlesCoverage(result, [AKDO_TDID])).toMatchObject({ seasons: 1, f9Verified: 1, breakVerified: 1 });
    const projection = projectSeasons(period.seasons, 'singles', games, result.contributions);
    const m = buildPopulation(projection.seasons, { kind: 'league' }, AKDO_TDID).people.find((p) => p.personKey === me.personKey)!.metrics;
    expect(m.ppr).toMatchObject({ num: 2952, den: 60 });
    expect(m.ppr.value!.toFixed(2)).toBe('49.20');
    expect(m.first9).toMatchObject({ num: 855, den: 18 });
    expect(m.first9.value!.toFixed(2)).toBe('47.50');
    expect(m.keep).toMatchObject({ num: 0, den: 1, value: 0 });
    expect(m.break).toMatchObject({ num: 0, den: 1, value: 0 });
  });

  it('a singles game stands on its legs: a doubles game that cannot be read does not hold back First 9 / Keep / Break', async () => {
    const { fake, period, games, ctx } = await loaded();
    const me = personOf(period, HIRAGA);
    // 平賀's doubles games fail: the season cannot be checked against n01's totals for the pair games.
    for (const g of SNAP.games) if ((g.statsData as { order: { oid: string }[] }[]).some((s) => s.order.length === 2 && s.order.some((p) => p.oid === HIRAGA))) fake.down.add(String(g.mid));
    const result = await reconstructPerson(ctx(), { seasons: period.seasons, games: games.games, personKey: me.personKey });
    expect(result.checks[0].verified.tons).toBe(false);
    const m = buildPopulation(projectSeasons(period.seasons, 'singles', games, result.contributions).seasons, { kind: 'league' }, AKDO_TDID).people.find((p) => p.personKey === me.personKey)!.metrics;
    expect(m.first9.den).toBe(18);
    expect(m.break.den).toBe(1);
    // …and no per-player score of a doubles game is admitted on that basis.
    const doubles = projectSeasons(period.seasons, 'doubles', games, result.contributions).seasons[0].players.find((p) => p.oid === HIRAGA)!.line;
    expect(doubles.darts).toBeNull();
  });

  it('another league with the same ignore_avg slots is checked the same way (no organiser’s rule: no double-in figure)', async () => {
    const other = underLeague(SNAP, 'lg_other_0001');
    const { period, games, ctx } = await loaded(other);
    const result = await reconstructPerson(ctx(), { seasons: period.seasons, games: games.games, personKey: personOf(period, TAKEUCHI).personKey });
    expect(result.checks[0]).toMatchObject({ state: 'verified' });
    expect(periodStart(result.starts)).toMatchObject({ state: 'rule-unknown', attempts: 0 });
  });
});

describe('AKDO 2026/2nd: ① the organiser’s rule, by league id, season and slot', () => {
  it('applies to 2026/2nd ダブルス1・2 only — not to another AKDO season, the gallon, nor an unknown season', async () => {
    const { period } = await loaded();
    const season = period.seasons[0];
    const games = classifyGames(season, (await loaded()).games.games.get(AKDO_TDID)!.games);
    const doubles = games.find((g) => g.schid === 'il25')!;
    expect(gameStartRule(season, doubles, null)).toMatchObject({ rule: 'double-in', basis: expect.stringContaining('AKDO') });
    expect(seasonRule({ ...season, tournamentId: 't_Fbsj_6639' })).toMatchObject({ reason: expect.stringContaining('確認できたシーズン') });
    expect(gameStartRule({ ...season, tournamentId: 't_new_season' }, doubles, null).rule).toBe('unknown');
    // A doubles 01 slot the rule was not confirmed for is not covered.
    const otherSlot = { ...doubles, schid: 'zzzz' };
    const slots = [...season.slots, { ...season.slots.find((s) => s.schid === 'il25')!, schid: 'zzzz' }];
    expect(gameStartRule({ ...season, slots }, otherSlot, null)).toMatchObject({ rule: 'unknown', reason: expect.stringContaining('適用を確認できた枠') });
  });

  it('the same path serves another league whose rule lists its checked seasons', async () => {
    const { period } = await loaded();
    const season = period.seasons[0];
    const doubles = classifyGames(season, (await loaded()).games.games.get(AKDO_TDID)!.games).find((g) => g.schid === 'jwps')!;
    const rule: DoubleInRule = { leagueId: 'lg_x', name: 'X', fromStartedAt: Number.POSITIVE_INFINITY, fromSeason: 'X 1st', seasons: ['t_x1'], source: 'test' };
    expect(gameStartRule({ ...season, leagueId: 'lg_x', tournamentId: 't_x1' }, doubles, null, [rule]).rule).toBe('double-in');
    expect(gameStartRule({ ...season, leagueId: 'lg_x', tournamentId: 't_x2' }, doubles, null, [rule]).rule).toBe('unknown');
    expect(DOUBLE_IN_RULES.find((r) => r.leagueId === 'lg_Amgb_5525')).toMatchObject({ seasons: [AKDO_TDID], slots: ['jwps', 'il25'] });
  });
});

describe('AKDO 2026/2nd: ④ MC-BREMEN singles from the team’s own legs', () => {
  it('First 9 64.01 (12 games), Keep / Break from the legs; 3DA, Leg and Set unchanged', async () => {
    const { fake, period, games, ctx } = await loaded();
    const before = projectSeasons(period.seasons, 'singles', games);
    const teamBefore = aggregateTeams(before.seasons).find((t) => t.seasons.some((s) => s.teamId === AKDO_TEAM))!.metrics;
    expect(teamBefore.first9.value).toBeNull();
    const n = fake.calls.length;
    const result = await reconstructTeam(ctx(), { seasons: period.seasons, games: games.games, teams: new Map([[AKDO_TDID, AKDO_TEAM]]), role: 'singles', key: 'singles|t' });
    const gets = fake.calls.slice(n).filter((c) => c.startsWith('match/get'));
    expect(gets).toHaveLength(12); // the team's singles games only
    expect(result.seasons).toEqual([expect.objectContaining({ games: 12, rebuilt: 12 })]);
    const after = projectSeasons(period.seasons, 'singles', games, new Map(), result.contributions);
    const m = aggregateTeams(after.seasons).find((t) => t.seasons.some((s) => s.teamId === AKDO_TEAM))!.metrics;
    expect(m.first9).toMatchObject({ num: 16131, den: 252 });
    expect(m.first9.value!.toFixed(2)).toBe('64.01');
    expect(m.keep).toMatchObject({ num: 8, den: 15 });
    expect(m.break).toMatchObject({ num: 7, den: 13 });
    expect(m.ppr).toEqual(teamBefore.ppr);
    expect(m.legRate).toEqual(teamBefore.legRate);
    expect(m.setRate).toEqual(teamBefore.setRate);
    // Read again: everything comes from the cache.
    const again = fake.calls.length;
    await reconstructTeam(ctx(), { seasons: period.seasons, games: games.games, teams: new Map([[AKDO_TDID, AKDO_TEAM]]), role: 'singles', key: 'singles|t' });
    expect(fake.calls.length).toBe(again);
  });

  it('doubles: a pair’s leg is counted once for the team', async () => {
    const { period, games, ctx } = await loaded();
    const result = await reconstructTeam(ctx(), { seasons: period.seasons, games: games.games, teams: new Map([[AKDO_TDID, AKDO_TEAM]]), role: 'doubles', key: 'doubles|t' });
    const after = projectSeasons(period.seasons, 'doubles', games, new Map(), result.contributions);
    const m = aggregateTeams(after.seasons).find((t) => t.seasons.some((s) => s.teamId === AKDO_TEAM))!.metrics;
    // Keep + Break legs = every leg of the team's doubles games, once each.
    expect(m.keep.den + m.break.den).toBe(m.legRate.den);
    // First 9 darts: at most 9 per leg of the side (not 9 per partner).
    expect(m.first9.den).toBeLessThanOrEqual(9 * m.legRate.den);
    expect(m.first9.den).toBeGreaterThan(6 * m.legRate.den);
  });
});

describe('AKDO 2026/2nd: ④ the team read keeps old and new legs apart (Codex audit)', () => {
  it('legs that had to be read again but could not be are not used (no figure from them, the reason is given)', async () => {
    const { fake, period, games, cache } = await loaded();
    const teams = new Map([[AKDO_TDID, AKDO_TEAM]]);
    const ctx = (extra: Record<string, unknown> = {}) => ({ api: new AnalyticsApi({ transport: fake, maxRequests: 60 }), cache, isOnline: () => true, now: () => Date.now(), sleep: async () => undefined, ...extra });
    const first = await reconstructTeam(ctx(), { seasons: period.seasons, games: games.games, teams, role: 'singles', key: 'k' });
    expect(first.seasons[0].rebuilt).toBe(12);
    for (const g of SNAP.games) fake.down.add(String(g.mid));
    const again = await reconstructTeam(ctx({ freshAfter: Date.now() + 1 }), { seasons: period.seasons, games: games.games, teams, role: 'singles', key: 'k' });
    expect(again.seasons[0]).toMatchObject({ games: 12, rebuilt: 0, reason: expect.stringContaining('保存済みの古い明細は使っていません') });
    expect(again.contributions.size).toBe(0);
  });

  it('a retry read in several parts reads each game once (the freshness point is fixed for the whole read)', async () => {
    const { fake, period, games, cache } = await loaded();
    const services = { createApi: (signal: AbortSignal) => new AnalyticsApi({ transport: fake, signal }), createRoleApi: (signal: AbortSignal) => new AnalyticsApi({ transport: fake, signal, maxRequests: 5 }), cache, sleep: async () => undefined };
    const teams = new Map([[AKDO_TDID, AKDO_TEAM]]);
    const { result } = renderHook(() => useTeamDetail(services, period, games, 'singles', teams, 0));
    await waitFor(() => expect(result.current.result?.seasons[0].rebuilt).toBe(12));
    expect(result.current.running).toBe(false);
    const n = fake.calls.length;
    act(() => result.current.retry());
    await waitFor(() => expect(result.current.running).toBe(false));
    await waitFor(() => expect(result.current.result?.seasons[0].rebuilt).toBe(12));
    const gets = fake.calls.slice(n).filter((c) => c.startsWith('match/get'));
    expect(gets).toHaveLength(12);
    expect(new Set(gets).size).toBe(12);
  });
});
