import { describe, expect, it } from 'vitest';
import { sharedOpids } from '../../domain/n01/identity';
import { planRosterSync, type RosterSourcePlayer } from '../../domain/n01/roster';
import { aggregatePlayer } from '../../domain/n01/history';
import { rosterSource } from './rosterResolver';
import { indexStats, statsFor } from './statsResolver';
import {
  CURRENT,
  PREVIOUS,
  buildIntel,
  linkedPlayer,
  orderEntry,
  rosterPlayer,
  row,
} from '../../test/n01/intelFixtures';

/**
 * F02 follow-up: the same `opid` AND the same name on rows with different `oid`s, inside one
 * season.
 *
 * Two readings fit those rows and the rows alone cannot tell them apart:
 *   (a) two people with the same name who were handed one `opid` (n01 does reuse an opid:
 *       the real ATDO 2026 3rd roster has two people under `02-0111`);
 *   (b) one person with two memberships in the season — in the real ATDO 2026 3rd roster,
 *       `02-0109` 西俣 太陽 is `alpp` on HsGD and `gm3v` on WpZb.
 *
 * Reading (a) would lend one person's numbers and history to the other, so the `opid` is not
 * used to join people while it carries two `oid`s in a season's rows. Each `oid` keeps its
 * own row of that season. (b) therefore loses the cross-membership join: a safe loss
 * (Unknown / LOW), never a wrong number. The tests below fix both halves.
 */

const OPID = 'op_twin';
const TWIN_A = { opid: OPID, oid: 'twA', name: '田中 太郎' };
const TWIN_B = { opid: OPID, oid: 'twB', name: '田中 太郎' };

describe('sharedOpids', () => {
  it('treats one opid on two different oids as not provably one person, even with one name', () => {
    expect(sharedOpids([TWIN_A, TWIN_B]).has(OPID)).toBe(true);
  });

  it('keeps an opid usable when every row for it has the same oid (stats + roster of one person)', () => {
    expect(sharedOpids([TWIN_A, { ...TWIN_A }, { opid: OPID, oid: 'twA', name: '田中 太郎' }]).has(OPID)).toBe(false);
  });

  it('ignores a row with no oid: it cannot tell people apart', () => {
    expect(sharedOpids([TWIN_A, { opid: OPID, oid: null, name: '田中 太郎' }]).has(OPID)).toBe(false);
  });

  it('is judged inside the rows given: the same opid in two seasons has two oids by nature', () => {
    const thisSeason = sharedOpids([TWIN_A]);
    const lastSeason = sharedOpids([{ opid: OPID, oid: 'old', name: '田中 太郎' }]);
    expect(thisSeason.has(OPID)).toBe(false);
    expect(lastSeason.has(OPID)).toBe(false);
  });
});

describe('current-season stats', () => {
  it('does not lend one same-named person’s row to the other', () => {
    const index = indexStats([row(OPID, 'twA', '田中 太郎', 60)], [TWIN_A, TWIN_B]);
    expect(statsFor(index, { opid: OPID, oid: 'twA' })?.name).toBe('田中 太郎');
    expect(statsFor(index, { opid: OPID, oid: 'twB' })).toBeNull();
  });

  it('gives each roster player only the row of their own oid', () => {
    const source = rosterSource(
      [rosterPlayer(OPID, 'twA', '田中 太郎'), rosterPlayer(OPID, 'twB', '田中 太郎')],
      [row(OPID, 'twA', '田中 太郎', 60)],
      CURRENT,
      1_000,
    );
    expect(source.map((player) => [player.oid, player.stats?.ppr ?? null])).toEqual([
      ['twA', 60],
      ['twB', null],
    ]);
  });
});

describe('a person with two memberships in one season (real ATDO 2026 3rd, 02-0109)', () => {
  it('is not joined across memberships: the safe loss is Unknown, not a namesake’s number', () => {
    // alpp is 西俣 on HsGD (no stats row: they played for WpZb); gm3v is 西俣 on WpZb (has the row).
    const source = rosterSource(
      [rosterPlayer('02-0109', 'alpp', '西俣 太陽', 'HsGD')],
      [row('02-0109', 'gm3v', '西俣 太陽', 54)],
      CURRENT,
      1_000,
    );
    expect(source[0].stats).toBeNull();
    // ...and with the WpZb membership listed too, each oid still gets only its own row.
    const both = rosterSource(
      [rosterPlayer('02-0109', 'alpp', '西俣 太陽', 'HsGD'), rosterPlayer('02-0109', 'gm3v', '西俣 太陽', 'WpZb')],
      [row('02-0109', 'gm3v', '西俣 太陽', 54)],
      CURRENT,
      1_000,
    );
    expect(both.map((player) => [player.oid, player.stats?.ppr ?? null])).toEqual([
      ['alpp', null],
      ['gm3v', 54],
    ]);
  });
});

describe('history across seasons', () => {
  const roster = [rosterPlayer(OPID, 'twA', '田中 太郎'), rosterPlayer(OPID, 'twB', '田中 太郎')];
  const stats = [row(OPID, 'twA', '田中 太郎', 60), row(OPID, 'twB', '田中 太郎', 40)];
  const previous = [row(OPID, 'pA', '田中 太郎', 72)];

  it('does not copy past rows of the opid onto either same-named person', () => {
    const intel = buildIntel({
      roster,
      stats,
      history: [{ id: PREVIOUS, title: '2026 2nd', seasonIndex: 1, stats: previous }],
    });
    expect(intel.ourStats).toHaveLength(2);
    expect(new Set(intel.ourStats.map((entry) => entry.key)).size).toBe(2);
    for (const entry of intel.ourStats) {
      expect(entry.seasons.map((line) => line.seasonIndex)).toEqual([0]);
    }
    const a = intel.ourStats.find((entry) => entry.key.endsWith('twA'))!;
    const b = intel.ourStats.find((entry) => entry.key.endsWith('twB'))!;
    expect(Math.round(aggregatePlayer(a).ppr ?? 0)).toBe(60);
    expect(Math.round(aggregatePlayer(b).ppr ?? 0)).toBe(40);
  });

  it('keeps the guard: one oid on the opid is still followed across seasons', () => {
    const intel = buildIntel({
      roster: [rosterPlayer(OPID, 'twA', '田中 太郎')],
      stats: [row(OPID, 'twA', '田中 太郎', 60)],
      history: [{ id: PREVIOUS, title: '2026 2nd', seasonIndex: 1, stats: previous }],
    });
    expect(intel.ourStats[0].key).toBe(OPID);
    expect(intel.ourStats[0].seasons.map((line) => line.seasonIndex)).toEqual([0, 1]);
  });

  it('does not join past rows when the second oid only shows up in the current roster', () => {
    // 田中 (twB) has no stats row yet; the roster alone shows the opid carries two oids.
    const intel = buildIntel({
      roster,
      stats: [row(OPID, 'twA', '田中 太郎', 60)],
      history: [{ id: PREVIOUS, title: '2026 2nd', seasonIndex: 1, stats: previous }],
    });
    expect(intel.ourPlayers).toHaveLength(2);
    expect(new Set(intel.ourPlayers.map((player) => player.key)).size).toBe(2);
    for (const entry of intel.ourStats) {
      expect(entry.seasons.map((line) => line.seasonIndex)).not.toContain(1);
    }
  });
});

describe('the opponent’s orders', () => {
  it('does not credit a same-named pair’s past line-ups to either of them', () => {
    const intel = buildIntel({
      roster: [rosterPlayer('op_me', 'me1', '自分')],
      stats: [row('op_me', 'me1', '自分', 50)],
      withOpponent: true,
      opponentRoster: [rosterPlayer(OPID, 'twA', '田中 太郎', 'T2'), rosterPlayer(OPID, 'twB', '田中 太郎', 'T2')],
      history: [
        {
          id: PREVIOUS,
          title: '2026 2nd',
          seasonIndex: 1,
          stats: [row(OPID, 'pA', '田中 太郎', 70, 1200, 'T2')],
          opponentOrders: [
            orderEntry('pm1', 's1', [{ opid: OPID, oid: 'pA', name: '田中 太郎' }]),
            orderEntry('pm2', 's1', [{ opid: OPID, oid: 'pA', name: '田中 太郎' }]),
          ],
        },
      ],
    });
    const keys = new Set(intel.opponent!.players.map((player) => player.key));
    expect(keys.size).toBe(2);
    const slot = intel.opponent!.positionModel.slots.find((entry) => entry.signature === 'SINGLES|01|1')!;
    for (const player of slot.players) expect(player.appearanceCount).toBe(0);
  });
});

describe('roster matching', () => {
  const source = (oid: string): RosterSourcePlayer => ({ opid: OPID, oid, teamId: 'T1', name: '田中 太郎', stats: null });
  let n = 0;
  const sync = (local: ReturnType<typeof linkedPlayer>[], roster: RosterSourcePlayer[]) =>
    planRosterSync({ teamId: 'team_test', localPlayers: local, source: roster, tournamentId: CURRENT, now: 2_000, newId: () => `pl_new${++n}` });

  it('does not join a same-named newcomer to the namesake through the shared opid', () => {
    const a = linkedPlayer('pl_a', TWIN_A);
    // twB comes first: through the bare opid it would take pl_a (who is twA) for itself.
    const result = sync([a], [source('twB'), source('twA')]);
    // twA is the record we already have; twB is somebody new, not a second copy of it.
    expect(result.added.map((entry) => entry.name)).toEqual(['田中 太郎']);
    expect(result.added[0].playerId).not.toBe('pl_a');
    const touched = result.upserts.find((player) => player.id === 'pl_a');
    expect(touched?.n01?.currentOid ?? 'twA').toBe('twA');
    expect(result.deactivated).toEqual([]);
  });
});
