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
import { createMatchInfo } from '../domain/types';
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
}: {
  onState?: (state: UndoableState) => void;
}): React.JSX.Element {
  const games = sampleFormatGames();
  const input = orderInput(sampleRoster(), games);
  const result = generateOrder(input);
  if (!result.ok) throw new Error('fixture should be satisfiable');

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

function renderResult(onState?: (state: UndoableState) => void) {
  return render(
    <ToastProvider>
      <AppStoreProvider>
        <Harness onState={onState} />
      </AppStoreProvider>
    </ToastProvider>,
  );
}

describe('ResultPage', () => {
  it('renders every game, the tally table and the reasons', async () => {
    renderResult();
    const games = sampleFormatGames();

    for (const game of games) {
      expect(screen.getAllByText(game.name).length).toBeGreaterThan(0);
    }
    expect(screen.getByText('集計')).toBeDefined();
    expect(screen.getByText('生成理由')).toBeDefined();
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
    expect(screen.getByText('Hard制約に違反しています')).toBeDefined();
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

    const tabs = screen.queryAllByRole('button', { name: /^[A-C]:/ });
    if (tabs.length < 2) return;
    await user.click(tabs[1]);
    expect(latest!.present.selectedCandidate).toBe(1);
  });

  it('renders the appearance tally for every participant', () => {
    renderResult();
    const table = screen.getByRole('table');
    for (const p of sampleRoster()) {
      expect(within(table).getByText(p.name)).toBeDefined();
    }
  });
});
