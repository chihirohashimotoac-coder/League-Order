import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { IDBFactory } from 'fake-indexeddb';
import 'fake-indexeddb/auto';
import '@testing-library/jest-dom/vitest';
import { openBackend, resetBackendCache } from './storage/db';
import { Repository } from './storage/repository';
import { TEAM_A, TEAM_B, formatFor, renderApp, roster } from './test/appHarness';
import { DEFAULT_SETTINGS } from './storage/repository';
import type { GenerateResult, LeagueFormat, OrderInput } from './domain/types';

vi.mock('./pwa', () => ({ onUpdateAvailable: () => () => undefined, initServiceWorker: () => undefined }));

/** Every generation the app asks for, answered by the real engine (synchronously, short budget). */
const runner = vi.hoisted(() => ({ inputs: [] as OrderInput[] }));
vi.mock('./optimizer/runner', async () => {
  const { generateOrder } = await import('./optimizer/generateOrder');
  return {
    createRunner: () => ({
      mode: 'sync' as const,
      generate: async (input: OrderInput, options?: { candidateCount?: number }): Promise<GenerateResult> => {
        runner.inputs.push(input);
        return generateOrder(input, { ...options, timeLimitMs: 400 });
      },
      dispose: () => undefined,
    }),
  };
});

afterEach(cleanup);
beforeEach(() => {
  window.scrollTo = vi.fn() as never;
  globalThis.indexedDB = new IDBFactory();
  resetBackendCache();
  runner.inputs.length = 0;
});

type User = ReturnType<typeof userEvent.setup>;
const nav = (): HTMLElement => screen.getByRole('navigation', { name: 'メインナビゲーション' });

async function seedWith(format: LeagueFormat): Promise<void> {
  await new Repository(await openBackend()).replaceAll({
    teams: [
      { id: TEAM_A, name: 'チームA', createdAt: 1 },
      { id: TEAM_B, name: 'チームB', createdAt: 2 },
    ],
    players: [...roster(TEAM_A, 'Aさん'), ...roster(TEAM_B, 'Bさん')],
    formats: [format, formatFor(TEAM_B)],
    pairs: [],
    orders: [],
    seasonCommits: [],
    settings: { ...DEFAULT_SETTINGS, activeTeamId: TEAM_A },
  });
  resetBackendCache();
}

async function openSetup(user: User): Promise<void> {
  await user.click(within(nav()).getByRole('button', { name: 'ホーム' }));
  await user.click(await screen.findByRole('button', { name: '新しいオーダーを作る' }));
  await screen.findByRole('heading', { name: 'オーダー設定' });
}

describe('league rules in the app', () => {
  it('format editor: blank is no rule, 0 is allowed, an invalid cap is refused, a valid one is saved', async () => {
    await seedWith(formatFor(TEAM_A));
    const user = userEvent.setup();
    renderApp();
    await screen.findByRole('navigation', { name: 'メインナビゲーション' });
    await user.click(within(nav()).getByRole('button', { name: /フォーマット/ }));
    await user.click(await screen.findByText('テスト 3ゲーム'));
    const editor = await screen.findByTestId('league-rules-editor');
    await user.click(within(editor).getByText('リーグ規則 (必須条件)'));
    expect(within(editor).getByTestId('rule-counting-note')).toHaveTextContent('総出場は 1 回のまま');
    // Only the categories the format plays are offered: Singles, Doubles and 01.
    expect(within(editor).getByLabelText('Singles')).toBeInTheDocument();
    expect(within(editor).queryByLabelText('Trios')).not.toBeInTheDocument();

    await user.type(within(editor).getByLabelText('Singles'), '-1');
    expect(within(editor).getByRole('alert')).toHaveTextContent('0 以上の整数');
    await user.click(screen.getByRole('button', { name: '保存' }));
    expect(await screen.findByText(/リーグ規則: 0 以上の整数/)).toBeInTheDocument();
    expect(screen.queryByTestId('format-rules-tag')).not.toBeInTheDocument();

    await user.clear(within(editor).getByLabelText('Singles'));
    await user.type(within(editor).getByLabelText('Singles'), '1');
    await user.type(within(editor).getByLabelText('同じ2人の組'), '0');
    await user.click(screen.getByRole('button', { name: '保存' }));
    expect(await screen.findByTestId('format-rules-tag')).toHaveTextContent('リーグ規則');
    const stored = (await new Repository(await openBackend()).loadAll()).formats.find((f) => f.id === `${TEAM_A}_fmt`);
    expect(stored?.leagueRules).toEqual({ maxPerStructure: { SINGLES: 1 }, maxSameDoublesPair: 0 });
  });

  it('setup → generate → hand edit that breaks a rule → finalize is refused', async () => {
    await seedWith({ ...formatFor(TEAM_A), leagueRules: { maxPerStructure: { SINGLES: 1 }, maxHelpers: 1 } });
    const user = userEvent.setup();
    renderApp();
    await screen.findByRole('navigation', { name: 'メインナビゲーション' });
    await openSetup(user);

    // The rules are on SETUP, as hard conditions, and the helper cap asks for every status.
    expect(screen.getByTestId('league-rules-summary')).toHaveTextContent('Singles: 1人 1 回まで');
    const notice = screen.getByTestId('league-status-notice');
    expect(notice).toHaveTextContent('未設定');
    await user.click(screen.getByRole('button', { name: /オーダーを生成/ }));
    expect(await screen.findByText(/大会資格が未設定の参加者がいます/)).toBeInTheDocument();
    expect(runner.inputs).toHaveLength(0);

    await user.click(within(notice).getByRole('button', { name: '名簿メンバーを正規登録にする' }));
    expect(screen.queryByTestId('league-status-notice')).not.toBeInTheDocument();
    expect(screen.getAllByTestId('league-status-tag')[0]).toHaveTextContent('大会: 正規登録');
    await user.click(screen.getByRole('button', { name: /オーダーを生成/ }));
    await waitFor(() => expect(runner.inputs).toHaveLength(1));
    // The order carries its own copy of the rules and the statuses.
    expect(runner.inputs[0].leagueRules).toEqual({ maxPerStructure: { SINGLES: 1 }, maxHelpers: 1 });
    expect(runner.inputs[0].participants.every((c) => c.leagueStatus === 'REGULAR')).toBe(true);

    const panel = await screen.findByTestId('league-rules-panel');
    expect(within(panel).getByTestId('rules-status')).toHaveTextContent('すべて満たしています');
    const finalize = screen.getByRole('button', { name: /オーダーを確定/ });
    expect(finalize).toBeEnabled();

    // Put Game 1's Singles player in Game 3 as well: two Singles against a cap of one.
    const g1 = screen.getByRole('combobox', { name: 'Game 1 Singles 01 のスロット 1' }) as HTMLSelectElement;
    await user.selectOptions(screen.getByRole('combobox', { name: 'Game 3 Singles 01 のスロット 1' }), g1.value);
    expect(within(panel).getByTestId('rules-status')).toHaveTextContent('違反');
    expect(screen.getByRole('alert', { name: '' })).toHaveTextContent(/Singles の出場上限 1 回/);
    expect(screen.getByRole('button', { name: /オーダーを確定/ })).toBeDisabled();

    // Undo brings back the legal order, which can be finalized; the version keeps the rules.
    await user.click(screen.getByRole('button', { name: '元に戻す' }));
    expect(within(panel).getByTestId('rules-status')).toHaveTextContent('すべて満たしています');
    await user.click(screen.getByRole('button', { name: /オーダーを確定/ }));
    expect(await screen.findByText('v1 として確定しました')).toBeInTheDocument();
    const saved = (await new Repository(await openBackend()).loadAll()).orders[0];
    expect(saved.versions[0].leagueRules).toEqual({ maxPerStructure: { SINGLES: 1 }, maxHelpers: 1 });
  });

  it('a format without rules shows nothing of them and asks nothing', async () => {
    await seedWith(formatFor(TEAM_A));
    const user = userEvent.setup();
    renderApp();
    await screen.findByRole('navigation', { name: 'メインナビゲーション' });
    await openSetup(user);
    expect(screen.queryByTestId('league-rules-summary')).not.toBeInTheDocument();
    expect(screen.queryByTestId('league-status-notice')).not.toBeInTheDocument();
    expect(screen.queryByTestId('league-status-tag')).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /オーダーを生成/ }));
    await waitFor(() => expect(runner.inputs).toHaveLength(1));
    expect('leagueRules' in runner.inputs[0]).toBe(false);
    await screen.findByRole('button', { name: /オーダーを確定/ });
    expect(screen.queryByTestId('league-rules-panel')).not.toBeInTheDocument();
  });
});
