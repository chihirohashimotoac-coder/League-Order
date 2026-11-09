import { render } from '@testing-library/react';
import { App } from '../App';
import { AppStoreProvider } from '../state/appStore';
import { ToastProvider } from '../components/ui';
import { openBackend, resetBackendCache } from '../storage/db';
import { DEFAULT_SETTINGS, Repository, type Snapshot } from '../storage/repository';
import type { LeagueFormat, Player, RuleAnswerSet, SavedOrder, Team } from '../domain/types';

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

export async function seed(
  extra: { formats?: LeagueFormat[]; orders?: SavedOrder[]; ruleAnswers?: Record<string, RuleAnswerSet> } = {},
): Promise<void> {
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
    // The harness formats play Singles twice. Their appearance cap is stated up front (2 = as
    // many as there are Singles games, i.e. no restriction), so the suites that are not about
    // the question are never stopped by it; `extra.ruleAnswers` replaces it.
    settings: {
      ...DEFAULT_SETTINGS,
      activeTeamId: TEAM_A,
      ruleAnswers: extra.ruleAnswers ?? {
        [`format:${TEAM_A}_fmt`]: { caps: { SINGLES: 2 }, updatedAt: 0 },
        [`format:${TEAM_B}_fmt`]: { caps: { SINGLES: 2 }, updatedAt: 0 },
      },
    },
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


/**
 * Opens a main screen from the bottom bar. Members, formats, pairs, history and settings live
 * under その他 (v1.5.0): the bar's その他, then the screen by name.
 */
export async function openScreen(user: { click: (element: Element) => Promise<void> }, name: string): Promise<void> {
  const { screen, within } = await import('@testing-library/react');
  const nav = screen.getByRole('navigation', { name: 'メインナビゲーション' });
  if (['メンバー', 'フォーマット', 'ペア相性', '履歴', '設定 / バックアップ'].includes(name)) {
    await user.click(within(nav).getByRole('button', { name: 'その他' }));
    const more = await screen.findByTestId('more-page');
    await user.click(within(more).getByRole('button', { name: new RegExp(`^${name.replace(/[/]/g, '\\/')}`) }));
    return;
  }
  await user.click(within(nav).getByRole('button', { name }));
}
