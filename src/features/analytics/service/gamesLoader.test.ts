import { describe, expect, it } from 'vitest';
import { N01Error } from '../../../integrations/n01/client';
import { AnalyticsApi } from '../api/readApi';
import type { AnalyticsTransport } from '../api/readApi';
import { AnalyticsCache } from '../cache/analyticsCache';
import { BOUNDARY_REASON, gamesKey, gamesProgressKey, loadSeasonGames, RUNNING_CHECKPOINT_MS } from './gamesLoader';
import type { GamesContext } from './gamesLoader';

/**
 * `match/list` read to the end across budgets, failures and changes of the list (controlled test
 * data; nothing here reaches n01). The TDO case: 2026/3rd held 1,665 games on 2026-11-15 — 17
 * requests of 100 — beyond the old cap of 15 pages a season.
 */

type Row = Record<string, unknown>;

function rows(n: number, from = 0, unfinished: readonly number[] = []): Row[] {
  const side = (tpid: string, legs: number) => ({ tpid, order: [{ oid: `${tpid}1` }], winLegs: legs, allScore: 501, allDarts: 30 });
  return Array.from({ length: n }, (_, k) => {
    const i = from + k;
    return { mid: `m${i}`, tmid: `t_lg_0_x${i}_A_B`, schid: 's', startTime: 1_000 + i, endMatch: unfinished.includes(i) ? 0 : 1, statsData: [side('A', 2), side('B', 1)] };
  });
}

/** A fake `match/list` over a list the test may change between requests. */
class FakeList implements AnalyticsTransport {
  calls: number[] = [];
  /** Called before each answer (the list can be changed under the reader). */
  before: ((call: number) => void) | null = null;
  /** Requests (by index) that fail, with the error to throw. */
  fail = new Map<number, () => Error>();
  constructor(public list: Row[]) {}
  async request(operation: string, params: Record<string, string>): Promise<unknown> {
    if (operation !== 'match/list') throw new Error(`unexpected ${operation}`);
    const call = this.calls.length;
    const skip = Number(params.skip ?? 0);
    this.calls.push(skip);
    this.before?.(call);
    const failure = this.fail.get(call);
    if (failure) throw failure();
    return { result: 0, list: this.list.slice(skip, skip + Number(params.count)) };
  }
}

const sleeps: number[] = [];
function ctxOf(fake: FakeList, cache: AnalyticsCache, opts: { maxRequests?: number; freshAfter?: number; online?: () => boolean } = {}): GamesContext {
  return {
    api: new AnalyticsApi({ transport: fake, maxRequests: opts.maxRequests }),
    cache,
    isOnline: opts.online ?? (() => true),
    now: () => Date.now(),
    freshAfter: opts.freshAfter,
    sleep: async (ms) => void sleeps.push(ms),
  };
}

const memory = (): AnalyticsCache => new AnalyticsCache({ memoryOnly: true });

describe('match/list: long lists, page boundaries and resuming', () => {
  it('TDO 2026/3rd size (1,665 games): reaches the 17th request and reads every game once; unfinished games are left out', async () => {
    const fake = new FakeList(rows(1665, 0, [1660, 1661, 1662]));
    const result = await loadSeasonGames(ctxOf(fake, memory()), 't_i3FQ_9507', 30);
    expect(fake.calls).toHaveLength(17);
    expect(fake.calls[16]).toBe(100 + 99 * 15 - 1);
    if (!result.ok) throw new Error(result.reason);
    expect(result.games.complete).toBe(true);
    expect(result.games.games).toHaveLength(1662);
    expect(new Set(result.games.games.map((g) => g.gameId)).size).toBe(1662);
    expect(result.games.dropped).toEqual({ unfinished: 3, unreadable: 0, nonLeague: 0 });
  });

  it('a list of exactly 100 or 200 rows: one more request confirms the end, nothing is counted twice', async () => {
    for (const n of [100, 200]) {
      const fake = new FakeList(rows(n));
      const result = await loadSeasonGames(ctxOf(fake, memory()), 't', 40);
      expect(fake.calls).toEqual(n === 100 ? [0, 99] : [0, 99, 198]);
      expect(result.ok && result.games.complete).toBe(true);
      expect(result.ok && result.games.games.length).toBe(n);
    }
  });

  it('cut off by the budget: the checkpoint is kept, the next load continues from it (no page read twice)', async () => {
    const fake = new FakeList(rows(1665));
    const cache = memory();
    const first = await loadSeasonGames(ctxOf(fake, cache, { maxRequests: 5 }), 't', 30);
    expect(first).toMatchObject({ ok: false, kind: 'budget', progress: { rows: 100 + 99 * 4, pages: 5 } });
    expect(await cache.get(gamesKey('t'))).toBeNull(); // nothing passes as the season yet
    const second = await loadSeasonGames(ctxOf(fake, cache, { maxRequests: 100 }), 't', 30);
    expect(second.ok && second.games.complete).toBe(true);
    expect(second.ok && second.games.games.length).toBe(1665);
    expect(fake.calls).toHaveLength(17);
    expect(new Set(fake.calls).size).toBe(17);
    expect(await cache.get(gamesProgressKey('t'))).toBeNull();
  });

  it('a temporary failure is retried (bounded); when it persists the load stops resumable and goes on from there later', async () => {
    const fake = new FakeList(rows(450));
    fake.fail.set(2, () => new N01Error('network', 'down'));
    const cache = memory();
    sleeps.length = 0;
    const retried = await loadSeasonGames(ctxOf(fake, cache), 't', 30);
    expect(retried.ok && retried.games.complete).toBe(true);
    expect(sleeps).toEqual([1_000]);

    const fake2 = new FakeList(rows(450));
    for (const call of [2, 3, 4]) fake2.fail.set(call, () => new N01Error('http', 'busy', 'match/list', 429));
    sleeps.length = 0;
    const cut = await loadSeasonGames(ctxOf(fake2, memory()), 't', 30);
    expect(sleeps).toEqual([5_000, 15_000]); // n01 asked to wait: longer pauses, then it stops
    expect(cut).toMatchObject({ ok: false, kind: 'network', progress: { rows: 199 } });
  });

  it('a game deleted before the boundary between two loads: the old part is not mixed in; the season is read again from its first row', async () => {
    const fake = new FakeList(rows(350));
    const cache = memory();
    await loadSeasonGames(ctxOf(fake, cache, { maxRequests: 2 }), 't', 30); // rows 0–198 kept
    fake.list = fake.list.filter((r) => r.mid !== 'm50');
    const result = await loadSeasonGames(ctxOf(fake, cache), 't', 30);
    if (!result.ok) throw new Error(result.reason);
    expect(result.games.complete).toBe(true);
    expect(result.games.games.map((g) => g.gameId)).not.toContain('m50');
    expect(result.games.games).toHaveLength(349);
    expect(new Set(result.games.games.map((g) => g.gameId)).size).toBe(349);
    // The overlap check failed at skip 198, so the list was read again from 0.
    expect(fake.calls.slice(2)).toEqual([198, 0, 99, 198, 297]);
  });

  it('a game inserted before the boundary while reading (same start time reordered, late entry) is detected the same way', async () => {
    const fake = new FakeList(rows(250));
    fake.before = (call) => {
      if (call === 1) fake.list.splice(10, 0, { ...rows(1, 900)[0], mid: 'late' });
    };
    const result = await loadSeasonGames(ctxOf(fake, memory()), 't', 30);
    expect(result.ok && result.games.complete).toBe(true);
    expect(result.ok && result.games.games.length).toBe(251);
    expect(result.ok && new Set(result.games.games.map((g) => g.gameId)).size).toBe(251);
  });

  it('a list that keeps moving is set aside with the reason, never published as the season', async () => {
    const fake = new FakeList(rows(250));
    let n = 0;
    fake.before = (call) => {
      if (call % 2 === 1) fake.list.splice(0, 0, { ...rows(1, 5000 + n)[0], mid: `new${(n += 1)}` });
    };
    const cache = memory();
    const result = await loadSeasonGames(ctxOf(fake, cache), 't', 30);
    if (!result.ok) throw new Error(result.reason);
    expect(result.games.complete).toBe(false);
    expect(result.games.heldReason).toBe(BOUNDARY_REASON);
    expect(await cache.get(gamesKey('t'))).toBeNull();
    expect(await cache.get(gamesProgressKey('t'))).toBeNull();
  });

  it('a refresh asked after a checkpoint was written starts again from the first row', async () => {
    const fake = new FakeList(rows(300));
    const cache = memory();
    await loadSeasonGames(ctxOf(fake, cache, { maxRequests: 2 }), 't', 30);
    await loadSeasonGames(ctxOf(fake, cache, { freshAfter: Date.now() + 1 }), 't', 30);
    expect(fake.calls.slice(2, 3)).toEqual([0]);
  });

  it('a game unfinished when an earlier load read it, finished since: read again before the season is published (Codex audit)', async () => {
    const fake = new FakeList(rows(120, 0, [50]));
    const cache = memory();
    await loadSeasonGames(ctxOf(fake, cache, { maxRequests: 1 }), 't', 30); // rows 0–99 kept, m50 unfinished
    fake.list[50] = { ...fake.list[50], endMatch: 1 };
    const result = await loadSeasonGames(ctxOf(fake, cache), 't', 30);
    if (!result.ok) throw new Error(result.reason);
    expect(result.games.complete).toBe(true);
    expect(result.games.games).toHaveLength(120);
    expect(result.games.games.map((g) => g.gameId)).toContain('m50');
    expect(result.games.dropped.unfinished).toBe(0);
    // The continuation (skip 99), then the row read again where it was (skip 50).
    expect(fake.calls.slice(1)).toEqual([99, 50]);
  });

  it('…and if the rows around it moved meanwhile, the old part is dropped and the season read again', async () => {
    const fake = new FakeList(rows(120, 0, [50]));
    const cache = memory();
    await loadSeasonGames(ctxOf(fake, cache, { maxRequests: 1 }), 't', 30);
    fake.list.splice(10, 1); // a game before m50 deleted: every later row moves up by one
    const result = await loadSeasonGames(ctxOf(fake, cache), 't', 30);
    if (!result.ok) throw new Error(result.reason);
    expect(result.games.games.map((g) => g.gameId)).not.toContain('m10');
    expect(new Set(result.games.games.map((g) => g.gameId)).size).toBe(result.games.games.length);
    expect(fake.calls).toContain(0);
  });

  it('reading the unfinished rows again is itself resumable: many of them across small budgets end, each read once (Codex audit 2)', async () => {
    const unfinished = Array.from({ length: 10 }, (_, k) => 5 + k * 100);
    const fake = new FakeList(rows(1000, 0, unfinished));
    const cache = memory();
    await loadSeasonGames(ctxOf(fake, cache, { maxRequests: 10 }), 't', 30); // rows 0–990, ten unfinished
    let result = await loadSeasonGames(ctxOf(fake, cache, { maxRequests: 3 }), 't', 30);
    let loads = 1;
    while (!result.ok && loads < 10) {
      expect(result.kind).toBe('budget');
      result = await loadSeasonGames(ctxOf(fake, cache, { maxRequests: 3 }), 't', 30);
      loads += 1;
    }
    if (!result.ok) throw new Error(result.reason);
    expect(result.games.complete).toBe(true);
    expect(result.games.dropped.unfinished).toBe(10);
    expect(result.games.games).toHaveLength(990);
    const rechecks = fake.calls.slice(10).filter((skip) => unfinished.includes(skip));
    expect(rechecks.sort((a, b) => a - b)).toEqual(unfinished);
    expect(loads).toBeLessThanOrEqual(6);
  });

  it('a running season\'s checkpoint older than 30 minutes is not continued (its rows may have been corrected)', async () => {
    let clock = 1_000_000;
    const fake = new FakeList(rows(250));
    const cache = new AnalyticsCache({ memoryOnly: true, now: () => clock });
    const ctx = (max?: number): GamesContext => ({ ...ctxOf(fake, cache, { maxRequests: max }), now: () => clock });
    await loadSeasonGames(ctx(1), 't', 30);
    clock += RUNNING_CHECKPOINT_MS + 1;
    await loadSeasonGames(ctx(), 't', 30);
    expect(fake.calls).toEqual([0, 0, 99, 198]);
  });

  it('offline: an older complete list is used; a checkpoint alone is not passed off as the season', async () => {
    const cache = memory();
    const fake = new FakeList(rows(300));
    await loadSeasonGames(ctxOf(fake, cache, { maxRequests: 1 }), 't', 30);
    const offline = await loadSeasonGames(ctxOf(fake, cache, { online: () => false }), 't', 30);
    expect(offline).toMatchObject({ ok: false, kind: 'offline', progress: { rows: 100 } });
  });
});
