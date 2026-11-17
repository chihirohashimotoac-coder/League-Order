import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { useEffect } from 'react';
import { MatchesApi } from '../api';
import type { AnalyticsTransport } from '../../analytics/api/readApi';
import { RequestGovernor } from '../governor';
import type { MatchesApiFactory } from '../environment';
import { AppStoreProvider, useAppStore } from '../../../state/appStore';
import { FollowedView } from './FollowedView';
import { LeaguePicker } from './LeaguePicker';
import { followedGames, nowKind } from '../followedNow';
import { parseGameRows } from '../parse';
import { FOLLOWED_LEAGUE_MID, FOLLOWED_NAME, FOLLOWED_SINGLE_MID, FOLLOWED_TOURNAMENT_MID, followedNowRows } from '../../../test/n01/browse';

/**
 * 注目選手の試合: 大会・リーグ・個別の試合を横断して、登録した選手 (メンバー名を含む) が出場中の試合だけ。
 * 入口は観戦の選択画面で 3 入口の直後 (注目選手がいるときだけ)。
 */

afterEach(() => cleanup());

const rows = () => parseGameRows({ result: 0, list: followedNowRows('t_Test_0001', 't_Jdo0_0001') }).games;

/** 注目選手を登録してから中身を描く (ストアの読み込みを待つ)。 */
function Followed({ names, children }: { names: string[]; children: React.ReactNode }): React.JSX.Element | null {
  const store = useAppStore();
  useEffect(() => {
    if (store.ready && (store.settings.followed?.length ?? 0) !== names.length) store.updateSettings({ followed: names.map((name) => ({ name, team: null })) });
  }, [store, names]);
  return store.ready ? <>{children}</> : null;
}

const flush = async (): Promise<void> => {
  await act(async () => {
    for (let i = 0; i < 12; i += 1) await Promise.resolve();
  });
};

describe('followedNow', () => {
  it('大会・リーグ (メンバー名)・個別の試合を n01 の並びのまま拾い、登録していない選手の試合は除く', () => {
    const found = followedGames(rows(), new Set([FOLLOWED_NAME]));
    expect(found.map((entry) => entry.row.mid)).toEqual([FOLLOWED_TOURNAMENT_MID, FOLLOWED_LEAGUE_MID, FOLLOWED_SINGLE_MID]);
    expect(found.map((entry) => nowKind(entry.row))).toEqual(['tournament', 'league', 'single']);
    expect(found.every((entry) => entry.names.join() === FOLLOWED_NAME)).toBe(true);
    expect(followedGames(rows(), new Set())).toEqual([]);
    // 前後の空白は無視、同じ試合に 2 回出ても 1 回。
    expect(followedGames(rows(), new Set(['田中 花子', '相田 二郎'])).map((entry) => entry.names)).toEqual([['田中 花子'], ['相田 二郎']]);
  });
});

describe('FollowedView', () => {
  // 注目選手の設定が後から読み込まれても (直接開いた・再読み込み)、そろった時点で 1 回読む。
  function factoryOf(reply: () => unknown) {
    const calls: Record<string, string>[] = [];
    const transport: AnalyticsTransport = {
      request: async (_operation, params) => {
        calls.push(params);
        const value = reply();
        if (value instanceof Error) throw value;
        return value;
      },
    };
    const api = new MatchesApi({ transport, governor: new RequestGovernor(100_000), pollPerMinute: 100_000 });
    const factory: MatchesApiFactory = () => api;
    return { factory, calls };
  }

  it('開いたときに 1 回読み、失敗は再試行でき、該当なしは別の表示', async () => {
    let mode: 'fail' | 'none' | 'ok' = 'fail';
    const { factory, calls } = factoryOf(() => (mode === 'fail' ? { result: -54, error: 'slow' } : { result: 0, list: mode === 'none' ? [] : followedNowRows('t_Test_0001', 't_Jdo0_0001') }));
    const onGame = vi.fn();
    render(
      <AppStoreProvider>
        <Followed names={[FOLLOWED_NAME]}>
          <FollowedView factory={factory} backLabel="戻る" onBack={vi.fn()} onGame={onGame} />
        </Followed>
      </AppStoreProvider>,
    );
    await flush();
    await flush();
    expect(screen.getByTestId('followed-error').textContent).toContain('進行中の試合を取得できませんでした');
    expect(screen.queryByTestId('followed-empty')).toBeNull();
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ live: '1', endMatch: '0' });
    mode = 'none';
    fireEvent.click(screen.getByRole('button', { name: '再試行' }));
    await flush();
    expect(screen.getByTestId('followed-empty').textContent).toBe('いま出場中の注目選手はいません。');
    mode = 'ok';
    fireEvent.click(screen.getByRole('button', { name: '最新の試合を取得' }));
    await flush();
    expect(screen.getAllByTestId('followed-game')).toHaveLength(3);
    fireEvent.click(screen.getAllByTestId('followed-game')[1]);
    expect(onGame).toHaveBeenCalledWith(FOLLOWED_LEAGUE_MID, 'Arrows vs Bulls');
  });
});

describe('LeaguePicker (観戦の初期画面・見るものを変更)', () => {
  it('注目選手がいるときだけ、3 入口の直後に「注目選手の試合」', async () => {
    const onFollowed = vi.fn();
    const { unmount } = render(
      <AppStoreProvider>
        <Followed names={[]}>
          <LeaguePicker onPick={vi.fn()} onBrowse={vi.fn()} onFollowed={onFollowed} />
        </Followed>
      </AppStoreProvider>,
    );
    await flush();
    await flush();
    expect(screen.queryByTestId('followed-entry')).toBeNull();
    unmount();
    render(
      <AppStoreProvider>
        <Followed names={[FOLLOWED_NAME, '田中 花子']}>
          <LeaguePicker onPick={vi.fn()} onBrowse={vi.fn()} onFollowed={onFollowed} />
        </Followed>
      </AppStoreProvider>,
    );
    await flush();
    await flush();
    const group = screen.getByRole('group', { name: 'n01 の一覧から探す' });
    expect([...group.querySelectorAll('button')].map((button) => button.textContent)).toEqual(['n01オンライン', 'n01トーナメント', 'n01リーグ', '★ 注目選手の試合 (2 人)']);
    fireEvent.click(screen.getByTestId('followed-entry'));
    expect(onFollowed).toHaveBeenCalledTimes(1);
  });
});
