import type { Page } from '@playwright/test';
import { N01_API_BASE_URL, parseRequestUrl } from '../src/integrations/n01/endpoints';
import { allFixtureDatasets, fixtureResponse } from '../src/test/n01/transport';
import { FIXTURE_NOW } from '../src/test/n01/leagues';

/**
 * Fixture n01 server for the browser (test-only).
 *
 * Intercepts the n01 public read API host and answers from the generated fixture
 * leagues, through the app's real `fetch` path — CORS headers included, because a
 * cross-origin response without them would be rejected exactly as in production.
 * Live n01 is never contacted from the suite.
 */
export interface N01ServerControl {
  /** While true every n01 request fails as a network error. */
  offline: boolean;
  /** Requests served so far, as `operation?params`. */
  log: string[];
  /** Holds every answer this long (ms), to see the progress screen. */
  delayMs: number;
}

export async function serveN01(page: Page): Promise<N01ServerControl> {
  const control: N01ServerControl = { offline: false, log: [], delayMs: 0 };
  const datasets = allFixtureDatasets();
  await page.route(`${N01_API_BASE_URL}/**`, async (route) => {
    if (control.delayMs > 0) await new Promise((resolve) => setTimeout(resolve, control.delayMs));
    if (control.offline) {
      await route.abort('internetdisconnected');
      return;
    }
    const request = parseRequestUrl(N01_API_BASE_URL, route.request().url());
    const headers = { 'Access-Control-Allow-Origin': '*' };
    if (!request) {
      await route.fulfill({ status: 404, body: '{}', headers });
      return;
    }
    control.log.push(`${request.operation}?${new URLSearchParams(request.params).toString()}`);
    const body = fixtureResponse(request, datasets);
    if (body === undefined) {
      await route.fulfill({ status: 404, body: '{}', headers });
      return;
    }
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body), headers });
  });
  return control;
}

/** Pins the page clock to the fixtures' "today" (2026-10-07 12:00 JST). */
export async function pinFixtureClock(page: Page): Promise<void> {
  await page.clock.setFixedTime(new Date(FIXTURE_NOW));
}
