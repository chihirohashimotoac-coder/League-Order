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
import { createFixtureTransport, FAIL } from '../../test/n01/transport';
import { FIXTURE_NOW } from '../../test/n01/leagues';

vi.mock('../../pwa', () => ({ onUpdateAvailable: () => () => undefined, initServiceWorker: () => undefined }));

/**
 * Phase 1 through the real app shell, store and IndexedDB, with n01 served from the
 * fixture leagues: League → Team → Preview → create, then the managed format and the
 * roster with n01 PPR, then a re-sync.
 */

afterEach(cleanup);

let failRequests = false;

beforeEach(() => {
  window.scrollTo = vi.fn() as never;
  globalThis.indexedDB = new IDBFactory();
  resetBackendCache();
  failRequests = false;
});

const env: N01Environment = {
  createClient: () =>
    new N01Client(createFixtureTransport({ override: () => (failRequests ? FAIL : undefined) }), { now: () => FIXTURE_NOW }),
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
