import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useReducer } from 'react';
import { ResultPage } from './ResultPage';
import { AppStoreProvider } from '../state/appStore';
import { ToastProvider } from '../components/ui';
import { OpponentPanel } from '../components/n01/OpponentPanel';
import { createUndoable, undoableReducer, type UndoableState } from '../state/orderSession';
import { evaluateManualOrder, generateOrder } from '../optimizer/generateOrder';
import { singlesAceNote } from '../optimizer/aceMatchup';
import { orderInput, player } from '../test/factories';
import { createMatchInfo, type GameSlotDef, type OrderInput } from '../domain/types';
import type { OpponentContext, OpponentGameContext } from '../domain/prediction/opponentContext';
import { THROW_ORDER_MODEL_VERSION } from '../domain/prediction/throwOrder';
import { finishPrior } from '../domain/prediction/finishing';
import 'fake-indexeddb/auto';

/**
 * The RESULT screen's throw-order and underdog-plan controls (docs/THROW_ORDER_MODEL.md §7,
 * docs/UNDERDOG_PLAN.md §5): 1投目… labels, a button (not only drag) to swap two throwers with a
 * live re-estimate, the reason when the order is not the strong one, and the one-tap underdog
 * plan with its way back.
 */

afterEach(cleanup);
beforeAll(() => {
  HTMLCanvasElement.prototype.getContext = vi.fn(() => null) as never;
});

function Harness({ input, onState }: { input: OrderInput; onState?: (state: UndoableState) => void }): React.JSX.Element {
  const result = generateOrder(input, { timeLimitMs: 6000 });
  if (!result.ok) throw new Error('fixture should be satisfiable');
  const [session, dispatch] = useReducer(
    undoableReducer,
    undoableReducer(createUndoable(input), { type: 'generated', candidates: result.candidates, underdog: result.underdog ?? null }),
  );
  onState?.(session);
  return (
    <ResultPage
      session={session}
      dispatch={dispatch}
      games={input.games}
      diagnostics={[]}
      generating={false}
      match={createMatchInfo('テストチーム')}
      onMatchChange={() => undefined}
      onRegenerate={() => undefined}
      onReoptimise={() => undefined}
      record={null}
      lifecycle="DRAFT"
      seasonStatus="none"
      onFinalize={() => undefined}
      onSaveDraft={() => undefined}
      onCommitSeason={() => undefined}
      onWithdrawSeason={() => undefined}
    />
  );
}

function renderWith(input: OrderInput, onState?: (state: UndoableState) => void) {
  return render(
    <ToastProvider>
      <AppStoreProvider>
        <Harness input={input} onState={onState} />
      </AppStoreProvider>
    </ToastProvider>,
  );
}

function context(
  players: Record<string, { strength: number; first9Excess?: number | null }>,
  games: Record<string, Partial<OpponentGameContext> & Pick<OpponentGameContext, 'sides' | 'numPart'>>,
  confidence: 'HIGH' | 'MEDIUM' = 'HIGH',
): OpponentContext {
  return {
    version: 2,
    generatedAt: 0,
    matchId: 'm',
    matchDate: '2026-10-20',
    opponentName: '相手チーム',
    leagueMeanPpr: 52,
    players: Object.fromEntries(
      Object.entries(players).map(([id, spec]) => [
        id,
        { strength: spec.strength, confidence: 'HIGH', legs: 60, imputed: false, formAdjustment: 0, first9Adjustment: 0, first9Excess: spec.first9Excess ?? null },
      ]),
    ),
    games: Object.fromEntries(
      Object.entries(games).map(([gameId, game]) => [
        gameId,
        { gameId, signature: gameId, legsToWin: 3, cricket: false, likely: [{ name: '相手エース', probability: 0.7 }], samples: 8, confidence, ...game } as OpponentGameContext,
      ]),
    ),
    orderConfidence: confidence,
    confidence,
    discipline: 'STEEL',
  };
}

const TRIOS: GameSlotDef = {
  id: 'tr',
  order: 1,
  name: 'Trios 701',
  kinds: ['TRIOS', 'G501'],
  playerCount: 3,
  n01: { schid: 'tr', numPart: 3, matchType: '01', startScore: 701, limitLegCount: 3, group: null, subtitle: null },
};

function trioInput(reverse: boolean): OrderInput {
  const roster = [
    player({ id: 'p1', name: 'エース', ppr: 65 }),
    player({ id: 'p2', name: 'セカンド', ppr: 55 }),
    player({ id: 'p3', name: 'スコアラー', ppr: 60 }),
  ];
  const members = [
    { strength: 65, finish: 0.7 },
    { strength: 51, finish: 0.1261 },
    { strength: 62, finish: 0.2737 },
  ];
  const opponentMembers = reverse ? [...members].reverse() : members;
  const opponent = context(
    { p1: { strength: 65, first9Excess: -3 }, p2: { strength: 55, first9Excess: -7 }, p3: { strength: 60, first9Excess: 14 } },
    {
      tr: {
        numPart: 3,
        startScore: 701,
        order: { known: true, confidence: 'HIGH', samples: 8, leaders: [{ name: '相手A', probability: 0.8 }] },
        sides: [{ strength: opponentMembers.reduce((a, m) => a + m.strength, 0) / 3, probability: 1, members: opponentMembers }],
      },
    },
  );
  return { ...orderInput(roster, [TRIOS], { preset: 'OPPONENT_OPTIMIZED' }), opponent, throwOrderModel: THROW_ORDER_MODEL_VERSION, discipline: 'STEEL' };
}

describe('throw order on the result screen', () => {
  it('labels the slots 1投目 / 2投目 / 3投目 and explains the strong order quietly', () => {
    renderWith(trioInput(false));
    const card = screen.getByRole('article', { name: /Trios 701/ });
    for (const label of ['1投目', '2投目', '3投目']) expect(within(card).getAllByText(label).length).toBeGreaterThan(0);
    expect(within(card).queryByText(/PLAYER/)).toBeNull();
    expect(screen.getByLabelText('Game 1 Trios 701 の1投目')).toBeDefined();
    expect(screen.getByLabelText('Game 1 Trios 701 1投目 のロック')).toBeDefined();
    const note = within(card).getByTestId('throw-order-note');
    expect(note.tagName).toBe('DETAILS');
    expect(note.textContent).toContain('投順: 強い順');
  });

  it('when the order is not the strong one, the reason stands out: usual order, gain, confidence, opponent tendency', () => {
    renderWith(trioInput(true));
    const note = screen.getByTestId('throw-order-note');
    expect(note.getAttribute('role')).toBe('note');
    expect(note.textContent).toContain('通常 (強い順) なら エース → スコアラー → セカンド');
    expect(note.textContent).toMatch(/推定ゲーム勝率が \+\d+\.\dpt 高い/);
    expect(note.textContent).toContain('信頼度 高');
    expect(note.textContent).toContain('利用した相手の傾向');
    expect(note.textContent).not.toMatch(/確実|必勝/);
  });

  it('a button swaps two throwers (no drag needed) and the estimate is redone at once', async () => {
    const user = userEvent.setup();
    let latest: UndoableState | null = null;
    renderWith(trioInput(false), (state) => {
      latest = state;
    });
    const before = latest!.present.current!;
    const swap = screen.getByRole('button', { name: 'Game 1 Trios 701: 1投目と2投目を入れ替え' });
    swap.focus();
    await user.keyboard('{Enter}');
    const after = latest!.present.current!;
    expect(after.assignments[0].playerIds).toEqual([before.assignments[0].playerIds[1], before.assignments[0].playerIds[0], before.assignments[0].playerIds[2]]);
    expect(after.prediction!.games[0].probability).not.toBeCloseTo(before.prediction!.games[0].probability, 6);
    expect(screen.getByTestId('throw-order-note').textContent).toContain('手動で変更');
  });

  it('a locked thrower cannot be swapped away', async () => {
    const user = userEvent.setup();
    renderWith(trioInput(false));
    await user.click(screen.getByLabelText('Game 1 Trios 701 1投目 のロック'));
    expect((screen.getByRole('button', { name: 'Game 1 Trios 701: 1投目と2投目を入れ替え' }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole('button', { name: 'Game 1 Trios 701: 2投目と3投目を入れ替え' }) as HTMLButtonElement).disabled).toBe(false);
  });
});

// ---------------------------------------------------------------------------

const SINGLES: GameSlotDef[] = [1, 2, 3, 4].map((n) => ({ id: `s${n}`, order: n, name: `Singles ${n}`, kinds: ['SINGLES', 'G501'], playerCount: 1 }));
const DOUBLES: GameSlotDef = { id: 'd1', order: 5, name: 'Doubles 1', kinds: ['DOUBLES', 'G501'], playerCount: 2 };

function underdogInput(): OrderInput {
  const strengths = [58, 50, 46, 44, 42];
  const roster = strengths.map((strength, index) => player({ id: `p${index + 1}`, name: `選手${index + 1}`, ppr: strength }));
  const opp: Record<string, number> = { s1: 70, s2: 68, s3: 66, s4: 50, d1: 66 };
  const opponent = context(
    Object.fromEntries(roster.map((p, index) => [p.id, { strength: strengths[index] }])),
    Object.fromEntries(
      [...SINGLES, DOUBLES].map((game) => [
        game.id,
        game.playerCount === 1
          ? { numPart: 1, legsToWin: 2, sides: [{ strength: opp[game.id], probability: 1 }] }
          : {
              numPart: 2,
              legsToWin: 2,
              startScore: 501,
              order: { known: true, confidence: 'MEDIUM', samples: 6, leaders: [] },
              sides: [{ strength: opp[game.id], probability: 1, members: [0, 1].map(() => ({ strength: opp[game.id], finish: finishPrior(opp[game.id]) })) }],
            },
      ]),
    ),
    'MEDIUM',
  );
  return { ...orderInput(roster, [...SINGLES, DOUBLES], { preset: 'OPPONENT_OPTIMIZED' }), opponent, throwOrderModel: THROW_ORDER_MODEL_VERSION, discipline: 'STEEL' };
}

describe('the underdog plan on the result screen', () => {
  it('is offered in one tap with its reason, switches the order, and comes back in one tap', async () => {
    const user = userEvent.setup();
    let latest: UndoableState | null = null;
    renderWith(underdogInput(), (state) => {
      latest = state;
    });
    const panel = screen.getByTestId('underdog-panel');
    expect(panel.textContent).toMatch(/標準案の推定 Match 勝率 \d+%/);
    expect(panel.textContent).toMatch(/1ゲーム以上取る確率を \+\d+\.\dpt 改善|期待勝ちゲーム数を \d\.\d\d 改善/);
    expect(panel.textContent).toMatch(/推定 Match 勝率/);
    expect(panel.textContent).not.toMatch(/確実|必勝/);
    // Not applied by itself.
    const standard = latest!.present.current!;
    expect(latest!.present.showingUnderdog).toBe(false);
    await user.click(within(panel).getByRole('button', { name: '格上対策案を試す' }));
    expect(latest!.present.showingUnderdog).toBe(true);
    expect(latest!.present.current).toBe(latest!.present.underdog!.solution);
    expect(screen.getByTestId('underdog-panel').textContent).toContain('格上対策案を表示中');
    await user.click(screen.getByRole('button', { name: '標準案に戻す' }));
    expect(latest!.present.current).toBe(standard);
    expect(screen.getByRole('button', { name: '格上対策案を試す' })).toBeDefined();
  });

  it('is not offered when the engine offered nothing (a beatable opponent)', () => {
    renderWith(trioInput(false));
    expect(screen.queryByTestId('underdog-panel')).toBeNull();
  });
});

describe('Singles: receiving the opponent\'s ace', () => {
  it('says when our ace is not put against their ace, with the estimate of doing so', () => {
    const games = SINGLES.slice(0, 3);
    const roster = [player({ id: 'a', name: '自軍エース', ppr: 62 }), player({ id: 'b', name: '受け役', ppr: 48 }), player({ id: 'c', name: '三番手', ppr: 47 })];
    const opponent = context(
      { a: { strength: 62 }, b: { strength: 48 }, c: { strength: 47 } },
      {
        s1: { numPart: 1, legsToWin: 2, sides: [{ strength: 72, probability: 1 }] },
        s2: { numPart: 1, legsToWin: 2, sides: [{ strength: 55, probability: 1 }] },
        s3: { numPart: 1, legsToWin: 2, sides: [{ strength: 54, probability: 1 }] },
      },
    );
    const input = { ...orderInput(roster, games, { preset: 'OPPONENT_OPTIMIZED' }), opponent, throwOrderModel: THROW_ORDER_MODEL_VERSION };
    // Their ace (72) is received by 受け役; our ace plays Singles 2.
    const evaluated = evaluateManualOrder(input, [
      { gameId: 's1', playerIds: ['b'] },
      { gameId: 's2', playerIds: ['a'] },
      { gameId: 's3', playerIds: ['c'] },
    ]);
    const note = singlesAceNote(input, evaluated.solution!)!;
    expect(note).toMatchObject({ aceGameId: 's1', ourAce: 'a', ourAceGameId: 's2', receiver: 'b' });
    expect(note.swapped).not.toBeNull();
    render(<OpponentPanel solution={evaluated.solution!} candidates={[evaluated.solution!]} games={games} input={input} />);
    const text = screen.getByTestId('opponent-ace').textContent!;
    expect(text).toContain('相手エース枠 G01 Singles 1');
    expect(text).toContain('受け役 が受け');
    expect(text).toContain('自軍エース 自軍エース は G02 Singles 2');
    expect(text).toMatch(/エースを相手エース枠に当てた場合の推定 Match 勝率 \d+% \/ この案 \d+%/);
    // Ace against ace: nothing to explain.
    const aceVsAce = evaluateManualOrder(input, [
      { gameId: 's1', playerIds: ['a'] },
      { gameId: 's2', playerIds: ['b'] },
      { gameId: 's3', playerIds: ['c'] },
    ]);
    expect(singlesAceNote(input, aceVsAce.solution!)).toBeNull();
  });
});
