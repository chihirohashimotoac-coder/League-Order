import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { OrderInput, OrderSolution, PresetKey, UnderdogStatus, UnderdogSuggestion } from '../../domain/types';
import { UnderdogPanel, underdogGainText, underdogGuidance, underdogLossText } from './UnderdogPanel';

/**
 * The panel's wording for both plans (docs/UNDERDOG_PLAN.md §4). The E[W] plan is rarely chosen
 * on realistic inputs (§3), so its text is checked here directly.
 */

afterEach(cleanup);

function solution(spread: number, counts: number[]): OrderSolution {
  return {
    assignments: [],
    tallies: counts.map((count, index) => ({ playerId: `p${index + 1}`, count })),
    metrics: { totalSlots: 6, participantCount: counts.length, appearanceSpread: spread },
  } as unknown as OrderSolution;
}

function suggestion(objective: UnderdogSuggestion['objective'], winBefore: number, winAfter: number): UnderdogSuggestion {
  return {
    version: 1,
    objective,
    solution: solution(2, [3, 2, 1, 0]),
    standard: { win: winBefore, draw: 0, atLeastOne: 0.61, expectedGames: 0.95, gameCount: 5 },
    plan: { win: winAfter, draw: 0, atLeastOne: objective === 'atLeastOne' ? 0.67 : 0.62, expectedGames: objective === 'expectedWins' ? 1.07 : 0.96, gameCount: 5 },
    improvement: objective === 'atLeastOne' ? 0.06 : 0.024,
    compared: { atLeastOne: objective === 'atLeastOne' ? 0.06 : 0.01, expectedWins: objective === 'expectedWins' ? 0.024 : 0.002 },
    matchWinLoss: winBefore - winAfter,
    confidence: 'MEDIUM',
  };
}

describe('UnderdogPanel', () => {
  it('names the P(W ≥ 1) plan by its gain and the match win it gives up', () => {
    const s = suggestion('atLeastOne', 0.18, 0.168);
    expect(underdogGainText(s)).toBe('1ゲーム以上取る確率を +6.0pt 改善 (61% → 67%)');
    expect(underdogLossText(s)).toBe('標準案から失われる推定 Match 勝率 −1.2pt (18% → 17%)');
  });

  it('names the E[W] plan in games, out of the number of games', () => {
    const s = suggestion('expectedWins', 0.18, 0.184);
    expect(underdogGainText(s)).toBe('期待勝ちゲーム数を 0.12 改善 (0.95 → 1.07 / 5)');
    expect(underdogLossText(s)).toBe('推定 Match 勝率は標準案より +0.4pt (18% → 18%)');
  });

  it('offers one tap to the plan and one tap back, and shows a fairness change', async () => {
    const onApply = vi.fn();
    const onRestore = vi.fn();
    const s = suggestion('expectedWins', 0.18, 0.17);
    const names = new Map([
      ['p1', '一'],
      ['p2', '二'],
      ['p3', '三'],
      ['p4', '四'],
    ]);
    const { rerender } = render(
      <UnderdogPanel suggestion={s} showing={false} edited={false} standard={solution(1, [2, 2, 1, 1])} nameById={names} onApply={onApply} onRestore={onRestore} />,
    );
    expect(screen.getByTestId('underdog-panel').textContent).toContain('期待勝ちゲーム数を 0.12 改善');
    expect(screen.getByText(/出場回数の最大差 1 → 2 \(出場なし: 四\)/u)).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: '格上対策案を試す' }));
    expect(onApply).toHaveBeenCalledTimes(1);
    rerender(<UnderdogPanel suggestion={s} showing edited={false} standard={solution(1, [2, 2, 1, 1])} nameById={names} onApply={onApply} onRestore={onRestore} />);
    expect(screen.getByText('格上対策案を表示中')).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: '標準案に戻す' }));
    expect(onRestore).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------

function candidate(presetKey: PresetKey, win: number | null, underdog = false): OrderSolution {
  return {
    meta: { presetKey, label: presetKey, ...(underdog ? { underdog: { objective: 'atLeastOne' } } : {}) },
    ...(win === null ? {} : { prediction: { win, confidence: 'MEDIUM', games: [] } }),
  } as unknown as OrderSolution;
}

function state(
  preset: PresetKey,
  candidates: OrderSolution[],
  extra: { selected?: number; underdog?: UnderdogSuggestion | null; status?: UnderdogStatus | null; edited?: boolean; showingUnderdog?: boolean } = {},
) {
  const selected = extra.selected ?? 0;
  return {
    input: { preset } as OrderInput,
    candidates,
    selectedCandidate: selected,
    current: candidates[selected] ?? null,
    edited: extra.edited ?? false,
    showingUnderdog: extra.showingUnderdog ?? false,
    underdog: extra.underdog ?? null,
    underdogStatus: extra.status ?? null,
    underdogBasis: null,
  };
}

const LOW: UnderdogStatus = { eligible: false, reason: 'low-confidence' };

describe('underdogGuidance (docs/UNDERDOG_PLAN.md §4.1)', () => {
  it('uses the engine\'s 20% bound: 20% shown (0.204) is included, 21% shown (0.205) is not', () => {
    expect(underdogGuidance(state('OPPONENT_OPTIMIZED', [candidate('OPPONENT_OPTIMIZED', 0.204)], { status: LOW }), true)?.kind).toBe('skipped');
    expect(underdogGuidance(state('OPPONENT_OPTIMIZED', [candidate('OPPONENT_OPTIMIZED', 0.205)], { status: LOW }), true)).toBeNull();
    expect(underdogGuidance(state('WIN_FIRST', [candidate('WIN_FIRST', 0.204)]), true)?.kind).toBe('other-preset');
    expect(underdogGuidance(state('WIN_FIRST', [candidate('WIN_FIRST', 0.205)]), true)).toBeNull();
  });

  it('adds nothing without opponent data (no estimate)', () => {
    expect(underdogGuidance(state('WIN_FIRST', [candidate('WIN_FIRST', null)]), true)).toBeNull();
    expect(underdogGuidance(state('OPPONENT_OPTIMIZED', [candidate('OPPONENT_OPTIMIZED', null)], { status: { eligible: false, reason: 'no-opponent' } }), true)).toBeNull();
  });

  it('names only the reasons the engine returned, and none it did not', () => {
    for (const reason of ['low-confidence', 'no-improvement', 'not-stronger', 'not-run'] as const) {
      expect(underdogGuidance(state('OPPONENT_OPTIMIZED', [candidate('OPPONENT_OPTIMIZED', 0.1)], { status: { eligible: false, reason } }), true)).toMatchObject({ kind: 'skipped', reason });
    }
    // No status: a saved order or older data — nothing is inferred.
    expect(underdogGuidance(state('OPPONENT_OPTIMIZED', [candidate('OPPONENT_OPTIMIZED', 0.1)]), true)).toBeNull();
    // A saved order that is the applied underdog plan is not "another preset".
    expect(underdogGuidance(state('OPPONENT_OPTIMIZED', [candidate('OPPONENT_OPTIMIZED', 0.1, true)]), true)).toBeNull();
  });

  it('on a comparison candidate, reads the standard plan\'s win and points back only when a plan exists', () => {
    const candidates = [candidate('OPPONENT_OPTIMIZED', 0.18), candidate('BALANCED', 0.25)];
    const plan = suggestion('atLeastOne', 0.18, 0.17);
    expect(underdogGuidance(state('OPPONENT_OPTIMIZED', candidates, { selected: 1, underdog: plan, status: { eligible: true } }), true)).toMatchObject({ kind: 'standard-has-plan', standardIndex: 0 });
    expect(underdogGuidance(state('OPPONENT_OPTIMIZED', candidates, { selected: 1, status: LOW }), true)).toBeNull();
    const above = [candidate('OPPONENT_OPTIMIZED', 0.22), candidate('BALANCED', 0.1)];
    expect(underdogGuidance(state('OPPONENT_OPTIMIZED', above, { selected: 1, underdog: plan }), true)).toBeNull();
  });

  it('nothing while editing, while the plan is shown, with the plan\'s own panel, or with estimates hidden', () => {
    const one = [candidate('OPPONENT_OPTIMIZED', 0.1)];
    expect(underdogGuidance(state('OPPONENT_OPTIMIZED', one, { status: LOW, edited: true }), true)).toBeNull();
    expect(underdogGuidance(state('OPPONENT_OPTIMIZED', one, { status: LOW, showingUnderdog: true }), true)).toBeNull();
    expect(underdogGuidance(state('OPPONENT_OPTIMIZED', one, { underdog: suggestion('atLeastOne', 0.1, 0.1), status: { eligible: true } }), true)).toBeNull();
    expect(underdogGuidance(state('OPPONENT_OPTIMIZED', one, { status: LOW }), false)).toBeNull();
    expect(underdogGuidance(state('WIN_FIRST', [candidate('WIN_FIRST', 0.1)], { edited: true }), true)).toBeNull();
  });
});
