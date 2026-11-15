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
 * the player P028 each → 75 `match/get` + 3 high-in lists). Through the real hook: read part
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

async function setup(opts: { sleep?: AnalyticsServices['sleep']; detailCache?: AnalyticsCache } = {}) {
  const world = new World();
  const cache = new AnalyticsCache({ memoryOnly: true });
  const services: AnalyticsServices = {
    createApi: (signal) => new AnalyticsApi({ transport: world, signal }),
    createRoleApi: (signal, max) => new AnalyticsApi({ transport: world, signal, maxRequests: max }),
    cache: opts.detailCache ?? cache,
    sleep: opts.sleep ?? (async () => undefined),
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

const tick = (): Promise<void> => act(async () => new Promise((resolve) => setTimeout(resolve, 0)));

describe('leg details beyond one budget (3 seasons × 25 games of one player)', () => {
  it('the browser refuses every write: the parts still never read a game twice (audit 3)', async () => {
    const refusing = new AnalyticsCache({ memoryOnly: true, limits: { maxEntries: 80, maxBytes: 1 } });
    const { world, out, personKey, wait } = await setup({ detailCache: refusing });
    const before = world.calls.length;
    await act(async () => out.detail!.focus(personKey, true));
    await wait();
    const gets = world.gets(before);
    expect(gets).toHaveLength(75);
    expect(new Set(gets).size).toBe(75);
    const result = out.detail!.results.get(personKey)!;
    expect(result.saveFailed).toBe(true);
    expect(result.checks.every((c) => c.verified.score)).toBe(true);
  });

  it('01全体 shown during the pause between two parts: the next part does not start; back again, it continues (audit 4)', async () => {
    let release: (() => void) | null = null;
    const sleep: AnalyticsServices['sleep'] = () => new Promise<void>((resolve) => (release = resolve));
    const { world, out, personKey, wait } = await setup({ sleep });
    const before = world.calls.length;
    await act(async () => out.detail!.focus(personKey, true));
    for (let i = 0; release === null && i < 2000; i += 1) await tick();
    expect(release).not.toBeNull(); // the first part is done, the pause before the next one began
    const firstPart = world.gets(before).length;
    await act(async () => out.detail!.focus(personKey, false)); // 01全体
    await act(async () => release!());
    for (let i = 0; i < 40; i += 1) await tick();
    expect(world.gets(before)).toHaveLength(firstPart); // no request of the next part
    expect(out.detail!.running).toBeNull();
    // Back to シングルス: continued from what was read (instant pauses from now on).
    const instant = setInterval(() => release?.(), 1);
    await act(async () => out.detail!.focus(personKey, true));
    await wait();
    clearInterval(instant);
    const gets = world.gets(before);
    expect(new Set(gets).size).toBe(75);
    expect(gets).toHaveLength(75);
  });

  it('a season\'s list read again with other content (same id): its figures leave until checked again; unchanged legs are not read again (audit 2)', async () => {
    const { world, load, games, out, view, personKey, wait, services } = await setup();
    await act(async () => out.detail!.focus(personKey, true));
    await wait();
    const tid = COPIES.ids[0];
    const before = [...out.detail!.contributions.keys()].length;
    // The newest season's list as n01 gives it after a correction: one game of the player gone.
    const raw = games.games.get(tid)!;
    const mine = raw.games.find((g) => g.sides.some((side) => side.players.some((p) => p.oid === TDA_PLAYER)))!;
    const corrected = { ...raw, games: raw.games.filter((g) => g.gameId !== mine.gameId), version: 'corrected' };
    const next: GamesLoad = { ...games, games: new Map([...games.games, [tid, corrected]]) };
    const calls = world.calls.length;
    view.rerender(<Harness services={services} load={load} games={next} out={out} />);
    // At once: none of that season's figures are shown with the new list.
    for (const gameId of out.detail!.contributions.keys()) expect(raw.games.find((g) => g.gameId === gameId) === undefined || corrected.games.some((g) => g.gameId === gameId)).toBe(true);
    expect([...out.detail!.contributions.keys()].length).toBeLessThan(before);
    await wait();
    for (let i = 0; i < 20; i += 1) await tick();
    // Checked again against the new list (it no longer adds up to n01's totals: shown as such), with no leg read again.
    expect(world.gets(calls)).toEqual([]);
    const result = out.detail!.results.get(personKey)!;
    expect(result.versions![tid]).toBe('corrected');
    expect(result.checks.find((c) => c.tournamentId === tid)!.verified.score).toBe(false);
  });

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

  it('another player shown between two parts, then back: the read continues from the cache (Codex audit)', async () => {
    const { world, out, personKey, wait, load } = await setup();
    const other = load.seasons[0].players.find((p) => p.oid !== TDA_PLAYER && p.personKey !== personKey)!.personKey;
    const before = world.calls.length;
    await act(async () => out.detail!.focus(personKey, true));
    for (let i = 0; !out.detail!.partial.has(personKey) && i < 2000; i += 1) await act(async () => new Promise((resolve) => setTimeout(resolve, 0)));
    expect(out.detail!.partial.has(personKey)).toBe(true); // the first part is shown, the next one under way
    await act(async () => out.detail!.focus(other, false));
    expect(out.detail!.running).toBeNull();
    await act(async () => out.detail!.focus(personKey, true));
    await wait();
    const gets = world.gets(before);
    expect(new Set(gets).size).toBe(75);
    expect(gets.length - 75).toBeLessThanOrEqual(3);
    expect(out.detail!.partial.has(personKey)).toBe(false);
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
