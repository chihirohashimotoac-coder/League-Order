import { describe, expect, it } from 'vitest';
import { N01Client } from './client';
import type { N01Request } from './endpoints';
import { fetchTeamData } from './sync';
import { buildIntelligenceSnapshot, fetchIntelligence } from './intelligence';
import { createFixtureTransport, FAIL } from '../../test/n01/transport';
import { FIXTURE_NOW } from '../../test/n01/leagues';
import {
  BEFORE,
  PREVIOUS,
  THEM,
  buildIntel,
  managedFormat,
  orderEntry,
  rosterPlayer,
  row,
} from '../../test/n01/intelFixtures';

/**
 * Whole rosters decide whether an `opid` names one person (docs/N01_MASTER_DESIGN.md §3.4).
 *
 * A season's stats and a team's line-ups only show the people who played. The whole roster
 * (`team/player/list` without a team) also shows the ones who did not: the real ATDO 2026
 * 3rd has two rows named 西俣 太陽 under `02-0109` with a stats row for one of them. So the
 * snapshot reads each season's whole roster, once, before it lets an `opid` join seasons —
 * and when that roster could not be read, nothing in that season is *proven*: the `opid`
 * joins nothing there, the season's own `oid`s still match, and the person falls back to
 * what is certain (their own current numbers, low confidence).
 */

const OP = 'op_twin';
const NAME = '田中 太郎';

const ours = rosterPlayer(OP, 'cx', NAME);
const nowRow = row(OP, 'cx', NAME, 60);

describe('a previous season’s whole roster has two oids under one opid, stats for one', () => {
  const previousRoster = [rosterPlayer(OP, 'pA', NAME, 'T9'), rosterPlayer(OP, 'pB', NAME, 'T9')];
  const previousStats = [row(OP, 'pB', NAME, 40, 1200, 'T9')];

  it('does not hand that row to the current player', () => {
    const intel = buildIntel({
      roster: [ours],
      stats: [nowRow],
      history: [{ id: PREVIOUS, title: '2026 2nd', seasonIndex: 1, stats: previousStats, roster: previousRoster }],
    });
    expect(intel.ourStats[0].seasons.map((line) => line.seasonIndex)).toEqual([0]);
  });

  it('guard: the same stats row IS followed when the roster shows one oid for the opid', () => {
    const intel = buildIntel({
      roster: [ours],
      stats: [nowRow],
      history: [
        { id: PREVIOUS, title: '2026 2nd', seasonIndex: 1, stats: previousStats, roster: [rosterPlayer(OP, 'pB', NAME, 'T9')] },
      ],
    });
    expect(intel.ourStats[0].seasons.map((line) => line.seasonIndex)).toEqual([0, 1]);
  });
});

describe('the current season’s whole roster has a same-named oid on another team', () => {
  it('keeps the player apart from their namesake and from the opid’s history', () => {
    const intel = buildIntel({
      roster: [ours],
      stats: [nowRow],
      // The other team's 田中 太郎: same name, same opid, another oid. Our own roster shows only one.
      fullRoster: [ours, rosterPlayer(OP, 'cy', NAME, 'T7')],
      history: [{ id: PREVIOUS, title: '2026 2nd', seasonIndex: 1, stats: [row(OP, 'pB', NAME, 40)] }],
    });
    const player = intel.ourStats[0];
    expect(player.key).not.toBe(OP);
    expect(player.seasons.map((line) => line.seasonIndex)).toEqual([0]);
    // The current season is still read by this player's own oid.
    expect(Math.round(((player.seasons[0].score * 3) / player.seasons[0].darts))).toBe(60);
  });
});

describe('a whole roster that could not be fetched proves nothing for that season', () => {
  const unique = [rosterPlayer('op_k', 'k1', NAME)];
  const uniqueNow = [row('op_k', 'k1', NAME, 60)];
  const uniquePast = [row('op_k', 'kOld', NAME, 44)];

  it('guard: with the roster, a unique opid joins the seasons', () => {
    const intel = buildIntel({
      roster: unique,
      stats: uniqueNow,
      history: [{ id: PREVIOUS, title: '2026 2nd', seasonIndex: 1, stats: uniquePast, roster: [rosterPlayer('op_k', 'kOld', NAME)] }],
    });
    expect(intel.ourStats[0].key).toBe('op_k');
    expect(intel.ourStats[0].seasons.map((line) => line.seasonIndex)).toEqual([0, 1]);
  });

  it('a past season whose roster failed adds no line through the opid', () => {
    const intel = buildIntel({
      roster: unique,
      stats: uniqueNow,
      history: [{ id: PREVIOUS, title: '2026 2nd', seasonIndex: 1, stats: uniquePast, roster: null }],
    });
    expect(intel.ourStats[0].seasons.map((line) => line.seasonIndex)).toEqual([0]);
  });

  it('only the season that failed is cut off; the other past season still joins', () => {
    const intel = buildIntel({
      roster: unique,
      stats: uniqueNow,
      history: [
        { id: PREVIOUS, title: '2026 2nd', seasonIndex: 1, stats: uniquePast, roster: null },
        { id: BEFORE, title: '2026 1st', seasonIndex: 2, stats: [row('op_k', 'kOlder', NAME, 40)], roster: [rosterPlayer('op_k', 'kOlder', NAME)] },
      ],
    });
    expect(intel.ourStats[0].seasons.map((line) => line.seasonIndex)).toEqual([0, 2]);
  });

  it('a current roster that failed proves nothing: the opid joins no season, the oid still finds this season', () => {
    const intel = buildIntel({
      roster: unique,
      stats: uniqueNow,
      fullRoster: null,
      history: [{ id: PREVIOUS, title: '2026 2nd', seasonIndex: 1, stats: uniquePast, roster: [rosterPlayer('op_k', 'kOld', NAME)] }],
    });
    const player = intel.ourStats[0];
    expect(player.key).toBe('oid:t_cur:k1');
    expect(player.seasons.map((line) => line.seasonIndex)).toEqual([0]);
    expect(Math.round((player.seasons[0].score * 3) / player.seasons[0].darts)).toBe(60);
  });

  it('a past season whose roster failed does not credit the opponent’s past line-ups through the opid', () => {
    const seats = (roster: ReturnType<typeof rosterPlayer>[] | null): number => {
      const intel = buildIntel({
        roster: [rosterPlayer('op_me', 'me1', '自分')],
        stats: [row('op_me', 'me1', '自分', 50)],
        withOpponent: true,
        opponentRoster: [rosterPlayer('op_x', 'x1', '山田 次郎', THEM)],
        history: [
          {
            id: PREVIOUS,
            title: '2026 2nd',
            seasonIndex: 1,
            stats: [row('op_x', 'xOld', '山田 次郎', 70, 1200, THEM)],
            roster,
            opponentOrders: [
              orderEntry('pm1', 's1', [{ opid: 'op_x', oid: 'xOld', name: '山田 次郎' }]),
              orderEntry('pm2', 's1', [{ opid: 'op_x', oid: 'xOld', name: '山田 次郎' }]),
            ],
          },
        ],
      });
      const slot = intel.opponent!.positionModel.slots.find((entry) => entry.signature === 'SINGLES|01|1')!;
      return slot.players.reduce((total, player) => total + player.appearanceCount, 0);
    };
    expect(seats([rosterPlayer('op_x', 'xOld', '山田 次郎', THEM)])).toBeGreaterThan(0);
    expect(seats(null)).toBe(0);
  });
});

describe('a rename and a normal join are unaffected', () => {
  it('follows a unique opid across a rename when the roster shows one oid', () => {
    const intel = buildIntel({
      roster: [rosterPlayer('op_k', 'k1', '田中 太郎')],
      stats: [row('op_k', 'k1', '田中 太郎', 50)],
      history: [
        {
          id: PREVIOUS,
          title: '2026 2nd',
          seasonIndex: 1,
          stats: [row('op_k', 'old1', '田中 太朗', 44, 1200, THEM)],
          roster: [rosterPlayer('op_k', 'old1', '田中 太朗', THEM)],
        },
        {
          id: BEFORE,
          title: '2026 1st',
          seasonIndex: 2,
          stats: [row('op_k', 'old2', '田中 太朗', 40)],
          roster: [rosterPlayer('op_k', 'old2', '田中 太朗')],
        },
      ],
    });
    expect(intel.ourStats[0].key).toBe('op_k');
    expect(intel.ourStats[0].seasons.map((line) => line.seasonIndex)).toEqual([0, 1, 2]);
  });

  it('a renamed player is still apart from a namesake shown only by the whole roster', () => {
    const intel = buildIntel({
      roster: [rosterPlayer('op_k', 'k1', '田中 太郎')],
      stats: [row('op_k', 'k1', '田中 太郎', 50)],
      history: [
        {
          id: PREVIOUS,
          title: '2026 2nd',
          seasonIndex: 1,
          stats: [row('op_k', 'old1', '田中 太朗', 44)],
          // Same opid, another oid and ANOTHER spelling: still two people under one opid.
          roster: [rosterPlayer('op_k', 'old1', '田中 太朗'), rosterPlayer('op_k', 'old9', '田中 太郎')],
        },
      ],
    });
    expect(intel.ourStats[0].seasons.map((line) => line.seasonIndex)).toEqual([0]);
  });
});

describe('fetching: each season’s whole roster is requested once', () => {
  const ATDO = 'lg_l3hI_3397';
  const CURRENT_ID = 't_ABvC_5234';

  async function run(options: Parameters<typeof createFixtureTransport>[0] = {}) {
    const log: N01Request[] = [];
    const client = new N01Client(createFixtureTransport({ ...options, log }), { now: () => FIXTURE_NOW });
    const data = await fetchTeamData(client, { leagueId: ATDO, leagueTitle: 'ATDO', tournamentId: CURRENT_ID, teamTpid: 'GpiQ' }, () => FIXTURE_NOW);
    log.length = 0;
    const fetched = await fetchIntelligence(client, data, { historyDepth: 2, now: () => FIXTURE_NOW });
    return { data, fetched, log };
  }

  const wholeRosterCalls = (log: readonly N01Request[]): string[] =>
    log.filter((request) => request.operation === 'team/player/list' && request.params.tpid === undefined).map((request) => request.params.tdid);

  it('one request per season: the current one and each referenced past one', async () => {
    const { fetched, log } = await run();
    const calls = wholeRosterCalls(log);
    expect(calls).toHaveLength(1 + fetched.history.length);
    expect(new Set(calls).size).toBe(calls.length);
    expect(calls).toContain(CURRENT_ID);
    for (const season of fetched.history) expect(calls).toContain(season.tournament.tournamentId);
    expect(fetched.rosters.current?.length).toBeGreaterThan(0);
    for (const season of fetched.history) expect(fetched.rosters.byTournament[season.tournament.tournamentId]?.length).toBeGreaterThan(0);
  });

  it('a failed whole roster is a note and a null, never a failed sync', async () => {
    const failing = new Set<string>();
    const first = await run();
    const pastId = first.fetched.history[0].tournament.tournamentId;
    failing.add(pastId);
    const { data, fetched } = await run({
      override: (request) =>
        request.operation === 'team/player/list' && request.params.tpid === undefined && failing.has(request.params.tdid) ? FAIL : undefined,
    });
    expect(fetched.rosters.byTournament[pastId]).toBeNull();
    expect(fetched.rosters.current).not.toBeNull();
    expect(fetched.history.map((season) => season.tournament.tournamentId)).toContain(pastId);
    expect(fetched.notes.some((note) => note.includes('名簿'))).toBe(true);
    const intel = buildIntelligenceSnapshot({ teamId: 'team_kv', data, format: managedFormat(), fetched, historyDepth: 2, now: FIXTURE_NOW });
    // The failed season contributes no line to anybody through an opid.
    const failedIndex = fetched.history.find((season) => season.tournament.tournamentId === pastId)!.seasonIndex;
    for (const entry of intel.ourStats) expect(entry.seasons.map((line) => line.seasonIndex)).not.toContain(failedIndex);
  });
});
