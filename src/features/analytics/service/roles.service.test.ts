import { describe, expect, it } from 'vitest';
import { AnalyticsApi } from '../api/readApi';
import type { AnalyticsTransport } from '../api/readApi';
import { AnalyticsCache } from '../cache/analyticsCache';
import { desperadoGames, details, season2024Data, TDID_2024_2ND, wireDetail, wireGame, withDetailSides } from '../realData.roles.fixtures';
import { reconstructPerson } from './detailService';
import { loadGames, loadSeasonGames, MAX_GAME_PAGES } from './gamesLoader';
import type { GamesContext } from './gamesLoader';

/** A fake n01 serving `match/list` pages and `match/get` from fixtures, recording each call. */
class FakeGames implements AnalyticsTransport {
  calls: { operation: string; params: Record<string, string> }[] = [];
  failing = new Set<string>();
  constructor(
    readonly rows: Record<string, Record<string, unknown>[]>,
    readonly detailsById: Record<string, unknown> = {},
  ) {}
  async request(operation: string, params: Record<string, string>): Promise<unknown> {
    this.calls.push({ operation, params });
    if (this.failing.has(params.tdid ?? params.mid)) throw new Error('boom');
    if (operation === 'match/list') {
      const all = this.rows[params.tdid] ?? [];
      const skip = Number(params.skip ?? 0);
      return { result: 0, list: all.slice(skip, skip + Number(params.count)) };
    }
    if (operation === 'match/get') {
      const found = this.detailsById[params.mid];
      if (!found) return { result: -1, error: 'not found' };
      return found;
    }
    throw new Error(`unexpected ${operation}`);
  }
}

function ctxOf(fake: FakeGames, opts: { maxRequests?: number; online?: () => boolean; cache?: AnalyticsCache; signal?: AbortSignal } = {}): GamesContext {
  return { api: new AnalyticsApi({ transport: fake, maxRequests: opts.maxRequests }), cache: opts.cache ?? new AnalyticsCache({ memoryOnly: true }), isOnline: opts.online ?? (() => true), now: () => Date.now(), signal: opts.signal };
}

function synthetic(n: number, extra: Record<string, unknown>[] = []): Record<string, unknown>[] {
  const side = (tpid: string) => ({ tpid, order: [{ oid: `${tpid}1` }], winLegs: 1, allScore: 501, allDarts: 30 });
  return [...Array.from({ length: n }, (_, i) => ({ mid: `m${i}`, tmid: `t_lg_0_x${i}_A_B`, schid: 's', endMatch: 1, statsData: [side('A'), side('B')] })), ...extra];
}

describe('game rows loader', () => {
  it('pages through match/list (100 a page, oldest first, league games only) and keeps unfinished / playoff rows out', async () => {
    const extra = [
      { mid: 'u', tmid: 't_lg_0_u_A_B', schid: 's', endMatch: 0, statsData: synthetic(1)[0].statsData },
      { mid: 'p', tmid: 't_m_0_A_B', schid: 's', endMatch: 1, statsData: synthetic(1)[0].statsData },
    ];
    const fake = new FakeGames({ t: synthetic(230, extra) });
    const result = await loadSeasonGames(ctxOf(fake), 't', 40);
    expect(fake.calls).toHaveLength(3);
    expect(fake.calls[0].params).toMatchObject({ tdid: 't', tmid__regex: '_lg_', sort: 'startTime', order: 'asc', count: '100' });
    expect(fake.calls[2].params.skip).toBe('200');
    if (!result.ok) throw new Error(result.reason);
    expect(result.games.games).toHaveLength(230);
    expect(result.games.dropped).toEqual({ unfinished: 1, unreadable: 0, nonLeague: 1 });
    expect(result.games.complete).toBe(true);
  });

  it('serves the second load from the cache, and offline from a stale cache', async () => {
    const fake = new FakeGames({ t: synthetic(10) });
    const cache = new AnalyticsCache({ memoryOnly: true });
    await loadSeasonGames(ctxOf(fake, { cache }), 't', 40);
    const again = await loadSeasonGames(ctxOf(fake, { cache }), 't', 40);
    expect(again).toMatchObject({ ok: true, source: 'cache' });
    expect(fake.calls).toHaveLength(1);
    const offline = await loadSeasonGames(ctxOf(fake, { online: () => false }), 'other', 40);
    expect(offline).toMatchObject({ ok: false, kind: 'offline' });
  });

  it('a runaway list stops at the page cap and is marked incomplete', async () => {
    const fake = new FakeGames({ t: synthetic(MAX_GAME_PAGES * 100 + 5) });
    const result = await loadSeasonGames(ctxOf(fake), 't', 40);
    expect(fake.calls).toHaveLength(MAX_GAME_PAGES);
    expect(result.ok && result.games.complete).toBe(false);
  });

  it('one failed season does not drop the others; a budget stop marks the rest as missing', async () => {
    const fake = new FakeGames({ a: synthetic(3), b: synthetic(3), c: synthetic(3) });
    fake.failing.add('b');
    const load = await loadGames(ctxOf(fake), [{ tournamentId: 'a', status: 40 }, { tournamentId: 'b', status: 40 }, { tournamentId: 'c', status: 40 }], 1);
    expect([...load.games.keys()]).toEqual(['a', 'c']);
    expect([...load.failed]).toEqual(['b']);
    const limited = await loadGames(ctxOf(new FakeGames({ a: synthetic(3), b: synthetic(3) }), { maxRequests: 1 }), [{ tournamentId: 'a', status: 40 }, { tournamentId: 'b', status: 40 }], 1);
    expect([...limited.failed]).toEqual(['b']);
    expect(limited.failures[0].kind).toBe('budget');
  });

  it('a cancelled load stops without throwing', async () => {
    const controller = new AbortController();
    controller.abort();
    const result = await loadSeasonGames(ctxOf(new FakeGames({ t: synthetic(3) }), { signal: controller.signal }), 't', 40);
    expect(result).toMatchObject({ ok: false, kind: 'aborted' });
  });
});

describe('leg reconstruction service (real 2024 2nd data)', () => {
  const games = withDetailSides(desperadoGames());
  const seasonGames = new Map([[TDID_2024_2ND, { tournamentId: TDID_2024_2ND, games, dropped: { unfinished: 0, unreadable: 0, nonLeague: 0 }, complete: true }]]);
  const detailsById = Object.fromEntries(details().map((d) => [d.gameId, wireDetail(d)]));

  it('fetches only the selected player\'s games, multi-thrower first; verifies against n01; reuses the cache', async () => {
    const fake = new FakeGames({ [TDID_2024_2ND]: games.map(wireGame) }, detailsById);
    const cache = new AnalyticsCache({ memoryOnly: true });
    const s = season2024Data();
    const personKey = s.players.find((p) => p.oid === '63Cz')!.personKey;
    const result = await reconstructPerson(ctxOf(fake, { cache }), { seasons: [s], games: seasonGames, personKey });
    const gets = fake.calls.filter((c) => c.operation === 'match/get');
    // 14 games of 63Cz: 8 multi-thrower ones first (the singles details are not in the fixture: their rows are exact anyway).
    expect(gets).toHaveLength(14);
    expect(new Set(gets.slice(0, 8).map((c) => c.params.mid))).toEqual(new Set(['IDnJ5lpQ_1726141072552', 'VU6AjbQE_1724326953016', 'KbzMhPtz_1723116985252', 'DuLnRiIn_1725534127641', '4jAYcZhO_1724324048336', '3Q67NKwR_1723114512738', 'o60HB8iW_1722509317072', 'WJ4INlYl_1726742612593']));
    expect(result.checks[0]).toMatchObject({ state: 'partly-verified', verified: { score: true } });
    expect(result.contributions.get('VU6AjbQE_1724326953016')?.get('63Cz')).toMatchObject({ score: expect.any(Number), darts: expect.any(Number) });

    // A partner (永野 優子) shares 7 of those games: they come from the cache, not the network.
    const before = fake.calls.length;
    const g1vr = s.players.find((p) => p.oid === 'g1vr')!.personKey;
    await reconstructPerson(ctxOf(fake, { cache }), { seasons: [s], games: seasonGames, personKey: g1vr });
    const refetched = fake.calls.slice(before).filter((c) => c.operation === 'match/get').map((c) => c.params.mid);
    for (const shared of ['VU6AjbQE_1724326953016', 'KbzMhPtz_1723116985252', 'DuLnRiIn_1725534127641', '4jAYcZhO_1724324048336', '3Q67NKwR_1723114512738', 'o60HB8iW_1722509317072', 'WJ4INlYl_1726742612593']) {
      expect(refetched).not.toContain(shared);
    }
  });

  it('a budget that runs out leaves the season "incomplete" — nothing is estimated', async () => {
    const fake = new FakeGames({ [TDID_2024_2ND]: games.map(wireGame) }, detailsById);
    const s = season2024Data();
    const personKey = s.players.find((p) => p.oid === '63Cz')!.personKey;
    const result = await reconstructPerson(ctxOf(fake, { maxRequests: 3 }), { seasons: [s], games: seasonGames, personKey });
    expect(result.checks[0].state).toBe('incomplete');
    expect(result.contributions.size).toBe(0);
  });
});
