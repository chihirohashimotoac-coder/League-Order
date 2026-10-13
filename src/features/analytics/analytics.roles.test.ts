import { describe, expect, it } from 'vitest';
import { parseGameDetail, parseGameList, parseSlotEvidence } from './api/parse';
import type { RawGame } from './api/parse';
import { aggregatePlayers, aggregateTeams } from './aggregate';
import { gameFamily, gameRole, normalizeMatchType, seasonComposition, slotFamily } from './gameKind';
import type { SlotEvidence } from './gameKind';
import { projectSeasons, seasonsNeedingGames } from './projection';
import type { GamesSource } from './projection';
import { reconstructGame } from './reconstruct';
import { classifyGames, inScope, isLeagueGame, divisionOfMatchId, linesFromGames } from './roleGames';
import type { SeasonGames } from './roleGames';
import { bestLegBasis, scopeMetrics, startScoresOf } from './scopeMetrics';
import { buildSeasonData } from './seasonData';
import { line, playerRow, roster, season, simpleLine, teamRow, tournament } from './testFixtures';

const slot = (o: Partial<SlotEvidence>): SlotEvidence => ({ schid: 's', division: null, numPart: 1, subtitle: null, startScore: 501, limitLegCount: 2, matchType: null, settingMatchType: null, ...o });

describe('game family (P0: 競技種別)', () => {
  it('normalises types; anything unrecognised is not a family', () => {
    expect(normalizeMatchType('01')).toBe('01');
    expect(normalizeMatchType('501')).toBe('01');
    expect(normalizeMatchType('Cricket')).toBe('cricket');
    expect(normalizeMatchType('count_up')).toBeNull();
    expect(normalizeMatchType('')).toBeNull();
  });

  it('a slot: explicit type wins; a name alone never decides; contradictions are unknown', () => {
    expect(slotFamily(slot({ matchType: 'cricket', startScore: 501 }))).toEqual({ family: 'cricket', basis: 'explicit' });
    expect(slotFamily(slot({ matchType: 'count_up' }))).toEqual({ family: 'unknown', basis: 'explicit' });
    expect(slotFamily(slot({ startScore: 701 }))).toEqual({ family: '01', basis: 'start-score' });
    expect(slotFamily(slot({ startScore: 0, subtitle: 'クリケット' }))).toEqual({ family: 'cricket', basis: 'start-score+name' });
    expect(slotFamily(slot({ startScore: null, subtitle: 'Cricket' }))).toEqual({ family: 'unknown', basis: 'none' });
    expect(slotFamily(slot({ startScore: 501, subtitle: 'クリケット' }))).toEqual({ family: 'unknown', basis: 'conflict' });
    expect(slotFamily(slot({ startScore: null }))).toEqual({ family: 'unknown', basis: 'none' });
    expect(slotFamily(slot({ startScore: null, settingMatchType: '01' }))).toEqual({ family: '01', basis: 'setting' });
    expect(slotFamily(slot({ startScore: 0, subtitle: 'クリケット', settingMatchType: '01' }))).toEqual({ family: 'unknown', basis: 'conflict' });
  });

  it('a played game without match_type is 01 (n01 spec) — but not under a Cricket slot', () => {
    expect(gameFamily(null, null)).toEqual({ family: '01', basis: 'match-default' });
    expect(gameFamily(null, { family: '01', basis: 'start-score' })).toEqual({ family: '01', basis: 'match-default' });
    expect(gameFamily(null, { family: 'cricket', basis: 'start-score+name' })).toEqual({ family: 'unknown', basis: 'conflict' });
    expect(gameFamily('cricket', { family: '01', basis: 'start-score' })).toEqual({ family: 'cricket', basis: 'explicit' });
    expect(gameFamily('01', { family: 'cricket', basis: 'explicit' })).toEqual({ family: 'unknown', basis: 'conflict' });
  });

  it('role: slot num_part checked against the players on both sides; gallon by subtitle', () => {
    expect(gameRole(slot({ numPart: 2 }), [2, 2])).toBe('doubles');
    expect(gameRole(slot({ numPart: 2 }), [3, 2])).toBe('unknown');
    expect(gameRole(slot({ numPart: 2 }), [3, 3])).toBe('unknown');
    expect(gameRole(slot({ numPart: 4, subtitle: 'ガロン' }), [4, 4])).toBe('gallon');
    expect(gameRole(slot({ numPart: 4, subtitle: 'チーム' }), [4, 4])).toBe('team');
    expect(gameRole(slot({ numPart: 3 }), [3, 3])).toBe('trios');
    expect(gameRole(null, [1, 1])).toBe('singles');
    expect(gameRole(null, [1, 2])).toBe('unknown');
  });

  it('season composition: the override replaces the base for its division only', () => {
    const slots = [slot({ schid: 'a', matchType: '01' }), slot({ schid: 'b', matchType: 'cricket' }), slot({ schid: 'c', division: 0, matchType: '01' })];
    // Division 0 plays only `c` (01); division 1 plays the base (with Cricket).
    expect(seasonComposition(slots, [0]).composition).toBe('pure01');
    expect(seasonComposition(slots, [0, 1]).composition).toBe('mixed');
    expect(seasonComposition([slot({ startScore: null })], [0]).composition).toBe('unknown');
    expect(seasonComposition([], [0]).composition).toBe('unknown');
  });

  it('scopes: "others" = trios + gallon + team; a role scope never includes unclassified games', () => {
    expect(inScope('team', 'others')).toBe(true);
    expect(inScope('doubles', 'others')).toBe(false);
    expect(inScope('unknown', 'doubles')).toBe(false);
    expect(inScope('unknown', 'all01')).toBe(true);
  });

  it('league games are told apart from playoffs by tmid', () => {
    expect(isLeagueGame('t_x_lg_2_abcd_A_B')).toBe(true);
    expect(divisionOfMatchId('t_x_lg_2_abcd_A_B')).toBe(2);
    expect(isLeagueGame('t_x_m_0_A_B')).toBe(false);
    expect(divisionOfMatchId('t_x_lg_t_x_r1_1_A_B')).toBeNull();
  });
});

describe('parsers keep what n01 did not write', () => {
  it('slot evidence keeps a missing match_type missing, and reads division overrides', () => {
    const slots = parseSlotEvidence({ result: 0, tournament: { lg_setting: { schedule: [{ schid: 'a', num_part: 1, startScore: 501 }], game_setting: [{ round: 1, match_type: '01', schedule: [{ schid: 'b', num_part: 2, startScore: 701 }] }] } } });
    expect(slots).toEqual([
      { schid: 'a', division: null, numPart: 1, subtitle: null, startScore: 501, limitLegCount: null, matchType: null, settingMatchType: null },
      { schid: 'b', division: 1, numPart: 2, subtitle: null, startScore: 701, limitLegCount: null, matchType: null, settingMatchType: '01' },
    ]);
    expect(parseSlotEvidence({ result: 0, tournament: {} })).toEqual([]);
  });

  it('match/list rows: an unreadable row is counted, not guessed; a missing list is a schema error', () => {
    const side = (tpid: string, won: number) => ({ tpid, order: [{ oid: `${tpid}1` }], winLegs: won, allScore: 501, allDarts: 30 });
    const page = parseGameList({ result: 0, list: [{ mid: 'm1', tmid: 't_lg_0_x_A_B', schid: 's', endMatch: 1, statsData: [side('A', 2), side('B', 0)] }, { mid: 'm2', statsData: [side('A', 1)] }] });
    expect(page.rows).toBe(2);
    expect(page.unreadable).toBe(1);
    expect(page.games[0]).toMatchObject({ gameId: 'm1', matchType: null, finished: true });
    expect(() => parseGameList({ result: 0 })).toThrow();
    expect(() => parseGameList({ result: -55, error: 'too many requests' })).toThrow();
  });

  it('match/get: legs with visits; a malformed leg makes the whole game unreadable', () => {
    const side = (tpid: string) => ({ tpid, order: [{ oid: `${tpid}1` }], winLegs: 0, allScore: 0, allDarts: 0 });
    const ok = parseGameDetail({ result: 0, match: { mid: 'm', startScore: 501, endMatch: 1, statsData: [side('A'), side('B')], legData: [{ first: 0, winner: 0, endFlag: 1, playerData: [[{ score: 0, left: 501 }, { score: 60, left: 441 }], [{ score: 0, left: 501 }]] }] } });
    expect(ok.legs[0].visits[0]).toEqual([{ score: 60, left: 441 }]);
    expect(() => parseGameDetail({ result: 0, match: { mid: 'm', statsData: [side('A'), side('B')], legData: [{ playerData: [[{ score: 0, left: 501 }, { score: 'x' }], []] }] } })).toThrow();
  });
});

// ---- synthetic seasons ---------------------------------------------------------------------

const T = [
  { id: 'A', name: 'Alpha' },
  { id: 'B', name: 'Bravo' },
];

/** A doubles game A(a1,a2) vs B(b1,b2) and a singles game a1 vs b1, per season. */
function games(tdid: string, opts: { doublesScore?: number; matchType?: string | null } = {}): RawGame[] {
  const mk = (id: string, schid: string, a: string[], b: string[], aScore: number, aDarts: number, aWon: number, bWon: number, matchType: string | null = opts.matchType ?? null): RawGame => ({
    gameId: `${tdid}_${id}`,
    matchId: `${tdid}_lg_0_x_A_B`,
    schid,
    matchType,
    finished: true,
    startTime: null,
    sides: [
      { teamId: 'A', players: a.map((oid) => ({ oid, opid: null, name: null })), legsWon: aWon, score: aScore, darts: aDarts },
      { teamId: 'B', players: b.map((oid) => ({ oid, opid: null, name: null })), legsWon: bWon, score: 900, darts: 60 },
    ],
  });
  return [mk('d', 'dbl', ['a1', 'a2'], ['b1', 'b2'], opts.doublesScore ?? 1002, 60, 2, 1), mk('s', 'sgl', ['a1'], ['b1'], 1002, 45, 2, 0), mk('c', 'cri', ['a2'], ['b2'], 0, 0, 0, 2, 'cricket')];
}

function seasonOf(tdid: string, opts: { startScore?: number; legs?: number; slots?: SlotEvidence[] } = {}) {
  const t = tournament(tdid, T, { startScore: opts.startScore, legs: opts.legs });
  t.schedule = [
    { schid: 'sgl', numPart: 1, subtitle: null, matchType: '01', startScore: opts.startScore ?? 501, limitLegCount: opts.legs ?? 2, group: null },
    { schid: 'dbl', numPart: 2, subtitle: null, matchType: '01', startScore: opts.startScore ?? 501, limitLegCount: opts.legs ?? 2, group: null },
  ];
  return buildSeasonData(
    season({
      tournament: t,
      ...(opts.slots ? { slots: opts.slots } : {}),
      // The whole roster proves each opid is one person, so seasons link (design §3).
      roster: roster([
        { oid: 'a1', opid: 'op1', team: 'A', name: 'A1' },
        { oid: 'a2', opid: 'op2', team: 'A', name: 'A2' },
        { oid: 'b1', opid: 'op3', team: 'B', name: 'B1' },
        { oid: 'b2', opid: 'op4', team: 'B', name: 'B2' },
      ]),
      teamStats: [teamRow('A', simpleLine(2004, 105, 4, 5)), teamRow('B', simpleLine(1800, 120, 1, 5))],
      playerStats: [playerRow('a1', 'op1', 'A', 'A1', simpleLine(1503, 75, 4, 5)), playerRow('a2', 'op2', 'A', 'A2', simpleLine(501, 30, 2, 3)), playerRow('b1', 'op3', 'B', 'B1', simpleLine(1350, 90, 1, 5)), playerRow('b2', 'op4', 'B', 'B2', simpleLine(450, 30, 1, 3))],
    }),
  );
}

const complete = (tdid: string, list: RawGame[]): SeasonGames => ({ tournamentId: tdid, games: list, dropped: { unfinished: 0, unreadable: 0, nonLeague: 0 }, complete: true });
const source = (entries: [string, SeasonGames][], failed: string[] = []): GamesSource => ({ games: new Map(entries), failed: new Set(failed) });

describe('role lines and projection (P2)', () => {
  it('team lines come from side totals once; a doubles total is never copied onto both partners', () => {
    const s = seasonOf('s1');
    const lines = linesFromGames(classifyGames(s, games('s1')), 'doubles');
    expect(lines.teams.get('A')).toMatchObject({ score: 1002, darts: 60, leg: 3, winLeg: 2, set: 1, winSet: 1 });
    expect(lines.players.get('a1')).toMatchObject({ score: null, darts: null, leg: 3, winLeg: 2, set: 1 });
    expect(lines.players.get('a2')).toMatchObject({ score: null, darts: null });
  });

  it('singles: the one thrower\'s score/darts are exact; Cricket games never enter a 01 line', () => {
    const s = seasonOf('s1');
    const lines = linesFromGames(classifyGames(s, games('s1')), 'singles');
    expect(lines.players.get('a1')).toMatchObject({ score: 1002, darts: 45, leg: 2, winLeg: 2 });
    expect(lines.players.has('a2')).toBe(false); // a2 only played doubles and Cricket
    const all = linesFromGames(classifyGames(s, games('s1')), 'all01');
    expect(all.games).toBe(2);
    expect(all.teams.get('A')).toMatchObject({ score: 2004, darts: 105, set: 2 });
  });

  it('01全体 = doubles + singles + others for the team (consistency of the breakdown)', () => {
    const s = seasonOf('s1');
    const c = classifyGames(s, games('s1'));
    const sum = (scope: 'singles' | 'doubles' | 'others') => linesFromGames(c, scope).teams.get('A');
    const all = linesFromGames(c, 'all01').teams.get('A')!;
    expect((sum('singles')?.score ?? 0) + (sum('doubles')?.score ?? 0) + (sum('others')?.score ?? 0)).toBe(all.score);
    expect((sum('singles')?.leg ?? 0) + (sum('doubles')?.leg ?? 0) + (sum('others')?.leg ?? 0)).toBe(all.leg);
  });

  it('pools 2-leg and 3-leg seasons, 501 and 1001, by Σ score × 3 / Σ darts — not a mean of means', () => {
    const s1 = seasonOf('s1', { legs: 2 });
    const s2 = seasonOf('s2', { legs: 3, startScore: 1001 });
    const p = projectSeasons([s1, s2], 'singles', source([['s1', complete('s1', games('s1'))], ['s2', complete('s2', games('s2'))]]));
    const a1 = aggregatePlayers(p.seasons).find((x) => x.personKey === 'opid:op1')!;
    expect(a1.metrics.ppr).toMatchObject({ num: 3 * 2004, den: 90 });
    expect(a1.metrics.seasons).toBe(2);
    const team = aggregateTeams(p.seasons).find((t) => t.name === 'Alpha')!;
    expect(team.metrics.legRate).toMatchObject({ num: 4, den: 4 });
  });

  it('a pure-01 season keeps n01\'s values in 01全体 and needs no game rows', () => {
    const s = seasonOf('s1');
    expect(seasonsNeedingGames([s], 'all01')).toEqual([]);
    expect(seasonsNeedingGames([s], 'doubles')).toEqual(['s1']);
    const p = projectSeasons([s], 'all01', source([]));
    expect(p.seasons[0]).toBe(s);
    expect(p.adoption[0].metrics.keepBreak.state).toBe('official');
  });

  it('a game-kind view without game rows contributes nothing (null, not 0) and says why', () => {
    const s = seasonOf('s1');
    const p = projectSeasons([s], 'singles', source([], ['s1']));
    expect(p.seasons[0].teams.every((t) => t.line === null || Object.values(t.line).every((v) => v === null))).toBe(true);
    expect(p.adoption[0]).toMatchObject({ gamesState: 'missing', metrics: { ppr: { state: 'excluded' } } });
    const team = aggregateTeams(p.seasons).find((t) => t.name === 'Alpha')!;
    expect(team.metrics.ppr.value).toBeNull();
    expect(team.metrics.seasons).toBe(0);
  });

  it('a list that could not be read to the end is never used as the season', () => {
    const s = seasonOf('s1');
    const p = projectSeasons([s], 'singles', source([['s1', { ...complete('s1', games('s1')), complete: false }]]));
    expect(p.adoption[0].gamesState).toBe('partial');
    expect(p.adoption[0].metrics.legSet.state).toBe('excluded');
  });

  it('a list with an unreadable row: Leg / Set / role figures of that season are withheld, and the reason says why (Codex P1)', () => {
    const s = seasonOf('s1');
    const withGap: SeasonGames = { ...complete('s1', games('s1')), dropped: { unfinished: 0, unreadable: 1, nonLeague: 0 }, complete: false };
    for (const scope of ['singles', 'doubles', 'all01'] as const) {
      const p = projectSeasons([s], scope, source([['s1', withGap]]));
      expect(p.adoption[0]).toMatchObject({ gamesState: 'partial', unreadableGames: 1 });
      expect(p.adoption[0].metrics.legSet).toMatchObject({ state: 'excluded', reason: expect.stringContaining('読めない試合記録が1件') });
      const a = p.seasons[0].teams.find((t) => t.teamId === 'A')!.line;
      expect(a?.leg ?? null).toBeNull();
      expect(a?.set ?? null).toBeNull();
    }
  });

  it('an unknown-type slot: n01 totals are not adopted in 01全体; only the 01 game rows count', () => {
    const s = seasonOf('s1', { slots: [slot({ schid: 'sgl', numPart: 1, matchType: '01' }), slot({ schid: 'dbl', numPart: 2, matchType: '01' }), slot({ schid: 'x', numPart: 1, startScore: null })] });
    expect(s.composition.composition).toBe('unknown');
    expect(seasonsNeedingGames([s], 'all01')).toEqual(['s1']);
    const p = projectSeasons([s], 'all01', source([['s1', complete('s1', games('s1'))]]));
    expect(p.seasons[0].teams.find((t) => t.teamId === 'A')!.line).toMatchObject({ score: 2004, darts: 105, f9Score: null });
    // a1 played a doubles game: without a verified reconstruction the 3DA is withheld.
    expect(p.seasons[0].players.find((x) => x.oid === 'a1')!.line.darts).toBeNull();
    expect(p.adoption[0].metrics.first9.state).toBe('excluded');
  });

  it('a Cricket game in a season whose schedule says 01 turns the season into "mixed"', () => {
    const s = seasonOf('s1');
    const p = projectSeasons([s], 'all01', source([['s1', complete('s1', games('s1'))]]));
    // seasonsNeedingGames would not have asked, but when rows are present they are honoured.
    expect(p.adoption[0].composition).toBe('mixed');
    expect(p.seasons[0].teams.find((t) => t.teamId === 'A')!.line).toMatchObject({ leg: 5, set: 2, breakLegs: null });
  });
});

it('mixed season: only the division whose slots include Cricket is corrected; the other keeps n01\'s values', () => {
  const t = tournament('s1', [{ id: 'A', name: 'Alpha', division: 0 }, { id: 'B', name: 'Bravo', division: 1 }]);
  const slots = [slot({ schid: 'sgl', numPart: 1, matchType: '01' }), slot({ schid: 'cri', numPart: 1, matchType: 'cricket' }), slot({ schid: 'sgl0', division: 0, numPart: 1, matchType: '01' })];
  const s = buildSeasonData(season({ tournament: t, slots, teamStats: [teamRow('A', simpleLine(3000, 150, 5, 9, { breakLegs: 4, breakWins: 2 }), 0), teamRow('B', simpleLine(3000, 150, 5, 9, { breakLegs: 4, breakWins: 2 }), 1)] }));
  expect(s.composition.composition).toBe('mixed');
  expect(s.divisionComposition).toEqual({ 0: 'pure01', 1: 'mixed' });
  const p = projectSeasons([s], 'all01', source([['s1', complete('s1', [])]]));
  expect(p.seasons[0].teams.find((x) => x.teamId === 'A')!.line).toMatchObject({ leg: 9, breakLegs: 4 });
  expect(p.seasons[0].teams.find((x) => x.teamId === 'B')!.line).toMatchObject({ leg: 0, breakLegs: null, score: 3000 });
});

describe('reconstruction rules on synthetic legs', () => {
  const detail = (aOrder: string[], legs: { first: number; winner: number; a: number[]; b: number[]; aOut?: [number, number] }[], start = 501) => {
    const side = (tpid: string, oids: string[], score: number, darts: number, won: number) => ({ teamId: tpid, players: oids.map((oid) => ({ oid, opid: null, name: null })), legsWon: won, score, darts });
    let aScore = 0;
    let aDarts = 0;
    let bScore = 0;
    let bDarts = 0;
    const raw = legs.map((leg) => {
      let left = start;
      const av = leg.a.map((p) => ((left -= p), { score: p, left }));
      aScore += leg.a.reduce((x, y) => x + y, 0);
      aDarts += leg.a.length * 3;
      if (leg.aOut) {
        av.push({ score: -leg.aOut[0], left: 0 });
        aScore += left;
        aDarts += leg.aOut[0];
      }
      let lb = start;
      const bv = leg.b.map((p) => ((lb -= p), { score: p, left: lb }));
      bScore += leg.b.reduce((x, y) => x + y, 0);
      bDarts += leg.b.length * 3;
      return { first: leg.first, winner: leg.winner, ended: true, visits: [av, bv] as [typeof av, typeof bv] };
    });
    return { gameId: 'g', matchId: null, schid: null, matchType: null, startScore: start, finished: true, legs: raw, sides: [side('A', aOrder, aScore, aDarts, 1), side('B', ['b1', 'b2'], bScore, bDarts, 0)] as [ReturnType<typeof side>, ReturnType<typeof side>] };
  };

  it('restarts the rotation at order[0] each leg; a <3-dart checkout counts its darts; busts (0) are visits', () => {
    const r = reconstructGame(detail(['p1', 'p2'], [{ first: 0, winner: 0, a: [100, 0, 140, 60, 101], aOut: [2, 0], b: [20, 20] }, { first: 1, winner: 1, a: [60], b: [30] }]));
    if (!r.ok) throw new Error(r.reason);
    // Leg 1: p1 100, p2 0 (bust), p1 140, p2 60, p1 101, p2 checks out 100 with 2 darts. Leg 2: p1 60.
    expect(r.perPlayer.p1).toMatchObject({ score: 100 + 140 + 101 + 60, darts: 12, ton00: 2, ton40: 1, f9Score: 100 + 140 + 60, f9Darts: 9 });
    expect(r.perPlayer.p2).toMatchObject({ score: 0 + 60 + 100, darts: 8, highOut: 100, f9Score: 0, f9Darts: 3 });
    // Break: leg 2 opponent threw first → one break leg for both partners, not won.
    expect(r.perPlayer.p1).toMatchObject({ breakLegs: 1, breakWins: 0 });
  });

  it('refuses a game whose legs do not add up to its totals', () => {
    const d = detail(['p1', 'p2'], [{ first: 0, winner: 0, a: [100], b: [20] }]);
    d.sides[0].score = 999;
    expect(reconstructGame(d)).toMatchObject({ ok: false });
    expect(reconstructGame({ ...d, finished: false })).toMatchObject({ ok: false });
  });
});

describe('what a view may rank', () => {
  it('Best Leg is compared only when every season plays the same start scores', () => {
    const a = seasonOf('s1');
    const b = seasonOf('s2', { startScore: 1001 });
    expect(startScoresOf(a)).toEqual([501]);
    expect(bestLegBasis([a, a]).comparable).toBe(true);
    expect(bestLegBasis([a, b]).comparable).toBe(false);
    expect(scopeMetrics('all01', [a, b], 'player').rank).not.toContain('bestLeg');
  });

  it('doubles/others rank players by Leg/Set only; teams and singles by 3DA too', () => {
    const a = seasonOf('s1');
    expect(scopeMetrics('doubles', [a], 'player').rank).toEqual(['legRate', 'setRate']);
    expect(scopeMetrics('doubles', [a], 'team').rank).toEqual(['ppr', 'legRate', 'setRate']);
    expect(scopeMetrics('singles', [a], 'player').rank).toEqual(['ppr', 'legRate', 'setRate']);
  });
});

it('a line with nothing measured is not a contributing season', () => {
  expect(aggregateTeams([buildSeasonData(season({ tournament: tournament('s', T), teamStats: [teamRow('A', line({}))] }))])[0].metrics.seasons).toBe(0);
});

describe('metric catalog (Cricket-ready, nothing unimplemented offered)', () => {
  it('lists only implemented 01 metrics; Cricket and unknown offer none yet', async () => {
    const { implementedMetrics, METRIC_CATALOG, zeroOneMetricIds } = await import('./metricCatalog');
    const { METRIC_LABEL } = await import('./format');
    expect(implementedMetrics('cricket')).toEqual([]);
    expect(implementedMetrics('unknown')).toEqual([]);
    expect(METRIC_CATALOG.some((m) => m.family === 'cricket')).toBe(true);
    for (const id of zeroOneMetricIds()) expect(METRIC_LABEL).toHaveProperty(id);
  });
});
