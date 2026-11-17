import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { IDBFactory } from 'fake-indexeddb';
import 'fake-indexeddb/auto';
import '@testing-library/jest-dom/vitest';
import { resetBackendCache } from './storage/db';
import { renderApp, seed } from './test/appHarness';
import { generateOrder } from './optimizer/generateOrder';
import { PRESETS } from './domain/orders/presets';
import type { GenerateResult, OrderInput } from './domain/types';
import type { OpponentContext } from './domain/prediction/opponentContext';
import type * as SetupPageModule from './pages/SetupPage';

vi.mock('./pwa', () => ({ onUpdateAvailable: () => () => undefined, initServiceWorker: () => undefined }));

/**
 * The underdog note through the real app shell (docs/UNDERDOG_PLAN.md §4.1): the engine's status
 * travels from a generation into the session with its candidates; オーダー設定を開く goes to SETUP
 * with the order's conditions and generates nothing; a failed attempt never changes the reason
 * shown for the order kept on screen, and a later result without a status clears it.
 */

interface PendingRequest {
  input: OrderInput;
  resolve: (result: GenerateResult) => void;
  reject: (error: Error) => void;
}

const runner = vi.hoisted(() => ({ pending: [] as PendingRequest[] }));
/**
 * Whether SETUP can offer 対戦相手最適化. The harness teams are manual (no n01 analysis), so the
 * analysis check App passes to the result screen is set here; SETUP's own list is not affected.
 */
const availability = vi.hoisted(() => ({ value: true }));

vi.mock('./pages/SetupPage', async (original) => ({
  ...(await original<typeof SetupPageModule>()),
  hasNextOpponent: () => availability.value,
}));

vi.mock('./optimizer/runner', () => ({
  createRunner: () => ({
    mode: 'sync' as const,
    generate: (input: OrderInput) =>
      new Promise<GenerateResult>((resolve, reject) => {
        runner.pending.push({ input, resolve, reject });
      }),
    dispose: () => undefined,
  }),
}));

afterEach(cleanup);

beforeEach(() => {
  window.scrollTo = vi.fn() as never;
  globalThis.indexedDB = new IDBFactory();
  resetBackendCache();
  runner.pending.length = 0;
  availability.value = true;
});

type User = ReturnType<typeof userEvent.setup>;

const nav = (): HTMLElement => screen.getByRole('navigation', { name: 'メインナビゲーション' });

/** An opponent far stronger in every game of the harness format (≈ a few % for the match). */
function strongOpponent(input: OrderInput, orderConfidence: 'MEDIUM' | 'LOW'): OpponentContext {
  return {
    version: 2,
    generatedAt: 0,
    matchId: 'm',
    matchDate: '2026-10-20',
    opponentName: '強豪チーム',
    leagueMeanPpr: 52,
    players: Object.fromEntries(
      input.players.map((p) => [p.id, { strength: 42, confidence: 'HIGH', legs: 60, imputed: false, formAdjustment: 0, first9Adjustment: 0, first9Excess: null }]),
    ),
    games: Object.fromEntries(
      input.games.map((game) => [
        game.id,
        { gameId: game.id, signature: game.id, numPart: game.playerCount, legsToWin: 2, cricket: false, likely: [], samples: 8, confidence: 'MEDIUM', sides: [{ strength: 70, probability: 1 }] },
      ]),
    ),
    orderConfidence,
    confidence: 'MEDIUM',
  } as OpponentContext;
}

/** Answers with a real generation for the request's own players against that opponent. */
function answer(request: PendingRequest, preset: 'WIN_FIRST' | 'OPPONENT_OPTIMIZED', orderConfidence: 'MEDIUM' | 'LOW' = 'MEDIUM'): GenerateResult {
  const input: OrderInput = { ...request.input, preset, weights: { ...PRESETS[preset].weights }, opponent: strongOpponent(request.input, orderConfidence) };
  const result = generateOrder(input, { timeLimitMs: 3000 });
  if (!result.ok) throw new Error('fixture should be satisfiable');
  act(() => request.resolve(result));
  return result;
}

async function generateFromSetup(user: User): Promise<PendingRequest> {
  const before = runner.pending.length;
  const generate = screen.getByRole('button', { name: /オーダーを生成|生成中/ });
  await waitFor(() => expect(generate).toBeEnabled());
  await user.click(generate);
  await waitFor(() => expect(runner.pending.length).toBe(before + 1));
  return runner.pending[runner.pending.length - 1];
}

async function openSetup(user: User): Promise<void> {
  await user.click(within(nav()).getByRole('button', { name: 'ホーム' }));
  await user.click(await screen.findByRole('button', { name: 'オーダーを作る' }));
  await screen.findByRole('heading', { name: 'オーダー設定' });
}

const note = () => screen.queryByTestId('underdog-note');

describe('the underdog note in the app', () => {
  it('勝利優先 ≤ 20%: オーダー設定を開く restores the order\'s conditions and generates nothing', async () => {
    await seed();
    const user = userEvent.setup();
    renderApp();
    await screen.findByRole('heading', { name: 'チームA', level: 1 });
    await openSetup(user);
    // A condition of this order: Aさん4 sits out.
    await user.click(screen.getByRole('checkbox', { name: 'Aさん4 を参加者に含める' }));
    const presetBefore = checkedPreset();
    const request = await generateFromSetup(user);
    expect(request.input.participants.find((config) => config.playerId.endsWith('_p4'))?.include).toBe(false);
    answer(request, 'WIN_FIRST');
    await screen.findByRole('heading', { name: 'オーダー結果' });

    // SETUP is changed afterwards without generating (Aさん4 back in), then the order is reopened.
    await openSetupFromBar(user);
    await user.click(screen.getByRole('checkbox', { name: 'Aさん4 を参加者に含める' }));
    expect(screen.getByRole('checkbox', { name: 'Aさん4 を参加者に含める' })).toBeChecked();
    await user.click(within(nav()).getByRole('button', { name: 'オーダー' }));
    await screen.findByRole('heading', { name: 'オーダー結果' });

    const hint = await screen.findByTestId('underdog-note');
    expect(hint).toHaveAttribute('data-kind', 'other-preset');
    expect(hint).toHaveTextContent('格上対策は「対戦相手最適化」で確認できます');
    await user.click(within(hint).getByRole('button', { name: 'オーダー設定を開く' }));

    await screen.findByRole('heading', { name: 'オーダー設定' });
    // The conditions are the order's own, nothing was generated and the preset was not chosen.
    expect(screen.getByRole('checkbox', { name: 'Aさん4 を参加者に含める' })).not.toBeChecked();
    expect(checkedPreset()).toBe(presetBefore);
    await flush();
    expect(runner.pending.length).toBe(1);
  });

  it('no analysis for the next match: no note to a preset SETUP cannot offer', async () => {
    availability.value = false;
    await seed();
    const user = userEvent.setup();
    renderApp();
    await screen.findByRole('heading', { name: 'チームA', level: 1 });
    await openSetup(user);
    answer(await generateFromSetup(user), 'WIN_FIRST');
    await screen.findByRole('heading', { name: 'オーダー結果' });
    expect(await screen.findByTestId('estimated-match-win')).toBeInTheDocument();
    expect(note()).toBeNull();
  });

  it('a failed attempt keeps the kept order\'s own reason; a result without a status clears it', async () => {
    await seed();
    const user = userEvent.setup();
    renderApp();
    await screen.findByRole('heading', { name: 'チームA', level: 1 });
    await openSetup(user);
    answer(await generateFromSetup(user), 'OPPONENT_OPTIMIZED', 'LOW');
    const hint = await screen.findByTestId('underdog-note');
    expect(hint).toHaveAttribute('data-kind', 'skipped');
    expect(hint).toHaveTextContent('相手データの信頼度が低いため');

    // A failed attempt: the previous order stays with its own reason, unchanged.
    await openSetupFromBar(user);
    const failing = await generateFromSetup(user);
    act(() => failing.resolve({ ok: false, candidates: [], diagnostics: [{ code: 'SEARCH_EXHAUSTED', message: 'テスト用の診断', suggestions: [] }] }));
    await screen.findByText('テスト用の診断');
    expect(screen.getByTestId('underdog-note')).toHaveTextContent('相手データの信頼度が低いため');

    // The next successful result has no status (another preset): nothing is carried over.
    await openSetupFromBar(user);
    const next = await generateFromSetup(user);
    const plain = generateOrder(next.input, { timeLimitMs: 3000 });
    if (!plain.ok) throw new Error('fixture should be satisfiable');
    act(() => next.resolve(plain));
    await waitFor(() => expect(screen.queryByText('テスト用の診断')).toBeNull());
    expect(note()).toBeNull();
    // Undo returns the earlier order together with its reason.
    await user.click(screen.getByRole('button', { name: '元に戻す' }));
    expect(screen.getByTestId('underdog-note')).toHaveTextContent('相手データの信頼度が低いため');
  });
});

/** The オーダー tab opens the working order; its breadcrumb goes back to SETUP as it is. */
async function openSetupFromBar(user: User): Promise<void> {
  await user.click(within(nav()).getByRole('button', { name: 'オーダー' }));
  await screen.findByRole('heading', { name: 'オーダー結果' });
  const crumbs = screen.getByRole('navigation', { name: 'パンくずリスト' });
  await user.click(within(crumbs).getByRole('button', { name: 'オーダー設定' }));
  await screen.findByRole('heading', { name: 'オーダー設定' });
}

function checkedPreset(): string {
  const radio = screen.getAllByRole('radio').find((element) => element.getAttribute('aria-checked') === 'true' || (element as HTMLInputElement).checked);
  return radio?.textContent ?? '';
}

async function flush(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}
