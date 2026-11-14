import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import 'fake-indexeddb/auto';
import { act, cleanup, render, waitFor } from '@testing-library/react';
import { AppStoreProvider, useAppStore, type AppStore } from './appStore';
import { openBackend, resetBackendCache } from '../storage/db';
import { Repository } from '../storage/repository';
import type { OrderVersion, SavedOrder } from '../domain/types';

/**
 * Season commits and withdrawals store first, then update the screen — and they run one
 * at a time, each planned from the totals the previous one stored. Two started at once
 * must not both start from the same totals (the second write would overwrite the first
 * one's appearances).
 */

beforeEach(async () => {
  resetBackendCache();
  await (await openBackend()).clearAll();
});

afterEach(() => {
  cleanup();
});

async function mountStore(): Promise<() => AppStore> {
  let current: AppStore | null = null;
  function Probe(): null {
    current = useAppStore();
    return null;
  }
  render(
    <AppStoreProvider>
      <Probe />
    </AppStoreProvider>,
  );
  await waitFor(() => expect(current?.ready).toBe(true));
  await act(async () => {
    await current!.loadSample();
  });
  return () => current!;
}

/** An order of the active team whose finalized version gives `playerId` two appearances. */
function orderWith(store: AppStore, id: string, playerId: string): { order: SavedOrder; version: OrderVersion } {
  const seed = { teams: store.teams, players: store.teamPlayers, formats: store.teamFormats, settings: store.settings };
  const teamId = store.activeTeamId!;
  const order: SavedOrder = {
    id,
    teamId,
    title: id,
    createdAt: 1,
    updatedAt: 1,
    input: {
      teamId,
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
  const version = {
    version: 1,
    players: order.input.players,
    appearances: [{ playerId, count: 2, byKind: { SINGLES: 2 } }],
  } as unknown as OrderVersion;
  return { order: { ...order, versions: [version] }, version };
}

describe('season commits run one at a time', () => {
  it('two orders committed without waiting both count: neither overwrites the other', async () => {
    const store = await mountStore();
    const player = store().teamPlayers[0];
    const before = player.seasonAppearances;
    const a = orderWith(store(), 'ord_a', player.id);
    const b = orderWith(store(), 'ord_b', player.id);

    let results: Awaited<ReturnType<AppStore['commitSeason']>>[] = [];
    await act(async () => {
      // Both started from the same render, before either is stored.
      const now = store();
      results = await Promise.all([now.commitSeason(a.order, a.version), now.commitSeason(b.order, b.version)]);
    });

    expect(results.map((result) => result.ok)).toEqual([true, true]);
    expect(store().players.find((entry) => entry.id === player.id)!.seasonAppearances).toBe(before + 4);
    const stored = await new Repository(await openBackend()).loadAll();
    expect(stored.players.find((entry) => entry.id === player.id)!.seasonAppearances).toBe(before + 4);
    expect(stored.seasonCommits.map((entry) => entry.id).sort()).toEqual(['ord_a', 'ord_b']);
  });

  it('a second tap on the same order finds it already reflected: no double counting', async () => {
    const store = await mountStore();
    const player = store().teamPlayers[0];
    const before = player.seasonAppearances;
    const a = orderWith(store(), 'ord_a', player.id);

    let results: Awaited<ReturnType<AppStore['commitSeason']>>[] = [];
    await act(async () => {
      const now = store();
      results = await Promise.all([now.commitSeason(a.order, a.version), now.commitSeason(a.order, a.version)]);
    });

    expect(results.map((result) => result.noop)).toEqual([false, true]);
    expect(store().players.find((entry) => entry.id === player.id)!.seasonAppearances).toBe(before + 2);
  });

  it('a withdrawal started right after its commit rolls back what the commit stored', async () => {
    const store = await mountStore();
    const player = store().teamPlayers[0];
    const before = player.seasonAppearances;
    const a = orderWith(store(), 'ord_a', player.id);

    await act(async () => {
      const now = store();
      await Promise.all([now.commitSeason(a.order, a.version), now.withdrawSeason(a.order.id)]);
    });

    expect(store().players.find((entry) => entry.id === player.id)!.seasonAppearances).toBe(before);
    const stored = await new Repository(await openBackend()).loadAll();
    expect(stored.seasonCommits).toHaveLength(0);
    expect(stored.players.find((entry) => entry.id === player.id)!.seasonAppearances).toBe(before);
  });
});
