import type { Page } from '@playwright/test';

type WakeLockCalls = { requests: number; releases: number };
type TestWindow = Window & { wakeLockCalls: WakeLockCalls };

export async function mockScreenWakeLock(page: Page): Promise<() => Promise<WakeLockCalls>> {
  await page.addInitScript(() => {
    const calls: WakeLockCalls = { requests: 0, releases: 0 };
    (window as TestWindow).wakeLockCalls = calls;
    Object.defineProperty(navigator, 'wakeLock', {
      value: {
        async request(type: string): Promise<WakeLockSentinel> {
          if (type !== 'screen') throw new Error('Expected a screen wake lock');
          calls.requests += 1;
          return Object.assign(new EventTarget(), {
            type: 'screen' as const,
            released: false,
            onrelease: null,
            async release() {
              if (this.released) return;
              this.released = true;
              calls.releases += 1;
            },
          });
        },
      },
    });
  });
  return () => page.evaluate(() => (window as TestWindow).wakeLockCalls);
}
