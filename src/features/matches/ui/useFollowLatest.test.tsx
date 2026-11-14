import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { act, cleanup, render } from '@testing-library/react';
import { useFollowLatest } from './useFollowLatest';

/**
 * The live score sheet's box follows the newest row only while the viewer is at it (re-audit
 * U02). jsdom has no layout: the box's heights and scroll position are set by hand here, the
 * way the browser would lay them out (one box per test).
 */

const layout = { clientHeight: 418, scrollHeight: 789, scrollTop: 0 };
const keys = ['clientHeight', 'clientWidth', 'scrollHeight', 'scrollTop', 'scrollTo'] as const;
const saved = new Map<string, PropertyDescriptor | undefined>();

beforeEach(() => {
  Object.assign(layout, { clientHeight: 418, scrollHeight: 789, scrollTop: 0 });
  for (const key of keys) saved.set(key, Object.getOwnPropertyDescriptor(HTMLElement.prototype, key));
  Object.defineProperties(HTMLElement.prototype, {
    clientHeight: { configurable: true, get: () => layout.clientHeight },
    clientWidth: { configurable: true, get: () => 600 },
    scrollHeight: { configurable: true, get: () => layout.scrollHeight },
    scrollTop: {
      configurable: true,
      get: () => layout.scrollTop,
      // The browser keeps the position within the content.
      set: (value: number) => {
        layout.scrollTop = Math.max(0, Math.min(value, layout.scrollHeight - layout.clientHeight));
      },
    },
    scrollTo: {
      configurable: true,
      value(this: HTMLElement, options?: ScrollToOptions) {
        this.scrollTop = options?.top ?? 0;
      },
    },
  });
});

afterEach(() => {
  cleanup();
  for (const key of keys) {
    const descriptor = saved.get(key);
    if (descriptor) Object.defineProperty(HTMLElement.prototype, key, descriptor);
    else delete (HTMLElement.prototype as unknown as Record<string, unknown>)[key];
  }
});

function Sheet(): React.JSX.Element {
  const follow = useFollowLatest<HTMLDivElement>({ enabled: true, game: 'g1', update: 0 });
  return <div ref={follow.ref} data-testid="box" data-following={follow.following ? 'true' : 'false'} />;
}

function mount(): { box: HTMLElement; following: () => string | null; scroll: (top: number) => void } {
  const box = render(<Sheet />).getByTestId('box');
  return {
    box,
    following: () => box.getAttribute('data-following'),
    // The viewer moves the position: the browser fires `scroll`.
    scroll: (top) =>
      act(() => {
        box.scrollTop = top;
        box.dispatchEvent(new Event('scroll'));
      }),
  };
}

const gap = (): number => layout.scrollHeight - layout.clientHeight - layout.scrollTop;

describe('useFollowLatest', () => {
  it('opens at the newest row and stops following when the viewer scrolls up', () => {
    const { following, scroll } = mount();
    expect(gap()).toBe(0);
    expect(following()).toBe('true');
    scroll(100);
    expect(following()).toBe('false');
    expect(layout.scrollTop).toBe(100);
  });

  it('a window resized and resized back between two frames does not stop following', () => {
    const { box, following } = mount();
    expect(layout.scrollTop).toBe(371);
    // Widened: the box grew to 522 px and the browser clamped the position to the new end
    // (371 → 267)…
    layout.clientHeight = 522;
    box.scrollTop = 267;
    // …then, before any frame, the window is back to its size: the box is 418 px again, and the
    // clamp's scroll event arrives with the window's resize event, at a size that looks unchanged.
    layout.clientHeight = 418;
    act(() => {
      window.dispatchEvent(new Event('resize'));
      box.dispatchEvent(new Event('scroll'));
    });
    expect(following()).toBe('true');
    expect(gap()).toBe(0);
  });

  it('while reading the history, a resize of the window does not pull the box to the end', () => {
    const { box, following, scroll } = mount();
    scroll(100);
    expect(following()).toBe('false');
    act(() => {
      window.dispatchEvent(new Event('resize'));
      box.dispatchEvent(new Event('scroll'));
    });
    expect(following()).toBe('false');
    expect(layout.scrollTop).toBe(100);
  });
});
