import { describe, expect, it } from 'vitest';
import type { AppSettings, Player, Team } from '../types';
import { DEFAULT_OPTIMIZER_SETTINGS, DEFAULT_WEIGHTS } from '../orders/presets';
import { generateOrder } from '../../optimizer/generateOrder';
import { buildNextMatchOrder } from './nextMatch';
import type { N01MatchIntelligenceSnapshot } from './intelligence';
import {
  BEFORE,
  PREVIOUS,
  buildIntel,
  linkedPlayer,
  managedFormat,
  rosterPlayer,
  row,
} from '../../test/n01/intelFixtures';

/**
 * F03: a player's earlier seasons count when the order is made, not only when an
 * opponent is known.
 *
 * `Player.n01.stats` keeps this season's numbers as synced. The order input carries the
 * PPR the order was generated with — this season's, or the recency-weighted and shrunk
 * estimate over the seasons n01 returned — and says where it came from.
 */

const TEAM: Team = { id: 'team_test', name: 'Us', createdAt: 0 };
const SETTINGS: AppSettings = {
  activeTeamId: 'team_test',
  optimizer: DEFAULT_OPTIMIZER_SETTINGS,
  lastPreset: 'WIN_FIRST',
  customWeights: DEFAULT_WEIGHTS,
};

const ALICE = { opid: 'op_a', oid: 'a1', name: 'Alice' };
const BOB = { opid: 'op_b', oid: 'b1', name: 'Bob' };
const CAROL = { opid: 'op_c', oid: 'c1', name: 'Carol' };
const ROSTER = [rosterPlayer('op_a', 'a1', 'Alice'), rosterPlayer('op_b', 'b1', 'Bob'), rosterPlayer('op_c', 'c1', 'Carol')];

function orderFor(intel: N01MatchIntelligenceSnapshot | null, players: Player[]) {
  return buildNextMatchOrder({
    team: TEAM,
    players,
    format: managedFormat(),
    pairs: [],
    settings: SETTINGS,
    intel,
    attending: new Set(players.map((player) => player.id)),
  });
}

const pprOf = (order: ReturnType<typeof orderFor>, id: string): number | null =>
  order.input.players.find((player) => player.id === id)!.ppr;

describe('history reaches the ordinary order', () => {
  const previous = (id = PREVIOUS, seasonIndex = 1) => ({
    id,
    title: id === PREVIOUS ? '2026 2nd' : '2026 1st',
    seasonIndex,
    stats: [row('op_a', 'a0', 'Alice', 60), row('op_b', 'b0', 'Bob', 40)],
  });

  it('this season has no rows: the season before sets the strength', () => {
    const intel = buildIntel({ roster: ROSTER, stats: [], history: [previous()] });
    const order = orderFor(intel, [linkedPlayer('pl_a', ALICE), linkedPlayer('pl_b', BOB), linkedPlayer('pl_c', CAROL)]);

    expect(order.opponentAvailable).toBe(false);
    expect(order.input.preset).toBe('WIN_FIRST');
    const alice = pprOf(order, 'pl_a')!;
    const bob = pprOf(order, 'pl_b')!;
    expect(alice).toBeGreaterThan(50);
    expect(alice).toBeLessThan(60);
    expect(bob).toBeGreaterThan(40);
    expect(bob).toBeLessThan(50);
    // Carol has no data anywhere: Unknown, never 0.
    expect(pprOf(order, 'pl_c')).toBeNull();
  });

  it('records which seasons stood behind each number, with a confidence', () => {
    const intel = buildIntel({ roster: ROSTER, stats: [], history: [previous()] });
    const order = orderFor(intel, [linkedPlayer('pl_a', ALICE), linkedPlayer('pl_c', CAROL)]);
    const basis = order.input.strengthBasis!;
    expect(basis.players.pl_a).toMatchObject({ origin: 'history', seasons: [1], confidence: 'MEDIUM' });
    expect(basis.players.pl_a.ppr).toBe(pprOf(order, 'pl_a'));
    expect(basis.players.pl_c).toMatchObject({ origin: 'unknown', ppr: null, confidence: 'LOW' });
    expect(basis.seasons.map((season) => season.title)).toContain('2026 2nd');
  });

  it('one leg this season barely moves a player with a full previous season', () => {
    const intel = buildIntel({
      roster: ROSTER,
      stats: [row('op_a', 'a1', 'Alice', 30, 24)],
      history: [previous()],
    });
    const order = orderFor(intel, [
      linkedPlayer('pl_a', ALICE, { statsPpr: 30, legs: 1 }),
      linkedPlayer('pl_b', BOB),
    ]);
    // Raw this-season PPR is 30; the earlier 60 over 50 legs outweighs a single leg.
    expect(pprOf(order, 'pl_a')!).toBeGreaterThan(45);
    expect(order.input.players.find((player) => player.id === 'pl_a')!.n01!.stats!.ppr).toBe(30);
    expect(order.input.strengthBasis!.players.pl_a.seasons).toEqual([0, 1]);
  });

  it('uses the season before last when that is all there is', () => {
    const intel = buildIntel({ roster: ROSTER, stats: [], history: [{ ...previous(BEFORE, 2) }] });
    const order = orderFor(intel, [linkedPlayer('pl_a', ALICE), linkedPlayer('pl_b', BOB)]);
    const alice = pprOf(order, 'pl_a')!;
    expect(alice).toBeGreaterThan(pprOf(order, 'pl_b')!);
    expect(order.input.strengthBasis!.players.pl_a.seasons).toEqual([2]);
  });

  it('keeps this season’s PPR as is when there is a plenty of it and no history', () => {
    const intel = buildIntel({ roster: ROSTER, stats: [row('op_a', 'a1', 'Alice', 55, 3000), row('op_b', 'b1', 'Bob', 45, 3000)] });
    const order = orderFor(intel, [
      linkedPlayer('pl_a', ALICE, { statsPpr: 55, legs: 125 }),
      linkedPlayer('pl_b', BOB, { statsPpr: 45, legs: 125 }),
    ]);
    expect(pprOf(order, 'pl_a')!).toBeGreaterThan(pprOf(order, 'pl_b')!);
    expect(order.input.strengthBasis!.players.pl_a).toMatchObject({ origin: 'current', confidence: 'HIGH' });
  });

  it('a hand-entered PPR wins over history', () => {
    const intel = buildIntel({ roster: ROSTER, stats: [], history: [previous()] });
    const order = orderFor(intel, [linkedPlayer('pl_a', ALICE, { pprSource: 'manual', ppr: 50 }), linkedPlayer('pl_b', BOB)]);
    expect(pprOf(order, 'pl_a')).toBe(50);
    expect(order.input.strengthBasis!.players.pl_a.origin).toBe('manual');
  });

  it('a hand-made player is untouched', () => {
    const intel = buildIntel({ roster: ROSTER, stats: [], history: [previous()] });
    const handMade: Player = { ...linkedPlayer('pl_h', ALICE), n01: undefined, ppr: 47, name: 'Hand' };
    const order = orderFor(intel, [handMade, linkedPlayer('pl_b', BOB)]);
    expect(pprOf(order, 'pl_h')).toBe(47);
  });

  it('with no history lines at all, the last synced value is kept at low confidence', () => {
    // The history requests failed and this season's stats were unavailable: the sync kept
    // the PPR it had stored. That is the number to use, not the league mean and not 0.
    const intel = buildIntel({ roster: ROSTER, stats: [], history: [] });
    const order = orderFor(intel, [linkedPlayer('pl_a', ALICE, { statsPpr: 55, legs: 40 }), linkedPlayer('pl_b', BOB)]);
    expect(pprOf(order, 'pl_a')).toBe(55);
    expect(order.input.strengthBasis!.players.pl_a).toMatchObject({ origin: 'carried', confidence: 'LOW' });
  });

  it('without any analysis the ordinary effective PPR is used, as before', () => {
    const order = orderFor(null, [linkedPlayer('pl_a', ALICE, { statsPpr: 55, legs: 40 }), linkedPlayer('pl_b', BOB)]);
    expect(pprOf(order, 'pl_a')).toBe(55);
    expect(pprOf(order, 'pl_b')).toBeNull();
  });

  it('the generated order scores the history: strength uses PPR, the unknown player is imputed', () => {
    const intel = buildIntel({ roster: ROSTER, stats: [], history: [previous()] });
    const order = orderFor(intel, [linkedPlayer('pl_a', ALICE), linkedPlayer('pl_b', BOB), linkedPlayer('pl_c', CAROL)]);
    const result = generateOrder(order.input, { singleCandidate: true, timeLimitMs: 2000 });
    expect(result.ok).toBe(true);
    const solution = result.candidates[0];
    expect(solution.metrics.strengthWeights!.ppr).toBeGreaterThan(0);
    const tally = (id: string) => solution.tallies.find((entry) => entry.playerId === id)!;
    expect(tally('pl_a').effectivePpr!).toBeGreaterThan(tally('pl_b').effectivePpr!);
    expect(tally('pl_c').pprImputed).toBe(true);
    expect(tally('pl_c').effectivePpr).not.toBe(0);
  });

  it('agrees with the opponent-aware path about our own players', () => {
    const intel = buildIntel({
      roster: ROSTER,
      stats: [row('op_a', 'a1', 'Alice', 52, 240)],
      history: [previous()],
      withOpponent: true,
      opponentRoster: [rosterPlayer('op_x', 'x1', 'X', 'T2'), rosterPlayer('op_y', 'y1', 'Y', 'T2')],
    });
    const order = orderFor(intel, [linkedPlayer('pl_a', ALICE, { statsPpr: 52, legs: 10 }), linkedPlayer('pl_b', BOB)]);
    expect(order.opponentAvailable).toBe(true);
    const used = pprOf(order, 'pl_a')!;
    expect(used).not.toBeNull();
    expect(order.input.opponent!.players.pl_a.strength).toBeCloseTo(used, 1);
  });
});
