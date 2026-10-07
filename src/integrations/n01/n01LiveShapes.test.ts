import { describe, expect, it } from 'vitest';
import { N01Client } from './client';
import { N01_API_BASE_URL, buildUrl, type N01Request } from './endpoints';
import { parseLeagueSearch, parseLeagueTournaments, parseStats, parseTournament } from './validation';
import { browseLeague, fetchTeamData, planN01Sync, resolveLinkedTeam, type N01TeamSelection } from './sync';
import { previousSeasons, seasonPriorityGroups } from './seasonResolver';
import { buildIntelligenceSnapshot, fetchIntelligence } from './intelligence';
import { resolveNextMatch } from './scheduleResolver';
import { divisionLabel } from '../../domain/n01/division';
import { eligiblePlayers } from '../../domain/n01/nextMatch';
import { buildOpponentContext } from '../../domain/prediction/opponentContext';
import { createFixtureTransport, type FixtureTransportOptions } from '../../test/n01/transport';
import { generateLeague } from '../../test/n01/generator';
import { FIXTURE_NOW, atdoSpec, fixtureLeagues, tdaSpec, tdoSpec } from '../../test/n01/leagues';
import { jstNoon } from '../../test/n01/replay';

/**
 * The n01 API as it really answers (owner's check of PR #5 `15e467e` against the official
 * manual and live data): divisions, result keys, league search and stats field names.
 * The ATDO-like and TDO-like fixture leagues serve these shapes; the hand-written
 * payloads below pin each one down on its own.
 */

const ATDO = 'lg_l3hI_3397';
const KALAVINKA: N01TeamSelection = { leagueId: ATDO, leagueTitle: 'ATDO', tournamentId: 't_ABvC_5234', teamTpid: 'GpiQ' };

function client(options: FixtureTransportOptions = {}, now = FIXTURE_NOW): N01Client {
  return new N01Client(createFixtureTransport(options), { now: () => now });
}

function ids(prefix: string): (kind: string) => string {
  let n = 0;
  return (kind) => `${prefix}_${kind}_${++n}`;
}

const slot = (schid: string, numPart: number, matchType = '01') => ({ schid, num_part: numPart, match_type: matchType, start_score: 501, limit_leg_count: 2 });

function realTournament(extra: Record<string, unknown> = {}) {
  return {
    result: 0,
    tournament: {
      title: '2026 3rd',
      status: 30,
      entry_list: ['A1', 'A2', 'A3', 'B1', 'B2'].map((tpid) => ({ tpid, name: `team ${tpid}` })),
      lg_table: [
        ['A1', 'A2', 'A3', 'empty'],
        ['B1', 'B2'],
      ],
      lg_title: ['A', 'B'],
      lg_setting: {
        schedule: [slot('s1', 1), slot('s2', 2)],
        game_setting: [{ round: 1, schedule: [slot('b1', 2, 'cricket'), slot('b2', 1), slot('b3', 3)] }],
      },
      lg_result: {
        '0_rqbd': { games: [{ schid: 's1', win_tpid: 'A1' }] },
        '1_x9zk': {},
      },
      ...extra,
    },
  };
}

// ---------------------------------------------------------------------------
// 1. Divisions
// ---------------------------------------------------------------------------

describe('divisions: lg_table is one array of tpids per division, titles in lg_title[]', () => {
  it('reads each lg_table[index] as the teams of division index, without the "empty" bye slot', () => {
    const tournament = parseTournament(realTournament(), 't');
    expect(tournament.divisions).toEqual([
      { index: 0, title: 'A', teamIds: ['A1', 'A2', 'A3'] },
      { index: 1, title: 'B', teamIds: ['B1', 'B2'] },
    ]);
  });

  it('without lg_title the divisions are "Division 1", "Division 2" — and never shown as "Division 2 Division"', () => {
    const raw = realTournament();
    delete (raw.tournament as Record<string, unknown>).lg_title;
    expect(parseTournament(raw, 't').divisions.map((division) => division.title)).toEqual(['Division 1', 'Division 2']);
    expect(divisionLabel('Division 2')).toBe('Division 2');
    expect(divisionLabel('A')).toBe('A Division');
    expect(divisionLabel('1部')).toBe('1部');
  });

  it('still reads the older { lg_title, list: [{ tpid }] } rows', () => {
    const raw = realTournament({ lg_table: [{ lg_title: 'X', list: [{ tpid: 'A1' }, { tpid: 'empty' }] }], lg_title: undefined });
    expect(parseTournament(raw, 't').divisions).toEqual([{ index: 0, title: 'X', teamIds: ['A1'] }]);
  });

  it('ATDO-like (real shape): kalavinka in Division 0 "A", レッドバレル in Division 1 "B"; the bye slot is no team', async () => {
    const c = client();
    const a = await fetchTeamData(c, KALAVINKA, () => FIXTURE_NOW);
    expect(a.division).toMatchObject({ index: 0, title: 'A' });
    expect(a.division?.teamIds).toHaveLength(5);
    expect(a.division?.teamIds).not.toContain('empty');
    const b = await fetchTeamData(c, { ...KALAVINKA, teamTpid: 'Rbrl' }, () => FIXTURE_NOW);
    expect(b.division).toMatchObject({ index: 1, title: 'B' });
  });

  it('the Division 1 team gets the game_setting round 1 format; Division 0 the base schedule', async () => {
    const c = client();
    const plan = async (teamTpid: string) => {
      const data = await fetchTeamData(c, { ...KALAVINKA, teamTpid }, () => FIXTURE_NOW);
      return planN01Sync({ team: { id: `t_${teamTpid}`, name: teamTpid, createdAt: 0 }, localPlayers: [], existingFormat: null, data, now: FIXTURE_NOW, newId: ids(teamTpid) });
    };
    const a = await plan('GpiQ');
    const b = await plan('Rbrl');
    expect(a.format.games.map((game) => game.n01?.schid)).toEqual(['c1', 'c2', 'c3', 'c4', 'c5', 'c6', 'c7']);
    expect(b.format.games.map((game) => game.n01?.schid)).toEqual(['cb1', 'cb2', 'cb3', 'cb4', 'cb5']);
    expect(b.format.games[0].playerCount).toBe(2);
    expect(b.format.games[0].kinds).toContain('CRICKET');
    expect(b.format.source).toMatchObject({ divisionTitle: 'B' });
  });

  it('a team moving from Division 1 (last season) to Division 0 is reported, with the new format', async () => {
    const c = client();
    const last = await fetchTeamData(c, { ...KALAVINKA, tournamentId: 't_ATp2_5101', teamTpid: 'P2kv' }, () => FIXTURE_NOW);
    expect(last.division).toMatchObject({ index: 1, title: 'B' });
    const before = planN01Sync({ team: { id: 't', name: 'kalavinka', createdAt: 0 }, localPlayers: [], existingFormat: null, data: last, now: FIXTURE_NOW, newId: ids('w') });
    const resolution = await resolveLinkedTeam(c, before.team.n01!);
    if (resolution.kind !== 'ok') throw new Error(resolution.kind);
    const now = await fetchTeamData(c, resolution.selection, () => FIXTURE_NOW);
    const after = planN01Sync({ team: before.team, localPlayers: before.players, existingFormat: before.format, data: now, now: FIXTURE_NOW, newId: ids('x') });
    expect(now.division).toMatchObject({ index: 0, title: 'A' });
    expect(after.changes.division).toEqual({ from: 'B', to: 'A' });
    expect(after.changes.format).toBeDefined();
  });
});

describe('format slots: n01 names start score and subtitle startScore / subTitle', () => {
  it('reads startScore and subTitle (and still the older names)', () => {
    const tournament = parseTournament(
      realTournament({
        lg_setting: {
          schedule: [
            { schid: 'g1', num_part: 4, match_type: '01', startScore: 1501, limit_leg_count: 1, subTitle: 'Gallon' },
            { schid: 'g2', num_part: 2, match_type: '01', start_score: 701, limit_leg_count: 1, subtitle: 'Doubles' },
          ],
        },
      }),
      't',
    );
    expect(tournament.schedule.map((slot) => [slot.schid, slot.startScore, slot.subtitle])).toEqual([
      ['g1', 1501, 'Gallon'],
      ['g2', 701, 'Doubles'],
    ]);
  });

  it('TDO-like (real shape): the Gallon game and the 701 / 1501 starts survive the sync', async () => {
    const data = await fetchTeamData(client(), { leagueId: 'lg_3qgW_6619', leagueTitle: 'TDO', tournamentId: 't_TDtu_7001', teamTpid: 'Ow1t' }, () => FIXTURE_NOW);
    const plan = planN01Sync({ team: { id: 't', name: 'owls', createdAt: 0 }, localPlayers: [], existingFormat: null, data, now: FIXTURE_NOW, newId: ids('g') });
    const games = plan.format.games;
    expect(games.map((game) => game.n01?.startScore)).toEqual([501, null, 701, null, 1501]);
    expect(games[4].kinds).toContain('GALLON');
    expect(games[4].n01?.subtitle).toBe('Gallon');
  });
});

// ---------------------------------------------------------------------------
// 2. lg_result keys
// ---------------------------------------------------------------------------

describe('lg_result: keys are <division>_<lsid>, fixtures use the bare lsid', () => {
  it('normalises 0_rqbd → rqbd and keeps the division separately', () => {
    const { results } = parseTournament(realTournament(), 't');
    expect(results.get('rqbd')).toEqual({ matchId: 'rqbd', division: 0, finished: true, games: [{ schid: 's1', winnerTeamId: 'A1' }] });
    expect(results.get('x9zk')).toMatchObject({ matchId: 'x9zk', division: 1, finished: true });
    expect(results.has('0_rqbd')).toBe(false);
  });

  it('a bare key (older shape) is used as it is', () => {
    const { results } = parseTournament(realTournament({ lg_result: { rqbd: {} } }), 't');
    expect(results.get('rqbd')).toMatchObject({ matchId: 'rqbd', division: null, finished: true });
  });

  it('finished fixtures are not the next match (ATDO-like, real keys)', async () => {
    const c = client();
    const data = await fetchTeamData(c, KALAVINKA, () => FIXTURE_NOW);
    // Every played kalavinka fixture is recognised as finished through its normalised key.
    const played = fixtureLeagues().atdo.games.filter((game) => game.tournamentId === 't_ABvC_5234' && (game.homeTpid === 'GpiQ' || game.awayTpid === 'GpiQ'));
    const playedIds = [...new Set(played.map((game) => game.matchId))];
    expect(playedIds).toHaveLength(3);
    for (const id of playedIds) expect(data.tournament.results.get(id)?.finished).toBe(true);
    const fetched = await fetchIntelligence(c, data, { historyDepth: 0, now: () => FIXTURE_NOW });
    expect(fetched.resolution).toMatchObject({ kind: 'resolved', match: { opponentTeamId: '68wv', date: '2026-10-08' } });
  });

  it('a result registered on the match day itself: that fixture is done, the next one is next', async () => {
    // The 10/8 round has been played and entered; the clock is still 10/8 noon.
    const asOf = generateLeague({ ...atdoSpec(), today: '2026-10-09' });
    const now = jstNoon('2026-10-08');
    const c = new N01Client(createFixtureTransport({ datasets: [asOf.dataset] }), { now: () => now });
    const data = await fetchTeamData(c, KALAVINKA, () => now);
    const todays = asOf.games.find((game) => game.date === '2026-10-08' && game.homeTpid === 'GpiQ')!;
    expect(data.tournament.results.get(todays.matchId)).toMatchObject({ division: 0, finished: true });
    const fetched = await fetchIntelligence(c, data, { historyDepth: 0, now: () => now });
    expect(fetched.resolution).toMatchObject({ kind: 'resolved', match: { opponentTeamId: 'BEyE', date: '2026-10-15' } });
    // Without the normalisation the same day's fixture would still look open and be chosen.
    const raw = new Map([[`0_${todays.matchId}`, { matchId: `0_${todays.matchId}`, division: 0, finished: true, games: [] }]]);
    const schedule = await c.schedule('t_ABvC_5234');
    const unnormalised = resolveNextMatch(schedule, { ...data.tournament, results: raw }, 'GpiQ', now);
    expect(unnormalised).toMatchObject({ kind: 'resolved', match: { matchId: todays.matchId } });
  });
});

// ---------------------------------------------------------------------------
// 3. League search
// ---------------------------------------------------------------------------

describe('league search: league/list?keyword=…', () => {
  it('asks league/list with keyword and reads { result: 0, list }', async () => {
    const log: N01Request[] = [];
    const found = await client({ log }).searchLeagues('TDA');
    expect(log).toEqual([{ operation: 'league/list', params: { keyword: 'TDA' } }]);
    expect(found).toEqual([{ leagueId: 'lg_Ev9v_7379', title: 'TDA' }]);
    expect(buildUrl(N01_API_BASE_URL, log[0])).toBe('https://push.n01darts.com/api/v1/league/list?keyword=TDA');
    expect(parseLeagueSearch({ result: 0, list: [{ lgid: 'lg_x', title: 'X League' }] })).toEqual([{ leagueId: 'lg_x', title: 'X League' }]);
  });
});

// ---------------------------------------------------------------------------
// 4. Stats field names
// ---------------------------------------------------------------------------

describe('tournament/stats: n01 field names (camelCase) first, older aliases kept', () => {
  const realRow = {
    tpid: 'GpiQ',
    opid: 'op_x',
    oname: '橋本 千尋',
    score: 6012,
    darts: 342,
    leg: 18,
    winLeg: 11,
    match: 9,
    set: 9,
    winSet: 6,
    ton00: 21,
    ton40: 7,
    ton70: 1,
    ton80: 2,
    highOut: 121,
    best: 15,
    worst: 33,
    f9Score: 1650,
    f9Darts: 81,
  };

  it('maps every documented field', () => {
    const [row] = parseStats({ result: 0, player_stats_list: [realRow] });
    expect(row).toMatchObject({
      opid: 'op_x',
      oid: null,
      teamId: 'GpiQ',
      name: '橋本 千尋',
      score: 6012,
      darts: 342,
      legs: 18,
      legsWon: 11,
      matches: 9,
      first9Score: 1650,
      first9Darts: 81,
      highOut: 121,
      bestLeg: 15,
      ton: 21,
      ton40: 7,
      ton70: 1,
      ton80: 2,
    });
  });

  it('missing fields stay null (never 0); snake_case rows still read', () => {
    const [bare] = parseStats({ player_stats_list: [{ opid: 'p', score: 300, darts: 18 }] });
    expect([bare.legs, bare.legsWon, bare.matches, bare.first9Score, bare.highOut, bare.bestLeg, bare.ton]).toEqual([null, null, null, null, null, null, null]);
    const [legacy] = parseStats({ player_stats_list: [{ opid: 'p', score: 300, darts: 18, legs: 3, win_legs: 2, first9_score: 150, first9_darts: 9, matches: 2 }] });
    expect(legacy).toMatchObject({ legs: 3, legsWon: 2, first9Score: 150, first9Darts: 9, matches: 2 });
  });

  it('ATDO-like (real rows): PPR = score / darts × 3, and legs / First 9 reach the prediction engine', async () => {
    const statsOnly = (strip: boolean) => (request: N01Request) => {
      if (request.operation !== 'tournament/stats' || !strip) return undefined;
      const raw = structuredClone(fixtureLeagues().atdo.dataset.get(`tournament/stats?kind=player_stats_list&tdid=${request.params.tdid}`)) as { player_stats_list: Record<string, unknown>[] };
      for (const row of raw.player_stats_list) {
        delete row.f9Score;
        delete row.f9Darts;
      }
      return raw;
    };
    const contextFor = async (strip: boolean) => {
      const c = client({ override: statsOnly(strip) });
      const data = await fetchTeamData(c, KALAVINKA, () => FIXTURE_NOW);
      const plan = planN01Sync({ team: { id: 't', name: 'kalavinka', createdAt: 0 }, localPlayers: [], existingFormat: null, data, now: FIXTURE_NOW, newId: ids('s') });
      const fetched = await fetchIntelligence(c, data, { historyDepth: 2, now: () => FIXTURE_NOW });
      const intel = buildIntelligenceSnapshot({ teamId: 't', data, format: plan.format, fetched, historyDepth: 2, now: FIXTURE_NOW });
      return { data, plan, intel, context: buildOpponentContext({ snapshot: intel, games: plan.format.games, players: eligiblePlayers(plan.players) })! };
    };

    const full = await contextFor(false);
    const hashimoto = full.data.stats.find((row) => row.opid === 'op_hashimoto')!;
    expect(hashimoto.legsWon).not.toBeNull();
    expect(hashimoto.first9Score).not.toBeNull();
    const player = full.plan.players.find((entry) => entry.n01?.opid === 'op_hashimoto')!;
    expect(player.n01?.stats?.ppr).toBe(Math.round((hashimoto.score / hashimoto.darts) * 3 * 100) / 100);
    const line = full.intel.ourStats.find((entry) => entry.key === 'op_hashimoto')!.seasons[0];
    expect(line).toMatchObject({ legs: hashimoto.legs, legsWon: hashimoto.legsWon, first9Score: hashimoto.first9Score, first9Darts: hashimoto.first9Darts });

    // First 9 is part of the strength model: removing it from the rows changes the strengths.
    const withoutF9 = await contextFor(true);
    const strengths = (context: typeof full.context) => Object.values(context.players).map((entry) => entry.strength);
    expect(strengths(withoutF9.context)).not.toEqual(strengths(full.context));
  });
});

// ---------------------------------------------------------------------------
// 5. Tournament list: t_date, creation order, status 25
// ---------------------------------------------------------------------------

const tids = (list: readonly { tournamentId: string }[]) => list.map((t) => t.tournamentId);

describe('league/tournament/list: seasons dated by t_date, listed in creation order', () => {
  it('the latest season is the latest t_date, not the last one created', () => {
    // The spring season was registered after the autumn one, but before winter's.
    const parsed = parseLeagueTournaments(
      {
        result: 0,
        list: [
          { tdid: 't_aut', title: '2025 秋', status: 40, t_date: '2025-09-04' },
          { tdid: 't_spr', title: '2026 春', status: 40, t_date: '2026-04-02' },
          { tdid: 't_win', title: '2025 冬', status: 40, t_date: '2025-12-04' },
        ],
      },
      'lg_x',
    );
    expect(parsed.tournaments.map((t) => t.startedAt)).toEqual(
      ['2025-09-04', '2026-04-02', '2025-12-04'].map((day) => Date.parse(`${day}T00:00:00Z`)),
    );
    expect(seasonPriorityGroups(parsed.tournaments).map(tids)).toEqual([['t_spr']]);
    expect(tids(previousSeasons(parsed.tournaments, 't_spr', 2))).toEqual(['t_win', 't_aut']);
  });

  it('t_date as epoch seconds, number or string, reads the same', () => {
    const seconds = Date.parse('2026-04-02T00:00:00Z') / 1000;
    const parsed = parseLeagueTournaments({ result: 0, list: [{ tdid: 'a', t_date: seconds }, { tdid: 'b', t_date: String(seconds) }] }, 'lg_x');
    expect(parsed.tournaments.map((t) => t.startedAt)).toEqual([seconds * 1000, seconds * 1000]);
  });

  it('ATDO fixture (oldest first, as created; t_date 0 everywhere): current and previous seasons come out by createTime', async () => {
    const raw = fixtureLeagues().atdo.dataset.get(`league/tournament/list?lgid=${ATDO}`) as { list: { t_date: unknown; createTime: unknown }[] };
    expect(raw.list.every((row) => row.t_date === 0 && typeof row.createTime === 'number')).toBe(true);
    const list = await client().leagueTournaments(ATDO);
    const newestFirst = tids(atdoSpec().seasons);
    expect(tids(list.tournaments)).toEqual([...newestFirst].reverse());
    expect(seasonPriorityGroups(list.tournaments).map(tids)[0]).toEqual(['t_ABvC_5234']);
    expect(tids(previousSeasons(list.tournaments, 't_ABvC_5234', 9))).toEqual(newestFirst.slice(1));
  });
});

describe('status 25 (building the bracket) is the current season', () => {
  const TDA = 'lg_Ev9v_7379';
  // TDA with its new season past entries and into bracket building.
  const bracket = generateLeague({
    ...tdaSpec(),
    seasons: tdaSpec().seasons.map((season) => (season.tournamentId === 't_TAop_8101' ? { ...season, status: 25 as const } : season)),
  });
  const c = () => new N01Client(createFixtureTransport({ datasets: [bracket.dataset] }), { now: () => FIXTURE_NOW });

  it('ranks after running and before open and finished seasons', () => {
    const t = (tournamentId: string, status: number, day: number) => ({ tournamentId, title: tournamentId, status, startedAt: day, listIndex: 0 });
    const list = [t('done', 40, 1), t('entries', 20, 3), t('bracket', 25, 2)];
    expect(seasonPriorityGroups(list).map(tids)).toEqual([['bracket'], ['entries'], ['done']]);
    expect(seasonPriorityGroups([...list, t('live', 30, 0)]).map(tids)[0]).toEqual(['live']);
  });

  it('a new link picks the bracket-building season, not the last finished one', async () => {
    const browse = await browseLeague(c(), TDA);
    expect(browse.candidates.map((t) => [t.tournamentId, t.status])).toEqual([['t_TAop_8101', 25]]);
  });

  it('a team linked while entries were open is still found once the bracket is being built', async () => {
    const selection = { leagueId: TDA, leagueTitle: 'TDA', tournamentId: 't_TAop_8101', teamTpid: 'St3w' };
    const data = await fetchTeamData(client(), selection, () => FIXTURE_NOW);
    expect(data.tournament.status).toBe(20);
    const plan = planN01Sync({ team: { id: 'team_st', name: 'スターズ', createdAt: 0 }, localPlayers: [], existingFormat: null, data, now: FIXTURE_NOW, newId: ids('b') });
    expect(await resolveLinkedTeam(c(), plan.team.n01!)).toEqual({ kind: 'ok', selection });
  });
});

// ---------------------------------------------------------------------------
// 6. t_date = 0 is no date; createTime is the fallback (owner's check of real ATDO)
// ---------------------------------------------------------------------------

describe('league/tournament/list: t_date = 0 is not a date, createTime orders the season', () => {
  const ct = (day: string) => Date.parse(`${day}T00:00:00Z`) / 1000;

  it('several t_date = 0 seasons, listed oldest first: newest first by createTime, history in order', () => {
    const parsed = parseLeagueTournaments(
      {
        result: 0,
        list: [
          { tdid: 'old', status: 40, t_date: 0, createTime: ct('2025-10-01') },
          { tdid: 'mid', status: 40, t_date: 0, createTime: ct('2026-01-10') },
          { tdid: 'new', status: 40, t_date: 0, createTime: ct('2026-04-15') },
        ],
      },
      'lg_x',
    );
    expect(parsed.tournaments.map((t) => t.startedAt)).toEqual(['2025-10-01', '2026-01-10', '2026-04-15'].map((day) => ct(day) * 1000));
    expect(seasonPriorityGroups(parsed.tournaments).map(tids)).toEqual([['new']]);
    expect(tids(previousSeasons(parsed.tournaments, 'new', 2))).toEqual(['mid', 'old']);
  });

  it('a valid t_date wins, then a start date, then createTime; "0" and createTime as text are read too', () => {
    const parsed = parseLeagueTournaments(
      {
        result: 0,
        list: [
          { tdid: 'a', t_date: '2026-04-02', createTime: ct('2026-03-01') },
          { tdid: 'b', t_date: 0, start_date: '2026-05-07', createTime: ct('2026-04-01') },
          { tdid: 'c', t_date: '0', createTime: '2026-06-01 10:00:00' },
          { tdid: 'd', t_date: 0 },
        ],
      },
      'lg_x',
    );
    expect(parsed.tournaments.map((t) => t.startedAt)).toEqual([
      Date.parse('2026-04-02T00:00:00Z'),
      Date.parse('2026-05-07T00:00:00Z'),
      Date.parse('2026-06-01T00:00:00Z'),
      null,
    ]);
  });

  it('ATDO fixture with every season finished: the latest is chosen although the list is oldest first', async () => {
    const finished = generateLeague({ ...atdoSpec(), seasons: atdoSpec().seasons.map((season) => ({ ...season, status: 40 as const })) });
    const c = new N01Client(createFixtureTransport({ datasets: [finished.dataset] }), { now: () => FIXTURE_NOW });
    const browse = await browseLeague(c, ATDO);
    expect(browse.candidates.map((t) => t.tournamentId)).toEqual(['t_ABvC_5234']);
    expect(tids(previousSeasons(browse.tournaments, 't_ABvC_5234', 3))).toEqual(['t_ATp2_5101', 't_ATp1_4988', 't_ATp0_4870']);
  });
});

// ---------------------------------------------------------------------------
// 7. A stale status 25 / 20 never hides the latest finished season (owner's check of real TDO)
// ---------------------------------------------------------------------------

describe('status 25 / 20 count as current only when newer than the latest finished season', () => {
  const TDO = 'lg_3qgW_6619';
  const t = (tournamentId: string, status: number, startedAt: number | null) => ({ tournamentId, title: tournamentId, status, startedAt, listIndex: 0 });

  it('old 25 / 20 fall back to the latest finished; a newer 25 / 20 is current; 30 still comes first', () => {
    const stale = [t('test25', 25, 1), t('oldEntry20', 20, 2), t('latest40', 40, 5), t('older40', 40, 3)];
    expect(seasonPriorityGroups(stale).map(tids)).toEqual([['latest40']]);
    expect(seasonPriorityGroups([...stale, t('next25', 25, 6)]).map(tids)).toEqual([['next25'], ['latest40']]);
    expect(seasonPriorityGroups([...stale, t('next20', 20, 6)]).map(tids)).toEqual([['next20'], ['latest40']]);
    expect(seasonPriorityGroups([...stale, t('live30', 30, 4)]).map(tids)).toEqual([['live30'], ['latest40']]);
    // Started on the same day is not newer.
    expect(seasonPriorityGroups([t('same25', 25, 5), t('latest40', 40, 5)]).map(tids)).toEqual([['latest40']]);
    // Without a date on either side staleness cannot be shown: still a candidate.
    expect(seasonPriorityGroups([t('undated25', 25, null), t('latest40', 40, 5)]).map(tids)).toEqual([['undated25'], ['latest40']]);
  });

  // TDO-like, as real TDO: an organiser's test tournament left at status 25 long ago.
  const testTournament = {
    tournamentId: 't_TDvf_5900',
    title: 'TDO事務局検証作業用',
    status: 25 as const,
    startDate: '2025-12-02',
    schedule: tdoSpec().seasons[0].schedule,
    divisions: [{ title: 'Premier', teams: [
      { tpid: 'Vf9a', name: '検証A', members: tdoSpec().seasons[0].divisions[0].teams[0].members.slice(0, 2) },
      { tpid: 'Vf9b', name: '検証B', members: tdoSpec().seasons[0].divisions[0].teams[1].members.slice(0, 2) },
    ] }],
    intervalDays: 7,
  };
  const league = (seasons: ReturnType<typeof tdoSpec>['seasons']) =>
    new N01Client(createFixtureTransport({ datasets: [generateLeague({ ...tdoSpec(), seasons }).dataset] }), { now: () => FIXTURE_NOW });
  const allFinished = () => tdoSpec().seasons.map((season) => ({ ...season, status: 40 as const }));

  it('real TDO today (3rd at 30, 2nd at 40, the test tournament at 25): the running seasons', async () => {
    const browse = await browseLeague(league([...tdoSpec().seasons, testTournament]), TDO);
    expect(browse.candidates.map((x) => x.tournamentId)).toEqual(['t_TDth_7002', 't_TDtu_7001']);
  });

  it('no season running, the test tournament still at 25: the latest finished season, not the test tournament', async () => {
    const browse = await browseLeague(league([...allFinished(), testTournament]), TDO);
    expect(browse.candidates.map((x) => x.tournamentId)).toEqual(['t_TDth_7002']);
    expect(browse.choices.map((choice) => choice.name)).not.toContain('検証A');
  });

  it('a new season at 25 after the latest finished one: the new season', async () => {
    const next = { ...testTournament, tournamentId: 't_TDwi_7101', title: '2026 冬', startDate: '2026-12-01' };
    const browse = await browseLeague(league([next, ...allFinished(), testTournament]), TDO);
    expect(browse.candidates.map((x) => x.tournamentId)).toEqual(['t_TDwi_7101']);
  });
});
