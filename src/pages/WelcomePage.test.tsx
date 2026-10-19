import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { IDBFactory } from 'fake-indexeddb';
import 'fake-indexeddb/auto';
import '@testing-library/jest-dom/vitest';
import { App } from '../App';
import { AppStoreProvider } from '../state/appStore';
import { ToastProvider } from '../components/ui';
import { N01EnvironmentProvider, type N01Environment } from '../state/n01Environment';
import { N01Client } from '../integrations/n01/client';
import { openBackend, resetBackendCache } from '../storage/db';
import { Repository } from '../storage/repository';
import { FAIL, createFixtureTransport } from '../test/n01/transport';
import { FIXTURE_NOW } from '../test/n01/leagues';
import { validateFormat } from '../domain/games/format';

vi.mock('../pwa', () => ({ onUpdateAvailable: () => () => undefined, initServiceWorker: () => undefined }));

/**
 * FIRST RUN through the real app: the manual setup works for soft and hard darts alike
 * (and for "decide later"), keeps what was typed when going back or switching template,
 * and every dead end of the n01 wizard leads back to it.
 */

afterEach(cleanup);

let n01Down = false;

beforeEach(() => {
  window.scrollTo = vi.fn() as never;
  globalThis.indexedDB = new IDBFactory();
  resetBackendCache();
  n01Down = false;
});

const env: N01Environment = {
  createClient: () =>
    new N01Client(createFixtureTransport({ override: () => (n01Down ? FAIL : undefined) }), { now: () => FIXTURE_NOW }),
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

type User = ReturnType<typeof userEvent.setup>;
const stored = async () => new Repository(await openBackend()).loadAll();

async function teamStep(user: User, name: string, discipline: RegExp | null): Promise<void> {
  await user.click(await screen.findByRole('button', { name: '自分のチームを作る' }));
  await user.type(screen.getByLabelText('チーム名'), name);
  if (discipline) await user.click(screen.getByRole('radio', { name: discipline }));
  await user.click(screen.getByRole('button', { name: '次へ' }));
}

async function members(user: User, rows: [string, string, string][]): Promise<void> {
  for (const [index, [name, rating, ppr]] of rows.entries()) {
    if (index > 0) await user.click(screen.getByRole('button', { name: 'メンバーを追加' }));
    await user.type(screen.getByLabelText(`メンバー ${index + 1} の名前`), name);
    if (rating) await user.type(screen.getByLabelText(`メンバー ${index + 1} の Rating`), rating);
    if (ppr) await user.type(screen.getByLabelText(`メンバー ${index + 1} の PPR (3投平均)`), ppr);
  }
}

describe('first run: the two ways to start', () => {
  it('says what manual entry and the n01 import each cover', async () => {
    renderApp();
    const manual = (await screen.findByRole('heading', { name: /手入力で作成/ })).closest('section')!;
    expect(manual).toHaveTextContent('ソフト・ハード');
    expect(manual).toHaveTextContent('n01 に登録していなくても作れます');
    expect(manual).toHaveTextContent('Light League');
    const n01 = screen.getByRole('heading', { name: 'n01 League から取り込み' }).closest('section')!;
    expect(n01).toHaveTextContent('ATDO・TDO・TDA 以外のリーグも名前で検索できます');
    expect(n01).toHaveTextContent('n01 Online のスケジュールモードは対象外');
  });
});

describe('manual setup', () => {
  it('soft darts: the discipline is required, stored on the format, and the next step is shown', async () => {
    const user = userEvent.setup();
    renderApp();
    await teamStep(user, 'ソフトチーム', null);
    // No silent default: a choice is needed (and "あとで設定" is one).
    expect(await screen.findByText(/ダーツ種別を選んでください/)).toBeInTheDocument();
    await user.click(screen.getByRole('radio', { name: /ソフトダーツ/ }));
    await user.click(screen.getByRole('button', { name: '次へ' }));
    await members(user, [
      ['あおき', '14', ''],
      ['ばば', '9', ''],
    ]);
    await user.click(screen.getByRole('button', { name: '次へ' }));
    expect(screen.getByRole('radio', { name: /標準6ゲーム/ })).toHaveAttribute('aria-checked', 'true');
    expect(screen.getByText(/特定のリーグの公式ルールではありません/)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'チームを作成' }));

    await screen.findByRole('heading', { name: 'ソフトチーム', level: 1 });
    const next = screen.getByTestId('next-step');
    expect(next).toHaveTextContent('フォーマットの内容を確認');
    expect(next).toHaveTextContent('最初のオーダーを作る');
    const data = await stored();
    expect(data.formats).toHaveLength(1);
    expect(data.formats[0].discipline).toBe('SOFT');
    expect(data.players.map((player) => [player.name, player.rating, player.ppr])).toEqual([
      ['あおき', 14, null],
      ['ばば', 9, null],
    ]);
  });

  it('hard darts: PPR (3投平均) is entered, an 01-only format is offered, and the order is generated', async () => {
    const user = userEvent.setup();
    renderApp();
    await teamStep(user, 'ハードチーム', /ハードダーツ/);
    expect(screen.getByText(/PPR \(3投平均\) を入れると戦力評価に使います/)).toBeInTheDocument();
    await members(user, [
      ['いとう', '', '72.5'],
      ['うえだ', '', '61'],
      ['えのき', '', '55'],
    ]);
    await user.click(screen.getByRole('button', { name: '次へ' }));
    // Steel darts preselects the 01-only example, whose games are listed for checking.
    expect(screen.getByRole('radio', { name: /01のみ 5ゲーム/ })).toHaveAttribute('aria-checked', 'true');
    const preview = screen.getByTestId('template-preview');
    expect(preview).toHaveTextContent('5 ゲーム ・ 総枠 9');
    expect(preview).not.toHaveTextContent('Cricket');
    await user.click(screen.getByRole('button', { name: 'チームを作成' }));
    await screen.findByRole('heading', { name: 'ハードチーム', level: 1 });

    const data = await stored();
    expect(data.formats[0]).toMatchObject({ discipline: 'STEEL', name: '01のみ 5ゲーム (Singles/Doubles/Trios)' });
    expect(data.formats[0].games.every((game) => !game.kinds.includes('CRICKET'))).toBe(true);
    expect(validateFormat(data.formats[0].games)).toEqual([]);
    expect(data.players.map((player) => player.ppr)).toEqual([72.5, 61, 55]);

    await user.click(within(screen.getByTestId('next-step')).getByRole('button', { name: 'オーダーを作る' }));
    const basis = await screen.findByTestId('setup-strength-basis');
    expect(basis).toHaveTextContent('戦力評価 PPR 100%');
    expect(basis).toHaveTextContent('Rating が未入力のため、PPR (3投平均) だけで評価します');
    await user.click(screen.getByRole('button', { name: 'オーダーを生成' }));
    await screen.findByRole('heading', { name: 'オーダー結果' }, { timeout: 20_000 });
  }, 40_000);

  it('Rating only with "あとで設定": the note no longer claims an equal blend', async () => {
    const user = userEvent.setup();
    renderApp();
    await teamStep(user, 'あとでチーム', /あとで設定/);
    await members(user, [
      ['かとう', '12', ''],
      ['きむら', '8', ''],
    ]);
    await user.click(screen.getByRole('button', { name: '次へ' }));
    await user.click(screen.getByRole('button', { name: 'チームを作成' }));
    await screen.findByRole('heading', { name: 'あとでチーム', level: 1 });
    expect((await stored()).formats[0].discipline).toBe('UNSPECIFIED');

    await user.click(within(screen.getByTestId('next-step')).getByRole('button', { name: 'オーダーを作る' }));
    const basis = await screen.findByTestId('setup-strength-basis');
    expect(basis).toHaveTextContent('戦力評価 Rating 100%');
    expect(basis).not.toHaveTextContent('同じ比重');
  });

  it('keeps names and numbers through 戻る, template switching and leaving the setup', async () => {
    const user = userEvent.setup();
    renderApp();
    await teamStep(user, '保持チーム', /ソフトダーツ/);
    await members(user, [
      ['さとう', '13', '60'],
      ['すずき', '7', ''],
    ]);
    await user.click(screen.getByRole('button', { name: '次へ' }));
    await user.click(screen.getByRole('radio', { name: /01のみ Singles 4ゲーム/ }));
    await user.click(screen.getByRole('radio', { name: /ダブルス中心/ }));
    await user.click(screen.getByRole('button', { name: '戻る' }));
    expect(screen.getByLabelText('メンバー 1 の名前')).toHaveValue('さとう');
    expect(screen.getByLabelText('メンバー 1 の Rating')).toHaveValue(13);
    expect(screen.getByLabelText('メンバー 1 の PPR (3投平均)')).toHaveValue(60);
    expect(screen.getByLabelText('メンバー 2 の名前')).toHaveValue('すずき');

    // Back to the first step, cancel to the welcome screen, and come back.
    await user.click(screen.getByRole('button', { name: '戻る' }));
    await user.click(screen.getByRole('button', { name: 'キャンセル' }));
    await user.click(await screen.findByRole('button', { name: '自分のチームを作る' }));
    expect(screen.getByLabelText('チーム名')).toHaveValue('保持チーム');
    expect(screen.getByRole('radio', { name: /ソフトダーツ/ })).toBeChecked();
    await user.click(screen.getByRole('button', { name: '次へ' }));
    expect(screen.getByLabelText('メンバー 2 の Rating')).toHaveValue(7);
    await user.click(screen.getByRole('button', { name: '次へ' }));
    // The format picked by hand is still picked (a discipline change does not override it).
    expect(screen.getByRole('radio', { name: /ダブルス中心/ })).toHaveAttribute('aria-checked', 'true');
  });

  it('"自分の構成を作る" creates the team and opens the format editor', async () => {
    const user = userEvent.setup();
    renderApp();
    await teamStep(user, '自作チーム', /ハードダーツ/);
    await members(user, [['たなか', '', '50']]);
    await user.click(screen.getByRole('button', { name: '次へ' }));
    await user.click(screen.getByRole('radio', { name: /自分の構成を作る/ }));
    await user.click(screen.getByRole('button', { name: 'チームを作成' }));
    const editor = await screen.findByRole('dialog', { name: 'フォーマットを編集' });
    expect(within(editor).getByDisplayValue('自分のフォーマット')).toBeInTheDocument();
    expect(within(editor).getByRole('button', { name: 'Steel Darts' })).toHaveAttribute('aria-pressed', 'true');
  });
});

describe('n01 wizard dead ends lead back to manual entry', () => {
  it('an unsupported online-league URL: explained, then manual setup', async () => {
    const user = userEvent.setup();
    renderApp();
    await user.click(await screen.findByRole('button', { name: 'n01から作成' }));
    const wizard = await screen.findByRole('dialog', { name: 'n01から作成' });
    expect(within(wizard).getByTestId('wizard-intro')).toHaveTextContent('新しいチームを作成します');
    await user.click(within(wizard).getByText('リーグ ID / URL で指定'));
    await user.type(within(wizard).getByLabelText(/リーグ ID \/ n01 の URL/), 'https://light-league.example.com/league/123');
    await user.click(within(wizard).getByRole('button', { name: '決定' }));
    expect(within(wizard).getByRole('alert')).toHaveTextContent('ほかのサービスのリーグは自動連携の対象外です');
    await user.click(within(within(wizard).getByTestId('manual-fallback')).getByRole('button', { name: '手入力で作成する' }));
    await screen.findByRole('heading', { name: 'チームを作成' });
    expect(screen.queryByRole('dialog', { name: 'n01から作成' })).toBeNull();
  });

  it('an n01 page that is not an n01 League league (e.g. n01 Online) is refused with the reason', async () => {
    const user = userEvent.setup();
    renderApp();
    await user.click(await screen.findByRole('button', { name: 'n01から作成' }));
    const wizard = await screen.findByRole('dialog', { name: 'n01から作成' });
    await user.click(within(wizard).getByText('リーグ ID / URL で指定'));
    await user.type(within(wizard).getByLabelText(/リーグ ID \/ n01 の URL/), 'https://n01darts.com/n01/online/');
    await user.click(within(wizard).getByRole('button', { name: '決定' }));
    expect(within(wizard).getByRole('alert')).toHaveTextContent('n01 Online のスケジュールモードなど');
    expect(within(wizard).getByTestId('manual-fallback')).toBeInTheDocument();
  });

  it('a search with no result offers manual entry; another n01 League is found by name', async () => {
    const user = userEvent.setup();
    renderApp();
    await user.click(await screen.findByRole('button', { name: 'n01から作成' }));
    const wizard = await screen.findByRole('dialog', { name: 'n01から作成' });
    // The search is visible without opening anything.
    const search = within(wizard).getByTestId('league-search');
    await user.type(within(search).getByLabelText('リーグ名で検索'), 'ライトリーグ');
    await user.click(within(search).getByRole('button', { name: '検索' }));
    expect(await within(search).findByText(/見つかりませんでした/)).toBeInTheDocument();
    expect(within(search).getByTestId('manual-fallback')).toHaveTextContent('Light League');

    await user.clear(within(search).getByLabelText('リーグ名で検索'));
    await user.type(within(search).getByLabelText('リーグ名で検索'), 'TDA');
    await user.click(within(search).getByRole('button', { name: '検索' }));
    await user.click(await within(search).findByRole('button', { name: /TDA\s*lg_Ev9v_7379/ }));
    expect(await within(wizard).findByRole('heading', { name: /TDA のチームを選択/ })).toBeInTheDocument();
  });

  it('n01 unreachable: the failure offers manual entry, and the manual team generates without n01', async () => {
    n01Down = true;
    const user = userEvent.setup();
    renderApp();
    await user.click(await screen.findByRole('button', { name: 'n01から作成' }));
    const wizard = await screen.findByRole('dialog', { name: 'n01から作成' });
    await user.click(within(wizard).getByRole('button', { name: 'ATDO' }));
    await within(wizard).findByRole('alert');
    await user.click(within(within(wizard).getByTestId('manual-fallback')).getByRole('button', { name: '手入力で作成する' }));

    await user.type(await screen.findByLabelText('チーム名'), 'オフライン');
    await user.click(screen.getByRole('radio', { name: /ソフトダーツ/ }));
    await user.click(screen.getByRole('button', { name: '次へ' }));
    await members(user, [
      ['な', '10', ''],
      ['に', '8', ''],
    ]);
    await user.click(screen.getByRole('button', { name: '次へ' }));
    await user.click(screen.getByRole('radio', { name: /シングルス4ゲーム/ }));
    await user.click(screen.getByRole('button', { name: 'チームを作成' }));
    await screen.findByRole('heading', { name: 'オフライン', level: 1 });
    await user.click(within(screen.getByTestId('next-step')).getByRole('button', { name: 'オーダーを作る' }));
    await user.click(await screen.findByRole('button', { name: 'オーダーを生成' }));
    await screen.findByRole('heading', { name: 'オーダー結果' }, { timeout: 20_000 });
    await waitFor(() => expect(screen.queryByText(/n01 に接続できませんでした/)).toBeNull());
  }, 40_000);
});
