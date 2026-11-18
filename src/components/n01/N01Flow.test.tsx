import { openScreen } from '../../test/appHarness';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react';
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
/** Names dropped from kalavinka's roster on later syncs (a player who left the team). */
let dropRoster: string[] = [];
/** While set, every n01 request waits for it: a slow venue connection. */
let gate: Promise<void> | null = null;

beforeEach(() => {
  window.scrollTo = vi.fn() as never;
  globalThis.indexedDB = new IDBFactory();
  resetBackendCache();
  failRequests = false;
  failOpponent = false;
  extraRoster = [];
  dropRoster = [];
  gate = null;
});

async function flush(): Promise<void> {
  for (let i = 0; i < 20; i += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

/** Holds every n01 request until `release` is called. */
function holdN01(): () => void {
  let release!: () => void;
  gate = new Promise<void>((resolve) => {
    release = () => {
      gate = null;
      resolve();
    };
  });
  return release;
}

const env: N01Environment = {
  createClient: () =>
    new N01Client(
      gated(createFixtureTransport({
        override: (request) => {
          if (failRequests) return FAIL;
          if (failOpponent && request.operation === 'team/player/list' && request.params.tpid === '68wv') return FAIL;
          if ((extraRoster.length > 0 || dropRoster.length > 0) && request.operation === 'team/player/list' && request.params.tpid === 'GpiQ') {
            const base = fixtureResponse(request, allFixtureDatasets()) as { list: { oname?: string }[] };
            return { list: [...base.list.filter((entry) => !dropRoster.includes(entry.oname ?? '')), ...extraRoster] };
          }
          return undefined;
        },
      })),
      { now: () => FIXTURE_NOW },
    ),
  now: () => FIXTURE_NOW,
};

function gated(transport: ReturnType<typeof createFixtureTransport>): ReturnType<typeof createFixtureTransport> {
  return {
    async request(request, signal) {
      if (gate) await gate;
      return transport.request(request, signal);
    },
  };
}

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
    await openScreen(user, 'フォーマット');
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
    await openScreen(user, 'メンバー');
    const row = (await screen.findByText('中村 蓮')).closest('.list-row')!;
    expect(row).toHaveTextContent('戦力データ未設定');
    expect(row).not.toHaveTextContent('PPR 0');
    const hashimoto = screen.getByText('橋本 千尋').closest('.list-row')!;
    expect(hashimoto).toHaveTextContent(/PPR \d+(\.\d+)? ・ PPR n01/);
  });

  it('HOME counts n01 PPR as strength data, not only Rating', async () => {
    const user = userEvent.setup();
    renderApp();
    await createKalavinka(user);
    const players = (await new Repository(await (await import('../../storage/db')).openBackend()).loadAll()).players;
    const withPpr = players.filter((player) => player.n01?.stats?.ppr != null || player.ppr != null).length;
    expect(withPpr).toBeGreaterThan(0);
    const coverage = await screen.findByTestId('strength-coverage');
    // No Rating was typed, yet the members with an n01 PPR are counted — the same values
    // the order generator uses.
    expect(coverage).toHaveTextContent(`戦力データあり ${withPpr} / ${players.length} 名 (Rating または PPR)`);
    expect(coverage).toHaveTextContent(`Rating 0 名 ・ PPR (3投平均) ${withPpr} 名`);
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
    // Linking is not creating: the wizard says which team it attaches to, and offers no
    // way to a new manual team.
    expect(within(wizard).getByTestId('wizard-intro')).toHaveTextContent('既存のチーム「KALAVINKA」に n01 League のチームを接続します');
    expect(within(wizard).getByTestId('wizard-intro')).toHaveTextContent('新しいチームは作られず');
    expect(within(wizard).queryByRole('button', { name: /手入力で作成/ })).toBeNull();
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
    await user.click(screen.getByRole('button', { name: '次戦のオーダーを作る' }));
    await screen.findByRole('heading', { name: 'オーダー設定' });
    await screen.findByTestId('flow-ready', {}, { timeout: 10_000 });
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

describe('next match order on ORDER SETUP (Phase 5)', () => {
  /** HOME → 次戦のオーダーを作る: SETUP opens at once; resolves once n01 has answered. */
  async function startNextMatch(user: ReturnType<typeof userEvent.setup>): Promise<HTMLElement> {
    await user.click(screen.getByRole('button', { name: '次戦のオーダーを作る' }));
    await screen.findByRole('heading', { name: 'オーダー設定' });
    return screen.getByTestId('match-source');
  }
  const generateButton = (): HTMLElement => screen.getByRole('button', { name: /オーダーを生成|生成中/ });
  const box = (name: string): HTMLInputElement => screen.getByRole('checkbox', { name: `${name} を参加者に含める` });

  it('HOME shows the next match; one tap opens SETUP, syncs there, and the order is made from the same page', async () => {
    const user = userEvent.setup();
    renderApp();
    await createKalavinka(user);
    const card = screen.getByTestId('next-match-card');
    expect(card).toHaveTextContent('vs スピンコブラ');
    expect(card).toHaveTextContent('10/8');
    expect(card).toHaveTextContent('kalavinka ・ ATDO ・ A Division');
    expect(screen.getByTestId('n01-freshness')).toHaveTextContent('n01 ✓ 最新');
    // The old hero (catch copy and a second "new order" button) is gone.
    expect(screen.queryByRole('button', { name: '新しいオーダーを作る' })).toBeNull();
    expect(screen.queryByText('速く・公平に・強く。')).toBeNull();

    const source = await startNextMatch(user);
    // No sheet and no attendance screen in between.
    expect(screen.queryByRole('dialog', { name: '次戦のオーダーを作る' })).toBeNull();
    const ready = await within(source).findByTestId('flow-ready', {}, { timeout: 10_000 });
    expect(ready).toHaveTextContent('n01 ✓ 最新');
    expect(source).toHaveTextContent('n01 の次戦');
    expect(source).toHaveTextContent('vs スピンコブラ');
    expect(screen.getByRole('heading', { name: /参加者 7 \/ 7/ })).toBeInTheDocument();
    expect(screen.getByRole('radio', { name: /対戦相手最適化/ })).toHaveAttribute('aria-checked', 'true');
    expect(screen.getByTestId('setup-opponent')).toHaveTextContent('相手の出場予測を使えます');
    expect(document.querySelector('.match-summary')).toHaveTextContent('vs スピンコブラ ・ 2026-10-08');
    // Nothing was generated by opening or syncing.
    expect(screen.queryByRole('heading', { name: 'オーダー結果' })).toBeNull();

    await user.click(box('伊藤 由佳'));
    expect(screen.getByRole('heading', { name: /参加者 6 \/ 7/ })).toBeInTheDocument();
    await user.click(generateButton());

    await screen.findByRole('heading', { name: 'オーダー結果' }, { timeout: 20_000 });
    expect(screen.getByTestId('opponent-panel')).toHaveTextContent('スピンコブラ');
    const fielded = [...document.querySelectorAll<HTMLSelectElement>('.order-game select')].map(
      (select) => select.selectedOptions[0]?.textContent ?? '',
    );
    expect(fielded.length).toBe(12);
    expect(fielded.some((name) => name.includes('伊藤 由佳'))).toBe(false);

    // The next time, today's attendance starts from last time's.
    await user.click(within(screen.getByRole('navigation', { name: 'メインナビゲーション' })).getByRole('button', { name: 'ホーム' }));
    const again = await startNextMatch(user);
    await within(again).findByTestId('flow-ready', {}, { timeout: 10_000 });
    expect(box('伊藤 由佳').checked).toBe(false);
  }, 60_000);

  it('a slow n01: SETUP is on screen first, locked; switching to a match by hand is never overwritten by the late answer', async () => {
    const user = userEvent.setup();
    renderApp();
    await createKalavinka(user);
    const release = holdN01();
    const source = await startNextMatch(user);
    // Open before n01 has answered: the progress is shown, the conditions and 生成 are locked.
    expect(within(source).getByTestId('setup-syncing')).toHaveTextContent('n01から試合情報を取得中…');
    expect(generateButton()).toBeDisabled();
    expect(box('伊藤 由佳')).toBeDisabled();
    // The way out and back stay usable.
    expect(within(source).getByRole('button', { name: '別の試合を作る' })).toBeEnabled();

    await user.click(within(source).getByRole('button', { name: '別の試合を作る' }));
    expect(source).toHaveTextContent('作成する試合');
    expect(source).toHaveTextContent('手動で設定');
    expect(generateButton()).toBeEnabled();
    expect(screen.queryByRole('radio', { name: /対戦相手最適化/ })).toBeNull();
    expect(screen.queryByTestId('setup-opponent')).toBeNull();
    await user.click(screen.getByText('試合情報 (任意)'));
    const opponent = screen.getByLabelText('対戦相手 (任意)');
    expect(opponent).toHaveValue('');
    await user.type(opponent, '手入力クラブ');
    await user.click(box('伊藤 由佳'));

    // n01 answers now: nothing typed or ticked by hand changes.
    release();
    await flush();
    expect(source).toHaveTextContent('手動で設定');
    expect(screen.getByLabelText('対戦相手 (任意)')).toHaveValue('手入力クラブ');
    expect(box('伊藤 由佳').checked).toBe(false);
    expect(screen.queryByTestId('setup-opponent')).toBeNull();

    // Back to the next match: fetched again, with its own conditions.
    await user.click(within(source).getByRole('button', { name: 'n01の次戦を使う' }));
    await within(source).findByTestId('flow-ready', {}, { timeout: 10_000 });
    expect(box('伊藤 由佳').checked).toBe(true);
    expect(document.querySelector('.match-summary')).toHaveTextContent('vs スピンコブラ');
    // … and the hand-made match is still as it was left.
    await user.click(within(source).getByRole('button', { name: '別の試合を作る' }));
    expect(document.querySelector('.match-summary')).toHaveTextContent('vs 手入力クラブ');
    expect(box('伊藤 由佳').checked).toBe(false);

    // Generated by hand: no opponent data of the n01 next match goes into the order …
    await user.click(generateButton());
    await screen.findByRole('heading', { name: 'オーダー結果' }, { timeout: 20_000 });
    expect(screen.queryByTestId('opponent-panel')).toBeNull();
    // … nor into a re-generation after going back to SETUP (audit 2026-11-17).
    await user.click(within(screen.getByRole('navigation', { name: 'メインナビゲーション' })).getByRole('button', { name: 'ホーム' }));
    await user.click(screen.getByRole('button', { name: /作業中のオーダーを開く/ }));
    await screen.findByRole('heading', { name: 'オーダー結果' });
    await user.click(screen.getByRole('button', { name: '戻る' }));
    await screen.findByRole('heading', { name: 'オーダー設定' });
    expect(screen.queryByTestId('setup-opponent')).toBeNull();
    expect(screen.queryByRole('radio', { name: /対戦相手最適化/ })).toBeNull();
    expect(screen.getByLabelText('対戦相手 (任意)')).toHaveValue('手入力クラブ');
    await user.click(generateButton());
    await screen.findByRole('heading', { name: 'オーダー結果' }, { timeout: 20_000 });
    expect(screen.queryByTestId('opponent-panel')).toBeNull();
    await user.click(screen.getByRole('button', { name: '下書きを保存' }));
    const { openBackend } = await import('../../storage/db');
    await waitFor(async () => expect((await new Repository(await openBackend()).loadAll()).orders).toHaveLength(1));
    expect((await new Repository(await openBackend()).loadAll()).orders[0].input.opponent).toBeUndefined();

    // Reopened from history, it is still that match: re-generated without the n01 next match.
    await openScreen(user, '履歴');
    await user.click(await screen.findByRole('button', { name: /勝利|バランス|公平|育成|ペア|カスタム|20\d\d/ }));
    await user.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'このオーダーを開いて編集' }));
    await screen.findByRole('heading', { name: 'オーダー結果' });
    await user.click(screen.getByRole('button', { name: '戻る' }));
    await screen.findByRole('heading', { name: 'オーダー設定' });
    expect(screen.queryByTestId('setup-opponent')).toBeNull();
    await user.click(generateButton());
    await screen.findByRole('heading', { name: 'オーダー結果' }, { timeout: 20_000 });
    expect(screen.queryByTestId('opponent-panel')).toBeNull();
  }, 90_000);

  it('the next match offers only players on the n01 roster, as its attendance always did', async () => {
    const user = userEvent.setup();
    renderApp();
    await createKalavinka(user);
    dropRoster = ['中村 蓮'];
    const source = await startNextMatch(user);
    const changes = await within(source).findByTestId('flow-changes', {}, { timeout: 10_000 });
    await user.click(within(changes).getByRole('button', { name: '確認して続ける' }));
    await within(source).findByTestId('flow-ready');
    expect(screen.queryByRole('checkbox', { name: '中村 蓮 を参加者に含める' })).toBeNull();
    await user.click(screen.getByRole('button', { name: '解除' }));
    await user.click(screen.getByRole('button', { name: '全員' }));
    expect(screen.getByRole('heading', { name: /参加者 6 \/ 6/ })).toBeInTheDocument();
    await user.click(generateButton());
    await screen.findByRole('heading', { name: 'オーダー結果' }, { timeout: 20_000 });
    const fielded = [...document.querySelectorAll<HTMLSelectElement>('.order-game select')].map((select) => select.selectedOptions[0]?.textContent ?? '');
    expect(fielded.some((name) => name.includes('中村 蓮'))).toBe(false);
  }, 60_000);

  it('without its n01 format the next match is not generated; a match by hand still is', async () => {
    const user = userEvent.setup();
    renderApp();
    await createKalavinka(user);
    // A hand-made copy exists; the managed format itself is gone from the device.
    await openScreen(user, 'フォーマット');
    await user.click(await screen.findByRole('button', { name: /ATDO 2026 3rd A Division.*n01 管理/ }));
    await user.click(within(await screen.findByRole('dialog', { name: 'n01 管理フォーマット' })).getByRole('button', { name: 'コピーして手動フォーマット' }));
    await screen.findByText('ATDO 2026 3rd A Division (手動)');
    cleanup();
    const { openBackend } = await import('../../storage/db');
    const backend = await openBackend();
    const stored = await new Repository(backend).loadAll();
    const team = stored.teams.find((entry) => entry.name === 'kalavinka')!;
    await backend.remove('formats', team.n01!.managedFormatId!);
    failRequests = true;
    renderApp();
    await screen.findByRole('heading', { name: 'kalavinka', level: 1 });
    const source = await startNextMatch(user);
    await user.click(await within(source).findByRole('button', { name: '前回データで続ける' }));
    expect(within(source).getByRole('alert')).toHaveTextContent('n01 のフォーマットがありません');
    expect(generateButton()).toBeDisabled();
    await user.click(within(source).getByRole('button', { name: '別の試合を作る' }));
    expect(generateButton()).toBeEnabled();
  }, 60_000);

  it('the next match keeps its own helpers and attendance changes, never the hand-made match’s', async () => {
    const user = userEvent.setup();
    renderApp();
    await createKalavinka(user);
    const source = await startNextMatch(user);
    await within(source).findByTestId('flow-ready', {}, { timeout: 10_000 });
    await user.click(screen.getByRole('button', { name: '今回だけ助っ人を追加' }));
    const editor = await screen.findByRole('dialog', { name: '今回だけ助っ人を追加' });
    await user.type(within(editor).getByPlaceholderText('例: ちひろ'), '助っ人 花子');
    await user.click(within(editor).getByRole('button', { name: '助っ人として追加' }));
    await user.click(box('中村 蓮'));
    expect(screen.getByRole('heading', { name: /参加者 7 \/ 8/ })).toBeInTheDocument();

    await user.click(within(source).getByRole('button', { name: '別の試合を作る' }));
    expect(screen.queryByRole('checkbox', { name: '助っ人 花子 を参加者に含める' })).toBeNull();
    expect(box('中村 蓮').checked).toBe(true);
    expect(screen.getByRole('heading', { name: /参加者 7 \/ 7/ })).toBeInTheDocument();
    // A match by hand starts with no opponent and no date (the league name stays).
    expect(document.querySelector('.match-summary')?.textContent).toBe('ATDO');

    await user.click(within(source).getByRole('button', { name: 'n01の次戦を使う' }));
    expect(box('助っ人 花子').checked).toBe(true);
    expect(box('中村 蓮').checked).toBe(false);
  }, 60_000);

  it('the work open in this session stays until a new order is generated; cancelling the discard keeps it', async () => {
    const user = userEvent.setup();
    renderApp();
    await createKalavinka(user);
    let source = await startNextMatch(user);
    await within(source).findByTestId('flow-ready', {}, { timeout: 10_000 });
    await user.click(generateButton());
    await screen.findByRole('heading', { name: 'オーダー結果' }, { timeout: 20_000 });
    const firstLabel = document.querySelector('.candidate-tab[aria-selected="true"] .c-label')?.textContent;

    // HOME → the same button: SETUP opens, the order is still there to resume.
    await user.click(within(screen.getByRole('navigation', { name: 'メインナビゲーション' })).getByRole('button', { name: 'ホーム' }));
    source = await startNextMatch(user);
    expect(screen.queryByRole('dialog', { name: '新しいオーダーを作る' })).toBeNull();
    await within(source).findByTestId('flow-ready', {}, { timeout: 10_000 });
    await user.click(within(source).getByRole('button', { name: '別の試合を作る' }));
    await user.click(box('伊藤 由佳'));
    // Generating replaces unsaved work: asked first; cancelled, nothing changes.
    await user.click(generateButton());
    const dialog = await screen.findByRole('dialog', { name: '新しいオーダーを作る' });
    await user.click(within(dialog).getByRole('button', { name: 'キャンセル' }));
    expect(screen.getByRole('heading', { name: 'オーダー設定' })).toBeInTheDocument();
    expect(box('伊藤 由佳').checked).toBe(false);
    await user.click(screen.getByRole('button', { name: /作業中のオーダーを開く/ }));
    await screen.findByRole('heading', { name: 'オーダー結果' });
    expect(document.querySelector('.candidate-tab[aria-selected="true"] .c-label')?.textContent).toBe(firstLabel);
    expect(screen.getByTestId('opponent-panel')).toHaveTextContent('スピンコブラ');
  }, 90_000);

  it('a new order is never a revision of the finalized order that was open', async () => {
    const user = userEvent.setup();
    renderApp();
    await createKalavinka(user);
    let source = await startNextMatch(user);
    await within(source).findByTestId('flow-ready', {}, { timeout: 10_000 });
    await user.click(generateButton());
    await screen.findByRole('heading', { name: 'オーダー結果' }, { timeout: 20_000 });
    await user.click(screen.getByRole('button', { name: /オーダーを確定/ }));
    await waitFor(() => expect(document.querySelector('.app-header')).toHaveTextContent('v1'));

    await user.click(within(screen.getByRole('navigation', { name: 'メインナビゲーション' })).getByRole('button', { name: 'ホーム' }));
    source = await startNextMatch(user);
    await within(source).findByTestId('flow-ready', {}, { timeout: 10_000 });
    // Not the editing banner of the saved order: this is a new one.
    expect(screen.queryByTestId('editing-banner')).toBeNull();
    await user.click(box('伊藤 由佳'));
    await user.click(generateButton());
    // Saved work is not asked about.
    await screen.findByRole('heading', { name: 'オーダー結果' }, { timeout: 20_000 });
    expect(screen.queryByRole('dialog', { name: '新しいオーダーを作る' })).toBeNull();
    expect(document.querySelector('.app-header')).toHaveTextContent('DRAFT');
    await user.click(screen.getByRole('button', { name: '下書きを保存' }));
    const { openBackend } = await import('../../storage/db');
    await waitFor(async () => expect((await new Repository(await openBackend()).loadAll()).orders).toHaveLength(2));
    const orders = (await new Repository(await openBackend()).loadAll()).orders;
    expect(orders.map((order) => order.versions.length).sort()).toEqual([0, 1]);
  }, 90_000);

  it('offline: names the last sync and continues with that data only when asked', async () => {
    const user = userEvent.setup();
    renderApp();
    await createKalavinka(user);
    failRequests = true;
    const source = await startNextMatch(user);
    const offline = await within(source).findByTestId('flow-offline');
    expect(offline).toHaveTextContent('n01 に接続できませんでした');
    expect(offline).toHaveTextContent('前回:');
    expect(offline).toHaveTextContent('このデータは最新ではありません');
    expect(generateButton()).toBeDisabled();
    await user.click(within(offline).getByRole('button', { name: '前回データで続ける' }));
    expect(within(source).getByTestId('flow-stale')).toHaveTextContent('最新ではありません');
    expect(generateButton()).toBeEnabled();
    expect(screen.getByTestId('setup-opponent')).toHaveTextContent('次戦: vs スピンコブラ');
    // Focus is not lost with the button that was pressed.
    expect(document.activeElement).toBe(screen.getByRole('heading', { name: /vs スピンコブラ/, level: 2 }));
  }, 30_000);

  it('offline with nothing on the device: only 再試行 and the match by hand are offered', async () => {
    const user = userEvent.setup();
    renderApp();
    await createKalavinka(user);
    // The device's n01 data is gone (cleared storage), and n01 cannot be reached.
    cleanup();
    const { openBackend } = await import('../../storage/db');
    const backend = await openBackend();
    for (const record of await new Repository(backend).loadN01Cache()) await backend.remove('n01Cache', (record as { id: string }).id);
    failRequests = true;
    renderApp();
    await screen.findByRole('heading', { name: 'kalavinka', level: 1 });
    const source = await startNextMatch(user);
    const offline = await within(source).findByTestId('flow-offline');
    expect(offline).toHaveTextContent('この端末には前回のデータがありません');
    expect(within(offline).queryByRole('button', { name: '前回データで続ける' })).toBeNull();
    expect(within(offline).getByRole('button', { name: '再試行' })).toBeInTheDocument();
    await user.click(within(source).getByRole('button', { name: '別の試合を作る' }));
    expect(generateButton()).toBeEnabled();
  }, 30_000);

  it('a re-sync whose opponent analysis fails drops the old analysis instead of showing it as current', async () => {
    const user = userEvent.setup();
    renderApp();
    await createKalavinka(user);
    expect(screen.getByTestId('next-match-card')).toHaveTextContent('vs スピンコブラ');
    failOpponent = true;
    const source = await startNextMatch(user);
    const changes = await within(source).findByTestId('flow-changes', {}, { timeout: 10_000 });
    expect(changes).toHaveTextContent('次戦の分析データを取得できませんでした');
    expect(generateButton()).toBeDisabled();
    await user.click(within(changes).getByRole('button', { name: '確認して続ける' }));
    expect(within(source).getByTestId('flow-no-opponent')).toHaveTextContent('次戦の相手データがないため、勝利優先で作成します。');
    expect(source).not.toHaveTextContent('スピンコブラ');
    expect(screen.getByRole('radio', { name: /勝利優先/ })).toHaveAttribute('aria-checked', 'true');
    expect(screen.queryByTestId('setup-opponent')).toBeNull();
    await user.click(within(screen.getByRole('navigation', { name: 'メインナビゲーション' })).getByRole('button', { name: 'ホーム' }));
    expect(screen.getByTestId('next-match-card')).toHaveTextContent('次戦: 未取得');
  }, 30_000);

  it('stops to show an important n01 change before going on', async () => {
    const user = userEvent.setup();
    renderApp();
    await createKalavinka(user);
    extraRoster = [{ opid: 'op_newcomer', oid: 'o3_op_newcomer', tpid: 'GpiQ', oname: '新加入 太郎' }];
    const source = await startNextMatch(user);
    const changes = await within(source).findByTestId('flow-changes', {}, { timeout: 10_000 });
    expect(changes).toHaveTextContent('メンバー追加: 新加入 太郎');
    await user.click(within(changes).getByRole('button', { name: '確認して続ける' }));
    await within(source).findByTestId('flow-ready');
    expect(screen.getByRole('heading', { name: /参加者 8 \/ 8/ })).toBeInTheDocument();
  }, 30_000);
});
