import { describe, expect, it } from 'vitest';
import { AnalyticsApi } from '../src/features/analytics/api/readApi';
import type { AnalyticsTransport } from '../src/features/analytics/api/readApi';
import { desperadoGames, details, OFFICIAL_2024_2ND, RAW_2024_2ND, TDID_2024_2ND, wireDetail, wireGame, withDetailSides } from '../src/features/analytics/realData.roles.fixtures';
import type { StatLine } from '../src/features/analytics/types';
import { formatRoleReport, verifySeasonRoles } from './verify-analytics-roles';

const wire = (l: StatLine, extra: Record<string, unknown> = {}) => ({
  score: l.score, darts: l.darts, f9Score: l.f9Score, f9Darts: l.f9Darts, leg: l.leg, winLeg: l.winLeg, set: l.set, winSet: l.winSet, a_b: l.breakLegs, w_b: l.breakWins,
  match: l.match, winMatch: l.winMatch, ton00: l.ton00, ton40: l.ton40, ton70: l.ton70, ton80: l.ton80, highOut: l.highOut, best: l.bestLeg, ...extra,
});

/** The live 2024 2nd responses, reduced to Desperado (the fixtures captured from n01). */
class Live2024 implements AnalyticsTransport {
  async request(operation: string, params: Record<string, string>): Promise<unknown> {
    const players = Object.entries(OFFICIAL_2024_2ND).filter(([id]) => id !== 'pzDR');
    switch (operation) {
      case 'tournament/get':
        return { result: 0, tournament: { ...RAW_2024_2ND.tournament, title: '2024 ATDO DARTS LEAGUE 2nd', status: 40, entry_list: [{ tpid: 'pzDR', name: 'Desperado' }], lg_table: [[], ['pzDR']], lg_title: ['A', 'B'] } };
      case 'tournament/stats':
        return params.kind === 'stats_list'
          ? { result: 0, stats: { pzDR: wire(OFFICIAL_2024_2ND.pzDR, { r_g: 2 }) } }
          : { result: 0, stats: Object.fromEntries(players.map(([oid, l]) => [oid, wire(l, { tpid: 'pzDR', oname: oid, r_g: 2 })])) };
      case 'team/player/list':
        return { result: 0, list: players.map(([oid]) => ({ oid, tpid: 'pzDR', oname: oid })) };
      case 'match/list': {
        const rows = withDetailSides(desperadoGames()).map(wireGame);
        const skip = Number(params.skip ?? 0);
        return { result: 0, list: rows.slice(skip, skip + Number(params.count)) };
      }
      case 'match/get': {
        const d = details().find((x) => x.gameId === params.mid);
        return d ? wireDetail(d) : { result: -1, error: 'not found' };
      }
    }
    throw new Error(operation);
  }
}

describe('verify:analytics-roles (on the captured 2024 2nd responses)', () => {
  it('reports the Cricket slot, the 01-only score/darts equality and the leg difference; the sample player verifies', async () => {
    const api = new AnalyticsApi({ transport: new Live2024(), maxRequests: 200 });
    const lines = await verifySeasonRoles(api, TDID_2024_2ND, 1);
    const text = lines.map((l) => `${l.status} ${l.text}`).join('\n');
    expect(text).toContain('構成 mixed');
    expect(text).toContain('8kxb クリケット num_part=2 start=0 legs=2 match_type=(なし) → cricket (start-score+name)');
    expect(text).toMatch(/pass team Desperado: 01ゲーム 48844\/3559 vs 公式 48844\/3559 ・ 公式との差 Leg 18 \/ Set 8/);
    // The sample is the player with the fewest multi-thrower games: 阿部 証人 (one team game).
    expect(text).toMatch(/pass player vhqF \(2ゲーム\): partly-verified 3DA=true/);
    expect(formatRoleReport({ lines, requests: api.requestCount, unreachable: false }).exitCode).toBe(0);
  });

  it('exit code 2 when n01 cannot be reached', () => {
    expect(formatRoleReport({ lines: [], requests: 0, unreachable: true }).exitCode).toBe(2);
  });
});
