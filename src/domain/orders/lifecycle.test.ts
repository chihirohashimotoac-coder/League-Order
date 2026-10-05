import { describe, expect, it } from 'vitest';
import {
  createVersion,
  deriveOrderState,
  diffOrders,
  diffVersionWithCurrent,
  diffVersions,
  latestVersion,
  nextVersionNumber,
  orderFingerprint,
} from './lifecycle';
import { generateOrder } from '../../optimizer/generateOrder';
import { games, orderInput, player, sampleFormatGames, sampleRoster } from '../../test/factories';
import type { MatchInfo, OrderInput, OrderSolution } from '../types';

const MATCH: MatchInfo = {
  leagueName: '秋季リーグ',
  teamName: 'kalavinka',
  opponentName: 'Team B',
  matchDate: '2026-10-08',
};

function build(roster = sampleRoster(), gameDefs = sampleFormatGames()): {
  input: OrderInput;
  solution: OrderSolution;
} {
  const input = orderInput(roster, gameDefs);
  const result = generateOrder(input);
  if (!result.ok) throw new Error('fixture should be satisfiable');
  return { input, solution: result.candidates[0] };
}

describe('orderFingerprint', () => {
  it('is stable for identical content', () => {
    const { input, solution } = build();
    expect(orderFingerprint(input.games, solution.assignments, MATCH)).toBe(
      orderFingerprint(input.games, solution.assignments, MATCH),
    );
  });

  it('changes when a player in a game changes', () => {
    const { input, solution } = build();
    const before = orderFingerprint(input.games, solution.assignments, MATCH);
    const edited = solution.assignments.map((entry, index) =>
      index === 0 ? { ...entry, playerIds: ['p5'] } : entry,
    );
    expect(orderFingerprint(input.games, edited, MATCH)).not.toBe(before);
  });

  it('changes when two players swap slots inside a game', () => {
    const { input, solution } = build();
    const doubles = solution.assignments.find((entry) => entry.playerIds.length === 2)!;
    const swapped = solution.assignments.map((entry) =>
      entry.gameId === doubles.gameId
        ? { ...entry, playerIds: [...entry.playerIds].reverse() }
        : entry,
    );
    expect(orderFingerprint(input.games, swapped, MATCH)).not.toBe(
      orderFingerprint(input.games, solution.assignments, MATCH),
    );
  });

  it('changes when the match header changes', () => {
    const { input, solution } = build();
    const before = orderFingerprint(input.games, solution.assignments, MATCH);
    expect(orderFingerprint(input.games, solution.assignments, { ...MATCH, opponentName: 'Team C' })).not.toBe(before);
    expect(orderFingerprint(input.games, solution.assignments, { ...MATCH, matchDate: '2026-10-09' })).not.toBe(before);
  });

  it('changes when a game is renamed or the format changes', () => {
    const { input, solution } = build();
    const before = orderFingerprint(input.games, solution.assignments, MATCH);
    const renamed = input.games.map((game, index) =>
      index === 0 ? { ...game, name: '別の名前' } : game,
    );
    expect(orderFingerprint(renamed, solution.assignments, MATCH)).not.toBe(before);
  });

  it('ignores a difference that nothing shared would show', () => {
    // Trailing whitespace in the match header is not a change the team can perceive.
    const { input, solution } = build();
    expect(orderFingerprint(input.games, solution.assignments, { ...MATCH, teamName: ' kalavinka ' })).toBe(
      orderFingerprint(input.games, solution.assignments, MATCH),
    );
  });
});

describe('deriveOrderState (追加要件 §2, §8)', () => {
  it('is DRAFT before anything is finalized', () => {
    expect(deriveOrderState([], 'anything')).toBe('DRAFT');
  });

  it('is FINALIZED while the working copy matches the latest version', () => {
    const { input, solution } = build();
    const version = createVersion(input, solution, MATCH, [], 1000);
    expect(deriveOrderState([version], version.fingerprint)).toBe('FINALIZED');
  });

  it('becomes UPDATED as soon as the content differs', () => {
    const { input, solution } = build();
    const version = createVersion(input, solution, MATCH, [], 1000);
    const edited = solution.assignments.map((entry, index) =>
      index === 0 ? { ...entry, playerIds: ['p5'] } : entry,
    );
    const fingerprint = orderFingerprint(input.games, edited, MATCH);
    expect(deriveOrderState([version], fingerprint)).toBe('UPDATED');
  });

  it('returns to FINALIZED when the change is undone', () => {
    const { input, solution } = build();
    const version = createVersion(input, solution, MATCH, [], 1000);
    const edited = orderFingerprint(
      input.games,
      solution.assignments.map((entry, index) => (index === 0 ? { ...entry, playerIds: ['p5'] } : entry)),
      MATCH,
    );
    expect(deriveOrderState([version], edited)).toBe('UPDATED');
    expect(deriveOrderState([version], version.fingerprint)).toBe('FINALIZED');
  });

  it('compares against the newest version, not the first', () => {
    const { input, solution } = build();
    const v1 = createVersion(input, solution, MATCH, [], 1000);
    const changed = {
      ...solution,
      assignments: solution.assignments.map((entry, index) =>
        index === 0 ? { ...entry, playerIds: ['p5'] } : entry,
      ),
    };
    const v2 = createVersion(input, changed, MATCH, [v1], 2000);
    expect(deriveOrderState([v1, v2], v2.fingerprint)).toBe('FINALIZED');
    expect(deriveOrderState([v1, v2], v1.fingerprint)).toBe('UPDATED');
  });
});

describe('versioning (追加要件 §4)', () => {
  it('numbers finalizations v1, v2, v3', () => {
    const { input, solution } = build();
    expect(nextVersionNumber([])).toBe(1);
    const v1 = createVersion(input, solution, MATCH, [], 1000);
    expect(v1.version).toBe(1);
    const v2 = createVersion(input, solution, MATCH, [v1], 2000);
    expect(v2.version).toBe(2);
    const v3 = createVersion(input, solution, MATCH, [v1, v2], 3000);
    expect(v3.version).toBe(3);
    expect(latestVersion([v1, v2, v3])?.version).toBe(3);
  });

  it('records the finalization time, label and appearances', () => {
    const { input, solution } = build();
    const version = createVersion(input, solution, MATCH, [], 1234);
    expect(version.finalizedAt).toBe(1234);
    expect(version.label).toBe(solution.meta.label);
    const total = version.appearances.reduce((acc, entry) => acc + entry.count, 0);
    expect(total).toBe(10);
  });
});

describe('immutable snapshots (追加要件 §5, §16)', () => {
  it('is unaffected by a later player rename', () => {
    const roster = sampleRoster();
    const { input, solution } = build(roster);
    const version = createVersion(input, solution, MATCH, [], 1000);
    const originalNames = version.players.map((entry) => entry.name);

    // The live roster is renamed afterwards.
    roster[0].name = '改名後';
    input.players[0].name = '改名後';

    expect(version.players.map((entry) => entry.name)).toEqual(originalNames);
    expect(version.players[0].name).not.toBe('改名後');
  });

  it('is unaffected by a later format edit', () => {
    const gameDefs = sampleFormatGames();
    const { input, solution } = build(sampleRoster(), gameDefs);
    const version = createVersion(input, solution, MATCH, [], 1000);
    const snapshotNames = version.games.map((game) => game.name);

    gameDefs[0].name = '改名ゲーム';
    gameDefs.push({ id: 'g99', order: 99, name: '追加', kinds: ['SINGLES'], playerCount: 1 });
    input.games[0].name = '改名ゲーム';

    expect(version.games.map((game) => game.name)).toEqual(snapshotNames);
    expect(version.games).toHaveLength(6);
  });

  it('is unaffected by a later match-info edit', () => {
    const { input, solution } = build();
    const match = { ...MATCH };
    const version = createVersion(input, solution, match, [], 1000);
    match.opponentName = '別チーム';
    expect(version.match.opponentName).toBe('Team B');
  });

  it('does not share mutable arrays with the live input', () => {
    const { input, solution } = build();
    const version = createVersion(input, solution, MATCH, [], 1000);
    solution.assignments[0].playerIds.push('p5');
    expect(version.assignments[0].playerIds).not.toContain('p5');
  });
});

describe('diffOrders (追加要件 §9)', () => {
  const roster = sampleRoster();
  const gameDefs = sampleFormatGames();

  it('reports no change for identical orders', () => {
    const { input, solution } = build(roster, gameDefs);
    const side = { games: input.games, assignments: solution.assignments, players: roster };
    const diff = diffOrders(side, side);
    expect(diff.changed).toBe(false);
    expect(diff.changes).toHaveLength(0);
    expect(diff.rows).toHaveLength(6);
    expect(diff.rows.every((row) => row.kind === 'unchanged')).toBe(true);
  });

  it('reports the before and after players of a changed game', () => {
    const { input, solution } = build(roster, gameDefs);
    const target = solution.assignments.find((entry) => entry.playerIds.length === 2)!;
    const replacement = roster.find((entry) => !target.playerIds.includes(entry.id))!;
    const after = solution.assignments.map((entry) =>
      entry.gameId === target.gameId
        ? { ...entry, playerIds: [entry.playerIds[0], replacement.id] }
        : entry,
    );

    const diff = diffOrders(
      { games: input.games, assignments: solution.assignments, players: roster },
      { games: input.games, assignments: after, players: roster },
    );

    expect(diff.changed).toBe(true);
    expect(diff.changes).toHaveLength(1);
    const [row] = diff.changes;
    expect(row.gameId).toBe(target.gameId);
    expect(row.kind).toBe('changed');
    expect(row.beforePlayerIds).toEqual(target.playerIds);
    expect(row.afterPlayerIds[1]).toBe(replacement.id);
    expect(row.afterNames[1]).toBe(replacement.name);
  });

  it('detects games added to and removed from the format', () => {
    const { input, solution } = build(roster, gameDefs);
    const shorter = input.games.slice(0, 5);
    const shorterAssignments = solution.assignments.filter((entry) =>
      shorter.some((game) => game.id === entry.gameId),
    );

    const removed = diffOrders(
      { games: input.games, assignments: solution.assignments, players: roster },
      { games: shorter, assignments: shorterAssignments, players: roster },
    );
    expect(removed.changes.filter((row) => row.kind === 'removed')).toHaveLength(1);

    const added = diffOrders(
      { games: shorter, assignments: shorterAssignments, players: roster },
      { games: input.games, assignments: solution.assignments, players: roster },
    );
    expect(added.changes.filter((row) => row.kind === 'added')).toHaveLength(1);
  });

  it('keeps each side’s own names, so a rename cannot rewrite history', () => {
    const { input, solution } = build(roster, gameDefs);
    const v1 = createVersion(input, solution, MATCH, [], 1000);

    const renamed = roster.map((entry) =>
      entry.id === 'p1' ? { ...entry, name: '新しい名前' } : entry,
    );
    const diff = diffVersionWithCurrent(v1, {
      games: input.games,
      assignments: solution.assignments.map((entry, index) =>
        index === 0 ? { ...entry, playerIds: ['p5'] } : entry,
      ),
      players: renamed,
    });

    const row = diff.changes[0];
    // The old side shows the name it was finalized under.
    expect(row.beforeNames[0]).toBe('Aoki');
  });

  it('diffs two stored versions', () => {
    const { input, solution } = build(roster, gameDefs);
    const v1 = createVersion(input, solution, MATCH, [], 1000);
    const changed: OrderSolution = {
      ...solution,
      assignments: solution.assignments.map((entry, index) =>
        index === 0 ? { ...entry, playerIds: ['p5'] } : entry,
      ),
    };
    const v2 = createVersion(input, changed, MATCH, [v1], 2000);
    const diff = diffVersions(v1, v2);
    expect(diff.changed).toBe(true);
    expect(diff.changes).toHaveLength(1);
    expect(diff.changes[0].afterPlayerIds).toEqual(['p5']);
  });

  it('orders rows by game order', () => {
    const roster2 = sampleRoster();
    const defs = games([
      { id: 'a', name: 'A', kinds: ['SINGLES'], playerCount: 1 },
      { id: 'b', name: 'B', kinds: ['SINGLES'], playerCount: 1 },
      { id: 'c', name: 'C', kinds: ['SINGLES'], playerCount: 1 },
    ]);
    const { input, solution } = build(roster2, defs);
    const diff = diffOrders(
      { games: input.games, assignments: solution.assignments, players: roster2 },
      { games: input.games, assignments: solution.assignments, players: roster2 },
    );
    expect(diff.rows.map((row) => row.order)).toEqual([1, 2, 3]);
  });

  it('handles a player who no longer exists in the roster', () => {
    const { input, solution } = build(roster, gameDefs);
    const v1 = createVersion(input, solution, MATCH, [], 1000);
    const reduced = roster.filter((entry) => entry.id !== 'p1');
    const diff = diffVersionWithCurrent(v1, {
      games: input.games,
      assignments: solution.assignments,
      players: reduced,
    });
    // Falls back to the id rather than crashing, and the old side still has the name.
    expect(diff.rows[0].beforeNames[0]).toBe('Aoki');
  });
});

describe('player snapshot independence', () => {
  it('keeps a version readable after the player is deleted', () => {
    const roster = [
      player({ id: 'p1', name: '消える人', rating: 10 }),
      player({ id: 'p2', name: '残る人', rating: 10 }),
    ];
    const defs = games([
      { id: 'g1', name: 'S1', kinds: ['SINGLES'], playerCount: 1 },
      { id: 'g2', name: 'S2', kinds: ['SINGLES'], playerCount: 1 },
    ]);
    const { input, solution } = build(roster, defs);
    const version = createVersion(input, solution, MATCH, [], 1000);
    expect(version.players.map((entry) => entry.name)).toContain('消える人');
  });
});
