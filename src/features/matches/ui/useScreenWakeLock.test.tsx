// @vitest-environment jsdom
import { StrictMode } from 'react';
import { act, cleanup, render, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useScreenWakeLock } from './useScreenWakeLock';

class ScreenLock extends EventTarget implements WakeLockSentinel {
  readonly type = 'screen';
  released = false;
  onrelease = null;
  release = vi.fn(async () => {
    this.released = true;
    this.dispatchEvent(new Event('release'));
  });
}

function Viewer({ watching = true }: { watching?: boolean }): null {
  useScreenWakeLock(watching);
  return null;
}

const wakeLockProperty = Object.getOwnPropertyDescriptor(navigator, 'wakeLock');

function mockWakeLock(request?: WakeLock['request']): void {
  Object.defineProperty(navigator, 'wakeLock', { configurable: true, value: request ? { request } : undefined });
}

function changeVisibility(state: DocumentVisibilityState): void {
  vi.spyOn(document, 'visibilityState', 'get').mockReturnValue(state);
  document.dispatchEvent(new Event('visibilitychange'));
}

afterEach(async () => {
  cleanup();
  await act(async () => {});
  vi.restoreAllMocks();
  if (wakeLockProperty) Object.defineProperty(navigator, 'wakeLock', wakeLockProperty);
  else Reflect.deleteProperty(navigator, 'wakeLock');
});

describe('useScreenWakeLock', () => {
  it('shares a single screen lock across viewers and releases it after the last one leaves', async () => {
    changeVisibility('visible');
    const lock = new ScreenLock();
    const request = vi.fn().mockResolvedValue(lock);
    mockWakeLock(request);
    const first = render(<StrictMode><Viewer /></StrictMode>);
    const second = render(<Viewer />);
    await waitFor(() => expect(request).toHaveBeenCalledTimes(1));
    expect(request).toHaveBeenCalledWith('screen');

    first.rerender(<StrictMode><Viewer watching={false} /></StrictMode>);
    expect(lock.release).not.toHaveBeenCalled();
    second.unmount();
    await waitFor(() => expect(lock.release).toHaveBeenCalledTimes(1));
  });

  it('waits for a visible tab and reacquires after visibility and page-cache transitions', async () => {
    changeVisibility('hidden');
    const first = new ScreenLock();
    const second = new ScreenLock();
    const third = new ScreenLock();
    const request = vi.fn().mockResolvedValueOnce(first).mockResolvedValueOnce(second).mockResolvedValueOnce(third);
    mockWakeLock(request);
    const view = render(<Viewer />);
    await act(async () => {});
    expect(request).not.toHaveBeenCalled();

    await act(async () => changeVisibility('visible'));
    expect(request).toHaveBeenCalledTimes(1);
    await act(async () => changeVisibility('hidden'));
    expect(first.release).toHaveBeenCalledTimes(1);
    await act(async () => changeVisibility('visible'));
    expect(request).toHaveBeenCalledTimes(2);

    await act(async () => { window.dispatchEvent(new Event('pagehide')); });
    expect(second.release).toHaveBeenCalledTimes(1);
    await act(async () => { window.dispatchEvent(new Event('pageshow')); });
    expect(request).toHaveBeenCalledTimes(3);

    view.unmount();
    await act(async () => changeVisibility('hidden'));
    await act(async () => changeVisibility('visible'));
    expect(third.release).toHaveBeenCalledTimes(1);
    expect(request).toHaveBeenCalledTimes(3);
  });

  it('releases a pending acquisition after leaving or hiding, before any replacement request', async () => {
    changeVisibility('visible');
    const late = new ScreenLock();
    const next = new ScreenLock();
    let finishRequest!: (lock: WakeLockSentinel) => void;
    const pending = new Promise<WakeLockSentinel>((resolve) => { finishRequest = resolve; });
    const request = vi.fn().mockReturnValueOnce(pending).mockResolvedValueOnce(next);
    mockWakeLock(request);
    const view = render(<Viewer />);
    await waitFor(() => expect(request).toHaveBeenCalledTimes(1));

    view.unmount();
    await act(async () => changeVisibility('hidden'));
    render(<Viewer />);
    await act(async () => changeVisibility('visible'));
    expect(request).toHaveBeenCalledTimes(1);

    await act(async () => finishRequest(late));
    expect(late.release).toHaveBeenCalledTimes(1);
    expect(request).toHaveBeenCalledTimes(2);
    expect(late.release.mock.invocationCallOrder[0]).toBeLessThan(request.mock.invocationCallOrder[1]);
    expect(next.release).not.toHaveBeenCalled();
  });

  it('releases a request that resolves after the last viewer has left', async () => {
    changeVisibility('visible');
    const late = new ScreenLock();
    let finishRequest!: (lock: WakeLockSentinel) => void;
    const pending = new Promise<WakeLockSentinel>((resolve) => { finishRequest = resolve; });
    const request = vi.fn().mockReturnValue(pending);
    mockWakeLock(request);
    const view = render(<Viewer />);
    await waitFor(() => expect(request).toHaveBeenCalledTimes(1));
    view.unmount();
    await act(async () => finishRequest(late));
    expect(late.release).toHaveBeenCalledTimes(1);
    expect(request).toHaveBeenCalledTimes(1);
  });

  it('keeps working when the browser denies a request or releases a held lock', async () => {
    changeVisibility('visible');
    const lock = new ScreenLock();
    const request = vi.fn().mockRejectedValueOnce(new DOMException('Denied', 'NotAllowedError'))
      .mockResolvedValueOnce(lock).mockResolvedValueOnce(new ScreenLock());
    mockWakeLock(request);
    render(<Viewer />);
    await act(async () => {});
    expect(request).toHaveBeenCalledTimes(1);

    await act(async () => changeVisibility('hidden'));
    await act(async () => changeVisibility('visible'));
    expect(request).toHaveBeenCalledTimes(2);
    lock.released = true;
    lock.dispatchEvent(new Event('release'));
    await act(async () => {});
    expect(request).toHaveBeenCalledTimes(2);

    await act(async () => changeVisibility('hidden'));
    await act(async () => changeVisibility('visible'));
    expect(request).toHaveBeenCalledTimes(3);
    expect(lock.release).not.toHaveBeenCalled();
  });

  it('allows viewing without API support', async () => {
    changeVisibility('visible');
    mockWakeLock();
    const listen = vi.spyOn(document, 'addEventListener');
    render(<Viewer />);
    await act(async () => {});
    expect(listen.mock.calls.some(([event]) => event === 'visibilitychange')).toBe(false);
  });
});
