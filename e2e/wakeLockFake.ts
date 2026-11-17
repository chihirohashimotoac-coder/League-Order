import type { Page } from '@playwright/test';

/**
 * A stand-in for the Screen Wake Lock API (`navigator.wakeLock`) and for the page being hidden,
 * installed before the app loads. Headless Chromium has no screen to keep on, so what the app
 * asks for is recorded instead: how many locks are held now, the most held at once, how many were
 * asked for and released. `mode: 'deny'` refuses every request (NotAllowedError), `'none'` leaves
 * the API out (an older browser).
 */
export interface WakeRecord {
  active: number;
  max: number;
  requests: number;
  releases: number;
  denied: number;
}

export async function fakeWakeLock(page: Page, mode: 'grant' | 'deny' | 'none' = 'grant'): Promise<void> {
  await page.addInitScript((how) => {
    const record = { active: 0, max: 0, requests: 0, releases: 0, denied: 0 };
    const control = { hidden: false };
    (window as unknown as { __wake: unknown; __wakeControl: unknown }).__wake = record;
    (window as unknown as { __wakeControl: unknown }).__wakeControl = control;
    Object.defineProperty(Document.prototype, 'visibilityState', { configurable: true, get: () => (control.hidden ? 'hidden' : 'visible') });
    Object.defineProperty(Document.prototype, 'hidden', { configurable: true, get: () => control.hidden });
    if (how === 'none') {
      Object.defineProperty(Navigator.prototype, 'wakeLock', { configurable: true, get: () => undefined });
      return;
    }
    const wakeLock = {
      request: (type: string) => {
        record.requests += 1;
        if (how === 'deny' || type !== 'screen') {
          record.denied += 1;
          return Promise.reject(new DOMException('Wake Lock permission request denied', 'NotAllowedError'));
        }
        record.active += 1;
        record.max = Math.max(record.max, record.active);
        let released = false;
        const listeners = new Set<() => void>();
        return Promise.resolve({
          type: 'screen',
          get released() {
            return released;
          },
          release: () => {
            if (!released) {
              released = true;
              record.active -= 1;
              record.releases += 1;
              for (const listener of [...listeners]) listener();
            }
            return Promise.resolve();
          },
          addEventListener: (_type: string, listener: () => void) => listeners.add(listener),
          removeEventListener: (_type: string, listener: () => void) => listeners.delete(listener),
        });
      },
    };
    Object.defineProperty(Navigator.prototype, 'wakeLock', { configurable: true, get: () => wakeLock });
  }, mode);
}

export const wakeRecord = (page: Page): Promise<WakeRecord> => page.evaluate(() => (window as unknown as { __wake: WakeRecord }).__wake);
/** How many screen locks the app holds now. */
export const wakeHeld = async (page: Page): Promise<number> => (await wakeRecord(page)).active;

/** The tab hidden (another app, the screen off) or shown again. */
export async function setPageHidden(page: Page, hidden: boolean): Promise<void> {
  await page.evaluate((value) => {
    (window as unknown as { __wakeControl: { hidden: boolean } }).__wakeControl.hidden = value;
    document.dispatchEvent(new Event('visibilitychange'));
  }, hidden);
}
