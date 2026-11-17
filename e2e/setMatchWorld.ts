import type { Page } from '@playwright/test';
import { N01_API_BASE_URL } from '../src/integrations/n01/endpoints';
import { setMatchReply } from '../src/test/n01/setMatch';
import type { SetMatchOptions } from '../src/test/n01/setMatch';

/**
 * The made-up set-format match of `src/test/n01/setMatch.ts` on canned n01 (no network),
 * layered over another canned server (registered after it, so it answers first and hands every
 * other read on). A test moves the match on by setting `phase`.
 */
export interface SetMatchControl extends SetMatchOptions {
  phase: number;
  /** In the list of games in progress, the left player's name is replaced by this (注目選手). */
  followedName?: string;
  log: string[];
}

export async function serveSetMatch(page: Page, control: SetMatchControl): Promise<void> {
  await page.route(`${N01_API_BASE_URL}/**`, async (route) => {
    const url = new URL(route.request().url());
    const operation = url.pathname.replace(/^.*\/api\/v1\//u, '');
    const params = Object.fromEntries(url.searchParams.entries());
    const headers = { 'access-control-allow-origin': '*' };
    let body: unknown;
    try {
      body = setMatchReply(operation, params, control.phase, control);
    } catch {
      return route.fulfill({ status: 503, body: '{}', headers });
    }
    if (body === undefined) return route.fallback();
    control.log.push(`${operation}?${url.searchParams.toString()}`);
    if (control.followedName && operation === 'match/list' && params.live === '1' && !params.scid && !params.mid) {
      const rows = (body as { list: { statsData: { name: string }[] }[] }).list;
      body = { result: 0, list: rows.map((row) => ({ ...row, statsData: [{ ...row.statsData[0], name: control.followedName }, row.statsData[1]] })) };
    }
    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body), headers });
  });
}
