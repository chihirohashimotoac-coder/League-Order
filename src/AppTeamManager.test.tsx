import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { IDBFactory } from 'fake-indexeddb';
import 'fake-indexeddb/auto';
import '@testing-library/jest-dom/vitest';
import { openBackend, resetBackendCache } from './storage/db';
import { Repository } from './storage/repository';
import { TEAM_A, TEAM_B, renderApp, seed, openScreen } from './test/appHarness';
import { generateOrder } from './optimizer/generateOrder';
import type { GenerateResult, OrderInput } from './domain/types';

vi.mock('./pwa', () => ({ onUpdateAvailable: () => () => undefined, initServiceWorker: () => undefined }));

// 生成はその場で答える (Worker を使わない)。ここで見るのは生成そのものではなく、チーム切替の安全性。
vi.mock('./optimizer/runner', () => ({
  createRunner: () => ({
    mode: 'sync' as const,
    generate: async (input: OrderInput): Promise<GenerateResult> => generateOrder(input),
    dispose: () => undefined,
  }),
}));

/**
 * ヘッダーの「チーム切替 / 管理」と、HOME の「切替 / 管理」は同じチーム管理シートを開く。
 * どちらの入口でも、切替・未保存オーダーの確認・キャンセル時の保持が同じように働くこと。
 */

afterEach(cleanup);

beforeEach(() => {
  window.scrollTo = vi.fn() as never;
  globalThis.indexedDB = new IDBFactory();
  resetBackendCache();
});

type User = ReturnType<typeof userEvent.setup>;

const nav = (): HTMLElement => screen.getByRole('navigation', { name: 'メインナビゲーション' });
const headerButton = (): HTMLElement => screen.getByRole('button', { name: 'チーム切替 / 管理' });
const homeButton = (): HTMLElement => screen.getByRole('button', { name: '切替 / 管理' });
const headerEl = (): HTMLElement => document.querySelector('.app-header') as HTMLElement;
const teamSheet = (): Promise<HTMLElement> => screen.findByRole('dialog', { name: 'チーム' });

/** ホーム → 新しいオーダーを作る → 生成。保存はしない (= 未保存の作業中オーダー)。 */
async function makeUnsavedOrder(user: User): Promise<void> {
  await user.click(within(nav()).getByRole('button', { name: 'ホーム' }));
  await user.click(await screen.findByRole('button', { name: '新しいオーダーを作る' }));
  await screen.findByRole('heading', { name: 'オーダー設定' });
  const generate = screen.getByRole('button', { name: /オーダーを生成/ });
  await waitFor(() => expect(generate).toBeEnabled());
  await user.click(generate);
  await screen.findByRole('heading', { name: 'オーダー結果' });
}

/** シートの一覧からチームを選ぶ。 */
async function pickTeam(user: User, name: string): Promise<void> {
  const sheet = await teamSheet();
  await user.click(within(sheet).getByRole('button', { name: new RegExp(`^${name}`) }));
}

describe('header entry to the team manager', () => {
  it('is on the home screen and on every other screen, and says in words what it is', async () => {
    await seed();
    const user = userEvent.setup();
    renderApp();
    await screen.findByRole('heading', { name: 'チームA', level: 1 });

    // アイコンだけではなく、文字で「チーム切替 / 管理」と読める。
    expect(headerButton()).toHaveTextContent('チーム切替 / 管理');
    expect(headerButton()).toHaveAttribute('aria-haspopup', 'dialog');

    for (const screenName of ['分析', 'オーダー', 'その他']) {
      await openScreen(user, screenName);
      expect(headerButton()).toBeInTheDocument();
    }
    await openScreen(user, 'メンバー');
    expect(headerButton()).toBeInTheDocument();
    // 使用中のチーム名は、ヘッダーの見出しの並びに出ている。
    expect(headerEl()).toHaveTextContent('チームA');
  });

  it('opens the same team manager as the button on the home card, with Escape and focus return', async () => {
    await seed();
    const user = userEvent.setup();
    renderApp();
    await screen.findByRole('heading', { name: 'チームA', level: 1 });

    // HOME の既存ボタン。
    await user.click(homeButton());
    let sheet = await teamSheet();
    const homeRows = within(sheet).getAllByRole('listitem').map((row) => row.textContent);
    expect(within(sheet).getByRole('button', { name: 'チームを追加' })).toBeInTheDocument();
    expect(within(sheet).getByRole('button', { name: 'n01から新規作成' })).toBeInTheDocument();
    await user.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'チーム' })).toBeNull());
    expect(homeButton()).toHaveFocus();

    // ヘッダーのボタン (ホーム以外の画面から)。同じシートが、同じ内容で開く。
    await openScreen(user, '分析');
    await user.click(headerButton());
    sheet = await teamSheet();
    expect(within(sheet).getAllByRole('listitem').map((row) => row.textContent)).toEqual(homeRows);
    expect(within(sheet).getByRole('button', { name: 'チームを追加' })).toBeInTheDocument();
    expect(within(sheet).getByRole('button', { name: 'n01から新規作成' })).toBeInTheDocument();
    expect(headerButton()).toHaveAttribute('aria-expanded', 'true');
    await user.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'チーム' })).toBeNull());
    expect(headerButton()).toHaveFocus();
    expect(headerButton()).toHaveAttribute('aria-expanded', 'false');
  });

  it('switches teams from a screen other than home, and shows the new active team everywhere', async () => {
    await seed();
    const user = userEvent.setup();
    renderApp();
    await screen.findByRole('heading', { name: 'チームA', level: 1 });

    await openScreen(user, 'メンバー');
    expect(screen.getByText('Aさん1')).toBeInTheDocument();
    await user.click(headerButton());
    const sheet = await teamSheet();
    // 切替前: 使用中はチームA。
    expect(within(within(sheet).getByRole('button', { name: /^チームA/ })).getByText('使用中')).toBeInTheDocument();
    expect(within(within(sheet).getByRole('button', { name: /^チームB/ })).queryByText('使用中')).toBeNull();
    await user.click(within(sheet).getByRole('button', { name: /^チームB/ }));

    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'チーム' })).toBeNull());
    // 切替後: ヘッダーの名前、画面の内容 (別チームのメンバーが出ない)、一覧の「使用中」。
    expect(headerEl()).toHaveTextContent('チームB');
    expect(await screen.findByText('Bさん1')).toBeInTheDocument();
    expect(screen.queryByText('Aさん1')).toBeNull();
    await user.click(headerButton());
    const after = await teamSheet();
    expect(within(within(after).getByRole('button', { name: /^チームB/ })).getByText('使用中')).toBeInTheDocument();
    expect(within(within(after).getByRole('button', { name: /^チームA/ })).queryByText('使用中')).toBeNull();
    expect((await new Repository(await openBackend()).loadAll()).settings.activeTeamId).toBe(TEAM_B);
  });

  it('edits and adds teams from the header entry', async () => {
    await seed();
    const user = userEvent.setup();
    renderApp();
    await screen.findByRole('heading', { name: 'チームA', level: 1 });

    await openScreen(user, '分析');
    await user.click(headerButton());
    let sheet = await teamSheet();
    // 編集: チームAの名前を直す。
    await user.click(within(sheet).getAllByRole('button', { name: '編集' })[0]);
    const editor = await screen.findAllByRole('dialog', { name: 'チーム' });
    const field = within(editor.at(-1)!).getByLabelText('チーム名');
    await user.clear(field);
    await user.type(field, 'チームA改');
    await user.click(within(editor.at(-1)!).getByRole('button', { name: '保存' }));
    await waitFor(() => expect(headerEl()).toHaveTextContent('チームA改'));

    // 追加。
    sheet = await teamSheet();
    await user.click(within(sheet).getByRole('button', { name: 'チームを追加' }));
    const adder = (await screen.findAllByRole('dialog', { name: 'チーム' })).at(-1)!;
    await user.type(within(adder).getByLabelText('チーム名'), 'チームC');
    await user.click(within(adder).getByRole('button', { name: '保存' }));
    await waitFor(async () => expect((await new Repository(await openBackend()).loadAll()).teams).toHaveLength(3));
    expect(within(await teamSheet()).getByRole('button', { name: /^チームC/ })).toBeInTheDocument();
  });

  it('deletes a non-active team after a confirmation, from the header entry', async () => {
    await seed();
    const user = userEvent.setup();
    renderApp();
    await screen.findByRole('heading', { name: 'チームA', level: 1 });

    await openScreen(user, 'オーダー');
    await user.click(headerButton());
    const sheet = await teamSheet();
    // 2 つ目 (チームB) を編集 → 削除。
    await user.click(within(sheet).getAllByRole('button', { name: '編集' })[1]);
    const editor = (await screen.findAllByRole('dialog', { name: 'チーム' })).at(-1)!;
    await user.click(within(editor).getByRole('button', { name: '削除' }));
    const confirm = await screen.findByRole('dialog', { name: 'チームを削除' });
    // キャンセルすれば何も消えない。
    await user.click(within(confirm).getByRole('button', { name: 'キャンセル' }));
    expect((await new Repository(await openBackend()).loadAll()).teams).toHaveLength(2);

    await user.click(headerButton());
    const again = await teamSheet();
    await user.click(within(again).getAllByRole('button', { name: '編集' })[1]);
    await user.click(within((await screen.findAllByRole('dialog', { name: 'チーム' })).at(-1)!).getByRole('button', { name: '削除' }));
    await user.click(within(await screen.findByRole('dialog', { name: 'チームを削除' })).getByRole('button', { name: '削除する' }));
    await waitFor(async () => expect((await new Repository(await openBackend()).loadAll()).teams.map((team) => team.id)).toEqual([TEAM_A]));
  });
});

describe('a single team', () => {
  it('lists just that team as in use, and cannot delete it', async () => {
    await seed();
    const repository = new Repository(await openBackend());
    await repository.deleteTeam(TEAM_B);
    const stored = await repository.loadAll();
    await repository.replaceAll({ ...stored, teams: stored.teams.filter((team) => team.id === TEAM_A) });
    resetBackendCache();

    const user = userEvent.setup();
    renderApp();
    await screen.findByRole('heading', { name: 'チームA', level: 1 });
    await user.click(headerButton());
    const sheet = await teamSheet();
    expect(within(sheet).getAllByRole('listitem')).toHaveLength(1);
    expect(within(within(sheet).getByRole('button', { name: /^チームA/ })).getByText('使用中')).toBeInTheDocument();
    // 使用中のチームを選んでも、何も切り替えずに閉じるだけ。
    await user.click(within(sheet).getByRole('button', { name: /^チームA/ }));
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'チーム' })).toBeNull());
    expect(screen.queryByRole('dialog', { name: 'チームを切り替える' })).toBeNull();
    // 最後の 1 チームは削除できない。
    await user.click(headerButton());
    await user.click(within(await teamSheet()).getByRole('button', { name: '編集' }));
    const editor = (await screen.findAllByRole('dialog', { name: 'チーム' })).at(-1)!;
    expect(within(editor).queryByRole('button', { name: '削除' })).toBeNull();
  });
});

describe('switching while the open order has unsaved work', () => {
  it.each([
    ['header', async (user: User) => user.click(headerButton())],
    ['home card', async (user: User) => {
      await user.click(within(nav()).getByRole('button', { name: 'ホーム' }));
      await user.click(await screen.findByRole('button', { name: '切替 / 管理' }));
    }],
  ])('asks first (%s); cancelling keeps the team and the order, confirming switches and drops it', async (_label, open) => {
    await seed();
    const user = userEvent.setup();
    renderApp();
    await screen.findByRole('heading', { name: 'チームA', level: 1 });
    await makeUnsavedOrder(user);

    await open(user);
    await pickTeam(user, 'チームB');
    const dialog = await screen.findByRole('dialog', { name: 'チームを切り替える' });
    expect(dialog).toHaveTextContent('保存されていない変更');

    // キャンセル: 確認だけが閉じ、チーム管理シート・使用中のチーム・作業中のオーダーはそのまま。
    await user.click(within(dialog).getByRole('button', { name: 'キャンセル' }));
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'チームを切り替える' })).toBeNull());
    expect(await teamSheet()).toBeInTheDocument();
    expect((await new Repository(await openBackend()).loadAll()).settings.activeTeamId).toBe(TEAM_A);
    await user.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'チーム' })).toBeNull());
    expect(headerEl()).toHaveTextContent('チームA');
    await user.click(within(nav()).getByRole('button', { name: 'ホーム' }));
    expect(await screen.findByRole('button', { name: /作業中のオーダーを開く/ })).toBeInTheDocument();

    // 承認: 切り替わり、チームAの作業中オーダーは別チームに持ち越されない。
    await user.click(headerButton());
    await pickTeam(user, 'チームB');
    await user.click(within(await screen.findByRole('dialog', { name: 'チームを切り替える' })).getByRole('button', { name: '破棄して切り替える' }));
    await screen.findByRole('heading', { name: 'チームB', level: 1 });
    expect(screen.queryByRole('button', { name: /作業中のオーダーを開く/ })).toBeNull();
    expect(headerEl()).toHaveTextContent('チームB');
    // 保存していない作業は保存もされていない (勝手に保存も削除もしない)。
    expect((await new Repository(await openBackend()).loadAll()).orders).toHaveLength(0);
  }, 60_000);

  it('does not ask once the order is saved, and keeps the saved order under its own team', async () => {
    await seed();
    const user = userEvent.setup();
    renderApp();
    await screen.findByRole('heading', { name: 'チームA', level: 1 });
    await makeUnsavedOrder(user);
    await user.click(screen.getByRole('button', { name: '下書きを保存' }));
    await waitFor(async () => expect((await new Repository(await openBackend()).loadAll()).orders).toHaveLength(1));

    await user.click(headerButton());
    await pickTeam(user, 'チームB');
    expect(screen.queryByRole('dialog', { name: 'チームを切り替える' })).toBeNull();
    await waitFor(() => expect(headerEl()).toHaveTextContent('チームB'));

    const orders = (await new Repository(await openBackend()).loadAll()).orders;
    expect(orders).toHaveLength(1);
    expect(orders[0].teamId).toBe(TEAM_A);
    // チームBの履歴にチームAのオーダーは出ない。
    await openScreen(user, '履歴');
    expect(screen.queryByText(orders[0].title)).toBeNull();
  }, 60_000);
});
