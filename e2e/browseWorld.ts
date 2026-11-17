import type { Page } from '@playwright/test';
import { N01_API_BASE_URL } from '../src/integrations/n01/endpoints';
import { browseReply } from '../src/test/n01/browse';
import type { BrowseReplyOptions } from '../src/test/n01/browse';

/**
 * 観戦の 3 つの一覧 (src/test/n01/browse.ts) を、通信なしの n01 として答える。別の n01 の応答
 * (serveNight など) の後に登録すると先に答え、該当しない読み込みはそちらに回す。
 */
export interface BrowseControl extends BrowseReplyOptions {
  log: string[];
}

export async function serveBrowse(page: Page, control: BrowseControl): Promise<void> {
  await page.route(`${N01_API_BASE_URL}/**`, async (route) => {
    const url = new URL(route.request().url());
    const operation = url.pathname.replace(/^.*\/api\/v1\//u, '');
    const params = Object.fromEntries(url.searchParams.entries());
    const body = browseReply(operation, params, control);
    if (body === undefined) return route.fallback();
    control.log.push(`${operation}?${url.searchParams.toString()}`);
    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body), headers: { 'access-control-allow-origin': '*' } });
  });
}
