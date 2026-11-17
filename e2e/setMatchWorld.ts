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
  liveReadFails?: boolean;
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
    if (control.liveReadFails && operation === 'match/live') return route.fulfill({ status: 503, body: '{}', headers });
    if (control.followedName && operation === 'match/list' && params.live === '1' && !params.scid && !params.mid) {
      const rows = (body as { list: { statsData: { name: string }[] }[] }).list;
      body = { result: 0, list: rows.map((row) => ({ ...row, statsData: [{ ...row.statsData[0], name: control.followedName }, row.statsData[1]] })) };
    }
    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body), headers });
  });
}

/**
 * liveNight's knockout event (JDO_EVENT) as a competition in progress in 「いま n01 で進行中」
 * (大会・リーグ), with its game readable by `mid` (layered over serveNight and serveSetMatch).
 */
export async function serveNowCompetition(page: Page): Promise<void> {
  const row = { mid: 'jdo_1', tdid: 't_Jdo0_0001', tmid: 't_Jdo0_0001_t_0_p1_p2', schid: '', match_type: '01', title: 'Sample Open 1回戦', startTime: 1_800_000_000, endMatch: 1, statsData: [{ name: '山田 太郎', tpid: 'p1', winLegs: 3, allScore: 1503, allDarts: 60 }, { name: '田中 花子', tpid: 'p2', winLegs: 1, allScore: 1200, allDarts: 60 }] };
  await page.route(`${N01_API_BASE_URL}/**`, async (route) => {
    const url = new URL(route.request().url());
    const operation = url.pathname.replace(/^.*\/api\/v1\//u, '');
    const q = url.searchParams;
    const headers = { 'access-control-allow-origin': '*' };
    const json = (body: unknown) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body), headers });
    if (operation === 'match/list' && q.get('mid') === 'jdo_1') return json({ result: 0, list: q.get('live') === '1' ? [] : [row] });
    if (operation === 'match/list' && q.get('live') === '1' && !q.get('tdid') && !q.get('mid') && !q.get('scid')) return json({ result: 0, list: [{ ...row, endMatch: 0 }] });
    // In the competition's own list it is in progress too (its ライブ tab shows it); read by
    // `mid` it is over (the page shows its legs without polling).
    if (operation === 'match/list' && q.get('tdid') === 't_Jdo0_0001' && !q.get('tmid__regex')) return json({ result: 0, list: [{ ...row, endMatch: 0 }] });
    return route.fallback();
  });
}
