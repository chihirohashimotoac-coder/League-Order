import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { AnalyticsApi } from '../src/features/analytics/api/readApi';
import type { AnalyticsOperation } from '../src/features/analytics/api/readApi';
import {
  N01UnreachableError,
  PAGES_ORIGIN,
  Reader,
  formatReport,
  verifyAll,
  verifyAnalyticsLeague,
  type AnalyticsCheck,
} from './verify-analytics-n01';

/**
 * The analytics live verifier against a fake n01: no network. Each test bends one property of
 * a healthy season (the shape of the real ATDO data: `r_g` from 1, `lg_table` / standings
 * from 0) and asserts the verifier says so — and that the bend it must tolerate (a team with
 * no stats row) is a note, not a failure.
 */

const LG = 'lg_l3hI_3397';
const TD = 't_cur';
const BASE = 'https://push.n01darts.com/api/v1';

type Json = Record<string, unknown>;

interface World {
  /** Per-path overrides; return a Response to replace the answer, or undefined to keep it. */
  override?: (path: string) => Response | Json | undefined;
  /** Transform the healthy body of an operation. */
  tweak?: Partial<Record<'list' | 'get' | 'stats' | 'players' | 'standings' | 'roster', (body: Json) => Json>>;
  allowOrigin?: string | null;
}

const TEAMS: [string, string, number][] = [
  ['A1', 'Alpha', 0],
  ['A2', 'Apex', 0],
  ['B1', 'Bravo', 1],
  ['B2', 'Bolt', 1],
];

function healthy(): Record<'list' | 'get' | 'stats' | 'players' | 'standings' | 'roster', Json> {
  const teamStats: Json = {};
  for (const [tpid, , division] of TEAMS) teamStats[tpid] = { tpid, r_g: division + 1, score: 5000, darts: 300, leg: 10, winLeg: 5, match: 2, winMatch: 1 };
  const players: Json = {};
  const roster: Json[] = [];
  for (const [tpid, name, division] of TEAMS) {
    for (const n of [1, 2]) {
      const oid = `${tpid}_o${n}`;
      players[oid] = { opid: `op_${oid}`, tpid, oname: `${name} ${n}`, r_g: division + 1, score: 2500, darts: 150 };
      roster.push({ opid: `op_${oid}`, oid, tpid, oname: `${name} ${n}` });
    }
  }
  return {
    list: {
      result: 0,
      list: [
        { tdid: TD, title: '2026 ALPHA LEAGUE 3rd', status: 30, t_date: 0, createTime: 1789829175 },
        { tdid: 't_old', title: '2026 ALPHA LEAGUE 2nd', status: 40, t_date: 0, createTime: 1782808919 },
      ],
    },
    get: {
      result: 0,
      tournament: {
        title: '2026 ALPHA LEAGUE 3rd',
        lgid: LG,
        status: 30,
        entry_list: TEAMS.map(([tpid, name]) => ({ tpid, name })),
        lg_table: [['A1', 'A2'], ['B1', 'B2']],
        lg_title: ['Aディビジョン', 'Bディビジョン'],
        lg_setting: { schedule: [{ schid: 's1', num_part: 1, match_type: '01', startScore: 501, limit_leg_count: 2 }] },
      },
    },
    stats: { result: 0, kind: 'stats_list', stats: teamStats },
    players: { result: 0, kind: 'player_stats_list', stats: players },
    standings: {
      result: 0,
      tdid: TD,
      groups: [0, 1].map((index) => ({
        kind: 'lg',
        index,
        title: `Division ${index}`,
        players: TEAMS.filter(([, , division]) => division === index).map(([tpid, name], rank) => ({ tpid, name, rank: rank + 1, p: 2, w: 1, d: 0, l: 1, pts: 9 })),
      })),
    },
    roster: { result: 0, list: roster },
  };
}

interface Seen {
  path: string;
  method: string;
  headers: Record<string, string>;
  credentials: string | undefined;
}

function fakeN01(world: World = {}): { fetchImpl: typeof fetch; seen: Seen[] } {
  const seen: Seen[] = [];
  const bodies = healthy();
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    const path = `${url.pathname.replace('/api/v1/', '')}?${url.searchParams.toString()}`;
    seen.push({ path, method: init?.method ?? 'GET', headers: Object.fromEntries(Object.entries(init?.headers ?? {})), credentials: init?.credentials });
    const replaced = world.override?.(path);
    const headers = new Headers({ 'content-type': 'application/json' });
    const allow = world.allowOrigin === undefined ? '*' : world.allowOrigin;
    if (allow !== null) headers.set('access-control-allow-origin', allow);
    if (replaced instanceof Response) return replaced;
    let key: keyof typeof bodies;
    if (url.pathname.endsWith('/league/tournament/list')) key = 'list';
    else if (url.pathname.endsWith('/tournament/get')) key = 'get';
    else if (url.pathname.endsWith('/tournament/standings')) key = 'standings';
    else if (url.pathname.endsWith('/team/player/list')) key = 'roster';
    else key = url.searchParams.get('kind') === 'stats_list' ? 'stats' : 'players';
    const body = replaced ?? (world.tweak?.[key] ? world.tweak[key]!(structuredClone(bodies[key])) : bodies[key]);
    return new Response(JSON.stringify(body), { status: 200, headers });
  }) as typeof fetch;
  return { fetchImpl, seen };
}

async function run(world: World = {}): Promise<{ checks: AnalyticsCheck[]; seen: Seen[]; reader: Reader }> {
  const { fetchImpl, seen } = fakeN01(world);
  const reader = new Reader({ fetchImpl, sleep: async () => undefined });
  const checks = await verifyAnalyticsLeague(reader, { leagueId: LG, title: 'TST' });
  return { checks, seen, reader };
}

const step = (checks: AnalyticsCheck[], name: string): AnalyticsCheck => {
  const found = checks.find((check) => check.step === name);
  if (!found) throw new Error(`no step "${name}" in: ${checks.map((c) => c.step).join(' | ')}`);
  return found;
};
const failures = (checks: AnalyticsCheck[]): string[] => checks.filter((c) => c.status === 'fail').map((c) => c.step);

describe('verify:analytics-n01 — a healthy season', () => {
  it('passes, and asks for exactly the paths and queries the analytics screens use', async () => {
    const { checks, seen } = await run();
    expect(failures(checks)).toEqual([]);
    expect(seen.map((s) => s.path)).toEqual([
      `league/tournament/list?lgid=${LG}`,
      `tournament/get?tdid=${TD}`,
      `tournament/stats?kind=stats_list&tdid=${TD}`,
      `tournament/stats?kind=player_stats_list&tdid=${TD}`,
      `tournament/standings?tdid=${TD}`,
      `team/player/list?tdid=${TD}`,
    ]);
  });

  it('sends the Pages origin, only GETs, and no credential', async () => {
    const { seen } = await run();
    for (const request of seen) {
      expect(request.method).toBe('GET');
      expect(request.credentials).toBe('omit');
      expect(request.headers.Origin).toBe(PAGES_ORIGIN);
      expect(Object.keys(request.headers).map((k) => k.toLowerCase())).not.toContain('authorization');
      expect(Object.keys(request.headers).map((k) => k.toLowerCase())).not.toContain('cookie');
    }
  });

  it('reports counts, r_g agreement and CORS', async () => {
    const { checks } = await run();
    expect(step(checks, 'stats_list').detail).toMatch(/4 rows for 4 registered teams/);
    expect(step(checks, 'player_stats_list').detail).toMatch(/8 rows \(8 on registered teams\)/);
    expect(step(checks, 'standings').detail).toMatch(/2 league group\(s\) indexed 0, 1, 4 rows/);
    expect(step(checks, 'team/player/list (all)').detail).toMatch(/8 players on all 4 registered teams/);
    expect(step(checks, 'r_g ↔ index').detail).toMatch(/stats_list: 4 agree, 0 disagree/);
    expect(step(checks, 'r_g ↔ index').status).toBe('pass');
    expect(step(checks, 'CORS').status).toBe('pass');
  });

  it('asks the same questions the app itself asks (AnalyticsApi parity)', async () => {
    const { seen } = await run();
    const sent: string[] = [];
    const api = new AnalyticsApi({
      transport: {
        async request(operation: AnalyticsOperation, params) {
          sent.push(`${operation}?${new URLSearchParams(Object.entries(params).sort(([a], [b]) => (a < b ? -1 : 1))).toString()}`);
          const { fetchImpl } = fakeN01();
          const url = new URL(`${BASE}/${operation}`);
          for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
          return (await fetchImpl(url.toString())).json();
        },
      },
    });
    await api.leagueTournaments(LG);
    await api.tournament(TD);
    await api.teamStats(TD);
    await api.playerStats(TD);
    await api.standings(TD);
    await api.fullRoster(TD);
    expect(sent).toEqual(seen.map((s) => s.path));
  });
});

describe('verify:analytics-n01 — division indexes', () => {
  it('accepts r_g counted from 1 against lg_table / standings counted from 0', async () => {
    const { checks } = await run();
    expect(step(checks, 'standings index ↔ lg_table').status).toBe('pass');
    expect(step(checks, 'r_g ↔ index').status).toBe('pass');
  });

  it('fails when r_g turns out to be 0-based, and says so', async () => {
    const { checks } = await run({
      tweak: {
        stats: (body) => {
          for (const row of Object.values(body.stats as Record<string, Json>)) row.r_g = (row.r_g as number) - 1;
          return body;
        },
      },
    });
    const check = step(checks, 'r_g ↔ index');
    expect(check.status).toBe('fail');
    expect(check.detail).toMatch(/looks 0-based/);
  });

  it('fails when standings are indexed from 1 instead of 0', async () => {
    const { checks } = await run({
      tweak: { standings: (body) => ({ ...body, groups: (body.groups as Json[]).map((g) => ({ ...g, index: (g.index as number) + 1 })) }) },
    });
    expect(step(checks, 'standings index ↔ lg_table').status).toBe('fail');
  });

  it('fails when standings put a team in another division than lg_table', async () => {
    const { checks } = await run({
      tweak: {
        standings: (body) => {
          const groups = body.groups as { players: Json[] }[];
          groups[1].players.push(groups[0].players.pop()!);
          return body;
        },
      },
    });
    const check = step(checks, 'standings index ↔ lg_table');
    expect(check.status).toBe('fail');
    expect(check.detail).toMatch(/1 team\(s\) in a different division/);
  });

  it('does not fail on a row whose r_g is 0 or absent: n01 reports no division', async () => {
    const { checks } = await run({
      tweak: {
        stats: (body) => {
          (body.stats as Record<string, Json>).A1.r_g = 0;
          delete (body.stats as Record<string, Json>).A2.r_g;
          return body;
        },
      },
    });
    const check = step(checks, 'r_g ↔ index');
    expect(check.status).toBe('pass');
    expect(check.detail).toMatch(/2 agree, 0 disagree, 2 without r_g/);
  });
});

describe('verify:analytics-n01 — teams without a stats row', () => {
  it('reports 未計測, and is neither a failure nor a zero', async () => {
    const { checks } = await run({
      tweak: {
        stats: (body) => {
          delete (body.stats as Record<string, Json>).B2;
          return body;
        },
      },
    });
    expect(failures(checks)).toEqual([]);
    const coverage = step(checks, 'stats_list coverage');
    expect(coverage.status).toBe('note');
    expect(coverage.detail).toMatch(/1 registered team\(s\) have no stats row — 未計測/);
    expect(coverage.detail).toMatch(/Bolt\[B2\]/);
    expect(step(checks, 'stats_list').detail).toMatch(/3 rows for 4 registered teams/);
  });

  it('is not a failure when no team has a stats row yet (a season that has not started)', async () => {
    const { checks } = await run({ tweak: { stats: (body) => ({ ...body, stats: {} }) } });
    expect(failures(checks)).toEqual([]);
    expect(step(checks, 'stats_list coverage').detail).toMatch(/4 registered team\(s\) have no stats row/);
  });
});

describe('verify:analytics-n01 — duplicate and shared opids', () => {
  it('reports an opid that two oids / names share, without failing', async () => {
    const { checks } = await run({
      tweak: {
        roster: (body) => {
          const rows = body.list as Json[];
          rows[0].opid = 'SHARED';
          rows[1].opid = 'SHARED';
          return body;
        },
      },
    });
    expect(failures(checks)).toEqual([]);
    const shared = step(checks, 'shared opid');
    expect(shared.status).toBe('note');
    expect(shared.detail).toMatch(/SHARED/);
  });

  it('reports an oid listed twice and an oid on two teams', async () => {
    const { checks } = await run({
      tweak: {
        players: (body) => {
          const rows: Json[] = Object.entries(body.stats as Record<string, Json>).map(([oid, row]) => ({ oid, ...row }));
          rows.push({ ...rows[0] }, { ...rows[1], tpid: 'B1', r_g: 2 });
          return { ...body, stats: rows };
        },
      },
    });
    expect(failures(checks)).toEqual([]);
    const dup = step(checks, 'duplicate oid');
    expect(dup.status).toBe('note');
    expect(dup.detail).toMatch(/2 oid\(s\) listed more than once/);
    expect(dup.detail).toMatch(/1 oid\(s\) on several teams/);
  });
});

describe('verify:analytics-n01 — the roster', () => {
  it('fails on a well-formed roster that lacks a registered team', async () => {
    const { checks } = await run({
      tweak: { roster: (body) => ({ ...body, list: (body.list as Json[]).filter((row) => row.tpid !== 'B2') }) },
    });
    const check = step(checks, 'team/player/list (all)');
    expect(check.status).toBe('fail');
    expect(check.detail).toMatch(/only 3 of 4 registered teams \(missing: B2\)/);
  });

  it('passes, and counts, team ids that are not registered', async () => {
    const { checks } = await run({
      tweak: { roster: (body) => ({ ...body, list: [...(body.list as Json[]), { opid: 'z', oid: 'zo', tpid: 'GHOST', oname: 'Ghost' }] }) },
    });
    const check = step(checks, 'team/player/list (all)');
    expect(check.status).toBe('pass');
    expect(check.detail).toMatch(/\+ 1 team id\(s\) not registered/);
  });
});

describe('verify:analytics-n01 — CORS', () => {
  it('passes for the exact Pages origin and for *', async () => {
    expect(step((await run({ allowOrigin: PAGES_ORIGIN })).checks, 'CORS').status).toBe('pass');
    expect(step((await run({ allowOrigin: '*' })).checks, 'CORS').status).toBe('pass');
  });

  it('fails when Access-Control-Allow-Origin is missing', async () => {
    const check = step((await run({ allowOrigin: null })).checks, 'CORS');
    expect(check.status).toBe('fail');
    expect(check.detail).toMatch(/\(no header\)/);
  });

  it('fails when it names another origin', async () => {
    const check = step((await run({ allowOrigin: 'https://example.com' })).checks, 'CORS');
    expect(check.status).toBe('fail');
    expect(check.detail).toMatch(/6 of 6 responses do not allow/);
  });
});

describe('verify:analytics-n01 — schema and HTTP changes', () => {
  it('fails when the stats container is renamed', async () => {
    const { checks } = await run({
      tweak: { stats: (body) => ({ result: 0, kind: 'stats_list', team_rows: body.stats }) },
    });
    expect(step(checks, 'stats_list').status).toBe('fail');
    expect(step(checks, 'stats_list').detail).toMatch(/schema/);
  });

  it('fails when the player stats container is renamed', async () => {
    const { checks } = await run({ tweak: { players: (body) => ({ result: 0, rows: body.stats }) } });
    expect(step(checks, 'player_stats_list').status).toBe('fail');
  });

  it('fails when standings lose their groups', async () => {
    const { checks } = await run({ tweak: { standings: () => ({ result: 0, tdid: TD, table: [] }) } });
    expect(step(checks, 'standings').status).toBe('fail');
  });

  it('fails when the roster loses its list', async () => {
    const { checks } = await run({ tweak: { roster: () => ({ result: 0, members: [] }) } });
    expect(step(checks, 'team/player/list (all)').status).toBe('fail');
  });

  it('fails on an n01 error body served with HTTP 200', async () => {
    const { checks } = await run({
      override: (path) => (path.startsWith('tournament/standings') ? { result: -1, error: 'not found' } : undefined),
    });
    expect(step(checks, 'standings').status).toBe('fail');
  });

  it('fails on an HTTP error and on a body that is not JSON', async () => {
    const http = await run({ override: (path) => (path.includes('player_stats_list') ? new Response('boom', { status: 500 }) : undefined) });
    expect(step(http.checks, 'player_stats_list').detail).toBe('HTTP 500');
    const html = await run({ override: (path) => (path.startsWith('tournament/standings') ? new Response('<html>', { status: 200 }) : undefined) });
    expect(step(html.checks, 'standings').detail).toMatch(/not JSON/);
  });

  it('fails when tournament/get loses lg_table', async () => {
    const { checks } = await run({
      tweak: {
        get: (body) => {
          delete (body.tournament as Json).lg_table;
          return body;
        },
      },
    });
    // Without divisions the season cannot be classified as a regular league season at all.
    expect(step(checks, 'season').status).toBe('fail');
    expect(step(checks, 'season').detail).toMatch(/no regular league season/);
  });

  it('retries a 429 once, then reports it', async () => {
    let calls = 0;
    const waits: number[] = [];
    const { fetchImpl } = fakeN01({
      override: (path) => {
        if (!path.startsWith('tournament/standings')) return undefined;
        calls += 1;
        return new Response('slow down', { status: 429, headers: { 'retry-after': '3' } });
      },
    });
    const reader = new Reader({ fetchImpl, sleep: async (ms) => void waits.push(ms) });
    const checks = await verifyAnalyticsLeague(reader, { leagueId: LG, title: 'TST' });
    expect(calls).toBe(2);
    expect(waits).toEqual([3000]);
    expect(step(checks, 'standings').detail).toBe('HTTP 429');
  });
});

describe('verify:analytics-n01 — season resolution', () => {
  it('passes over a newer running championship and resolves the regular season', async () => {
    const { checks, seen } = await run({
      tweak: {
        list: (body) => ({
          ...body,
          list: [{ tdid: 't_champ', title: '2026 年末チャンピオンシップ', status: 30, t_date: 0, createTime: 1790000000 }, ...(body.list as Json[])],
        }),
      },
      override: (path) =>
        path === 'tournament/get?tdid=t_champ'
          ? { result: 0, tournament: { title: '2026 年末チャンピオンシップ', status: 30, entry_list: [{ tpid: 'X', name: 'X' }], lg_table: [['X']] } }
          : undefined,
    });
    expect(step(checks, 'season').detail).toMatch(new RegExp(`^${TD} `));
    expect(seen.map((s) => s.path)).not.toContain('tournament/stats?kind=stats_list&tdid=t_champ');
  });

  it('fails when the list holds no running or finished tournament', async () => {
    const { checks } = await run({ tweak: { list: () => ({ result: 0, list: [{ tdid: 't_x', title: 'draft', status: 10, createTime: 1 }] }) } });
    expect(step(checks, 'season').status).toBe('fail');
  });
});

describe('verify:analytics-n01 — an environment that cannot reach n01', () => {
  const offline = (async () => {
    throw new TypeError('fetch failed', { cause: new Error('getaddrinfo ENOTFOUND push.n01darts.com') });
  }) as unknown as typeof fetch;

  it('is reported as unreachable with the reason, not as a contract failure', async () => {
    const report = await verifyAll({ fetchImpl: offline }, [{ leagueId: LG, title: 'TST' }]);
    expect(report.unreachable).toMatch(/ENOTFOUND push\.n01darts\.com/);
    expect(report.checks.filter((c) => c.status === 'fail')).toEqual([]);
    const { text, exitCode } = formatReport(report);
    expect(exitCode).toBe(2);
    expect(text).toMatch(/UNREACHABLE/);
    expect(text).toMatch(/does not|says nothing about the contract/);
  });

  it('throws N01UnreachableError from the reader itself', async () => {
    await expect(new Reader({ fetchImpl: offline }).get('league/tournament/list', { lgid: LG })).rejects.toBeInstanceOf(N01UnreachableError);
  });
});

describe('verify:analytics-n01 — exit codes and read-only guarantee', () => {
  it('exits 0 when the contract holds and 1 when it does not', async () => {
    const { fetchImpl } = fakeN01();
    const good = formatReport(await verifyAll({ fetchImpl, sleep: async () => undefined }, [{ leagueId: LG, title: 'TST' }]));
    expect(good.exitCode).toBe(0);
    expect(good.text).toMatch(/GET \/api\/v1\/tournament\/standings\?tdid=t_cur {2}→ HTTP 200 {2}json=yes {2}ACAO=\*/);
    const bad = fakeN01({ allowOrigin: null });
    expect(formatReport(await verifyAll({ fetchImpl: bad.fetchImpl, sleep: async () => undefined }, [{ leagueId: LG, title: 'TST' }])).exitCode).toBe(1);
  });

  it('has no write method and no credential in its source', () => {
    const source = readFileSync(new URL('./verify-analytics-n01.ts', import.meta.url), 'utf8');
    expect(source).not.toMatch(/method:\s*['"](?!GET)/);
    expect(source).not.toMatch(/Authorization|Basic |Cookie|process\.env/i);
  });
});
