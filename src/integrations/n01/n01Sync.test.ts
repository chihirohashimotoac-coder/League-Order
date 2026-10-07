import { describe, expect, it } from 'vitest';
import type { Player, Team } from '../../domain/types';
import { N01Client, N01Error, createFetchTransport } from './client';
import { buildUrl, parseRequestUrl, N01_API_BASE_URL } from './endpoints';
import { parseLeagueReference, KNOWN_LEAGUES } from './leagueRegistry';
import { parseDateText, parseStats, parseTournament } from './validation';
import { newestFirst, pickSeasonByMembership, previousSeasons, seasonPriorityGroups } from './seasonResolver';
import { describeFormat, effectiveSchedule, gamesFromSchedule } from './formatResolver';
import { browseLeague, fetchTeamData, planN01Sync, resolveLinkedTeam, type N01TeamData } from './sync';
import { FAIL, createFixtureTransport } from '../../test/n01/transport';
import { FIXTURE_NOW } from '../../test/n01/leagues';
import type { N01Request } from './endpoints';
import type { N01TournamentSummary } from './types';

const ATDO = 'lg_l3hI_3397';
const TDO = 'lg_3qgW_6619';
const TDA = 'lg_Ev9v_7379';

function client(options: Parameters<typeof createFixtureTransport>[0] = {}): N01Client {
  return new N01Client(createFixtureTransport(options), { now: () => FIXTURE_NOW });
}

function ids(prefix: string): (p: string) => string {
  let n = 0;
  return (p) => `${p}_${prefix}${++n}`;
}

const TEAM: Team = { id: 'team_kv', name: 'kalavinka', createdAt: 0 };

async function kalavinka(c = client(), tournamentId = 't_ABvC_5234', teamTpid = 'GpiQ'): Promise<N01TeamData> {
  return fetchTeamData(c, { leagueId: ATDO, leagueTitle: 'ATDO', tournamentId, teamTpid }, () => FIXTURE_NOW);
}

// ---------------------------------------------------------------------------

describe('endpoints and league registry', () => {
  it('maps an operation to a GET URL and back', () => {
    const request: N01Request = { operation: 'team/player/list', params: { tpid: 'GpiQ', tdid: 't_ABvC_5234' } };
    const url = buildUrl(N01_API_BASE_URL, request);
    expect(url).toBe('https://n01darts.com/n01/api/team/player/list?tdid=t_ABvC_5234&tpid=GpiQ');
    expect(parseRequestUrl(N01_API_BASE_URL, url)).toEqual(request);
    expect(parseRequestUrl(N01_API_BASE_URL, 'https://n01darts.com/n01/api/team/delete?tpid=x')).toBeNull();
  });

  it('knows ATDO, TDO and TDA by league id only', () => {
    expect(KNOWN_LEAGUES.map((league) => league.leagueId)).toEqual([ATDO, TDO, TDA]);
    for (const league of KNOWN_LEAGUES) expect(Object.keys(league).sort()).toEqual(['key', 'leagueId', 'title']);
  });

  it('accepts a bare league id or an https n01 URL, and nothing else', () => {
    expect(parseLeagueReference('lg_l3hI_3397')).toEqual({ ok: true, leagueId: ATDO });
    expect(parseLeagueReference('https://n01darts.com/n01/league/season.php?id=lg_Ev9v_7379')).toEqual({ ok: true, leagueId: TDA });
    for (const bad of [
      'http://n01darts.com/n01/league/season.php?id=lg_Ev9v_7379',
      'https://n01darts.com.evil.example/x?id=lg_Ev9v_7379',
      'https://user:pw@n01darts.com/x?id=lg_Ev9v_7379',
      'javascript:alert(1)//lg_Ev9v_7379',
      'lg_bad',
      '',
    ]) {
      expect(parseLeagueReference(bad).ok).toBe(false);
    }
  });

  it('refuses to build a transport for a non-n01 base URL', () => {
    expect(() => createFetchTransport({ baseUrl: 'https://example.com/api' })).toThrow(N01Error);
    expect(() => createFetchTransport({ baseUrl: 'http://n01darts.com/n01/api' })).toThrow(N01Error);
  });
});

describe('validation: tolerant extraction, explicit failure', () => {
  it('reads numbers given as strings and an object-keyed list', () => {
    const tournament = parseTournament(
      {
        data: {
          title: 'S',
          status: '30',
          softdarts: '1',
          entry_list: { GpiQ: { name: 'kalavinka' } },
          lg_table: [{ lg_title: 'A', list: ['GpiQ'] }],
          lg_setting: { schedule: [{ schid: 's1', num_part: '1', match_type: '01', start_score: '501' }] },
        },
      },
      't_x',
    );
    expect(tournament.status).toBe(30);
    expect(tournament.softdarts).toBe(true);
    expect(tournament.entries).toEqual([{ teamId: 'GpiQ', name: 'kalavinka' }]);
    expect(tournament.divisions[0]).toEqual({ index: 0, title: 'A', teamIds: ['GpiQ'] });
    expect(tournament.schedule[0]).toMatchObject({ schid: 's1', numPart: 1, startScore: 501, limitLegCount: null });
  });

  it('raises a schema error when a container is missing or every row is unusable', () => {
    expect(() => parseTournament({ title: 'x' }, 't')).toThrow(/entry_list/);
    expect(() => parseStats({ player_stats_list: [{ name: 'x' }] })).toThrow(/有効な行/);
    expect(() => parseStats({ something_else: [] })).toThrow(/player_stats_list/);
  });

  it('keeps optional metrics as null, never 0', () => {
    const [row] = parseStats({ player_stats_list: [{ opid: 'p', score: 300, darts: 18 }] });
    expect(row.legs).toBeNull();
    expect(row.first9Score).toBeNull();
    expect(row.ton80).toBeNull();
  });

  it('parses dates, inferring the year of a bare month/day from the clock', () => {
    expect(parseDateText('2026/10/08', FIXTURE_NOW)).toBe('2026-10-08');
    expect(parseDateText('第5節 10/8', FIXTURE_NOW)).toBe('2026-10-08');
    expect(parseDateText('1月9日', FIXTURE_NOW)).toBe('2027-01-09');
    expect(parseDateText('2026/02/30', FIXTURE_NOW)).toBeNull();
    expect(parseDateText('第5節', FIXTURE_NOW)).toBeNull();
  });
});

describe('client: classified failures, memoised requests', () => {
  it('reports malformed JSON as a schema error', async () => {
    const transport = createFetchTransport({
      fetchImpl: async () => new Response('<html>oops</html>', { status: 200 }),
    });
    await expect(new N01Client(transport).leagueTournaments(ATDO)).rejects.toMatchObject({ kind: 'schema' });
  });

  it('reports network failure, 404 and other HTTP errors distinctly', async () => {
    const failing = createFetchTransport({ fetchImpl: async () => Promise.reject(new TypeError('Failed to fetch')) });
    await expect(new N01Client(failing).tournament('t')).rejects.toMatchObject({ kind: 'network' });
    const missing = createFetchTransport({ fetchImpl: async () => new Response('{}', { status: 404 }) });
    await expect(new N01Client(missing).tournament('t')).rejects.toMatchObject({ kind: 'notFound' });
    const down = createFetchTransport({ fetchImpl: async () => new Response('', { status: 503 }) });
    await expect(new N01Client(down).tournament('t')).rejects.toMatchObject({ kind: 'http', status: 503 });
  });

  it('sends anonymous, uncached GETs only', async () => {
    const seen: RequestInit[] = [];
    const transport = createFetchTransport({
      fetchImpl: async (_url, init) => {
        seen.push(init ?? {});
        return new Response(JSON.stringify({ list: [] }), { status: 200 });
      },
    });
    await new N01Client(transport).leagueTournaments(ATDO);
    expect(seen[0]).toMatchObject({ method: 'GET', credentials: 'omit', cache: 'no-store' });
  });

  it('times out a request that never answers', async () => {
    const hanging = { request: (_r: N01Request, signal: AbortSignal) => new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(new Error('aborted')))) };
    await expect(new N01Client(hanging, { timeoutMs: 20 }).tournament('t')).rejects.toMatchObject({ kind: 'timeout' });
  });

  it('asks n01 once per distinct request within a sync, and retries a failure', async () => {
    const log: N01Request[] = [];
    let fail = true;
    const c = client({ log, override: (request) => (request.operation === 'tournament/get' && fail ? FAIL : undefined) });
    await expect(c.tournament('t_ABvC_5234')).rejects.toMatchObject({ kind: 'network' });
    fail = false;
    await c.tournament('t_ABvC_5234');
    await c.tournament('t_ABvC_5234');
    expect(log.filter((request) => request.operation === 'tournament/get')).toHaveLength(2);
  });
});

describe('season resolution', () => {
  const t = (tournamentId: string, status: number | null, startedAt: number | null, listIndex: number): N01TournamentSummary => ({
    tournamentId,
    title: tournamentId,
    status,
    startedAt,
    listIndex,
  });

  it('prefers running, then open, then the latest finished season', () => {
    const list = [t('old', 40, 1, 3), t('newer', 40, 5, 2), t('open', 20, 6, 1)];
    expect(seasonPriorityGroups(list).map((group) => group.map((x) => x.tournamentId))).toEqual([['open'], ['newer']]);
    expect(seasonPriorityGroups([...list, t('live', 30, 7, 0)])[0].map((x) => x.tournamentId)).toEqual(['live']);
    expect(seasonPriorityGroups([t('a', 40, null, 1), t('b', 40, null, 0)])[0][0].tournamentId).toBe('b');
  });

  it('narrows several active seasons by team membership, and asks only when that is not enough', () => {
    const groups = [[t('tue', 30, 2, 0), t('thu', 30, 3, 1)]];
    expect(pickSeasonByMembership(groups, (id) => id === 'thu')).toEqual({ kind: 'resolved', tournamentId: 'thu' });
    expect(pickSeasonByMembership(groups, () => true)).toEqual({ kind: 'ambiguous', tournamentIds: ['tue', 'thu'] });
    expect(pickSeasonByMembership(groups, () => false)).toEqual({ kind: 'notFound' });
  });

  it('lists previous seasons newest first, up to the configured depth', () => {
    const list = [t('c', 30, 9, 0), t('p1', 40, 8, 1), t('p2', 40, 7, 2), t('p3', 40, 6, 3)];
    expect(previousSeasons(list, 'c', 2).map((x) => x.tournamentId)).toEqual(['p1', 'p2']);
    expect(previousSeasons(list, 'c', 0)).toEqual([]);
    expect(newestFirst(list)[0].tournamentId).toBe('c');
  });

  it('resolves ATDO to the running season without reading its title', async () => {
    const browse = await browseLeague(client(), ATDO);
    expect(browse.candidates.map((x) => x.tournamentId)).toEqual(['t_ABvC_5234']);
    expect(browse.choices.find((choice) => choice.name === 'kalavinka')?.seasons[0]).toMatchObject({ teamId: 'GpiQ' });
  });

  it('TDO: two seasons are running; membership picks the one the team entered', async () => {
    const browse = await browseLeague(client(), TDO);
    expect(browse.candidates).toHaveLength(2);
    const resolution = await resolveLinkedTeam(client(), {
      provider: 'n01',
      leagueId: TDO,
      leagueTitle: 'TDO',
      stableIdentity: { kind: 'name', value: 'タイガース' },
      lastTournamentId: 't_TDsp_6900',
      lastTournamentTitle: '2026 春',
      lastTeamId: 'Tg0s',
      lastTeamName: 'タイガース',
      lastDivisionIndex: 0,
      lastDivisionTitle: 'Premier',
      discipline: 'SOFT',
      managedFormatId: null,
      linkedAt: 0,
      lastSuccessfulSyncAt: 0,
    });
    expect(resolution).toEqual({
      kind: 'ok',
      selection: { leagueId: TDO, leagueTitle: 'TDO', tournamentId: 't_TDth_7002', teamTpid: 'Tg1h' },
    });
  });

  it('TDA: only an open season exists, and it is used', async () => {
    const browse = await browseLeague(client(), TDA);
    expect(browse.candidates.map((x) => x.status)).toEqual([20]);
  });

  it('a renamed team is not found, and is never fuzzily remapped', async () => {
    const data = await kalavinka();
    const plan = planN01Sync({ team: TEAM, localPlayers: [], existingFormat: null, data, now: FIXTURE_NOW, newId: ids('a') });
    const resolution = await resolveLinkedTeam(client(), {
      ...plan.team.n01!,
      stableIdentity: { kind: 'name', value: 'kalavinka2' },
    });
    expect(resolution.kind).toBe('teamNotFound');
  });
});

describe('division, discipline and format', () => {
  it('resolves the division from lg_table on every sync', async () => {
    expect((await kalavinka()).division).toMatchObject({ index: 0, title: 'A' });
    expect((await kalavinka(client(), 't_ATp2_5101', 'P2kv')).division).toMatchObject({ index: 1, title: 'B' });
  });

  it('reads softdarts 0 / 1 / missing as STEEL / SOFT / UNSPECIFIED', async () => {
    const atdo = planN01Sync({ team: TEAM, localPlayers: [], existingFormat: null, data: await kalavinka(), now: FIXTURE_NOW, newId: ids('b') });
    expect(atdo.format.discipline).toBe('STEEL');
    const tdo = await fetchTeamData(client(), { leagueId: TDO, leagueTitle: 'TDO', tournamentId: 't_TDtu_7001', teamTpid: 'Ow1t' }, () => FIXTURE_NOW);
    expect(planN01Sync({ team: TEAM, localPlayers: [], existingFormat: null, data: tdo, now: FIXTURE_NOW, newId: ids('c') }).format.discipline).toBe('SOFT');
    const tda = await fetchTeamData(client(), { leagueId: TDA, leagueTitle: 'TDA', tournamentId: 't_TAop_8101', teamTpid: 'St3w' }, () => FIXTURE_NOW);
    expect(planN01Sync({ team: TEAM, localPlayers: [], existingFormat: null, data: tda, now: FIXTURE_NOW, newId: ids('d') }).format.discipline).toBe('UNSPECIFIED');
  });

  it('builds the ATDO format from lg_setting.schedule: Team 1001 ×1 / Doubles 501 ×2 / Singles 501 ×4', async () => {
    const plan = planN01Sync({ team: TEAM, localPlayers: [], existingFormat: null, data: await kalavinka(), now: FIXTURE_NOW, newId: ids('e') });
    expect(describeFormat(plan.format.games)).toBe('Team 1001 ×1 / Doubles 501 ×2 / Singles 501 ×4');
    expect(plan.format.games[0]).toMatchObject({ kinds: ['TEAM', 'G501'], playerCount: 4 });
    expect(plan.format.games[0].n01).toMatchObject({ schid: 'c1', startScore: 1001, matchType: '01', limitLegCount: 1 });
    expect(plan.format.source).toMatchObject({ provider: 'n01', tournamentId: 't_ABvC_5234', divisionTitle: 'A' });
  });

  it('uses the division override (game_setting.round) when the team is in that division', async () => {
    const data = await fetchTeamData(client(), { leagueId: ATDO, leagueTitle: 'ATDO', tournamentId: 't_ABvC_5234', teamTpid: 'Rbrl' }, () => FIXTURE_NOW);
    const schedule = effectiveSchedule(data.tournament, data.division?.index ?? null);
    expect(schedule.map((slot) => slot.schid)).toEqual(['cb1', 'cb2', 'cb3', 'cb4', 'cb5']);
    const games = gamesFromSchedule(data.tournament.tournamentId, schedule);
    expect(games[0]).toMatchObject({ name: 'Doubles Cricket', kinds: ['DOUBLES', 'CRICKET'], playerCount: 2 });
    expect(games[4]).toMatchObject({ name: 'Trios 701', kinds: ['TRIOS', 'G501'], playerCount: 3 });
  });

  it('maps a clearly-labelled Gallon game to GALLON', async () => {
    const tdo = await fetchTeamData(client(), { leagueId: TDO, leagueTitle: 'TDO', tournamentId: 't_TDtu_7001', teamTpid: 'Ow1t' }, () => FIXTURE_NOW);
    const games = gamesFromSchedule(tdo.tournament.tournamentId, tdo.tournament.schedule);
    expect(games.map((game) => game.kinds[0])).toEqual(['SINGLES', 'SINGLES', 'DOUBLES', 'DOUBLES', 'GALLON']);
    expect(games[1].kinds).toEqual(['SINGLES', 'CRICKET']);
  });
});

describe('roster and PPR sync', () => {
  it('imports the roster with PPR = score / darts * 3, and null (not 0) without stats', async () => {
    const data = await kalavinka();
    const plan = planN01Sync({ team: TEAM, localPlayers: [], existingFormat: null, data, now: FIXTURE_NOW, newId: ids('f') });
    expect(plan.players).toHaveLength(7);
    for (const player of plan.players) {
      const stats = player.n01?.stats;
      if (stats) expect(stats.ppr).toBeCloseTo((stats.score / stats.darts) * 3, 2);
    }
    const benched = plan.players.find((player) => player.name === '中村 蓮')!;
    expect(benched.n01?.stats).toBeNull();
    expect(benched.ppr).toBeNull();
    expect(plan.players.every((player) => player.rating === null && player.n01?.rosterActive)).toBe(true);
  });

  it('a zero-dart row gives a null PPR, never 0', async () => {
    const tda = await fetchTeamData(client(), { leagueId: TDA, leagueTitle: 'TDA', tournamentId: 't_TAop_8101', teamTpid: 'St3w' }, () => FIXTURE_NOW);
    const plan = planN01Sync({ team: TEAM, localPlayers: [], existingFormat: null, data: tda, now: FIXTURE_NOW, newId: ids('g') });
    const rookie = plan.players.find((player) => player.name === '新人 花子')!;
    expect(rookie.n01?.stats).toMatchObject({ darts: 0, ppr: null });
  });

  it('a re-sync keeps every local field, writes nothing when nothing changed, and never deletes', async () => {
    const data = await kalavinka();
    const first = planN01Sync({ team: TEAM, localPlayers: [], existingFormat: null, data, now: FIXTURE_NOW, newId: ids('h') });
    const local: Player[] = first.players.map((player, index) => ({
      ...player,
      rating: 10 + index,
      skills: { SINGLES: 4 },
      note: 'メモ',
      seasonAppearances: index,
      ppr: 70,
      pprSource: index === 0 ? 'manual' : undefined,
    }));
    const again = planN01Sync({ team: first.team, localPlayers: local, existingFormat: first.format, data, now: FIXTURE_NOW + 1000, newId: ids('i') });
    expect(again.players).toEqual([]);
    expect(again.changes.firstSync).toBe(false);
    expect(again.changes.season).toBeNull();
    expect(again.changes.format).toBeNull();

    // A player leaves the n01 roster: kept, marked inactive, local data intact.
    const without = { ...data, roster: data.roster.filter((player) => player.name !== '伊藤 由佳') };
    const left = planN01Sync({ team: first.team, localPlayers: local, existingFormat: first.format, data: without, now: FIXTURE_NOW, newId: ids('j') });
    expect(left.changes.rosterInactive).toEqual(['伊藤 由佳']);
    const ito = left.players.find((player) => player.name === '伊藤 由佳')!;
    expect(ito).toMatchObject({ rating: local.find((p) => p.id === ito.id)!.rating, note: 'メモ', skills: { SINGLES: 4 } });
    expect(ito.n01?.rosterActive).toBe(false);
  });

  it('follows players into a new season by opid, even though every oid and tpid changed', async () => {
    const previous = await kalavinka(client(), 't_ATp2_5101', 'P2kv');
    const first = planN01Sync({ team: TEAM, localPlayers: [], existingFormat: null, data: previous, now: FIXTURE_NOW, newId: ids('k') });
    const current = await kalavinka();
    const next = planN01Sync({ team: first.team, localPlayers: first.players, existingFormat: first.format, data: current, now: FIXTURE_NOW, newId: ids('l') });
    expect(next.changes.season).toEqual({ from: '2026 2nd', to: '2026 3rd' });
    expect(next.changes.division).toEqual({ from: 'B', to: 'A' });
    expect(next.changes.rosterAdded).toEqual(['中村 蓮']);
    const hashimoto = next.players.find((player) => player.name === '橋本 千尋')!;
    expect(hashimoto.id).toBe(first.players.find((player) => player.name === '橋本 千尋')!.id);
    expect(hashimoto.n01).toMatchObject({ currentTpid: 'GpiQ', lastSeenTournamentId: 't_ABvC_5234' });
    expect(next.team.n01).toMatchObject({ lastTeamId: 'GpiQ', lastDivisionTitle: 'A', managedFormatId: first.format.id });
  });

  it('never merges two people with the same name, and falls back to oid when opid is missing', async () => {
    const tda = await fetchTeamData(client(), { leagueId: TDA, leagueTitle: 'TDA', tournamentId: 't_TAop_8101', teamTpid: 'St3w' }, () => FIXTURE_NOW);
    const first = planN01Sync({ team: TEAM, localPlayers: [], existingFormat: null, data: tda, now: FIXTURE_NOW, newId: ids('m') });
    const satos = first.players.filter((player) => player.name === '佐藤 優');
    expect(satos).toHaveLength(2);
    expect(new Set(satos.map((player) => player.n01?.opid))).toEqual(new Set(['op_sato_a', 'op_sato_b']));
    const anon = first.players.find((player) => player.name === '匿名 太郎')!;
    expect(anon.n01?.opid).toBeNull();
    const again = planN01Sync({ team: first.team, localPlayers: first.players, existingFormat: first.format, data: tda, now: FIXTURE_NOW, newId: ids('n') });
    expect(again.players).toEqual([]);
    expect(again.roster.added).toEqual([]);
  });

  it('linking a hand-made team matches exact names, leaves ambiguity to the captain, and keeps local data', async () => {
    const data = await kalavinka();
    const local: Player[] = [
      { id: 'pl_a', teamId: TEAM.id, name: '橋本　千尋', rating: 14, ppr: 61, skills: { DOUBLES: 5 }, seasonAppearances: 3, seasonAppearancesByKind: {}, archived: false, createdAt: 1 },
      { id: 'pl_b', teamId: TEAM.id, name: 'ゲスト', rating: 8, ppr: null, skills: {}, seasonAppearances: 0, seasonAppearancesByKind: {}, archived: false, createdAt: 2 },
    ];
    const plan = planN01Sync({ team: TEAM, localPlayers: local, existingFormat: null, data, now: FIXTURE_NOW, newId: ids('o') });
    const linked = plan.players.find((player) => player.id === 'pl_a')!;
    expect(linked).toMatchObject({ rating: 14, ppr: 61, skills: { DOUBLES: 5 }, seasonAppearances: 3, name: '橋本 千尋' });
    expect(linked.n01?.opid).toBe('op_hashimoto');
    // The hand-made guest is not on n01 and is left alone (not deactivated, not deleted).
    expect(plan.players.some((player) => player.id === 'pl_b')).toBe(false);
  });

  it('an empty n01 roster deactivates nobody and says so', async () => {
    const data = await kalavinka();
    const first = planN01Sync({ team: TEAM, localPlayers: [], existingFormat: null, data, now: FIXTURE_NOW, newId: ids('p') });
    const empty = planN01Sync({ team: first.team, localPlayers: first.players, existingFormat: first.format, data: { ...data, roster: [] }, now: FIXTURE_NOW, newId: ids('q') });
    expect(empty.players).toEqual([]);
    expect(empty.changes.notes).toHaveLength(1);
  });

  it('a whole first sync takes four requests', async () => {
    const log: N01Request[] = [];
    await kalavinka(client({ log }));
    expect(log.map((request) => request.operation)).toEqual([
      'league/tournament/list',
      'tournament/get',
      'team/player/list',
      'tournament/stats',
    ]);
  });
});
