import { useEffect, useMemo, useState } from 'react';
import { MAX_FOLLOWED } from '../watchSettings';
import { useAppStore } from '../../../state/appStore';
import type { MatchesApi } from '../api';
import type { Fixture, GameRow, SeasonDocument } from '../parse';
import type { PlayerStatsRow } from '../../analytics/types';
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

// ---------------------------------------------------------------------------
// Registered teams (登録チーム) in a season
// ---------------------------------------------------------------------------

/**
 * The season ids of the teams registered in League Order for this league: by id in the season
 * the binding last synced, otherwise by exact team name, and only when exactly one entry has
 * it. The active team comes first.
 */
export function useRegisteredTeams(season: SeasonDocument | null): string[] {
  const map = useRegisteredTeamMap(season);
  return useMemo(() => [...map.keys()], [map]);
}

/** Registered teams of this season: n01 team id → League Order team id (active team first). */
export function useRegisteredTeamMap(season: SeasonDocument | null): Map<string, string> {
  const store = useAppStore();
  return useMemo(() => {
    const map = new Map<string, string>();
    if (!season) return map;
    const teams = [...store.teams].sort((a, b) => Number(b.id === store.activeTeamId) - Number(a.id === store.activeTeamId));
    for (const team of teams) {
      const binding = team.n01;
      if (!binding || binding.leagueId !== season.leagueId) continue;
      const id = ownTeamIn(season, {
        leagueId: binding.leagueId,
        leagueTitle: binding.leagueTitle,
        ownTournamentId: binding.lastTournamentId,
        ownTeamId: binding.lastTeamId,
        ownTeamName: binding.lastTeamName,
        ownDivision: binding.lastDivisionIndex,
      });
      if (id && !map.has(id)) map.set(id, team.id);
    }
    return map;
  }, [season, store.teams, store.activeTeamId]);
}

// ---------------------------------------------------------------------------
// Today's board: every league game started in the last 18 hours, refreshed while visible
// ---------------------------------------------------------------------------

export interface BoardState {
  games: GameRow[] | null;
  error: string | null;
  fetchedAt: number | null;
}

/** 5 s while a game is in progress, 15 s when the last three polls brought nothing new, 60 s with nothing live. */
export function useTodayBoard(api: MatchesApi | null, tournamentId: string | null, enabled: boolean): BoardState {
  const [state, setState] = useState<BoardState>({ games: null, error: null, fetchedAt: null });
  useEffect(() => {
    if (!api || !tournamentId || !enabled) return;
    let alive = true;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let lastMax = 0;
    let quiet = 0;
    const controller = new AbortController();
    const tick = async (): Promise<void> => {
      if (document.visibilityState === 'hidden') {
        timer = setTimeout(() => void tick(), 2000);
        return;
      }
      let delay = 5000;
      try {
        const games = await api.todayGames(tournamentId, Date.now() / 1000 - 18 * 3600, controller.signal);
        if (!alive) return;
        const max = Math.max(0, ...games.map((game) => game.updateTime ?? 0));
        quiet = max > lastMax ? 0 : quiet + 1;
        lastMax = Math.max(lastMax, max);
        const live = games.some((game) => !game.finished);
        delay = !live ? 60_000 : quiet >= 3 ? 15_000 : 5000;
        setState({ games, error: null, fetchedAt: Date.now() });
      } catch (error) {
        if (!alive) return;
        delay = 20_000;
        setState((current) => ({ ...current, error: describeN01Error(error) }));
      }
      // ±20 % so phones on one Wi-Fi do not poll in step.
      if (alive) timer = setTimeout(() => void tick(), delay * (0.8 + Math.random() * 0.4));
    };
    void tick();
    return () => {
      alive = false;
      controller.abort();
      if (timer) clearTimeout(timer);
    };
  }, [api, tournamentId, enabled]);
  return state;
}

// ---------------------------------------------------------------------------
// Season player stats with names
// ---------------------------------------------------------------------------

export interface PlayerLine {
  oid: string;
  name: string;
  teamId: string | null;
  divisionIndex: number | null;
  line: PlayerStatsRow['line'];
}

export function usePlayerStats(api: MatchesApi | null, tournamentId: string | null, enabled: boolean): Load<PlayerLine[]> {
  const [state, setState] = useState<Load<PlayerLine[]>>({ kind: 'loading' });
  useEffect(() => {
    if (!api || !tournamentId || !enabled) return;
    let alive = true;
    setState({ kind: 'loading' });
    Promise.all([api.playerStats(tournamentId), api.roster(tournamentId).catch(() => [])])
      .then(([rows, roster]) => {
        if (!alive) return;
        const names = new Map(roster.map((player) => [player.oid, player]));
        setState({
          kind: 'ready',
          fetchedAt: Date.now(),
          value: rows.map((row) => ({
            oid: row.oid,
            name: row.name ?? names.get(row.oid)?.name ?? '(名前なし)',
            teamId: row.teamId ?? names.get(row.oid)?.teamId ?? null,
            divisionIndex: row.divisionIndex,
            line: row.line,
          })),
        });
      })
      .catch((error) => alive && setState({ kind: 'error', message: describeN01Error(error) }));
    return () => {
      alive = false;
    };
  }, [api, tournamentId, enabled]);
  return state;
}

// ---------------------------------------------------------------------------
// Followed players (注目選手): kept in settings, matched by name
// ---------------------------------------------------------------------------

export interface Followed {
  names: ReadonlySet<string>;
  isFollowed: (name: string) => boolean;
  toggle: (name: string, team: string | null) => void;
  full: boolean;
}

export function useFollowed(): Followed {
  const store = useAppStore();
  const stored = store.settings.followed;
  const list = useMemo(() => stored ?? [], [stored]);
  const names = useMemo(() => new Set(list.map((entry) => entry.name)), [list]);
  return {
    names,
    isFollowed: (name) => names.has(name.trim()),
    full: list.length >= MAX_FOLLOWED,
    toggle: (name, team) => {
      const key = name.trim();
      if (!key) return;
      const next = names.has(key) ? list.filter((entry) => entry.name !== key) : list.length >= MAX_FOLLOWED ? list : [...list, { name: key, team }];
      store.updateSettings({ followed: next });
    },
  };
}
