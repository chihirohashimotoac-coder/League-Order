import { beforeEach, describe, expect, it } from 'vitest';
import 'fake-indexeddb/auto';
import { openBackend, resetBackendCache } from './db';
import { Repository, type Snapshot } from './repository';
import { parseBackup, serialiseBackup } from './backup';
import { buildSeed } from './seed';
import { planSeasonCommit, planSeasonWithdrawal } from '../domain/orders/seasonLedger';
import type { OrderVersion, Player, SavedOrder, SeasonCommit } from '../domain/types';

/**
 * Delete safety for season-committed orders (追加要件 §9–§12).
 *
 * ## The failure this guards against
 *
 * Season totals are the only numbers in this app that cannot be recomputed from
 * anything else: they are an accumulator, and the commit ledger is the sole record of
 * what each order contributed. Deleting an order together with its ledger entry
 * therefore does not undo its contribution — it strands it. The appearances stay in
 * every player's season total, nothing records where they came from, and withdrawing is
 * no longer possible because the entry that said how much to withdraw is gone.
 *
 * So the ledger entry is a lock. Deletion is refused while it exists, and withdrawing is
 * a separate step the captain has to ask for (追加要件 §11) — deletion never rolls
 * season totals back on its own.
 *
 * These tests drive the storage layer directly, so the invariant is asserted where it is
 * enforced rather than only through the UI; `e2e/lifecycle.spec.ts` covers the operator
 * flow, including the two-step withdraw-then-delete and the reload/import cases.
 */

async function freshRepository(): Promise<Repository> {
  resetBackendCache();
  const backend = await openBackend();
  await backend.clearAll();
  return new Repository(backend);
}

function versionOf(order: SavedOrder, playerIds: readonly string[]): OrderVersion {
  return {
    version: 1,
    finalizedAt: 1_000,
    fingerprint: 'fp-v1',
    assignments: order.solution.assignments,
    games: order.input.games,
    players: order.input.players,
    participants: order.input.participants,
    match: { leagueName: '', teamName: '', opponentName: '', matchDate: '' },
    tallies: [],
    appearances: playerIds.map((playerId) => ({ playerId, count: 2, byKind: { SINGLES: 1, G501: 1 } })),
    label: 'バランス',
    hasImputedRating: false,
  };
}

/** A seeded database with one saved order, plus helpers to read it back. */
async function seededWithOrder(): Promise<{
  repository: Repository;
  snapshot: Snapshot;
  order: SavedOrder;
  version: OrderVersion;
}> {
  const repository = await freshRepository();
  const seed = buildSeed();
  const order: SavedOrder = {
    id: 'ord_1',
    teamId: seed.teams[0].id,
    title: 'テスト戦',
    createdAt: 1,
    updatedAt: 1,
    input: {
      teamId: seed.teams[0].id,
      formatId: seed.formats[0].id,
      games: seed.formats[0].games,
      players: seed.players,
      participants: seed.players.map((player) => ({
        playerId: player.id,
        include: true,
        excludedGameIds: [],
        excludedKinds: [],
      })),
      pairs: [],
      locks: [],
      preset: 'BALANCED',
      weights: seed.settings.customWeights,
      settings: seed.settings.optimizer,
      discipline: 'UNSPECIFIED',
    },
    solution: {
      assignments: [],
      tallies: [],
      score: {
        strength: 0,
        gameFit: 0,
        pairFit: 0,
        fairness: 0,
        novelty: 0,
        consecutivePenalty: 0,
        seasonImbalance: 0,
        total: 0,
        display: 0,
      },
      metrics: {
        totalSlots: 10,
        participantCount: 5,
        appearanceSpread: 0,
        appearanceStdDev: 0,
        fairnessExcess: 0,
        maxConsecutive: 1,
        averageRating: null,
        hasImputedRating: false,
      },
      explanation: { games: [], overall: [] },
      warnings: [],
      meta: {
        stage: 'dfs',
        exhaustive: true,
        nodesVisited: 0,
        elapsedMs: 0,
        label: 'バランス',
        presetKey: 'BALANCED',
      },
    },
    versions: [],
    seasonApplied: false,
  };

  const snapshot: Snapshot = { ...seed, orders: [order] };
  await repository.replaceAll(snapshot);
  return {
    repository,
    snapshot,
    order,
    version: versionOf(order, seed.players.map((player) => player.id)),
  };
}

/** Commits a version through the real planner and persists the result. */
async function commit(
  repository: Repository,
  order: SavedOrder,
  version: OrderVersion,
  players: readonly Player[],
): Promise<{ players: Player[]; commit: SeasonCommit }> {
  const existing = (await repository.loadAll()).seasonCommits.find((entry) => entry.id === order.id) ?? null;
  const plan = planSeasonCommit(order.id, order.teamId, version, existing, players, 2_000);
  await repository.savePlayers(plan.updatedPlayers);
  await repository.saveSeasonCommit(plan.commit!);
  return { players: plan.updatedPlayers, commit: plan.commit! };
}

function totalsOf(players: readonly Player[]): Record<string, number> {
  return Object.fromEntries(players.map((player) => [player.id, player.seasonAppearances]));
}

describe('deleting a season-committed order (追加要件 §9–§12)', () => {
  let fixture: Awaited<ReturnType<typeof seededWithOrder>>;

  beforeEach(async () => {
    fixture = await seededWithOrder();
  });

  // Case A
  it('deletes an order that was never committed to the season', async () => {
    const outcome = await fixture.repository.deleteOrder(fixture.order.id);
    expect(outcome).toBe('deleted');

    const loaded = await fixture.repository.loadAll();
    expect(loaded.orders).toHaveLength(0);
  });

  // Case B
  it('refuses to delete an order whose season contribution is still counted', async () => {
    await commit(fixture.repository, fixture.order, fixture.version, fixture.snapshot.players);

    const outcome = await fixture.repository.deleteOrder(fixture.order.id);
    expect(outcome).toBe('blocked');

    const loaded = await fixture.repository.loadAll();
    expect(loaded.orders.map((order) => order.id)).toEqual([fixture.order.id]);
  });

  // Case C
  it('allows the delete once the season reflection has been withdrawn', async () => {
    const { players } = await commit(
      fixture.repository,
      fixture.order,
      fixture.version,
      fixture.snapshot.players,
    );
    expect(await fixture.repository.deleteOrder(fixture.order.id)).toBe('blocked');

    const ledger = (await fixture.repository.loadAll()).seasonCommits[0];
    const withdrawal = planSeasonWithdrawal(ledger, players);
    await fixture.repository.savePlayers(withdrawal.updatedPlayers);
    await fixture.repository.deleteSeasonCommit(fixture.order.id);

    expect(await fixture.repository.deleteOrder(fixture.order.id)).toBe('deleted');
    const loaded = await fixture.repository.loadAll();
    expect(loaded.orders).toHaveLength(0);
    expect(loaded.seasonCommits).toHaveLength(0);
    // And the totals are back where they started, not stranded.
    expect(totalsOf(loaded.players)).toEqual(totalsOf(fixture.snapshot.players));
  });

  // Case D
  it('leaves the season totals untouched when the delete is refused', async () => {
    await commit(fixture.repository, fixture.order, fixture.version, fixture.snapshot.players);
    const before = totalsOf((await fixture.repository.loadAll()).players);
    expect(Object.values(before).every((value) => value === 2)).toBe(true);

    await fixture.repository.deleteOrder(fixture.order.id);

    expect(totalsOf((await fixture.repository.loadAll()).players)).toEqual(before);
  });

  // Case E
  it('leaves the commit ledger untouched when the delete is refused', async () => {
    await commit(fixture.repository, fixture.order, fixture.version, fixture.snapshot.players);
    const before = (await fixture.repository.loadAll()).seasonCommits;

    await fixture.repository.deleteOrder(fixture.order.id);

    expect((await fixture.repository.loadAll()).seasonCommits).toEqual(before);
  });

  // Case F
  it('applies the same refusal after a reload', async () => {
    await commit(fixture.repository, fixture.order, fixture.version, fixture.snapshot.players);

    // A reload is a fresh Repository over the same stored data.
    resetBackendCache();
    const reopened = new Repository(await openBackend());
    expect((await reopened.loadAll()).seasonCommits).toHaveLength(1);
    expect(await reopened.deleteOrder(fixture.order.id)).toBe('blocked');
    expect((await reopened.loadAll()).orders).toHaveLength(1);
  });

  // Case G
  it('applies the same refusal to data restored from a JSON backup', async () => {
    await commit(fixture.repository, fixture.order, fixture.version, fixture.snapshot.players);
    const exported = serialiseBackup(await fixture.repository.loadAll());

    const parsed = parseBackup(exported);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    // The ledger has to survive the round-trip, otherwise the lock is lost on restore.
    expect(parsed.snapshot.seasonCommits).toHaveLength(1);
    expect(parsed.snapshot.seasonCommits[0].appearances).toHaveLength(5);

    const restored = await freshRepository();
    await restored.replaceAll(parsed.snapshot);

    expect(await restored.deleteOrder(fixture.order.id)).toBe('blocked');
    expect((await restored.loadAll()).orders).toHaveLength(1);
    expect(totalsOf((await restored.loadAll()).players)).toEqual(
      Object.fromEntries(fixture.snapshot.players.map((player) => [player.id, 2])),
    );
  });

  it('does not strand a contribution even if the order record is gone', async () => {
    // The guard's whole purpose: there is no reachable sequence that leaves a ledger
    // entry without its order, or a season total without a ledger entry explaining it.
    await commit(fixture.repository, fixture.order, fixture.version, fixture.snapshot.players);
    await fixture.repository.deleteOrder(fixture.order.id);

    const loaded = await fixture.repository.loadAll();
    const orderIds = new Set(loaded.orders.map((order) => order.id));
    for (const entry of loaded.seasonCommits) {
      expect(orderIds.has(entry.id)).toBe(true);
    }
    const committed = loaded.seasonCommits.flatMap((entry) => entry.appearances);
    const totalCommitted = committed.reduce((sum, record) => sum + record.count, 0);
    const totalCounted = loaded.players.reduce((sum, player) => sum + player.seasonAppearances, 0);
    expect(totalCounted).toBe(totalCommitted);
  });
});
