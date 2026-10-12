import { describe, expect, it } from 'vitest';
import type { GameSlotDef } from '../types';
import {
  cachedVisitDistribution,
  clearRaceCache,
  legRace,
  normalCdf,
  raceHorizon,
  visitDistribution,
  type RaceMember,
} from './raceModel';
import { FINISH_RATE_MAX, FINISH_RATE_MIN, estimateFinish, finishPrior, partialFinish, priorFinish } from './finishing';
import {
  APTITUDE_PPR_PER_LEVEL,
  ROLE_DELTA_CAP,
  ROLE_PRIOR_LEGS,
  aptitudeDelta,
  estimateRole,
  roleKeyOf,
  type RoleEvidence,
} from './roleStrength';
import {
  ORDER_EFFECT_CAP,
  ORDER_MIN_GAIN,
  decideThrowOrder,
  orderEffect,
  orderedGameWin,
  permutationsWithFixed,
  type DecisionInput,
} from './throwOrder';
import { expectedGameWin, type OpponentGameContext } from './opponentContext';

const member = (mu: number, finish = finishPrior(mu)): RaceMember => ({ mu, finish });

function game(numPart: number, sides: OpponentGameContext['sides'], extra: Partial<OpponentGameContext> = {}): OpponentGameContext {
  return {
    gameId: 'g',
    signature: 'DOUBLES|01|1',
    numPart,
    legsToWin: 2,
    cricket: false,
    sides,
    likely: [],
    samples: 8,
    confidence: 'HIGH',
    startScore: 501,
    ...extra,
  };
}

describe('01 race model', () => {
  it('the normal CDF is accurate to 1e-7', () => {
    expect(normalCdf(0)).toBeCloseTo(0.5, 7);
    expect(normalCdf(1.96)).toBeCloseTo(0.9750021, 6);
    expect(normalCdf(-1)).toBeCloseTo(0.1586553, 6);
    expect(normalCdf(Infinity)).toBe(1);
    expect(normalCdf(-Infinity)).toBe(0);
  });

  it('the visit distribution is a probability distribution (tail included)', () => {
    for (const members of [[member(50)], [member(60), member(40)], [member(45), member(55), member(70)]]) {
      const dist = visitDistribution(members, 501);
      const total = dist.reduce((acc, p) => acc + p, 0);
      expect(total).toBeCloseTo(1, 9);
      expect(dist[0]).toBe(0);
      // A finished leg needs a few visits; the tail beyond the horizon is negligible.
      expect(dist[dist.length - 1]).toBeLessThan(1e-4);
    }
  });

  it('a stronger side needs fewer visits on average', () => {
    const mean = (dist: Float64Array) => dist.reduce((acc, p, t) => acc + (t <= dist.length - 2 ? p * t : 0), 0);
    expect(mean(visitDistribution([member(60), member(60)], 501))).toBeLessThan(mean(visitDistribution([member(45), member(45)], 501)));
  });

  it('equal sides split a leg; throwing first is an advantage', () => {
    const a = visitDistribution([member(50), member(50)], 501);
    const race = legRace(a, a);
    expect(race.average).toBeCloseTo(0.5, 9);
    expect(race.first).toBeGreaterThan(race.second);
    expect(race.first + race.second).toBeCloseTo(1, 9);
  });

  it('the cache changes nothing', () => {
    const members = [member(58), member(43)];
    clearRaceCache();
    const miss = cachedVisitDistribution(members, 701);
    const hit = cachedVisitDistribution(members, 701);
    expect(hit).toBe(miss);
    expect([...miss]).toEqual([...visitDistribution(members, 701, raceHorizon(701))]);
  });
});

describe('order effect (PPR points)', () => {
  it('is zero for members of equal strength and finishing, and for single players', () => {
    expect(orderEffect([member(50), member(50)], [member(50), member(50)], 501)).toBeCloseTo(0, 9);
    expect(orderEffect([member(60)], [member(40)], 501)).toBe(0);
  });

  it('the stronger player first is worth more than the reverse, and is positive against no order', () => {
    const opponent = [member(50), member(50)];
    const strongFirst = orderEffect([member(62), member(42)], opponent, 501);
    const weakFirst = orderEffect([member(42), member(62)], opponent, 501);
    expect(strongFirst).toBeGreaterThan(0);
    expect(strongFirst).toBeGreaterThan(weakFirst);
  });

  it('the opponent ordering their strong player first lowers our estimate', () => {
    const ours = [member(52), member(48)];
    const theirsStrongFirst = orderEffect(ours, [member(62), member(42)], 501);
    const theirsWeakFirst = orderEffect(ours, [member(42), member(62)], 501);
    expect(theirsStrongFirst).toBeLessThan(theirsWeakFirst);
  });

  it('is only the order: averaged over our orders it is zero, so what the members do in any order is not credited', () => {
    // A fast and a slow finisher against average finishers: the race favours this pair in either
    // order, which is the members' make-up, not their order.
    const flatOpponent = [member(50, 0.3), member(50, 0.3)];
    const ab = orderEffect([member(50, 0.6), member(50, 0.1)], flatOpponent, 501);
    const ba = orderEffect([member(50, 0.1), member(50, 0.6)], flatOpponent, 501);
    expect(ab + ba).toBeCloseTo(0, 9);
    const trio = [member(60, 0.4), member(52, 0.2), member(45, 0.3)];
    const orders = [
      [0, 1, 2],
      [0, 2, 1],
      [1, 0, 2],
      [1, 2, 0],
      [2, 0, 1],
      [2, 1, 0],
    ].map((order) => orderEffect(order.map((index) => trio[index]), [member(52), member(52), member(52)], 701));
    expect(orders.reduce((a, b) => a + b, 0)).toBeCloseTo(0, 9);
  });

  it('is capped', () => {
    const effect = orderEffect([member(110, 0.7), member(10, 0.08)], [member(60), member(60)], 301);
    expect(Math.abs(effect)).toBeLessThanOrEqual(ORDER_EFFECT_CAP);
  });

  it('sides of more than four (order not modelled) are exactly the order-free estimate: no one-sided order bonus', () => {
    const team = game(5, [{ strength: 50, probability: 1 }], { startScore: 1001 });
    const strengths = [60, 55, 50, 45, 40];
    const options = { startScore: 1001, discipline: 'STEEL' as const };
    const strongFirst = orderedGameWin({ strengths, finish: strengths.map((s) => finishPrior(s)), pairBonus: 0 }, team, options);
    const weakFirst = orderedGameWin({ strengths: [...strengths].reverse(), finish: [...strengths].reverse().map((s) => finishPrior(s)), pairBonus: 0 }, team, options);
    expect(strongFirst).toBe(expectedGameWin(50, team));
    expect(weakFirst).toBe(strongFirst);
  });

  it('Singles and Cricket are exactly the order-free estimate', () => {
    const singles = game(1, [{ strength: 55, probability: 1 }]);
    expect(orderedGameWin({ strengths: [50], finish: [0.3], pairBonus: 0 }, singles, { startScore: 501, discipline: 'STEEL' })).toBe(expectedGameWin(50, singles));
    const cricket = game(2, [{ strength: 52, probability: 1, members: [{ strength: 60, finish: 0.3 }, { strength: 44, finish: 0.3 }] }], { cricket: true });
    expect(orderedGameWin({ strengths: [62, 40], finish: [0.3, 0.3], pairBonus: 0 }, cricket, { startScore: 501, discipline: 'STEEL' })).toBe(
      expectedGameWin(51, cricket),
    );
  });

  it('the same members in another order are another estimate (multi-player 01)', () => {
    const doubles = game(2, [{ strength: 50, probability: 1, members: [{ strength: 50, finish: 0.3 }, { strength: 50, finish: 0.3 }] }]);
    const options = { startScore: 501, discipline: 'STEEL' as const };
    const ab = orderedGameWin({ strengths: [62, 42], finish: [finishPrior(62), finishPrior(42)], pairBonus: 0 }, doubles, options);
    const ba = orderedGameWin({ strengths: [42, 62], finish: [finishPrior(42), finishPrior(62)], pairBonus: 0 }, doubles, options);
    expect(ab).not.toBeCloseTo(ba, 6);
    expect(ab).toBeGreaterThan(ba);
  });
});

describe('finishing estimate', () => {
  it('without First 9 evidence it is the prior, at LOW confidence', () => {
    expect(estimateFinish(55, null, 80)).toEqual(priorFinish(55));
    expect(estimateFinish(55, 3, 0).source).toBe('prior');
    expect(priorFinish(55).confidence).toBe('LOW');
  });

  it('a First 9 well above the rest of the leg lowers the finishing rate, and the reverse raises it', () => {
    const prior = finishPrior(55);
    const slow = estimateFinish(55, 6, 60);
    const fast = estimateFinish(55, -6, 60);
    expect(slow.rate).toBeLessThan(prior);
    expect(fast.rate).toBeGreaterThan(prior);
    expect(slow.confidence).toBe('HIGH');
    expect(estimateFinish(55, 6, 20).confidence).toBe('MEDIUM');
    expect(estimateFinish(55, 6, 5).confidence).toBe('LOW');
  });

  it('PPR alone moves the prior only mildly, and the rate stays inside its bounds', () => {
    expect(finishPrior(80) - finishPrior(40)).toBeLessThan(0.2);
    expect(estimateFinish(50, 100, 100).rate).toBe(FINISH_RATE_MIN);
    expect(estimateFinish(50, -100, 100).rate).toBe(FINISH_RATE_MAX);
    expect(finishPrior(50, 'SOFT')).toBeGreaterThan(finishPrior(50, 'STEEL'));
  });

  it('partial evidence sits between the prior and the full estimate', () => {
    const full = estimateFinish(55, 6, 60);
    const half = partialFinish(full, 0.5);
    expect(half).toBeLessThan(full.prior);
    expect(half).toBeGreaterThan(full.rate);
    expect(partialFinish(full, 0)).toBeCloseTo(full.prior, 12);
    expect(partialFinish(full, 1)).toBeCloseTo(full.rate, 12);
  });
});

describe('role strength', () => {
  const doubles01: Pick<GameSlotDef, 'kinds' | 'playerCount'> = { kinds: ['DOUBLES', 'G501'], playerCount: 2 };
  const singles01: Pick<GameSlotDef, 'kinds' | 'playerCount'> = { kinds: ['SINGLES', 'G501'], playerCount: 1 };
  const trios01: Pick<GameSlotDef, 'kinds' | 'playerCount'> = { kinds: ['TRIOS', 'G501'], playerCount: 3 };
  const gallon: Pick<GameSlotDef, 'kinds' | 'playerCount'> = { kinds: ['TEAM', 'G501'], playerCount: 4 };

  it('maps games to roles (Team and Gallon share one)', () => {
    expect(roleKeyOf(doubles01)).toBe('DOUBLES|01');
    expect(roleKeyOf({ kinds: ['DOUBLES', 'CRICKET'], playerCount: 2 })).toBe('DOUBLES|CRICKET');
    expect(roleKeyOf(gallon)).toBe('GALLON|01');
    expect(roleKeyOf({ kinds: ['GALLON'], playerCount: 4 })).toBe('GALLON|OTHER');
  });

  it('no data at all: Δ = 0 and the role strength is the base strength (never 0)', () => {
    const entry = estimateRole(undefined, 'DOUBLES|01', null, 'MEDIUM');
    expect(entry).toMatchObject({ delta: 0, source: 'base', confidence: 'MEDIUM', games: 0 });
  });

  it('aptitude is the next fallback, at LOW confidence', () => {
    expect(aptitudeDelta({ skills: { DOUBLES: 5 } }, doubles01)).toBe(2 * APTITUDE_PPR_PER_LEVEL);
    expect(aptitudeDelta({ skills: { DOUBLES: 5, G501: 3 } }, doubles01)).toBe(1 * APTITUDE_PPR_PER_LEVEL);
    expect(aptitudeDelta({ skills: {} }, doubles01)).toBeNull();
    expect(aptitudeDelta({ skills: { DOUBLES: 1 } }, gallon)).toBeNull();
    const entry = estimateRole(undefined, 'DOUBLES|01', 2, 'HIGH');
    expect(entry).toMatchObject({ delta: 2, source: 'aptitude', confidence: 'LOW' });
  });

  it('n01 evidence in the role is a shrunk mean: (Σw·r + K·parent) / (Σw + K)', () => {
    const evidence: RoleEvidence = { 'DOUBLES|01': { games: 10, weight: 30, sum: 30 * 4 } };
    const entry = estimateRole(evidence, 'DOUBLES|01', null, 'HIGH');
    expect(entry.delta).toBeCloseTo((30 * 4) / (30 + ROLE_PRIOR_LEGS), 9);
    expect(entry).toMatchObject({ source: 'n01-role', games: 10, confidence: 'MEDIUM' });
  });

  it('a role never played is shrunk towards the nearest roles (Trios ← Doubles / Gallon), at lower confidence', () => {
    const evidence: RoleEvidence = { 'DOUBLES|01': { games: 20, weight: 60, sum: 60 * 3 } };
    const trios = estimateRole(evidence, 'TRIOS|01', null, 'HIGH');
    expect(trios.source).toBe('n01-near');
    expect(trios.delta).toBeCloseTo((60 * 3) / (60 + ROLE_PRIOR_LEGS), 9);
    expect(trios.confidence).toBe('MEDIUM');
    // Singles have no "near" multi-player role: they fall back to the base.
    expect(estimateRole(evidence, 'SINGLES|01', null, 'HIGH').source).toBe('base');
    expect(roleKeyOf(trios01)).toBe('TRIOS|01');
    expect(roleKeyOf(singles01)).toBe('SINGLES|01');
  });

  it('Cricket is shrunk twice as hard and one confidence level lower', () => {
    const evidence: RoleEvidence = { 'DOUBLES|CRICKET': { games: 20, weight: 60, sum: 60 * 3 } };
    const entry = estimateRole(evidence, 'DOUBLES|CRICKET', null, 'HIGH');
    expect(entry.delta).toBeCloseTo((60 * 3) / (60 + 2 * ROLE_PRIOR_LEGS), 9);
    expect(entry.confidence).toBe('MEDIUM');
  });

  it('is capped, and never more confident than the base data', () => {
    const evidence: RoleEvidence = { 'SINGLES|01': { games: 100, weight: 1000, sum: 1000 * 40 } };
    const entry = estimateRole(evidence, 'SINGLES|01', null, 'LOW');
    expect(entry.delta).toBe(ROLE_DELTA_CAP);
    expect(entry.confidence).toBe('LOW');
  });
});

describe('throw-order decision (guardrails)', () => {
  const base = (overrides: Partial<DecisionInput>): DecisionInput => ({
    strongOrder: [0, 1],
    options: [
      { order: [0, 1], probability: 0.5 },
      { order: [1, 0], probability: 0.53 },
    ],
    confidence: 'HIGH',
    opponentOrderKnown: true,
    orderData: true,
    robustGain: () => 0.01,
    ...overrides,
  });

  it('adopts another order when it is ≥ 2 points better on MEDIUM/HIGH data with every guardrail met', () => {
    const decision = decideThrowOrder(base({}));
    expect(decision).toMatchObject({ order: [1, 0], adopted: 'model', fallback: null });
    expect(decision.gain).toBeCloseTo(0.03, 12);
    expect(decideThrowOrder(base({ confidence: 'MEDIUM' })).adopted).toBe('model');
  });

  it('the 2-point boundary: exactly 2 points qualifies, just under does not', () => {
    const at = decideThrowOrder(base({ options: [{ order: [0, 1], probability: 0.5 }, { order: [1, 0], probability: 0.5 + ORDER_MIN_GAIN }] }));
    expect(at.adopted).toBe('model');
    const under = decideThrowOrder(base({ options: [{ order: [0, 1], probability: 0.5 }, { order: [1, 0], probability: 0.5 + 0.0199 }] }));
    expect(under).toMatchObject({ adopted: 'strong', order: [0, 1], fallback: 'small-gain' });
    expect(under.bestGain).toBeCloseTo(0.0199, 12);
  });

  it('keeps the strong order on LOW confidence, however large the estimated gain', () => {
    const decision = decideThrowOrder(base({ confidence: 'LOW', options: [{ order: [0, 1], probability: 0.4 }, { order: [1, 0], probability: 0.6 }] }));
    expect(decision).toMatchObject({ adopted: 'strong', order: [0, 1], fallback: 'low-confidence' });
  });

  it('keeps the strong order when the opponent order is unknown, the order data is missing, or the result is unstable', () => {
    expect(decideThrowOrder(base({ opponentOrderKnown: false })).fallback).toBe('opponent-order-unknown');
    expect(decideThrowOrder(base({ orderData: false })).fallback).toBe('no-order-data');
    expect(decideThrowOrder(base({ robustGain: () => 0 })).fallback).toBe('unstable');
    expect(decideThrowOrder(base({ robustGain: () => -0.01 })).order).toEqual([0, 1]);
  });

  it('keeps the strong order when it is the best one, and on ties', () => {
    expect(decideThrowOrder(base({ options: [{ order: [0, 1], probability: 0.55 }, { order: [1, 0], probability: 0.5 }] }))).toMatchObject({
      adopted: 'strong',
      fallback: null,
    });
    expect(decideThrowOrder(base({ options: [{ order: [1, 0], probability: 0.5 }, { order: [0, 1], probability: 0.5 }] })).order).toEqual([0, 1]);
  });

  it('without an estimate for the strong order it is kept and says so', () => {
    expect(decideThrowOrder(base({ options: [] }))).toMatchObject({ adopted: 'strong', fallback: 'no-model', probability: null });
  });

  it('enumerates every order that keeps the locked positions', () => {
    expect(permutationsWithFixed([3, 5], [undefined, undefined])).toEqual([
      [3, 5],
      [5, 3],
    ]);
    expect(permutationsWithFixed([1, 2, 3], [undefined, 2, undefined])).toEqual([
      [1, 2, 3],
      [3, 2, 1],
    ]);
    expect(permutationsWithFixed([1, 2, 3, 4], [undefined, undefined, undefined, undefined])).toHaveLength(24);
  });
});
