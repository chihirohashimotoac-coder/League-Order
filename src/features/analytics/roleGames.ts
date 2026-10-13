import type { RawGame, RawGameSide } from './api/parse';
import { gameFamily, gameRole, slotFamily, slotFor } from './gameKind';
import type { FamilyVerdict, GameRole } from './gameKind';
import type { SeasonData } from './seasonData';
import type { VerifiedContribution } from './reconstruct';
import type { StatLine } from './types';

/**
 * A season's played games (`match/list`) → classified games → per-game-kind counters
 * (P2: 役割別分析).
 *
 * What a played game row tells exactly, without any attribution:
 *  - per side: the team, its players in throwing order, legs won, total score and darts;
 *  - so per **team**: 3DA, Leg and game (Set) results for every role;
 *  - per **player**: Leg and game results of every game they took part in (credited to each
 *    partner, as n01 itself does), and score/darts only for **singles** (one thrower).
 * Score and darts of a doubles/trios/team game are the side's; they are never copied onto
 * each partner. Per-player values for those games come only from a verified leg-by-leg
 * reconstruction (`reconstruct.ts`), through {@link PerPlayerScores}.
 */

/** Which games a figure covers. `others` = trios + gallon + team (4+). */
export type GameScope = 'all01' | 'singles' | 'doubles' | 'others' | 'trios' | 'gallon' | 'team';

export const SCOPE_LABEL: Record<GameScope, string> = {
  all01: '01全体',
  singles: 'シングルス01',
  doubles: 'ダブルス01',
  others: 'その他の01',
  trios: 'トリオス01',
  gallon: 'ガロン01',
  team: 'チーム戦01（4人以上）',
};

export function inScope(role: GameRole, scope: GameScope): boolean {
  switch (scope) {
    case 'all01':
      return true;
    case 'singles':
    case 'doubles':
    case 'trios':
    case 'gallon':
    case 'team':
      return role === scope;
    case 'others':
      return role === 'trios' || role === 'gallon' || role === 'team';
  }
}

/** A season's league games as fetched (finished and readable only), plus what was left out. */
export interface SeasonGames {
  tournamentId: string;
  games: RawGame[];
  dropped: { unfinished: number; unreadable: number; nonLeague: number };
  /** Every page was read (a cut-off list must not pass as the whole season). */
  complete: boolean;
}

export interface ClassifiedGame {
  gameId: string;
  matchId: string | null;
  division: number | null;
  schid: string | null;
  family: FamilyVerdict;
  role: GameRole;
  /** The slot's start score when known (501 / 1001 …). */
  startScore: number | null;
  sides: [RawGameSide, RawGameSide];
}

const LEAGUE_TMID = /_lg_(\d+)_/u;

/**
 * Division index from a league `tmid` (`<tdid>_lg_<division>_<lsid>_<tpid>_<tpid>`, the live
 * shape); `null` when the id carries none. The division picks the `game_setting` override.
 */
export function divisionOfMatchId(matchId: string | null): number | null {
  const hit = matchId ? LEAGUE_TMID.exec(matchId) : null;
  return hit ? Number(hit[1]) : null;
}

/** A game of the league table (`_lg_`), not of a playoff or another part of the event. */
export function isLeagueGame(matchId: string | null): boolean {
  return matchId !== null && matchId.includes('_lg_');
}

export function classifyGames(season: Pick<SeasonData, 'slots'>, games: readonly RawGame[]): ClassifiedGame[] {
  return games.map((game) => {
    const division = divisionOfMatchId(game.matchId);
    const slot = slotFor(season.slots, game.schid, division);
    return {
      gameId: game.gameId,
      matchId: game.matchId,
      division,
      schid: game.schid,
      family: gameFamily(game.matchType, slot ? slotFamily(slot) : null),
      role: gameRole(slot, [game.sides[0].players.length, game.sides[1].players.length]),
      startScore: slot?.startScore ?? null,
      sides: game.sides,
    };
  });
}

export interface GameTally {
  /** Games per family, and 01 games per role (the basis shown in the details panel). */
  byFamily: Record<FamilyVerdict['family'], number>;
  byRole: Record<GameRole, number>;
}

export function tallyGames(games: readonly ClassifiedGame[]): GameTally {
  const byFamily = { '01': 0, cricket: 0, unknown: 0 };
  const byRole: Record<GameRole, number> = { singles: 0, doubles: 0, trios: 0, gallon: 0, team: 0, unknown: 0 };
  for (const game of games) {
    byFamily[game.family.family] += 1;
    if (game.family.family === '01') byRole[game.role] += 1;
  }
  return { byFamily, byRole };
}

/**
 * Per-player figures of multi-thrower games, from a reconstruction that passed the season
 * checksum (`reconstruct.ts`); only verified fields are present.
 */
export type PerPlayerScores = ReadonlyMap<string, ReadonlyMap<string, VerifiedContribution>>;

/** A line holding only what game rows can tell; everything else stays `null` (not measured). */
function blankLine(): StatLine {
  return {
    score: null,
    darts: null,
    f9Score: null,
    f9Darts: null,
    leg: 0,
    winLeg: 0,
    set: 0,
    winSet: 0,
    breakLegs: null,
    breakWins: null,
    match: null,
    winMatch: null,
    ton00: null,
    ton40: null,
    ton70: null,
    ton80: null,
    highOut: null,
    bestLeg: null,
  };
}

/** Field groups that are either known for every game of a subject, or withheld. */
const GROUPS = {
  scoreDarts: ['score', 'darts'],
  f9: ['f9Score', 'f9Darts'],
  tons: ['ton00', 'ton40', 'ton70', 'ton80'],
  break: ['breakLegs', 'breakWins'],
} as const satisfies Record<string, readonly (keyof StatLine & keyof VerifiedContribution)[]>;

type Group = keyof typeof GROUPS | 'highOut';

interface Acc {
  line: StatLine;
  /** Games in which a group was unknown for this subject: the group is then withheld. */
  gaps: Record<Group, number>;
  games: number;
}

function newAcc(): Acc {
  return { line: blankLine(), gaps: { scoreDarts: 0, f9: 0, tons: 0, break: 0, highOut: 0 }, games: 0 };
}

function credit(acc: Acc, side: RawGameSide, opponent: RawGameSide, known: VerifiedContribution | null): void {
  const l = acc.line;
  l.leg = (l.leg ?? 0) + side.legsWon + opponent.legsWon;
  l.winLeg = (l.winLeg ?? 0) + side.legsWon;
  l.set = (l.set ?? 0) + 1;
  l.winSet = (l.winSet ?? 0) + (side.legsWon > opponent.legsWon ? 1 : 0);
  acc.games += 1;
  for (const [group, keys] of Object.entries(GROUPS) as [keyof typeof GROUPS, readonly (keyof StatLine & keyof VerifiedContribution)[]][]) {
    if (known && keys.every((k) => typeof known[k] === 'number' && Number.isFinite(known[k]))) {
      for (const k of keys) l[k] = ((l[k] as number | null) ?? 0) + (known[k] as number);
    } else acc.gaps[group] += 1;
  }
  if (known && 'highOut' in known) {
    if (known.highOut !== null && known.highOut !== undefined) l.highOut = Math.max(l.highOut ?? 0, known.highOut);
  } else acc.gaps.highOut += 1;
}

function finish(acc: Acc): StatLine {
  // A figure over only some of the games would be a different population: all or nothing.
  const out = { ...acc.line };
  for (const [group, keys] of Object.entries(GROUPS) as [keyof typeof GROUPS, readonly (keyof StatLine)[]][]) {
    if (acc.gaps[group] > 0) for (const k of keys) out[k] = null;
  }
  if (acc.gaps.highOut > 0) out.highOut = null;
  return out;
}

export interface GameLines {
  teams: Map<string, StatLine>;
  /** By the player's season-scoped `oid`. */
  players: Map<string, StatLine>;
  /** Games counted (01 family, in scope). */
  games: number;
}

/**
 * Counters per team and per player over the 01 games of one season in `scope`. Teams get
 * score/darts from their own side totals; players get them for singles (one thrower) or from
 * `perPlayer` (verified reconstruction) — never a side's total copied onto a partner.
 */
export function linesFromGames(games: readonly ClassifiedGame[], scope: GameScope, perPlayer: PerPlayerScores = new Map()): GameLines {
  const teams = new Map<string, Acc>();
  const players = new Map<string, Acc>();
  const acc = (map: Map<string, Acc>, key: string): Acc => {
    let found = map.get(key);
    if (!found) {
      found = newAcc();
      map.set(key, found);
    }
    return found;
  };
  let counted = 0;
  for (const game of games) {
    if (game.family.family !== '01' || !inScope(game.role, scope)) continue;
    counted += 1;
    game.sides.forEach((side, index) => {
      const opponent = game.sides[1 - index];
      const sideScore: VerifiedContribution | null = side.score !== null && side.darts !== null ? { score: side.score, darts: side.darts } : null;
      credit(acc(teams, side.teamId), side, opponent, sideScore);
      const reconstructed = perPlayer.get(game.gameId);
      for (const player of side.players) {
        if (!player.oid) continue;
        const verified = reconstructed?.get(player.oid) ?? null;
        const known = side.players.length === 1 ? { ...(sideScore ?? {}), ...(verified ?? {}) } : verified;
        credit(acc(players, player.oid), side, opponent, known);
      }
    });
  }
  return {
    teams: new Map([...teams].map(([k, v]) => [k, finish(v)])),
    players: new Map([...players].map(([k, v]) => [k, finish(v)])),
    games: counted,
  };
}
