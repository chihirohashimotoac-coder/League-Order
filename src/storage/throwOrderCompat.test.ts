import { describe, expect, it } from 'vitest';
import type { GameSlotDef, OrderInput, SavedOrder } from '../domain/types';
import { createMatchInfo } from '../domain/types';
import type { OpponentContext } from '../domain/prediction/opponentContext';
import { predictOrder } from '../domain/prediction/predictOrder';
import { THROW_ORDER_MODEL_VERSION } from '../domain/prediction/throwOrder';
import { createVersion, deriveOrderState, diffOrders, orderFingerprint } from '../domain/orders/lifecycle';
import { buildGameRows } from '../share/layout';
import { renderLineText } from '../share/text';
import { evaluateManualOrder, generateOrder } from '../optimizer/generateOrder';
import { createUndoable, undoableReducer } from '../state/orderSession';
import { orderInput, player } from '../test/factories';
import { parseBackup, serialiseBackup } from './backup';
import { buildSeed } from './seed';

/**
 * Saved orders and the throw-order model (docs/THROW_ORDER_MODEL.md §9): an order saved before it
 * is opened, edited and shared exactly as it was — never re-scored by the newer model — and an
 * order made with it keeps its model version, evidence and decisions through a backup, so it is
 * re-evaluated as it was generated. The slot order is the throwing order everywhere.
 */

const GAMES: GameSlotDef[] = [
  { id: 's1', order: 1, name: 'Singles 501', kinds: ['SINGLES', 'G501'], playerCount: 1 },
  { id: 'd1', order: 2, name: 'Doubles 501', kinds: ['DOUBLES', 'G501'], playerCount: 2 },
];
const ROSTER = [player({ id: 'p1', name: '一番', ppr: 60 }), player({ id: 'p2', name: '二番', ppr: 50 }), player({ id: 'p3', name: '三番', ppr: 45 })];

/** A version-1 context exactly as orders saved before this change carry it (sides without members). */
function legacyContext(): OpponentContext {
  return {
    version: 1,
    generatedAt: 0,
    matchId: 'm',
    matchDate: '2026-09-01',
    opponentName: '旧相手',
    leagueMeanPpr: 50,
    players: {
      p1: { strength: 60, confidence: 'HIGH', legs: 60, imputed: false, formAdjustment: 0, first9Adjustment: 0 },
      p2: { strength: 50, confidence: 'HIGH', legs: 60, imputed: false, formAdjustment: 0, first9Adjustment: 0 },
      p3: { strength: 45, confidence: 'MEDIUM', legs: 20, imputed: false, formAdjustment: 0, first9Adjustment: 0 },
    },
    games: {
      s1: { gameId: 's1', signature: 'SINGLES|01|1', numPart: 1, legsToWin: 2, cricket: false, sides: [{ strength: 55, probability: 1 }], likely: [], samples: 5, confidence: 'MEDIUM' },
      d1: {
        gameId: 'd1',
        signature: 'DOUBLES|01|1',
        numPart: 2,
        legsToWin: 2,
        cricket: false,
        sides: [
          { strength: 52, probability: 0.6 },
          { strength: 48, probability: 0.4 },
        ],
        likely: [],
        samples: 5,
        confidence: 'MEDIUM',
      },
    },
    orderConfidence: 'MEDIUM',
    confidence: 'MEDIUM',
  };
}

function legacyOrder(): SavedOrder {
  // As saved before the change: no model version, no role evidence, no decisions; its doubles
  // were written in the then id order.
  const input: OrderInput = { ...orderInput(ROSTER, GAMES, { preset: 'OPPONENT_OPTIMIZED' }), opponent: legacyContext() };
  const assignments = [
    { gameId: 's1', playerIds: ['p3'] },
    { gameId: 'd1', playerIds: ['p1', 'p2'] },
  ];
  const legacySolution = { ...evaluateManualOrder(input, assignments).solution! };
  delete legacySolution.throwOrder;
  return {
    id: 'ord_old',
    teamId: input.teamId,
    title: 'old',
    createdAt: 0,
    updatedAt: 0,
    input,
    solution: legacySolution,
    match: createMatchInfo('チーム'),
    versions: [],
    seasonApplied: false,
  };
}

describe('orders saved before the throw-order model', () => {
  it('open with the saved solution itself: nothing is recomputed', () => {
    const order = legacyOrder();
    const session = undoableReducer(createUndoable(order.input), { type: 'generated', candidates: [order.solution] });
    expect(session.present.current).toBe(order.solution);
    expect(session.present.current!.assignments).toEqual(order.solution.assignments);
  });

  it('keep the order-free estimate: a hand edit, even of the order inside a game, is scored as before', () => {
    const order = legacyOrder();
    expect(order.input.throwOrderModel).toBeUndefined();
    const before = predictOrder(order.input.opponent!, order.solution.assignments, order.input.pairs)!;
    const reordered = order.solution.assignments.map((a) => (a.gameId === 'd1' ? { ...a, playerIds: ['p2', 'p1'] } : a));
    const edited = evaluateManualOrder(order.input, reordered).solution!.prediction!;
    expect(edited.games.find((g) => g.gameId === 'd1')!.probability).toBeCloseTo(before.games.find((g) => g.gameId === 'd1')!.probability, 12);
    expect(edited.win).toBeCloseTo(before.win, 12);
    expect(edited.games.every((game) => game.orderEffect === undefined)).toBe(true);
    // Its saved (id-ordered) Doubles is not explained as a hand edit of a rule it was never made with.
    expect(evaluateManualOrder(order.input, reordered).solution!.throwOrder).toEqual([]);
    expect(evaluateManualOrder(order.input, order.solution.assignments).solution!.throwOrder).toEqual([]);
  });

  it('survive a backup round trip unchanged, and share in their saved slot order', () => {
    const order = legacyOrder();
    const seed = buildSeed();
    const parsed = parseBackup(serialiseBackup({ ...seed, orders: [order] }));
    if (!parsed.ok) throw new Error('parse failed');
    const back = parsed.snapshot.orders[0];
    expect(back.solution).toEqual(order.solution);
    expect(back.input.throwOrderModel).toBeUndefined();
    expect(back.input.opponent?.version).toBe(1);
    const rows = buildGameRows(GAMES, ROSTER, back.solution);
    expect(rows.find((row) => row.gameName === 'Doubles 501')!.players).toBe('一番 / 二番');
  });
});

describe('orders made with the throw-order model', () => {
  function newOrder(): SavedOrder {
    const input: OrderInput = {
      ...orderInput(ROSTER, GAMES, { preset: 'WIN_FIRST' }),
      throwOrderModel: THROW_ORDER_MODEL_VERSION,
      roleStrength: {
        version: 1,
        generatedAt: 1,
        source: 'n01',
        gamesObserved: 12,
        before: '2026-10-20',
        players: { p2: { evidence: { 'DOUBLES|01': { games: 6, weight: 18, sum: 18 * 3 } } } },
      },
    };
    const result = generateOrder(input, { singleCandidate: true });
    if (!result.ok) throw new Error('no order');
    const match = createMatchInfo('チーム');
    return {
      id: 'ord_new',
      teamId: input.teamId,
      title: 'new',
      createdAt: 0,
      updatedAt: 0,
      input,
      solution: result.candidates[0],
      match,
      versions: [createVersion(input, result.candidates[0], match, [], 1)],
      seasonApplied: false,
    };
  }

  it('keep the model version, the role evidence and every order decision through a backup', () => {
    const order = newOrder();
    const parsed = parseBackup(serialiseBackup({ ...buildSeed(), orders: [order] }));
    if (!parsed.ok) throw new Error('parse failed');
    const back = parsed.snapshot.orders[0];
    expect(back.input.throwOrderModel).toBe(THROW_ORDER_MODEL_VERSION);
    expect(back.input.roleStrength).toEqual(order.input.roleStrength);
    expect(back.solution.throwOrder).toEqual(order.solution.throwOrder);
    expect(back.solution.throwOrder!.length).toBeGreaterThan(0);
    // Re-evaluated exactly as generated.
    const again = evaluateManualOrder(back.input, back.solution.assignments).solution!;
    expect(again.throwOrder!.map((r) => r.order)).toEqual(order.solution.throwOrder!.map((r) => r.order));
    expect(again.throwOrder!.map((r) => r.strongOrder)).toEqual(order.solution.throwOrder!.map((r) => r.strongOrder));
  });

  it('a change of throwing order alone changes the fingerprint (FINALIZED → UPDATED) and the diff', () => {
    const order = newOrder();
    const swapped = order.solution.assignments.map((a) => (a.gameId === 'd1' ? { ...a, playerIds: [...a.playerIds].reverse() } : a));
    const match = order.match!;
    expect(deriveOrderState(order.versions, orderFingerprint(GAMES, order.solution.assignments, match))).toBe('FINALIZED');
    expect(deriveOrderState(order.versions, orderFingerprint(GAMES, swapped, match))).toBe('UPDATED');
    const diff = diffOrders({ games: GAMES, assignments: order.solution.assignments, players: ROSTER }, { games: GAMES, assignments: swapped, players: ROSTER });
    expect(diff.changes.map((row) => row.gameId)).toEqual(['d1']);
  });

  it('share text and image rows list the players in throwing order (1投目 first)', () => {
    const order = newOrder();
    const doubles = order.solution.assignments.find((a) => a.gameId === 'd1')!;
    const names = doubles.playerIds.map((id) => ROSTER.find((p) => p.id === id)!.name);
    expect(buildGameRows(GAMES, ROSTER, order.solution).find((row) => row.gameName === 'Doubles 501')!.playerNames).toEqual(names);
    expect(renderLineText(GAMES, ROSTER, order.solution, order.match!)).toContain(names.join(' / '));
    // The order shown is the strong order of the record, not an id order.
    expect(order.solution.throwOrder!.find((r) => r.gameId === 'd1')!.order).toEqual(doubles.playerIds);
  });
});
