import { readFileSync } from 'node:fs';
import type { Page } from '@playwright/test';
import { N01_API_BASE_URL } from '../src/integrations/n01/endpoints';
import { details2026, drizzumGamesWithDetails, OFFICIAL_2026_3RD, OFFICIAL_WPZB_2026_3RD, TDID_2026_3RD, wireDetail, wireGame } from '../src/features/analytics/realData.roles.fixtures';
import type { StatLine } from '../src/features/analytics/types';

/**
 * A fixture n01 (test-only) holding one real league season, for the doubles view's positive
 * path: ATDO DARTS LEAGUE 2026 3rd, team ドリズム (`WpZb`, division A).
 *
 *  - `tournament/get` and ドリズム's roster: read 2026-11-15 (`e2e/fixtures/atdo-2026-3rd-drizzum.json`,
 *    match results left out);
 *  - stats, played games and leg details: the analytics fixtures read 2026-10-13
 *    (`realData.roles.fixtures.ts`), already checked there against n01's own totals — 灰田
 *    (`o3ul`) 473 points / 26 darts, First 9 96 / 6, from one doubles game whose legs are served
 *    here in full. Only ドリズム's two `player_stats_list` rows and its team row exist.
 *  - `player_high_in`: none (the in-rule comes from the organiser's rule, not from the records).
 * Live n01 is never contacted; every request is logged.
 */

const SNAPSHOT = JSON.parse(readFileSync(new URL('./fixtures/atdo-2026-3rd-drizzum.json', import.meta.url), 'utf-8')) as {
  tournament: Record<string, unknown>;
  rosterWpZb: { tpid: string; oid: string; opid: string; oname: string }[];
};
const LEAGUE = 'lg_l3hI_3397';
/** The season's league-list `createTime` (no `t_date` is set on ATDO seasons). */
const CREATE_TIME = 1_789_829_175;

function statRow(line: StatLine, extra: Record<string, unknown>): Record<string, unknown> {
  return {
    ...extra,
    score: line.score, darts: line.darts, f9Score: line.f9Score, f9Darts: line.f9Darts, leg: line.leg, winLeg: line.winLeg, set: line.set, winSet: line.winSet,
    a_b: line.breakLegs, w_b: line.breakWins, match: line.match, winMatch: line.winMatch, ton00: line.ton00, ton40: line.ton40, ton70: line.ton70, ton80: line.ton80,
    highOut: line.highOut ?? 0, best: line.bestLeg ?? 0, ho: 1, hc: 0,
  };
}

function response(operation: string, params: URLSearchParams): unknown | undefined {
  const tdid = params.get('tdid');
  if (operation === 'league/list') return { result: 0, list: [{ lgid: LEAGUE, title: 'ATDO DARTS LEAGUE' }] };
  if (operation === 'league/tournament/list' && params.get('lgid') === LEAGUE) {
    return { result: 0, list: [{ tdid: TDID_2026_3RD, title: SNAPSHOT.tournament.title, status: 30, createTime: CREATE_TIME, t_date: 0 }] };
  }
  if (operation === 'match/get') {
    const detail = details2026().find((d) => d.gameId === params.get('mid'));
    return detail ? wireDetail(detail) : { result: -1, error: 'not found' };
  }
  if (tdid !== TDID_2026_3RD) return undefined;
  switch (operation) {
    case 'tournament/get':
      return { result: 0, tournament: SNAPSHOT.tournament };
    case 'team/player/list': {
      const tpid = params.get('tpid');
      return { result: 0, list: !tpid || tpid === 'WpZb' ? SNAPSHOT.rosterWpZb : [] };
    }
    case 'tournament/standings':
      return { result: 0, tdid, groups: [] };
    case 'tournament/stats': {
      const kind = params.get('kind') ?? 'stats_list';
      if (kind === 'stats_list') return { result: 0, kind, stats: { WpZb: statRow(OFFICIAL_WPZB_2026_3RD, { tpid: 'WpZb', r_g: 1 }) } };
      if (kind === 'player_stats_list') {
        const stats = Object.fromEntries(
          Object.entries(OFFICIAL_2026_3RD).map(([oid, line]) => {
            const member = SNAPSHOT.rosterWpZb.find((p) => p.oid === oid)!;
            return [oid, statRow(line, { oid, opid: member.opid, oname: member.oname, tpid: 'WpZb', r_g: 1 })];
          }),
        );
        return { result: 0, kind, stats };
      }
      if (kind === 'player_high_in') return { result: 0, kind, stats: [] };
      return undefined;
    }
    case 'match/list': {
      if (params.get('tmid__regex') !== '_lg_') return { result: 0, list: [] };
      const skip = Number(params.get('skip') ?? 0);
      const count = Number(params.get('count') ?? 100);
      return { result: 0, list: drizzumGamesWithDetails().map(wireGame).slice(skip, skip + count) };
    }
    default:
      return undefined;
  }
}

export interface DoublesWorldControl {
  /** Every request, as `operation?params`. */
  log: string[];
  /** Requests this world has no answer for (answered 404). */
  unanswered: string[];
}

export async function serveDoublesWorld(page: Page): Promise<DoublesWorldControl> {
  const control: DoublesWorldControl = { log: [], unanswered: [] };
  await page.route(`${N01_API_BASE_URL}/**`, async (route) => {
    const url = new URL(route.request().url());
    const operation = url.pathname.replace(/^.*\/api\/v1\//u, '');
    const entry = `${operation}?${url.searchParams.toString()}`;
    control.log.push(entry);
    const headers = { 'Access-Control-Allow-Origin': '*' };
    const body = response(operation, url.searchParams);
    if (body === undefined) {
      control.unanswered.push(entry);
      await route.fulfill({ status: 404, body: '{}', headers });
      return;
    }
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body), headers });
  });
  return control;
}
