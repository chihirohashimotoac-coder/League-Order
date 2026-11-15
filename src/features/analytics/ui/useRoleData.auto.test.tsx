import { afterEach, describe, expect, it } from 'vitest';
import { act, cleanup, render } from '@testing-library/react';
import { AnalyticsApi } from '../api/readApi';
import type { AnalyticsTransport } from '../api/readApi';
import { AnalyticsCache } from '../cache/analyticsCache';
import { desperadoGames, details, season2024Data, TDID_2024_2ND, wireDetail, withDetailSides } from '../realData.roles.fixtures';
import { HIGH_IN_ATDO_2024_2ND, LEAGUE_ATDO } from '../realData.startRate.fixtures';
import type { PeriodLoad } from '../service/periodService';
import { emptyLoad } from '../service/periodService';
import type { GamesLoad } from '../service/gamesLoader';
import type { AnalyticsServices } from './usePeriodLoad';
import { usePlayerDetail } from './useRoleData';

/**
 * The doubles view's automatic read (C4), through the real hook and a fake n01 whose answers
 * take a few milliseconds, so a player can be switched while a read is under way.
 * Data: the stored ATDO 2024 2nd fixtures (league id set to ATDO's); the timing is simulated.
 */

afterEach(cleanup);

const season = { ...season2024Data(), leagueId: LEAGUE_ATDO };
const raw = withDetailSides(desperadoGames());
const games: GamesLoad = {
  games: new Map([[TDID_2024_2ND, { tournamentId: TDID_2024_2ND, games: raw, dropped: { unfinished: 0, unreadable: 0, nonLeague: 0 }, complete: true }]]),
  failed: new Set(),
  failures: [],
  usedStaleCache: false,
  requestsSent: 0,
};
const periodA: PeriodLoad = emptyLoad({ mode: 'current', currentTournamentId: TDID_2024_2ND }, { seasons: [season], complete: true });
const periodB: PeriodLoad = { ...periodA };
const byId = Object.fromEntries(details().map((d) => [d.gameId, wireDetail(d)]));
const keyOf = (oid: string): string => season.players.find((p) => p.oid === oid)!.personKey;

const n01 = { down: false, calls: [] as string[] };
const transport: AnalyticsTransport = {
  async request(operation, params, signal) {
    await new Promise((resolve) => setTimeout(resolve, 2));
    if (signal.aborted) throw new Error('aborted');
    n01.calls.push(`${operation}?${params.mid ?? params.kind ?? ''}`);
    if (n01.down) throw new Error('network down');
    if (operation === 'match/get') return byId[params.mid] ?? { result: -1, error: 'not found' };
    if (operation === 'tournament/stats' && params.kind === 'player_high_in') return { result: 0, stats: HIGH_IN_ATDO_2024_2ND };
    throw new Error(`unexpected ${operation}`);
  },
};

type Detail = ReturnType<typeof usePlayerDetail>;

function Harness({ services, load, out }: { services: AnalyticsServices; load: PeriodLoad; out: { detail: Detail | null } }): null {
  out.detail = usePlayerDetail(services, load, games, 0);
  return null;
}

async function settle(out: { detail: Detail | null }): Promise<void> {
  for (let i = 0; i < 400 && out.detail!.running !== null; i += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 2));
    });
  }
  expect(out.detail!.running).toBeNull();
}

function setup() {
  n01.down = false;
  n01.calls = [];
  const services: AnalyticsServices = {
    createApi: (signal) => new AnalyticsApi({ transport, signal }),
    createRoleApi: (signal, maxRequests) => new AnalyticsApi({ transport, signal, maxRequests }),
    cache: new AnalyticsCache({ memoryOnly: true }),
  };
  const out: { detail: Detail | null } = { detail: null };
  const view = render(<Harness services={services} load={periodA} out={out} />);
  return { out, services, view };
}

describe('automatic read of the shown doubles player (C4)', () => {
  it('ensure on every render reads the player once; a revisit reads nothing', async () => {
    const { out } = setup();
    await act(async () => {
      out.detail!.ensure(keyOf('63Cz'));
      out.detail!.ensure(keyOf('63Cz'));
    });
    await act(async () => out.detail!.ensure(keyOf('63Cz')));
    await settle(out);
    const first = n01.calls.length;
    expect(n01.calls.filter((c) => c.startsWith('match/get')).length).toBe(14); // 和田's 14 games, once each
    expect(n01.calls.filter((c) => c.includes('player_high_in')).length).toBe(1);
    expect(out.detail!.results.get(keyOf('63Cz'))!.starts[0]).toMatchObject({ attempts: 13, successes: 5 });
    for (let i = 0; i < 3; i += 1) await act(async () => out.detail!.ensure(keyOf('63Cz')));
    expect(out.detail!.running).toBeNull();
    expect(n01.calls.length).toBe(first);
  });

  it('fast switching A → B → A: only the last pick finishes; nothing of the cancelled read is shown under another player', async () => {
    const { out } = setup();
    await act(async () => out.detail!.ensure(keyOf('63Cz')));
    await act(async () => out.detail!.ensure(keyOf('g1vr')));
    await act(async () => out.detail!.ensure(keyOf('63Cz')));
    await settle(out);
    expect([...out.detail!.results.keys()]).toEqual([keyOf('63Cz')]);
    expect(out.detail!.results.get(keyOf('63Cz'))!.starts[0]).toMatchObject({ attempts: 13, successes: 5 });
    // The contributions shown are 和田's only.
    for (const players of out.detail!.contributions.values()) expect([...players.keys()]).toEqual(['63Cz']);
    // B shown again later: read now, and its partner's games already read for A come from the cache.
    const before = n01.calls.length;
    await act(async () => out.detail!.ensure(keyOf('g1vr')));
    await settle(out);
    expect(out.detail!.results.get(keyOf('g1vr'))!.starts[0].doublesGames).toBe(5);
    expect(n01.calls.slice(before)).not.toContain('match/get?VU6AjbQE_1724326953016');
  });

  it('leaving the doubles view (ensure(null)) stops the read: no result, nothing running, no further requests (Codex audit)', async () => {
    const { out } = setup();
    await act(async () => out.detail!.ensure(keyOf('63Cz')));
    await act(async () => out.detail!.ensure(null));
    expect(out.detail!.running).toBeNull();
    const after = n01.calls.length;
    for (let i = 0; i < 40; i += 1) {
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 2));
      });
    }
    expect(out.detail!.results.size).toBe(0);
    expect(out.detail!.contributions.size).toBe(0);
    expect(n01.calls.length).toBeLessThanOrEqual(after + 3); // at most the batch already on the wire
  });

  it('switching to a player already read stops the other player\'s automatic read (Codex audit)', async () => {
    const { out } = setup();
    await act(async () => out.detail!.ensure(keyOf('g1vr')));
    await settle(out);
    await act(async () => out.detail!.ensure(keyOf('63Cz')));
    expect(out.detail!.running).toBe(keyOf('63Cz'));
    await act(async () => out.detail!.ensure(keyOf('g1vr'))); // has a result: no new read, and 和田's stops
    expect(out.detail!.running).toBeNull();
    for (let i = 0; i < 60; i += 1) {
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 2));
      });
    }
    expect([...out.detail!.results.keys()]).toEqual([keyOf('g1vr')]);
    for (const players of out.detail!.contributions.values()) expect(players.has('63Cz')).toBe(false);
  });

  it('a period change while a read is under way: its result is never shown in the new period', async () => {
    const { out, services, view } = setup();
    await act(async () => out.detail!.ensure(keyOf('63Cz')));
    view.rerender(<Harness services={services} load={periodB} out={out} />);
    for (let i = 0; i < 60; i += 1) {
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 2));
      });
    }
    expect(out.detail!.results.size).toBe(0);
    expect(out.detail!.running).toBeNull();
  });

  it('offline: the failure is shown once and not retried on its own; the retry reads again', async () => {
    const { out } = setup();
    n01.down = true;
    await act(async () => out.detail!.ensure(keyOf('63Cz')));
    await settle(out);
    const failed = out.detail!.results.get(keyOf('63Cz'))!;
    expect(failed.failures.length).toBeGreaterThan(0);
    expect(failed.contributions.size).toBe(0);
    const calls = n01.calls.length;
    for (let i = 0; i < 3; i += 1) await act(async () => out.detail!.ensure(keyOf('63Cz')));
    expect(n01.calls.length).toBe(calls); // no loop
    n01.down = false;
    await act(async () => out.detail!.run(keyOf('63Cz'), { fresh: false })); // 「取得できなかった明細を再試行」
    await settle(out);
    expect(out.detail!.results.get(keyOf('63Cz'))!.checks[0].verified.score).toBe(true);
    expect(out.detail!.results.get(keyOf('63Cz'))!.starts[0]).toMatchObject({ attempts: 13, successes: 5 });
  });
});
