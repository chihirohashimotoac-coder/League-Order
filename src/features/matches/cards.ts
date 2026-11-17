import type { Fixture, GameRow, LiveState, SeasonDocument, SeasonSlot } from './parse';
import { gameRowOfLive, parseLeagueTmid, slotsFor } from './parse';

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
    const cardGames: CardGame[] = slotsFor(season, fixture.divisionIndex).map((slot) => {
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

/**
 * The card as n01's live states of it say it is now, over the season's (slower) game list:
 * `states` holds the last live state seen of each of its games (by `schid`), `latest` the one
 * the live poller is on. A game the list does not hold yet, or holds as less far on, is shown
 * from its live state; a game the list still has in progress is over once the card has moved
 * on to another game or ended. The card ends with `end_schedule` (`cardEnded`) only — a game
 * ending is not the card ending — and its score is n01's count of games won (`sets` of a team
 * schedule) while it has one. n01's official result, when the list has it, is kept as it is.
 */
export function cardWithLive(card: MatchCard, states: ReadonlyMap<string, LiveState>, latest: LiveState | null): MatchCard {
  if (!latest || card.official) return card;
  const games = card.games.map((entry): CardGame => {
    const state = states.get(entry.slot.schid);
    const row = entry.game;
    const ahead = state !== undefined && (!row || row.mid !== state.mid || !row.finished || row.updateTime === null || state.updateTime > row.updateTime);
    // Over: n01 said so, or it has moved on from this game, or the card is over.
    const over = (mid: string): boolean => latest.cardEnded || latest.mid !== mid;
    if (!ahead || !state) {
      return entry.state === 'live' && row && over(row.mid) ? { ...entry, state: 'finished' } : entry;
    }
    const flip = state.sides[0].teamId === card.teams[1].id;
    const pick = <T>(pair: readonly [T, T]): [T, T] => (flip ? [pair[1], pair[0]] : [pair[0], pair[1]]);
    const ended = state.gameEnded || over(state.mid);
    const legs = pick(state.legs);
    const winner = state.gameEnded && legs[0] !== legs[1] ? (legs[0] > legs[1] ? 0 : 1) : null;
    const same = row?.mid === state.mid;
    return {
      ...entry,
      state: ended ? 'finished' : 'live',
      game: { ...(same && row ? { ...row, sides: gameRowOfLive(state).sides.map((side, i) => ({ ...row.sides[i], legsWon: side.legsWon })) as GameRow['sides'] } : gameRowOfLive(state)), finished: ended },
      winner,
      legs,
      rate: same ? entry.rate : [null, null],
      members: pick([state.sides[0].members, state.sides[1].members]),
      flip,
    };
  });
  const counted: [number, number] = [0, 0];
  for (const game of games) if (game.winner !== null) counted[game.winner] += 1;
  const latestFlip = latest.sides[0].teamId === card.teams[1].id;
  const won: [number, number] = latest.isSchedule ? (latestFlip ? [latest.sets[1], latest.sets[0]] : [latest.sets[0], latest.sets[1]]) : counted;
  const state: CardState = latest.cardEnded ? 'unrecorded' : 'live';
  return { ...card, games, counted: won, state, updatedAt: Math.max(card.updatedAt ?? 0, latest.updateTime) };
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
