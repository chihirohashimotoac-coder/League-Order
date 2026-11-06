import { useEffect, useMemo, useState } from 'react';
import { useAppStore } from '../../../state/appStore';
import type { MatchesApi } from '../api';
import type { Fixture, GameRow, SeasonDocument } from '../parse';
import type { MatchCard } from '../cards';
import { buildCards } from '../cards';
import type { N01TournamentSummary } from '../../../integrations/n01/types';
import { describeN01Error } from '../../../integrations/n01/client';
import type { OfficialStandingGroup } from '../../analytics/types';

/**
 * Which league / season / team the match screens show. An n01-linked team starts on its own
 * league, season and division; any other team picks a league first.
 */
export interface MatchScope {
  leagueId: string;
  leagueTitle: string;
  /** Our team in the season the binding knows (`tpid` is season-scoped). */
  ownTournamentId: string | null;
  ownTeamId: string | null;
  ownTeamName: string | null;
  ownDivision: number | null;
}

export function useOwnScope(): MatchScope | null {
  const store = useAppStore();
  const binding = store.activeTeam?.n01;
  return useMemo(
    () =>
      binding
        ? {
            leagueId: binding.leagueId,
            leagueTitle: binding.leagueTitle,
            ownTournamentId: binding.lastTournamentId,
            ownTeamId: binding.lastTeamId,
            ownTeamName: binding.lastTeamName,
            ownDivision: binding.lastDivisionIndex,
          }
        : null,
    [binding],
  );
}

/** Our team's id in another season, by exact name only (never a guess); `null` when not found once. */
export function ownTeamIn(season: SeasonDocument, scope: MatchScope | null): string | null {
  if (!scope?.ownTeamId) return null;
  if (season.tournamentId === scope.ownTournamentId) return season.teams.has(scope.ownTeamId) ? scope.ownTeamId : null;
  const name = scope.ownTeamName?.trim();
  if (!name) return null;
  const hits = [...season.teams.entries()].filter(([, entry]) => entry.trim() === name);
  return hits.length === 1 ? hits[0][0] : null;
}

export type Load<T> = { kind: 'loading' } | { kind: 'error'; message: string } | { kind: 'ready'; value: T; fetchedAt: number };

export function useSeasons(api: MatchesApi | null, leagueId: string | null): Load<N01TournamentSummary[]> {
  const [state, setState] = useState<Load<N01TournamentSummary[]>>({ kind: 'loading' });
  useEffect(() => {
    if (!api || !leagueId) return;
    let live = true;
    setState({ kind: 'loading' });
    api
      .seasons(leagueId)
      .then((result) => {
        if (!live) return;
        const sorted = [...result.tournaments].sort((a, b) => (b.startedAt ?? 0) - (a.startedAt ?? 0) || a.listIndex - b.listIndex);
        setState({ kind: 'ready', value: sorted, fetchedAt: Date.now() });
      })
      .catch((error) => live && setState({ kind: 'error', message: describeN01Error(error) }));
    return () => {
      live = false;
    };
  }, [api, leagueId]);
  return state;
}

export interface SeasonData {
  season: SeasonDocument;
  fixtures: Fixture[];
  games: GameRow[];
  cards: MatchCard[];
  standings: OfficialStandingGroup[] | null;
  standingsError: string | null;
  unreadableGames: number;
  truncated: boolean;
}

export function useSeasonData(api: MatchesApi | null, tournamentId: string | null): Load<SeasonData> {
  const [state, setState] = useState<Load<SeasonData>>({ kind: 'loading' });
  useEffect(() => {
    if (!api || !tournamentId) return;
    let live = true;
    setState({ kind: 'loading' });
    (async () => {
      const [season, fixtures, games] = await Promise.all([api.season(tournamentId), api.fixtures(tournamentId), api.seasonGames(tournamentId)]);
      let standings: OfficialStandingGroup[] | null = null;
      let standingsError: string | null = null;
      try {
        standings = await api.standings(tournamentId);
      } catch (error) {
        standingsError = describeN01Error(error);
      }
      return {
        season,
        fixtures,
        games: games.games,
        cards: buildCards(season, fixtures, games.games),
        standings,
        standingsError,
        unreadableGames: games.unreadable,
        truncated: games.truncated,
      };
    })()
      .then((value) => live && setState({ kind: 'ready', value, fetchedAt: Date.now() }))
      .catch((error) => live && setState({ kind: 'error', message: describeN01Error(error) }));
    return () => {
      live = false;
    };
  }, [api, tournamentId]);
  return state;
}

export function formatClock(ms: number | null): string {
  if (ms === null) return '—';
  const date = new Date(ms);
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${date.getMonth() + 1}/${date.getDate()} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/** 3-dart average or MPR with two decimals; `—` when n01 gives none (never 0). */
export function formatRate(value: number | null): string {
  return value === null ? '—' : value.toFixed(2);
}
