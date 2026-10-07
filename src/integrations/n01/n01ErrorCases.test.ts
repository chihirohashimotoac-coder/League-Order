import { describe, expect, it } from 'vitest';
import type { Player } from '../../domain/types';
import { hasImportantChanges } from '../../domain/n01/changes';
import { buildNextMatchOrder, eligiblePlayers } from '../../domain/n01/nextMatch';
import { DEFAULT_OPTIMIZER_SETTINGS, DEFAULT_WEIGHTS } from '../../domain/orders/presets';
import { N01Client, N01Error } from './client';
import type { N01Request } from './endpoints';
import { fetchTeamData, planN01Sync, resolveLinkedTeam, type N01TeamSelection } from './sync';
import { buildIntelligenceSnapshot, fetchIntelligence } from './intelligence';
import { FAIL, createFixtureTransport, type FixtureTransportOptions } from '../../test/n01/transport';
import { generateLeague } from '../../test/n01/generator';
import { FIXTURE_NOW, atdoSpec, fixtureLeagues } from '../../test/n01/leagues';
import { jstNoon } from '../../test/n01/replay';

/**
 * n01 error cases (MASTER SPEC Phase 6 §6), one per line of the spec, through the real
 * pipeline (fetch → plan → intelligence → order input). Each must end in either an
 * explicit, classified failure that leaves the previous data alone, or a documented
 * degradation that is said out loud — never a silent wrong answer.
 *
 * Cases already covered elsewhere are named in docs/N01_MASTER_DESIGN.md §13.
 */

const ATDO = 'lg_l3hI_3397';
const KALAVINKA: N01TeamSelection = { leagueId: ATDO, leagueTitle: 'ATDO', tournamentId: 't_ABvC_5234', teamTpid: 'GpiQ' };
const TEAM = { id: 'team_kv', name: 'kalavinka', createdAt: 0 };

function client(options: FixtureTransportOptions = {}, now = FIXTURE_NOW): N01Client {
  return new N01Client(createFixtureTransport(options), { now: () => now });
}

function ids(prefix: string): (kind: string) => string {
  let n = 0;
  return (kind) => `${prefix}_${kind}_${++n}`;
}

async function syncKalavinka(options: FixtureTransportOptions = {}, localPlayers: Player[] = []) {
  const data = await fetchTeamData(client(options), KALAVINKA, () => FIXTURE_NOW);
  return { data, plan: planN01Sync({ team: TEAM, localPlayers, existingFormat: null, data, now: FIXTURE_NOW, newId: ids('p') }) };
}

describe('n01 error cases (Phase 6 §6)', () => {
  it('API down: a classified network error before anything is planned', async () => {
    await expect(fetchTeamData(client({ override: () => FAIL }), KALAVINKA, () => FIXTURE_NOW)).rejects.toMatchObject({
      kind: 'network',
    });
  });

  it('API down in the middle of a sync: still a failure, never a half-synced team', async () => {
    const override = (request: N01Request) => (request.operation === 'tournament/stats' ? FAIL : undefined);
    await expect(syncKalavinka({ override })).rejects.toMatchObject({ kind: 'network' });
  });

  it('malformed JSON / schema change in a required response: an explicit schema error', async () => {
    const override = (request: N01Request) => (request.operation === 'tournament/get' ? { changed: 'shape' } : undefined);
    const error = await syncKalavinka({ override }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(N01Error);
    expect(error).toMatchObject({ kind: 'schema', operation: 'tournament/get' });
  });

  it('missing stats: roster and format sync, PPR keeps its previous values, and the captain is told', async () => {
    const first = await syncKalavinka();
    const before = first.plan.players.filter((player) => player.n01?.stats);
    expect(before.length).toBeGreaterThan(0);

    const missing = (request: N01Request) =>
      request.operation === 'tournament/stats' ? new N01Error('notFound', 'n01 にデータが見つかりませんでした。', request.operation, 404) : undefined;
    const data = await fetchTeamData(client({ override: missing }), KALAVINKA, () => FIXTURE_NOW);
    expect(data.statsUnavailable).toBe(true);
    const plan = planN01Sync({
      team: first.plan.team,
      localPlayers: first.plan.players,
      existingFormat: first.plan.format,
      data,
      now: FIXTURE_NOW,
      newId: ids('q'),
    });
    expect(plan.changes.notes).toContain('n01 の成績データを取得できなかったため、PPR は前回の値のままです。');
    expect(plan.changes.pprChanged).toEqual([]);
    expect(plan.changes.rosterInactive).toEqual([]);
    // Nothing about a player changed, so nothing is rewritten; PPR is the previous one.
    expect(plan.players).toEqual([]);

    // A first sync without stats: everyone is imported, PPR is null (never 0).
    const fresh = planN01Sync({ team: TEAM, localPlayers: [], existingFormat: null, data, now: FIXTURE_NOW, newId: ids('r') });
    expect(fresh.players).toHaveLength(7);
    expect(fresh.players.every((player) => player.n01?.stats === null)).toBe(true);
    expect(fresh.players.every((player) => player.ppr === null)).toBe(true);
  });

  it('stats with an unreadable shape are treated like missing stats', async () => {
    const override = (request: N01Request) => (request.operation === 'tournament/stats' ? { stats: 'moved' } : undefined);
    const data = await fetchTeamData(client({ override }), KALAVINKA, () => FIXTURE_NOW);
    expect(data.statsUnavailable).toBe(true);
    expect(data.stats).toEqual([]);
  });

  it('missing schedule: the sync succeeds with no next match, and the order falls back to 勝利優先', async () => {
    const override = (request: N01Request) => (request.operation === 'league/schedule/get' ? FAIL : undefined);
    const c = client({ override });
    const data = await fetchTeamData(c, KALAVINKA, () => FIXTURE_NOW);
    const plan = planN01Sync({ team: TEAM, localPlayers: [], existingFormat: null, data, now: FIXTURE_NOW, newId: ids('s') });
    const fetched = await fetchIntelligence(c, data, { historyDepth: 2, now: () => FIXTURE_NOW });
    const intel = buildIntelligenceSnapshot({ teamId: TEAM.id, data, format: plan.format, fetched, historyDepth: 2, now: FIXTURE_NOW });
    expect(intel.nextMatch).toBeNull();
    expect(fetched.notes.length).toBeGreaterThan(0);
    const order = buildNextMatchOrder({
      team: plan.team,
      players: eligiblePlayers(plan.players),
      format: plan.format,
      pairs: [],
      settings: { activeTeamId: TEAM.id, optimizer: DEFAULT_OPTIMIZER_SETTINGS, lastPreset: 'BALANCED', customWeights: DEFAULT_WEIGHTS },
      intel,
      attending: new Set(plan.players.map((player) => player.id)),
    });
    expect(order.opponentAvailable).toBe(false);
    expect(order.input.preset).toBe('WIN_FIRST');
  });

  it('duplicate names: two people called 佐藤 優 stay two players', async () => {
    const data = await fetchTeamData(
      client(),
      { leagueId: 'lg_Ev9v_7379', leagueTitle: 'TDA', tournamentId: 't_TAop_8101', teamTpid: 'St3w' },
      () => FIXTURE_NOW,
    );
    const plan = planN01Sync({ team: TEAM, localPlayers: [], existingFormat: null, data, now: FIXTURE_NOW, newId: ids('t') });
    const satos = plan.players.filter((player) => player.name === '佐藤 優');
    expect(satos).toHaveLength(2);
    expect(new Set(satos.map((player) => player.n01?.opid)).size).toBe(2);
  });

  it('opid missing: the player is matched by oid on re-sync, never duplicated', async () => {
    const selection = { leagueId: 'lg_Ev9v_7379', leagueTitle: 'TDA', tournamentId: 't_TAop_8101', teamTpid: 'St3w' };
    const data = await fetchTeamData(client(), selection, () => FIXTURE_NOW);
    const first = planN01Sync({ team: TEAM, localPlayers: [], existingFormat: null, data, now: FIXTURE_NOW, newId: ids('u') });
    const anonymous = first.players.find((player) => player.name === '匿名 太郎')!;
    expect(anonymous.n01?.opid).toBeNull();
    const again = planN01Sync({
      team: first.team,
      localPlayers: first.players,
      existingFormat: first.format,
      data,
      now: FIXTURE_NOW,
      newId: ids('v'),
    });
    expect(again.roster.added).toEqual([]);
    expect(again.players).toEqual([]);
  });

  it('team renamed: not found, and never remapped to a similar name', async () => {
    const { plan } = await syncKalavinka();
    const renamed = (request: N01Request) => {
      if (request.operation !== 'tournament/get' || request.params.tdid !== 't_ABvC_5234') return undefined;
      const raw = structuredClone(fixtureLeagues().atdo.dataset.get(`tournament/get?tdid=t_ABvC_5234`)) as {
        tournament: { entry_list: { tpid: string; name: string }[] };
      };
      raw.tournament.entry_list = raw.tournament.entry_list.map((entry) =>
        entry.tpid === 'GpiQ' ? { ...entry, name: 'kalavinka 改', tpid: 'Zz99' } : entry,
      );
      return raw;
    };
    const resolution = await resolveLinkedTeam(client({ override: renamed }), plan.team.n01!);
    expect(resolution.kind).toBe('teamNotFound');
  });

  it('season overlap: a team in one of two running seasons is resolved by membership', async () => {
    const resolution = await resolveLinkedTeam(client(), {
      provider: 'n01',
      leagueId: 'lg_3qgW_6619',
      leagueTitle: 'TDO',
      stableIdentity: { kind: 'name', value: 'ナイトオウルズ' },
      lastTournamentId: 't_TDsp_6900',
      lastTournamentTitle: '2026 春',
      lastTeamId: 'Ow0s',
      lastTeamName: 'ナイトオウルズ',
      lastDivisionIndex: 0,
      lastDivisionTitle: 'Premier',
      discipline: 'SOFT',
      managedFormatId: null,
      linkedAt: 0,
      lastSuccessfulSyncAt: 0,
    });
    expect(resolution).toMatchObject({ kind: 'ok', selection: { tournamentId: 't_TDtu_7001', teamTpid: 'Ow1t' } });
  });

  it('division move: B last season → A now is reported as an important change, with the new format', async () => {
    const c = client();
    const last = await fetchTeamData(c, { ...KALAVINKA, tournamentId: 't_ATp2_5101', teamTpid: 'P2kv' }, () => FIXTURE_NOW);
    const before = planN01Sync({ team: TEAM, localPlayers: [], existingFormat: null, data: last, now: FIXTURE_NOW, newId: ids('w') });
    expect(before.team.n01?.lastDivisionTitle).toBe('B');
    const resolution = await resolveLinkedTeam(c, before.team.n01!);
    expect(resolution).toMatchObject({ kind: 'ok', selection: { tournamentId: 't_ABvC_5234', teamTpid: 'GpiQ' } });
    if (resolution.kind !== 'ok') return;
    const now = await fetchTeamData(c, resolution.selection, () => FIXTURE_NOW);
    const after = planN01Sync({
      team: before.team,
      localPlayers: before.players,
      existingFormat: before.format,
      data: now,
      now: FIXTURE_NOW,
      newId: ids('x'),
    });
    expect(after.changes.division).toEqual({ from: 'B', to: 'A' });
    expect(after.changes.season).toEqual({ from: '2026 2nd', to: '2026 3rd' });
    expect(after.changes.format).toBeDefined();
    expect(hasImportantChanges(after.changes)).toBe(true);
    // Same people, followed by opid into the new season: nobody added twice.
    expect(after.roster.added.map((entry) => entry.name)).toEqual(['中村 蓮']);
  });

  it('bye: on the day of kalavinka’s bye the next match is the following fixture, not the bye', async () => {
    const asOf = generateLeague({ ...atdoSpec(), today: '2026-10-01' });
    const now = jstNoon('2026-10-01');
    const c = new N01Client(createFixtureTransport({ datasets: [asOf.dataset] }), { now: () => now });
    const data = await fetchTeamData(c, KALAVINKA, () => now);
    const fetched = await fetchIntelligence(c, data, { historyDepth: 0, now: () => now });
    expect(fetched.resolution).toMatchObject({ kind: 'resolved', match: { opponentTeamId: '68wv', date: '2026-10-08' } });
  });

  it('no next match: when every fixture is played there is none, and the order falls back to 勝利優先', async () => {
    const asOf = generateLeague({ ...atdoSpec(), today: '2026-10-16' });
    const now = jstNoon('2026-10-16');
    const c = new N01Client(createFixtureTransport({ datasets: [asOf.dataset] }), { now: () => now });
    const data = await fetchTeamData(c, KALAVINKA, () => now);
    const plan = planN01Sync({ team: TEAM, localPlayers: [], existingFormat: null, data, now, newId: ids('y') });
    const fetched = await fetchIntelligence(c, data, { historyDepth: 0, now: () => now });
    expect(fetched.resolution).toEqual({ kind: 'none' });
    const intel = buildIntelligenceSnapshot({ teamId: TEAM.id, data, format: plan.format, fetched, historyDepth: 0, now });
    expect(intel.nextMatchStatus).toBe('none');
    const order = buildNextMatchOrder({
      team: plan.team,
      players: eligiblePlayers(plan.players),
      format: plan.format,
      pairs: [],
      settings: { activeTeamId: TEAM.id, optimizer: DEFAULT_OPTIMIZER_SETTINGS, lastPreset: 'BALANCED', customWeights: DEFAULT_WEIGHTS },
      intel,
      attending: new Set(plan.players.map((player) => player.id)),
    });
    expect(order.opponentAvailable).toBe(false);
  });
});
