import { describe, expect, it } from 'vitest';
import { AnalyticsApi } from './api/readApi';
import type { AnalyticsTransport } from './api/readApi';
import { AnalyticsCache } from './cache/analyticsCache';
import { buildPopulation } from './playerView';
import { projectSeasons } from './projection';
import { tdaResponse, TDA_PLAYER, TDA_TDID } from './realData.tda.fixtures';
import type { TdaSnapshot } from './realData.tda.fixtures';
import TDA_RAW from './realData.tda.json';
import { reconstructPerson, roleExposure, singlesCoverage } from './service/detailService';
import { GamesSession } from './service/gamesSession';
import type { GamesLoad } from './service/gamesSession';
import { loadPeriod } from './service/periodService';

/**
 * TDA 2026年度 中期 (`t_Drq9_9632`), the player `P028` (pseudonymised, team ml3z): the singles view's
 * First 9 / Keep / Break come from his leg details, read without the doubles view. Real n01
 * responses read 2026-11-15 (`realData.tda.json`).
 *
 * Hand check of the expected values (from the fixture's own rows, see the first test):
 *  - his 9 singles games, 23 legs (14 won); score 10,859 / 487 darts → 3DA 66.89;
 *  - First 9 4,710 points / 207 darts → 68.26; legs he threw second 12 (won 4) → Break 33.3%;
 *    legs he threw first 11 (won 10) → Keep 90.9%;
 *  - the season check: his 25 01 games rebuilt add up to n01's season totals for him (17,495 /
 *    808, First 9 6,738 / 312, Break 26 / 10), so the figures are admitted.
 */

const SNAP = TDA_RAW as unknown as TdaSnapshot;

class TdaN01 implements AnalyticsTransport {
  calls: string[] = [];
  async request(operation: string, params: Record<string, string>): Promise<unknown> {
    this.calls.push(`${operation}?${new URLSearchParams(params).toString()}`);
    const body = tdaResponse(SNAP, operation, params);
    if (body === undefined) throw new Error(`unexpected ${operation}`);
    return body;
  }
}

async function loaded() {
  const fake = new TdaN01();
  const cache = new AnalyticsCache({ memoryOnly: true });
  const period = await loadPeriod({ api: new AnalyticsApi({ transport: fake }), cache, leagueId: SNAP.league.lgid, request: { mode: 'current', currentTournamentId: TDA_TDID } });
  const games = await new Promise<GamesLoad>((resolve) => {
    const session = new GamesSession({ createApi: (signal, max) => new AnalyticsApi({ transport: fake, signal, maxRequests: max }), cache, isOnline: () => true, now: () => Date.now(), sleep: async () => undefined }, (load, running) => {
      if (!running && load.pending.size === 0) resolve(load);
    });
    session.want(period.seasons.map((s) => ({ tournamentId: s.tournamentId, status: s.status })));
  });
  return { fake, cache, period, games };
}

describe('TDA 2026 中期 P028: singles First 9 / Keep / Break from the leg details', () => {
  it('the fixture rows give 9 singles games, 23 legs, 10,859 / 487 (hand check of the basis)', () => {
    const singles = SNAP.games.filter((g) => (g.statsData as { order: { oid: string }[] }[]).some((s) => s.order.length === 1 && s.order[0].oid === TDA_PLAYER));
    expect(singles).toHaveLength(9);
    let legs = 0;
    let score = 0;
    let darts = 0;
    for (const g of singles) {
      const sides = g.statsData as { order: { oid: string }[]; winLegs: number; allScore: number; allDarts: number }[];
      const mine = sides.find((s) => s.order[0].oid === TDA_PLAYER)!;
      legs += sides[0].winLegs + sides[1].winLegs;
      score += mine.allScore;
      darts += mine.allDarts;
    }
    expect({ legs, score, darts }).toEqual({ legs: 23, score: 10859, darts: 487 });
  });

  it('reads his 25 games once, verifies the season, and the singles projection shows every figure', async () => {
    const { fake, cache, period, games } = await loaded();
    const season = period.seasons[0];
    const me = season.players.find((p) => p.oid === TDA_PLAYER)!;
    expect(games.games.get(TDA_TDID)?.complete).toBe(true);
    const exposure = roleExposure(period.seasons, games.games, me.personKey, 'singles');
    expect(exposure).toMatchObject({ games: 9, unknownSeasons: 0, seasons: [TDA_TDID] });

    const before = fake.calls.length;
    const result = await reconstructPerson({ api: new AnalyticsApi({ transport: fake, maxRequests: 60 }), cache, isOnline: () => true, now: () => Date.now(), sleep: async () => undefined }, { seasons: period.seasons, games: games.games, personKey: me.personKey });
    const gets = fake.calls.slice(before).filter((c) => c.startsWith('match/get'));
    expect(gets).toHaveLength(25);
    expect(new Set(gets).size).toBe(25);
    expect(result.checks[0]).toMatchObject({ state: 'verified', games: 25, reconstructed: 25 });
    expect(result.checks[0].verified).toMatchObject({ score: true, f9: true, break: true });
    expect(singlesCoverage(result, exposure.seasons)).toMatchObject({ seasons: 1, scoreVerified: 1, f9Verified: 1, breakVerified: 1 });

    const projection = projectSeasons(period.seasons, 'singles', games, result.contributions);
    const person = buildPopulation(projection.seasons, { kind: 'league' }, TDA_TDID).people.find((p) => p.personKey === me.personKey)!;
    expect(person.metrics.setRate.den).toBe(9);
    expect(person.metrics.legRate).toMatchObject({ num: 14, den: 23 });
    expect(person.metrics.ppr.den).toBe(487);
    expect(person.metrics.ppr.value!.toFixed(2)).toBe('66.89');
    expect(person.metrics.first9).toMatchObject({ num: 3 * 4710, den: 207 });
    expect(person.metrics.first9.value!.toFixed(2)).toBe('68.26');
    expect(person.metrics.keep).toMatchObject({ num: 10, den: 11 });
    expect(person.metrics.break).toMatchObject({ num: 4, den: 12 });
    // The breakdown names the figure as the verified players' only — not "対象外" for everyone.
    expect(projection.adoption[0].metrics.first9.state).toBe('players');
    expect(projection.adoption[0].metrics.keepBreak.state).toBe('players');

    // A second read (another view, a revisit) sends nothing: every game is cached.
    const again = fake.calls.length;
    await reconstructPerson({ api: new AnalyticsApi({ transport: fake, maxRequests: 60 }), cache, isOnline: () => true, now: () => Date.now(), sleep: async () => undefined }, { seasons: period.seasons, games: games.games, personKey: me.personKey });
    expect(fake.calls.slice(again)).toEqual([]);
  });
});
