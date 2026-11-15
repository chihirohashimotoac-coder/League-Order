import { describe, expect, it } from 'vitest';
import type { HighInRecord, RawGameDetail } from '../api/parse';
import { AnalyticsApi } from '../api/readApi';
import type { AnalyticsTransport } from '../api/readApi';
import { AnalyticsCache } from '../cache/analyticsCache';
import { safeReconstruct } from '../reconstruct';
import { desperadoGames, details, season2024Data, TDID_2024_2ND, wireDetail, withDetailSides } from '../realData.roles.fixtures';
import { HIGH_IN_ATDO_2024_2ND, LEAGUE_ATDO } from '../realData.startRate.fixtures';
import { periodStart } from '../startRate';
import { detailKey, highInKey, reconstructPerson } from './detailService';
import type { GamesContext } from './gamesLoader';

/**
 * The 個人スタート率 through the reconstruction service, on the stored ATDO 2024 2nd data: real
 * leg details and real high-in records of its doubles slot `rdsi` (19, read 2026-11-15). The
 * season fixture's league id is set to ATDO's (the fixture builder uses a placeholder).
 * Swapped orders, a conflicting high-in record and an old cache are simulated (intentional).
 *
 * 和田 (63Cz), counted by hand from the fixture's visits (rotation from order[0] each leg):
 *   IDnJ5lpQ [MHv6, 63Cz]: 0 0 0 41 | 0 0 0 2          → 63Cz 1/2 + 1/2
 *   VU6AjbQE [63Cz, g1vr]: 80 | 0 0 0 0 0 22 | 0 0 80  → 63Cz 1/1 + 0/3 + 1/2
 *   KbzMhPtz [63Cz, g1vr]: 0 45 | 0 0 45               → 63Cz 0/1 + 1/2
 *   = 5 / 13
 */

const games = withDetailSides(desperadoGames());
const seasonGames = new Map([[TDID_2024_2ND, { tournamentId: TDID_2024_2ND, games, dropped: { unfinished: 0, unreadable: 0, nonLeague: 0 }, complete: true }]]);
const DOUBLES_63CZ = ['IDnJ5lpQ_1726141072552', 'VU6AjbQE_1724326953016', 'KbzMhPtz_1723116985252'];

class FakeN01 implements AnalyticsTransport {
  calls: { operation: string; params: Record<string, string> }[] = [];
  failing = new Set<string>();
  constructor(
    public detailsById: Record<string, unknown>,
    public highIns: HighInRecord[] | null = HIGH_IN_ATDO_2024_2ND,
  ) {}
  async request(operation: string, params: Record<string, string>): Promise<unknown> {
    this.calls.push({ operation, params });
    if (this.failing.has(params.mid ?? params.kind ?? '')) throw new Error('down');
    if (operation === 'match/get') return this.detailsById[params.mid] ?? { result: -1, error: 'not found' };
    if (operation === 'tournament/stats' && params.kind === 'player_high_in') {
      if (!this.highIns) throw new Error('down');
      return { result: 0, stats: this.highIns };
    }
    throw new Error(`unexpected ${operation}`);
  }
  gets(): string[] {
    return this.calls.filter((c) => c.operation === 'match/get').map((c) => c.params.mid);
  }
  highInCalls(): number {
    return this.calls.filter((c) => c.params.kind === 'player_high_in').length;
  }
}

const atdoSeason = () => ({ ...season2024Data(), leagueId: LEAGUE_ATDO });
const ctxOf = (fake: FakeN01, cache = new AnalyticsCache({ memoryOnly: true }), maxRequests?: number): GamesContext => ({ api: new AnalyticsApi({ transport: fake, maxRequests }), cache, isOnline: () => true, now: () => Date.now() });
const keyOf = (oid: string) => atdoSeason().players.find((p) => p.oid === oid)!.personKey;
const wired = (list: RawGameDetail[] = details()) => Object.fromEntries(list.map((d) => [d.gameId, wireDetail(d)]));

describe('個人スタート率 through the reconstruction service', () => {
  it('和田: 5/13 over his three doubles games, adopted because the season matches n01; the high-in records are read once and cached', async () => {
    const fake = new FakeN01(wired());
    const cache = new AnalyticsCache({ memoryOnly: true });
    const result = await reconstructPerson(ctxOf(fake, cache), { seasons: [atdoSeason()], games: seasonGames, personKey: keyOf('63Cz') });
    expect(result.checks[0].verified.score).toBe(true);
    expect(result.starts).toHaveLength(1);
    expect(result.starts[0]).toMatchObject({ doublesGames: 3, counted: 3, attempts: 13, successes: 5, excludedGames: {} });
    expect(periodStart(result.starts)).toMatchObject({ state: 'value', attempts: 13, successes: 5, partial: false });
    expect(fake.highInCalls()).toBe(1);
    // 和田's 14 games are read once (8 multi-thrower + 6 singles): the high-in list adds one request.
    expect(result.requestsSent).toBe(fake.calls.length);
    expect(fake.calls.length).toBe(15);

    // The partner, later: the shared games and the high-in records come from the cache.
    const before = fake.calls.length;
    const partner = await reconstructPerson(ctxOf(fake, cache), { seasons: [atdoSeason()], games: seasonGames, personKey: keyOf('g1vr') });
    expect(fake.calls.slice(before).filter((c) => c.params.kind === 'player_high_in')).toHaveLength(0);
    for (const id of ['VU6AjbQE_1724326953016', 'KbzMhPtz_1723116985252']) expect(fake.gets().slice(before)).not.toContain(id);
    expect(partner.starts[0].doublesGames).toBe(5);
  });

  it('a league nobody declared: no high-in request, every doubles game "ルール不明", no number', async () => {
    const fake = new FakeN01(wired());
    const result = await reconstructPerson(ctxOf(fake), { seasons: [season2024Data()], games: seasonGames, personKey: keyOf('63Cz') });
    expect(fake.highInCalls()).toBe(0);
    expect(result.starts[0]).toMatchObject({ counted: 0, excludedGames: { 'rule-unknown': 3 } });
    expect(periodStart(result.starts)).toMatchObject({ state: 'rule-unknown', value: null });
    // The 3DA is unaffected.
    expect(result.checks[0].verified.score).toBe(true);
  });

  it('the high-in records cannot be read: the slots are unknown (not assumed double-in); the 3DA is kept', async () => {
    const fake = new FakeN01(wired(), null);
    const result = await reconstructPerson(ctxOf(fake), { seasons: [atdoSeason()], games: seasonGames, personKey: keyOf('63Cz') });
    expect(result.starts[0].excludedGames).toEqual({ 'rule-unknown': 3 });
    expect(result.failures.some((f) => f.includes('ハイイン'))).toBe(true);
    expect(result.contributions.size).toBeGreaterThan(0);
  });

  it('投順不一致: a pair order that breaks n01\'s checksum leaves the start attempts out too (never failures)', async () => {
    const swapped = details().map((d) => (d.gameId === 'VU6AjbQE_1724326953016' ? { ...d, sides: d.sides.map((s) => ({ ...s, players: [...s.players].reverse() })) as RawGameDetail['sides'] } : d));
    const result = await reconstructPerson(ctxOf(new FakeN01(wired(swapped))), { seasons: [atdoSeason()], games: seasonGames, personKey: keyOf('63Cz') });
    expect(result.checks[0].state).toBe('mismatch');
    expect(result.starts[0]).toMatchObject({ counted: 0, attempts: 0, excludedGames: { 'order-unverified': 3 } });
    expect(periodStart(result.starts)).toMatchObject({ state: 'unavailable', value: null });
  });

  it('a high-in record of a leg that names the other partner: that game is left out; the same record naming 和田 confirms it', async () => {
    const T = 1_724_326_000_000;
    const timed = details().map((d) => (d.gameId === 'VU6AjbQE_1724326953016' ? { ...d, legs: d.legs.map((leg, i) => (i === 0 ? { ...leg, time: T } : leg)) } : d));
    const other = await reconstructPerson(ctxOf(new FakeN01(wired(timed), [...HIGH_IN_ATDO_2024_2ND, { schid: 'rdsi', oid: 'g1vr', highIn: 80, time: T }])), { seasons: [atdoSeason()], games: seasonGames, personKey: keyOf('63Cz') });
    expect(other.starts[0]).toMatchObject({ counted: 2, attempts: 7, successes: 3, excludedGames: { 'order-conflict': 1 } });
    expect(periodStart(other.starts).partial).toBe(true);
    const same = await reconstructPerson(ctxOf(new FakeN01(wired(timed), [...HIGH_IN_ATDO_2024_2ND, { schid: 'rdsi', oid: '63Cz', highIn: 80, time: T }])), { seasons: [atdoSeason()], games: seasonGames, personKey: keyOf('63Cz') });
    expect(same.starts[0]).toMatchObject({ counted: 3, attempts: 13, successes: 5, highInAgreements: 1 });
  });

  it('the budget runs out: unread doubles games are "未取得", never failures; a season not reached is listed', async () => {
    const result = await reconstructPerson(ctxOf(new FakeN01(wired()), undefined, 3), { seasons: [atdoSeason()], games: seasonGames, personKey: keyOf('63Cz') });
    expect(result.checks[0].state).toBe('incomplete');
    expect(result.starts[0].attempts).toBe(0);
    expect(periodStart(result.starts)).toMatchObject({ state: 'unavailable', value: null });
    const later = { ...atdoSeason(), tournamentId: 'later', title: 'later season' };
    const two = await reconstructPerson(ctxOf(new FakeN01(wired()), undefined, 0), {
      seasons: [atdoSeason(), later],
      games: new Map([...seasonGames, ['later', { ...seasonGames.get(TDID_2024_2ND)!, tournamentId: 'later' }]]),
      personKey: keyOf('63Cz'),
    });
    expect(two.starts.find((s) => s.tournamentId === 'later')).toMatchObject({ seasonReason: expect.stringContaining('未取得'), doublesGames: 3 });
  });
});

describe('an analytics cache written before the start tally existed', () => {
  /** The cache as an older version left it: the same reconstructions, without `start`. */
  async function oldCache(at: number): Promise<AnalyticsCache> {
    const cache = new AnalyticsCache({ memoryOnly: true });
    const gamesHeld = Object.fromEntries(
      details().map((d) => {
        const r = safeReconstruct(d);
        if (r.ok) delete r.start;
        return [d.gameId, { r, at }];
      }),
    );
    await cache.put(detailKey(TDID_2024_2ND), { v: 2, games: gamesHeld }, 7 * 24 * 60 * 60 * 1000);
    await cache.put(highInKey(TDID_2024_2ND), HIGH_IN_ATDO_2024_2ND, 7 * 24 * 60 * 60 * 1000);
    return cache;
  }

  it('only the doubles games of double-in slots are read again; the 3DA figures are the same; the start appears', async () => {
    const fresh = await reconstructPerson(ctxOf(new FakeN01(wired())), { seasons: [atdoSeason()], games: seasonGames, personKey: keyOf('63Cz') });
    const fake = new FakeN01(wired());
    const cache = await oldCache(Date.now());
    const result = await reconstructPerson(ctxOf(fake, cache), { seasons: [atdoSeason()], games: seasonGames, personKey: keyOf('63Cz') });
    // The 5 team games and the singles held in the cache are not read; the 3 doubles games are, once.
    expect(fake.gets().filter((id) => details().some((d) => d.gameId === id)).sort()).toEqual([...DOUBLES_63CZ].sort());
    expect(fake.highInCalls()).toBe(0);
    expect(result.contributions).toEqual(fresh.contributions);
    expect(result.starts[0]).toMatchObject({ counted: 3, attempts: 13, successes: 5 });
    expect(result.stale).toEqual([]);
  });

  it('the reads fail: the old 3DA figures are kept (not stale), and the start is "not counted", not 0/0', async () => {
    const fake = new FakeN01(wired());
    for (const id of DOUBLES_63CZ) fake.failing.add(id);
    const result = await reconstructPerson(ctxOf(fake, await oldCache(Date.now())), { seasons: [atdoSeason()], games: seasonGames, personKey: keyOf('63Cz') });
    expect(result.checks[0].verified.score).toBe(true);
    expect(result.contributions.size).toBeGreaterThan(0);
    expect(result.stale).toEqual([]);
    expect(result.starts[0]).toMatchObject({ counted: 0, attempts: 0, excludedGames: { 'needs-refetch': 3 } });
    expect(periodStart(result.starts)).toMatchObject({ state: 'unavailable', value: null });
  });
});
