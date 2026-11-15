import { act, cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { AnalyticsApi } from '../api/readApi';
import type { AnalyticsTransport } from '../api/readApi';
import { AnalyticsCache } from '../cache/analyticsCache';
import { tdaCopies, tdaMultiResponse } from '../realData.tda.fixtures';
import type { TdaSnapshot } from '../realData.tda.fixtures';
import TDA_RAW from '../realData.tda.json';
import type { GameScope } from '../roleGames';
import { loadPeriod } from '../service/periodService';
import type { PeriodLoad } from '../service/periodService';
import type { AnalyticsServices } from './usePeriodLoad';
import { useGamesLoad } from './useRoleData';
import type { GamesState } from './useRoleData';

/**
 * The game lists of the open period through the real hook: one read per period whatever views are
 * switched, continued after going back online, and nothing of another period shown. Three seasons
 * built from the real TDA season (simulated copies); n01 is a fake that answers after a tick.
 */

afterEach(cleanup);

const COPIES = tdaCopies(TDA_RAW as unknown as TdaSnapshot, 3);

class World implements AnalyticsTransport {
  calls: string[] = [];
  down = false;
  async request(operation: string, params: Record<string, string>, signal: AbortSignal): Promise<unknown> {
    await new Promise((resolve) => setTimeout(resolve, 1));
    if (signal.aborted) throw new Error('aborted');
    if (operation === 'match/list') this.calls.push(`${params.tdid}@${params.skip ?? 0}`);
    if (this.down && operation === 'match/list') throw new Error('offline');
    const body = tdaMultiResponse(COPIES, operation, params);
    if (body === undefined) throw new Error(`unexpected ${operation}`);
    return body;
  }
}

function Harness({ services, load, scope, out }: { services: AnalyticsServices; load: PeriodLoad | null; scope: GameScope; out: { games: GamesState | null } }): null {
  out.games = useGamesLoad(services, load, scope, 0);
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
  const load = await loadPeriod({ api: new AnalyticsApi({ transport: world }), cache, leagueId: COPIES.seasons[0].league.lgid, request: { mode: 'last3', currentTournamentId: COPIES.ids[0] } });
  const out: { games: GamesState | null } = { games: null };
  const view = render(<Harness services={services} load={load} scope="all01" out={out} />);
  const tick = async (n = 1): Promise<void> => {
    for (let i = 0; i < n; i += 1) await act(async () => new Promise((resolve) => setTimeout(resolve, 2)));
  };
  return { world, load, out, view, services, tick };
}

describe('game lists of the open period, shared by every view', () => {
  it('01全体 of all-01 seasons needs none; switching シングルス ↔ 01全体 ↔ ダブルス while reading never repeats a request', async () => {
    const { world, load, out, view, services, tick } = await setup();
    expect(out.games!.status).toBe('idle');
    expect(world.calls).toEqual([]);
    for (const scope of ['singles', 'all01', 'doubles', 'all01', 'singles'] as const) {
      view.rerender(<Harness services={services} load={load} scope={scope} out={out} />);
      await tick();
    }
    for (let i = 0; i < 200 && out.games!.status !== 'done'; i += 1) await tick();
    expect(out.games!.status).toBe('done');
    expect(world.calls).toHaveLength(3);
    expect(new Set(world.calls).size).toBe(3);
    for (const id of COPIES.ids) expect(out.games!.load!.games.get(id)?.complete).toBe(true);
  });

  it('offline: the seasons fail once; back online they continue by themselves', async () => {
    const { world, load, out, view, services, tick } = await setup();
    world.down = true;
    view.rerender(<Harness services={services} load={load} scope="singles" out={out} />);
    for (let i = 0; i < 200 && out.games!.status !== 'done'; i += 1) await tick();
    expect(out.games!.load!.failures.map((f) => f.kind)).toEqual(['network', 'network', 'network']);
    const failedCalls = world.calls.length;
    await tick(5);
    expect(world.calls.length).toBe(failedCalls); // no loop while offline
    world.down = false;
    await act(async () => void window.dispatchEvent(new Event('online')));
    for (let i = 0; i < 200 && (out.games!.status !== 'done' || out.games!.load!.failures.length > 0); i += 1) await tick();
    for (const id of COPIES.ids) expect(out.games!.load!.games.get(id)?.complete).toBe(true);
  });

  it('a period change stops the old read; nothing of the old period is shown in the new one', async () => {
    const { world, load, out, view, services, tick } = await setup();
    view.rerender(<Harness services={services} load={load} scope="singles" out={out} />);
    await tick();
    const other: PeriodLoad = { ...load, seasons: load.seasons.slice(0, 1) };
    view.rerender(<Harness services={services} load={other} scope="singles" out={out} />);
    expect(out.games!.load?.games.size ?? 0).toBe(0);
    for (let i = 0; i < 200 && out.games!.status !== 'done'; i += 1) await tick();
    expect([...out.games!.load!.games.keys()]).toEqual([COPIES.ids[0]]);
    await tick(10);
    expect(world.calls.filter((c) => !c.startsWith(COPIES.ids[0])).length).toBeLessThanOrEqual(2);
  });
});
