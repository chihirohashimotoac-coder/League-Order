import { readFileSync } from 'node:fs';
import type { Page } from '@playwright/test';
import { N01_API_BASE_URL } from '../src/integrations/n01/endpoints';

/**
 * A fixture n01 (browser tests) holding one real AKDO season: `src/features/analytics/realData.akdo.json`
 * (n01 read API 2026-11-16; names and opids are test values). Unknown requests are answered 404.
 */
const SNAP = JSON.parse(readFileSync(new URL('../src/features/analytics/realData.akdo.json', import.meta.url), 'utf-8')) as {
  league: { lgid: string; title: string };
  leagueEntry: Record<string, unknown>;
  tournament: Record<string, unknown>;
  fullRoster: Record<string, unknown>[];
  playerStats: Record<string, unknown>;
  teamStats: Record<string, unknown>;
  games: Record<string, unknown>[];
  details: Record<string, unknown>;
  highIn: unknown;
};
export const AKDO_LEAGUE = SNAP.league.lgid;
const TDID = String(SNAP.leagueEntry.tdid);

function response(operation: string, params: URLSearchParams): unknown | undefined {
  const tdid = params.get('tdid');
  if (operation === 'league/list') return { result: 0, list: [SNAP.league] };
  if (operation === 'league/get' && params.get('lgid') === AKDO_LEAGUE) return { result: 0, league: SNAP.league };
  if (operation === 'league/tournament/list' && params.get('lgid') === AKDO_LEAGUE) return { result: 0, list: [SNAP.leagueEntry] };
  if (operation === 'match/get') return SNAP.details[params.get('mid') ?? ''] ?? { result: -1, error: 'not found' };
  if (tdid !== TDID) return undefined;
  switch (operation) {
    case 'tournament/get':
      return { result: 0, tournament: SNAP.tournament };
    case 'team/player/list': {
      const tpid = params.get('tpid');
      return { result: 0, list: tpid ? SNAP.fullRoster.filter((r) => r.tpid === tpid) : SNAP.fullRoster };
    }
    case 'tournament/standings':
      return { result: 0, tdid, groups: [] };
    case 'tournament/stats': {
      const kind = params.get('kind') ?? 'stats_list';
      if (kind === 'stats_list') return { result: 0, kind, stats: SNAP.teamStats };
      if (kind === 'player_stats_list') return { result: 0, kind, stats: SNAP.playerStats };
      if (kind === 'player_high_in') return SNAP.highIn;
      return undefined;
    }
    case 'match/list': {
      if (params.get('tmid__regex') !== '_lg_') return { result: 0, list: [] };
      const skip = Number(params.get('skip') ?? 0);
      const count = Number(params.get('count') ?? 100);
      return { result: 0, list: SNAP.games.slice(skip, skip + count) };
    }
    default:
      return undefined;
  }
}

export async function serveAkdoWorld(page: Page): Promise<{ log: string[]; unanswered: string[] }> {
  const control = { log: [] as string[], unanswered: [] as string[] };
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
