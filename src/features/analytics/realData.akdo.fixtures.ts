import type { AnalyticsTransport } from './api/readApi';

/**
 * A fixture n01 holding one real AKDO season (test-only): AKDO DARTS LEAGUE 2026/2nd
 * (`t_Oyyg_8973`), the 21 games of MC-BREMEN (`5bve`) with their leg details, read from the n01 read
 * API on 2026-11-16 (`realData.akdo.json`, see its `_note`: names and opids are test values, oids are
 * the season's own). Its doubles and gallon slots are `ignore_avg: 1`.
 *
 * Expected (recomputed from those responses in `.scratch`-style probes and the audit):
 *  - 竹内 淳 (`b1p2`, AKDO選手01): n01 official 3,370 / 148 = his three singles only; all nine 01
 *    games rebuilt give 6,311 / 286. 100+ 17 / 140+ 4 / 180 2, High Finish 72, Break 4/9 over all
 *    games. Doubles double-in: 6 successes in 9 throws (66.7%), slot ダブルス2 (`il25`).
 *  - 平賀 正弘 (`vuch`, AKDO選手02) singles: 3DA 49.20 (984 / 60), First 9 47.50 (285 / 18),
 *    Keep 0/1, Break 0/1.
 *  - MC-BREMEN singles (12 games): First 9 64.01 (5,377 points / 252 darts), 3DA 61.56.
 */
export interface AkdoSnapshot {
  league: { lgid: string; title: string };
  leagueEntry: Record<string, unknown>;
  tournament: Record<string, unknown>;
  fullRoster: Record<string, unknown>[];
  playerStats: Record<string, Record<string, unknown>>;
  teamStats: Record<string, Record<string, unknown>>;
  games: Record<string, unknown>[];
  details: Record<string, unknown>;
  highIn: unknown;
}

export const AKDO_TDID = 't_Oyyg_8973';
export const AKDO_LEAGUE = 'lg_Amgb_5525';
export const AKDO_TEAM = '5bve';
export const TAKEUCHI = 'b1p2';
export const HIRAGA = 'vuch';

/** A copy of the season under another league id (the same `ignore_avg` slots, no organiser's rule). */
export function underLeague(snap: AkdoSnapshot, leagueId: string): AkdoSnapshot {
  return { ...snap, league: { ...snap.league, lgid: leagueId }, leagueEntry: { ...snap.leagueEntry, lgid: leagueId }, tournament: { ...snap.tournament, lgid: leagueId } };
}

export class AkdoN01 implements AnalyticsTransport {
  calls: string[] = [];
  /** Games whose `match/get` fails (as n01 down for that game). */
  down = new Set<string>();
  constructor(private readonly snap: AkdoSnapshot) {}
  async request(operation: string, params: Record<string, string>): Promise<unknown> {
    this.calls.push(`${operation}?${new URLSearchParams(params).toString()}`);
    const snap = this.snap;
    const tdid = params.tdid;
    if (operation === 'league/tournament/list' && params.lgid === snap.league.lgid) return { result: 0, list: [snap.leagueEntry] };
    if (operation === 'match/get') {
      if (this.down.has(params.mid)) throw new Error('down');
      return snap.details[params.mid] ?? { result: -1, error: 'not found' };
    }
    if (tdid !== AKDO_TDID) throw new Error(`unexpected ${operation}`);
    switch (operation) {
      case 'tournament/get':
        return { result: 0, tournament: snap.tournament };
      case 'team/player/list':
        return { result: 0, list: params.tpid ? snap.fullRoster.filter((r) => r.tpid === params.tpid) : snap.fullRoster };
      case 'tournament/standings':
        return { result: 0, tdid, groups: [] };
      case 'tournament/stats': {
        const kind = params.kind ?? 'stats_list';
        if (kind === 'stats_list') return { result: 0, kind, stats: snap.teamStats };
        if (kind === 'player_stats_list') return { result: 0, kind, stats: snap.playerStats };
        if (kind === 'player_high_in') return snap.highIn;
        break;
      }
      case 'match/list': {
        if (params.tmid__regex !== '_lg_') return { result: 0, list: [] };
        const skip = Number(params.skip ?? 0);
        const count = Number(params.count ?? 100);
        return { result: 0, list: snap.games.slice(skip, skip + count) };
      }
    }
    throw new Error(`unexpected ${operation}`);
  }
}
