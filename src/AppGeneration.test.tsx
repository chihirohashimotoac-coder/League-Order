import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { IDBFactory } from 'fake-indexeddb';
import 'fake-indexeddb/auto';
import '@testing-library/jest-dom/vitest';
import { openBackend, resetBackendCache } from './storage/db';
import { DEFAULT_SETTINGS, Repository } from './storage/repository';
import { TEAM_A, TEAM_B, formatFor, renderApp, roster, seed } from './test/appHarness';
import { generateOrder } from './optimizer/generateOrder';
import { createVersion } from './domain/orders/lifecycle';
import { createParticipantConfig } from './domain/orders/participants';
import { DEFAULT_OPTIMIZER_SETTINGS, PRESETS } from './domain/orders/presets';
import type { GenerateResult, OrderInput } from './domain/types';

vi.mock('./pwa', () => ({ onUpdateAvailable: () => () => undefined, initServiceWorker: () => undefined }));

/**
 * Generation is asynchronous (a Web Worker in the browser). These tests hold every
 * request open and answer them by hand, so the order of events a captain can cause on a
 * slow phone — switch team, start over, open another order while a line-up is still being
 * computed — is reproduced exactly. A stale answer must never reach the screen, the
 * notifications, the spinner or storage, and an order is only ever saved under the team
 * whose players it holds.
 */

interface PendingRequest {
  input: OrderInput;
  resolve: (result: GenerateResult) => void;
  reject: (error: Error) => void;
}

const runner = vi.hoisted(() => ({ pending: [] as PendingRequest[] }));

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
});

type User = ReturnType<typeof userEvent.setup>;

const nav = (): HTMLElement => screen.getByRole('navigation', { name: 'メインナビゲーション' });

/** HOME → 新しいオーダーを作る → オーダーを生成: leaves one request open in the runner. */
async function startGeneration(user: User): Promise<PendingRequest> {
  const before = runner.pending.length;
  await user.click(within(nav()).getByRole('button', { name: 'ホーム' }));
  await user.click(await screen.findByRole('button', { name: '新しいオーダーを作る' }));
  const discard = screen.queryByRole('dialog', { name: '新しいオーダーを作る' });
  if (discard) await user.click(within(discard).getByRole('button', { name: '破棄して作成' }));
  await screen.findByRole('heading', { name: 'オーダー設定' });
  const generate = screen.getByRole('button', { name: /オーダーを生成|生成中/ });
  await waitFor(() => expect(generate).toBeEnabled());
  await user.click(generate);
  await waitFor(() => expect(runner.pending.length).toBe(before + 1));
  return runner.pending[runner.pending.length - 1];
}

async function switchTeam(user: User, name: string): Promise<void> {
  await user.click(within(nav()).getByRole('button', { name: 'ホーム' }));
  await user.click(await screen.findByRole('button', { name: '切替 / 管理' }));
  const sheet = await screen.findByRole('dialog', { name: 'チーム' });
  await user.click(within(sheet).getByRole('button', { name: new RegExp(`^${name}`) }));
  const confirm = screen.queryByRole('dialog', { name: 'チームを切り替える' });
  if (confirm) await user.click(within(confirm).getByRole('button', { name: '破棄して切り替える' }));
  await screen.findByRole('heading', { name, level: 1 });
}

/** Answers a request with a real line-up for its own input, tagged so it can be recognised. */
function answer(request: PendingRequest, tag: string): void {
  const result = generateOrder(request.input);
  if (!result.ok) throw new Error('fixture should be satisfiable');
  const candidates = result.candidates.map((candidate) => ({ ...candidate, meta: { ...candidate.meta, label: tag } }));
  act(() => request.resolve({ ...result, candidates }));
}

const storedOrders = async () => (await new Repository(await openBackend()).loadAll()).orders;

const fieldedNames = (): string[] =>
  [...document.querySelectorAll<HTMLSelectElement>('.order-game select')].map(
    (select) => select.selectedOptions[0]?.textContent ?? '',
  );

async function flush(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

describe('a generation that finishes after the team was switched', () => {
  it('is discarded: never shown, never saved under the other team, and the spinner is not stuck', async () => {
    await seed();
    const user = userEvent.setup();
    renderApp();
    await screen.findByRole('heading', { name: 'チームA', level: 1 });

    const stale = await startGeneration(user);
    expect(stale.input.teamId).toBe(TEAM_A);
    await switchTeam(user, 'チームB');

    answer(stale, 'STALE-A');
    await flush();

    // Still on HOME of team B: the old team's line-up did not open the result screen.
    expect(screen.queryByRole('heading', { name: 'オーダー結果' })).toBeNull();
    expect(screen.getByRole('heading', { name: 'チームB', level: 1 })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /作業中のオーダーを開く/ })).toBeNull();

    // Team B can generate straight away (no stuck "生成中…"), and its own result is shown.
    const fresh = await startGeneration(user);
    expect(fresh.input.teamId).toBe(TEAM_B);
    answer(fresh, 'FRESH-B');
    await screen.findByRole('heading', { name: 'オーダー結果' });
    expect(fieldedNames().every((name) => name === '' || name.startsWith('Bさん') || name === '—')).toBe(true);
    expect(fieldedNames().some((name) => name.startsWith('Aさん'))).toBe(false);

    await user.click(screen.getByRole('button', { name: '下書きを保存' }));
    await waitFor(async () => expect(await storedOrders()).toHaveLength(1));
    const [saved] = await storedOrders();
    expect(saved.teamId).toBe(TEAM_B);
    expect(saved.input.teamId).toBe(TEAM_B);
    expect(saved.solution.meta.label).toBe('FRESH-B');
    expect(saved.input.players.every((player) => player.teamId === TEAM_B)).toBe(true);
  }, 60_000);

  it('does not replace the other team’s result when the two answers arrive in reverse order', async () => {
    await seed();
    const user = userEvent.setup();
    renderApp();
    await screen.findByRole('heading', { name: 'チームA', level: 1 });

    const first = await startGeneration(user);
    await switchTeam(user, 'チームB');
    const second = await startGeneration(user);

    answer(second, 'FRESH-B');
    await screen.findByRole('heading', { name: 'オーダー結果' });
    answer(first, 'STALE-A');
    await flush();

    expect(screen.getByRole('heading', { name: 'オーダー結果' })).toBeInTheDocument();
    expect(fieldedNames().some((name) => name.startsWith('Aさん'))).toBe(false);
    await user.click(screen.getByRole('button', { name: '下書きを保存' }));
    await waitFor(async () => expect(await storedOrders()).toHaveLength(1));
    const [saved] = await storedOrders();
    expect(saved).toMatchObject({ teamId: TEAM_B, input: { teamId: TEAM_B } });
    expect(saved.solution.meta.label).toBe('FRESH-B');
  }, 60_000);
});

describe('a generation superseded on the same team', () => {
  it('keeps the newer request when the older one answers last', async () => {
    await seed();
    const user = userEvent.setup();
    renderApp();
    await screen.findByRole('heading', { name: 'チームA', level: 1 });

    const first = await startGeneration(user);
    // 新しいオーダーを作る while the first is still running starts over.
    const second = await startGeneration(user);

    answer(second, 'NEWER');
    await screen.findByRole('heading', { name: 'オーダー結果' });
    answer(first, 'OLDER');
    await flush();

    await user.click(screen.getByRole('button', { name: '下書きを保存' }));
    await waitFor(async () => expect(await storedOrders()).toHaveLength(1));
    expect((await storedOrders())[0].solution.meta.label).toBe('NEWER');
  }, 60_000);

  it('ignores a failure of the superseded request: no error toast, the spinner follows the live request', async () => {
    await seed();
    const user = userEvent.setup();
    renderApp();
    await screen.findByRole('heading', { name: 'チームA', level: 1 });

    const first = await startGeneration(user);
    const second = await startGeneration(user);

    act(() => first.reject(new Error('worker crashed')));
    await flush();
    expect(screen.queryByText(/生成に失敗しました/)).toBeNull();
    // The live request is still running.
    expect(screen.getByRole('button', { name: /生成中/ })).toBeDisabled();

    answer(second, 'LIVE');
    await screen.findByRole('heading', { name: 'オーダー結果' });
  }, 60_000);

  it('ignores a "no solution" answer of the superseded request', async () => {
    await seed();
    const user = userEvent.setup();
    renderApp();
    await screen.findByRole('heading', { name: 'チームA', level: 1 });

    const first = await startGeneration(user);
    const second = await startGeneration(user);
    answer(second, 'LIVE');
    await screen.findByRole('heading', { name: 'オーダー結果' });

    act(() => first.resolve({ ok: false, diagnostics: [{ code: 'TEST', message: '古い要求の診断' }] } as never));
    await flush();
    expect(screen.queryByText(/条件を満たすオーダーがありません/)).toBeNull();
    expect(screen.queryByText('古い要求の診断')).toBeNull();
  }, 60_000);

  it('a live failure is still reported', async () => {
    await seed();
    const user = userEvent.setup();
    renderApp();
    await screen.findByRole('heading', { name: 'チームA', level: 1 });

    const only = await startGeneration(user);
    act(() => only.reject(new Error('worker crashed')));
    expect(await screen.findByText(/生成に失敗しました: worker crashed/)).toBeInTheDocument();
    await waitFor(() => expect(screen.getByRole('button', { name: 'オーダーを生成' })).toBeEnabled());
  }, 60_000);
});

describe('a generation that finishes after a saved order was opened', () => {
  it('does not overwrite the opened order', async () => {
    await seed();
    const user = userEvent.setup();
    renderApp();
    await screen.findByRole('heading', { name: 'チームA', level: 1 });

    // Make and save one order first.
    const saved = await startGeneration(user);
    answer(saved, 'SAVED');
    await screen.findByRole('heading', { name: 'オーダー結果' });
    await user.click(screen.getByRole('button', { name: '下書きを保存' }));
    await waitFor(async () => expect(await storedOrders()).toHaveLength(1));

    const pending = await startGeneration(user);
    await user.click(within(nav()).getByRole('button', { name: '履歴' }));
    await user.click(await screen.findByRole('button', { name: /SAVED/ }));
    await user.click(await screen.findByRole('button', { name: 'このオーダーを開いて編集' }));
    await screen.findByRole('heading', { name: 'オーダー結果' });

    answer(pending, 'LATE');
    await flush();
    await user.click(screen.getByRole('button', { name: '下書きを保存' }));
    await flush();
    const orders = await storedOrders();
    expect(orders).toHaveLength(1);
    expect(orders[0].solution.meta.label).toBe('SAVED');
  }, 60_000);
});

describe('a generation that finishes after the app was closed', () => {
  it('writes nothing', async () => {
    await seed();
    const user = userEvent.setup();
    const view = renderApp();
    await screen.findByRole('heading', { name: 'チームA', level: 1 });
    const pending = await startGeneration(user);
    view.unmount();
    answer(pending, 'AFTER-UNMOUNT');
    await flush();
    expect(await storedOrders()).toHaveLength(0);
  }, 60_000);
});

describe('an order record whose team does not match its line-up (written by the old race)', () => {
  it.each([false, true])('can still be opened, but saving, finalizing and season totals refuse to write (finalized: %s)', async (finalized) => {
    await seed();
    // What the race used to store: listed under team B, holding team A's input and players.
    const input: OrderInput = {
      teamId: TEAM_A,
      formatId: `${TEAM_A}_fmt`,
      games: formatFor(TEAM_A).games,
      players: roster(TEAM_A, 'Aさん'),
      participants: roster(TEAM_A, 'Aさん').map((player) => createParticipantConfig(player.id)),
      pairs: [],
      locks: [],
      preset: 'BALANCED',
      weights: PRESETS.BALANCED.weights,
      settings: DEFAULT_OPTIMIZER_SETTINGS,
      discipline: 'SOFT',
    };
    const result = generateOrder(input);
    if (!result.ok) throw new Error('fixture should be satisfiable');
    const match = { leagueName: '', teamName: 'チームB', opponentName: '', matchDate: '' };
    const repository = new Repository(await openBackend());
    await repository.saveOrder({
      id: 'ord_mixed',
      teamId: TEAM_B,
      title: '混在したオーダー',
      createdAt: 1,
      updatedAt: 1,
      input,
      solution: result.candidates[0],
      match,
      versions: finalized ? [createVersion(input, result.candidates[0], match, [], 1)] : [],
      seasonApplied: false,
    });
    await repository.saveSettings({ ...DEFAULT_SETTINGS, activeTeamId: TEAM_B });
    resetBackendCache();

    const user = userEvent.setup();
    renderApp();
    await screen.findByRole('heading', { name: 'チームB', level: 1 });
    await user.click(within(nav()).getByRole('button', { name: '履歴' }));
    await user.click(await screen.findByRole('button', { name: /混在したオーダー/ }));
    await user.click(await screen.findByRole('button', { name: 'このオーダーを開いて編集' }));
    await screen.findByRole('heading', { name: 'オーダー結果' });

    if (finalized) {
      await user.click(screen.getByRole('button', { name: /シーズン累計へ反映/ }));
      await user.click(within(await screen.findByRole('dialog', { name: 'シーズン累計へ反映' })).getByRole('button', { name: '反映する' }));
      expect(await screen.findByText(/シーズン累計へ反映できません/)).toBeInTheDocument();
    } else {
      await user.click(screen.getByRole('button', { name: '下書きを保存' }));
      expect(await screen.findByText(/別のチームの条件で作られたため/)).toBeInTheDocument();
      await user.click(screen.getByRole('button', { name: /オーダーを確定/ }));
      expect(await screen.findByText(/確定できません: このオーダーは別のチーム/)).toBeInTheDocument();
    }

    const stored = await new Repository(await openBackend()).loadAll();
    expect(stored.orders).toHaveLength(1);
    expect(stored.orders[0]).toMatchObject({ id: 'ord_mixed', teamId: TEAM_B, updatedAt: 1, seasonApplied: false });
    expect(stored.orders[0].versions).toHaveLength(finalized ? 1 : 0);
    expect(stored.orders[0].input.teamId).toBe(TEAM_A);
    expect(stored.seasonCommits).toHaveLength(0);
    expect(stored.players.every((player) => player.seasonAppearances === 0)).toBe(true);
  }, 60_000);
});
