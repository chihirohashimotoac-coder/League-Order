import { describe, expect, it } from 'vitest';
import { AnalyticsApi } from './api/readApi';
import type { AnalyticsTransport } from './api/readApi';
import { AnalyticsCache } from './cache/analyticsCache';
import { buildPopulation } from './playerView';
import { projectSeasons } from './projection';
import { tdaCorrection, tdaResponse, TDA_PLAYER, TDA_TDID } from './realData.tda.fixtures';
import type { TdaSnapshot } from './realData.tda.fixtures';
import TDA_RAW from './realData.tda.json';
import { currentResult, newDetailMemory, reconstructPerson } from './service/detailService';
import type { DetailMemory, PlayerDetailResult } from './service/detailService';
import { loadSeasonGames } from './service/gamesLoader';
import type { SeasonGames } from './roleGames';
import { loadPeriod } from './service/periodService';
import type { PeriodLoad } from './service/periodService';

/**
 * 修正2: a list read again with a corrected game must not be checked against legs and n01 totals
 * read before the correction. Simulated on the real TDA season (`realData.tda.json`): one leg the
 * player lost in one of their singles games gets 1 more point on their first visit — the list row,
 * then the leg details, then n01's player totals show it, in that order (n01 catching up).
 */

type Rec = Record<string, unknown>;
const SNAP = TDA_RAW as unknown as TdaSnapshot;

const FIX = tdaCorrection(SNAP);

class World implements AnalyticsTransport {
  calls: string[] = [];
  list = false;
  legs = false;
  totals = false;
  legsDown = false;
  async request(operation: string, params: Record<string, string>): Promise<unknown> {
    this.calls.push(`${operation}?${params.mid ?? params.kind ?? params.skip ?? ''}`);
    if (operation === 'match/get' && params.mid === FIX.mid) {
      if (this.legsDown) throw new Error('down');
      if (this.legs) return FIX.detail;
    }
    const snap: TdaSnapshot = { ...SNAP, games: this.list ? FIX.list : SNAP.games, playerStats: this.totals ? FIX.stats : SNAP.playerStats };
    const body = tdaResponse(snap, operation, params);
    if (body === undefined) throw new Error(`unexpected ${operation}`);
    return body;
  }
  since(n: number): string[] {
    return this.calls.slice(n);
  }
}

/** Added to the clock (the legs' read times are compared with it). */
let skew = 0;
const ctxOf = (world: World, cache: AnalyticsCache, extra: { forceRefresh?: boolean } = {}) => ({ api: new AnalyticsApi({ transport: world, maxRequests: 60 }), cache, isOnline: () => true, now: () => Date.now() + skew, sleep: async () => undefined, ...extra });

async function start() {
  skew = 0;
  const world = new World();
  const cache = new AnalyticsCache({ memoryOnly: true });
  const period = await loadPeriod({ api: new AnalyticsApi({ transport: world }), cache, leagueId: SNAP.league.lgid, request: { mode: 'current', currentTournamentId: TDA_TDID } });
  const listed = async (forceRefresh = false): Promise<Map<string, SeasonGames>> => {
    const r = await loadSeasonGames(ctxOf(world, cache, { forceRefresh }), TDA_TDID, 30);
    if (!r.ok) throw new Error(r.reason);
    return new Map([[TDA_TDID, r.games]]);
  };
  const v1 = await listed();
  const me = period.seasons[0].players.find((p) => p.oid === TDA_PLAYER)!;
  const memory = newDetailMemory();
  const first = await reconstructPerson(ctxOf(world, cache), { seasons: period.seasons, games: v1, personKey: me.personKey, memory });
  return { world, cache, period, me, memory, first, listed };
}

const read = (s: Awaited<ReturnType<typeof start>>, games: Map<string, SeasonGames>, previous: PlayerDetailResult, recheck = false) =>
  reconstructPerson(ctxOf(s.world, s.cache), { seasons: s.period.seasons, games, personKey: s.me.personKey, memory: s.memory as DetailMemory, previousVersions: previous.versions, recheckOfficial: recheck });

function shown(period: PeriodLoad, games: Map<string, SeasonGames>, result: PlayerDetailResult, personKey: string) {
  const projection = projectSeasons(period.seasons, 'singles', { games, failed: new Set() }, currentResult(result, games).contributions);
  return { metrics: buildPopulation(projection.seasons, { kind: 'league' }, TDA_TDID).people.find((p) => p.personKey === personKey)!.metrics, adoption: projection.adoption[0] };
}

describe('a corrected game (300 → 301) is checked only with legs and totals read after the correction', () => {
  it('before the correction: verified, First 9 68.26', async () => {
    const s = await start();
    expect(s.first.checks[0].verified).toMatchObject({ score: true, f9: true });
    const before = shown(s.period, new Map([[TDA_TDID, (await s.listed())!.get(TDA_TDID)!]]), s.first, s.me.personKey);
    expect(before.metrics.first9.value!.toFixed(2)).toBe('68.26');
  });

  it('n01 shows the correction in the list only: old legs (300) and old totals (300) never make it verified', async () => {
    const s = await start();
    s.world.list = true;
    const v2 = await s.listed(true);
    expect(v2.get(TDA_TDID)!.changedFrom).toBeDefined();
    skew = 11 * 60 * 1000; // the other legs were read more than 10 minutes ago (still within their TTL)
    const n = s.world.calls.length;
    const r = await read(s, v2, s.first);
    // n01's totals once, the corrected game's legs once — no other game's legs.
    expect(s.world.since(n).filter((c) => c.startsWith('match/get'))).toEqual([`match/get?${FIX.mid}`]);
    expect(s.world.since(n).filter((c) => c.includes('player_stats_list'))).toHaveLength(1);
    expect(r.checks[0].verified.score).toBe(false);
    expect(r.checks[0].verified.f9).toBe(false);
    expect(r.awaitingOfficial).toEqual([TDA_TDID]);
    expect(r.contributions.size).toBe(0);
    const view = shown(s.period, v2, r, s.me.personKey);
    expect(view.metrics.first9.value).toBeNull(); // withheld, not the old 68.26
    expect(view.adoption.metrics.first9.state).not.toBe('players');
  });

  it('legs corrected but n01\'s totals not yet: still not verified; once the totals catch up, the retry verifies with the new values', async () => {
    const s = await start();
    s.world.list = true;
    const v2 = await s.listed(true);
    const lagging = await read(s, v2, s.first);
    s.world.legs = true;
    let n = s.world.calls.length;
    const legsOnly = await read(s, v2, lagging, true);
    expect(s.world.since(n).filter((c) => c.startsWith('match/get'))).toEqual([`match/get?${FIX.mid}`]); // read again: its old legs did not match the row
    expect(legsOnly.checks[0].verified.score).toBe(false);
    expect(legsOnly.checks[0].reason).toContain('反映されていない可能性');
    // Best Leg too waits for the check (Codex audit).
    expect(legsOnly.bestLegs.size).toBe(0);
    expect(legsOnly.bestLegHeld.reasons.join()).toContain('照合が済んでいない');
    s.world.totals = true;
    n = s.world.calls.length;
    const done = await read(s, v2, legsOnly, true);
    expect(s.world.since(n).filter((c) => c.startsWith('match/get'))).toEqual([]); // valid legs reused
    expect(s.world.since(n).filter((c) => c.includes('player_stats_list'))).toHaveLength(1);
    expect(done.checks[0].verified).toMatchObject({ score: true, f9: true });
    expect(done.awaitingOfficial ?? []).toEqual([]);
    expect(done.bestLegs.size).toBeGreaterThan(0);
    const view = shown(s.period, v2, done, s.me.personKey);
    expect(view.metrics.first9).toMatchObject({ num: 3 * 4711, den: 207 });
    expect(view.metrics.first9.value!.toFixed(2)).toBe(((3 * 4711) / 207).toFixed(2));
    expect(view.adoption.metrics.first9.state).toBe('players');
    // The same versions again (a redraw, a tab round trip): nothing is asked of n01.
    n = s.world.calls.length;
    await read(s, v2, done);
    expect(s.world.since(n)).toEqual([]);
  });

  it('the corrected game\'s legs cannot be read: its old legs are not used; First 9 etc. stay withheld, with the reason and a retry', async () => {
    const s = await start();
    s.world.list = true;
    s.world.totals = true;
    s.world.legsDown = true;
    const v2 = await s.listed(true);
    const r = await read(s, v2, s.first);
    // The 3DA may verify from the list rows (the corrected row's 301 is exact for singles); what only
    // the legs give — First 9, Keep/Break, 100+… — stays withheld: its old legs are never used.
    expect(r.checks[0].verified).toMatchObject({ f9: false, break: false, tons: false });
    expect(r.failures.length).toBeGreaterThan(0);
    for (const players of r.contributions.values()) expect(players.get(TDA_PLAYER)?.f9Score).toBeUndefined();
    expect(shown(s.period, v2, r, s.me.personKey).metrics.first9.value).toBeNull();
  });

  it('a doubles pair order corrected (same totals): old legs — kept after a failed read, or served again by n01 — are never used (Codex audit)', async () => {
    const s = await start();
    const doubles = SNAP.games.find((g) => (g.statsData as { order: { oid: string }[] }[]).some((x) => x.order.length === 2 && x.order.some((p) => p.oid === TDA_PLAYER)))!;
    const mid = String(doubles.mid);
    const swapped = SNAP.games.map((g) => (g.mid === mid ? { ...g, statsData: (g.statsData as { order: unknown[] }[]).map((x) => (x.order.length === 2 ? { ...x, order: [...x.order].reverse() } : x)) } : g));
    const orderWorld = s.world as World & { swap?: boolean; swapDown?: boolean };
    const original = orderWorld.request.bind(orderWorld);
    orderWorld.request = async (operation, params) => {
      if (operation === 'match/list' && orderWorld.swap) {
        orderWorld.calls.push(`${operation}?${params.skip ?? ''}`);
        return tdaResponse({ ...SNAP, games: swapped }, operation, params);
      }
      if (operation === 'match/get' && params.mid === mid && orderWorld.swapDown) {
        orderWorld.calls.push(`${operation}?${mid}`);
        throw new Error('down');
      }
      return original(operation, params);
    };
    orderWorld.swap = true;
    const v2 = await s.listed(true);
    // n01 serves the old order again (legs not updated yet): same totals, but not this row → not used.
    const servedOld = await read(s, v2, s.first);
    expect(servedOld.contributions.has(mid)).toBe(false);
    expect(servedOld.checks[0].verified.score).toBe(false);
    // The read fails: the old legs kept from before are not used either.
    orderWorld.swapDown = true;
    const failed = await read(s, v2, servedOld);
    expect(failed.contributions.has(mid)).toBe(false);
    expect(failed.checks[0].verified.score).toBe(false);
    expect(failed.failures.length).toBeGreaterThan(0);
  });

  it('a row giving only one of its totals (the other missing): that one must still match, in both directions (Codex audit 2)', async () => {
    for (const [field, other] of [['allScore', 'allDarts'], ['allDarts', 'allScore']] as const) {
      const s = await start();
      // The corrected game's row: one total missing, the other one more than the old legs show.
      const row = SNAP.games.find((g) => g.mid === FIX.mid)!;
      const side = (row.statsData as { order: { oid: string }[] }[]).findIndex((x) => x.order.length === 1 && x.order[0].oid === TDA_PLAYER);
      const list = SNAP.games.map((g) => (g.mid === FIX.mid ? { ...g, statsData: (g.statsData as Rec[]).map((x, i) => (i === side ? { ...x, [field]: null, [other]: Number(x[other]) + 1 } : x)) } : g));
      const w = s.world as World;
      const original = w.request.bind(w);
      w.request = async (operation, params) => (operation === 'match/list' ? tdaResponse({ ...SNAP, games: list }, operation, params) : original(operation, params));
      const v2 = await s.listed(true);
      const r = await read(s, v2, s.first);
      expect(r.contributions.has(FIX.mid)).toBe(false);
      expect(r.checks[0].verified.f9).toBe(false);
      expect(r.bestLegs.size).toBe(0);
    }
  });
});
