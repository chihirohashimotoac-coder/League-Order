import type { Page } from '@playwright/test';
import { N01_API_BASE_URL } from '../src/integrations/n01/endpoints';
import { requestKey } from '../src/test/n01/generator';
import { allFixtureDatasets } from '../src/test/n01/transport';

/**
 * The two analytics-only read operations the fixture n01 does not serve:
 * `tournament/stats?kind=stats_list` and `tournament/standings`. Both are derived from the
 * fixture's own player rows, so the numbers the browser shows can be recomputed in the test.
 * Everything else falls through to the shared fixture server (`serveN01`).
 */
export interface AnalyticsServerControl {
  /** Analytics-only requests served, as `operation?params`. */
  log: string[];
  /** While true the analytics-only operations fail as network errors. */
  failExtras: boolean;
}

type Row = Record<string, unknown>;

function playerRows(tdid: string): Row[] {
  for (const dataset of allFixtureDatasets()) {
    const raw = dataset.get(requestKey('tournament/stats', { tdid, kind: 'player_stats_list' })) as { player_stats_list?: Row[] } | undefined;
    if (raw?.player_stats_list) return raw.player_stats_list;
  }
  return [];
}

function tournamentBody(tdid: string): Row | undefined {
  for (const dataset of allFixtureDatasets()) {
    const raw = dataset.get(requestKey('tournament/get', { tdid })) as { tournament?: Row } | undefined;
    if (raw?.tournament) return raw.tournament;
  }
  return undefined;
}

/** The roster's oid for a stats row (the live API keys player stats by oid; the fixture rows carry none). */
function oidOf(tdid: string, row: Row): string {
  for (const dataset of allFixtureDatasets()) {
    const raw = dataset.get(requestKey('team/player/list', { tdid })) as { list?: Row[] } | undefined;
    const hit = raw?.list?.find((r) => r.opid === row.opid && r.tpid === row.tpid);
    if (hit?.oid) return String(hit.oid);
  }
  return `x_${String(row.opid ?? row.oname)}`;
}

/** `player_stats_list` in the live shape: an object keyed by oid. */
export function playerStatsLive(tdid: string): Record<string, Row> {
  const out: Record<string, Row> = {};
  for (const row of playerRows(tdid)) out[oidOf(tdid, row)] = row;
  return out;
}

const SUM = ['score', 'darts', 'leg', 'winLeg', 'f9Score', 'f9Darts', 'ton00', 'ton40', 'ton70', 'ton80'] as const;

export function teamStats(tdid: string): Record<string, Row> {
  const teams: Record<string, Row> = {};
  for (const row of playerRows(tdid)) {
    const tpid = String(row.tpid ?? '');
    if (!tpid) continue;
    const acc = (teams[tpid] ??= { tpid, match: 2, winMatch: 1 });
    for (const key of SUM) acc[key] = Number(acc[key] ?? 0) + Number(row[key] ?? 0);
  }
  return teams;
}

export function standings(tdid: string): Row {
  const body = tournamentBody(tdid);
  const table = (body?.lg_table as string[][] | undefined) ?? [];
  const names = new Map(((body?.entry_list as Row[] | undefined) ?? []).map((e) => [String(e.tpid), String(e.name ?? e.tpid)]));
  const stats = teamStats(tdid);
  const groups = table.map((ids, index) => ({
    kind: 'lg',
    index,
    title: `Division ${index + 1}`,
    players: ids
      .filter((id) => stats[id])
      .sort((a, b) => Number(stats[b].winLeg) - Number(stats[a].winLeg))
      .map((id, rank) => ({ tpid: id, name: names.get(id) ?? id, rank: rank + 1, p: 2, w: 1, d: 0, l: 1, diff: 0, diff_l: 0, pts: 9, bh: 0, byes: 0 })),
  }));
  return { result: 0, tdid, groups };
}

export async function serveAnalyticsExtras(page: Page): Promise<AnalyticsServerControl> {
  const control: AnalyticsServerControl = { log: [], failExtras: false };
  await page.route(`${N01_API_BASE_URL}/**`, async (route) => {
    const url = new URL(route.request().url());
    const operation = url.pathname.replace(/^.*\/api\/v1\//u, '');
    const tdid = url.searchParams.get('tdid') ?? '';
    const kind = url.searchParams.get('kind');
    const headers = { 'Access-Control-Allow-Origin': '*' };
    const isStatsList = operation === 'tournament/stats' && kind === 'stats_list';
    const isPlayerList = operation === 'tournament/stats' && kind === 'player_stats_list';
    if (!isStatsList && !isPlayerList && operation !== 'tournament/standings') {
      await route.fallback();
      return;
    }
    if (!isPlayerList) control.log.push(`${operation}?${url.searchParams.toString()}`);
    if (control.failExtras && !isPlayerList) {
      await route.abort('internetdisconnected');
      return;
    }
    const body = isStatsList
      ? { result: 0, kind: 'stats_list', stats: teamStats(tdid) }
      : isPlayerList
        ? { result: 0, kind: 'player_stats_list', stats: playerStatsLive(tdid) }
        : standings(tdid);
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body), headers });
  });
  return control;
}
