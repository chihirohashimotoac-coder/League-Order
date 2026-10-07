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
import { resetBackendCache } from '../../storage/db';
import { Repository } from '../../storage/repository';
import { allFixtureDatasets, createFixtureTransport, FAIL, fixtureResponse } from '../../test/n01/transport';
import { FIXTURE_NOW } from '../../test/n01/leagues';

vi.mock('../../pwa', () => ({ onUpdateAvailable: () => () => undefined, initServiceWorker: () => undefined }));

/**
 * Phase 1 through the real app shell, store and IndexedDB, with n01 served from the
 * fixture leagues: League → Team → Preview → create, then the managed format and the
 * roster with n01 PPR, then a re-sync.
 */

afterEach(cleanup);

let failRequests = false;
/** Fails only the opponent's roster request, so the analysis fails but the sync does not. */
let failOpponent = false;
/** Extra roster entries served for kalavinka on later syncs (simulates an n01 change). */
let extraRoster: { opid: string; oid: string; tpid: string; oname: string }[] = [];

beforeEach(() => {
  window.scrollTo = vi.fn() as never;
  globalThis.indexedDB = new IDBFactory();
  resetBackendCache();
  failRequests = false;
  failOpponent = false;
  extraRoster = [];
});

const env: N01Environment = {
  createClient: () =>
    new N01Client(
      createFixtureTransport({
        override: (request) => {
          if (failRequests) return FAIL;
          if (failOpponent && request.operation === 'team/player/list' && request.params.tpid === '68wv') return FAIL;
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

async function createKalavinka(user: ReturnType<typeof userEvent.setup>): Promise<void> {
  await user.click(await screen.findByRole('button', { name: 'n01から作成' }));
  const wizard = await screen.findByRole('dialog', { name: 'n01から作成' });
  await user.click(within(wizard).getByRole('button', { name: /ATDO/ }));
  await user.click(await within(wizard).findByRole('button', { name: /kalavinka/ }));
  const preview = await within(wizard).findByTestId('n01-preview');
  expect(preview).toHaveTextContent('2026 3rd');
  expect(preview).toHaveTextContent('Team 1001 ×1 / Doubles 501 ×2 / Singles 501 ×4');
  expect(preview).toHaveTextContent('STEEL');
  expect(preview).toHaveTextContent('6 / 7 名が n01 から取得');
  await user.click(within(wizard).getByRole('button', { name: 'このチームを作成' }));
  await screen.findByRole('heading', { name: 'kalavinka', level: 1 });
}

describe('n01 team creation', () => {
  it('creates a team from League and Team alone, and stores it in one batch', async () => {
    const user = userEvent.setup();
    renderApp();
    await createKalavinka(user);

    expect(screen.getByTestId('n01-team-status')).toHaveTextContent('ATDO ・ 2026 3rd ・ A Division');

    const stored = await new Repository(await (await import('../../storage/db')).openBackend()).loadAll();
    const team = stored.teams.find((entry) => entry.name === 'kalavinka')!;
    expect(team.n01).toMatchObject({ lastTeamId: 'GpiQ', lastDivisionTitle: 'A', discipline: 'STEEL', leagueId: 'lg_l3hI_3397' });
    expect(stored.players.filter((player) => player.teamId === team.id)).toHaveLength(7);
    const format = stored.formats.find((entry) => entry.id === team.n01!.managedFormatId)!;
    expect(format.source?.tournamentId).toBe('t_ABvC_5234');
    expect(stored.settings.activeTeamId).toBe(team.id);
  });

  it('shows the managed format read-only, with a manual copy', async () => {
    const user = userEvent.setup();
    renderApp();
    await createKalavinka(user);
    await user.click(within(screen.getByRole('navigation')).getByRole('button', { name: 'フォーマット' }));
    await user.click(await screen.findByRole('button', { name: /ATDO 2026 3rd A Division.*n01 管理/ }));
    const viewer = await screen.findByRole('dialog', { name: 'n01 管理フォーマット' });
    expect(within(viewer).getByTestId('managed-format-source')).toHaveTextContent('ATDO');
    expect(within(viewer).queryByRole('button', { name: '保存' })).toBeNull();
    await user.click(within(viewer).getByRole('button', { name: 'コピーして手動フォーマット' }));
    expect(await screen.findByText('ATDO 2026 3rd A Division (手動)')).toBeInTheDocument();
  });

  it('lists the roster with n01 PPR, and no PPR (not 0) for a player without stats', async () => {
    const user = userEvent.setup();
    renderApp();
    await createKalavinka(user);
    await user.click(within(screen.getByRole('navigation')).getByRole('button', { name: 'メンバー' }));
    const row = (await screen.findByText('中村 蓮')).closest('.list-row')!;
    expect(row).toHaveTextContent('戦力データ未設定');
    expect(row).not.toHaveTextContent('PPR 0');
    const hashimoto = screen.getByText('橋本 千尋').closest('.list-row')!;
    expect(hashimoto).toHaveTextContent(/PPR \d+(\.\d+)? ・ PPR n01/);
  });

  it('re-syncs with no changes, and reports a network failure without pretending to be current', async () => {
    const user = userEvent.setup();
    renderApp();
    await createKalavinka(user);
    await user.click(screen.getByRole('button', { name: 'n01を再同期' }));
    const sheet = await screen.findByRole('dialog', { name: 'n01を再同期' });
    expect(await within(sheet).findByTestId('n01-sync-done')).toHaveTextContent('変更はありません');
    await user.click(within(sheet).getAllByRole('button', { name: '閉じる' }).at(-1)!);

    failRequests = true;
    await user.click(screen.getByRole('button', { name: 'n01を再同期' }));
    const failed = await screen.findByRole('dialog', { name: 'n01を再同期' });
    const alert = await within(failed).findByRole('alert');
    expect(alert).toHaveTextContent('n01 に接続できませんでした');
    expect(alert).toHaveTextContent('このデータは最新ではありません');
    expect(within(failed).queryByText(/最新$/)).toBeNull();
    await waitFor(() => expect(within(failed).getByRole('button', { name: /再試行/ })).toBeEnabled());
  });
});

describe('linking an existing team', () => {
  it('maps players by exact name, keeps local Rating, and adds the rest', async () => {
    const { openBackend } = await import('../../storage/db');
    const repository = new Repository(await openBackend());
    await repository.saveTeam({ id: 'team_manual', name: 'KALAVINKA', createdAt: 1 });
    await repository.savePlayers([
      { id: 'pl_h', teamId: 'team_manual', name: '橋本　千尋', rating: 14, ppr: null, skills: { SINGLES: 5 }, seasonAppearances: 4, seasonAppearancesByKind: {}, archived: false, createdAt: 1 },
      { id: 'pl_g', teamId: 'team_manual', name: 'ゲスト', rating: 9, ppr: null, skills: {}, seasonAppearances: 0, seasonAppearancesByKind: {}, archived: false, createdAt: 2 },
    ]);

    const user = userEvent.setup();
    renderApp();
    await screen.findByRole('heading', { name: 'KALAVINKA', level: 1 });
    await user.click(screen.getByRole('button', { name: '切替 / 管理' }));
    await user.click(await screen.findByRole('button', { name: '編集' }));
    await user.click(await screen.findByRole('button', { name: 'n01と接続' }));
    const wizard = await screen.findByRole('dialog', { name: 'n01と接続' });
    await user.click(within(wizard).getByRole('button', { name: /ATDO/ }));
    await user.click(await within(wizard).findByRole('button', { name: /kalavinka/ }));
    const mapping = await within(wizard).findByLabelText('橋本 千尋');
    expect((mapping as HTMLSelectElement).value).toBe('pl_h');
    expect((within(wizard).getByLabelText('佐藤 健') as HTMLSelectElement).value).toBe('');
    await user.click(within(wizard).getByRole('button', { name: 'n01と接続する' }));
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'n01と接続' })).toBeNull());

    const stored = await repository.loadAll();
    const players = stored.players.filter((player) => player.teamId === 'team_manual');
    expect(players).toHaveLength(8);
    expect(players.find((player) => player.id === 'pl_h')).toMatchObject({ rating: 14, skills: { SINGLES: 5 }, seasonAppearances: 4, name: '橋本 千尋' });
    expect(players.find((player) => player.id === 'pl_h')?.n01?.opid).toBe('op_hashimoto');
    expect(players.find((player) => player.id === 'pl_g')).toMatchObject({ name: 'ゲスト', rating: 9 });
    expect(players.find((player) => player.id === 'pl_g')?.n01).toBeUndefined();
    expect(stored.teams.find((team) => team.id === 'team_manual')?.n01?.lastTeamId).toBe('GpiQ');
  });
});

describe('next match intelligence (Phase 2)', () => {
  it('is analysed when the team is created and again on every re-sync', async () => {
    const user = userEvent.setup();
    renderApp();
    await createKalavinka(user);
    const { openBackend } = await import('../../storage/db');
    const repository = new Repository(await openBackend());
    const cache = await repository.loadN01Cache();
    const intel = cache.find((record) => record.kind === 'intel');
    expect(intel).toMatchObject({ nextMatchStatus: 'resolved', nextMatch: { opponentName: 'スピンコブラ', date: '2026-10-08' } });
    expect(intel && intel.kind === 'intel' ? intel.opponent?.positionModel.slots.length : 0).toBe(7);

    await user.click(screen.getByRole('button', { name: 'n01を再同期' }));
    const sheet = await screen.findByRole('dialog', { name: 'n01を再同期' });
    expect(await within(sheet).findByTestId('sync-next-match')).toHaveTextContent('次戦: vs スピンコブラ (10/8)');
    expect(within(sheet).getByTestId('n01-sync-done')).toHaveTextContent('変更はありません');
  });
});

describe('opponent-optimised order (Phase 4)', () => {
  it('offers 対戦相手最適化 for the next opponent and shows the estimate next to 勝利優先', async () => {
    const user = userEvent.setup();
    renderApp();
    await createKalavinka(user);
    await user.click(screen.getByRole('button', { name: '新しいオーダーを作る' }));
    await screen.findByRole('heading', { name: 'オーダー設定' });
    expect(screen.getByTestId('setup-opponent')).toHaveTextContent('次戦: vs スピンコブラ (10/8)');
    await user.click(screen.getByRole('radio', { name: /対戦相手最適化/ }));
    await user.click(screen.getByRole('button', { name: 'オーダーを生成' }));
    await screen.findByRole('heading', { name: 'オーダー結果' }, { timeout: 15_000 });

    const tabs = document.querySelectorAll('.candidate-tab');
    expect([...tabs].map((tab) => tab.querySelector('.c-label')?.textContent)).toEqual(['対戦相手最適化', '勝利優先', 'バランス', '公平性優先']);
    const panel = screen.getByTestId('opponent-panel');
    expect(panel).toHaveTextContent('スピンコブラ');
    expect(panel).toHaveTextContent('推定 Match 勝率');
    expect(panel).toHaveTextContent('通常の勝利優先');
    expect(panel).toHaveTextContent('推定値であり、結果を保証するものではありません');
    expect(screen.getByTestId('estimated-match-win').textContent).toMatch(/^\d{1,3}%$/);
    expect(document.querySelectorAll('.tag.predict')).toHaveLength(7);
    // No absolute claims anywhere on the screen.
    expect(document.body.textContent).not.toMatch(/確実|必勝|絶対勝/);
  }, 30_000);
});

describe('next match order in one flow (Phase 5)', () => {
  async function startNextMatch(user: ReturnType<typeof userEvent.setup>): Promise<HTMLElement> {
    await user.click(screen.getByRole('button', { name: '次戦のオーダーを作る' }));
    return screen.findByRole('dialog', { name: '次戦のオーダーを作る' });
  }

  it('HOME shows the next match; one tap syncs, asks who is here, and builds the order', async () => {
    const user = userEvent.setup();
    renderApp();
    await createKalavinka(user);
    const card = screen.getByTestId('next-match-card');
    expect(card).toHaveTextContent('vs スピンコブラ');
    expect(card).toHaveTextContent('10/8');
    expect(card).toHaveTextContent('kalavinka ・ ATDO ・ A Division');
    expect(screen.getByTestId('n01-freshness')).toHaveTextContent('n01 ✓ 最新');

    const flow = await startNextMatch(user);
    const attendance = await within(flow).findByTestId('flow-attendance', {}, { timeout: 10_000 });
    expect(attendance).toHaveTextContent('vs スピンコブラ');
    expect(attendance).toHaveTextContent('本日参加 7 / 7');
    await user.click(within(attendance).getByRole('checkbox', { name: /伊藤 由佳/ }));
    expect(attendance).toHaveTextContent('本日参加 6 / 7');
    await user.click(within(attendance).getByRole('button', { name: 'このメンバーで作成' }));

    await screen.findByRole('heading', { name: 'オーダー結果' }, { timeout: 20_000 });
    expect(screen.getByTestId('opponent-panel')).toHaveTextContent('スピンコブラ');
    const fielded = [...document.querySelectorAll<HTMLSelectElement>('.order-game select')].map(
      (select) => select.selectedOptions[0]?.textContent ?? '',
    );
    expect(fielded.length).toBe(12);
    expect(fielded.some((name) => name.includes('伊藤 由佳'))).toBe(false);

    // The next time, today's attendance starts from last time's.
    await user.click(within(screen.getByRole('navigation')).getByRole('button', { name: 'ホーム' }));
    const again = await startNextMatch(user);
    const second = await within(again).findByTestId('flow-attendance', {}, { timeout: 10_000 });
    expect((within(second).getByRole('checkbox', { name: /伊藤 由佳/ }) as HTMLInputElement).checked).toBe(false);
  }, 60_000);

  it('offline: names the last sync and continues with that data only when asked', async () => {
    const user = userEvent.setup();
    renderApp();
    await createKalavinka(user);
    failRequests = true;
    const flow = await startNextMatch(user);
    const offline = await within(flow).findByTestId('flow-offline');
    expect(offline).toHaveTextContent('n01 に接続できませんでした');
    expect(offline).toHaveTextContent('前回:');
    expect(offline).toHaveTextContent('このデータは最新ではありません');
    expect(within(flow).queryByTestId('flow-attendance')).toBeNull();
    await user.click(within(offline).getByRole('button', { name: '前回データで続ける' }));
    const attendance = await within(flow).findByTestId('flow-attendance');
    expect(within(attendance).getByTestId('flow-stale')).toHaveTextContent('最新ではありません');
  }, 30_000);

  it('a re-sync whose opponent analysis fails drops the old analysis instead of showing it as current', async () => {
    const user = userEvent.setup();
    renderApp();
    await createKalavinka(user);
    expect(screen.getByTestId('next-match-card')).toHaveTextContent('vs スピンコブラ');
    failOpponent = true;
    const flow = await startNextMatch(user);
    const changes = await within(flow).findByTestId('flow-changes', {}, { timeout: 10_000 });
    expect(changes).toHaveTextContent('次戦の分析データを取得できませんでした');
    await user.click(within(changes).getByRole('button', { name: '確認して続ける' }));
    const attendance = await within(flow).findByTestId('flow-attendance');
    expect(attendance).toHaveTextContent('次戦の相手データがないため、勝利優先で作成します。');
    expect(attendance).not.toHaveTextContent('スピンコブラ');
    await user.click(within(flow).getByRole('button', { name: '閉じる' }));
    expect(screen.getByTestId('next-match-card')).toHaveTextContent('次戦: 未取得');
  }, 30_000);

  it('stops to show an important n01 change before going on', async () => {
    const user = userEvent.setup();
    renderApp();
    await createKalavinka(user);
    extraRoster = [{ opid: 'op_newcomer', oid: 'o3_op_newcomer', tpid: 'GpiQ', oname: '新加入 太郎' }];
    const flow = await startNextMatch(user);
    const changes = await within(flow).findByTestId('flow-changes', {}, { timeout: 10_000 });
    expect(changes).toHaveTextContent('メンバー追加: 新加入 太郎');
    await user.click(within(changes).getByRole('button', { name: '確認して続ける' }));
    expect(await within(flow).findByTestId('flow-attendance')).toHaveTextContent('本日参加 8 / 8');
  }, 30_000);
});
