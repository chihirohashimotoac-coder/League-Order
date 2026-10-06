import type {
  AppearanceRecord,
  GameAssignment,
  GameId,
  GameSlotDef,
  MatchInfo,
  OrderInput,
  OrderLifecycleState,
  OrderSolution,
  OrderVersion,
  Player,
  PlayerId,
  PlayerTally,
} from '../types';
import { sortedGames } from '../games/format';
import { asDiscipline } from '../types';

/**
 * Order lifecycle: finalization, versioning and change detection (追加要件 §2–§5, §8, §9).
 *
 * Pure and free of any optimizer dependency. The optimizer produces an order; this
 * module decides whether that order is a draft, has been finalized, or has drifted away
 * from what the team was last shown — and freezes each finalization so it can never be
 * rewritten by a later roster or format edit.
 */

// ---------------------------------------------------------------------------
// Fingerprint
// ---------------------------------------------------------------------------

/**
 * Canonical digest of everything a shared order shows.
 *
 * Deliberately covers the assignments, the game definitions and the match header, and
 * deliberately NOT the locks or the participant restrictions: the state exists to warn
 * that *what the team can see* has changed. Pinning a slot the optimizer already chose,
 * or tightening a constraint that changes nothing, leaves every shared image and message
 * correct, so it must not raise a "re-confirm" flag the captain would learn to ignore.
 */
export function orderFingerprint(
  games: readonly GameSlotDef[],
  assignments: readonly GameAssignment[],
  match: MatchInfo,
): string {
  const ordered = sortedGames(games);
  const byGame = new Map(assignments.map((entry) => [entry.gameId, entry]));

  const gamePart = ordered
    .map((game) => {
      const players = byGame.get(game.id)?.playerIds ?? [];
      return [
        game.id,
        game.order,
        game.name,
        [...game.kinds].sort().join('+'),
        game.playerCount,
        players.join('.'),
      ].join('~');
    })
    .join('|');

  const matchPart = [
    match.leagueName.trim(),
    match.teamName.trim(),
    match.opponentName.trim(),
    match.matchDate.trim(),
  ].join('~');

  return `g:${gamePart}#m:${matchPart}`;
}

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

/**
 * Derives the lifecycle state. The only three outcomes, with no hidden flag:
 *
 * - no finalized version at all → `DRAFT`
 * - the working copy matches the latest version → `FINALIZED`
 * - anything else → `UPDATED`
 */
export function deriveOrderState(
  versions: readonly OrderVersion[],
  currentFingerprint: string | null,
): OrderLifecycleState {
  const latest = latestVersion(versions);
  if (!latest) return 'DRAFT';
  if (currentFingerprint === null) return 'FINALIZED';
  return latest.fingerprint === currentFingerprint ? 'FINALIZED' : 'UPDATED';
}

export function latestVersion(versions: readonly OrderVersion[]): OrderVersion | null {
  return versions.length === 0 ? null : versions[versions.length - 1];
}

export function versionByNumber(
  versions: readonly OrderVersion[],
  version: number,
): OrderVersion | null {
  return versions.find((entry) => entry.version === version) ?? null;
}

/** The version number the next finalization will produce. */
export function nextVersionNumber(versions: readonly OrderVersion[]): number {
  return (latestVersion(versions)?.version ?? 0) + 1;
}

// ---------------------------------------------------------------------------
// Finalization
// ---------------------------------------------------------------------------

export function appearancesFromTallies(tallies: readonly PlayerTally[]): AppearanceRecord[] {
  return tallies
    .filter((tally) => tally.count > 0)
    .map((tally) => ({
      playerId: tally.playerId,
      count: tally.count,
      byKind: { ...tally.countByKind },
    }))
    .sort((a, b) => (a.playerId < b.playerId ? -1 : a.playerId > b.playerId ? 1 : 0));
}

/**
 * Builds the immutable snapshot for a finalization.
 *
 * Everything is deep-copied. A version must stay readable and shareable years later,
 * after players have been renamed or removed and the format has been rewritten
 * (追加要件 §5).
 */
export function createVersion(
  input: OrderInput,
  solution: OrderSolution,
  match: MatchInfo,
  versions: readonly OrderVersion[],
  finalizedAt: number,
): OrderVersion {
  const games = sortedGames(input.games).map((game) => ({ ...game, kinds: [...game.kinds] }));
  const assignments = solution.assignments.map((entry) => ({
    gameId: entry.gameId,
    playerIds: [...entry.playerIds],
  }));

  return {
    version: nextVersionNumber(versions),
    finalizedAt,
    fingerprint: orderFingerprint(games, assignments, match),
    assignments,
    games,
    players: input.players.map((player) => clonePlayer(player)),
    participants: input.participants.map((config) => ({
      ...config,
      excludedGameIds: [...config.excludedGameIds],
      excludedKinds: [...config.excludedKinds],
      window: config.window ? { ...config.window } : undefined,
    })),
    match: { ...match },
    tallies: solution.tallies.map((tally) => ({ ...tally, countByKind: { ...tally.countByKind } })),
    appearances: appearancesFromTallies(solution.tallies),
    label: solution.meta.label,
    hasImputedRating: solution.metrics.hasImputedRating,
    // What "strong" meant when this version was generated (soft / steel).
    discipline: asDiscipline(input.discipline),
  };
}

function clonePlayer(player: Player): Player {
  return {
    ...player,
    skills: { ...player.skills },
    seasonAppearancesByKind: { ...player.seasonAppearancesByKind },
  };
}

// ---------------------------------------------------------------------------
// Diff
// ---------------------------------------------------------------------------

export type GameChangeKind = 'unchanged' | 'changed' | 'added' | 'removed';

export interface GameDiffRow {
  gameId: GameId;
  order: number;
  gameName: string;
  kind: GameChangeKind;
  beforePlayerIds: PlayerId[];
  afterPlayerIds: PlayerId[];
  beforeNames: string[];
  afterNames: string[];
}

export interface OrderDiff {
  rows: GameDiffRow[];
  /** Only the rows that actually differ. */
  changes: GameDiffRow[];
  changed: boolean;
}

export interface DiffSide {
  games: readonly GameSlotDef[];
  assignments: readonly GameAssignment[];
  players: readonly Player[];
}

function nameLookup(players: readonly Player[]): (id: PlayerId) => string {
  const map = new Map(players.map((player) => [player.id, player.name]));
  return (id) => (id ? (map.get(id) ?? id) : '(空席)');
}

/**
 * Game-by-game diff between two orders (追加要件 §9).
 *
 * Player lists are compared in slot order, not as sets: a swap between the first and
 * second slot changes what the shared image reads, so it counts as a change.
 *
 * Names are resolved from each side's own player snapshot, so an old version keeps
 * showing the name it was shared under even if the player has since been renamed.
 */
export function diffOrders(before: DiffSide, after: DiffSide): OrderDiff {
  const beforeName = nameLookup(before.players);
  const afterName = nameLookup(after.players);
  const beforeAssignments = new Map(before.assignments.map((entry) => [entry.gameId, entry]));
  const afterAssignments = new Map(after.assignments.map((entry) => [entry.gameId, entry]));

  const beforeGames = sortedGames(before.games);
  const afterGames = sortedGames(after.games);
  const afterIds = new Set(afterGames.map((game) => game.id));

  const rows: GameDiffRow[] = [];

  for (const game of afterGames) {
    const beforeIds = beforeAssignments.get(game.id)?.playerIds ?? null;
    const afterIds2 = afterAssignments.get(game.id)?.playerIds ?? [];
    const existedBefore = beforeGames.some((entry) => entry.id === game.id);

    const kind: GameChangeKind = !existedBefore
      ? 'added'
      : (beforeIds ?? []).join('.') === afterIds2.join('.')
        ? 'unchanged'
        : 'changed';

    rows.push({
      gameId: game.id,
      order: game.order,
      gameName: game.name,
      kind,
      beforePlayerIds: beforeIds ? [...beforeIds] : [],
      afterPlayerIds: [...afterIds2],
      beforeNames: (beforeIds ?? []).map(beforeName),
      afterNames: afterIds2.map(afterName),
    });
  }

  // Games that existed before and are gone now.
  for (const game of beforeGames) {
    if (afterIds.has(game.id)) continue;
    const beforeIds = beforeAssignments.get(game.id)?.playerIds ?? [];
    rows.push({
      gameId: game.id,
      order: game.order,
      gameName: game.name,
      kind: 'removed',
      beforePlayerIds: [...beforeIds],
      afterPlayerIds: [],
      beforeNames: beforeIds.map(beforeName),
      afterNames: [],
    });
  }

  rows.sort((a, b) => a.order - b.order || (a.gameId < b.gameId ? -1 : 1));
  const changes = rows.filter((row) => row.kind !== 'unchanged');
  return { rows, changes, changed: changes.length > 0 };
}

/** Convenience: diff a stored version against the current working order. */
export function diffVersionWithCurrent(
  version: OrderVersion,
  current: DiffSide,
): OrderDiff {
  return diffOrders(
    { games: version.games, assignments: version.assignments, players: version.players },
    current,
  );
}

/** Convenience: diff two stored versions. */
export function diffVersions(before: OrderVersion, after: OrderVersion): OrderDiff {
  return diffOrders(
    { games: before.games, assignments: before.assignments, players: before.players },
    { games: after.games, assignments: after.assignments, players: after.players },
  );
}
