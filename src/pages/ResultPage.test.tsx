import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useReducer } from 'react';
import { ResultPage } from './ResultPage';
import { AppStoreProvider } from '../state/appStore';
import { ToastProvider } from '../components/ui';
import { createUndoable, undoableReducer, type UndoableState } from '../state/orderSession';
import { generateOrder } from '../optimizer/generateOrder';
import { orderInput, sampleFormatGames, sampleRoster } from '../test/factories';
import { createMatchInfo, type OrderLifecycleState, type SavedOrder } from '../domain/types';
import { createVersion } from '../domain/orders/lifecycle';
import 'fake-indexeddb/auto';

/**
 * Component test for the RESULT screen.
 *
 * Covers the interactions the spec calls out specifically: manual edits must re-evaluate
 * live (§15), undo must restore the previous state (§16), and locks must be toggleable
 * per slot (§14).
 */

// Vitest runs without global injection here, so Testing Library's own auto-cleanup hook
// is not registered; without this the DOM accumulates across tests.
afterEach(cleanup);

beforeAll(() => {
  // jsdom has no canvas; the share sheet degrades gracefully and is not under test here.
  HTMLCanvasElement.prototype.getContext = vi.fn(() => null) as never;
});

function Harness({
  onState,
  lifecycle = 'DRAFT',
}: {
  onState?: (state: UndoableState) => void;
  lifecycle?: OrderLifecycleState;
}): React.JSX.Element {
  const games = sampleFormatGames();
  const input = orderInput(sampleRoster(), games);
  const result = generateOrder(input);
  if (!result.ok) throw new Error('fixture should be satisfiable');
  const match = createMatchInfo('テストチーム');
  // A finalized v1 for the FINALIZED / UPDATED cases; the page reads only its versions.
  const record: SavedOrder | null =
    lifecycle === 'DRAFT'
      ? null
      : {
          id: 'ord_test',
          teamId: input.teamId,
          title: 'test',
          createdAt: 0,
          updatedAt: 0,
          input,
          solution: result.candidates[0],
          match,
          versions: [createVersion(input, result.candidates[0], match, [], 0)],
          seasonApplied: false,
        };

  const [session, dispatch] = useReducer(
    undoableReducer,
    undoableReducer(createUndoable(input), { type: 'generated', candidates: result.candidates }),
  );
  onState?.(session);

  return (
    <ResultPage
      session={session}
      dispatch={dispatch}
      games={games}
      diagnostics={[]}
      generating={false}
      match={match}
      onMatchChange={() => undefined}
      onRegenerate={() => undefined}
      onReoptimise={() => undefined}
      record={record}
      lifecycle={lifecycle}
      seasonStatus="none"
      onFinalize={() => undefined}
      onSaveDraft={() => undefined}
      onCommitSeason={() => undefined}
      onWithdrawSeason={() => undefined}
    />
  );
}

function renderResult(onState?: (state: UndoableState) => void, lifecycle?: OrderLifecycleState) {
  return render(
    <ToastProvider>
      <AppStoreProvider>
        <Harness onState={onState} lifecycle={lifecycle} />
      </AppStoreProvider>
    </ToastProvider>,
  );
}

/** The fixed action bar's primary (filled) button. */
function primaryAction(container: HTMLElement): HTMLElement {
  const button = container.querySelector<HTMLElement>('.action-bar .btn.primary');
  if (!button) throw new Error('no primary action');
  return button;
}

describe('ResultPage', () => {
  it('renders every game, the appearance summary and the reasons', async () => {
    renderResult();
    const games = sampleFormatGames();

    for (const game of games) {
      expect(screen.getAllByText(game.name).length).toBeGreaterThan(0);
    }
    expect(screen.getByText('出場回数')).toBeDefined();
    // Analysis is collapsed but still present.
    expect(screen.getByText('生成理由')).toBeDefined();
    expect(screen.getByText('詳細分析')).toBeDefined();
    // One select per slot.
    const totalSlots = games.reduce((acc, game) => acc + game.playerCount, 0);
    expect(screen.getAllByRole('combobox')).toHaveLength(totalSlots);
  });

  it('re-evaluates the tally immediately after a manual change (spec §15)', async () => {
    const user = userEvent.setup();
    let latest: UndoableState | null = null;
    renderResult((state) => {
      latest = state;
    });

    const slot = screen.getByLabelText('Game 1 Singles 501 のスロット 1');
    const before = latest!.present.current!.tallies.find((t) => t.playerId === 'p5')!.count;
    await user.selectOptions(slot, 'p5');

    const after = latest!.present.current!.tallies.find((t) => t.playerId === 'p5')!.count;
    expect(latest!.present.edited).toBe(true);
    expect(after).toBeGreaterThan(before);
    expect(screen.getByText('手動編集中です。数値は編集内容で再計算されています。')).toBeDefined();
  });

  it('shows a hard-constraint violation when a slot is emptied', async () => {
    const user = userEvent.setup();
    renderResult();
    await user.selectOptions(screen.getByLabelText('Game 1 Singles 501 のスロット 1'), '');
    expect(screen.getByText('絶対条件に違反しています')).toBeDefined();
    // A line-up that breaks an absolute condition cannot be finalized.
    expect((screen.getByRole('button', { name: /オーダーを確定/ }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('undoes a manual change (spec §16)', async () => {
    const user = userEvent.setup();
    let latest: UndoableState | null = null;
    renderResult((state) => {
      latest = state;
    });

    const slot = screen.getByLabelText('Game 1 Singles 501 のスロット 1') as HTMLSelectElement;
    const original = slot.value;
    await user.selectOptions(slot, 'p5');
    expect((screen.getByLabelText('Game 1 Singles 501 のスロット 1') as HTMLSelectElement).value).toBe('p5');

    await user.click(screen.getByLabelText('元に戻す'));
    expect((screen.getByLabelText('Game 1 Singles 501 のスロット 1') as HTMLSelectElement).value).toBe(original);
    expect(latest!.present.edited).toBe(false);
  });

  it('locks a slot and disables its select (spec §14)', async () => {
    const user = userEvent.setup();
    let latest: UndoableState | null = null;
    renderResult((state) => {
      latest = state;
    });

    const toggle = screen.getByLabelText('Game 1 Singles 501 スロット 1 のロック');
    await user.click(toggle);

    expect(latest!.present.input.locks).toHaveLength(1);
    expect((screen.getByLabelText('Game 1 Singles 501 のスロット 1') as HTMLSelectElement).disabled).toBe(true);
    expect(screen.getByLabelText('Game 1 Singles 501 スロット 1 のロック').getAttribute('aria-pressed')).toBe('true');
  });

  it('switches between candidates', async () => {
    const user = userEvent.setup();
    let latest: UndoableState | null = null;
    renderResult((state) => {
      latest = state;
    });

    const tabs = screen.queryAllByRole('button', { name: /^候補 [A-C]:/ });
    if (tabs.length < 2) return;
    await user.click(tabs[1]);
    expect(latest!.present.selectedCandidate).toBe(1);
  });

  it('renders the appearance tally for every participant', () => {
    renderResult();
    const list = screen.getByRole('list', { name: '選手ごとの出場回数' });
    for (const p of sampleRoster()) {
      expect(within(list).getByText(p.name)).toBeDefined();
    }
  });

  it('makes finalizing the primary action of a draft (§28)', () => {
    const { container } = renderResult(undefined, 'DRAFT');
    expect(primaryAction(container).textContent).toContain('オーダーを確定 v1');
    // Sharing a draft is still possible, but never the primary action.
    expect(screen.getByRole('button', { name: /^共有$/ }).classList.contains('primary')).toBe(false);
  });

  it('makes re-finalizing the primary action of an updated order (§29)', () => {
    const { container } = renderResult(undefined, 'UPDATED');
    expect(primaryAction(container).textContent).toContain('再確定 v2');
    expect(screen.getByRole('button', { name: '変更点を確認' })).toBeDefined();
    expect(screen.getByRole('button', { name: /^共有$/ }).classList.contains('primary')).toBe(false);
  });

  it('makes sharing the primary action once finalized (§30)', () => {
    const { container } = renderResult(undefined, 'FINALIZED');
    expect(primaryAction(container).textContent).toContain('共有');
    expect(screen.queryByRole('button', { name: /オーダーを確定|再確定/ })).toBeNull();
    // Exactly one share entry point.
    expect(screen.getAllByRole('button', { name: /^共有$/ })).toHaveLength(1);
  });

  it('switching candidates changes the game cards, not just the pressed tab', async () => {
    const user = userEvent.setup();
    let latest: UndoableState | null = null;
    renderResult((state) => {
      latest = state;
    });

    const tabs = screen.getAllByRole('button', { name: /^候補 [A-Z]/ });
    expect(tabs.length).toBeGreaterThan(1);
    const games = sampleFormatGames();
    const shown: string[] = [];
    for (const [index, tab] of tabs.entries()) {
      await user.click(tab);
      expect(tab.getAttribute('aria-pressed')).toBe('true');
      const candidate = latest!.present.candidates[index];
      const expected = games.flatMap(
        (game) => candidate.assignments.find((entry) => entry.gameId === game.id)!.playerIds,
      );
      const values = screen.getAllByRole('combobox').map((select) => (select as HTMLSelectElement).value);
      // The cards show exactly the selected candidate's line-up.
      expect(values).toEqual(expected);
      shown.push(values.join(','));
    }
    // Candidates are distinct line-ups, so the cards really changed between them.
    expect(new Set(shown).size).toBe(tabs.length);
  });

  it('states what "strong" meant for this order', () => {
    renderResult();
    const basis = screen.getByTestId('result-strength-basis');
    expect(basis.textContent).toContain('戦力評価 Rating 100%');
    expect(basis.textContent).toContain('未設定');
  });
});
