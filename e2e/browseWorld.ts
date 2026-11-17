import type { Page } from '@playwright/test';
import { N01_API_BASE_URL } from '../src/integrations/n01/endpoints';
import { FOLLOWED_TOURNAMENT_MID, browseReply, followedNowRows } from '../src/test/n01/browse';
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

/**
 * 注目選手の試合 (src/test/n01/browse.ts の followedNowRows) を答える。n01 で進行中の試合の一覧
 * (条件なしの `match/list?live=1`) と、大会の試合を `mid` で読んだとき (終わった試合として) だけ。
 * 他の n01 の応答 (serveNight など) の後に登録する。`fail` の間は進行中の一覧の読み込みを失敗させる。
 */
export async function serveFollowedNow(page: Page, control: { log: string[]; fail?: boolean; leagueTdid: string; eventTdid: string }): Promise<void> {
  await page.route(`${N01_API_BASE_URL}/**`, async (route) => {
    const url = new URL(route.request().url());
    const operation = url.pathname.replace(/^.*\/api\/v1\//u, '');
    const q = url.searchParams;
    const json = (body: unknown) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body), headers: { 'access-control-allow-origin': '*' } });
    const rows = followedNowRows(control.leagueTdid, control.eventTdid);
    if (operation === 'match/list' && q.get('live') === '1' && !q.get('tdid') && !q.get('mid') && !q.get('scid') && !q.get('tdid__exists')) {
      control.log.push(`${operation}?${q.toString()}`);
      return control.fail ? json({ result: -54, error: 'query too slow' }) : json({ result: 0, list: rows });
    }
    if (operation === 'match/list' && q.get('mid') === FOLLOWED_TOURNAMENT_MID) {
      const row = rows.find((entry) => entry.mid === FOLLOWED_TOURNAMENT_MID)!;
      return json({ result: 0, list: q.get('live') === '1' ? [] : [{ ...row, endMatch: 1 }] });
    }
    return route.fallback();
  });
}
