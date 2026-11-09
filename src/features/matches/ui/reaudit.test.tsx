import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { MatchesApi } from '../api';
import type { AnalyticsOperation, AnalyticsTransport } from '../../analytics/api/readApi';
import { RequestGovernor } from '../governor';
import { parseLive } from '../parse';
import type { LiveState } from '../parse';
import { liveBody } from '../testFixtures';
import { LiveSheet } from './LiveSheet';
import { GameView } from './GameView';
import { SYNC_RETRY_MS } from './useGameLegs';

/**
 * Re-audit of 2026-11-09, R02: the legs of a live game held against what the game has ended.
 * A read that succeeded is not a complete game: a reply asked for before a leg ended does not
 * carry that leg's end, and a failed catch-up must stay retryable after the automatic reads.
 */

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

type Reply = unknown | Promise<unknown> | Error;

function apiOf(handler: (params: Record<string, string>) => Reply) {
  const calls: Record<string, string>[] = [];
  const transport: AnalyticsTransport = {
    request: async (operation: AnalyticsOperation, params) => {
      if (operation !== 'match/throws') throw new Error(`unexpected ${operation}`);
      calls.push(params);
      const reply = await handler(params);
      if (reply instanceof Error) throw reply;
      return reply;
    },
  };
  return { api: new MatchesApi({ transport, governor: new RequestGovernor(100_000), pollPerMinute: 100_000 }), calls };
}

const flush = async (): Promise<void> => {
  await act(async () => {
    for (let i = 0; i < 12; i += 1) await Promise.resolve();
  });
};

/** A leg of 501 the left side wins in 9 darts with 180, 180, 141 (time = its last update). */
const endedLeg = (leg: number, time: number) => ({
  leg,
  first: 0,
  end: 1,
  winner: 0,
  time,
  darts: [9, 6],
  throws: [
    { p: 0, r: 1, score: 180, left: 321, darts: 3 },
    { p: 1, r: 1, score: 26, left: 475, darts: 3 },
    { p: 0, r: 2, score: 180, left: 141, darts: 3 },
    { p: 1, r: 2, score: 26, left: 449, darts: 3 },
    { p: 0, r: 3, score: 141, left: 0, darts: 3, finish: 1 },
  ],
});

/** The same leg while still in progress (two visits in). */
const openLeg = (leg: number, time: number) => ({
  leg,
  first: 0,
  end: 0,
  winner: null,
  time,
  thrower: 0,
  throws: [
    { p: 0, r: 1, score: 180, left: 321, darts: 3 },
    { p: 1, r: 1, score: 26, left: 475, darts: 3 },
  ],
});

const throwsReply = (mid: string, updateTime: number, currentLeg: number, legs: unknown[]) => ({ result: 0, changed: 1, mid, updateTime, current_leg: currentLeg, legs: [0, 0], leg_data: legs });

function liveAt(mid: string, legIndex: number, won: [number, number], extra: Record<string, unknown> = {}): LiveState {
  const state = parseLive(
    liveBody({
      mid,
      current_leg: legIndex,
      legs: won,
      format: { limit_leg: 3, limit_set: 1, draw_mode: 0, schedule: 0, start_score: 501 },
      show_sets: 0,
      leg: { leg: legIndex, first: legIndex % 2, end: 0, winner: null, start: [501, 501], left: [401, 501], thrower: 1, round: 1, throws: [{ p: 0, r: 1, score: 100, left: 401, darts: 3 }] },
      ...extra,
    }),
  );
  if (!state.changed) throw new Error('unchanged');
  return state;
}

const stats = (): string => screen.queryByLabelText('このゲームのスタッツ')?.textContent ?? '';
/** The two cells of one row of the live sheet's figures (`[left, right]`). */
const statRow = (label: string): [string, string] => {
  const row = [...(screen.getByLabelText('このゲームのスタッツ').querySelectorAll('tr') as NodeListOf<HTMLTableRowElement>)].find((tr) => tr.querySelector('th')?.textContent === label)!;
  const cells = row.querySelectorAll('td');
  return [cells[0].textContent ?? '', cells[1].textContent ?? ''];
};

describe('R02-A: a first read answered from before a leg ended', () => {
  it('the live leg moves on while the first read is out: the ended leg is read again, nothing is shown from the gap', async () => {
    let releaseFirst: (value: unknown) => void = () => undefined;
    let releaseSince: (value: unknown) => void = () => undefined;
    const { api, calls } = apiOf((params) => {
      if (!params.since) return new Promise((resolve) => (releaseFirst = resolve));
      return new Promise((resolve) => (releaseSince = resolve));
    });
    const view = render(<LiveSheet api={api} live={liveAt('gameA', 0, [0, 0])} />);
    await flush();
    // Leg 0 ends and leg 1 starts on the board before the first reply comes back…
    view.rerender(<LiveSheet api={api} live={liveAt('gameA', 1, [1, 0])} />);
    await flush();
    // …which n01 answered from leg 0 still in progress.
    releaseFirst(throwsReply('gameA', 10, 0, [openLeg(0, 10)]));
    await flush();

    expect(calls).toHaveLength(2);
    expect(calls[1].since).toBe('10');
    expect(stats()).toBe('');
    expect(screen.queryByTestId('leg-chance')).toBeNull();
    expect(screen.getByTestId('legs-status').textContent).toContain('L1');
    // The points left of the live leg stay on screen.
    expect(screen.getByLabelText('残り点数').textContent).toContain('401');

    releaseSince(throwsReply('gameA', 30, 1, [endedLeg(0, 20)]));
    await flush();
    expect(screen.queryByTestId('legs-status')).toBeNull();
    expect(stats()).toContain('141'); // the high finish of leg 0
    expect(view.container.textContent).toContain('L1:');
    expect(screen.getByTestId('leg-chance')).toBeTruthy();
    expect(calls).toHaveLength(2);
  });

  it('a since read that brings nothing new is followed by a whole read, not taken as complete', async () => {
    vi.useFakeTimers();
    let server: unknown = throwsReply('gameA', 10, 0, [openLeg(0, 10)]);
    const { api, calls } = apiOf((params) => (params.since ? { result: 0, changed: 0, mid: 'gameA', updateTime: 10 } : server));
    const view = render(<LiveSheet api={api} live={liveAt('gameA', 0, [0, 0])} />);
    await flush();
    view.rerender(<LiveSheet api={api} live={liveAt('gameA', 1, [1, 0])} />);
    await flush();
    expect(calls.map((call) => call.since ?? null)).toEqual([null, '10']);
    expect(stats()).toBe('');
    expect(screen.getByTestId('legs-status').dataset.sync).toBe('waiting');
    server = throwsReply('gameA', 40, 1, [endedLeg(0, 20), openLeg(1, 40)]);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(SYNC_RETRY_MS[0]);
    });
    await flush();
    expect(calls.map((call) => call.since ?? null)).toEqual([null, '10', null]);
    expect(stats()).toContain('141');
  });
});

describe('R02-B: the catch-up read fails past its automatic retries', () => {
  async function failedThrough() {
    vi.useFakeTimers();
    let online = false;
    const { api, calls } = apiOf((params) => {
      if (!params.since && calls.length === 1) return throwsReply('gameA', 10, 0, [openLeg(0, 10)]);
      if (!online) return new Error('network down');
      return throwsReply('gameA', 40, 1, [endedLeg(0, 20), openLeg(1, 40)]);
    });
    const view = render(<LiveSheet api={api} live={liveAt('gameA', 0, [0, 0])} />);
    await flush();
    view.rerender(<LiveSheet api={api} live={liveAt('gameA', 1, [1, 0])} />);
    await flush();
    for (const wait of SYNC_RETRY_MS) {
      await act(async () => {
        await vi.advanceTimersByTimeAsync(wait);
      });
      await flush();
    }
    return { calls, view, restore: () => (online = true) };
  }

  it('stops after 1 + 5 reads, says so, offers a retry and shows no estimate', async () => {
    const { calls } = await failedThrough();
    expect(calls).toHaveLength(7); // first read + catch-up + 5 automatic retries
    expect(vi.getTimerCount()).toBe(0); // nothing scheduled: no loop
    const status = screen.getByTestId('legs-status');
    expect(status.dataset.sync).toBe('stopped');
    expect(status.textContent).toContain('取得できていません');
    expect(status.textContent).not.toContain('再取得しています');
    expect(screen.getByRole('button', { name: '再取得' })).toBeTruthy();
    expect(screen.queryByTestId('leg-chance')).toBeNull();
    expect(stats()).toBe('');
    // Ten more minutes on the same leg: still no read on its own.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10 * 60_000);
    });
    expect(calls).toHaveLength(7);
  });

  it('back online: the ended leg is read and the figures come back', async () => {
    const { calls, restore } = await failedThrough();
    restore();
    await act(async () => {
      window.dispatchEvent(new Event('online'));
    });
    await flush();
    expect(calls).toHaveLength(8);
    expect(calls[7].since).toBeUndefined(); // a whole read after failures
    expect(screen.queryByTestId('legs-status')).toBeNull();
    expect(stats()).toContain('141');
    expect(screen.getByTestId('leg-chance')).toBeTruthy();
  });

  it('the page shown again reads at once; the retry button does too', async () => {
    const { calls, restore } = await failedThrough();
    restore();
    const visibility = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible');
    await act(async () => {
      document.dispatchEvent(new Event('visibilitychange'));
    });
    await flush();
    expect(calls).toHaveLength(8);
    expect(stats()).toContain('141');
    visibility.mockRestore();
  });

  it('the retry button reads at once', async () => {
    const { calls, restore } = await failedThrough();
    restore();
    fireEvent.click(screen.getByRole('button', { name: '再取得' }));
    await flush();
    expect(calls).toHaveLength(8);
    expect(stats()).toContain('141');
  });

  it('while hidden, a retry that falls due waits for the page to be shown', async () => {
    vi.useFakeTimers();
    let fail = true;
    const { api, calls } = apiOf((params) => {
      if (!params.since && calls.length === 1) return throwsReply('gameA', 10, 0, [openLeg(0, 10)]);
      return fail ? new Error('down') : throwsReply('gameA', 40, 1, [endedLeg(0, 20), openLeg(1, 40)]);
    });
    const view = render(<LiveSheet api={api} live={liveAt('gameA', 0, [0, 0])} />);
    await flush();
    view.rerender(<LiveSheet api={api} live={liveAt('gameA', 1, [1, 0])} />);
    await flush();
    expect(calls).toHaveLength(2);
    const visibility = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden');
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10 * 60_000);
    });
    expect(calls).toHaveLength(2);
    fail = false;
    visibility.mockReturnValue('visible');
    await act(async () => {
      document.dispatchEvent(new Event('visibilitychange'));
    });
    await flush();
    expect(calls).toHaveLength(3);
    expect(stats()).toContain('141');
    visibility.mockRestore();
  });
});

describe('R02: the game boundary holds while legs are caught up', () => {
  it('a catch-up reply for game A arriving after game B opened at the same leg index is dropped', async () => {
    const pendingA: ((value: unknown) => void)[] = [];
    const { api } = apiOf((params) => {
      if (params.mid === 'gameA') {
        if (!params.since) return throwsReply('gameA', 10, 0, [openLeg(0, 10)]);
        return new Promise((resolve) => pendingA.push(resolve));
      }
      return throwsReply('gameB', 50, 1, [{ ...endedLeg(0, 45), throws: [{ p: 0, r: 1, score: 60, left: 441, darts: 3 }, { p: 1, r: 1, score: 501, left: 0, darts: 3, finish: 1 }], winner: 1 }]);
    });
    const view = render(<LiveSheet api={api} live={liveAt('gameA', 0, [0, 0])} />);
    await flush();
    view.rerender(<LiveSheet api={api} live={liveAt('gameA', 1, [1, 0])} />);
    await flush();
    view.rerender(<LiveSheet api={api} live={liveAt('gameB', 1, [0, 1])} />);
    await flush();
    pendingA.forEach((release) => release(throwsReply('gameA', 30, 1, [endedLeg(0, 20)])));
    await flush();
    expect(statRow("180's")).toEqual(['0', '0']);
    expect(statRow('High Finish')).not.toContain('141');
  });

  it('the deciding leg ended: the held legs and the final live leg make the whole game', async () => {
    const { api, calls } = apiOf(() => throwsReply('gameA', 60, 2, [endedLeg(0, 20), endedLeg(1, 40)]));
    const last = liveAt('gameA', 2, [3, 0], {
      end_match: 1,
      leg: { ...endedLeg(2, 60), start: [501, 501], left: [0, 449] },
    });
    render(<LiveSheet api={api} live={last} />);
    await flush();
    expect(screen.queryByTestId('legs-status')).toBeNull();
    expect(screen.getAllByText(/L3:/).length).toBe(1);
    expect(calls).toHaveLength(1);
  });

  it('the game view (a live game opened from the list) waits for the ended legs too', async () => {
    let releaseSince: (value: unknown) => void = () => undefined;
    const { api } = apiOf((params) => (params.since ? new Promise((resolve) => (releaseSince = resolve)) : throwsReply('gameA', 10, 0, [openLeg(0, 10)])));
    const legOf = (index: number) => liveAt('gameA', index, [index, 0]).leg;
    const view = render(<GameView api={api} mid="gameA" cricket={false} finished={false} names={['A', 'B']} flip={false} liveLeg={legOf(0)} />);
    await flush();
    expect(screen.getByLabelText('ゲームの詳細')).toBeTruthy();
    view.rerender(<GameView api={api} mid="gameA" cricket={false} finished={false} names={['A', 'B']} flip={false} liveLeg={legOf(1)} />);
    await flush();
    expect(screen.queryByLabelText('ゲームの詳細')).toBeNull();
    expect(screen.getByTestId('legs-status').textContent).toContain('L1');
    releaseSince(throwsReply('gameA', 30, 1, [endedLeg(0, 20)]));
    await flush();
    expect(screen.getByLabelText('ゲームの詳細').textContent).toContain('141');
  });
});
