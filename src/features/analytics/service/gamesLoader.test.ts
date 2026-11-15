import { describe, expect, it } from 'vitest';
import { N01Error } from '../../../integrations/n01/client';
import { AnalyticsApi } from '../api/readApi';
import type { AnalyticsTransport } from '../api/readApi';
import { AnalyticsCache } from '../cache/analyticsCache';
import { BOUNDARY_REASON, CHANGED_REASON, gamesKey, gamesProgressKey, loadSeasonGames, MAX_CHANGE_RESTARTS, RUNNING_CHECKPOINT_MS } from './gamesLoader';
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

  it('one reading goes on across units in memory: budgets of 5 requests, 1,665 games, no page read twice', async () => {
    const fake = new FakeList(rows(1665));
    const units: AnalyticsApi[] = [];
    const ctx: GamesContext = {
      ...ctxOf(fake, memory(), { maxRequests: 5 }),
      nextApi: async () => {
        const api = new AnalyticsApi({ transport: fake, maxRequests: 5 });
        units.push(api);
        return api;
      },
    };
    const result = await loadSeasonGames(ctx, 't', 30);
    expect(result.ok && result.games.complete).toBe(true);
    expect(result.ok && result.games.games.length).toBe(1665);
    // Reading: 17 requests, none twice. Then the check of the 1,486 rows read before the last switch:
    // 15 requests (修正1), one pass.
    expect(fake.calls.slice(0, 17)).toHaveLength(new Set(fake.calls.slice(0, 17)).size);
    expect(fake.calls[16]).toBe(100 + 99 * 15 - 1);
    expect(fake.calls.slice(17)).toHaveLength(15);
    expect(result.ok && result.games.verified).toEqual({ rows: 1486, pages: 15, restarts: 0 });
    expect(units.length).toBeGreaterThanOrEqual(3);
  });

  it('the browser refuses every write: the reading still goes on from where it is, never back to row 0 (audit 3)', async () => {
    const fake = new FakeList(rows(450));
    const full = new AnalyticsCache({ memoryOnly: true, limits: { maxEntries: 80, maxBytes: 1 } }); // every put → false
    const ctx: GamesContext = { ...ctxOf(fake, full, { maxRequests: 1 }), nextApi: async () => new AnalyticsApi({ transport: fake, maxRequests: 1 }) };
    const result = await loadSeasonGames(ctx, 't', 30);
    // Reading on from where it is (no position twice), then one check of the rows read before the last switch.
    expect(fake.calls).toEqual([0, 99, 198, 297, 396, 0, 99, 198, 297]);
    expect(result.ok && result.games.complete).toBe(true);
    expect(result.ok && result.saveFailed).toBe(true);
  });

  it('a reading that stopped: the next one reads the rows again and compares, nothing is reused', async () => {
    const fake = new FakeList(rows(450));
    const cache = memory();
    const first = await loadSeasonGames(ctxOf(fake, cache, { maxRequests: 2 }), 't', 30);
    expect(first).toMatchObject({ ok: false, kind: 'budget', progress: { rows: 199 } });
    expect(await cache.get(gamesKey('t'))).toBeNull(); // nothing passes as the season yet
    const second = await loadSeasonGames(ctxOf(fake, cache), 't', 30);
    if (!second.ok) throw new Error(second.reason);
    expect(second.games.complete).toBe(true);
    expect(second.games.recollated).toEqual({ rows: 199, corrected: 0, removed: 0, added: 0 });
    expect(fake.calls.slice(2)).toEqual([0, 99, 198, 297, 396]);
    expect(await cache.get(gamesProgressKey('t'))).toBeNull();
  });

  it('① a score corrected under the same id inside the rows already read: the new score is taken, the old one never published (audit 1)', async () => {
    const fake = new FakeList(rows(250));
    const cache = memory();
    await loadSeasonGames(ctxOf(fake, cache, { maxRequests: 1 }), 't', 30); // rows 0–99 read
    const sides = fake.list[40].statsData as Record<string, unknown>[];
    fake.list[40] = { ...fake.list[40], statsData: [{ ...sides[0], allScore: 480, allDarts: 33 }, sides[1]] };
    const result = await loadSeasonGames(ctxOf(fake, cache), 't', 30);
    if (!result.ok) throw new Error(result.reason);
    expect(result.games.complete).toBe(true);
    const g = result.games.games.find((x) => x.gameId === 'm40')!;
    expect([g.sides[0].score, g.sides[0].darts]).toEqual([480, 33]);
    expect(result.games.recollated).toMatchObject({ corrected: 1, removed: 0, added: 0 });
  });

  it('② one game deleted and one added inside the rows already read (the boundary row unchanged): the list is the new one (audit 1)', async () => {
    const fake = new FakeList(rows(250));
    const cache = memory();
    await loadSeasonGames(ctxOf(fake, cache, { maxRequests: 1 }), 't', 30); // rows 0–99 read
    fake.list.splice(20, 1); // m20 deleted …
    fake.list.splice(60, 0, { ...rows(1, 900)[0], mid: 'late' }); // … and a game entered late among them
    expect(fake.list[99].mid).toBe('m99'); // the boundary row is where it was
    const result = await loadSeasonGames(ctxOf(fake, cache), 't', 30);
    if (!result.ok) throw new Error(result.reason);
    expect(result.games.complete).toBe(true);
    const ids = result.games.games.map((g) => g.gameId);
    expect(ids).not.toContain('m20');
    expect(ids).toContain('late');
    expect(ids).toHaveLength(250);
    expect(result.games.recollated).toMatchObject({ corrected: 0, removed: 1, added: 1 });
  });

  it('a temporary failure is retried (bounded); when it persists the reading stops, and the next one compares what it read', async () => {
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

  it('a game deleted before the boundary between two readings: the old part is not mixed in; the season is read again from its first row', async () => {
    const fake = new FakeList(rows(350));
    const cache = memory();
    await loadSeasonGames(ctxOf(fake, cache, { maxRequests: 2 }), 't', 30); // rows 0–198 seen
    fake.list = fake.list.filter((r) => r.mid !== 'm50');
    const result = await loadSeasonGames(ctxOf(fake, cache), 't', 30);
    if (!result.ok) throw new Error(result.reason);
    expect(result.games.complete).toBe(true);
    expect(result.games.games.map((g) => g.gameId)).not.toContain('m50');
    expect(result.games.games).toHaveLength(349);
    expect(new Set(result.games.games.map((g) => g.gameId)).size).toBe(349);
    expect(fake.calls.slice(2)).toEqual([0, 99, 198, 297]);
    expect(result.games.recollated).toMatchObject({ removed: 1 });
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

  it('a game unfinished when an earlier reading saw it, finished since: counted (Codex audit)', async () => {
    const fake = new FakeList(rows(120, 0, [50]));
    const cache = memory();
    await loadSeasonGames(ctxOf(fake, cache, { maxRequests: 1 }), 't', 30); // rows 0–99, m50 unfinished
    fake.list[50] = { ...fake.list[50], endMatch: 1 };
    const result = await loadSeasonGames(ctxOf(fake, cache), 't', 30);
    if (!result.ok) throw new Error(result.reason);
    expect(result.games.complete).toBe(true);
    expect(result.games.games.map((g) => g.gameId)).toContain('m50');
    expect(result.games.dropped.unfinished).toBe(0);
    expect(result.games.recollated).toMatchObject({ corrected: 1 });
  });

  it('the comparison of a long reading spans units too, and every row is read once in it (Codex audit 2)', async () => {
    const fake = new FakeList(rows(1000, 0, [5, 105, 905]));
    const cache = memory();
    await loadSeasonGames(ctxOf(fake, cache, { maxRequests: 10 }), 't', 30); // stopped after 991 rows
    const before = fake.calls.length;
    const result = await loadSeasonGames({ ...ctxOf(fake, cache, { maxRequests: 3 }), nextApi: async () => new AnalyticsApi({ transport: fake, maxRequests: 3 }) }, 't', 30);
    if (!result.ok) throw new Error(result.reason);
    expect(result.games.complete).toBe(true);
    const again = fake.calls.slice(before);
    // 11 requests reading again (none twice), then 9 checking the rows read before the last switch.
    expect(again.slice(0, 11)).toHaveLength(new Set(again.slice(0, 11)).size);
    expect(again).toHaveLength(20);
    expect(result.games.dropped.unfinished).toBe(3);
  });

  it('a running season\'s record older than 30 minutes is not used even for the comparison', async () => {
    let clock = 1_000_000;
    const fake = new FakeList(rows(250));
    const cache = new AnalyticsCache({ memoryOnly: true, now: () => clock });
    const ctx = (max?: number): GamesContext => ({ ...ctxOf(fake, cache, { maxRequests: max }), now: () => clock });
    await loadSeasonGames(ctx(1), 't', 30);
    clock += RUNNING_CHECKPOINT_MS + 1;
    const result = await loadSeasonGames(ctx(), 't', 30);
    expect(fake.calls).toEqual([0, 0, 99, 198]);
    expect(result.ok && result.games.recollated).toBeUndefined(); // too old to compare: simply read
  });

  it('offline: an older complete list is used; a checkpoint alone is not passed off as the season', async () => {
    const cache = memory();
    const fake = new FakeList(rows(300));
    await loadSeasonGames(ctxOf(fake, cache, { maxRequests: 1 }), 't', 30);
    const offline = await loadSeasonGames(ctxOf(fake, cache, { online: () => false }), 't', 30);
    expect(offline).toMatchObject({ ok: false, kind: 'offline', progress: { rows: 100 } });
  });
});

/**
 * 修正1: a reading that moves to the next unit by itself (no stop, no user action). The list is
 * changed by the test exactly when the new unit is handed over, inside the rows already read,
 * with the boundary row left where it was.
 */
describe('match/list: changes while a reading moves on to its next unit', () => {
  type Mutation = (list: Row[]) => void;
  /** Units of `per` requests; `mutate` runs when a unit is handed over (once, or every time). */
  function chained(fake: FakeList, per: number, mutate: Mutation | null, every = false): GamesContext & { switches: () => number } {
    let switches = 0;
    const ctx = {
      ...ctxOf(fake, memory(), { maxRequests: per }),
      nextApi: async () => {
        switches += 1;
        if (mutate && (every || switches === 1)) mutate(fake.list);
        return new AnalyticsApi({ transport: fake, maxRequests: per });
      },
      switches: () => switches,
    };
    return ctx;
  }
  const scoreOf = (result: Awaited<ReturnType<typeof loadSeasonGames>>, mid: string) => {
    if (!result.ok) throw new Error(result.reason);
    const g = result.games.games.find((x) => x.gameId === mid);
    return g ? [g.sides[0].score, g.sides[0].darts] : null;
  };

  it('① a score corrected under the same id (300 → 320): the reading is checked, read again, and the new score published', async () => {
    const fake = new FakeList(rows(250).map((r, i) => (i === 40 ? { ...r, statsData: [{ ...(r.statsData as Row[])[0], allScore: 300 }, (r.statsData as Row[])[1]] } : r)));
    const result = await loadSeasonGames(
      chained(fake, 1, (list) => {
        const sides = list[40].statsData as Row[];
        list[40] = { ...list[40], statsData: [{ ...sides[0], allScore: 320 }, sides[1]] };
      }),
      't',
      30,
    );
    expect(result.ok && result.games.complete).toBe(true);
    expect(scoreOf(result, 'm40')).toEqual([320, 30]);
    expect(result.ok && result.games.verified).toMatchObject({ restarts: 1 });
  });

  it('② a game finished meanwhile: counted after the check (never published as unfinished)', async () => {
    const fake = new FakeList(rows(250, 0, [30]));
    const result = await loadSeasonGames(
      chained(fake, 1, (list) => {
        list[30] = { ...list[30], endMatch: 1 };
      }),
      't',
      30,
    );
    if (!result.ok) throw new Error(result.reason);
    expect(result.games.complete).toBe(true);
    expect(result.games.games.map((g) => g.gameId)).toContain('m30');
    expect(result.games.dropped.unfinished).toBe(0);
    expect(result.games.verified).toMatchObject({ restarts: 1 });
  });

  it('③ one game deleted and one added before the boundary (its row unchanged): the new list, nothing of the old', async () => {
    const fake = new FakeList(rows(250));
    const result = await loadSeasonGames(
      chained(fake, 1, (list) => {
        list.splice(20, 1);
        list.splice(60, 0, { ...rows(1, 900)[0], mid: 'late' });
        expect(list[99].mid).toBe('m99');
      }),
      't',
      30,
    );
    if (!result.ok) throw new Error(result.reason);
    expect(result.games.complete).toBe(true);
    const ids = result.games.games.map((g) => g.gameId);
    expect(ids).not.toContain('m20');
    expect(ids).toContain('late');
    expect(ids).toHaveLength(250);
    expect(new Set(ids).size).toBe(250);
  });

  it('without any change, the check itself spans units, never starts itself again, and costs the rows read before the last switch', async () => {
    const fake = new FakeList(rows(450));
    const ctx = chained(fake, 2, null);
    const result = await loadSeasonGames(ctx, 't', 30);
    if (!result.ok) throw new Error(result.reason);
    expect(result.games.complete).toBe(true);
    // Reading: 0, 99 | 198, 297 | 396 (end) — the last switch came after 397 rows; checking them: 0, 99 | 198, 297.
    expect(fake.calls).toEqual([0, 99, 198, 297, 396, 0, 99, 198, 297]);
    expect(result.games.verified).toEqual({ rows: 397, pages: 4, restarts: 0 });
    expect(ctx.switches()).toBeGreaterThanOrEqual(3);
  });

  it('changes that keep coming: set aside with the reason after a bounded number of restarts, never published', async () => {
    const fake = new FakeList(rows(250));
    let n = 0;
    const ctx = chained(
      fake,
      1,
      (list) => {
        const sides = list[10].statsData as Row[];
        list[10] = { ...list[10], statsData: [{ ...sides[0], allScore: 400 + (n += 1) }, sides[1]] };
      },
      true,
    );
    const result = await loadSeasonGames(ctx, 't', 30);
    if (!result.ok) throw new Error(result.reason);
    expect(result.games.complete).toBe(false);
    expect(result.games.heldReason).toBe(CHANGED_REASON);
    expect(MAX_CHANGE_RESTARTS).toBe(2);
    expect(fake.calls.length).toBeLessThan(40);
  });
});
