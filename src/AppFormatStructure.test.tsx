import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { IDBFactory } from 'fake-indexeddb';
import 'fake-indexeddb/auto';
import '@testing-library/jest-dom/vitest';
import { openBackend, resetBackendCache } from './storage/db';
import { Repository } from './storage/repository';
import { TEAM_A, renderApp, roster, seed } from './test/appHarness';
import { generateOrder } from './optimizer/generateOrder';
import { createParticipantConfig } from './domain/orders/participants';
import { DEFAULT_OPTIMIZER_SETTINGS, PRESETS } from './domain/orders/presets';
import type { LeagueFormat, OrderInput, SavedOrder } from './domain/types';

vi.mock('./pwa', () => ({ onUpdateAvailable: () => () => undefined, initServiceWorker: () => undefined }));

/**
 * A format whose games contradict themselves (two player-count kinds, a two-player
 * Singles) — possible before the editor separated the two — is kept exactly as stored,
 * flagged with what is wrong, and not generated or finalized until it is corrected.
 * Orders made with it stay viewable.
 */

afterEach(cleanup);

beforeEach(() => {
  window.scrollTo = vi.fn() as never;
  globalThis.indexedDB = new IDBFactory();
  resetBackendCache();
});

const LEGACY: LeagueFormat = {
  id: 'fmt_legacy',
  teamId: TEAM_A,
  name: '古いフォーマット',
  discipline: 'SOFT',
  games: [
    { id: 'lg1', order: 1, name: 'Singles 01', kinds: ['SINGLES', 'G501'], playerCount: 2 },
    { id: 'lg2', order: 2, name: 'Mixed', kinds: ['SINGLES', 'DOUBLES', 'G501'], playerCount: 2 },
    { id: 'lg3', order: 3, name: 'Doubles Medley', kinds: ['DOUBLES', 'G501', 'CRICKET'], playerCount: 2 },
  ],
  createdAt: 5,
};

type User = ReturnType<typeof userEvent.setup>;
const nav = (): HTMLElement => screen.getByRole('navigation', { name: 'メインナビゲーション' });
const stored = async () => new Repository(await openBackend()).loadAll();

async function openFormats(user: User): Promise<void> {
  await screen.findByRole('heading', { name: 'チームA', level: 1 });
  await user.click(within(nav()).getByRole('button', { name: 'フォーマット' }));
}

describe('a stored self-contradicting format', () => {
  it('is listed as 要修正 and left untouched in storage until the captain edits it', async () => {
    await seed({ formats: [LEGACY] });
    const user = userEvent.setup();
    renderApp();
    await openFormats(user);

    const legacyRow = (await screen.findByText('古いフォーマット')).closest('li')!;
    expect(within(legacyRow).getByTestId('format-issue-tag')).toHaveTextContent('要修正');
    const fineRow = screen.getByText('テスト 3ゲーム').closest('li')!;
    expect(within(fineRow).queryByTestId('format-issue-tag')).toBeNull();

    const format = (await stored()).formats.find((entry) => entry.id === LEGACY.id)!;
    expect(format.games).toEqual(LEGACY.games);
  });

  it('is corrected in the editor: one player-count choice per game, fixed head counts, medley kept', async () => {
    await seed({ formats: [LEGACY] });
    const user = userEvent.setup();
    renderApp();
    await openFormats(user);
    await user.click(await screen.findByText('古いフォーマット'));
    const editor = await screen.findByRole('dialog', { name: 'フォーマットを編集' });

    const issues = within(editor).getAllByTestId('structure-issue');
    expect(issues).toHaveLength(2);
    expect(issues[0]).toHaveTextContent('Singles は 1 名のゲームですが、必要人数が 2 名');
    expect(issues[1]).toHaveTextContent('人数区分が複数選ばれています (Singles / Doubles)');
    // The medley game is fine, and says what carrying both 01 and Cricket means.
    expect(within(editor).getByTestId('medley-note')).toHaveTextContent('両方の適性の平均');

    // Game 2: nothing is shown as chosen while it is contradictory; choosing fixes it.
    const second = within(editor).getByRole('radiogroup', { name: 'ゲーム 2 の人数区分' });
    expect(within(second).getAllByRole('radio').filter((radio) => radio.getAttribute('aria-checked') === 'true')).toHaveLength(0);
    // Saving is refused while anything is wrong.
    await user.click(within(editor).getByRole('button', { name: '保存' }));
    expect(await screen.findByText(/Singles は 1 名のゲーム/, { selector: '.toast *, .toast' })).toBeInTheDocument();

    await user.click(within(second).getByRole('radio', { name: /Doubles/ }));
    expect(within(second).getByRole('radio', { name: /Doubles/ })).toHaveAttribute('aria-checked', 'true');
    await user.click(within(editor).getByRole('button', { name: '1名にする' }));
    expect(within(editor).queryAllByTestId('structure-issue')).toHaveLength(0);

    // Singles / Doubles / Trios show their fixed head count instead of a stepper.
    expect(within(editor).getAllByTestId('fixed-player-count').map((node) => node.textContent)).toEqual([
      '1名 (Singles)',
      '2名 (Doubles)',
      '2名 (Doubles)',
    ]);

    await user.click(within(editor).getByRole('button', { name: '保存' }));
    await waitFor(async () => {
      const format = (await stored()).formats.find((entry) => entry.id === LEGACY.id)!;
      expect(format.games.map((game) => [game.kinds, game.playerCount])).toEqual([
        [['SINGLES', 'G501'], 1],
        [['DOUBLES', 'G501'], 2],
        [['DOUBLES', 'G501', 'CRICKET'], 2],
      ]);
    });
  });

  it('cannot hold two player-count kinds after editing: picking one replaces the other', async () => {
    await seed();
    const user = userEvent.setup();
    renderApp();
    await openFormats(user);
    await user.click(await screen.findByText('テスト 3ゲーム'));
    const editor = await screen.findByRole('dialog', { name: 'フォーマットを編集' });
    const first = within(editor).getByRole('radiogroup', { name: 'ゲーム 1 の人数区分' });
    await user.click(within(first).getByRole('radio', { name: /Trios/ }));
    await user.click(within(first).getByRole('radio', { name: /Doubles/ }));
    const checked = within(first).getAllByRole('radio').filter((radio) => radio.getAttribute('aria-checked') === 'true');
    expect(checked).toHaveLength(1);
    expect(checked[0]).toHaveTextContent('Doubles');
    expect(within(editor).getAllByTestId('fixed-player-count')[0]).toHaveTextContent('2名 (Doubles)');
    // Keyboard: arrow keys move the single choice (WAI-ARIA radio group).
    within(first).getByRole('radio', { name: /Doubles/ }).focus();
    await user.keyboard('{ArrowRight}');
    expect(within(first).getByRole('radio', { name: /Trios/ })).toHaveAttribute('aria-checked', 'true');
  });

  it('is not generated from SETUP, which says what to fix', async () => {
    await seed({ formats: [LEGACY] });
    const user = userEvent.setup();
    renderApp();
    await screen.findByRole('heading', { name: 'チームA', level: 1 });
    await user.click(screen.getByRole('button', { name: '新しいオーダーを作る' }));
    await screen.findByRole('heading', { name: 'オーダー設定' });
    await user.selectOptions(screen.getByLabelText('使用するフォーマット'), LEGACY.id);

    expect(screen.getByTestId('setup-format-issue')).toHaveTextContent('修正が必要なゲームがあります');
    await user.click(screen.getByRole('button', { name: 'オーダーを生成' }));
    expect(await screen.findByText(/生成できません: Singles 01: Singles は 1 名/)).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'オーダー結果' })).toBeNull();

    await user.click(within(screen.getByTestId('setup-format-issue')).getByRole('button', { name: 'フォーマットを修正' }));
    await screen.findByRole('heading', { name: 'フォーマット' });
  });

  it('an order saved with it can still be opened, but is not finalized', async () => {
    const players = roster(TEAM_A, 'Aさん');
    const input: OrderInput = {
      teamId: TEAM_A,
      formatId: LEGACY.id,
      games: LEGACY.games,
      players,
      participants: players.map((player) => createParticipantConfig(player.id)),
      pairs: [],
      locks: [],
      preset: 'BALANCED',
      weights: PRESETS.BALANCED.weights,
      settings: DEFAULT_OPTIMIZER_SETTINGS,
      discipline: 'SOFT',
    };
    const result = generateOrder(input);
    if (!result.ok) throw new Error('fixture should be satisfiable');
    const order: SavedOrder = {
      id: 'ord_legacy',
      teamId: TEAM_A,
      title: '古い形式のオーダー',
      createdAt: 1,
      updatedAt: 1,
      input,
      solution: result.candidates[0],
      match: { leagueName: '', teamName: 'チームA', opponentName: '', matchDate: '' },
      versions: [],
      seasonApplied: false,
    };
    await seed({ formats: [LEGACY], orders: [order] });
    const user = userEvent.setup();
    renderApp();
    await screen.findByRole('heading', { name: 'チームA', level: 1 });
    await user.click(within(nav()).getByRole('button', { name: '履歴' }));
    await user.click(await screen.findByRole('button', { name: /古い形式のオーダー/ }));
    await user.click(await screen.findByRole('button', { name: 'このオーダーを開いて編集' }));
    await screen.findByRole('heading', { name: 'オーダー結果' });
    expect(document.querySelectorAll('.order-game').length).toBe(3);

    await user.click(screen.getByRole('button', { name: /オーダーを確定/ }));
    expect(await screen.findByText(/確定できません: Singles 01: Singles は 1 名/)).toBeInTheDocument();
    const [kept] = (await stored()).orders;
    expect(kept.versions).toHaveLength(0);
  });
});
