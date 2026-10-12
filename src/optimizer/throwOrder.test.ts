import { describe, expect, it } from 'vitest';
import type { GameSlotDef, OrderInput, Player } from '../domain/types';
import type {
  OpponentContext,
  OpponentGameContext,
  OpponentOrderInfo,
  OpponentSideMember,
  OurPlayerContext,
} from '../domain/prediction/opponentContext';
import { finishPrior } from '../domain/prediction/finishing';
import { THROW_ORDER_MODEL_VERSION } from '../domain/prediction/throwOrder';
import type { RoleStrengthContext } from '../domain/prediction/roleStrength';
import { predictOrder, predictionOptionsOf } from '../domain/prediction/predictOrder';
import { independentGamesModel } from '../domain/prediction/matchWinProbability';
import { describeThrowOrder } from '../domain/orders/throwOrderText';
import { createParticipantConfig } from '../domain/orders/participants';
import { orderInput, player } from '../test/factories';
import { evaluateManualOrder, generateOrder } from './generateOrder';
import { prepare } from './prepare';
import { describeCombo, selectionSignature } from './candidates/combinations';
import { createUndoable, undoableReducer } from '../state/orderSession';

/**
 * Throw order inside multi-player games (docs/THROW_ORDER_MODEL.md), end to end through the
 * optimizer: the strong order is the rule, an estimate overrules it only through the guardrails,
 * and nothing about it depends on internal ids.
 */

const HIGH_ORDER: OpponentOrderInfo = { known: true, confidence: 'HIGH', samples: 8, leaders: [{ name: '相手A', probability: 0.8 }] };

function ours(strength: number, extra: Partial<OurPlayerContext> = {}): OurPlayerContext {
  return { strength, confidence: 'HIGH', legs: 60, imputed: false, formAdjustment: 0, first9Adjustment: 0, first9Excess: null, ...extra };
}

function side(members: OpponentSideMember[], probability = 1) {
  return { strength: members.reduce((acc, m) => acc + m.strength, 0) / members.length, probability, members };
}

function context(players: Record<string, OurPlayerContext>, games: Record<string, Partial<OpponentGameContext> & Pick<OpponentGameContext, 'sides' | 'numPart'>>): OpponentContext {
  return {
    version: 2,
    generatedAt: 0,
    matchId: 'm1',
    matchDate: '2026-10-20',
    opponentName: '相手チーム',
    leagueMeanPpr: 50,
    players,
    games: Object.fromEntries(
      Object.entries(games).map(([gameId, game]) => [
        gameId,
        {
          gameId,
          signature: 'X|01|1',
          legsToWin: 3,
          cricket: false,
          likely: [],
          samples: 8,
          confidence: 'HIGH',
          ...game,
        } as OpponentGameContext,
      ]),
    ),
    orderConfidence: 'HIGH',
    confidence: 'HIGH',
    discipline: 'STEEL',
  };
}

function trios(id = 'tr'): GameSlotDef {
  return {
    id,
    order: 1,
    name: 'Trios 701',
    kinds: ['TRIOS', 'G501'],
    playerCount: 3,
    n01: { schid: id, numPart: 3, matchType: '01', startScore: 701, limitLegCount: 3, group: null, subtitle: null },
  };
}

function withModel(input: OrderInput, opponent: OpponentContext, extra: Partial<OrderInput> = {}): OrderInput {
  return { ...input, opponent, throwOrderModel: THROW_ORDER_MODEL_VERSION, discipline: 'STEEL', ...extra };
}

function names(input: OrderInput, ids: readonly string[]): string[] {
  const byId = new Map(input.players.map((p) => [p.id, p.name]));
  return ids.map((id) => byId.get(id) ?? id);
}

/**
 * A trio whose members differ sharply in finishing (First 9 evidence on 60 legs) against an
 * opponent with a fast finisher (see docs/THROW_ORDER_MODEL.md §8 for how such cases were found).
 */
const TRIO = {
  players: [
    { id: 'p1', name: 'エース', strength: 65, excess: -3 },
    { id: 'p2', name: 'セカンド', strength: 55, excess: -7 },
    { id: 'p3', name: 'スコアラー', strength: 60, excess: 14 },
  ],
  opponent: [
    { strength: 65, finish: 0.7 },
    { strength: 51, finish: 0.1261 },
    { strength: 62, finish: 0.2737 },
  ],
};

function trioCase(options: { reverseOpponent?: boolean; order?: Partial<OpponentOrderInfo>; gameConfidence?: OpponentGameContext['confidence']; excess?: boolean; locks?: OrderInput['locks'] } = {}) {
  const roster = TRIO.players.map((spec) => player({ id: spec.id, name: spec.name, ppr: spec.strength }));
  const opponentMembers = options.reverseOpponent ? [...TRIO.opponent].reverse() : TRIO.opponent;
  const opponent = context(
    Object.fromEntries(TRIO.players.map((spec) => [spec.id, ours(spec.strength, { first9Excess: options.excess === false ? null : spec.excess })])),
    {
      tr: {
        numPart: 3,
        sides: [side(opponentMembers)],
        startScore: 701,
        order: { ...HIGH_ORDER, ...options.order },
        confidence: options.gameConfidence ?? 'HIGH',
      },
    },
  );
  return withModel(orderInput(roster, [trios()], { preset: 'OPPONENT_OPTIMIZED', locks: options.locks ?? [] }), opponent);
}

function only(input: OrderInput) {
  const result = generateOrder(input, { singleCandidate: true, timeLimitMs: 4000 });
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error('no order');
  return result.candidates[0];
}

describe('throw order: the strong order is the rule', () => {
  it('[2] without order data the strongest player in the game throws first (role strength, not the id)', () => {
    const input = trioCase({ excess: false });
    const solution = only(input);
    expect(names(input, solution.assignments[0].playerIds)).toEqual(['エース', 'スコアラー', 'セカンド']);
    const record = solution.throwOrder![0];
    expect(record.adopted).toBe('strong');
    expect(record.strongOrder).toEqual(solution.assignments[0].playerIds);
  });

  it('[2] the ranking is the strength in this game\'s role: an aptitude for Doubles lifts a player there only', () => {
    const a = player({ id: 'a', name: 'シングルス型', ppr: 50 });
    const b = player({ id: 'b', name: 'ダブルス型', ppr: 49, skills: { DOUBLES: 5 } });
    const games: GameSlotDef[] = [
      { id: 'd', order: 1, name: 'Doubles 501', kinds: ['DOUBLES', 'G501'], playerCount: 2 },
      { id: 't', order: 2, name: 'Trios 701', kinds: ['TRIOS', 'G501'], playerCount: 2 },
    ];
    const input = orderInput([a, b], games, { preset: 'WIN_FIRST' });
    const solution = only(input);
    const doubles = solution.assignments.find((entry) => entry.gameId === 'd')!;
    const other = solution.assignments.find((entry) => entry.gameId === 't')!;
    expect(names(input, doubles.playerIds)).toEqual(['ダブルス型', 'シングルス型']);
    expect(names(input, other.playerIds)).toEqual(['シングルス型', 'ダブルス型']);
    expect(solution.throwOrder!.find((r) => r.gameId === 'd')!.basis[0].source).toBe('aptitude');
  });

  it('[1] swapping internal ids between players changes nothing about who throws first', () => {
    const build = (swap: boolean): OrderInput => {
      const idOf = (id: string): string => (swap ? ({ p1: 'p3', p3: 'p1' } as Record<string, string>)[id] ?? id : id);
      const roster = TRIO.players.map((spec) => player({ id: idOf(spec.id), name: spec.name, ppr: spec.strength }));
      const opponent = context(
        Object.fromEntries(TRIO.players.map((spec) => [idOf(spec.id), ours(spec.strength)])),
        { tr: { numPart: 3, sides: [side(TRIO.opponent)], startScore: 701, order: HIGH_ORDER } },
      );
      return withModel(orderInput(roster, [trios()], { preset: 'OPPONENT_OPTIMIZED' }), opponent);
    };
    const plain = build(false);
    const swapped = build(true);
    expect(names(plain, only(plain).assignments[0].playerIds)).toEqual(names(swapped, only(swapped).assignments[0].playerIds));
    // Also without opponent data (ranking by PPR).
    const noOpponent = (swap: boolean): OrderInput => {
      const input = build(swap);
      return { ...input, opponent: undefined, preset: 'WIN_FIRST' };
    };
    expect(names(noOpponent(false), only(noOpponent(false)).assignments[0].playerIds)).toEqual(
      names(noOpponent(true), only(noOpponent(true)).assignments[0].playerIds),
    );
  });

  it('[1] players whose data is identical are told apart by name, never by id first', () => {
    const roster = (ids: [string, string]): Player[] => [player({ id: ids[0], name: 'Bさん', ppr: 50 }), player({ id: ids[1], name: 'Aさん', ppr: 50 })];
    const games: GameSlotDef[] = [{ id: 'd', order: 1, name: 'Doubles', kinds: ['DOUBLES', 'G501'], playerCount: 2 }];
    for (const ids of [['x1', 'x2'], ['x2', 'x1']] as [string, string][]) {
      const input = orderInput(roster(ids), games, { preset: 'WIN_FIRST' });
      expect(names(input, only(input).assignments[0].playerIds)).toEqual(['Aさん', 'Bさん']);
    }
  });
});

describe('throw order: the guardrails', () => {
  it('[5] another order is adopted when it is ≥ 2 points better on MEDIUM or HIGH data, and the screen says why', () => {
    for (const gameConfidence of ['HIGH', 'MEDIUM'] as const) {
      const input = trioCase({ reverseOpponent: true, gameConfidence });
      const solution = only(input);
      const record = solution.throwOrder![0];
      expect(record.adopted).toBe('model');
      expect(record.probability! - record.strongProbability!).toBeGreaterThanOrEqual(0.02);
      expect(names(input, record.strongOrder)).toEqual(['エース', 'スコアラー', 'セカンド']);
      expect(names(input, solution.assignments[0].playerIds)).toEqual(['スコアラー', 'エース', 'セカンド']);
      const text = describeThrowOrder(record, (id) => names(input, [id])[0]);
      expect(text.deviates).toBe(true);
      expect(text.detail).toContain('通常 (強い順) なら エース → スコアラー → セカンド');
      expect(text.detail).toMatch(/推定ゲーム勝率が \+\d+\.\dpt 高い/);
      expect(text.detail).toContain('信頼度');
      expect(text.detail).toContain('利用した相手の傾向');
      expect(text.detail).not.toMatch(/確実|必勝/);
    }
  });

  it('[3] on LOW-confidence data the strong order stays, however large the estimate', () => {
    const solution = only(trioCase({ reverseOpponent: true, gameConfidence: 'LOW' }));
    expect(solution.throwOrder![0]).toMatchObject({ adopted: 'strong', fallback: 'low-confidence' });
    expect(solution.throwOrder![0].bestGain!).toBeGreaterThanOrEqual(0.02);
  });

  it('[10] an opponent order that is not known is never treated as known', () => {
    const solution = only(trioCase({ reverseOpponent: true, order: { known: false, confidence: 'LOW' } }));
    expect(solution.throwOrder![0]).toMatchObject({ adopted: 'strong', fallback: 'opponent-order-unknown' });
    const input = trioCase({ reverseOpponent: true, order: { known: false, confidence: 'LOW' } });
    const prediction = predictOrder(input.opponent!, solution.assignments, [], independentGamesModel, predictionOptionsOf(input))!;
    expect(prediction.games[0].reasons).toContain('相手の投順は不明 (全順を同等と仮定)');
  });

  it('[9] with enough evidence, a change in the opponent\'s expected order changes ours', () => {
    const before = only(trioCase());
    const after = only(trioCase({ reverseOpponent: true }));
    expect(before.throwOrder![0].adopted).toBe('strong');
    expect(after.throwOrder![0].adopted).toBe('model');
    expect(before.assignments[0].playerIds).not.toEqual(after.assignments[0].playerIds);
  });

  it('[3] without order evidence (no First 9 data) the strong order stays', () => {
    const solution = only(trioCase({ reverseOpponent: true, excess: false }));
    expect(solution.throwOrder![0].adopted).toBe('strong');
  });

  it('[11] a locked slot keeps its player: neither the rule nor the estimate moves it', () => {
    const input = trioCase({ reverseOpponent: true, locks: [{ gameId: 'tr', slotIndex: 0, playerId: 'p2' }] });
    const solution = only(input);
    expect(solution.assignments[0].playerIds[0]).toBe('p2');
    const unlockedStrongFirst = only(trioCase({ locks: [{ gameId: 'tr', slotIndex: 2, playerId: 'p1' }] }));
    expect(unlockedStrongFirst.assignments[0].playerIds[2]).toBe('p1');
  });

  it('Cricket keeps the strong order and says why', () => {
    const roster = TRIO.players.map((spec) => player({ id: spec.id, name: spec.name, ppr: spec.strength }));
    const game: GameSlotDef = { ...trios(), kinds: ['TRIOS', 'CRICKET'] };
    const opponent = context(Object.fromEntries(TRIO.players.map((spec) => [spec.id, ours(spec.strength, { first9Excess: spec.excess })])), {
      tr: { numPart: 3, sides: [side([...TRIO.opponent].reverse())], startScore: 701, order: HIGH_ORDER, cricket: true },
    });
    const solution = only(withModel(orderInput(roster, [game], { preset: 'OPPONENT_OPTIMIZED' }), opponent));
    expect(solution.throwOrder![0]).toMatchObject({ adopted: 'strong', fallback: 'cricket' });
  });
});

describe('throw order: candidates, roles and manual edits', () => {
  it('[8] the same members in another order are another candidate with another estimate', () => {
    const input = trioCase({ reverseOpponent: true });
    const ctx = prepare(input);
    const members = [0, 1, 2];
    const a = describeCombo(ctx, 0, members, [0, 2, 1]);
    const b = describeCombo(ctx, 0, members, [2, 0, 1]);
    expect(selectionSignature(ctx, [a])).not.toBe(selectionSignature(ctx, [b]));
    expect(a.oppWin).not.toBeCloseTo(b.oppWin, 6);
    const pa = evaluateManualOrder(input, [{ gameId: 'tr', playerIds: ['p1', 'p3', 'p2'] }]).solution!.prediction!;
    const pb = evaluateManualOrder(input, [{ gameId: 'tr', playerIds: ['p3', 'p1', 'p2'] }]).solution!.prediction!;
    expect(pa.games[0].probability).toBeCloseTo(a.oppWin, 12);
    expect(pb.games[0].probability).toBeCloseTo(b.oppWin, 12);
  });

  it('the estimate shown is the number the optimizer optimised', () => {
    const input = trioCase({ reverseOpponent: true });
    const solution = only(input);
    const ctx = prepare(input);
    const chosen = solution.assignments[0].playerIds.map((id) => ctx.playerIndex.get(id)!);
    const combo = describeCombo(ctx, 0, [...chosen].sort((x, y) => x - y));
    expect(solution.prediction!.games[0].probability).toBeCloseTo(combo.oppWin, 12);
    expect(solution.throwOrder![0].probability).toBeCloseTo(combo.oppWin, 12);
  });

  it('[7] a Singles player and a Doubles player are placed by their strength in each role', () => {
    const roster = [player({ id: 's', name: 'シングルス型', ppr: 55 }), player({ id: 'd', name: 'ダブルス型', ppr: 55 }), player({ id: 'x', name: '控え', ppr: 50 })];
    const games: GameSlotDef[] = [
      { id: 'g1', order: 1, name: 'Singles 501', kinds: ['SINGLES', 'G501'], playerCount: 1 },
      { id: 'g2', order: 2, name: 'Doubles 501', kinds: ['DOUBLES', 'G501'], playerCount: 2 },
    ];
    const opponent = context(
      { s: ours(55), d: ours(55), x: ours(50) },
      {
        g1: { numPart: 1, sides: [{ strength: 55, probability: 1 }], legsToWin: 2 },
        g2: { numPart: 2, sides: [side([{ strength: 55, finish: finishPrior(55) }, { strength: 55, finish: finishPrior(55) }])], legsToWin: 2, order: HIGH_ORDER },
      },
    );
    const roles = (singles: string, doubles: string): RoleStrengthContext => ({
      version: 1,
      generatedAt: 0,
      source: 'n01',
      gamesObserved: 40,
      before: '2026-10-20',
      players: {
        [singles]: { evidence: { 'SINGLES|01': { games: 20, weight: 60, sum: 60 * 6 }, 'DOUBLES|01': { games: 20, weight: 60, sum: -60 * 6 } } },
        [doubles]: { evidence: { 'SINGLES|01': { games: 20, weight: 60, sum: -60 * 6 }, 'DOUBLES|01': { games: 20, weight: 60, sum: 60 * 6 } } },
      },
    });
    const run = (singles: string, doubles: string) => {
      const input = withModel(orderInput(roster, games, { preset: 'OPPONENT_OPTIMIZED' }), opponent, { roleStrength: roles(singles, doubles) });
      const solution = only(input);
      return {
        singles: names(input, solution.assignments.find((a) => a.gameId === 'g1')!.playerIds),
        doubles: names(input, solution.assignments.find((a) => a.gameId === 'g2')!.playerIds),
      };
    };
    expect(run('s', 'd')).toEqual({ singles: ['シングルス型'], doubles: ['ダブルス型', '控え'] });
    // The same two players with the evidence swapped swap roles.
    expect(run('d', 's')).toEqual({ singles: ['ダブルス型'], doubles: ['シングルス型', '控え'] });
  });

  it('[12] a hand-made change of the order is re-estimated at once (game and match)', () => {
    const input = { ...trioCase({ reverseOpponent: true }), participants: TRIO.players.map((spec) => createParticipantConfig(spec.id)) };
    const solution = only(input);
    let session = createUndoable(input);
    session = undoableReducer(session, { type: 'generated', candidates: [solution] });
    const before = session.present.current!.prediction!;
    // 2投目 ↔ 3投目: neither the strong order nor the estimate's choice.
    session = undoableReducer(session, { type: 'swapSlots', from: { gameId: 'tr', slotIndex: 1 }, to: { gameId: 'tr', slotIndex: 2 } });
    const edited = session.present.current!;
    expect(edited.assignments[0].playerIds).toEqual([solution.assignments[0].playerIds[0], solution.assignments[0].playerIds[2], solution.assignments[0].playerIds[1]]);
    expect(edited.prediction!.games[0].probability).not.toBeCloseTo(before.games[0].probability, 6);
    expect(edited.prediction!.win).not.toBeCloseTo(before.win, 6);
    expect(edited.throwOrder![0].adopted).toBe('manual');
    expect(session.present.violations).toEqual([]);
    // Moving the players back into the strong order by hand is recognised as the strong order.
    const strong = solution.throwOrder![0].strongOrder;
    const byStrong = undoableReducer(session, {
      type: 'setInput',
      input: session.present.input,
    });
    const restored = evaluateManualOrder(byStrong.present.input, [{ gameId: 'tr', playerIds: strong }]).solution!;
    expect(restored.throwOrder![0].adopted).toBe('strong');
    // Undo restores the generated order and its numbers.
    session = undoableReducer(session, { type: 'undo' });
    expect(session.present.current!.assignments[0].playerIds).toEqual(solution.assignments[0].playerIds);
    expect(session.present.current!.prediction!.win).toBe(before.win);
  });
});

describe('throw order: generation time', () => {
  it('[24] a league night (Team 1001 ×1, Doubles ×2, Singles ×4, 8 players, ordered opponent sides) generates in practical time', () => {
    const strengths = [64, 61, 58, 56, 54, 52, 50, 47];
    const roster = strengths.map((ppr, index) => player({ id: `q${index + 1}`, name: `選手${index + 1}`, ppr }));
    const games: GameSlotDef[] = [
      { id: 'team', order: 1, name: 'Team 1001', kinds: ['TEAM', 'G501'], playerCount: 4, n01: { schid: 'team', numPart: 4, matchType: '01', startScore: 1001, limitLegCount: 2, group: null, subtitle: null } },
      { id: 'd1', order: 2, name: 'Doubles 501', kinds: ['DOUBLES', 'G501'], playerCount: 2, n01: { schid: 'd1', numPart: 2, matchType: '01', startScore: 501, limitLegCount: 2, group: null, subtitle: null } },
      { id: 'd2', order: 3, name: 'Doubles 501', kinds: ['DOUBLES', 'G501'], playerCount: 2, n01: { schid: 'd2', numPart: 2, matchType: '01', startScore: 501, limitLegCount: 2, group: null, subtitle: null } },
      ...[1, 2, 3, 4].map((n): GameSlotDef => ({ id: `s${n}`, order: 3 + n, name: `Singles 501`, kinds: ['SINGLES', 'G501'], playerCount: 1 })),
    ];
    const theirs = [62, 59, 57, 55, 53, 50];
    const member = (strength: number, finish = finishPrior(strength)): OpponentSideMember => ({ strength, finish });
    // Every order of the opponent's likely members, as version-2 contexts carry them.
    const orders = (keys: number[]): number[][] =>
      keys.length <= 1 ? [keys] : keys.flatMap((key) => orders(keys.filter((other) => other !== key)).map((rest) => [key, ...rest]));
    const sidesOf = (keys: number[]): OpponentContext['games'][string]['sides'] => {
      const all = orders(keys);
      return all.map((order) => side(order.map((index) => member(theirs[index])), 1 / all.length));
    };
    const opponent = context(
      Object.fromEntries(roster.map((p, index) => [p.id, ours(strengths[index], { first9Excess: index % 2 === 0 ? 4 : -4 })])),
      {
        team: { numPart: 4, sides: sidesOf([0, 1, 2, 3]), startScore: 1001, order: HIGH_ORDER },
        d1: { numPart: 2, sides: [...sidesOf([0, 4]), ...sidesOf([1, 5])].map((s) => ({ ...s, probability: s.probability / 2 })), startScore: 501, order: HIGH_ORDER },
        d2: { numPart: 2, sides: sidesOf([2, 3]), startScore: 501, order: { ...HIGH_ORDER, known: false, confidence: 'LOW' } },
        s1: { numPart: 1, sides: [{ strength: 62, probability: 1 }] },
        s2: { numPart: 1, sides: [{ strength: 58, probability: 1 }] },
        s3: { numPart: 1, sides: [{ strength: 55, probability: 0.5 }, { strength: 51, probability: 0.5 }] },
        s4: { numPart: 1, sides: [{ strength: 53, probability: 1 }] },
      },
    );
    const input = withModel(orderInput(roster, games, { preset: 'OPPONENT_OPTIMIZED' }), opponent);
    const started = performance.now();
    const result = generateOrder(input);
    const elapsed = performance.now() - started;
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.candidates.length).toBeGreaterThan(1);
    for (const candidate of result.candidates) {
      expect(evaluateManualOrder(input, candidate.assignments).violations).toEqual([]);
      // Every multi-player game has its order decided and recorded.
      expect(candidate.throwOrder!.map((record) => record.gameId).sort()).toEqual(['d1', 'd2', 'team']);
    }
    // Four candidates, each bounded by the 1.2 s time limit, plus the order estimates: well under
    // what a captain waits for at the venue (the backtest reports the distribution, §8.3).
    expect(elapsed).toBeLessThan(12_000);
  });
});
