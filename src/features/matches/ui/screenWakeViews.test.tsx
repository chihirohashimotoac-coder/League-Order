import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen } from '@testing-library/react';
import { MatchesApi } from '../api';
import type { AnalyticsOperation, AnalyticsTransport } from '../../analytics/api/readApi';
import { RequestGovernor } from '../governor';
import type { MatchesApiFactory } from '../environment';
import { buildCards } from '../cards';
import { parseFixtures, parseGameRows, parseSeasonDocument } from '../parse';
import { TDID, fixtures, gameRow, list, liveBody, side, tournamentDoc } from '../testFixtures';
import { setMatchReply, setMid } from '../../../test/n01/setMatch';
import { AppStoreProvider } from '../../../state/appStore';
import { screenWake } from '../screenWake';
import type * as LivePollerModule from '../livePoller';
import type { SeasonData } from './useMatchContext';
import { SetMatchPage } from './SetMatchPage';
import { LiveTab } from './LiveTab';
import { ResultsTab } from './ResultsTab';

/**
 * 3 つの観戦ビュー（個別試合・リーグのライブ・日程・結果の進行中の対戦）で、画面のロックが
 * ポーラーの状態に従うことを確かめる。
 * - `retrying`（一時的な取得失敗）では、最後の進行状態に従って保持する。
 * - `budget`（取得上限で停止）では解除し、タブを表示し直しても再取得しない。
 *
 * 20,000 回の通信を待たないよう、`LivePoller` の上限と間隔だけをこのテストで小さくする
 * （ポーラーの処理そのものは本物）。n01 は固定データで、ライブの n01 には接続しない。
 */

const POLL_LIMIT = 4;
const POLL_INTERVAL_MS = 100;

// vi.mock は定数より前に巻き上げられるため、同じ値 (POLL_LIMIT・POLL_INTERVAL_MS) を直接書く。
vi.mock('../livePoller', async (importOriginal) => {
  const actual = await importOriginal<typeof LivePollerModule>();
  class SmallLivePoller extends actual.LivePoller {
    constructor(...[source, target, options]: ConstructorParameters<typeof actual.LivePoller>) {
      super(source, target, { ...options, maxRequests: 4, intervalMs: 100 });
    }
  }
  return { ...actual, LivePoller: SmallLivePoller };
});

// --- 偽の navigator.wakeLock と表示状態 ---------------------------------------------------

const wake = { requests: 0, active: 0 };
let hidden = false;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] });
  wake.requests = 0;
  wake.active = 0;
  hidden = false;
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => (hidden ? 'hidden' : 'visible') });
  Object.defineProperty(navigator, 'wakeLock', {
    configurable: true,
    value: {
      request: () => {
        wake.requests += 1;
        wake.active += 1;
        let released = false;
        return Promise.resolve({
          release: () => {
            if (!released) {
              released = true;
              wake.active -= 1;
            }
            return Promise.resolve();
          },
          addEventListener: () => undefined,
          removeEventListener: () => undefined,
        });
      },
    },
  });
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  // 前のテストの保持者が残っていない (アプリ全体で 1 つの screenWake)。
  expect(screenWake.snapshot.holders).toBe(0);
  Reflect.deleteProperty(navigator, 'wakeLock');
  Reflect.deleteProperty(document, 'visibilityState');
});

const flush = async (ms = 0): Promise<void> => {
  await act(async () => {
    if (ms) await vi.advanceTimersByTimeAsync(ms);
    for (let i = 0; i < 20; i += 1) await Promise.resolve();
  });
};

const setHidden = async (next: boolean): Promise<void> => {
  hidden = next;
  await act(async () => {
    document.dispatchEvent(new Event('visibilitychange'));
    for (let i = 0; i < 20; i += 1) await Promise.resolve();
  });
};

type Handler = (operation: AnalyticsOperation, params: Record<string, string>) => unknown;

function apiOf(handler: Handler, failing: () => boolean) {
  const lives: string[] = [];
  const transport: AnalyticsTransport = {
    request: async (operation, params) => {
      if (operation === 'match/live') {
        lives.push(new URLSearchParams(params).toString());
        if (failing()) throw new Error('n01 に接続できません (テスト)');
      }
      return handler(operation, params);
    },
  };
  const api = new MatchesApi({ transport, governor: new RequestGovernor(100_000), pollPerMinute: 100_000 });
  const factory: MatchesApiFactory = () => api;
  return { api, factory, lives };
}

/**
 * ポーラーの 1 回目は成功、2 回目は失敗 (retrying)、3・4 回目は成功、上限 (4 回) で budget。
 * 対戦は最後まで進行中のまま (終了判定では解除されない)。
 */
async function retryThenBudget(view: { status: () => string }, lives: string[], failing: { on: boolean }): Promise<void> {
  await flush(1); // ポーラーの 1 回目の取得は 0 ms 後に予約される
  await flush();
  expect(lives).toHaveLength(1);
  expect(wake.active).toBe(1);

  failing.on = true;
  await flush(POLL_INTERVAL_MS);
  expect(lives).toHaveLength(2);
  expect(view.status()).toMatch(/取得失敗|取得エラー/);
  expect(wake.active).toBe(1); // retrying: 最後の進行状態で保持

  failing.on = false;
  await flush(POLL_INTERVAL_MS * 2); // 3 回目 (再試行) は成功
  expect(lives).toHaveLength(3);
  expect(view.status()).not.toMatch(/取得失敗|取得エラー/);
  expect(wake.active).toBe(1);
  await flush(POLL_INTERVAL_MS); // 4 回目
  expect(lives).toHaveLength(POLL_LIMIT);
  expect(wake.active).toBe(1);
  await flush(POLL_INTERVAL_MS); // 上限: budget
  expect(lives).toHaveLength(POLL_LIMIT);
  expect(wake.active).toBe(0);

  // タブを隠して表示し直しても、budget のままならロックは取り直さない (ポーリングも止まったまま)。
  const asked = wake.requests;
  await setHidden(true);
  await setHidden(false);
  await flush(POLL_INTERVAL_MS * 10);
  expect(wake.requests).toBe(asked);
  expect(wake.active).toBe(0);
  expect(lives).toHaveLength(POLL_LIMIT);
}

describe('screen wake lock follows the poller: held while retrying, let go at the request cap (budget)', () => {
  it('SetMatchPage (a set-format match in progress)', async () => {
    const failing = { on: false };
    const { factory, lives } = apiOf((operation, params) => setMatchReply(operation, params, 2) ?? { result: -1, error: 'not found' }, () => failing.on);
    render(<SetMatchPage mid={setMid(1)} factory={factory} onBack={() => undefined} onShown={() => undefined} />);
    await flush(); // 先に試合を読み、わかってから対戦を追う
    await flush();
    expect(lives).toHaveLength(0);
    await retryThenBudget({ status: () => screen.getByTestId('set-page-status').textContent ?? '' }, lives, failing);
    // 表示はそのまま: 進行中のセットとスコア。
    expect(screen.getByTestId('shown-set').textContent).toContain('ダブルス1');
    expect(screen.getByTestId('set-legs').textContent).toBe('1 - 1');
  });

  const today = (): unknown[] => [
    gameRow('c003', 'AAAA', 'CCCC', 'tm01', [side('AAAA', [['a1', 'A1'], ['a2', 'A2'], ['a3', 'A3'], ['a4', 'A4']], 1, 1001, 54), side('CCCC', [['c1', 'C1'], ['c2', 'C2'], ['c3', 'C3'], ['c4', 'C4']], 0, 880, 54)], { start: 1_800_000_000, mid: 'c003_tm01' }),
    gameRow('c003', 'AAAA', 'CCCC', 'db01', [side('AAAA', [['a1', 'A1'], ['a2', 'A2']], 1, 400, 30), side('CCCC', [['c1', 'C1'], ['c2', 'C2']], 0, 300, 30)], { start: 1_800_000_900, finished: false, mid: 'c003_db01' }),
  ];
  // c003 (Arrows – Corks) のダブルス1 が進行中。ライブの応答も進行中のまま。
  const league: Handler = (operation) => {
    if (operation === 'match/list') return list(today());
    if (operation === 'match/live') return liveBody({ mid: 'c003_db01', schid: 'db01', title: 'Test League A Division ダブルス1', sets: [1, 0] });
    if (operation === 'match/throws') return { result: 0, changed: 1, mid: 'c003_db01', match_type: '01', end_match: 0, updateTime: 1_800_000_500_000, leg_data: [] };
    if (operation === 'team/order/list' || operation === 'team/player/list') return { result: 0, list: [] };
    if (operation === 'tournament/stats') return { result: 0, stats: {} };
    return { result: -1, error: 'not found' };
  };
  const seasonData = (): SeasonData => {
    const season = parseSeasonDocument(tournamentDoc(), TDID);
    const parsed = parseFixtures(fixtures());
    const games = parseGameRows(list(today())).games;
    return { season, fixtures: parsed, games, cards: buildCards(season, parsed, games), standings: [], standingsError: null, unreadableGames: 0, truncated: false };
  };

  it('LiveTab (a league card followed on the live tab)', async () => {
    const failing = { on: false };
    const { api, factory, lives } = apiOf(league, () => failing.on);
    render(
      <AppStoreProvider>
        <LiveTab data={seasonData()} registered={[]} api={api} factory={factory} />
      </AppStoreProvider>,
    );
    await flush();
    await flush();
    expect(screen.getByTestId('focus-card')).toBeTruthy();
    await retryThenBudget({ status: () => screen.getByTestId('live-status').textContent ?? '' }, lives, failing);
    expect(screen.getByTestId('focus-card').textContent).toContain('Arrows');
  });

  it('ResultsTab (a card in progress opened from 日程・結果)', async () => {
    const failing = { on: false };
    const { api, lives } = apiOf(league, () => failing.on);
    const data = seasonData();
    const card = data.cards.find((entry) => entry.state === 'live');
    expect(card).toBeTruthy();
    render(
      <AppStoreProvider>
        <ResultsTab data={data} registered={[]} api={api} onTeam={() => undefined} link={{ season: TDID, card: card!.key }} base={{ season: TDID }} />
      </AppStoreProvider>,
    );
    // ライブの状態はゲームの状態行に表示される。ポーラーの状態はそこから読む。
    await retryThenBudget({ status: () => screen.getByTestId('match-detail').textContent ?? '' }, lives, failing);
    expect(screen.getByTestId('match-detail').textContent).toContain('Corks');
  });
});
