import { useCallback, useMemo } from 'react';
import type { Team } from '../domain/types';
import { createId } from '../utils/id';
import type {
  LeagueBrowse,
  LinkedResolution,
  N01ProgressListener,
  N01SyncPlan,
  N01TeamData,
  N01TeamSelection,
} from '../integrations/n01/sync';
import { browseLeague, fetchTeamData, planN01Sync, resolveLinkedTeam } from '../integrations/n01/sync';
import type { N01LeagueSummary } from '../integrations/n01/types';
import { useAppStore } from './appStore';
import { useN01Environment } from './n01Environment';

/**
 * n01 sync actions for the screens (docs/N01_MASTER_DESIGN.md §4.1).
 *
 * Fetching and planning are separate: a screen fetches once, then re-plans as often as
 * it likes (e.g. while the captain maps players), and nothing is written until it calls
 * `apply`, which stores the plan through the app store in one batch.
 */
export interface N01SyncActions {
  searchLeagues(query: string): Promise<N01LeagueSummary[]>;
  browse(leagueId: string, fallbackTitle?: string, onProgress?: N01ProgressListener): Promise<LeagueBrowse>;
  fetch(selection: N01TeamSelection, onProgress?: N01ProgressListener): Promise<N01TeamData>;
  /** Re-resolves a linked team (season, tpid) on n01. */
  resolve(team: Team, onProgress?: N01ProgressListener): Promise<LinkedResolution>;
  /** Plans a fetch against a team (pure; nothing is written). */
  plan(team: Team, data: N01TeamData, explicit?: ReadonlyMap<string, string | null>): N01SyncPlan;
  /** A brand-new League Order team for an n01 team, named as on n01. */
  newTeam(data: N01TeamData): Team;
  /** Stores a plan (team, players, managed format, cache) as one batch. */
  apply(plan: N01SyncPlan, options?: { activate?: boolean }): Promise<void>;
}

export function useN01Sync(): N01SyncActions {
  const store = useAppStore();
  const env = useN01Environment();

  const plan = useCallback(
    (team: Team, data: N01TeamData, explicit?: ReadonlyMap<string, string | null>): N01SyncPlan => {
      const existingFormatId = team.n01?.managedFormatId ?? null;
      return planN01Sync({
        team,
        localPlayers: store.players.filter((player) => player.teamId === team.id),
        existingFormat: store.formats.find((format) => format.id === existingFormatId) ?? null,
        data,
        now: env.now(),
        newId: createId,
        explicit,
      });
    },
    [env, store.players, store.formats],
  );

  const { applyN01Sync } = store;

  return useMemo(
    () => ({
      searchLeagues: (query) => env.createClient().searchLeagues(query),
      browse: (leagueId, fallbackTitle, onProgress) =>
        browseLeague(env.createClient(), leagueId, fallbackTitle, onProgress),
      fetch: (selection, onProgress) => fetchTeamData(env.createClient(), selection, env.now, onProgress),
      resolve: (team, onProgress) => {
        if (!team.n01) return Promise.reject(new Error('team is not linked to n01'));
        return resolveLinkedTeam(env.createClient(), team.n01, onProgress);
      },
      plan,
      newTeam: (data) => ({ id: createId('team'), name: data.entry.name, createdAt: env.now() }),
      apply: (result, options) =>
        applyN01Sync({ team: result.team, players: result.players, format: result.format, cache: [result.snapshot] }, options),
    }),
    [env, plan, applyN01Sync],
  );
}
