import type { MatchCard } from './cards';
import { slotStructure } from './cards';
import { teamProfile } from './insights';
import type { GameRow, SeasonDocument, SeasonSlot } from './parse';
import type { CardOutlook, GameOutlook } from './probability';
import { cardOutlook, log5, shrunk } from './probability';

/**
 * The card estimate game by game (カード勝率の推移): the estimate before the first game, then
 * after each game in the order the games ended, and (live) now. The game that moved it most is
 * the one where the card turned.
 *
 * Each game's chance comes from the two teams' season win rates by kind, without this card's
 * own games (they are counted as results, not again as form).
 */

export interface SlotChances {
  chance: Map<string, number>;
  /** Games behind the two teams' rates, to flag a thin basis. */
  seasonGames: number;
}

export function slotChances(
  season: SeasonDocument,
  cards: readonly MatchCard[],
  games: readonly GameRow[],
  teams: [string, string],
  exclude: ReadonlySet<string>,
  slots: readonly SeasonSlot[],
): SlotChances {
  const pool = games.filter((game) => !exclude.has(game.mid));
  const a = teamProfile(season, cards, pool, teams[0]);
  const b = teamProfile(season, cards, pool, teams[1]);
  const chance = new Map(slots.map((slot) => [slot.schid, log5(shrunk(a.byStructure[slotStructure(slot)]), shrunk(b.byStructure[slotStructure(slot)]))]));
  const count = (profile: typeof a): number => Object.values(profile.byStructure).reduce((sum, record) => sum + record.games, 0);
  return { chance, seasonGames: count(a) + count(b) };
}

export interface GameResult {
  schid: string;
  /** Card side that won. */
  winner: 0 | 1;
  endedAt: number | null;
}

export interface TrailStep {
  /** The game just decided (`null` before the first game and for the live step). */
  schid: string | null;
  winner: 0 | 1 | null;
  live: boolean;
  outlook: CardOutlook;
}

export function outlookTrail(
  slots: readonly { schid: string }[],
  chance: ReadonlyMap<string, number>,
  results: readonly GameResult[],
  live: { schid: string; legs: [number, number]; need: number } | null = null,
): TrailStep[] {
  const slotIndex = new Map(slots.map((slot, index) => [slot.schid, index]));
  const ordered = [...results].sort((x, y) => (x.endedAt ?? Infinity) - (y.endedAt ?? Infinity) || (slotIndex.get(x.schid) ?? 0) - (slotIndex.get(y.schid) ?? 0));
  const at = (done: readonly GameResult[], withLive: boolean): CardOutlook =>
    cardOutlook(
      slots.map((slot): GameOutlook => {
        const result = done.find((entry) => entry.schid === slot.schid);
        if (result) return { state: 'done', winner: result.winner };
        const p = chance.get(slot.schid) ?? 0.5;
        if (withLive && live && live.schid === slot.schid) return { state: 'live', p, legs: live.legs, need: live.need };
        return { state: 'todo', p };
      }),
    );
  const steps: TrailStep[] = [{ schid: null, winner: null, live: false, outlook: at([], false) }];
  ordered.forEach((result, index) => steps.push({ schid: result.schid, winner: result.winner, live: false, outlook: at(ordered.slice(0, index + 1), false) }));
  if (live && !ordered.some((entry) => entry.schid === live.schid)) steps.push({ schid: live.schid, winner: null, live: true, outlook: at(ordered, true) });
  return steps;
}

/** The decided game that moved side 0's win chance most, and by how much (at least 5 points). */
export function biggestSwing(steps: readonly TrailStep[]): { index: number; from: number; to: number } | null {
  let best: { index: number; from: number; to: number } | null = null;
  steps.forEach((step, index) => {
    if (index === 0 || step.live) return;
    const from = steps[index - 1].outlook.win;
    const to = step.outlook.win;
    if (Math.abs(to - from) >= 0.05 && (!best || Math.abs(to - from) > Math.abs(best.to - best.from))) best = { index, from, to };
  });
  return best;
}
