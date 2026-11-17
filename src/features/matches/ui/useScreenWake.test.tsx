import { StrictMode } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render } from '@testing-library/react';
import { createScreenWake } from '../screenWake';
import type { WakeSentinel } from '../screenWake';
import { WatchShown, useScreenWake } from './useScreenWake';

/**
 * ライブ観戦のビューが使うフック: 進行中で表示されている間だけ保持する。React Strict Mode
 * (effect が 2 回実行される)、2 つのビューの同時表示、試合ページの下に隠して保持する一覧で確かめる。
 */

function fakeWake() {
  let requests = 0;
  const sentinels: { released: boolean }[] = [];
  const listeners = new Set<() => void>();
  const wake = createScreenWake({
    wakeLock: () => ({
      request: () => {
        requests += 1;
        const sentinel = { released: false };
        sentinels.push(sentinel);
        const object: WakeSentinel = {
          release: () => {
            sentinel.released = true;
            return Promise.resolve();
          },
          addEventListener: () => undefined,
          removeEventListener: () => undefined,
        };
        return Promise.resolve(object);
      },
    }),
    visible: () => true,
    onVisibility: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  });
  return { wake, sentinels, listeners, requests: () => requests };
}

const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

function View({ live, wake }: { live: boolean; wake: ReturnType<typeof createScreenWake> }): React.JSX.Element {
  useScreenWake(live, wake);
  return <p>view</p>;
}

afterEach(cleanup);

describe('useScreenWake', () => {
  it('Strict Mode: one request, one holder, and nothing left once the view is gone', async () => {
    const { wake, sentinels, listeners, requests } = fakeWake();
    const { unmount } = render(
      <StrictMode>
        <View live wake={wake} />
      </StrictMode>,
    );
    await settle();
    expect(requests()).toBe(1);
    expect(wake.snapshot).toEqual({ holders: 1, held: true, pending: false });
    unmount();
    expect(wake.snapshot.holders).toBe(0);
    expect(sentinels.every((sentinel) => sentinel.released)).toBe(true);
    expect(listeners.size).toBe(0);
  });

  it('the match ends: the lock is let go; a view of a match that is over takes none', async () => {
    const { wake, sentinels, requests } = fakeWake();
    const { rerender } = render(<View live wake={wake} />);
    await settle();
    expect(wake.snapshot.held).toBe(true);
    rerender(<View live={false} wake={wake} />);
    expect(wake.snapshot.holders).toBe(0);
    expect(sentinels[0].released).toBe(true);
    cleanup();
    render(<View live={false} wake={wake} />);
    await settle();
    expect(requests()).toBe(1);
  });

  it('two cards side by side: one lock, held until both are gone', async () => {
    const { wake, sentinels, requests } = fakeWake();
    const { rerender } = render(
      <>
        <View live wake={wake} />
        <View live wake={wake} />
      </>,
    );
    await settle();
    expect(requests()).toBe(1);
    expect(wake.snapshot.holders).toBe(2);
    rerender(
      <>
        <View live wake={wake} />
        <View live={false} wake={wake} />
      </>,
    );
    expect(sentinels[0].released).toBe(false);
    rerender(<></>);
    expect(sentinels[0].released).toBe(true);
  });

  it('a live view kept hidden under a match page holds nothing; shown again, it holds the lock again', async () => {
    const { wake, sentinels, requests } = fakeWake();
    const tree = (shown: boolean): React.JSX.Element => (
      <WatchShown shown={shown}>
        <WatchShown shown>
          <View live wake={wake} />
        </WatchShown>
      </WatchShown>
    );
    const { rerender } = render(tree(true));
    await settle();
    expect(wake.snapshot.held).toBe(true);
    rerender(tree(false));
    expect(wake.snapshot.holders).toBe(0);
    expect(sentinels[0].released).toBe(true);
    rerender(tree(true));
    await settle();
    expect(requests()).toBe(2);
    expect(wake.snapshot.held).toBe(true);
  });
});
