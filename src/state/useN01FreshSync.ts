import { useCallback } from 'react';
import type { Team } from '../domain/types';
import type { N01MatchIntelligenceSnapshot } from '../domain/n01/intelligence';
import type { N01CacheRecord } from '../domain/n01/types';
import { N01Error, describeN01Error } from '../integrations/n01/client';
import type { N01ProgressListener, N01SyncPlan, N01TeamData, N01TeamSelection } from '../integrations/n01/sync';
import { useN01Sync } from './useN01Sync';

/**
 * One complete n01 sync of a linked team (MASTER SPEC Phase 5 §2):
 *
 *   season → team → roster → PPR → format → opponent → analysis → stored in one batch
 *
 * The roster/format half is the part that must succeed; if the opponent analysis fails
 * the rest is still stored and the failure is listed with the changes.
 */
export type FreshSyncResult =
  | { kind: 'ok'; plan: N01SyncPlan; intel: N01MatchIntelligenceSnapshot | null; data: N01TeamData }
  | { kind: 'seasonAmbiguous'; options: { tournamentId: string; title: string; teamTpid: string }[] }
  | { kind: 'teamNotFound' };

export interface FreshSyncOptions {
  onProgress?: N01ProgressListener;
  /** The captain's choice of season, after `seasonAmbiguous`. */
  selection?: N01TeamSelection;
  /** The captain's choice of fixture, after an ambiguous next match. */
  chosenMatchId?: string;
  /** Lets a caller that was closed ignore a late result. */
  isCurrent?: () => boolean;
}

export function useN01FreshSync(): (team: Team, options?: FreshSyncOptions) => Promise<FreshSyncResult | null> {
  const sync = useN01Sync();
  return useCallback(
    async (team, options = {}) => {
      const current = options.isCurrent ?? (() => true);
      let selection = options.selection;
      if (!selection) {
        const resolution = await sync.resolve(team, options.onProgress);
        if (!current()) return null;
        if (resolution.kind === 'seasonAmbiguous') return { kind: 'seasonAmbiguous', options: resolution.options };
        if (resolution.kind === 'teamNotFound') return { kind: 'teamNotFound' };
        selection = resolution.selection;
      }
      const data = await sync.fetch(selection, options.onProgress);
      if (!current()) return null;
      // n01 players who might be hand-made members are held back, not added a second time:
      // they come back in `plan.roster.pending` for the captain to confirm.
      const plan = sync.plan(team, data, undefined, { deferAmbiguous: true });
      let intel: N01MatchIntelligenceSnapshot | null = null;
      try {
        intel = (
          await sync.intelligence(team.id, data, plan.format, {
            onProgress: options.onProgress,
            plan,
            chosenMatchId: options.chosenMatchId,
          })
        ).snapshot;
      } catch (error) {
        if (error instanceof N01Error && error.kind === 'aborted') throw error;
        options.onProgress?.('opponent', 'error');
        plan.changes.notes.push(`次戦の分析データを取得できませんでした (${describeN01Error(error)})`);
      }
      if (!current()) return null;
      const extraCache: N01CacheRecord[] = intel ? [intel] : [];
      await sync.apply(plan, { extraCache });
      return { kind: 'ok', plan, intel, data };
    },
    [sync],
  );
}

/**
 * Applies the captain's answers about uncertain matches (see `PendingLinks`): re-plans the
 * same fetched data with their choices — a member to join, or `null` for "someone new" —
 * and stores the result. Nothing is fetched again.
 */
export function useN01LinkResolution(): (
  team: Team,
  result: Extract<FreshSyncResult, { kind: 'ok' }>,
  answers: ReadonlyMap<string, string | null>,
) => Promise<N01SyncPlan> {
  const sync = useN01Sync();
  return useCallback(
    async (team, result, answers) => {
      const plan = sync.plan(team, result.data, answers, { deferAmbiguous: true });
      await sync.apply(plan, { extraCache: result.intel ? [result.intel] : [] });
      return plan;
    },
    [sync],
  );
}
