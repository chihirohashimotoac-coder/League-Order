import type { DartsDiscipline, GameKind, GameSlotDef, LeagueFormat } from '../../domain/types';
import type { N01FormatSource, N01GameMeta } from '../../domain/n01/types';
import type { N01Division, N01ScheduleSlot, N01Tournament } from './types';

/**
 * Format resolution (docs/N01_MASTER_DESIGN.md §4, MASTER SPEC Phase 1 §11).
 *
 * Nothing about a league is hard-coded. The format is read from the tournament:
 *
 * - base: `lg_setting.schedule`
 * - division override: the `lg_setting.game_setting` entry whose `round` equals the
 *   team's division index replaces the base when present.
 *
 * Each slot becomes a game:
 *
 * | n01                         | League Order            |
 * |-----------------------------|-------------------------|
 * | `num_part` 1 / 2 / 3 / 4+   | SINGLES / DOUBLES / TRIOS / TEAM |
 * | subtitle clearly "Gallon"   | GALLON (instead of the above) |
 * | `match_type` 01             | G501 (the internal id for every 01 game) |
 * | `match_type` cricket        | CRICKET                 |
 *
 * `playerCount` is `num_part`. The original n01 values are kept on the game (`n01`).
 */

export function effectiveSchedule(
  tournament: Pick<N01Tournament, 'schedule' | 'gameSettings'>,
  divisionIndex: number | null,
): N01ScheduleSlot[] {
  if (divisionIndex !== null) {
    const override = tournament.gameSettings.find((setting) => setting.round === divisionIndex);
    if (override && override.schedule.length > 0) return override.schedule;
  }
  return tournament.schedule;
}

const GALLON = /gallon|ガロン/iu;

export function structuralKind(slot: Pick<N01ScheduleSlot, 'numPart' | 'subtitle'>): GameKind {
  if (slot.subtitle && GALLON.test(slot.subtitle)) return 'GALLON';
  if (slot.numPart === 1) return 'SINGLES';
  if (slot.numPart === 2) return 'DOUBLES';
  if (slot.numPart === 3) return 'TRIOS';
  return 'TEAM';
}

/** `G501` for every 01 game, `CRICKET` for cricket, `null` for anything unrecognised. */
export function matchKind(matchType: string): GameKind | null {
  const type = matchType.trim().toLowerCase();
  if (type === '01' || /^\d+$/u.test(type)) return 'G501';
  if (type.includes('cricket') || type.includes('クリケット')) return 'CRICKET';
  return null;
}

const STRUCTURE_LABEL: Partial<Record<GameKind, string>> = {
  SINGLES: 'Singles',
  DOUBLES: 'Doubles',
  TRIOS: 'Trios',
  TEAM: 'Team',
  GALLON: 'Gallon',
};

/** "Singles 501", "Doubles Cricket", "Team 1001", "Gallon 01". */
export function gameName(slot: N01ScheduleSlot): string {
  const structure = STRUCTURE_LABEL[structuralKind(slot)] ?? 'Game';
  const kind = matchKind(slot.matchType);
  const game =
    kind === 'CRICKET'
      ? 'Cricket'
      : kind === 'G501'
        ? slot.startScore !== null
          ? String(slot.startScore)
          : /^\d{3,4}$/u.test(slot.matchType)
            ? slot.matchType
            : '01'
        : slot.matchType.toUpperCase();
  return `${structure} ${game}`;
}

export function gameMeta(slot: N01ScheduleSlot): N01GameMeta {
  return {
    schid: slot.schid,
    numPart: slot.numPart,
    matchType: slot.matchType,
    startScore: slot.startScore,
    limitLegCount: slot.limitLegCount,
    group: slot.group,
    subtitle: slot.subtitle,
  };
}

/** Games of the managed format, in n01's order. */
export function gamesFromSchedule(tournamentId: string, schedule: readonly N01ScheduleSlot[]): GameSlotDef[] {
  return schedule.map((slot, index) => {
    const kinds: GameKind[] = [structuralKind(slot)];
    const kind = matchKind(slot.matchType);
    kinds.push(kind ?? 'CUSTOM');
    return {
      id: `n01g_${tournamentId}_${slot.schid}`,
      order: index + 1,
      name: gameName(slot),
      kinds,
      playerCount: slot.numPart,
      n01: gameMeta(slot),
    };
  });
}

export function disciplineOf(tournament: Pick<N01Tournament, 'softdarts'>): DartsDiscipline {
  if (tournament.softdarts === true) return 'SOFT';
  if (tournament.softdarts === false) return 'STEEL';
  return 'UNSPECIFIED';
}

export interface ManagedFormatInput {
  formatId: string;
  teamId: string;
  leagueId: string;
  leagueTitle: string;
  tournament: N01Tournament;
  division: N01Division | null;
  now: number;
  /** Kept when the format already exists, so it does not jump in the format list. */
  createdAt?: number;
}

export function buildManagedFormat(input: ManagedFormatInput): LeagueFormat {
  const { tournament, division } = input;
  const schedule = effectiveSchedule(tournament, division?.index ?? null);
  const source: N01FormatSource = {
    provider: 'n01',
    leagueId: input.leagueId,
    leagueTitle: input.leagueTitle,
    tournamentId: tournament.tournamentId,
    tournamentTitle: tournament.title,
    divisionIndex: division?.index ?? null,
    divisionTitle: division?.title ?? null,
    syncedAt: input.now,
  };
  const label = [input.leagueTitle, tournament.title, division?.title ? `${division.title} Division` : null]
    .filter(Boolean)
    .join(' ');
  return {
    id: input.formatId,
    teamId: input.teamId,
    name: label || 'n01 フォーマット',
    discipline: disciplineOf(tournament),
    games: gamesFromSchedule(tournament.tournamentId, schedule),
    createdAt: input.createdAt ?? input.now,
    source,
  };
}

/** Structural fingerprint of a format, for change detection (ids and titles ignored). */
export function formatShape(format: Pick<LeagueFormat, 'games' | 'discipline'>): string {
  return [
    format.discipline,
    ...[...format.games]
      .sort((a, b) => a.order - b.order)
      .map((game) => `${[...game.kinds].join('+')}:${game.playerCount}:${game.n01?.startScore ?? ''}:${game.n01?.limitLegCount ?? ''}`),
  ].join('|');
}

/** "Team 1001 ×1 / Doubles 501 ×2 / Singles 501 ×4". */
export function describeFormat(games: readonly GameSlotDef[]): string {
  const counts = new Map<string, number>();
  for (const game of games) counts.set(game.name, (counts.get(game.name) ?? 0) + 1);
  return [...counts.entries()].map(([name, count]) => `${name} ×${count}`).join(' / ');
}
