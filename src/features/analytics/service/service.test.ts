import 'fake-indexeddb/auto';
import { describe, expect, it } from 'vitest';
import { openBackend, resetBackendCache } from '../../../storage/db';
import { AnalyticsApi } from '../api/readApi';
import type { AnalyticsTransport } from '../api/readApi';
import { AnalyticsCache, ANALYTICS_DB_NAME } from '../cache/analyticsCache';
import { describeLoad, loadPeriod, periodLabelAllowed } from './periodService';
import { loadSeason } from './seasonLoader';
import type { LoaderContext } from './seasonLoader';

// ---- a tiny fake n01 --------------------------------------------------------------

interface FakeSeason {
  id: string;
  title: string;
  status?: number;
  startedAt: number;
  startScore?: number;
}

const TEAMS = [
  { tpid: 'T1', name: 'Alpha' },
  { tpid: 'T2', name: 'Beta' },
];

function statsRow(tpid: string | null, extra: Record<string, unknown> = {}) {
  return { score: 3000, darts: 300, winLeg: 5, leg: 10, a_b: 5, w_b: 2, winMatch: 1, match: 2, winSet: 3, set: 6, f9Score: 900, f9Darts: 90, ...(tpid ? { tpid } : {}), ...extra };
}

class FakeN01 implements AnalyticsTransport {
  calls: string[] = [];
  failing = new Set<string>();
  constructor(readonly seasons: FakeSeason[]) {}
  async request(operation: string, params: Record<string, string>): Promise<unknown> {
    const tdid = params.tdid;
    this.calls.push(`${operation}:${tdid ?? params.lgid}${params.kind ? `:${params.kind}` : ''}`);
    if ([...this.failing].some((f) => `${operation}:${tdid ?? params.lgid}`.startsWith(f))) throw new Error('boom');
    if (operation === 'league/tournament/list') {
      return { result: 0, list: this.seasons.map((s) => ({ tdid: s.id, title: s.title, status: s.status ?? 40, t_date: s.startedAt })) };
    }
    const season = this.seasons.find((s) => s.id === tdid)!;
    switch (operation) {
      case 'tournament/get':
        return {
          result: 0,
          tournament: {
            tdid, title: season.title, lgid: 'lg1', status: season.status ?? 40,
            entry_list: TEAMS.map((t) => ({ tpid: t.tpid, name: t.name })),
            lg_table: [TEAMS.map((t) => t.tpid)], lg_title: ['A'],
            lg_setting: { schedule: [{ schid: 's1', num_part: 1, match_type: '01', startScore: season.startScore ?? 501, limit_leg_count: 2 }] },
          },
        };
      case 'tournament/stats':
        return params.kind === 'stats_list'
          ? { result: 0, stats: { T1: statsRow(null, { r_g: 0 }), T2: statsRow(null, { r_g: 0 }) } }
          : { result: 0, stats: { [`${tdid}p1`]: statsRow('T1', { opid: 'op1', oname: 'P1' }), [`${tdid}p2`]: statsRow('T2', { opid: 'op2', oname: 'P2' }) } };
      case 'tournament/standings':
        return { result: 0, groups: [{ kind: 'lg', index: 0, title: 'A', players: TEAMS.map((t, i) => ({ tpid: t.tpid, name: t.name, rank: i + 1, p: 2, w: 1, d: 0, l: 1, pts: 9 })) }] };
      case 'team/player/list':
        return { result: 0, list: [{ oid: `${tdid}p1`, opid: 'op1', tpid: 'T1', oname: 'P1' }, { oid: `${tdid}p2`, opid: 'op2', tpid: 'T2', oname: 'P2' }] };
    }
    throw new Error(`unexpected ${operation}`);
  }
}

const SEASONS: FakeSeason[] = [
  { id: 's5', title: '2026 3rd', status: 30, startedAt: 5000 },
  { id: 's4', title: '2026 2nd', startedAt: 4000 },
  { id: 's3', title: '2025 イヤーズチャンピオンシップ', startedAt: 3500 },
  { id: 's2', title: '2026 1st', startedAt: 3000 },
  { id: 's1', title: '2025 3rd', startedAt: 2000 },
];

function setup(seasons = SEASONS, opts: { now?: () => number; maxRequests?: number; online?: () => boolean } = {}) {
  const fake = new FakeN01(seasons);
  const api = new AnalyticsApi({ transport: fake, maxRequests: opts.maxRequests });
  const cache = new AnalyticsCache({ memoryOnly: true, now: opts.now });
  const ctx: LoaderContext = { api, cache, isOnline: opts.online ?? (() => true), now: opts.now ?? (() => Date.now()) };
  return { fake, api, cache, ctx };
}

// ---- season loader ------------------------------------------------------------------

describe('loadSeason', () => {
  it('fetches once, then serves the fresh cache without any request', async () => {
    const { fake, ctx } = setup();
    const first = await loadSeason(ctx, 's4');
    expect(first).toMatchObject({ ok: true, source: 'network', missing: [] });
    expect(fake.calls).toHaveLength(5);
    const second = await loadSeason(ctx, 's4');
    expect(second).toMatchObject({ ok: true, source: 'cache' });
    expect(fake.calls).toHaveLength(5);
  });

  it('a missing standings / roster makes the season partial instead of failing it', async () => {
    const { fake, ctx } = setup();
    fake.failing.add('tournament/standings');
    fake.failing.add('team/player/list');
    const result = await loadSeason(ctx, 's4');
    expect(result).toMatchObject({ ok: true, missing: ['standings', 'roster'] });
  });

  it('a required part failing fails the season, never throwing', async () => {
    const { fake, ctx } = setup();
    fake.failing.add('tournament/stats');
    const result = await loadSeason(ctx, 's4');
    expect(result.ok).toBe(false);
  });

  it('after expiry a failed refresh falls back to the stale copy and says so', async () => {
    let t = 1_000;
    const { fake, ctx } = setup(SEASONS, { now: () => t });
    await loadSeason(ctx, 's4');
    t += 30 * 24 * 60 * 60 * 1000;
    fake.failing.add('tournament/get');
    // A new load gets a new adapter (the adapter memoises within one load only).
    const result = await loadSeason({ ...ctx, api: new AnalyticsApi({ transport: fake }) }, 's4');
    expect(result).toMatchObject({ ok: true, source: 'stale-cache' });
    expect((result as { error?: string }).error).toContain('保存済み');
  });

  it('offline: uses any cached copy, otherwise reports offline — with zero requests', async () => {
    let online = true;
    const { fake, ctx } = setup(SEASONS, { online: () => online });
    await loadSeason(ctx, 's4');
    const before = fake.calls.length;
    online = false;
    expect(await loadSeason({ ...ctx, forceRefresh: true }, 's4')).toMatchObject({ ok: true, source: 'stale-cache' });
    expect(await loadSeason(ctx, 's1')).toMatchObject({ ok: false, kind: 'offline' });
    expect(fake.calls).toHaveLength(before);
  });
});

// ---- period service -----------------------------------------------------------------

describe('loadPeriod', () => {
  const base = { leagueId: 'lg1', isOnline: () => true };

  it('current: one season', async () => {
    const { api, cache } = setup();
    const load = await loadPeriod({ ...base, api, cache, request: { mode: 'current', currentTournamentId: 's5' } });
    expect(load.seasons.map((s) => s.tournamentId)).toEqual(['s5']);
    expect(periodLabelAllowed(load)).toBe('full');
  });

  it('last3 stops at three eligible seasons, skipping the championship without fetching it', async () => {
    const { api, cache, fake } = setup();
    const load = await loadPeriod({ ...base, api, cache, request: { mode: 'last3', currentTournamentId: 's5' } });
    expect(load.seasons.map((s) => s.tournamentId)).toEqual(['s5', 's4', 's2']);
    expect(load.skipped.map((s) => s.tournamentId)).toEqual(['s3']);
    expect(fake.calls.some((c) => c.includes('s3') || c.includes('s1'))).toBe(false);
    expect(load.requestsSent).toBe(1 + 3 * 5);
    expect(load.complete).toBe(true);
  });

  it('all: every eligible season; the second run is served from the cache with no requests', async () => {
    const { api, cache, fake } = setup();
    const req = { mode: 'all', currentTournamentId: 's5' } as const;
    const first = await loadPeriod({ ...base, api, cache, request: req });
    expect(first.seasons.map((s) => s.tournamentId)).toEqual(['s5', 's4', 's2', 's1']);
    expect(periodLabelAllowed(first)).toBe('full');
    const calls = fake.calls.length;
    const second = await loadPeriod({ ...base, api, cache, request: req });
    expect(second.seasons).toHaveLength(4);
    expect(fake.calls).toHaveLength(calls);
  });

  it('a season that cannot be read makes "all" partial — never labelled as full history', async () => {
    const { api, cache, fake } = setup();
    fake.failing.add('tournament/stats:s2'.replace(':s2', ''));
    const load = await loadPeriod({ ...base, api, cache, request: { mode: 'all', currentTournamentId: 's5' } });
    expect(load.seasons).toHaveLength(0);
    expect(load.failures.length).toBeGreaterThan(0);
    const { fake: fake2, api: api2, cache: cache2 } = setup();
    const original = fake2.request.bind(fake2);
    fake2.request = async (op, params) => {
      if (op === 'tournament/get' && params.tdid === 's2') throw new Error('boom');
      return original(op, params);
    };
    const partial = await loadPeriod({ ...base, api: api2, cache: cache2, request: { mode: 'all', currentTournamentId: 's5' } });
    expect(partial.seasons.map((s) => s.tournamentId)).toEqual(['s5', 's4', 's1']);
    expect(partial.complete).toBe(false);
    expect(periodLabelAllowed(partial)).toBe('partial');
    expect(describeLoad(partial).kind).toBe('partial');
  });

  it('the request budget stops the fetch and the result says it is partial', async () => {
    const { api, cache } = setup(SEASONS, { maxRequests: 8 });
    const load = await loadPeriod({ ...base, api, cache, request: { mode: 'all', currentTournamentId: 's5' } });
    expect(api.requestCount).toBeLessThanOrEqual(8);
    expect(load.complete).toBe(false);
    expect(load.failures.some((f) => f.kind === 'budget')).toBe(true);
  });

  it('a season cap cuts "all" short and marks it incomplete', async () => {
    const { api, cache } = setup();
    const load = await loadPeriod({ ...base, api, cache, maxSeasons: 2, request: { mode: 'all', currentTournamentId: 's5' } });
    expect(load.seasons).toHaveLength(2);
    expect(load.complete).toBe(false);
  });

  it('seasons with another format are not pooled and are reported', async () => {
    const seasons = SEASONS.map((s) => (s.id === 's2' ? { ...s, startScore: 701 } : s));
    const { api, cache } = setup(seasons);
    const load = await loadPeriod({ ...base, api, cache, request: { mode: 'last3', currentTournamentId: 's5' } });
    expect(load.seasons.map((s) => s.tournamentId)).toEqual(['s5', 's4']);
    expect(load.formatExcluded.map((s) => s.tournamentId)).toEqual(['s2']);
    expect(periodLabelAllowed(load)).toBe('partial');
  });

  it('league list failure is a state, not an exception; offline with a warm cache still works', async () => {
    const { fake, api, cache } = setup();
    fake.failing.add('league/tournament/list');
    const failed = await loadPeriod({ ...base, api, cache, request: { mode: 'current', currentTournamentId: 's5' } });
    expect(failed.listError).not.toBeNull();
    expect(describeLoad(failed).kind).toBe('error');

    const warm = setup();
    const req = { mode: 'last3', currentTournamentId: 's5' } as const;
    await loadPeriod({ ...base, api: warm.api, cache: warm.cache, request: req });
    const calls = warm.fake.calls.length;
    const offline = await loadPeriod({ leagueId: 'lg1', api: warm.api, cache: warm.cache, request: req, isOnline: () => false, forceRefresh: true });
    expect(offline.seasons).toHaveLength(3);
    expect(offline.offline).toBe(true);
    expect(describeLoad(offline).kind).toBe('offline-cache');
    expect(warm.fake.calls).toHaveLength(calls);
  });

  it('a specified season that is not in the league is reported, not guessed', async () => {
    const { api, cache } = setup();
    const load = await loadPeriod({ ...base, api, cache, request: { mode: 'specified', currentTournamentId: 's5', specifiedTournamentId: 'nope' } });
    expect(load.seasons).toEqual([]);
    expect(describeLoad(load).kind).toBe('empty');
  });
});

// ---- cache ----------------------------------------------------------------------------

describe('AnalyticsCache', () => {
  it('evicts least-recently-used entries beyond the entry limit', async () => {
    let t = 0;
    const cache = new AnalyticsCache({ memoryOnly: true, now: () => ++t, limits: { maxEntries: 2, maxBytes: 1e6 } });
    await cache.put('a', { v: 1 }, 1000);
    await cache.put('b', { v: 2 }, 1000);
    await cache.get('a'); // a is now more recent than b
    await cache.put('c', { v: 3 }, 1000);
    expect((await cache.keys()).sort()).toEqual(['a', 'c']);
  });

  it('evicts by total bytes and refuses a single oversize value', async () => {
    const cache = new AnalyticsCache({ memoryOnly: true, limits: { maxEntries: 10, maxBytes: 100 } });
    expect(await cache.put('big', 'x'.repeat(500), 1000)).toBe(false);
    await cache.put('a', 'x'.repeat(40), 1000);
    await cache.put('b', 'x'.repeat(40), 1000);
    await cache.put('c', 'x'.repeat(40), 1000);
    expect((await cache.keys()).length).toBeLessThanOrEqual(2);
  });

  it('marks expired entries stale but still returns them', async () => {
    let t = 0;
    const cache = new AnalyticsCache({ memoryOnly: true, now: () => t });
    await cache.put('k', 1, 100);
    t = 50;
    expect(cache.isFresh((await cache.get('k'))!)).toBe(true);
    t = 500;
    const entry = (await cache.get('k'))!;
    expect(entry.value).toBe(1);
    expect(cache.isFresh(entry)).toBe(false);
  });

  it('lives in its own IndexedDB and leaves the app database (v3) untouched', async () => {
    resetBackendCache();
    const app = await openBackend();
    await app.put('teams', { id: 't1', name: 'Mine' } as never);
    const before = await app.getAll('teams');
    const cache = new AnalyticsCache();
    expect(await cache.put('k', { a: 1 }, 1000)).toBe(true);
    expect(cache.mode).toBe('indexeddb');
    expect((await cache.get<{ a: number }>('k'))!.value).toEqual({ a: 1 });
    const dbs = (await indexedDB.databases()).map((d) => [d.name, d.version]);
    expect(dbs).toContainEqual([ANALYTICS_DB_NAME, 1]);
    expect(dbs).toContainEqual(['darts-league-order', 3]);
    expect(await app.getAll('teams')).toEqual(before);
    expect(await app.getAll('n01Cache')).toEqual([]);
    await cache.clear();
  });

  it('survives a broken IndexedDB by falling back to memory', async () => {
    const original = indexedDB.open.bind(indexedDB);
    (indexedDB as { open: unknown }).open = () => {
      throw new Error('blocked');
    };
    try {
      const cache = new AnalyticsCache();
      expect(await cache.put('k', 1, 1000)).toBe(true);
      expect(cache.mode).toBe('memory');
      expect((await cache.get('k'))!.value).toBe(1);
    } finally {
      (indexedDB as { open: unknown }).open = original;
    }
  });
});
