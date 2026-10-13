import type { Composition } from './gameKind';
import { classifyGames, linesFromGames, tallyGames } from './roleGames';
import type { ClassifiedGame, GameScope, GameTally, PerPlayerScores, SeasonGames } from './roleGames';
import type { PlayerSeason, SeasonData, TeamSeason } from './seasonData';
import type { StatLine } from './types';

/**
 * Seasons as the chosen game kind sees them (P0 合算 + P2 役割別).
 *
 * The rest of analytics (pooling, rankings, views) works on `SeasonData` lines and pools
 * Σ numerator / Σ denominator. This module only decides **which counters each season
 * contributes** for a game kind, and records why, so the existing — correct — maths is reused
 * unchanged and a season is never dropped just because its format differs from another's.
 *
 * Rules (verified against n01's own totals, see `realData.roles.test.ts`):
 *  - A season whose slots are all 01: n01's season stats are used as they are.
 *  - A season with Cricket slots: n01 keeps Cricket in separate counters, so score, darts,
 *    First 9, ton counts, High Finish and Best Leg are 01-only and are used; legs and sets
 *    include the Cricket games (ATDO 2024 2nd: +18 legs, +8 sets for one team), so they are
 *    recounted from the 01 games; Keep/Break is withheld.
 *  - A season with a slot of unknown type: n01's counters may include it, so only what the
 *    01 games themselves show is used.
 *  - A game-kind view (singles, doubles …): only the game rows of that kind.
 * Unknown stays `null`, never 0, and a partial game list is never passed off as a season.
 */

export type MetricGroup = 'ppr' | 'first9' | 'legSet' | 'keepBreak' | 'records' | 'match';

export const METRIC_GROUP_LABEL: Record<MetricGroup, string> = {
  ppr: '3DA',
  first9: 'First 9',
  legSet: 'Leg / Set（ゲーム）勝率',
  keepBreak: 'Keep / Break',
  records: '100+〜180・High Finish・Best Leg',
  match: 'Match勝敗（公式）',
};

/**
 * - `official`: n01's season stats, as reported;
 * - `recomputed`: counted from the season's played 01 games;
 * - `excluded`: this season cannot supply it (reason given);
 * - `unavailable`: this game kind cannot supply it at all (needs leg-by-leg data).
 */
export type AdoptionState = 'official' | 'recomputed' | 'excluded' | 'unavailable';

export interface MetricAdoption {
  state: AdoptionState;
  reason?: string;
}

export type GamesState = 'not-needed' | 'loaded' | 'partial' | 'missing';

export interface SeasonAdoption {
  tournamentId: string;
  title: string;
  /** Schedule make-up, upgraded by what the games show. */
  composition: Composition;
  gamesState: GamesState;
  tally: GameTally | null;
  /** 01 games counted for this view. */
  gamesCounted: number;
  metrics: Record<MetricGroup, MetricAdoption>;
  /** Per-player 3DA for multi-thrower games in this view. */
  playerPpr: 'exact' | 'partly-verified' | 'not-applicable' | 'unavailable';
  notes: string[];
}

export interface GamesSource {
  /** Loaded game lists by tournament id. */
  games: ReadonlyMap<string, SeasonGames>;
  /** Seasons whose game list was asked for but could not be read. */
  failed: ReadonlySet<string>;
}

export interface Projection {
  scope: GameScope;
  seasons: SeasonData[];
  adoption: SeasonAdoption[];
}

/** Seasons whose game rows a view needs. `all01` needs them only for non-pure-01 seasons. */
export function seasonsNeedingGames(seasons: readonly SeasonData[], scope: GameScope): string[] {
  return seasons.filter((s) => scope !== 'all01' || s.composition.composition !== 'pure01').map((s) => s.tournamentId);
}

const ALL_OFFICIAL: Record<MetricGroup, MetricAdoption> = {
  ppr: { state: 'official' },
  first9: { state: 'official' },
  legSet: { state: 'official' },
  keepBreak: { state: 'official' },
  records: { state: 'official' },
  match: { state: 'official' },
};

const NO_GAMES = 'ゲーム別データを取得できませんでした';
const PARTIAL_GAMES = 'ゲーム一覧を最後まで取得できなかったため、この季は使いません';
const NEEDS_LEGS = 'Leg明細が必要なため、この表示では集計しません';

function effectiveComposition(season: SeasonData, classified: readonly ClassifiedGame[] | null): Composition {
  let composition = season.composition.composition;
  if (!classified) return composition;
  if (classified.some((g) => g.family.family === 'unknown')) composition = 'unknown';
  else if (composition === 'pure01' && classified.some((g) => g.family.family === 'cricket')) composition = 'mixed';
  return composition;
}

function emptied(line: StatLine | null): StatLine | null {
  if (!line) return null;
  const out = { ...line };
  for (const key of Object.keys(out) as (keyof StatLine)[]) out[key] = null;
  return out;
}

/** A subject with no 01 game in a fully read list: 0 legs played (so every rate is "no data"). */
function zeroGames(): StatLine {
  return {
    score: null, darts: null, f9Score: null, f9Darts: null, leg: 0, winLeg: 0, set: 0, winSet: 0, breakLegs: null, breakWins: null,
    match: null, winMatch: null, ton00: null, ton40: null, ton70: null, ton80: null, highOut: null, bestLeg: null,
  };
}

/** n01's 01-only counters of a mixed season, with legs/sets replaced by the 01 games' count. */
function mixedLine(official: StatLine, games: StatLine | null): StatLine {
  return {
    ...official,
    leg: games?.leg ?? null,
    winLeg: games?.winLeg ?? null,
    set: games?.set ?? null,
    winSet: games?.winSet ?? null,
    breakLegs: null,
    breakWins: null,
  };
}

function withLines(season: SeasonData, team: (t: TeamSeason) => StatLine | null, player: (p: PlayerSeason) => StatLine): SeasonData {
  return {
    ...season,
    teams: season.teams.map((t) => ({ ...t, line: team(t) })),
    players: season.players.map((p) => ({ ...p, line: player(p) })),
  };
}

export function projectSeasons(seasons: readonly SeasonData[], scope: GameScope, source: GamesSource, perPlayer: PerPlayerScores = new Map()): Projection {
  const projected: SeasonData[] = [];
  const adoption: SeasonAdoption[] = [];
  for (const season of seasons) {
    const raw = source.games.get(season.tournamentId) ?? null;
    const classified = raw ? classifyGames(season, raw.games) : null;
    const composition = effectiveComposition(season, classified);
    const gamesState: GamesState = raw ? (raw.complete ? 'loaded' : 'partial') : source.failed.has(season.tournamentId) ? 'missing' : 'not-needed';
    const usable = raw?.complete ? classified : null;
    const lines = usable ? linesFromGames(usable, scope, perPlayer) : null;
    const notes: string[] = [];
    if (raw && (raw.dropped.unfinished > 0 || raw.dropped.unreadable > 0)) {
      notes.push(`未終了 ${raw.dropped.unfinished} ゲーム・読めない記録 ${raw.dropped.unreadable} 件は集計していません`);
    }
    const base = {
      tournamentId: season.tournamentId,
      title: season.title,
      composition,
      gamesState,
      tally: classified ? tallyGames(classified) : null,
      gamesCounted: lines?.games ?? 0,
      notes,
    };

    if (scope === 'all01' && composition === 'pure01') {
      projected.push(season);
      adoption.push({ ...base, metrics: { ...ALL_OFFICIAL }, playerPpr: 'exact' });
      continue;
    }

    if (scope === 'all01' && composition === 'mixed') {
      const legSet: MetricAdoption = lines ? { state: 'recomputed', reason: '公式のLeg/SetにはCricketが含まれるため、01のゲームから数え直しました' } : { state: 'excluded', reason: gamesState === 'partial' ? PARTIAL_GAMES : NO_GAMES };
      // Only rows of a division whose schedule has a Cricket slot are corrected; the season's
      // games must also show no Cricket there (a row's division is the team's).
      const cricketDivisions = new Set(classified?.filter((g) => g.family.family === 'cricket').map((g) => g.division) ?? []);
      const pureDivision = (division: number | null): boolean =>
        division !== null && season.divisionComposition[division] === 'pure01' && !cricketDivisions.has(division) && !cricketDivisions.has(null);
      projected.push(
        withLines(
          season,
          (t) => (!t.line || pureDivision(t.divisionIndex) ? t.line : mixedLine(t.line, lines ? (lines.teams.get(t.teamId) ?? zeroGames()) : null)),
          (p) => (pureDivision(p.divisionIndex) ? p.line : mixedLine(p.line, lines ? (lines.players.get(p.oid) ?? zeroGames()) : null)),
        ),
      );
      adoption.push({
        ...base,
        metrics: {
          ppr: { state: 'official', reason: 'n01はCricketを別の項目で集計するため、得点・投数は01のみ' },
          first9: { state: 'official' },
          legSet,
          keepBreak: { state: 'excluded', reason: 'Cricketを含むディビジョンの成績は01のみと確認できないため使いません（Cricketのないディビジョンは公式値）' },
          records: { state: 'official' },
          match: { state: 'official', reason: 'Match勝敗はCricketのゲームを含む公式の試合結果です' },
        },
        playerPpr: 'exact',
      });
      continue;
    }

    // `all01` with an unknown slot, or a game-kind view: the 01 game rows are the only source.
    const roleView = scope !== 'all01';
    const missingReason = gamesState === 'partial' ? PARTIAL_GAMES : NO_GAMES;
    const multi = scope !== 'singles';
    const anyMulti = multi && lines !== null && [...lines.players.values()].length > 0;
    const verifiedAll = anyMulti && [...lines!.players.values()].every((l) => l.darts !== null);
    const verifiedSome = anyMulti && [...lines!.players.values()].some((l) => l.darts !== null);
    projected.push(
      withLines(
        season,
        (t) => (lines ? (lines.teams.get(t.teamId) ?? null) : emptied(t.line)),
        (p) => (lines ? (lines.players.get(p.oid) ?? zeroGames()) : (emptied(p.line) as StatLine)),
      ),
    );
    const unknownReason = '種別不明のゲーム枠を含むため、公式の通算値を採用できません';
    adoption.push({
      ...base,
      metrics: {
        ppr: lines ? { state: 'recomputed', reason: multi ? 'チームの3DAはゲーム記録から。選手個人の3DAはLeg明細から復元・検証できた場合のみ' : undefined } : { state: 'excluded', reason: missingReason },
        first9: roleView ? { state: 'unavailable', reason: NEEDS_LEGS } : { state: 'excluded', reason: unknownReason },
        legSet: lines ? { state: 'recomputed' } : { state: 'excluded', reason: missingReason },
        keepBreak: roleView ? { state: 'unavailable', reason: NEEDS_LEGS } : { state: 'excluded', reason: unknownReason },
        records: roleView ? { state: 'unavailable', reason: NEEDS_LEGS } : { state: 'excluded', reason: unknownReason },
        match: roleView ? { state: 'unavailable', reason: '公式のMatch勝敗は試合単位のため、ゲーム種別ごとには分けません' } : { state: 'official' },
      },
      playerPpr: scope === 'singles' ? 'exact' : verifiedAll ? 'exact' : verifiedSome ? 'partly-verified' : 'unavailable',
    });
  }
  return { scope, seasons: projected, adoption };
}

/** Seasons that supply at least one figure for this view. */
export function contributingSeasons(adoption: readonly SeasonAdoption[]): number {
  return adoption.filter((a) => a.metrics.ppr.state === 'official' || a.metrics.ppr.state === 'recomputed' || a.metrics.legSet.state !== 'excluded').length;
}
