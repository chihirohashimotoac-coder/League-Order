import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MatchesApi } from '../api';
import type { CardOrder } from '../parse';
import { ORDER_POLL_MS, useCardOrders, useCardStart } from './useCardOrders';
import { N01Error } from '../../../integrations/n01/client';

const row = (tmid: string, name: string): CardOrder => ({ tmid, teamId: 'AAAA', schid: 's1', fixed: true, fix: 1, members: [name], entries: [{ oid: 'o', opid: null, name }] });

interface Deferred {
  tmid: string;
  resolve: (rows: CardOrder[]) => void;
  reject: (error: unknown) => void;
  signal?: AbortSignal;
}

function fakeApi(): { api: MatchesApi; calls: Deferred[] } {
  const calls: Deferred[] = [];
  const api = {
    cardOrders: (_tdid: string, tmid: string, signal?: AbortSignal) =>
      new Promise<CardOrder[]>((resolve, reject) => {
        calls.push({ tmid, resolve, reject, signal });
      }),
  } as unknown as MatchesApi;
  return { api, calls };
}

let hidden = false;
beforeEach(() => {
  vi.useFakeTimers();
  hidden = false;
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => (hidden ? 'hidden' : 'visible') });
});
afterEach(() => {
  vi.useRealTimers();
});

const flush = async (): Promise<void> => {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
};

describe('useCardOrders', () => {
  it('reads at once, then every 30 s; one read at a time', async () => {
    const { api, calls } = fakeApi();
    const { result } = renderHook(() => useCardOrders(api, 't', 'T1', { poll: true }));
    expect(calls).toHaveLength(1);
    expect(result.current.loading).toBe(true);
    await act(async () => calls[0].resolve([row('T1', 'A')]));
    await flush();
    expect(result.current.rows?.[0].members).toEqual(['A']);
    // A manual refresh while nothing is on reads now; a second one while it is on does not.
    act(() => result.current.refresh());
    act(() => result.current.refresh());
    expect(calls).toHaveLength(2);
    await act(async () => calls[1].resolve([row('T1', 'B')]));
    await flush();
    await act(async () => {
      vi.advanceTimersByTime(ORDER_POLL_MS - 1);
    });
    expect(calls).toHaveLength(2);
    await act(async () => {
      vi.advanceTimersByTime(1);
    });
    expect(calls).toHaveLength(3);
  });

  it('a failure keeps the last good orders and says so; the next tries wait 30, 60, 120 s', async () => {
    const { api, calls } = fakeApi();
    const { result } = renderHook(() => useCardOrders(api, 't', 'T1', { poll: true }));
    await act(async () => calls[0].resolve([row('T1', 'A')]));
    await flush();
    await act(async () => {
      vi.advanceTimersByTime(ORDER_POLL_MS);
    });
    await act(async () => calls[1].reject(new N01Error('network', 'down')));
    await flush();
    expect(result.current.rows?.[0].members).toEqual(['A']);
    expect(result.current.error).toBeTruthy();
    expect(result.current.failedAt).not.toBeNull();
    await act(async () => {
      vi.advanceTimersByTime(ORDER_POLL_MS);
    });
    expect(calls).toHaveLength(3);
    await act(async () => calls[2].reject(new N01Error('network', 'down')));
    await flush();
    await act(async () => {
      vi.advanceTimersByTime(ORDER_POLL_MS * 2 - 1);
    });
    expect(calls).toHaveLength(3);
    await act(async () => {
      vi.advanceTimersByTime(1);
    });
    expect(calls).toHaveLength(4);
    await act(async () => calls[3].reject(new N01Error('network', 'down')));
    await flush();
    await act(async () => {
      vi.advanceTimersByTime(ORDER_POLL_MS * 4 - 1);
    });
    expect(calls).toHaveLength(4);
    await act(async () => {
      vi.advanceTimersByTime(1);
    });
    expect(calls).toHaveLength(5);
    // Back: the error goes, the new orders show.
    await act(async () => calls[4].resolve([row('T1', 'C')]));
    await flush();
    expect(result.current.error).toBeNull();
    expect(result.current.rows?.[0].members).toEqual(['C']);
  });

  it('a late reply of the previous card never shows on the new one', async () => {
    const { api, calls } = fakeApi();
    const { result, rerender } = renderHook(({ tmid }) => useCardOrders(api, 't', tmid, { poll: true }), { initialProps: { tmid: 'T1' } });
    rerender({ tmid: 'T2' });
    expect(calls.map((call) => call.tmid)).toEqual(['T1', 'T2']);
    expect(calls[0].signal?.aborted).toBe(true);
    await act(async () => calls[0].resolve([row('T1', 'old')]));
    await flush();
    expect(result.current.tmid).toBe('T2');
    expect(result.current.rows).toBeNull();
    await act(async () => calls[1].resolve([row('T2', 'new')]));
    await flush();
    expect(result.current.rows?.[0].members).toEqual(['new']);
  });

  it('no polling without `poll` (a later round), when hidden, nor after unmount; back to visible reads when due', async () => {
    const { api, calls } = fakeApi();
    const once = renderHook(() => useCardOrders(api, 't', 'T9', { poll: false }));
    await act(async () => calls[0].resolve([]));
    await flush();
    await act(async () => {
      vi.advanceTimersByTime(ORDER_POLL_MS * 5);
    });
    expect(calls).toHaveLength(1);
    once.unmount();

    const polled = renderHook(() => useCardOrders(api, 't', 'T1', { poll: true }));
    await act(async () => calls[1].resolve([]));
    await flush();
    hidden = true;
    act(() => {
      document.dispatchEvent(new Event('visibilitychange'));
    });
    await act(async () => {
      vi.advanceTimersByTime(ORDER_POLL_MS * 4);
    });
    expect(calls).toHaveLength(2);
    hidden = false;
    act(() => {
      document.dispatchEvent(new Event('visibilitychange'));
    });
    expect(calls).toHaveLength(3);
    await act(async () => calls[2].resolve([]));
    await flush();
    polled.unmount();
    await act(async () => {
      vi.advanceTimersByTime(ORDER_POLL_MS * 4);
    });
    expect(calls).toHaveLength(3);
  });

  it('opened while hidden: no read until shown, polled or not', async () => {
    const { api, calls } = fakeApi();
    hidden = true;
    renderHook(() => useCardOrders(api, 't', 'T9', { poll: false }));
    expect(calls).toHaveLength(0);
    hidden = false;
    act(() => {
      document.dispatchEvent(new Event('visibilitychange'));
    });
    expect(calls).toHaveLength(1);
  });

  it('no card, no read', () => {
    const { api, calls } = fakeApi();
    const { result } = renderHook(() => useCardOrders(api, 't', null, { poll: true }));
    expect(calls).toHaveLength(0);
    expect(result.current.loading).toBe(false);
  });
});

describe('useCardStart', () => {
  it('asks match/live every 30 s; "not found" is not yet; a game of the card is the start, then it stops', async () => {
    const replies: (() => Promise<unknown>)[] = [];
    let count = 0;
    const api = {
      live: () => {
        count += 1;
        return replies.shift()?.() ?? Promise.reject(new N01Error('notFound', 'not found'));
      },
    } as unknown as MatchesApi;
    const { result } = renderHook(() => useCardStart(api, 'T1', true));
    await flush();
    expect(count).toBe(1);
    expect(result.current).toBe(false);
    replies.push(() => Promise.resolve({ mid: 'm', tmid: 'OTHER', schid: 's1' }));
    await act(async () => {
      vi.advanceTimersByTime(ORDER_POLL_MS);
    });
    await flush();
    expect(count).toBe(2);
    expect(result.current).toBe(false);
    replies.push(() => Promise.resolve({ mid: 'm', tmid: 'T1', schid: 's1' }));
    await act(async () => {
      vi.advanceTimersByTime(ORDER_POLL_MS);
    });
    await flush();
    expect(result.current).toBe(true);
    await act(async () => {
      vi.advanceTimersByTime(ORDER_POLL_MS * 4);
    });
    expect(count).toBe(3);
  });

  it('opened while hidden: the first check waits for the page to be shown', () => {
    let count = 0;
    const api = { live: () => ((count += 1), Promise.reject(new N01Error('notFound', 'x'))) } as unknown as MatchesApi;
    hidden = true;
    renderHook(() => useCardStart(api, 'T1', true));
    expect(count).toBe(0);
    hidden = false;
    act(() => {
      document.dispatchEvent(new Event('visibilitychange'));
    });
    expect(count).toBe(1);
  });

  it('not enabled: no read', () => {
    let count = 0;
    const api = { live: () => (count += 1, Promise.resolve({})) } as unknown as MatchesApi;
    renderHook(() => useCardStart(api, 'T1', false));
    expect(count).toBe(0);
  });
});
