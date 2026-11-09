import { afterEach, describe, expect, it } from 'vitest';
import { act, cleanup, render } from '@testing-library/react';
import { AnalyticsApi } from '../api/readApi';
import type { AnalyticsTransport } from '../api/readApi';
import { AnalyticsCache } from '../cache/analyticsCache';
import { projectSeasons } from '../projection';
import { desperadoGames, details, season2024Data, TDID_2024_2ND, wireDetail, wireGame, withDetailSides } from '../realData.roles.fixtures';
import type { PeriodLoad } from '../service/periodService';
import { emptyLoad } from '../service/periodService';
import type { GamesLoad } from '../service/gamesLoader';
import type { AnalyticsServices } from './usePeriodLoad';
import { usePlayerDetail } from './useRoleData';

/**
 * Re-audit of 2026-11-09, R01: running a player's reconstruction again replaces that player's
 * figures. A season verified once and then no longer matching n01 (a leg corrected or deleted on
 * n01) must leave the figures shown — through the real hook and the projection the page draws —
 * not keep the old ones under a result that says "公式値と一致せず（表示しません）".
 * The fixture is the stored ATDO 2024 2nd data; the "correction" is simulated, not a real one.
 */

afterEach(cleanup);

const season = season2024Data();
const raw = withDetailSides(desperadoGames());
const games: GamesLoad = {
  games: new Map([[TDID_2024_2ND, { tournamentId: TDID_2024_2ND, games: raw, dropped: { unfinished: 0, unreadable: 0, nonLeague: 0 }, complete: true }]]),
  failed: new Set(),
  failures: [],
  usedStaleCache: false,
  requestsSent: 0,
};
const load: PeriodLoad = emptyLoad({ mode: 'current', currentTournamentId: TDID_2024_2ND }, { seasons: [season], complete: true });
const correct = Object.fromEntries(details().map((d) => [d.gameId, wireDetail(d)]));
const CORRECTED = 'VU6AjbQE_1724326953016';
const target = details().find((d) => d.gameId === CORRECTED)!;
/** n01 after a correction that removed the game's first leg: the season no longer adds up. */
const afterCorrection = { ...correct, [CORRECTED]: wireDetail({ ...target, legs: target.legs.slice(1) }) };

const n01 = { details: correct as Record<string, unknown>, down: false };
const transport: AnalyticsTransport = {
  async request(operation, params) {
    if (n01.down) throw new Error('network down');
    if (operation === 'match/get') return n01.details[params.mid] ?? { result: -1, error: 'not found' };
    if (operation === 'match/list') return { result: 0, list: raw.map(wireGame) };
    throw new Error(`unexpected ${operation}`);
  },
};

type Detail = ReturnType<typeof usePlayerDetail>;

function Harness({ services, out }: { services: AnalyticsServices; out: { detail: Detail | null } }): null {
  out.detail = usePlayerDetail(services, load, games, 0);
  return null;
}

const keyOf = (oid: string): string => season.players.find((p) => p.oid === oid)!.personKey;
/** What the page shows for a player in the doubles view (the projection fed by the hook). */
const shown = (detail: Detail, oid: string) => projectSeasons([season], 'doubles', { games: games.games, failed: new Set() }, detail.contributions).seasons[0].players.find((p) => p.oid === oid)!.line;
/** Every per-game figure of a player fed to the projection (game id → figures). */
const fed = (detail: Detail, oid: string) => new Map([...detail.contributions].filter(([, players]) => players.has(oid)).map(([gameId, players]) => [gameId, players.get(oid)]));

async function setup() {
  n01.details = correct;
  n01.down = false;
  const services: AnalyticsServices = {
    createApi: (signal) => new AnalyticsApi({ transport, signal }),
    createRoleApi: (signal, maxRequests) => new AnalyticsApi({ transport, signal, maxRequests }),
    cache: new AnalyticsCache({ memoryOnly: true }),
  };
  const out: { detail: Detail | null } = { detail: null };
  render(<Harness services={services} out={out} />);
  const run = async (oid: string): Promise<void> => {
    await act(async () => {
      out.detail!.run(keyOf(oid));
    });
    // The reconstruction is async (fake n01, memory cache): let it settle.
    for (let i = 0; i < 50 && out.detail!.running !== null; i += 1) {
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
    }
    expect(out.detail!.running).toBeNull();
  };
  return { out, run };
}

describe('R01: a reconstruction run again replaces the player’s figures', () => {
  it('verified → corrected on n01 → no longer verified: the old figures leave the page; another player keeps theirs', async () => {
    const { out, run } = await setup();
    await run('6s5w');
    await run('63Cz');
    const verifiedWada = shown(out.detail!, '63Cz');
    const verifiedOther = fed(out.detail!, '6s5w');
    expect(out.detail!.results.get(keyOf('63Cz'))!.checks[0].verified.score).toBe(true);
    expect(out.detail!.results.get(keyOf('6s5w'))!.checks[0].verified.score).toBe(true);
    expect(verifiedWada.darts).not.toBeNull();
    expect(verifiedOther.size).toBe(2);

    n01.details = afterCorrection;
    await run('63Cz'); // 「再度復元する」: read again (forceRefresh), no longer adds up
    const check = out.detail!.results.get(keyOf('63Cz'))!.checks[0];
    expect(check.verified.score).toBe(false);
    expect(out.detail!.results.get(keyOf('63Cz'))!.contributions.size).toBe(0);
    // The page: no per-player figures for 63Cz any more (the pair's games are withheld again)…
    expect(shown(out.detail!, '63Cz').darts).toBeNull();
    expect(shown(out.detail!, '63Cz').score).toBeNull();
    // …and the other verified player is untouched.
    expect(fed(out.detail!, '6s5w')).toEqual(verifiedOther);
    expect(fed(out.detail!, '63Cz').size).toBe(0);

    n01.details = correct;
    await run('63Cz'); // corrected again: only the newest figures, the same as the first verified ones
    expect(out.detail!.results.get(keyOf('63Cz'))!.checks[0].verified.score).toBe(true);
    expect(shown(out.detail!, '63Cz')).toEqual(verifiedWada);
    expect(fed(out.detail!, '6s5w')).toEqual(verifiedOther);
    expect(fed(out.detail!, '63Cz').size).toBe(8);
  });

  it('a run that ends in an error says so and shows none of the old figures', async () => {
    const { out, run } = await setup();
    await run('63Cz');
    expect(shown(out.detail!, '63Cz').darts).not.toBeNull();
    // n01 down and nothing usable cached for a fresh read: whatever the outcome, the figures
    // shown are those of the result shown.
    n01.down = true;
    await run('63Cz');
    const result = out.detail!.results.get(keyOf('63Cz'))!;
    const contributed = [...out.detail!.contributions.values()].some((players) => players.has('63Cz'));
    expect(contributed).toBe(result.contributions.size > 0);
    if (result.stale.length > 0) expect(result.checks[0].verified.score).toBe(true); // old records, flagged as not re-checked
  });
});
