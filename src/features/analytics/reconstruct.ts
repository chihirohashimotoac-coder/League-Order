import type { RawGameDetail } from './api/parse';
import type { ClassifiedGame } from './roleGames';
import type { StatLine } from './types';

/**
 * Per-player figures of a doubles / trios / team game, rebuilt from its legs (`match/get`),
 * and accepted only when they add up to n01's own season totals for that player.
 *
 * n01 stores a leg as the *side's* visits; which partner threw a visit is not written. The
 * attribution rule below is the one that reproduces n01's own player totals exactly
 * (ATDO 2024 2nd, `realData.roles.test.ts`):
 *  - inside a side, visits rotate through the players in `order[]`, restarting from
 *    `order[0]` at every leg (continuing across legs, or alternating the starter, does not
 *    match n01's totals);
 *  - every recorded visit counts, including the 0-point rows a scorer leaves at the start of a
 *    leg (n01 counts their darts too);
 *  - a negative score is a checkout with |score| darts (1–3); its points are what was left;
 *  - First 9 = the side's first three visits of a leg, credited to whoever threw them;
 *  - 100+ / 140+ / 170+ / 180 are exclusive bands (100–139, 140–169, 170–179, 180).
 *
 * The rule is n01's convention, not a record of who really threw: if a pair swapped their
 * order in a leg without it being recorded, n01's totals and this reconstruction share that
 * error, and the season checksum cannot reveal it. When the checksum fails, nothing is shown.
 */

export interface Contribution {
  score: number;
  darts: number;
  f9Score: number;
  f9Darts: number;
  ton00: number;
  ton40: number;
  ton70: number;
  ton80: number;
  /** Largest checkout, `null` when the player finished no leg in this game. */
  highOut: number | null;
  /** Legs of this game in which the player's side threw second (Break opportunities), and those won. */
  breakLegs: number;
  breakWins: number;
  /** Fewest darts in a leg the player's side won, singles only (`null` otherwise / none won). */
  bestLeg: number | null;
}

export type GameReconstruction =
  | { gameId: string; ok: true; startScore: number | null; perPlayer: Record<string, Contribution> }
  | { gameId: string; ok: false; reason: string };

function emptyContribution(): Contribution {
  return { score: 0, darts: 0, f9Score: 0, f9Darts: 0, ton00: 0, ton40: 0, ton70: 0, ton80: 0, highOut: null, breakLegs: 0, breakWins: 0, bestLeg: null };
}

export function reconstructGame(detail: RawGameDetail): GameReconstruction {
  const fail = (reason: string): GameReconstruction => ({ gameId: detail.gameId, ok: false, reason });
  if (!detail.finished) return fail('未終了のゲームです');
  if (detail.startScore === null || detail.startScore <= 0) return fail('開始点数が不明です');
  const perPlayer: Record<string, Contribution> = {};
  const sideTotals = [
    { score: 0, darts: 0 },
    { score: 0, darts: 0 },
  ];
  for (const side of detail.sides) {
    for (const player of side.players) {
      if (!player.oid) return fail('選手IDのない記録があります');
      perPlayer[player.oid] ??= emptyContribution();
    }
  }
  for (const leg of detail.legs) {
    if (leg.visits[0].length === 0 && leg.visits[1].length === 0) continue; // n01's trailing, unplayed leg row
    for (const sideIndex of [0, 1] as const) {
      const side = detail.sides[sideIndex];
      const order = side.players.map((p) => p.oid as string);
      let left = detail.startScore;
      let sideDarts = 0;
      leg.visits[sideIndex].forEach((visit, visitIndex) => {
        const thrower = perPlayer[order[visitIndex % order.length]];
        const checkout = visit.score < 0;
        const points = checkout ? left : visit.score;
        const darts = checkout ? -visit.score : 3;
        if (checkout && (darts > 3 || visit.left !== 0)) throw new ReconstructionError('チェックアウトの記録が不正です');
        thrower.score += points;
        thrower.darts += darts;
        sideDarts += darts;
        if (visitIndex < 3) {
          thrower.f9Score += points;
          thrower.f9Darts += darts;
        }
        if (points === 180) thrower.ton80 += 1;
        else if (points >= 170) thrower.ton70 += 1;
        else if (points >= 140) thrower.ton40 += 1;
        else if (points >= 100) thrower.ton00 += 1;
        if (checkout) thrower.highOut = Math.max(thrower.highOut ?? 0, points);
        left = visit.left;
        sideTotals[sideIndex].score += points;
        sideTotals[sideIndex].darts += darts;
      });
      if (leg.ended && leg.first !== null) {
        const second = leg.first !== sideIndex;
        for (const oid of order) {
          if (second) {
            perPlayer[oid].breakLegs += 1;
            if (leg.winner === sideIndex) perPlayer[oid].breakWins += 1;
          }
        }
      }
      if (leg.ended && leg.winner === sideIndex && order.length === 1) {
        const p = perPlayer[order[0]];
        p.bestLeg = p.bestLeg === null ? sideDarts : Math.min(p.bestLeg, sideDarts);
      }
    }
    if (leg.ended && leg.first === null) {
      for (const c of Object.values(perPlayer)) c.breakLegs = Number.NaN; // unknown starter: Break cannot be counted
    }
  }
  // The legs must add up to n01's own game totals, or the rows are not what we think they are.
  for (const sideIndex of [0, 1] as const) {
    const side = detail.sides[sideIndex];
    if (side.score !== sideTotals[sideIndex].score || side.darts !== sideTotals[sideIndex].darts) {
      return fail(`Leg明細の合計（${sideTotals[sideIndex].score}点/${sideTotals[sideIndex].darts}投）がゲームの合計（${side.score ?? '—'}点/${side.darts ?? '—'}投）と一致しません`);
    }
  }
  return { gameId: detail.gameId, ok: true, startScore: detail.startScore, perPlayer };
}

class ReconstructionError extends Error {}

/** {@link reconstructGame}, with malformed checkout rows turned into a failed reconstruction. */
export function safeReconstruct(detail: RawGameDetail): GameReconstruction {
  try {
    return reconstructGame(detail);
  } catch (error) {
    if (error instanceof ReconstructionError) return { gameId: detail.gameId, ok: false, reason: error.message };
    throw error;
  }
}

/** Fields that passed the season checksum for one player. */
export interface VerifiedFields {
  score: boolean;
  f9: boolean;
  tons: boolean;
  highOut: boolean;
  break: boolean;
}

export type SeasonCheckState = 'verified' | 'partly-verified' | 'mismatch' | 'incomplete' | 'no-games';

export interface SeasonCheck {
  tournamentId: string;
  oid: string;
  state: SeasonCheckState;
  /** 01 games of the player in the season, and how many have a reconstruction. */
  games: number;
  reconstructed: number;
  verified: VerifiedFields;
  /** What was compared, for the details panel: [reconstructed, official]. */
  compared: { score: [number, number | null]; darts: [number, number | null]; f9Score: [number, number | null]; f9Darts: [number, number | null] } | null;
  reason?: string;
}

const NONE: VerifiedFields = { score: false, f9: false, tons: false, highOut: false, break: false };

/**
 * Checks one player's season: the reconstructed totals over **all** their 01 games of the
 * season must equal n01's season totals for the player. Singles games may use the game row's
 * own score/darts (exact) when not reconstructed; every other field needs every game rebuilt.
 *
 * `official` must be a line whose score/darts/First 9/tons are 01-only (all seasons whose
 * slots are 01, and Cricket-mixed seasons — n01 keeps Cricket apart). Break is compared only
 * when `breakComparable` (all-01 seasons), because n01's mixed-season Break may include Cricket.
 */
export function checkPlayerSeason(
  tournamentId: string,
  oid: string,
  official: StatLine,
  games: readonly ClassifiedGame[],
  reconstructions: ReadonlyMap<string, GameReconstruction>,
  breakComparable: boolean,
): SeasonCheck {
  const mine = games.filter((g) => g.family.family === '01' && g.sides.some((s) => s.players.some((p) => p.oid === oid)));
  if (mine.length === 0) return { tournamentId, oid, state: 'no-games', games: 0, reconstructed: 0, verified: NONE, compared: null };
  let score = 0;
  let darts = 0;
  let scoreKnown = true;
  const sum = { f9Score: 0, f9Darts: 0, ton00: 0, ton40: 0, ton70: 0, ton80: 0, breakLegs: 0, breakWins: 0 };
  let highOut: number | null = null;
  let reconstructed = 0;
  let allRebuilt = true;
  for (const game of mine) {
    const side = game.sides.find((s) => s.players.some((p) => p.oid === oid))!;
    const rebuilt = reconstructions.get(game.gameId);
    const c = rebuilt?.ok ? rebuilt.perPlayer[oid] : undefined;
    if (c) {
      reconstructed += 1;
      score += c.score;
      darts += c.darts;
      for (const key of Object.keys(sum) as (keyof typeof sum)[]) sum[key] += c[key];
      if (c.highOut !== null) highOut = Math.max(highOut ?? 0, c.highOut);
    } else {
      allRebuilt = false;
      if (side.players.length === 1 && side.score !== null && side.darts !== null) {
        score += side.score;
        darts += side.darts;
      } else scoreKnown = false;
    }
  }
  const compared = { score: [score, official.score] as [number, number | null], darts: [darts, official.darts] as [number, number | null], f9Score: [sum.f9Score, official.f9Score] as [number, number | null], f9Darts: [sum.f9Darts, official.f9Darts] as [number, number | null] };
  if (!scoreKnown) {
    return { tournamentId, oid, state: 'incomplete', games: mine.length, reconstructed, verified: NONE, compared: null, reason: `${mine.length}ゲーム中${reconstructed}ゲームのみLeg明細を取得済みです` };
  }
  const verified: VerifiedFields = {
    score: official.score === score && official.darts === darts,
    f9: allRebuilt && official.f9Score === sum.f9Score && official.f9Darts === sum.f9Darts,
    tons: allRebuilt && official.ton00 === sum.ton00 && official.ton40 === sum.ton40 && official.ton70 === sum.ton70 && official.ton80 === sum.ton80,
    highOut: allRebuilt && (official.highOut ?? null) === highOut,
    break: allRebuilt && breakComparable && Number.isFinite(sum.breakLegs) && official.breakLegs === sum.breakLegs && official.breakWins === sum.breakWins,
  };
  if (!verified.score) {
    return { tournamentId, oid, state: 'mismatch', games: mine.length, reconstructed, verified: NONE, compared, reason: `復元値 ${score}点/${darts}投 と n01公式 ${official.score ?? '—'}点/${official.darts ?? '—'}投 が一致しません` };
  }
  const all = verified.f9 && verified.tons && verified.highOut && verified.break;
  return { tournamentId, oid, state: all ? 'verified' : 'partly-verified', games: mine.length, reconstructed, verified, compared };
}

/** Per game, per player: only the fields that passed the season checksum. */
export type VerifiedContribution = Partial<Omit<Contribution, 'bestLeg'>> & { bestLeg?: number | null };
export type PlayerContributions = Map<string, Map<string, VerifiedContribution>>;

/** Adds one verified player-season's per-game figures to `into`. */
export function addVerified(into: PlayerContributions, check: SeasonCheck, games: readonly ClassifiedGame[], reconstructions: ReadonlyMap<string, GameReconstruction>): void {
  if (!check.verified.score) return;
  for (const game of games) {
    const rebuilt = reconstructions.get(game.gameId);
    const c = rebuilt?.ok ? rebuilt.perPlayer[check.oid] : undefined;
    if (!c) continue;
    const v: VerifiedContribution = { score: c.score, darts: c.darts };
    if (check.verified.f9) Object.assign(v, { f9Score: c.f9Score, f9Darts: c.f9Darts });
    if (check.verified.tons) Object.assign(v, { ton00: c.ton00, ton40: c.ton40, ton70: c.ton70, ton80: c.ton80 });
    if (check.verified.highOut) v.highOut = c.highOut;
    if (check.verified.break) Object.assign(v, { breakLegs: c.breakLegs, breakWins: c.breakWins });
    const forGame = into.get(game.gameId) ?? new Map<string, VerifiedContribution>();
    forGame.set(check.oid, v);
    into.set(game.gameId, forGame);
  }
}

/** Best Leg per start score from reconstructed singles legs (501 and 1001 are never mixed). */
export function bestLegsByStart(oid: string, games: readonly ClassifiedGame[], reconstructions: ReadonlyMap<string, GameReconstruction>): Map<number, number> {
  const best = new Map<number, number>();
  for (const game of games) {
    const rebuilt = reconstructions.get(game.gameId);
    if (!rebuilt?.ok || rebuilt.startScore === null) continue;
    const c = rebuilt.perPlayer[oid];
    if (!c || c.bestLeg === null) continue;
    best.set(rebuilt.startScore, Math.min(best.get(rebuilt.startScore) ?? Infinity, c.bestLeg));
  }
  return best;
}
