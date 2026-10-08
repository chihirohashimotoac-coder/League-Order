import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { IDBFactory } from 'fake-indexeddb';
import 'fake-indexeddb/auto';
import '@testing-library/jest-dom/vitest';
import { App } from '../../App';
import { AppStoreProvider } from '../../state/appStore';
import { ToastProvider } from '../ui';
import { N01EnvironmentProvider, type N01Environment } from '../../state/n01Environment';
import { N01Client } from '../../integrations/n01/client';
import { openBackend, resetBackendCache } from '../../storage/db';
import { Repository } from '../../storage/repository';
import { allFixtureDatasets, createFixtureTransport, fixtureResponse } from '../../test/n01/transport';
import { FIXTURE_NOW } from '../../test/n01/leagues';

vi.mock('../../pwa', () => ({ onUpdateAvailable: () => () => undefined, initServiceWorker: () => undefined }));

/**
 * F06 and F07 through the real app: a one-order helper and a member added for next time,
 * entered from 「次戦のオーダーを作る」 and from the ordinary SETUP screen, against the
 * fixture n01 league. What is checked is what a captain would see — and what is stored.
 */

afterEach(cleanup);

/** Roster entries n01 serves for kalavinka on top of the fixture’s (a late registration). */
let extraRoster: { opid: string; oid: string; tpid: string; oname: string }[] = [];

beforeEach(() => {
  window.scrollTo = vi.fn() as never;
  globalThis.indexedDB = new IDBFactory();
  resetBackendCache();
  extraRoster = [];
});

const env: N01Environment = {
  createClient: () =>
    new N01Client(
      createFixtureTransport({
        override: (request) => {
          if (extraRoster.length > 0 && request.operation === 'team/player/list' && request.params.tpid === 'GpiQ') {
            const base = fixtureResponse(request, allFixtureDatasets()) as { list: unknown[] };
            return { list: [...base.list, ...extraRoster] };
          }
          return undefined;
        },
      }),
      { now: () => FIXTURE_NOW },
    ),
  now: () => FIXTURE_NOW,
};

type User = ReturnType<typeof userEvent.setup>;

function renderApp(): void {
  render(
    <ToastProvider>
      <AppStoreProvider>
        <N01EnvironmentProvider value={env}>
          <App />
        </N01EnvironmentProvider>
      </AppStoreProvider>
    </ToastProvider>,
  );
}

async function createKalavinka(user: User): Promise<void> {
  await user.click(await screen.findByRole('button', { name: 'n01から作成' }));
  const wizard = await screen.findByRole('dialog', { name: 'n01から作成' });
  await user.click(within(wizard).getByRole('button', { name: /ATDO/ }));
  await user.click(await within(wizard).findByRole('button', { name: /kalavinka/ }));
  await within(wizard).findByTestId('n01-preview');
  await user.click(within(wizard).getByRole('button', { name: 'このチームを作成' }));
  await screen.findByRole('heading', { name: 'kalavinka', level: 1 });
}

async function openAttendance(user: User): Promise<HTMLElement> {
  await user.click(screen.getByRole('button', { name: '次戦のオーダーを作る' }));
  const flow = await screen.findByRole('dialog', { name: '次戦のオーダーを作る' });
  await within(flow).findByTestId('flow-attendance', {}, { timeout: 10_000 });
  return flow;
}

async function fillAndSave(user: User, dialogName: string, name: string, rating: string, saveLabel: string): Promise<void> {
  const editor = await screen.findByRole('dialog', { name: dialogName });
  await user.type(within(editor).getByPlaceholderText('例: ちひろ'), name);
  if (rating) await user.type(within(editor).getByPlaceholderText('例: 14'), rating);
  await user.click(within(editor).getByRole('button', { name: saveLabel }));
  await waitFor(() => expect(screen.queryByRole('dialog', { name: dialogName })).toBeNull());
}

const storedPlayers = async (): Promise<{ id: string; name: string; teamId: string; rating: number | null; n01?: { opid: string | null; currentOid: string | null } }[]> => {
  const stored = await new Repository(await openBackend()).loadAll();
  return stored.players as never;
};

const fieldedNames = (): string[] =>
  [...document.querySelectorAll<HTMLSelectElement>('.order-game select')].map((select) => select.selectedOptions[0]?.textContent ?? '');

describe('今回だけの助っ人 from the next-match flow', () => {
  it('joins this order only: ticked and fielded now, in no roster, not offered next time', async () => {
    const user = userEvent.setup();
    renderApp();
    await createKalavinka(user);

    const flow = await openAttendance(user);
    await user.click(within(flow).getByRole('button', { name: '今回だけ助っ人を追加' }));
    const editor = await screen.findByRole('dialog', { name: '今回だけ助っ人を追加' });
    expect(within(editor).getByTestId('player-editor-notice-guest')).toHaveTextContent('チームのメンバー・次回の候補・シーズン累計には残りません');
    // A name is required: nothing is added without one.
    expect(within(editor).getByRole('button', { name: '助っ人として追加' })).toBeDisabled();
    await user.click(within(editor).getByRole('button', { name: '閉じる' }));

    await user.click(within(flow).getByRole('button', { name: '今回だけ助っ人を追加' }));
    await fillAndSave(user, '今回だけ助っ人を追加', '助っ人 花子', '10', '助っ人として追加');
    const attendance = within(flow).getByTestId('flow-attendance');
    expect(attendance).toHaveTextContent('本日参加 8 / 8');
    expect(within(attendance).getByTestId('guest-tag')).toHaveTextContent('助っ人 (今回のみ)');
    expect(within(attendance).getByText('助っ人 花子')).toBeInTheDocument();

    await user.click(within(attendance).getByRole('button', { name: 'このメンバーで作成' }));
    await screen.findByRole('heading', { name: 'オーダー結果' }, { timeout: 20_000 });
    expect(fieldedNames().some((name) => name.includes('助っ人 花子'))).toBe(true);

    // SETUP, reached from the result, still has the helper (the draft was built with them).
    await user.click(screen.getByRole('button', { name: '戻る' }));
    await screen.findByRole('heading', { name: 'オーダー設定' });
    expect(screen.getByTestId('guest-tag')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'オーダーを生成' }));
    await screen.findByRole('heading', { name: 'オーダー結果' }, { timeout: 20_000 });
    expect(fieldedNames().some((name) => name.includes('助っ人 花子'))).toBe(true);

    // Not a member of the team, in storage or on screen …
    expect((await storedPlayers()).some((entry) => entry.name === '助っ人 花子')).toBe(false);
    await user.click(within(screen.getByRole('navigation')).getByRole('button', { name: 'メンバー' }));
    await screen.findByText('橋本 千尋');
    expect(screen.queryByText('助っ人 花子')).toBeNull();

    // … and not offered the next time.
    await user.click(within(screen.getByRole('navigation')).getByRole('button', { name: 'ホーム' }));
    const again = await openAttendance(user);
    expect(again).not.toHaveTextContent('助っ人 花子');
    expect(again).toHaveTextContent('本日参加 7 / 7');
  }, 90_000);
});

describe('次回から参加するメンバー from the next-match flow', () => {
  it('is saved as a team member, ticked for today, and stays a candidate', async () => {
    const user = userEvent.setup();
    renderApp();
    await createKalavinka(user);

    const flow = await openAttendance(user);
    await user.click(within(flow).getByRole('button', { name: '次回から参加するメンバーを追加' }));
    const editor = await screen.findByRole('dialog', { name: '次回から参加するメンバーを追加' });
    expect(within(editor).getByTestId('player-editor-notice-member')).toHaveTextContent('次回以降のオーダーでも候補になります');
    await user.click(within(editor).getByRole('button', { name: '閉じる' }));
    await user.click(within(flow).getByRole('button', { name: '次回から参加するメンバーを追加' }));
    await fillAndSave(user, '次回から参加するメンバーを追加', '新人 次郎', '8', 'メンバーに追加');

    const attendance = within(flow).getByTestId('flow-attendance');
    expect(attendance).toHaveTextContent('本日参加 8 / 8');
    expect(within(attendance).getByTestId('manual-tag')).toHaveTextContent('n01 未連携');
    expect((within(attendance).getByRole('checkbox', { name: /新人 次郎/ }) as HTMLInputElement).checked).toBe(true);

    const saved = (await storedPlayers()).filter((entry) => entry.name === '新人 次郎');
    expect(saved).toHaveLength(1);
    expect(saved[0]).toMatchObject({ rating: 8 });
    expect(saved[0].n01).toBeUndefined();

    // Next time, with no order made in between, they are still offered.
    await user.click(within(flow).getByRole('button', { name: '閉じる' }));
    const again = await openAttendance(user);
    expect(again).toHaveTextContent('新人 次郎');
  }, 60_000);

  it('is the same person, with the same id and numbers, when n01 later lists their exact name', async () => {
    const user = userEvent.setup();
    renderApp();
    await createKalavinka(user);
    const flow = await openAttendance(user);
    await user.click(within(flow).getByRole('button', { name: '次回から参加するメンバーを追加' }));
    await fillAndSave(user, '次回から参加するメンバーを追加', '新人 次郎', '8', 'メンバーに追加');
    const before = (await storedPlayers()).find((entry) => entry.name === '新人 次郎')!;
    await user.click(within(flow).getByRole('button', { name: '閉じる' }));

    extraRoster = [{ opid: 'op_shinjin', oid: 'o3_op_shinjin', tpid: 'GpiQ', oname: '新人 次郎' }];
    const second = await openAttendance(user);
    expect(second).toHaveTextContent('本日参加 8 / 8');
    expect(within(second).getAllByText('新人 次郎')).toHaveLength(1);
    expect(within(second).queryByTestId('manual-tag')).toBeNull();

    const after = (await storedPlayers()).filter((entry) => entry.name === '新人 次郎');
    expect(after).toHaveLength(1);
    expect(after[0]).toMatchObject({ id: before.id, rating: 8 });
    expect(after[0].n01).toMatchObject({ opid: 'op_shinjin', currentOid: 'o3_op_shinjin' });
  }, 90_000);

  it('asks before joining a different spelling, adds nobody twice, and then keeps the member’s numbers', async () => {
    const user = userEvent.setup();
    renderApp();
    await createKalavinka(user);
    const flow = await openAttendance(user);
    await user.click(within(flow).getByRole('button', { name: '次回から参加するメンバーを追加' }));
    await fillAndSave(user, '次回から参加するメンバーを追加', '新人 次郎', '8', 'メンバーに追加');
    const before = (await storedPlayers()).find((entry) => entry.name === '新人 次郎')!;
    await user.click(within(flow).getByRole('button', { name: '閉じる' }));

    extraRoster = [{ opid: 'op_shinjin', oid: 'o3_op_shinjin', tpid: 'GpiQ', oname: '新人次郎' }];
    await user.click(screen.getByRole('button', { name: '次戦のオーダーを作る' }));
    const sheet = await screen.findByRole('dialog', { name: '次戦のオーダーを作る' });
    const links = await within(sheet).findByTestId('pending-links', {}, { timeout: 10_000 });
    expect(links).toHaveTextContent('新人次郎');
    // Nothing is chosen for the captain, and nobody has been added meanwhile.
    expect(within(links).getByRole('button', { name: '選んだ内容で確定' })).toBeDisabled();
    expect((await storedPlayers()).filter((entry) => /新人/.test(entry.name))).toHaveLength(1);

    await user.click(within(links).getByRole('radio', { name: /既存メンバー「新人 次郎」と同じ人/ }));
    await user.click(within(links).getByRole('button', { name: '選んだ内容で確定' }));
    const attendance = await within(sheet).findByTestId('flow-attendance', {}, { timeout: 10_000 });
    expect(within(attendance).getAllByText(/新人/)).toHaveLength(1);

    const after = (await storedPlayers()).filter((entry) => /新人/.test(entry.name));
    expect(after).toHaveLength(1);
    expect(after[0]).toMatchObject({ id: before.id, rating: 8, name: '新人次郎' });
    expect(after[0].n01).toMatchObject({ opid: 'op_shinjin' });
  }, 90_000);

  it('“later”: the hand-made member stays a candidate (n01 未連携), the held-back n01 row is neither created nor linked, and the screen says exactly that', async () => {
    const user = userEvent.setup();
    renderApp();
    await createKalavinka(user);
    const flow = await openAttendance(user);
    await user.click(within(flow).getByRole('button', { name: '次回から参加するメンバーを追加' }));
    await fillAndSave(user, '次回から参加するメンバーを追加', '新人 次郎', '', 'メンバーに追加');
    await user.click(within(flow).getByRole('button', { name: '閉じる' }));

    extraRoster = [{ opid: 'op_shinjin', oid: 'o3_op_shinjin', tpid: 'GpiQ', oname: '新人次郎' }];
    await user.click(screen.getByRole('button', { name: '次戦のオーダーを作る' }));
    const sheet = await screen.findByRole('dialog', { name: '次戦のオーダーを作る' });
    const links = await within(sheet).findByTestId('pending-links', {}, { timeout: 10_000 });
    // What “later” does is stated about each side separately, and nothing reads as “the same person”.
    const note = within(links).getByTestId('pending-links-later');
    expect(note).toHaveTextContent('手動で追加済みのメンバーは、これまでどおり今回の参加候補に残ります');
    expect(note).toHaveTextContent('n01 の成績は使いません');
    expect(note).toHaveTextContent('n01 の「新人次郎」は、新しいメンバーとして追加も、既存メンバーとの結び付けもしません');
    expect(note).toHaveTextContent('次回の同期で再確認します');
    expect(links).not.toHaveTextContent('その人は今回の候補に入りません');
    expect(within(links).getByRole('group', { name: /新人次郎/ })).toHaveAccessibleDescription(/手動で追加済みのメンバーは/);

    await user.click(within(links).getByRole('button', { name: 'あとで確認する' }));
    const attendance = await within(sheet).findByTestId('flow-attendance');
    // The member is still offered (and ticked), marked as not linked to n01; the n01 row is not.
    expect(within(attendance).getAllByText(/新人/)).toHaveLength(1);
    expect(within(attendance).getByText('新人 次郎')).toBeInTheDocument();
    expect(within(attendance).queryByText('新人次郎')).toBeNull();
    expect(within(attendance).getByTestId('manual-tag')).toHaveTextContent('n01 未連携');
    expect((within(attendance).getByRole('checkbox', { name: /新人 次郎/ }) as HTMLInputElement).checked).toBe(true);
    expect(attendance).toHaveTextContent('本日参加 8 / 8');

    // Nothing was created or linked, and no n01 numbers were attached to the member.
    const after = (await storedPlayers()).filter((entry) => /新人/.test(entry.name));
    expect(after).toHaveLength(1);
    expect(after[0].name).toBe('新人 次郎');
    expect(after[0].n01).toBeUndefined();

    // The member can be fielded now; their strength is Unknown, not n01’s.
    await user.click(within(attendance).getByRole('button', { name: 'このメンバーで作成' }));
    await screen.findByRole('heading', { name: 'オーダー結果' }, { timeout: 20_000 });
    expect(fieldedNames().some((name) => name.includes('新人 次郎'))).toBe(true);
    expect(fieldedNames().some((name) => name.includes('新人次郎'))).toBe(false);
    expect(within(screen.getByTestId('strength-basis-panel')).getByText('新人 次郎').closest('.basis-row')).toHaveAttribute('data-origin', 'unknown');

    // The next sync asks again.
    await user.click(within(screen.getByRole('navigation')).getByRole('button', { name: 'ホーム' }));
    await user.click(screen.getByRole('button', { name: '次戦のオーダーを作る' }));
    const again = await screen.findByRole('dialog', { name: '次戦のオーダーを作る' });
    expect(await within(again).findByTestId('pending-links', {}, { timeout: 10_000 })).toHaveTextContent('新人次郎');
  }, 120_000);
});

describe('助っ人 on the ordinary SETUP screen', () => {
  it('stays through generation, going back, a re-generation and a reload; a new order starts without them', async () => {
    const user = userEvent.setup();
    renderApp();
    await createKalavinka(user);

    await user.click(screen.getByRole('button', { name: '新しいオーダーを作る' }));
    await screen.findByRole('heading', { name: 'オーダー設定' });
    await user.click(screen.getByRole('button', { name: '今回だけ助っ人を追加' }));
    await fillAndSave(user, '今回だけ助っ人を追加', '助っ人 花子', '10', '助っ人として追加');
    expect(screen.getByTestId('guest-tag')).toHaveTextContent('助っ人 (今回のみ)');
    expect(screen.getByRole('heading', { name: /参加者 8 \/ 8/ })).toBeInTheDocument();

    // The basis of every number is on the screen: seasons used, data behind each, confidence;
    // the helper typed a Rating only, so their PPR is unknown (and valued as the median, never 0).
    const basis = screen.getByTestId('strength-basis-panel');
    expect(basis).toHaveTextContent('使用 Season: 2026 3rd');
    expect(basis).toHaveTextContent('信頼度');
    expect(within(basis).getByText('助っ人 花子').closest('.basis-row')).toHaveAttribute('data-origin', 'unknown');

    await user.click(screen.getByRole('button', { name: 'オーダーを生成' }));
    await screen.findByRole('heading', { name: 'オーダー結果' }, { timeout: 20_000 });
    expect(fieldedNames().some((name) => name.includes('助っ人 花子'))).toBe(true);
    // … and it travels with the order, so the result shows what it was generated with.
    expect(screen.getByTestId('strength-basis-panel')).toHaveTextContent('助っ人 花子');

    // Back to SETUP: the helper (and their row) is still there, and a re-generation keeps them.
    await user.click(screen.getByRole('button', { name: '戻る' }));
    await screen.findByRole('heading', { name: 'オーダー設定' });
    expect(screen.getByTestId('guest-tag')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'オーダーを生成' }));
    await screen.findByRole('heading', { name: 'オーダー結果' }, { timeout: 20_000 });
    expect(fieldedNames().some((name) => name.includes('助っ人 花子'))).toBe(true);

    // Saved, the order keeps the helper in its own snapshot — and the roster still does not.
    await user.click(screen.getByRole('button', { name: /下書きを保存/ }));
    const stored = await new Repository(await openBackend()).loadAll();
    expect(stored.orders[0].input.players.filter((entry) => entry.guest).map((entry) => entry.name)).toEqual(['助っ人 花子']);
    expect(stored.players.some((entry) => entry.name === '助っ人 花子')).toBe(false);

    // A reload (a new app on the same database) reopens the order with the helper in it.
    cleanup();
    renderApp();
    await screen.findByRole('heading', { name: 'kalavinka', level: 1 });
    await user.click(within(screen.getByRole('navigation')).getByRole('button', { name: '履歴' }));
    await user.click(await screen.findByRole('button', { name: /助っ人|ORDER|20\d\d|下書き|未確定|バランス|勝利|対戦/ }));
    const preview = await screen.findByRole('dialog');
    // The saved order lists the helper by name too.
    expect(preview).toHaveTextContent('助っ人 花子');
    await user.click(within(preview).getByRole('button', { name: 'このオーダーを開いて編集' }));
    await screen.findByRole('heading', { name: 'オーダー結果' });
    expect(fieldedNames().some((name) => name.includes('助っ人 花子'))).toBe(true);

    // A new order does not carry them over.
    await user.click(within(screen.getByRole('navigation')).getByRole('button', { name: 'ホーム' }));
    await user.click(screen.getByRole('button', { name: '新しいオーダーを作る' }));
    const discard = screen.queryByRole('button', { name: '破棄して作成' });
    if (discard) await user.click(discard);
    await screen.findByRole('heading', { name: 'オーダー設定' });
    expect(screen.queryByText('助っ人 花子')).toBeNull();
    expect(screen.getByRole('heading', { name: /参加者 7 \/ 7/ })).toBeInTheDocument();
  }, 120_000);
});

describe('助っ人 and the season', () => {
  it('finalizing, counting the season, re-counting and withdrawing leave no ghost: the helper is nobody’s total', async () => {
    const user = userEvent.setup();
    renderApp();
    await createKalavinka(user);
    await user.click(screen.getByRole('button', { name: '新しいオーダーを作る' }));
    await screen.findByRole('heading', { name: 'オーダー設定' });
    await user.click(screen.getByRole('button', { name: '今回だけ助っ人を追加' }));
    await fillAndSave(user, '今回だけ助っ人を追加', '助っ人 花子', '10', '助っ人として追加');
    await user.click(screen.getByRole('button', { name: 'オーダーを生成' }));
    await screen.findByRole('heading', { name: 'オーダー結果' }, { timeout: 20_000 });

    await user.click(screen.getByRole('button', { name: /オーダーを確定/ }));
    await user.click(await screen.findByRole('button', { name: 'シーズン累計へ反映' }));
    await user.click(await within(await screen.findByRole('dialog', { name: 'シーズン累計へ反映' })).findByRole('button', { name: '反映する' }));

    const repository = new Repository(await openBackend());
    const stored = await repository.loadAll();
    const guestId = stored.orders[0].input.players.find((entry) => entry.guest)!.id;
    const commit = stored.seasonCommits[0];
    expect(commit.appearances.some((record) => record.playerId === guestId)).toBe(false);
    expect(stored.players.some((entry) => entry.id === guestId)).toBe(false);
    // The roster’s totals took exactly the roster’s games: 12 slots, less the helper’s.
    const helperGames = stored.orders[0].solution.tallies.find((tally) => tally.playerId === guestId)!.count;
    expect(helperGames).toBeGreaterThan(0);
    const total = stored.players.reduce((acc, entry) => acc + entry.seasonAppearances, 0);
    expect(total).toBe(12 - helperGames);

    // Counting again changes nothing.
    await user.click(screen.getByRole('button', { name: 'シーズン累計を再反映' }));
    await user.click(await within(await screen.findByRole('dialog', { name: 'シーズン累計を再反映' })).findByRole('button', { name: '反映する' }));
    const again = await repository.loadAll();
    expect(again.players.reduce((acc, entry) => acc + entry.seasonAppearances, 0)).toBe(total);

    // Withdrawing returns the roster to where it started.
    await user.click(screen.getByRole('button', { name: '反映を取り消す' }));
    await user.click(await within(await screen.findByRole('dialog')).findByRole('button', { name: /取り消す|取消/ }));
    await waitFor(async () => {
      const after = await repository.loadAll();
      expect(after.players.reduce((acc, entry) => acc + entry.seasonAppearances, 0)).toBe(0);
    });
  }, 120_000);
});

