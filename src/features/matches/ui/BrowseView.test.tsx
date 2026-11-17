import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { MatchesApi } from '../api';
import type { AnalyticsTransport } from '../../analytics/api/readApi';
import { RequestGovernor } from '../governor';
import type { MatchesApiFactory } from '../environment';
import type { BrowseCategory } from '../browse';
import { AppStoreProvider } from '../../../state/appStore';
import { BrowseView, resetBrowseMemory } from './BrowseView';
import { browseReply } from '../../../test/n01/browse';

/**
 * 一覧の非同期の競合: 後から送った検索・カテゴリ切替の応答を、先に送った古い応答で上書きしない。
 * 次ページは n01 の並びのまま足し、取得失敗・0 件・検索結果 0 件を区別する。
 */

afterEach(() => {
  cleanup();
  resetBrowseMemory();
});

interface Pending {
  operation: string;
  params: Record<string, string>;
  resolve: () => void;
  fail: () => void;
}

/** 応答を手で返す n01: 送られた順に `pending` に並ぶ。 */
function manual(options: { ignoreAbort?: boolean } = {}) {
  const pending: Pending[] = [];
  const transport: AnalyticsTransport = {
    request: (operation, params, signal) =>
      new Promise((resolve, reject) => {
        if (!options.ignoreAbort) signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
        pending.push({ operation, params, resolve: () => resolve(browseReply(operation, params)), fail: () => resolve({ result: -54, error: 'slow' }) });
      }),
  };
  const api = new MatchesApi({ transport, governor: new RequestGovernor(100_000), pollPerMinute: 100_000 });
  const factory: MatchesApiFactory = () => api;
  return { pending, factory };
}

const flush = async (): Promise<void> => {
  await act(async () => {
    for (let i = 0; i < 12; i += 1) await Promise.resolve();
  });
};

function view(factory: MatchesApiFactory, category: BrowseCategory, onCategory = vi.fn()) {
  const props = { factory, backLabel: '戻る', onBack: vi.fn(), onCategory, onTournament: vi.fn(), onLeague: vi.fn(), onGame: vi.fn() };
  const result = render(
    <AppStoreProvider>
      <BrowseView category={category} {...props} />
    </AppStoreProvider>,
  );
  return {
    ...result,
    props,
    show: (next: BrowseCategory) =>
      result.rerender(
        <AppStoreProvider>
          <BrowseView category={next} {...props} />
        </AppStoreProvider>,
      ),
  };
}

const titles = (): string[] => screen.queryAllByTestId('browse-tournament').map((row) => row.querySelector('.n01-row-title')!.textContent ?? '');

describe('BrowseView', () => {
  it('先に送った検索の応答が後から届いても、新しい検索の一覧を上書きしない', async () => {
    const { pending, factory } = manual();
    view(factory, 'tournament');
    await flush();
    pending[0].resolve();
    await flush();
    expect(screen.getAllByTestId('browse-tournament')).toHaveLength(30);
    const box = screen.getByRole('searchbox', { name: '大会名で検索' });
    fireEvent.change(box, { target: { value: 'Самбар' } });
    fireEvent.submit(box.closest('form')!);
    await flush(); // 1 つ目の検索は送信済み (応答待ち)
    fireEvent.change(box, { target: { value: 'Weekly' } });
    fireEvent.submit(box.closest('form')!);
    await flush();
    expect(pending.map((entry) => entry.params.keyword)).toEqual([undefined, 'Самбар', 'Weekly']);
    pending[2].resolve();
    await flush();
    pending[1].resolve(); // 古い応答 (中止済み)
    await flush();
    expect(titles()).toEqual(['Weekly Cup', 'Weekly Cup']);
    expect(screen.getByTestId('browse-meta').textContent).toContain('「Weekly」の検索結果');
  });

  it('中止に応じない通信でも、古い応答は送った順の番号で捨てる', async () => {
    const { pending, factory } = manual({ ignoreAbort: true });
    view(factory, 'tournament');
    await flush();
    const box = screen.getByRole('searchbox', { name: '大会名で検索' });
    fireEvent.change(box, { target: { value: 'Weekly' } });
    fireEvent.submit(box.closest('form')!);
    await flush();
    expect(pending.map((entry) => entry.params.keyword)).toEqual([undefined, 'Weekly']);
    pending[1].resolve();
    await flush();
    pending[0].resolve(); // 最初の (検索語なしの) 一覧が遅れて届く
    await flush();
    expect(titles()).toEqual(['Weekly Cup', 'Weekly Cup']);
  });

  it('カテゴリを切り替えたあとに前のカテゴリの応答が届いても、表示中の一覧は変わらない', async () => {
    const { pending, factory } = manual();
    const screenView = view(factory, 'tournament');
    await flush();
    screenView.show('league');
    await flush();
    expect(pending.map((entry) => entry.operation)).toEqual(['tournament/list', 'league/list']);
    pending[1].resolve();
    await flush();
    pending[0].resolve();
    await flush();
    expect(screen.getAllByTestId('browse-league')).toHaveLength(30);
    expect(screen.queryAllByTestId('browse-tournament')).toHaveLength(0);
  });

  it('次ページは n01 の並びのまま後ろに足し、重なった行は 1 つにする。読み込み中の二重送信はしない', async () => {
    const { pending, factory } = manual();
    view(factory, 'tournament');
    await flush();
    pending[0].resolve();
    await flush();
    fireEvent.click(screen.getByTestId('browse-more'));
    await flush();
    expect((screen.getByTestId('browse-more') as HTMLButtonElement).disabled).toBe(true);
    expect(pending[1].params.skip).toBe('30');
    pending[1].resolve();
    await flush();
    expect(screen.getAllByTestId('browse-tournament')).toHaveLength(45);
    expect(screen.getByTestId('browse-count').textContent).toBe('読み込み済み 45 件');
    expect(screen.queryByTestId('browse-more')).toBeNull();
  });

  it('取得失敗・0 件・検索結果 0 件を区別する。次ページの失敗では読み込んだ一覧を残す', async () => {
    const { pending, factory } = manual();
    view(factory, 'league');
    await flush();
    pending[0].fail();
    await flush();
    expect(screen.getByTestId('browse-error').textContent).toContain('一覧を取得できませんでした');
    expect(screen.queryByTestId('browse-empty')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: '再試行' }));
    await flush();
    pending[1].resolve();
    await flush();
    expect(screen.getAllByTestId('browse-league')).toHaveLength(30);
    fireEvent.click(screen.getByTestId('browse-more'));
    await flush();
    pending[2].fail();
    await flush();
    expect(screen.getAllByTestId('browse-league')).toHaveLength(30);
    expect(screen.getByTestId('browse-more-error').textContent).toContain('続きを取得できませんでした');
    const box = screen.getByRole('searchbox', { name: 'リーグ名で検索' });
    fireEvent.change(box, { target: { value: 'zzz' } });
    fireEvent.submit(box.closest('form')!);
    await flush();
    pending[3].resolve();
    await flush();
    expect(screen.getByTestId('browse-empty').textContent).toBe('「zzz」に一致するリーグは見つかりませんでした。');
  });

  it('オンライン: 応答に紛れた大会の試合・中継は掲載せず、件数に数えない', async () => {
    const { pending, factory } = manual();
    view(factory, 'online');
    await flush();
    pending[0].resolve();
    await flush();
    expect(screen.getAllByTestId('browse-online')).toHaveLength(4);
    expect(screen.getByTestId('browse-count').textContent).toBe('読み込み済み 4 試合');
    expect(screen.getByTestId('browse-notes').textContent).toContain('2 行は掲載していません');
    expect(screen.getByTestId('official-lobby').getAttribute('href')).toBe('https://n01darts.com/n01/online/');
  });
});
