import { act, cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { AnalyticsApi } from './api/readApi';
import type { AnalyticsTransport } from './api/readApi';
import { AnalyticsCache } from './cache/analyticsCache';
import { buildPopulation } from './playerView';
import { projectSeasons } from './projection';
import { tdaCopies, tdaMultiResponse, TDA_PLAYER } from './realData.tda.fixtures';
import type { TdaSnapshot } from './realData.tda.fixtures';
import TDA_RAW from './realData.tda.json';
import { DETAIL_MAX_REQUESTS } from './service/detailService';
import { GamesSession } from './service/gamesSession';
import type { GamesLoad } from './service/gamesSession';
import { loadPeriod } from './service/periodService';
import type { PeriodLoad } from './service/periodService';
import type { AnalyticsServices } from './ui/usePeriodLoad';
import { usePlayerDetail } from './ui/useRoleData';

/**
 * One player's leg details over a period that needs more than one budget (60 requests): three
 * seasons built from the real TDA 2026 中期 season (`tdaCopies`, simulated copies, 25 games of
 * ニシマタ タイヨウ each → 75 `match/get` + 3 high-in lists). Through the real hook: read part
 * after part without a button, seasons checked first shown first, every game read once, and the
 * period's figures the three seasons' sums.
 */

afterEach(cleanup);

const SNAP = TDA_RAW as unknown as TdaSnapshot;
const COPIES = tdaCopies(SNAP, 3);

class World implements AnalyticsTransport {
  calls: string[] = [];
  async request(operation: string, params: Record<string, string>, signal: AbortSignal): Promise<unknown> {
    await new Promise((resolve) => setTimeout(resolve, 0));
    if (signal.aborted) throw new Error('aborted');
    this.calls.push(`${operation}?${params.mid ?? `${params.tdid ?? ''}&${params.kind ?? ''}&${params.skip ?? ''}`}`);
    const body = tdaMultiResponse(COPIES, operation, params);
    if (body === undefined) throw new Error(`unexpected ${operation}`);
    return body;
  }
  gets(from = 0): string[] {
    return this.calls.slice(from).filter((c) => c.startsWith('match/get'));
  }
}

type Detail = ReturnType<typeof usePlayerDetail>;

function Harness({ services, load, games, out }: { services: AnalyticsServices; load: PeriodLoad; games: GamesLoad; out: { detail: Detail | null; seen: { partial: boolean; verified: number }[] } }): null {
  out.detail = usePlayerDetail(services, load, games, 0);
  return null;
}

async function setup() {
  const world = new World();
  const cache = new AnalyticsCache({ memoryOnly: true });
  const services: AnalyticsServices = {
    createApi: (signal) => new AnalyticsApi({ transport: world, signal }),
    createRoleApi: (signal, max) => new AnalyticsApi({ transport: world, signal, maxRequests: max }),
    cache,
    sleep: async () => undefined,
  };
  const load = await loadPeriod({ api: new AnalyticsApi({ transport: world }), cache, leagueId: SNAP.league.lgid, request: { mode: 'last3', currentTournamentId: COPIES.ids[0] } });
  const games = await new Promise<GamesLoad>((resolve) => {
    const s = new GamesSession({ createApi: services.createRoleApi!, cache, isOnline: () => true, now: () => Date.now(), sleep: async () => undefined }, (g, running) => {
      if (!running && g.pending.size === 0) resolve(g);
    });
    s.want(load.seasons.map((x) => ({ tournamentId: x.tournamentId, status: x.status })));
  });
  const out: { detail: Detail | null; seen: { partial: boolean; verified: number }[] } = { detail: null, seen: [] };
  const view = render(<Harness services={services} load={load} games={games} out={out} />);
  const personKey = load.seasons[0].players.find((p) => p.oid === TDA_PLAYER)!.personKey;
  const wait = async (): Promise<void> => {
    for (let i = 0; i < 2000; i += 1) {
      const r = out.detail!.results.get(personKey);
      if (r) out.seen.push({ partial: out.detail!.partial.has(personKey), verified: r.checks.filter((c) => c.verified.score).length });
      if (out.detail!.running === null && !out.detail!.partial.has(personKey) && r) return;
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
    }
    throw new Error('the read did not finish');
  };
  return { world, load, games, out, view, personKey, wait, services };
}

describe('leg details beyond one budget (3 seasons × 25 games of one player)', () => {
  it('the period loads as 3 seasons, one person linked across them', async () => {
    const { load, personKey } = await setup();
    expect(load.seasons.map((s) => s.tournamentId)).toEqual(COPIES.ids);
    for (const s of load.seasons) expect(s.players.some((p) => p.personKey === personKey)).toBe(true);
  });

  it('read part after part without a button: 75 games once each, the later season shown after the first ones, then all three', async () => {
    const { world, load, games, out, personKey, wait } = await setup();
    const before = world.calls.length;
    await act(async () => out.detail!.focus(personKey, true));
    await wait();
    const gets = world.gets(before);
    expect(gets).toHaveLength(75);
    expect(new Set(gets).size).toBe(75);
    expect(75 + 3).toBeGreaterThan(DETAIL_MAX_REQUESTS);
    const result = out.detail!.results.get(personKey)!;
    expect(result.checks.map((c) => c.verified.score)).toEqual([true, true, true]);
    expect(result.budgetStopped).toBe(false);
    expect(result.requestsSent).toBe(78);
    // Shown as partial in between, with the first seasons already checked.
    expect(out.seen.some((s) => s.partial && s.verified >= 1 && s.verified < 3)).toBe(true);

    const projection = projectSeasons(load.seasons, 'singles', games, out.detail!.contributions);
    const person = buildPopulation(projection.seasons, { kind: 'league' }, COPIES.ids[0]).people.find((p) => p.personKey === personKey)!;
    expect(person.metrics.setRate.den).toBe(27);
    expect(person.metrics.legRate).toMatchObject({ num: 42, den: 69 });
    expect(person.metrics.ppr.value!.toFixed(2)).toBe('66.89');
    expect(person.metrics.first9).toMatchObject({ num: 3 * 4710 * 3, den: 207 * 3 });
    expect(person.metrics.keep).toMatchObject({ num: 30, den: 33 });
    expect(person.metrics.break).toMatchObject({ num: 12, den: 36 });

    // Tab round trip (another view, then back): nothing is read again.
    const settled = world.calls.length;
    await act(async () => out.detail!.focus(personKey, false));
    await act(async () => out.detail!.focus(personKey, true));
    for (let i = 0; i < 20; i += 1) await act(async () => new Promise((resolve) => setTimeout(resolve, 0)));
    expect(world.calls.length).toBe(settled);
  });

  it('another player shown mid-way stops the read; back again, it continues from the cache (at most the batch on the wire is read twice)', async () => {
    const { world, out, personKey, wait, load } = await setup();
    const other = load.seasons[0].players.find((p) => p.oid !== TDA_PLAYER && p.personKey !== personKey)!.personKey;
    const before = world.calls.length;
    await act(async () => out.detail!.focus(personKey, true));
    for (let i = 0; world.gets(before).length < 30 && i < 2000; i += 1) await act(async () => new Promise((resolve) => setTimeout(resolve, 0)));
    await act(async () => out.detail!.focus(other, false));
    expect(out.detail!.running).toBeNull();
    for (let i = 0; i < 20; i += 1) await act(async () => new Promise((resolve) => setTimeout(resolve, 0)));
    expect(out.detail!.results.has(personKey)).toBe(false); // the dropped part shows nothing
    await act(async () => out.detail!.focus(personKey, true));
    await wait();
    const gets = world.gets(before);
    expect(new Set(gets).size).toBe(75);
    expect(gets.length - 75).toBeLessThanOrEqual(3);
    expect(out.detail!.results.get(personKey)!.checks.every((c) => c.verified.score)).toBe(true);
  });

  it('the singles view needs the legs, 01全体 does not: a paused read continues when wanted again', async () => {
    const { world, out, personKey, wait } = await setup();
    const before = world.calls.length;
    await act(async () => out.detail!.focus(personKey, true));
    for (let i = 0; world.gets(before).length < 20 && i < 2000; i += 1) await act(async () => new Promise((resolve) => setTimeout(resolve, 0)));
    // 01全体 is shown while the first part runs: that part finishes (nothing on the wire is
    // wasted), the next one does not start.
    await act(async () => out.detail!.focus(personKey, false));
    for (let i = 0; i < 400 && out.detail!.running !== null; i += 1) await act(async () => new Promise((resolve) => setTimeout(resolve, 0)));
    for (let i = 0; i < 40; i += 1) await act(async () => new Promise((resolve) => setTimeout(resolve, 0)));
    const paused = world.gets(before).length;
    expect(paused).toBe(DETAIL_MAX_REQUESTS - 3); // the first part: 60 requests, 3 of them high-in lists
    expect(out.detail!.partial.has(personKey)).toBe(true);
    expect(out.detail!.results.get(personKey)!.checks.filter((c) => c.verified.score)).toHaveLength(2);
    await act(async () => out.detail!.focus(personKey, true));
    await wait();
    expect(new Set(world.gets(before)).size).toBe(75);
    expect(world.gets(before)).toHaveLength(75);
  });
});
