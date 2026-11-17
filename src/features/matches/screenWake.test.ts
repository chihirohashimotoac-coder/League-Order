import { describe, expect, it } from 'vitest';
import { browserWakeEnvironment, createScreenWake } from './screenWake';
import type { WakeEnvironment, WakeSentinel } from './screenWake';

/**
 * 画面の自動スリープ防止 (screenWake.ts) を、偽の `navigator.wakeLock` と表示状態で確かめる。
 * 要求の応答は手で解決・拒否する (要求の途中で隠れる・離れる場合を作るため)。
 */

class FakeSentinel implements WakeSentinel {
  released = false;
  private listeners = new Set<() => void>();
  release(): Promise<void> {
    this.released = true;
    return Promise.resolve();
  }
  addEventListener(_type: 'release', listener: () => void): void {
    this.listeners.add(listener);
  }
  removeEventListener(_type: 'release', listener: () => void): void {
    this.listeners.delete(listener);
  }
  /** OS (ブラウザ) が解除した。 */
  osRelease(): void {
    this.released = true;
    for (const listener of [...this.listeners]) listener();
  }
  get listening(): number {
    return this.listeners.size;
  }
}

interface Asked {
  resolve: () => FakeSentinel;
  reject: (error?: unknown) => void;
}

function world(options: { supported?: boolean; throws?: boolean } = {}) {
  const asked: Asked[] = [];
  const sentinels: FakeSentinel[] = [];
  const visibility = new Set<() => void>();
  let visible = true;
  const environment: WakeEnvironment = {
    wakeLock: () =>
      options.supported === false
        ? undefined
        : {
            request: (type) => {
              expect(type).toBe('screen');
              if (options.throws) throw new TypeError('not allowed here');
              return new Promise<WakeSentinel>((resolve, reject) => {
                asked.push({
                  resolve: () => {
                    const sentinel = new FakeSentinel();
                    sentinels.push(sentinel);
                    resolve(sentinel);
                    return sentinel;
                  },
                  reject: (error = new DOMException('denied', 'NotAllowedError')) => reject(error),
                });
              });
            },
          },
    visible: () => visible,
    onVisibility: (listener) => {
      visibility.add(listener);
      return () => visibility.delete(listener);
    },
  };
  const setVisible = (next: boolean): void => {
    visible = next;
    for (const listener of [...visibility]) listener();
  };
  return { asked, sentinels, visibility, setVisible, wake: createScreenWake(environment) };
}

/** 解決・拒否の後の `then` を流す。 */
const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

describe('screenWake', () => {
  it('holds one lock while a live view is shown, and lets go when the view leaves', async () => {
    const { asked, sentinels, visibility, wake } = world();
    const leave = wake.acquire();
    expect(asked).toHaveLength(1);
    expect(wake.snapshot.pending).toBe(true);
    asked[0].resolve();
    await settle();
    expect(wake.snapshot).toEqual({ holders: 1, held: true, pending: false });
    expect(visibility.size).toBe(1);

    leave();
    expect(sentinels[0].released).toBe(true);
    expect(sentinels[0].listening).toBe(0);
    expect(wake.snapshot).toEqual({ holders: 0, held: false, pending: false });
    expect(visibility.size).toBe(0); // リスナーが残らない
    leave(); // 2 回目: 何もしない
    expect(wake.snapshot.holders).toBe(0);
  });

  it('lets go when the tab is hidden and asks again when it is shown', async () => {
    const { asked, sentinels, setVisible, wake } = world();
    const leave = wake.acquire();
    asked[0].resolve();
    await settle();

    setVisible(false);
    expect(sentinels[0].released).toBe(true);
    expect(wake.snapshot.held).toBe(false);
    expect(asked).toHaveLength(1); // 非表示の間は要求しない

    setVisible(true);
    expect(asked).toHaveLength(2);
    asked[1].resolve();
    await settle();
    expect(wake.snapshot.held).toBe(true);
    leave();
    expect(sentinels[1].released).toBe(true);
  });

  it('one request for several views shown at once (two cards side by side), held until the last leaves', async () => {
    const { asked, sentinels, visibility, wake } = world();
    const left = wake.acquire();
    const right = wake.acquire();
    expect(asked).toHaveLength(1);
    asked[0].resolve();
    await settle();
    const third = wake.acquire();
    expect(asked).toHaveLength(1);
    expect(visibility.size).toBe(1);
    left();
    third();
    expect(sentinels[0].released).toBe(false);
    right();
    expect(sentinels[0].released).toBe(true);
    expect(visibility.size).toBe(0);
  });

  it('a view left and taken again while the request is on (React Strict Mode) asks once and keeps the lock', async () => {
    const { asked, sentinels, wake } = world();
    wake.acquire()();
    const leave = wake.acquire();
    expect(asked).toHaveLength(1);
    asked[0].resolve();
    await settle();
    expect(wake.snapshot.held).toBe(true);
    expect(sentinels[0].released).toBe(false);
    leave();
    expect(sentinels[0].released).toBe(true);
  });

  it('a lock that arrives after the view was left is let go at once', async () => {
    const { asked, sentinels, wake } = world();
    const leave = wake.acquire();
    leave();
    asked[0].resolve();
    await settle();
    expect(sentinels[0].released).toBe(true);
    expect(sentinels[0].listening).toBe(0);
    expect(wake.snapshot).toEqual({ holders: 0, held: false, pending: false });
  });

  it('a lock that arrives after the tab was hidden is let go; shown again, it is asked for anew', async () => {
    const { asked, sentinels, setVisible, wake } = world();
    const leave = wake.acquire();
    setVisible(false);
    asked[0].resolve();
    await settle();
    expect(sentinels[0].released).toBe(true);
    expect(wake.snapshot.held).toBe(false);
    setVisible(true);
    expect(asked).toHaveLength(2);
    asked[1].resolve();
    await settle();
    expect(wake.snapshot.held).toBe(true);
    leave();
  });

  it('hidden and shown again while the request is on: the lock that arrives is kept, nothing asked twice', async () => {
    const { asked, sentinels, setVisible, wake } = world();
    const leave = wake.acquire();
    setVisible(false);
    setVisible(true);
    expect(asked).toHaveLength(1);
    asked[0].resolve();
    await settle();
    expect(wake.snapshot.held).toBe(true);
    expect(sentinels[0].released).toBe(false);
    leave();
  });

  it('hidden while asked, the request refused, shown again: asked once more (a new chance)', async () => {
    const { asked, setVisible, wake } = world();
    const leave = wake.acquire();
    setVisible(false);
    asked[0].reject();
    await settle();
    expect(asked).toHaveLength(1); // まだ非表示
    setVisible(true);
    expect(asked).toHaveLength(2);
    leave();
  });

  it('hidden and shown again while asked, then refused: asked once more (the new chance), not again after that', async () => {
    const { asked, visibility, setVisible, wake } = world();
    const leave = wake.acquire();
    setVisible(false);
    setVisible(true);
    expect(asked).toHaveLength(1); // 要求中: 同時に 2 件は要求しない
    asked[0].reject();
    await settle();
    expect(asked).toHaveLength(2);
    asked[1].reject();
    await settle();
    expect(asked).toHaveLength(2); // 同じ機会: 繰り返さない
    expect(wake.snapshot).toEqual({ holders: 1, held: false, pending: false });
    leave();
    expect(visibility.size).toBe(0);
  });

  it('refused (permission, low battery): watching goes on, and it is not asked again in a loop', async () => {
    const { asked, visibility, wake } = world();
    const leave = wake.acquire();
    asked[0].reject();
    await settle();
    expect(wake.snapshot).toEqual({ holders: 1, held: false, pending: false });
    const other = wake.acquire(); // 別のビュー・同じ機会: 新たに要求しない
    expect(asked).toHaveLength(1);
    other();
    leave();
    expect(visibility.size).toBe(0);
    // あとで開いたビューは新しい機会。
    const later = wake.acquire();
    expect(asked).toHaveLength(2);
    later();
  });

  it('refused while shown (Strict Mode pair of effects during the request) is not asked twice', async () => {
    const { asked, wake } = world();
    wake.acquire()();
    const leave = wake.acquire();
    asked[0].reject();
    await settle();
    expect(asked).toHaveLength(1);
    leave();
  });

  it('released by the OS: not asked again until the tab is shown again', async () => {
    const { asked, sentinels, setVisible, wake } = world();
    const leave = wake.acquire();
    asked[0].resolve();
    await settle();
    sentinels[0].osRelease();
    expect(wake.snapshot.held).toBe(false);
    expect(sentinels[0].listening).toBe(0);
    expect(asked).toHaveLength(1);
    setVisible(false);
    setVisible(true);
    expect(asked).toHaveLength(2);
    asked[1].resolve();
    await settle();
    expect(wake.snapshot.held).toBe(true);
    leave();
  });

  it('no Wake Lock API (older browsers, http): nothing is asked and nothing fails', () => {
    const { wake, visibility } = world({ supported: false });
    const leave = wake.acquire();
    expect(wake.snapshot).toEqual({ holders: 1, held: false, pending: false });
    leave();
    expect(visibility.size).toBe(0);
  });

  it('a request that throws at once: watching goes on', () => {
    const { wake } = world({ throws: true });
    const leave = wake.acquire();
    expect(wake.snapshot).toEqual({ holders: 1, held: false, pending: false });
    leave();
  });

  it('the browser environment without navigator.wakeLock (Node, jsdom) reports none', () => {
    expect(browserWakeEnvironment().wakeLock()).toBeUndefined();
  });
});
