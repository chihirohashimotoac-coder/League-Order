import { describe, expect, it } from 'vitest';
import {
  appearanceDelta,
  planSeasonCommit,
  planSeasonWithdrawal,
  seasonCommitStatus,
} from './seasonLedger';
import { createVersion } from './lifecycle';
import { generateOrder } from '../../optimizer/generateOrder';
import { orderInput, player, sampleFormatGames, sampleRoster } from '../../test/factories';
import { createMatchInfo, type OrderVersion, type Player, type SeasonCommit } from '../types';

const MATCH = createMatchInfo('kalavinka');
const ORDER_ID = 'ord_1';
const TEAM_ID = 'team_test';

function versionFor(roster: Player[], previous: OrderVersion[] = [], seed = 0): OrderVersion {
  const input = orderInput(roster, sampleFormatGames());
  const result = generateOrder(input);
  if (!result.ok) throw new Error('fixture should be satisfiable');
  return createVersion(input, result.candidates[0], MATCH, previous, 1000 + seed);
}

/** A version with hand-written appearances, so the arithmetic is easy to read. */
function syntheticVersion(
  version: number,
  appearances: { playerId: string; count: number; byKind?: Record<string, number> }[],
): OrderVersion {
  return {
    version,
    finalizedAt: 1000 * version,
    fingerprint: `fp${version}`,
    assignments: [],
    games: [],
    players: [],
    participants: [],
    match: MATCH,
    tallies: [],
    appearances: appearances.map((entry) => ({
      playerId: entry.playerId,
      count: entry.count,
      byKind: (entry.byKind ?? { SINGLES: entry.count }) as OrderVersion['appearances'][number]['byKind'],
    })),
    label: 'バランス',
    hasImputedRating: false,
  };
}

function roster(totals: Record<string, number> = {}): Player[] {
  return ['p1', 'p2', 'p3'].map((id) =>
    player({ id, name: id.toUpperCase(), rating: 10, seasonAppearances: totals[id] ?? 0 }),
  );
}

function applied(players: Player[], updated: Player[]): Player[] {
  const byId = new Map(updated.map((entry) => [entry.id, entry]));
  return players.map((entry) => byId.get(entry.id) ?? entry);
}

describe('appearanceDelta', () => {
  it('is the full amount when nothing has been committed yet', () => {
    const deltas = appearanceDelta([], [{ playerId: 'p1', count: 2, byKind: { SINGLES: 2 } }]);
    expect(deltas).toEqual([{ playerId: 'p1', count: 2, byKind: { SINGLES: 2 } }]);
  });

  it('is empty when nothing changed', () => {
    const records = [{ playerId: 'p1', count: 2, byKind: { SINGLES: 2 } }];
    expect(appearanceDelta(records, records)).toEqual([]);
  });

  it('is negative for a player who dropped out', () => {
    const deltas = appearanceDelta(
      [{ playerId: 'p1', count: 2, byKind: { SINGLES: 2 } }],
      [],
    );
    expect(deltas).toEqual([{ playerId: 'p1', count: -2, byKind: { SINGLES: -2 } }]);
  });

  it('nets out per player and per kind', () => {
    const deltas = appearanceDelta(
      [
        { playerId: 'p1', count: 3, byKind: { SINGLES: 2, DOUBLES: 1 } },
        { playerId: 'p2', count: 1, byKind: { SINGLES: 1 } },
      ],
      [
        { playerId: 'p1', count: 2, byKind: { SINGLES: 1, DOUBLES: 1 } },
        { playerId: 'p3', count: 2, byKind: { TRIOS: 2 } },
      ],
    );
    expect(deltas).toEqual([
      { playerId: 'p1', count: -1, byKind: { SINGLES: -1 } },
      { playerId: 'p2', count: -1, byKind: { SINGLES: -1 } },
      { playerId: 'p3', count: 2, byKind: { TRIOS: 2 } },
    ]);
  });
});

describe('planSeasonCommit (追加要件 §11, §12)', () => {
  it('adds the appearances on the first commit', () => {
    const players = roster();
    const version = syntheticVersion(1, [
      { playerId: 'p1', count: 2 },
      { playerId: 'p2', count: 1 },
    ]);
    const plan = planSeasonCommit(ORDER_ID, TEAM_ID, version, null, players, 500);

    expect(plan.noop).toBe(false);
    const after = applied(players, plan.updatedPlayers);
    expect(after.find((entry) => entry.id === 'p1')!.seasonAppearances).toBe(2);
    expect(after.find((entry) => entry.id === 'p2')!.seasonAppearances).toBe(1);
    expect(after.find((entry) => entry.id === 'p3')!.seasonAppearances).toBe(0);
    expect(plan.commit).toMatchObject({ id: ORDER_ID, committedVersion: 1, committedAt: 500 });
  });

  it('is idempotent: committing the same version twice adds nothing (追加要件 §16)', () => {
    let players = roster();
    const version = syntheticVersion(1, [
      { playerId: 'p1', count: 2 },
      { playerId: 'p2', count: 1 },
    ]);

    const first = planSeasonCommit(ORDER_ID, TEAM_ID, version, null, players, 500);
    players = applied(players, first.updatedPlayers);

    const second = planSeasonCommit(ORDER_ID, TEAM_ID, version, first.commit, players, 600);
    expect(second.noop).toBe(true);
    expect(second.deltas).toEqual([]);
    expect(second.updatedPlayers).toEqual([]);

    players = applied(players, second.updatedPlayers);
    expect(players.find((entry) => entry.id === 'p1')!.seasonAppearances).toBe(2);
    expect(players.find((entry) => entry.id === 'p2')!.seasonAppearances).toBe(1);
  });

  it('committing ten times is the same as committing once', () => {
    let players = roster();
    const version = syntheticVersion(1, [{ playerId: 'p1', count: 3 }]);
    let commit: SeasonCommit | null = null;
    for (let i = 0; i < 10; i += 1) {
      const plan = planSeasonCommit(ORDER_ID, TEAM_ID, version, commit, players, 500 + i);
      players = applied(players, plan.updatedPlayers);
      commit = plan.commit;
    }
    expect(players.find((entry) => entry.id === 'p1')!.seasonAppearances).toBe(3);
  });

  it('respects totals the players already had', () => {
    const players = roster({ p1: 7, p2: 4 });
    const version = syntheticVersion(1, [{ playerId: 'p1', count: 2 }]);
    const plan = planSeasonCommit(ORDER_ID, TEAM_ID, version, null, players, 500);
    const after = applied(players, plan.updatedPlayers);
    expect(after.find((entry) => entry.id === 'p1')!.seasonAppearances).toBe(9);
    expect(after.find((entry) => entry.id === 'p2')!.seasonAppearances).toBe(4);
  });

  it('accumulates per-kind counts too', () => {
    const players = roster();
    const version = syntheticVersion(1, [
      { playerId: 'p1', count: 3, byKind: { SINGLES: 1, DOUBLES: 2 } },
    ]);
    const plan = planSeasonCommit(ORDER_ID, TEAM_ID, version, null, players, 500);
    const after = applied(players, plan.updatedPlayers);
    expect(after.find((entry) => entry.id === 'p1')!.seasonAppearancesByKind).toEqual({
      SINGLES: 1,
      DOUBLES: 2,
    });
  });
});

describe('the v1 → v2 invariant (追加要件 §13, §16)', () => {
  it('committing v1 then v2 equals committing v2 alone', () => {
    const v1 = syntheticVersion(1, [
      { playerId: 'p1', count: 2, byKind: { SINGLES: 2 } },
      { playerId: 'p2', count: 2, byKind: { DOUBLES: 2 } },
    ]);
    const v2 = syntheticVersion(2, [
      { playerId: 'p1', count: 1, byKind: { SINGLES: 1 } },
      { playerId: 'p3', count: 3, byKind: { TRIOS: 3 } },
    ]);

    // Path A: commit v1, then re-commit at v2.
    let sequential = roster({ p1: 5, p2: 1, p3: 0 });
    const first = planSeasonCommit(ORDER_ID, TEAM_ID, v1, null, sequential, 100);
    sequential = applied(sequential, first.updatedPlayers);
    const second = planSeasonCommit(ORDER_ID, TEAM_ID, v2, first.commit, sequential, 200);
    sequential = applied(sequential, second.updatedPlayers);

    // Path B: commit v2 once, from the same starting totals.
    let direct = roster({ p1: 5, p2: 1, p3: 0 });
    const only = planSeasonCommit(ORDER_ID, TEAM_ID, v2, null, direct, 300);
    direct = applied(direct, only.updatedPlayers);

    const totals = (list: Player[]) =>
      Object.fromEntries(list.map((entry) => [entry.id, entry.seasonAppearances]));
    const kinds = (list: Player[]) =>
      Object.fromEntries(list.map((entry) => [entry.id, entry.seasonAppearancesByKind]));

    expect(totals(sequential)).toEqual(totals(direct));
    expect(kinds(sequential)).toEqual(kinds(direct));
    // And the numbers are the ones v2 alone implies.
    expect(totals(sequential)).toEqual({ p1: 6, p2: 1, p3: 3 });
  });

  it('holds across a three-version chain', () => {
    const versions = [
      syntheticVersion(1, [{ playerId: 'p1', count: 4 }, { playerId: 'p2', count: 1 }]),
      syntheticVersion(2, [{ playerId: 'p1', count: 2 }, { playerId: 'p3', count: 2 }]),
      syntheticVersion(3, [{ playerId: 'p2', count: 3 }]),
    ];

    let sequential = roster({ p1: 2, p2: 2, p3: 2 });
    let commit: SeasonCommit | null = null;
    for (const version of versions) {
      const plan = planSeasonCommit(ORDER_ID, TEAM_ID, version, commit, sequential, version.finalizedAt);
      sequential = applied(sequential, plan.updatedPlayers);
      commit = plan.commit;
    }

    let direct = roster({ p1: 2, p2: 2, p3: 2 });
    const only = planSeasonCommit(ORDER_ID, TEAM_ID, versions[2], null, direct, 9000);
    direct = applied(direct, only.updatedPlayers);

    expect(sequential.map((entry) => entry.seasonAppearances)).toEqual(
      direct.map((entry) => entry.seasonAppearances),
    );
    expect(Object.fromEntries(sequential.map((e) => [e.id, e.seasonAppearances]))).toEqual({
      p1: 2,
      p2: 5,
      p3: 2,
    });
  });

  it('holds for real generated orders too', () => {
    const base = sampleRoster();
    const v1 = versionFor(base, [], 0);

    // Someone drops out; the order is regenerated and re-finalized.
    const reduced = base.filter((entry) => entry.id !== 'p5');
    const inputB = orderInput(reduced, sampleFormatGames());
    const resultB = generateOrder(inputB);
    if (!resultB.ok) throw new Error('fixture should be satisfiable');
    const v2 = createVersion(inputB, resultB.candidates[0], MATCH, [v1], 2000);

    let sequential = sampleRoster();
    const first = planSeasonCommit(ORDER_ID, TEAM_ID, v1, null, sequential, 100);
    sequential = applied(sequential, first.updatedPlayers);
    const second = planSeasonCommit(ORDER_ID, TEAM_ID, v2, first.commit, sequential, 200);
    sequential = applied(sequential, second.updatedPlayers);

    let direct = sampleRoster();
    const only = planSeasonCommit(ORDER_ID, TEAM_ID, v2, null, direct, 300);
    direct = applied(direct, only.updatedPlayers);

    expect(sequential.map((entry) => entry.seasonAppearances)).toEqual(
      direct.map((entry) => entry.seasonAppearances),
    );
    // p5 was committed under v1 and must have been rolled back out.
    expect(sequential.find((entry) => entry.id === 'p5')!.seasonAppearances).toBe(0);
  });
});

describe('planSeasonWithdrawal', () => {
  it('restores the totals the players had before the commit', () => {
    let players = roster({ p1: 3, p2: 1 });
    const before = players.map((entry) => entry.seasonAppearances);
    const version = syntheticVersion(1, [
      { playerId: 'p1', count: 2 },
      { playerId: 'p2', count: 1 },
    ]);

    const commit = planSeasonCommit(ORDER_ID, TEAM_ID, version, null, players, 100);
    players = applied(players, commit.updatedPlayers);
    expect(players.map((entry) => entry.seasonAppearances)).toEqual([5, 2, 0]);

    const withdrawal = planSeasonWithdrawal(commit.commit!, players);
    players = applied(players, withdrawal.updatedPlayers);
    expect(players.map((entry) => entry.seasonAppearances)).toEqual(before);
    expect(withdrawal.commit).toBeNull();
  });

  it('clamps at zero and reports when totals were edited down by hand', () => {
    let players = roster({ p1: 0 });
    const commit: SeasonCommit = {
      id: ORDER_ID,
      teamId: TEAM_ID,
      committedVersion: 1,
      committedAt: 1,
      appearances: [{ playerId: 'p1', count: 2, byKind: { SINGLES: 2 } }],
    };
    const plan = planSeasonWithdrawal(commit, players);
    players = applied(players, plan.updatedPlayers);
    expect(players.find((entry) => entry.id === 'p1')!.seasonAppearances).toBe(0);
    expect(plan.clamped).toContain('p1');
  });
});

describe('seasonCommitStatus', () => {
  it('reports none, current and outdated', () => {
    expect(seasonCommitStatus(null, 1)).toBe('none');
    const commit: SeasonCommit = {
      id: ORDER_ID,
      teamId: TEAM_ID,
      committedVersion: 1,
      committedAt: 1,
      appearances: [],
    };
    expect(seasonCommitStatus(commit, 1)).toBe('current');
    expect(seasonCommitStatus(commit, 2)).toBe('outdated');
  });
});

describe('deleted players', () => {
  it('skips a player who is no longer on the roster without corrupting the rest', () => {
    const players = roster();
    const version = syntheticVersion(1, [
      { playerId: 'p1', count: 2 },
      { playerId: 'ghost', count: 5 },
    ]);
    const plan = planSeasonCommit(ORDER_ID, TEAM_ID, version, null, players, 100);
    const after = applied(players, plan.updatedPlayers);
    expect(after.find((entry) => entry.id === 'p1')!.seasonAppearances).toBe(2);
    expect(plan.updatedPlayers.some((entry) => entry.id === 'ghost')).toBe(false);
  });
});
