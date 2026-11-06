import type { Fixture, GameRow, SeasonDocument, SeasonSlot } from './parse';
import { parseLeagueTmid } from './parse';

/**
 * Match cards (対戦カード) of one season: a fixture, n01's official card result, and the games
 * played under it — each game placed on the schedule slot it was played for.
 *
 * States are kept apart and never inferred from one another:
 * - card `official`: n01 has a card result (`lg_result`) — the score shown is n01's.
 * - card `live`: a game of the card is being played.
 * - card `unrecorded`: games were played, every one finished, but no card result is entered.
 * - card `scheduled`: no game and no result — not played yet (n01 gives no date to tell
 *   "not yet" from "never").
 * - game `finished` / `live` / `notPlayed` (no game for the slot) / `unreadable`.
 */

export type CardState = 'official' | 'live' | 'unrecorded' | 'scheduled';
export type GameState = 'finished' | 'live' | 'notPlayed';

export interface CardGame {
  slot: SeasonSlot;
  state: GameState;
  game: GameRow | null;
  /** Side index in *card* order (0 = `teams[0]`), `null` when not decided or not played. */
  winner: 0 | 1 | null;
  /** Legs won per card side. */
  legs: [number | null, number | null];
  /** 01: 3-dart average; Cricket: MPR. Per card side, `null` when n01 gives none. */
  rate: [number | null, number | null];
  members: [string[], string[]];
  /** True when the game row lists the card's second team first. */
  flip: boolean;
}

export interface MatchCard {
  key: string;
  tournamentId: string;
  divisionIndex: number;
  divisionTitle: string;
  lsid: string;
  title: string;
  teams: [{ id: string; name: string }, { id: string; name: string }];
  state: CardState;
  /** n01's card score (`lg_result.r`), only when official. */
  official: [number, number] | null;
  /** Games won counted from the game rows (League Order's own count). */
  counted: [number, number];
  /** n01's card averages, when official. */
  officialAvg: [number | null, number | null];
  games: CardGame[];
  /** First and last game start (epoch s), `null` when no game was played. */
  playedFrom: number | null;
  playedTo: number | null;
  /** Latest `updateTime` (ms) of the card's games. */
  updatedAt: number | null;
  /** The `tmid` n01 uses for the card (from a game row), `null` until a game exists. */
  tmid: string | null;
}

/** 3-dart average (01) or MPR (Cricket) of one side of one game; `null` without darts. */
export function sideRate(game: GameRow, side: 0 | 1): number | null {
  const row = game.sides[side];
  if (row.darts === null || row.darts <= 0) return null;
  if (game.matchType === 'cricket') return row.marks === null ? null : (row.marks / row.darts) * 3;
  return row.score === null ? null : (row.score / row.darts) * 3;
}

/** Winner of a finished game by legs (n01's `winLegs`), in the row's own side order. */
export function gameWinner(game: GameRow): 0 | 1 | null {
  if (!game.finished) return null;
  const [a, b] = [game.sides[0].legsWon, game.sides[1].legsWon];
  if (a === null || b === null || a === b) return null;
  return a > b ? 0 : 1;
}

export function buildCards(season: SeasonDocument, fixtures: readonly Fixture[], games: readonly GameRow[]): MatchCard[] {
  const byCard = new Map<string, GameRow[]>();
  for (const game of games) {
    const parts = parseLeagueTmid(game.tmid, season.tournamentId);
    if (!parts) continue;
    const key = `${parts.divisionIndex}_${parts.lsid}`;
    const list = byCard.get(key) ?? [];
    list.push(game);
    byCard.set(key, list);
  }
  const title = (index: number): string => season.divisions[index]?.title ?? `Division ${index + 1}`;
  return fixtures.map((fixture) => {
    const key = `${fixture.divisionIndex}_${fixture.lsid}`;
    const teams: MatchCard['teams'] = [
      { id: fixture.teamIds[0], name: season.teams.get(fixture.teamIds[0]) ?? fixture.teamIds[0] },
      { id: fixture.teamIds[1], name: season.teams.get(fixture.teamIds[1]) ?? fixture.teamIds[1] },
    ];
    const rows = byCard.get(key) ?? [];
    // The newest row per slot wins (a replayed game supersedes an abandoned one).
    const bySlot = new Map<string, GameRow>();
    for (const row of [...rows].sort((a, b) => (a.startTime ?? 0) - (b.startTime ?? 0))) {
      if (row.schid) bySlot.set(row.schid, row);
    }
    const counted: [number, number] = [0, 0];
    const cardGames: CardGame[] = season.slots.map((slot) => {
      const game = bySlot.get(slot.schid) ?? null;
      if (!game) return { slot, state: 'notPlayed', game: null, winner: null, legs: [null, null], rate: [null, null], members: [[], []], flip: false };
      // Card order may differ from the row's side order.
      const flip = game.sides[0].teamId === teams[1].id;
      const idx = (cardSide: 0 | 1): 0 | 1 => (flip ? ((1 - cardSide) as 0 | 1) : cardSide);
      const rowWinner = gameWinner(game);
      const winner = rowWinner === null ? null : ((flip ? 1 - rowWinner : rowWinner) as 0 | 1);
      if (winner !== null) counted[winner] += 1;
      return {
        slot,
        state: game.finished ? 'finished' : 'live',
        game,
        winner,
        legs: [game.sides[idx(0)].legsWon, game.sides[idx(1)].legsWon],
        rate: [sideRate(game, idx(0)), sideRate(game, idx(1))],
        members: [game.sides[idx(0)].members.map((m) => m.name), game.sides[idx(1)].members.map((m) => m.name)],
        flip,
      };
    });
    const result = season.results.get(key);
    const official: [number, number] | null = result && result.get(teams[0].id) && result.get(teams[1].id) ? [result.get(teams[0].id)!.r, result.get(teams[1].id)!.r] : null;
    const anyLive = cardGames.some((game) => game.state === 'live');
    const anyPlayed = cardGames.some((game) => game.state !== 'notPlayed');
    const state: CardState = official ? 'official' : anyLive ? 'live' : anyPlayed ? 'unrecorded' : 'scheduled';
    const starts = rows.map((row) => row.startTime).filter((time): time is number => time !== null);
    const updates = rows.map((row) => row.updateTime).filter((time): time is number => time !== null);
    return {
      key,
      tournamentId: season.tournamentId,
      divisionIndex: fixture.divisionIndex,
      divisionTitle: title(fixture.divisionIndex),
      lsid: fixture.lsid,
      title: fixture.title,
      teams,
      state,
      official,
      counted,
      officialAvg: [result?.get(teams[0].id)?.avg ?? null, result?.get(teams[1].id)?.avg ?? null],
      games: cardGames,
      playedFrom: starts.length ? Math.min(...starts) : null,
      playedTo: starts.length ? Math.max(...starts) : null,
      updatedAt: updates.length ? Math.max(...updates) : null,
      tmid: rows[0]?.tmid ?? null,
    };
  });
}

/** The score to show and whose it is: n01's official score, else League Order's count. */
export function cardScore(card: MatchCard): { score: [number, number]; source: 'official' | 'counted' } | null {
  if (card.official) return { score: card.official, source: 'official' };
  if (card.state === 'scheduled') return null;
  return { score: card.counted, source: 'counted' };
}

/** Card outcome for one team: 'W' | 'D' | 'L', only from an official result. */
export function cardOutcome(card: MatchCard, teamId: string): 'W' | 'D' | 'L' | null {
  if (!card.official) return null;
  const side = card.teams[0].id === teamId ? 0 : card.teams[1].id === teamId ? 1 : null;
  if (side === null) return null;
  const mine = card.official[side];
  const theirs = card.official[1 - side];
  return mine > theirs ? 'W' : mine < theirs ? 'L' : 'D';
}

export const CARD_STATE_LABELS: Record<CardState, string> = {
  official: '結果確定 (n01)',
  live: '進行中',
  unrecorded: '結果未入力',
  scheduled: '未開催',
};

export const GAME_STATE_LABELS: Record<GameState, string> = {
  finished: '終了',
  live: '進行中',
  notPlayed: '未実施',
};

/** `Team 1001`, `Doubles 501`, `Singles Cricket` from the slot. */
export function slotKindLabel(slot: SeasonSlot): string {
  const people = slot.numPart === 1 ? 'Singles' : slot.numPart === 2 ? 'Doubles' : slot.numPart === 3 ? 'Trios' : /gallon|ガロン/iu.test(slot.label) ? 'Gallon' : 'Team';
  const game = slot.matchType === 'cricket' ? 'Cricket' : slot.startScore ? String(slot.startScore) : '01';
  return `${people} ${game}`;
}

export function slotStructure(slot: SeasonSlot): 'SINGLES' | 'DOUBLES' | 'TRIOS' | 'GALLON' | 'TEAM' {
  if (/gallon|ガロン/iu.test(slot.label)) return 'GALLON';
  return slot.numPart === 1 ? 'SINGLES' : slot.numPart === 2 ? 'DOUBLES' : slot.numPart === 3 ? 'TRIOS' : 'TEAM';
}
