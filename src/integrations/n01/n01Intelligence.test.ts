import { describe, expect, it } from 'vitest';
import type { LeagueFormat } from '../../domain/types';
import { N01Client, N01Error } from './client';
import type { N01Request } from './endpoints';
import { fetchTeamData, planN01Sync, type N01TeamData } from './sync';
import { buildIntelligenceSnapshot, fetchIntelligence, type IntelligenceFetch } from './intelligence';
import { jstToday, resolveNextMatch } from './scheduleResolver';
import type { N01Fixture, N01Tournament } from './types';
import { aggregatePlayer, leagueMeanPpr } from '../../domain/n01/history';
import { buildPositionModel } from '../../domain/n01/positionModel';
import { recencyWeight, RECENCY_WEIGHTS, RECENCY_FLOOR } from '../../domain/n01/recency';
import { describeSignature, formatSignatures, signaturesOf } from '../../domain/n01/signature';
import { aggregateConfidence, minConfidence, playerConfidence, slotConfidence } from '../../domain/prediction/confidence';
import { FAIL, createFixtureTransport } from '../../test/n01/transport';
import { buildNextMatchOrder, eligiblePlayers } from '../../domain/n01/nextMatch';
import { DEFAULT_OPTIMIZER_SETTINGS, DEFAULT_WEIGHTS } from '../../domain/orders/presets';
import { FIXTURE_NOW } from '../../test/n01/leagues';

const ATDO = 'lg_l3hI_3397';

function client(options: Parameters<typeof createFixtureTransport>[0] = {}): N01Client {
  return new N01Client(createFixtureTransport(options), { now: () => FIXTURE_NOW });
}

async function kalavinka(c = client()): Promise<{ data: N01TeamData; format: LeagueFormat }> {
  const data = await fetchTeamData(c, { leagueId: ATDO, leagueTitle: 'ATDO', tournamentId: 't_ABvC_5234', teamTpid: 'GpiQ' }, () => FIXTURE_NOW);
  let n = 0;
  const plan = planN01Sync({ team: { id: 'team_kv', name: 'kalavinka', createdAt: 0 }, localPlayers: [], existingFormat: null, data, now: FIXTURE_NOW, newId: (p) => `${p}_${++n}` });
  return { data, format: plan.format };
}

async function intelligence(depth = 2, options: Parameters<typeof createFixtureTransport>[0] = {}): Promise<{ fetched: IntelligenceFetch; data: N01TeamData; format: LeagueFormat }> {
  const c = client(options);
  const { data, format } = await kalavinka(c);
  const fetched = await fetchIntelligence(c, data, { historyDepth: depth, now: () => FIXTURE_NOW });
  return { fetched, data, format };
}

function tournamentWith(divisions: string[][], results: string[] = []): Pick<N01Tournament, 'divisions' | 'results' | 'entries'> {
  return {
    divisions: divisions.map((teamIds, index) => ({ index, title: `D${index}`, teamIds })),
    results: new Map(results.map((id) => [id, { matchId: id, division: 0, finished: true, games: [] }])),
    entries: divisions.flat().map((teamId) => ({ teamId, name: `name-${teamId}` })),
  };
}

const fixture = (matchId: string, home: string, away: string | null, date: string | null, listIndex = 0): N01Fixture => ({
  matchId,
  title: matchId,
  homeTeamId: home,
  awayTeamId: away,
  date,
  listIndex,
});

describe('next match', () => {
  it('ATDO: skips finished matches and the bye, and finds kalavinka vs スピンコブラ on 10/8', async () => {
    const { fetched } = await intelligence(0);
    expect(fetched.resolution).toMatchObject({
      kind: 'resolved',
      match: { opponentTeamId: '68wv', opponentName: 'スピンコブラ', date: '2026-10-08', ourTeamId: 'GpiQ' },
    });
  });

  it('only considers the current division and unresolved, non-bye fixtures', () => {
    const tournament = tournamentWith([['A', 'B', 'C'], ['X']], ['m1']);
    const schedule = [
      fixture('m1', 'A', 'B', '2026-10-01'),
      fixture('m2', 'A', null, '2026-10-02'),
      fixture('m3', 'A', 'X', '2026-10-03'),
      fixture('m4', 'C', 'A', '2026-10-08'),
    ];
    expect(resolveNextMatch(schedule, tournament, 'A', FIXTURE_NOW)).toMatchObject({ kind: 'resolved', match: { matchId: 'm4', opponentTeamId: 'C' } });
  });

  it('asks when two fixtures share the earliest date, and reports none when everything is played', () => {
    const tournament = tournamentWith([['A', 'B', 'C']]);
    const tied = resolveNextMatch([fixture('a', 'A', 'B', '2026-10-08'), fixture('b', 'C', 'A', '2026-10-08')], tournament, 'A', FIXTURE_NOW);
    expect(tied.kind).toBe('ambiguous');
    const done = resolveNextMatch([fixture('a', 'A', 'B', '2026-09-01')], tournamentWith([['A', 'B']], ['a']), 'A', FIXTURE_NOW);
    expect(done).toEqual({ kind: 'none' });
  });

  it('prefers an upcoming fixture over an overdue one that has no result yet', () => {
    const tournament = tournamentWith([['A', 'B', 'C']]);
    const result = resolveNextMatch([fixture('late', 'A', 'B', '2026-10-01'), fixture('next', 'A', 'C', '2026-10-08')], tournament, 'A', FIXTURE_NOW);
    expect(result).toMatchObject({ match: { matchId: 'next' } });
    const onlyOverdue = resolveNextMatch([fixture('late', 'A', 'B', '2026-10-01')], tournament, 'A', FIXTURE_NOW);
    expect(onlyOverdue).toMatchObject({ match: { matchId: 'late' } });
    expect(jstToday(FIXTURE_NOW)).toBe('2026-10-07');
  });

  it('a missing schedule is not fatal: no next match, and a note', async () => {
    const { fetched } = await intelligence(0, { override: (request) => (request.operation === 'league/schedule/get' ? FAIL : undefined) });
    expect(fetched.resolution).toEqual({ kind: 'none' });
    expect(fetched.notes).toEqual(['n01 の日程を取得できませんでした。']);
  });
});

describe('opponent and history', () => {
  it('reads the opponent roster and past orders of the current season', async () => {
    const { fetched } = await intelligence(0);
    expect(fetched.opponentRoster.map((player) => player.name)).toContain('田村 翔');
    expect(fetched.opponentOrders.length).toBeGreaterThan(0);
  });

  it('reads current + 2 previous seasons by default, not the whole history', async () => {
    const log: N01Request[] = [];
    const { fetched } = await intelligence(2, { log });
    expect(fetched.history.map((season) => season.summary.tournamentId)).toEqual(['t_ATp2_5101', 't_ATp1_4988']);
    expect(log.some((request) => request.params.tdid === 't_ATp0_4870')).toBe(false);
    // 4 team requests + schedule + opponent roster/orders + 3 per historical season.
    expect(log.length).toBeLessThanOrEqual(4 + 3 + 2 * 3);
  });

  it('a failed historical season thins the history but does not fail the sync', async () => {
    const { fetched } = await intelligence(2, {
      override: (request) => (request.params.tdid === 't_ATp1_4988' ? new N01Error('http', 'down', request.operation, 503) : undefined),
    });
    expect(fetched.history.map((season) => season.summary.tournamentId)).toEqual(['t_ATp2_5101']);
    expect(fetched.notes).toEqual(['2026 1st: 過去シーズンのデータを取得できませんでした。']);
  });

  it('follows a player across seasons and teams by opid', async () => {
    const { fetched, data, format } = await intelligence(2);
    const snapshot = buildIntelligenceSnapshot({ teamId: 'team_kv', data, format, fetched, historyDepth: 2, now: FIXTURE_NOW });
    const tamura = snapshot.opponent!.stats.find((entry) => entry.name === '田村 翔')!;
    expect(tamura.key).toBe('op_tamura');
    expect(tamura.seasons.map((line) => line.seasonIndex)).toEqual([0, 1, 2]);
    // スピンコブラ this season, ブルズアイ before.
    expect(tamura.seasons[0].teamTpid).toBe('68wv');
    expect(tamura.seasons[1].teamTpid).toBe('P2be');
  });

  it('team analysis uses only the orders of seasons in which that team fielded the player', async () => {
    const { fetched } = await intelligence(2);
    const previousCobra = fetched.history[0];
    expect(previousCobra.opponentTeamId).toBe('P2cb');
    const fielded = previousCobra.opponentOrders.flatMap((entry) => entry.players.map((player) => player.opid));
    // 田村 played for ブルズアイ last season: none of スピンコブラ's orders then include him.
    expect(fielded).not.toContain('op_tamura');
    expect(fielded.length).toBeGreaterThan(0);
  });
});

describe('recency, signatures and the position model', () => {
  it('weights the current season 1.0, then 0.6, 0.35, then a floor', () => {
    expect(RECENCY_WEIGHTS).toEqual([1, 0.6, 0.35]);
    expect([0, 1, 2, 3, 7].map((index) => recencyWeight(index))).toEqual([1, 0.6, 0.35, RECENCY_FLOOR, RECENCY_FLOOR]);
    const aggregate = aggregatePlayer({
      seasons: [
        { tournamentId: 'c', seasonIndex: 0, teamTpid: null, score: 600, darts: 30, legs: 2, matches: 1, legsWon: 1, first9Score: null, first9Darts: null, highOut: null, bestLeg: null, ton: null, ton40: null, ton70: null, ton80: null },
        { tournamentId: 'p', seasonIndex: 1, teamTpid: null, score: 300, darts: 30, legs: 2, matches: 1, legsWon: 0, first9Score: null, first9Darts: null, highOut: null, bestLeg: null, ton: null, ton40: null, ton70: null, ton80: null },
      ],
    });
    // (1.0·600 + 0.6·300) / (1.0·30 + 0.6·30) · 3 = 780 / 48 · 3
    expect(aggregate.ppr).toBeCloseTo(48.75, 6);
    expect(aggregate.legWinRate).toBeCloseTo(1 / 3.2, 6);
    expect(aggregate.first9).toBeNull();
    expect(aggregate.currentPpr).toBe(60);
  });

  it('gives slots stable signatures across seasons, whatever their schid', async () => {
    expect(signaturesOf([
      { structure: 'TEAM', family: '01' },
      { structure: 'DOUBLES', family: '01' },
      { structure: 'SINGLES', family: '01' },
      { structure: 'SINGLES', family: '01' },
      { structure: 'DOUBLES', family: '01' },
    ])).toEqual(['TEAM|01|1', 'DOUBLES|01|1', 'SINGLES|01|1', 'SINGLES|01|2', 'DOUBLES|01|2']);
    const { format } = await kalavinka();
    expect([...formatSignatures(format.games).values()]).toEqual([
      'TEAM|01|1', 'DOUBLES|01|1', 'SINGLES|01|1', 'SINGLES|01|2', 'DOUBLES|01|2', 'SINGLES|01|3', 'SINGLES|01|4',
    ]);
    expect(describeSignature('SINGLES|01|2')).toBe('Singles 01 #2');
  });

  it('maps past orders of every season onto the current slots; every distribution sums to 1', async () => {
    const { fetched, data, format } = await intelligence(2);
    const snapshot = buildIntelligenceSnapshot({ teamId: 'team_kv', data, format, fetched, historyDepth: 2, now: FIXTURE_NOW });
    const model = snapshot.opponent!.positionModel;
    expect(model.slots).toHaveLength(7);
    for (const slot of model.slots) {
      expect(slot.players.reduce((acc, p) => acc + p.probability, 0)).toBeCloseTo(1, 9);
      if (slot.lineups.length > 0) expect(slot.lineups.reduce((acc, l) => acc + l.probability, 0)).toBeCloseTo(1, 9);
      expect(slot.sampleCount).toBeGreaterThan(0);
    }
    // Seen in this season (3 matches) and two full previous seasons.
    expect(model.orderSampleCount).toBeGreaterThan(3);
    const singles1 = model.slots.find((slot) => slot.signature === 'SINGLES|01|1')!;
    expect(singles1.players.every((player) => snapshot.opponent!.players.some((p) => p.key === player.key))).toBe(true);
  });

  it('shrinks a slot seen once towards broader evidence instead of trusting it fully', () => {
    const roster = ['a', 'b', 'c', 'd'].map((key) => ({ key, strength: 50 }));
    const once = buildPositionModel({
      observations: [{ seasonIndex: 0, matchId: 'm1', signature: 'SINGLES|01|1', playerKeys: ['a'] }],
      slots: [{ gameId: 'g', signature: 'SINGLES|01|1', numPart: 1 }],
      roster,
    });
    const a = once.slots[0].players.find((p) => p.key === 'a')!;
    // (1 + 3 · 0.25) / (1 + 3): one sighting moves a from 25% to under 50%.
    expect(a.probability).toBeCloseTo(0.4375, 6);
    expect(once.slots[0].confidence).toBe('LOW');

    const many = buildPositionModel({
      observations: Array.from({ length: 10 }, (_, i) => ({ seasonIndex: 0, matchId: `m${i}`, signature: 'SINGLES|01|1', playerKeys: ['a'] })),
      slots: [{ gameId: 'g', signature: 'SINGLES|01|1', numPart: 1 }],
      roster,
    });
    expect(many.slots[0].players[0]).toMatchObject({ key: 'a' });
    expect(many.slots[0].players[0].probability).toBeGreaterThan(0.75);
    expect(many.slots[0].confidence).toBe('HIGH');
    expect(many.confidence).toBe('HIGH');
  });

  it('with no past orders the distribution falls back to the base prior (never certain)', () => {
    const model = buildPositionModel({
      observations: [],
      slots: [{ gameId: 'g', signature: 'DOUBLES|01|1', numPart: 2 }],
      roster: [{ key: 'strong', strength: 70 }, { key: 'weak', strength: 40 }, { key: 'new', strength: null }],
    });
    const [first] = model.slots[0].players;
    expect(first.key).toBe('strong');
    expect(first.probability).toBeLessThan(0.6);
    expect(model.slots[0].lineups).toEqual([]);
    expect(model.confidence).toBe('LOW');
  });

  it('players who left the roster get no probability', () => {
    const model = buildPositionModel({
      observations: [{ seasonIndex: 0, matchId: 'm', signature: 'SINGLES|01|1', playerKeys: ['gone'] }],
      slots: [{ gameId: 'g', signature: 'SINGLES|01|1', numPart: 1 }],
      roster: [{ key: 'a', strength: null }, { key: 'b', strength: null }],
    });
    expect(model.slots[0].players.map((p) => p.key).sort()).toEqual(['a', 'b']);
  });
});

describe('confidence model', () => {
  it('uses named thresholds and takes the weakest input', () => {
    expect([0, 11.9, 12, 39.9, 40].map(playerConfidence)).toEqual(['LOW', 'LOW', 'MEDIUM', 'MEDIUM', 'HIGH']);
    expect([0, 2.5, 6].map(slotConfidence)).toEqual(['LOW', 'MEDIUM', 'HIGH']);
    expect(minConfidence('HIGH', 'MEDIUM', 'HIGH')).toBe('MEDIUM');
    expect(aggregateConfidence(['HIGH', 'LOW', 'MEDIUM', 'HIGH'])).toBe('MEDIUM');
    expect(aggregateConfidence([])).toBe('LOW');
  });

  it('the snapshot carries sample metadata and a league prior', async () => {
    const { fetched, data, format } = await intelligence(2);
    const snapshot = buildIntelligenceSnapshot({ teamId: 'team_kv', data, format, fetched, historyDepth: 2, now: FIXTURE_NOW });
    expect(snapshot.seasons.map((season) => [season.seasonIndex, season.weight])).toEqual([[0, 1], [1, 0.6], [2, 0.35]]);
    expect(snapshot.nextMatch?.opponentName).toBe('スピンコブラ');
    expect(snapshot.ourPlayers.map((player) => player.key)).toEqual(snapshot.ourStats.map((entry) => entry.key));
    expect(snapshot.leagueMeanPpr).toBeGreaterThan(30);
    expect(snapshot.leagueMeanPpr).toBeLessThan(70);
    expect(['MEDIUM', 'HIGH']).toContain(snapshot.orderConfidence);
    expect(leagueMeanPpr([])).toBeNull();
    // 中村 never played: present, with no stat lines (not zeros).
    expect(snapshot.ourStats.find((entry) => entry.name === '中村 蓮')?.seasons).toEqual([]);
  });
});

describe('next match order from a synced team (Phase 5)', () => {
  it('kalavinka vs スピンコブラ: opponent-optimised input over the synced roster and format', async () => {
    const c = client();
    const data = await fetchTeamData(c, { leagueId: ATDO, leagueTitle: 'ATDO', tournamentId: 't_ABvC_5234', teamTpid: 'GpiQ' }, () => FIXTURE_NOW);
    let n = 0;
    const team = { id: 'team_kv', name: 'kalavinka', createdAt: 0 };
    const plan = planN01Sync({ team, localPlayers: [], existingFormat: null, data, now: FIXTURE_NOW, newId: (p) => `${p}_${++n}` });
    const fetched = await fetchIntelligence(c, data, { historyDepth: 2, now: () => FIXTURE_NOW });
    const intel = buildIntelligenceSnapshot({ teamId: team.id, data, format: plan.format, fetched, historyDepth: 2, now: FIXTURE_NOW });
    const players = eligiblePlayers(plan.players);
    const attending = new Set(players.slice(1).map((player) => player.id));
    const built = buildNextMatchOrder({
      team: plan.team,
      players,
      format: plan.format,
      pairs: [],
      settings: { activeTeamId: team.id, optimizer: DEFAULT_OPTIMIZER_SETTINGS, lastPreset: 'BALANCED', customWeights: DEFAULT_WEIGHTS },
      intel,
      attending,
    });
    expect(built.opponentAvailable).toBe(true);
    expect(built.input.preset).toBe('OPPONENT_OPTIMIZED');
    expect(built.input.opponent?.opponentName).toBe('スピンコブラ');
    expect(built.match).toMatchObject({ opponentName: 'スピンコブラ', matchDate: '2026-10-08', teamName: 'kalavinka' });
    expect(built.input.games).toBe(plan.format.games);
    expect(built.input.participants.filter((config) => config.include).map((config) => config.playerId)).toEqual([...attending]);
    // What the optimizer sees for a player with n01 stats is the recency-weighted, shrunk
    // estimate over the seasons analysed — the very number the opponent model uses for our
    // players — while the player's own record keeps this season's PPR as synced.
    const withStats = plan.players.find((player) => player.n01?.stats);
    expect(withStats).toBeDefined();
    const used = built.input.players.find((player) => player.id === withStats?.id);
    expect(used?.n01?.stats?.ppr).toBe(withStats?.n01?.stats?.ppr);
    expect(used?.ppr).toBeCloseTo(built.input.opponent!.players[withStats!.id].strength, 1);
    expect(built.input.strengthBasis?.players[withStats!.id].ppr).toBe(used?.ppr);
  });
});
