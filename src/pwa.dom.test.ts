import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * PWA update flow (MASTER SPEC Phase 6 §9 "update"): a new build is announced, never
 * applied behind the captain's back; applying it is the captain's explicit action.
 */

const registerSW = vi.fn();
vi.mock('virtual:pwa-register', () => ({ registerSW }));

let updateSW: ReturnType<typeof vi.fn>;
let options: { onNeedRefresh?: () => void; onOfflineReady?: () => void; immediate?: boolean };

beforeEach(() => {
  vi.resetModules();
  updateSW = vi.fn();
  registerSW.mockReset();
  registerSW.mockImplementation((given) => {
    options = given;
    return updateSW;
  });
  Object.defineProperty(navigator, 'serviceWorker', { configurable: true, value: {} });
});

afterEach(() => {
  Reflect.deleteProperty(navigator, 'serviceWorker');
});

describe('service worker updates', () => {
  it('registers immediately so the app is cached for offline use at once', async () => {
    const pwa = await import('./pwa');
    pwa.initServiceWorker();
    expect(registerSW).toHaveBeenCalledTimes(1);
    expect(options.immediate).toBe(true);
    expect(pwa.isOfflineReady()).toBe(false);
    options.onOfflineReady?.();
    expect(pwa.isOfflineReady()).toBe(true);
  });

  it('announces a waiting update and applies it only when asked', async () => {
    const pwa = await import('./pwa');
    pwa.initServiceWorker();
    const seen: (() => void)[] = [];
    pwa.onUpdateAvailable((apply) => seen.push(apply));
    options.onNeedRefresh?.();
    expect(seen).toHaveLength(1);
    expect(updateSW).not.toHaveBeenCalled();
    seen[0]();
    expect(updateSW).toHaveBeenCalledWith(true);
  });

  it('tells a screen that subscribes later about an update that is already waiting', async () => {
    const pwa = await import('./pwa');
    pwa.initServiceWorker();
    options.onNeedRefresh?.();
    const late = vi.fn();
    const unsubscribe = pwa.onUpdateAvailable(late);
    expect(late).toHaveBeenCalledTimes(1);
    unsubscribe();
  });
});
