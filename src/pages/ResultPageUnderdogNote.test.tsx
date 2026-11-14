import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useReducer } from 'react';
import { IDBFactory } from 'fake-indexeddb';
import 'fake-indexeddb/auto';
import { ResultPage } from './ResultPage';
import { AppStoreProvider } from '../state/appStore';
import { ToastProvider } from '../components/ui';
import { createUndoable, undoableReducer, type UndoableState } from '../state/orderSession';
import { generateOrder } from '../optimizer/generateOrder';
import { previewScenarios } from '../preview/scenarios';
import { openBackend, resetBackendCache } from '../storage/db';
import { DEFAULT_SETTINGS, Repository } from '../storage/repository';
import { DEFAULT_N01_SETTINGS, createMatchInfo, type OrderInput, type UnderdogStatus } from '../domain/types';

/**
 * Why the result screen shows no underdog plan, and where to check one (docs/UNDERDOG_PLAN.md
 * §4.1), on the preview fixtures (D: 対戦相手最適化 2%・中 with a plan; F: the same data as
 * 勝利優先; G: D with only the opponent order model LOW) and an 8%・高 single-game variant whose
 * plans do not improve enough. The reason shown is always the one the engine returned.
 */

afterEach(cleanup);
beforeAll(() => {
  HTMLCanvasElement.prototype.getContext = vi.fn(() => null) as never;
});
beforeEach(() => {
  window.scrollTo = vi.fn() as never;
  globalThis.indexedDB = new IDBFactory();
  resetBackendCache();
});

const scenario = (id: string): OrderInput => previewScenarios().find((entry) => entry.id === id)!.input;

/** D's data, one Singles against a much stronger player, all HIGH: 8%, and no plan improves 2pt. */
function noImprovementInput(): OrderInput {
  const d = scenario('underdog');
  const opponent = d.opponent!;
  return {
    ...d,
    games: [d.games[0]],
    opponent: {
      ...opponent,
      confidence: 'HIGH',
      orderConfidence: 'HIGH',
      games: { s1: { ...opponent.games.s1, confidence: 'HIGH', sides: [{ strength: 75, probability: 1 }] } },
    },
  };
}

/** The session App builds from a generation (with the engine's status, or one given in its place). */
function sessionFor(input: OrderInput, status?: UnderdogStatus | null): UndoableState {
  const result = generateOrder(input, { timeLimitMs: 4000 });
  if (!result.ok) throw new Error('fixture should be satisfiable');
  const underdogStatus = status === undefined ? (result.underdogStatus ?? null) : status;
  return undoableReducer(createUndoable(input), {
    type: 'generated',
    candidates: result.candidates,
    underdog: status === undefined ? (result.underdog ?? null) : null,
    underdogStatus,
  });
}

function Harness({ initial, onState, onOpenSetup }: { initial: UndoableState; onState?: (state: UndoableState) => void; onOpenSetup?: () => void }): React.JSX.Element {
  const [session, dispatch] = useReducer(undoableReducer, initial);
  onState?.(session);
  return (
    <ResultPage
      session={session}
      dispatch={dispatch}
      games={session.present.input.games}
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
      onOpenSetup={onOpenSetup}
    />
  );
}

function renderSession(initial: UndoableState, options: { onState?: (state: UndoableState) => void; onOpenSetup?: () => void } = {}) {
  return render(
    <ToastProvider>
      <AppStoreProvider>
        <Harness initial={initial} {...options} />
      </AppStoreProvider>
    </ToastProvider>,
  );
}

const note = () => screen.queryByTestId('underdog-note');

describe('勝利優先 at 2% (fixture F): where to check the underdog plan', () => {
  it('says 対戦相手最適化 shows it and opens オーダー設定 without generating anything', async () => {
    const user = userEvent.setup();
    const onOpenSetup = vi.fn();
    let latest: UndoableState | null = null;
    renderSession(sessionFor(scenario('underdog-win-first')), { onOpenSetup, onState: (state) => (latest = state) });
    expect(screen.getByTestId('estimated-match-win').textContent).toBe('2%');
    const hint = note()!;
    expect(hint.dataset.kind).toBe('other-preset');
    expect(hint.textContent).toContain('格上対策は「対戦相手最適化」で確認できます');
    expect(hint.textContent).toContain('この候補の推定 Match 勝率は 2%');
    expect(screen.queryByTestId('underdog-panel')).toBeNull();
    const before = latest!;
    await user.click(within(hint).getByRole('button', { name: 'オーダー設定を開く' }));
    expect(onOpenSetup).toHaveBeenCalledTimes(1);
    // Nothing in the order changed: no generation, no preset chosen.
    expect(latest).toBe(before);
  });

  it('is not added for a hand-edited line-up, and comes back on undo', async () => {
    const user = userEvent.setup();
    renderSession(sessionFor(scenario('underdog-win-first')), { onOpenSetup: () => undefined });
    expect(note()).not.toBeNull();
    const first = document.querySelector<HTMLSelectElement>('.order-game select')!;
    const other = [...first.options].find((option) => option.value && option.value !== first.value)!;
    await user.selectOptions(first, other.value);
    expect(note()).toBeNull();
    await user.click(screen.getByRole('button', { name: '元に戻す' }));
    expect(note()).not.toBeNull();
  });
});

describe('対戦相手最適化 at 2% (fixture D): the existing plan, and the way back to it', () => {
  it('shows the plan for the standard plan and no extra note', () => {
    renderSession(sessionFor(scenario('underdog')));
    expect(screen.getByTestId('underdog-panel').textContent).toContain('標準案の推定 Match 勝率 2%');
    expect(note()).toBeNull();
  });

  it('on a comparison candidate, points back to the standard plan by the candidate switch, not a new generation', async () => {
    const user = userEvent.setup();
    let latest: UndoableState | null = null;
    renderSession(sessionFor(scenario('underdog')), { onState: (state) => (latest = state) });
    const candidates = latest!.present.candidates;
    const balanced = candidates.findIndex((candidate) => candidate.meta.presetKey === 'BALANCED');
    // BALANCED is 3% here; the 20% bound is read from the standard plan (2%).
    await user.click(screen.getByRole('button', { name: /^候補 [A-D]: バランス/u }));
    expect(latest!.present.selectedCandidate).toBe(balanced);
    expect(screen.queryByTestId('underdog-panel')).toBeNull();
    const hint = note()!;
    expect(hint.dataset.kind).toBe('standard-has-plan');
    expect(hint.textContent).toContain('標準案 (推定 Match 勝率 2%) を表示すると、格上対策案を試せます');
    await user.click(within(hint).getByRole('button', { name: '標準案を表示' }));
    expect(latest!.present.current).toBe(candidates[0]);
    expect(latest!.present.candidates).toBe(candidates);
    expect(screen.getByTestId('underdog-panel')).toBeDefined();
    expect(note()).toBeNull();
  });

  it('while the plan is applied, keeps the existing 標準案に戻す only', async () => {
    const user = userEvent.setup();
    renderSession(sessionFor(scenario('underdog')));
    await user.click(screen.getByRole('button', { name: '格上対策案を試す' }));
    expect(screen.getByRole('button', { name: '標準案に戻す' })).toBeDefined();
    expect(note()).toBeNull();
  });
});

describe('対戦相手最適化 without a plan: the reason the engine returned', () => {
  it('low-confidence (fixture G): the opponent order model is LOW while the shown win is 中', () => {
    renderSession(sessionFor(scenario('underdog-low-order')));
    expect(screen.getByTestId('opponent-panel').textContent).toContain('信頼度 中');
    expect(screen.getByTestId('estimated-match-win').textContent).toBe('2%');
    const hint = note()!;
    expect(hint.dataset.kind).toBe('skipped');
    expect(hint.textContent).toContain('標準案の推定 Match 勝率 2%');
    expect(hint.textContent).toContain('相手データの信頼度が低いため、出していません (相手のオーダー傾向 低・相手ゲーム 中)');
    expect(hint.textContent).toContain('上の「信頼度 中」は推定 Match 勝率の信頼度で、判定に使う相手データとは材料が異なります');
    expect(within(hint).queryByRole('button')).toBeNull();
  });

  it('no-improvement (8%・高): the plans did not reach the 2pt bar', () => {
    renderSession(sessionFor(noImprovementInput()));
    expect(screen.getByTestId('estimated-match-win').textContent).toBe('8%');
    const hint = note()!;
    expect(hint.textContent).toContain('改善が基準 (2pt) に届かなかったため');
    expect(hint.textContent).not.toContain('信頼度');
  });

  it('not-stronger and not-run are told apart from no-improvement', () => {
    const { unmount } = renderSession(sessionFor(scenario('underdog'), { eligible: false, reason: 'not-stronger' }));
    expect(note()!.textContent).toContain('モデル上の戦力差で相手が上回っていないため');
    unmount();
    renderSession(sessionFor(scenario('underdog'), { eligible: false, reason: 'not-run' }));
    const text = note()!.textContent ?? '';
    expect(text).toContain('条件を満たす対策案を作れず、標準案と比較できなかったため');
    expect(text).not.toContain('改善');
  });

  it('says nothing when no status came with the order (a saved order, older data)', () => {
    renderSession(sessionFor(scenario('underdog-low-order'), null));
    expect(screen.getByTestId('estimated-match-win').textContent).toBe('2%');
    expect(note()).toBeNull();
  });

  it('a regeneration without a status drops the previous reason; undo brings it back with its order', () => {
    const first = sessionFor(scenario('underdog-low-order'));
    const regenerated = undoableReducer(first, { type: 'generated', candidates: first.present.candidates });
    expect(regenerated.present.underdogStatus).toBeNull();
    renderSession(regenerated);
    expect(note()).toBeNull();
    cleanup();
    renderSession(undoableReducer(regenerated, { type: 'undo' }));
    expect(note()!.dataset.kind).toBe('skipped');
  });

  it('a re-generation on other opponent data, undone one step: the reason keeps the data it was judged on', () => {
    // G (order model LOW) → D's data (MEDIUM) re-generated, as App does it: input first, then the result.
    const first = sessionFor(scenario('underdog-low-order'));
    const d = scenario('underdog');
    const result = generateOrder(d, { timeLimitMs: 4000 });
    if (!result.ok) throw new Error('fixture should be satisfiable');
    const withInput = undoableReducer(first, { type: 'setInput', input: d });
    const regenerated = undoableReducer(withInput, { type: 'generated', candidates: result.candidates, underdog: result.underdog ?? null, underdogStatus: result.underdogStatus ?? null });
    // One undo: D's input, but G's candidates and status — the levels shown are G's, not D's.
    const undone = undoableReducer(regenerated, { type: 'undo' });
    expect(undone.present.input).toBe(d);
    renderSession(undone);
    expect(note()!.textContent).toContain('(相手のオーダー傾向 低・相手ゲーム 中)');
    cleanup();
    renderSession(undoableReducer(undone, { type: 'redo' }));
    expect(screen.getByTestId('underdog-panel')).toBeDefined();
    expect(note()).toBeNull();
  });

  it('hidden with the estimates when 推定勝率 is turned off', async () => {
    await new Repository(await openBackend()).replaceAll({
      teams: [],
      players: [],
      formats: [],
      pairs: [],
      orders: [],
      seasonCommits: [],
      settings: { ...DEFAULT_SETTINGS, n01: { ...DEFAULT_N01_SETTINGS, showPredictions: false } },
    });
    resetBackendCache();
    renderSession(sessionFor(scenario('underdog-low-order')));
    await waitFor(() => expect(screen.queryByTestId('opponent-panel')).toBeNull());
    expect(note()).toBeNull();
  });
});
