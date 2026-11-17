import { afterEach, describe, expect, it } from 'vitest';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { MatchesApi } from '../api';
import type { AnalyticsTransport } from '../../analytics/api/readApi';
import { RequestGovernor } from '../governor';
import { GameView } from './GameView';

/**
 * 終了したゲームの Leg チップの状態表記と、推移チャートの見出し・位置 (終了したゲームは統計・
 * 上がり圏の後、進行中のゲームはスコア表の直後)。
 * n01 の記録 (`match/throws`) はここで作った架空のもの。
 */

afterEach(cleanup);

const apiOf = (reply: unknown): MatchesApi => {
  const transport: AnalyticsTransport = { request: async () => reply };
  return new MatchesApi({ transport, governor: new RequestGovernor(100_000), pollPerMinute: 100_000 });
};

const flush = async (): Promise<void> => {
  await act(async () => {
    for (let i = 0; i < 12; i += 1) await Promise.resolve();
  });
};

// 左が 9 本で上がる 501 の Leg。winner を差し替えて引き分け・勝者不明を作る。
const leg = (index: number, winner: number | null, end = 1) => ({
  leg: index,
  first: 0,
  end,
  winner,
  time: 10 + index,
  darts: [9, 6],
  throws: [
    { p: 0, r: 1, score: 180, left: 321, darts: 3 },
    { p: 1, r: 1, score: 26, left: 475, darts: 3 },
    { p: 0, r: 2, score: 180, left: 141, darts: 3 },
    { p: 1, r: 2, score: 26, left: 449, darts: 3 },
    { p: 0, r: 3, score: 141, left: 0, darts: 3, finish: 1 },
  ],
});
// n01 が終了後に残す、投擲のない Leg。
const unstarted = (index: number) => ({ leg: index, first: 0, end: 0, winner: null, time: 20, throws: [] });

const reply = (legs: unknown[]) => ({ result: 0, changed: 1, mid: 'g1', updateTime: 30, current_leg: legs.length - 1, legs: [1, 0], leg_data: legs });

describe('GameView (終了したゲーム)', () => {
  it('Leg チップ: 勝者・引き分け・勝者不明・未実施を区別し、最後にプレイされた Leg を開く', async () => {
    render(<GameView api={apiOf(reply([leg(0, 0), leg(1, -1), leg(2, null), unstarted(3)]))} mid="g1" cricket={false} finished names={['青木 一郎', '加藤 二郎']} flip={false} openPlayedLeg />);
    await flush();
    const chips = within(screen.getByTestId('leg-chips')).getAllByRole('tab');
    expect(chips.map((chip) => chip.textContent)).toEqual(['Leg 1青木 9本', 'Leg 2引き分け', 'Leg 3勝者不明', 'Leg 4未実施']);
    expect(chips[2].getAttribute('aria-selected')).toBe('true');
  });

  it('推移チャートは1つだけ、統計と上がり圏の後に置く (スマホの表示順・読み上げ順)', async () => {
    const { container } = render(<GameView api={apiOf(reply([leg(0, 0)]))} mid="g1" cricket={false} finished names={['A', 'B']} flip={false} openPlayedLeg />);
    await flush();
    const order = [...container.querySelectorAll('[data-testid="leg-chips"], [data-testid="leg-sheet"], table.gv-compare, [data-testid="finish-chances"], [data-testid="race-chart"]')].map(
      (el) => el.getAttribute('data-testid') ?? 'stats',
    );
    expect(order).toEqual(['leg-chips', 'leg-sheet', 'stats', 'finish-chances', 'race-chart']);
    expect(screen.getAllByTestId('race-chart')).toHaveLength(1);
  });

  it('未実施の Leg を選ぶと見出しもチャートも描かず、投擲のある Leg に戻ると1つずつ描く', async () => {
    const { container } = render(<GameView api={apiOf(reply([leg(0, 0), unstarted(1)]))} mid="g1" cricket={false} finished names={['A', 'B']} flip={false} openPlayedLeg />);
    await flush();
    const heading = () => [...container.querySelectorAll('h4')].filter((h) => h.textContent?.includes('残り点の推移'));
    expect(heading()).toHaveLength(1);
    expect(screen.getAllByTestId('race-chart')).toHaveLength(1);
    const chips = within(screen.getByTestId('leg-chips')).getAllByRole('tab');
    fireEvent.click(chips[1]); // Leg 2: 未実施
    expect(chips[1].textContent).toBe('Leg 2未実施');
    expect(heading()).toHaveLength(0);
    expect(screen.queryByTestId('race-chart')).toBeNull();
    expect(container.querySelector('.gv-chart')).toBeNull();
    fireEvent.click(chips[0]);
    expect(heading().map((h) => h.textContent)).toEqual(['Leg 1 の残り点の推移']);
    expect(screen.getAllByTestId('race-chart')).toHaveLength(1);
  });
});

describe('GameView (進行中のゲーム)', () => {
  it('推移チャートはスコア表の直後 (統計より前) に1つだけ置く', async () => {
    const { container } = render(<GameView api={apiOf(reply([leg(0, 0), leg(1, 0)]))} mid="g1" cricket={false} finished={false} names={['A', 'B']} flip={false} />);
    await flush();
    const order = [...container.querySelectorAll('[data-testid="leg-chips"], [data-testid="leg-sheet"], [data-testid="race-chart"], table.gv-compare, [data-testid="finish-chances"]')].map(
      (el) => el.getAttribute('data-testid') ?? 'stats',
    );
    expect(order).toEqual(['leg-chips', 'leg-sheet', 'race-chart', 'stats', 'finish-chances']);
    expect(screen.getAllByTestId('race-chart')).toHaveLength(1);
    expect(container.querySelector('.gv-chart')).toBeNull();
  });
});
