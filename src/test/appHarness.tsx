import { render } from '@testing-library/react';
import { App } from '../App';
import { AppStoreProvider } from '../state/appStore';
import { ToastProvider } from '../components/ui';
import { openBackend, resetBackendCache } from '../storage/db';
import { DEFAULT_SETTINGS, Repository, type Snapshot } from '../storage/repository';
import type { LeagueFormat, Player, SavedOrder, Team } from '../domain/types';

/**
 * The real app shell over a seeded IndexedDB: two manual teams (A active) with four
 * members and a three-game format each. Call `seed` after installing a fresh IDBFactory.
 */

export const TEAM_A = 'team_a';
export const TEAM_B = 'team_b';

export function roster(teamId: string, prefix: string): Player[] {
  return [14, 11, 8, 5].map((rating, index) => ({
    id: `${teamId}_p${index + 1}`,
    teamId,
    name: `${prefix}${index + 1}`,
    rating,
    ppr: null,
    skills: {},
    seasonAppearances: 0,
    seasonAppearancesByKind: {},
    archived: false,
    createdAt: index,
  }));
}

export function formatFor(teamId: string): LeagueFormat {
  return {
    id: `${teamId}_fmt`,
    teamId,
    name: 'テスト 3ゲーム',
    discipline: 'SOFT',
    games: [
      { id: `${teamId}_g1`, order: 1, name: 'Singles 01', kinds: ['SINGLES', 'G501'], playerCount: 1 },
      { id: `${teamId}_g2`, order: 2, name: 'Doubles 01', kinds: ['DOUBLES', 'G501'], playerCount: 2 },
      { id: `${teamId}_g3`, order: 3, name: 'Singles 01', kinds: ['SINGLES', 'G501'], playerCount: 1 },
    ],
    createdAt: 0,
  };
}

export async function seed(extra: { formats?: LeagueFormat[]; orders?: SavedOrder[] } = {}): Promise<void> {
  const teams: Team[] = [
    { id: TEAM_A, name: 'チームA', createdAt: 1 },
    { id: TEAM_B, name: 'チームB', createdAt: 2 },
  ];
  const snapshot: Snapshot = {
    teams,
    players: [...roster(TEAM_A, 'Aさん'), ...roster(TEAM_B, 'Bさん')],
    formats: [formatFor(TEAM_A), formatFor(TEAM_B), ...(extra.formats ?? [])],
    pairs: [],
    orders: extra.orders ?? [],
    seasonCommits: [],
    settings: { ...DEFAULT_SETTINGS, activeTeamId: TEAM_A },
  };
  await new Repository(await openBackend()).replaceAll(snapshot);
  resetBackendCache();
}

export function renderApp(): ReturnType<typeof render> {
  return render(
    <ToastProvider>
      <AppStoreProvider>
        <App />
      </AppStoreProvider>
    </ToastProvider>,
  );
}

