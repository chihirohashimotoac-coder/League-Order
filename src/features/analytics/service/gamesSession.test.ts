import { describe, expect, it } from 'vitest';
import { AnalyticsApi } from '../api/readApi';
import type { AnalyticsTransport } from '../api/readApi';
import { AnalyticsCache } from '../cache/analyticsCache';
import { GamesSession } from './gamesSession';
import type { GamesLoad, GamesSessionOptions } from './gamesSession';

/**
 * Twelve seasons' game lists that need far more than one budget (controlled data, no n01): read to
 * the end part after part, newest first, each season published as soon as it is read.
 */

const side = (tpid: string, legs: number) => ({ tpid, order: [{ oid: `${tpid}1` }], winLegs: legs, allScore: 501, allDarts: 30 });
const list = (tdid: string, n: number) => Array.from({ length: n }, (_, i) => ({ mid: `${tdid}-${i}`, tmid: `${tdid}_lg_0_x${i}_A_B`, schid: 's', endMatch: 1, statsData: [side('A', 2), side('B', 1)] }));

class FakeSeasons implements AnalyticsTransport {
  calls: string[] = [];
  down = new Set<string>();
  constructor(readonly seasons: Record<string, ReturnType<typeof list>>) {}
  async request(_operation: string, params: Record<string, string>): Promise<unknown> {
    await Promise.resolve();
    this.calls.push(`${params.tdid}@${params.skip ?? 0}`);
    if (this.down.has(params.tdid)) throw new Error('down');
    const all = this.seasons[params.tdid] ?? [];
    const skip = Number(params.skip ?? 0);
    return { result: 0, list: all.slice(skip, skip + Number(params.count)) };
  }
}

function session(fake: FakeSeasons, extra: Partial<GamesSessionOptions> = {}) {
  const loads: { load: GamesLoad; running: boolean }[] = [];
  let done!: (load: GamesLoad) => void;
  const finished = new Promise<GamesLoad>((resolve) => (done = resolve));
  const s = new GamesSession(
    { createApi: (signal, max) => new AnalyticsApi({ transport: fake, signal, maxRequests: max }), cache: new AnalyticsCache({ memoryOnly: true }), isOnline: () => true, now: () => Date.now(), sleep: async () => undefined, ...extra },
    (load, running) => {
      loads.push({ load, running });
      if (!running && load.pending.size === 0) done(load);
    },
  );
  return { s, loads, finished };
}

const twelve = (): Record<string, ReturnType<typeof list>> => Object.fromEntries(Array.from({ length: 12 }, (_, i) => [`s${i}`, list(`s${i}`, 1000 + i * 37)]));

describe('game lists of a long period (several budgets)', () => {
  it('12 seasons, ~140 requests: continued automatically past 100 requests until every season is read', async () => {
    const fake = new FakeSeasons(twelve());
    const { s, loads, finished } = session(fake);
    s.want(Object.keys(fake.seasons).map((id) => ({ tournamentId: id, status: 40 })));
    const load = await finished;
    expect(fake.calls.length).toBeGreaterThan(100);
    expect(load.units).toBeGreaterThanOrEqual(2);
    expect(load.failures).toEqual([]);
    for (const [id, rows] of Object.entries(fake.seasons)) {
      expect(load.games.get(id)?.complete).toBe(true);
      expect(load.games.get(id)?.games).toHaveLength(rows.length);
    }
    // No page was requested twice, across all parts.
    expect(new Set(fake.calls).size).toBe(fake.calls.length);
    // Newest first: s0 is published before s11, and a partial load never shows s11 before s0.
    const firstWith = (id: string) => loads.findIndex((l) => l.load.games.get(id)?.complete);
    expect(firstWith('s0')).toBeLessThan(firstWith('s11'));
    // While reading, the seasons not yet read are pending — never counted as read.
    const midway = loads.find((l) => l.running && l.load.games.size > 0 && l.load.pending.size > 0)!;
    for (const id of midway.load.pending) expect(midway.load.games.get(id)?.complete ?? false).toBe(false);
  });

  it('one season that cannot be read does not hold up the others; retry() continues it', async () => {
    const fake = new FakeSeasons({ a: list('a', 120), b: list('b', 120), c: list('c', 120) });
    fake.down.add('b');
    const { s, finished } = session(fake);
    s.want(['a', 'b', 'c'].map((id) => ({ tournamentId: id, status: 40 })));
    const load = await finished;
    expect([...load.games.keys()].sort()).toEqual(['a', 'c']);
    expect(load.failures).toMatchObject([{ tournamentId: 'b', kind: 'network' }]);
    expect(s.offlineFailures()).toEqual(['b']);
    fake.down.delete('b');
    const again = new Promise<GamesLoad>((resolve) => {
      const check = setInterval(() => {
        const snap = s.snapshot();
        if (!s.busy && snap.games.get('b')?.complete) {
          clearInterval(check);
          resolve(snap);
        }
      }, 1);
    });
    s.retry();
    expect((await again).failures).toEqual([]);
  });

  it('a unit that can read nothing stops instead of spinning, with a retry offered', async () => {
    const fake = new FakeSeasons({ a: list('a', 120) });
    const { s, finished } = session(fake, { unitRequests: 0 });
    s.want([{ tournamentId: 'a', status: 40 }]);
    const load = await finished;
    expect(load.failures).toMatchObject([{ tournamentId: 'a', kind: 'budget' }]);
    expect(fake.calls).toEqual([]);
  });

  it('after the safety limit of units, the offered retry really continues (Codex audit 2)', async () => {
    const fake = new FakeSeasons({ a: list('a', 1000) });
    const { s, finished } = session(fake, { unitRequests: 2, maxUnits: 2 });
    s.want([{ tournamentId: 'a', status: 40 }]);
    const stopped = await finished;
    expect(stopped.failures).toMatchObject([{ tournamentId: 'a', kind: 'budget' }]);
    expect(fake.calls).toHaveLength(4);
    const done = new Promise<GamesLoad>((resolve) => {
      const check = setInterval(() => {
        const snap = s.snapshot();
        if (!s.busy && (snap.games.get('a')?.complete || snap.failures.length > 0)) {
          clearInterval(check);
          resolve(snap);
        }
      }, 1);
    });
    s.retry();
    const after = await done;
    expect(after.failures).toMatchObject([{ kind: 'budget' }]); // two more units, then the limit again
    expect(fake.calls).toHaveLength(8);
    expect(new Set(fake.calls).size).toBe(8); // continued, nothing read twice
  });

  it('dispose() stops the load: no request after it', async () => {
    const fake = new FakeSeasons(twelve());
    const { s } = session(fake);
    s.want(Object.keys(fake.seasons).map((id) => ({ tournamentId: id, status: 40 })));
    await new Promise((resolve) => setTimeout(resolve, 0));
    s.dispose();
    const at = fake.calls.length;
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(fake.calls.length).toBeLessThanOrEqual(at + 2);
  });
});
