import { describe, expect, it } from 'vitest';
import { N01Client } from './client';
import type { N01Request } from './endpoints';
import { fetchTeamData, planN01Sync, resolveLinkedTeam } from './sync';
import { fetchIntelligence } from './intelligence';
import { createFixtureTransport } from '../../test/n01/transport';
import { FIXTURE_NOW } from '../../test/n01/leagues';

/**
 * Request budget of one complete sync (MASTER SPEC Phase 6 §7 "過剰request防止"): the
 * per-sync client asks n01 once per distinct request, and the opponent history grows
 * with the configured depth only.
 */

async function fullSync(historyDepth: number): Promise<N01Request[]> {
  const first = new N01Client(createFixtureTransport(), { now: () => FIXTURE_NOW });
  const selection = { leagueId: 'lg_l3hI_3397', leagueTitle: 'ATDO', tournamentId: 't_ABvC_5234', teamTpid: 'GpiQ' };
  const data = await fetchTeamData(first, selection, () => FIXTURE_NOW);
  let n = 0;
  const linked = planN01Sync({ team: { id: 't', name: 'kalavinka', createdAt: 0 }, localPlayers: [], existingFormat: null, data, now: FIXTURE_NOW, newId: (p) => `${p}_${++n}` });

  // A re-sync, exactly as 「次戦のオーダーを作る」 runs it, with one client for the whole sync.
  const log: N01Request[] = [];
  const client = new N01Client(createFixtureTransport({ log }), { now: () => FIXTURE_NOW });
  const resolution = await resolveLinkedTeam(client, linked.team.n01!);
  if (resolution.kind !== 'ok') throw new Error('not resolved');
  const fresh = await fetchTeamData(client, resolution.selection, () => FIXTURE_NOW);
  await fetchIntelligence(client, fresh, { historyDepth, now: () => FIXTURE_NOW });
  return log;
}

describe('request budget of a complete sync (Phase 6 §7)', () => {
  it('resolve + roster + PPR + format + opponent + 2 past seasons = 13 GETs, none repeated', async () => {
    const log = await fullSync(2);
    const keys = log.map((request) => `${request.operation}?${new URLSearchParams(request.params).toString()}`);
    expect(new Set(keys).size).toBe(keys.length);
    expect(log).toHaveLength(13);
    expect(log.every((request) => /^(league|tournament|team)\//.test(request.operation))).toBe(true);
  });

  it('each past season costs a fixed number of requests; depth 0 reads none', async () => {
    const none = await fullSync(0);
    const one = await fullSync(1);
    const two = await fullSync(2);
    expect(one.length - none.length).toBe(two.length - one.length);
    expect(none.some((request) => request.params.tdid === 't_ATp2_5101')).toBe(false);
  });
});
