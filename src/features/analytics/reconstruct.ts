import type { RawGameDetail } from './api/parse';
import type { ClassifiedGame } from './roleGames';
import { startTallyOf } from './startRate';
import type { GameStartTally } from './startRate';
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
  | {
      gameId: string;
      ok: true;
      startScore: number | null;
      perPlayer: Record<string, Contribution>;
      /**
       * Per side (0/1), the side's own First 9 and Break — figures of the pair / team as a whole, not
       * of a thrower, so they need no attribution (a side without its order has them too). Absent on
       * reconstructions cached before it existed: derived from {@link perPlayer} then ({@link sideFiguresOf}).
       */
      sides?: [SideFigures, SideFigures];
      /**
       * Start attempts per player (`startRate.ts`). Absent on reconstructions cached before it
       * existed: "not counted yet", never 0/0. `null` when the legs cannot be read that way.
       */
      start?: GameStartTally | null;
    }
  | { gameId: string; ok: false; reason: string };

/** A side's First 9 (its first three visits of every leg) and Break (legs thrown second, and won). */
export interface SideFigures {
  f9Score: number;
  f9Darts: number;
  /** `NaN` when a leg's starter is unknown. */
  breakLegs: number;
  breakWins: number;
}

/** A side's figures of a rebuilt game, or `null` when they cannot be told (an old entry of a side without its order). */
export function sideFiguresOf(rebuilt: Extract<GameReconstruction, { ok: true }>, sideIndex: 0 | 1, oids: readonly (string | null)[]): SideFigures | null {
  if (rebuilt.sides) return rebuilt.sides[sideIndex];
  if (oids.length === 0 || oids.some((oid) => !oid || !rebuilt.perPlayer[oid])) return null;
  const players = oids.map((oid) => rebuilt.perPlayer[oid as string]);
  return { f9Score: players.reduce((a, c) => a + c.f9Score, 0), f9Darts: players.reduce((a, c) => a + c.f9Darts, 0), breakLegs: players[0].breakLegs, breakWins: players[0].breakWins };
}

function emptyContribution(): Contribution {
  return { score: 0, darts: 0, f9Score: 0, f9Darts: 0, ton00: 0, ton40: 0, ton70: 0, ton80: 0, highOut: null, breakLegs: 0, breakWins: 0, bestLeg: null };
}

export function reconstructGame(detail: RawGameDetail): GameReconstruction {
  const fail = (reason: string): GameReconstruction => ({ gameId: detail.gameId, ok: false, reason });
  if (!detail.finished) return fail('未終了のゲームです');
  if (detail.startScore === null || detail.startScore <= 0) return fail('開始点数が不明です');
  if (detail.sides.every((side) => side.players.length === 0)) return fail('両チームの投順がありません');
  const perPlayer: Record<string, Contribution> = {};
  const sideTotals = [
    { score: 0, darts: 0 },
    { score: 0, darts: 0 },
  ];
  const sideFigures: [SideFigures, SideFigures] = [
    { f9Score: 0, f9Darts: 0, breakLegs: 0, breakWins: 0 },
    { f9Score: 0, f9Darts: 0, breakLegs: 0, breakWins: 0 },
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
      // A side whose throwing order n01 left out: its visits still add up to its total, but are
      // credited to nobody (the other side is rebuilt as usual).
      const unattributed = order.length === 0;
      let left = detail.startScore;
      let sideDarts = 0;
      leg.visits[sideIndex].forEach((visit, visitIndex) => {
        const thrower = unattributed ? emptyContribution() : perPlayer[order[visitIndex % order.length]];
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
          sideFigures[sideIndex].f9Score += points;
          sideFigures[sideIndex].f9Darts += darts;
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
      if (leg.ended && leg.first !== null && leg.first !== sideIndex) {
        sideFigures[sideIndex].breakLegs += 1;
        if (leg.winner === sideIndex) sideFigures[sideIndex].breakWins += 1;
      }
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
      for (const f of sideFigures) f.breakLegs = Number.NaN;
    }
  }
  // The legs must add up to n01's own game totals, or the rows are not what we think they are.
  for (const sideIndex of [0, 1] as const) {
    const side = detail.sides[sideIndex];
    if (side.score !== sideTotals[sideIndex].score || side.darts !== sideTotals[sideIndex].darts) {
      return fail(`Leg明細の合計（${sideTotals[sideIndex].score}点/${sideTotals[sideIndex].darts}投）がゲームの合計（${side.score ?? '—'}点/${side.darts ?? '—'}投）と一致しません`);
    }
  }
  return { gameId: detail.gameId, ok: true, startScore: detail.startScore, perPlayer, sides: sideFigures, start: startTallyOf(detail) };
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
  /** Score / darts of the games n01 counts in its averages (`ignore_avg` slots left out). */
  score: boolean;
  /** First 9 of the same games. */
  f9: boolean;
  /** 100+–180 of every 01 game (n01 counts them in `ignore_avg` slots too). */
  tons: boolean;
  highOut: boolean;
  /** Break of every 01 game. */
  break: boolean;
  /**
   * The games n01 leaves out of its averages (`ignore_avg`) cannot be checked against its score /
   * darts. Their per-player figures are admitted when every 01 game was rebuilt, each game's legs add
   * up to its row, and the totals n01 does keep over all games (100+–180, High Finish) and the
   * averaged games' score / darts all match. Absent / false otherwise.
   */
  outsideAvg?: boolean;
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
  /** What was compared, for the details panel: [reconstructed, official] (score / darts / First 9 over the averaged games). */
  compared: { score: [number, number | null]; darts: [number, number | null]; f9Score: [number, number | null]; f9Darts: [number, number | null] } | null;
  /** Games of the player n01 leaves out of its averages (`ignore_avg`): not in {@link compared}. */
  avgExcludedGames?: number;
  /** The player's singles games and how many have legs: their figures do not depend on the checksum. */
  singles?: { games: number; rebuilt: number };
  /**
   * Whether the per-player figures of the player's multi-thrower games are admitted (score / darts
   * and First 9), each kind of game by its own evidence. Absent: no such game.
   */
  multi?: { score: boolean; f9: boolean };
  /** Not checked because of how n01 recorded the season (a retry cannot change it). */
  byRecord?: boolean;
  reason?: string;
}

const NONE: VerifiedFields = { score: false, f9: false, tons: false, highOut: false, break: false };

const isSinglesOf = (game: Pick<ClassifiedGame, 'sides'>, oid: string): boolean => game.sides.some((s) => s.players.length === 1 && s.players[0].oid === oid);

/**
 * Checks one player's season against n01's season totals, **each metric over the games n01 counts
 * in it**: score / darts / First 9 over the games of slots n01 keeps in its averages (all of them
 * when no slot has `ignore_avg`), 100+–180, High Finish and Break over every 01 game. Singles games
 * may use the game row's own score/darts (exact) when not reconstructed.
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
  const f9 = { f9Score: 0, f9Darts: 0 };
  const all = { ton00: 0, ton40: 0, ton70: 0, ton80: 0, breakLegs: 0, breakWins: 0 };
  let highOut: number | null = null;
  let reconstructed = 0;
  let allRebuilt = true;
  let averagedRebuilt = true;
  let excluded = 0;
  let singlesGames = 0;
  let singlesRebuilt = 0;
  let includedMulti = 0;
  let excludedMulti = 0;
  for (const game of mine) {
    const side = game.sides.find((s) => s.players.some((p) => p.oid === oid))!;
    const rebuilt = reconstructions.get(game.gameId);
    const c = rebuilt?.ok ? rebuilt.perPlayer[oid] : undefined;
    const averaged = game.avgExcluded !== true;
    const singles = side.players.length === 1;
    if (singles) singlesGames += 1;
    else if (averaged) includedMulti += 1;
    else excludedMulti += 1;
    if (!averaged) excluded += 1;
    if (c) {
      reconstructed += 1;
      if (singles) singlesRebuilt += 1;
      if (averaged) {
        score += c.score;
        darts += c.darts;
        f9.f9Score += c.f9Score;
        f9.f9Darts += c.f9Darts;
      }
      for (const key of Object.keys(all) as (keyof typeof all)[]) all[key] += c[key];
      if (c.highOut !== null) highOut = Math.max(highOut ?? 0, c.highOut);
    } else {
      allRebuilt = false;
      if (!averaged) continue;
      averagedRebuilt = false;
      if (singles && side.score !== null && side.darts !== null) {
        score += side.score;
        darts += side.darts;
      } else scoreKnown = false;
    }
  }
  const compared = { score: [score, official.score] as [number, number | null], darts: [darts, official.darts] as [number, number | null], f9Score: [f9.f9Score, official.f9Score] as [number, number | null], f9Darts: [f9.f9Darts, official.f9Darts] as [number, number | null] };
  const extra = { avgExcludedGames: excluded, singles: { games: singlesGames, rebuilt: singlesRebuilt } };
  if (!scoreKnown) {
    return { tournamentId, oid, state: 'incomplete', games: mine.length, reconstructed, verified: NONE, compared: null, ...extra, reason: `${mine.length}ゲーム中${reconstructed}ゲームのみLeg明細を取得済みです` };
  }
  // No averaged game at all: n01's averaged totals are then empty (0 / absent).
  const averagedNone = mine.length === excluded;
  const scoreOk = averagedNone ? (official.score ?? 0) === 0 && (official.darts ?? 0) === 0 : official.score === score && official.darts === darts;
  const f9Ok = averagedNone ? (official.f9Score ?? 0) === 0 && (official.f9Darts ?? 0) === 0 : official.f9Score === f9.f9Score && official.f9Darts === f9.f9Darts;
  const verified: VerifiedFields = {
    score: scoreOk,
    f9: averagedRebuilt && f9Ok,
    tons: allRebuilt && official.ton00 === all.ton00 && official.ton40 === all.ton40 && official.ton70 === all.ton70 && official.ton80 === all.ton80,
    highOut: allRebuilt && (official.highOut ?? null) === highOut,
    break: allRebuilt && breakComparable && Number.isFinite(all.breakLegs) && official.breakLegs === all.breakLegs && official.breakWins === all.breakWins,
  };
  if (excluded > 0) verified.outsideAvg = allRebuilt && scoreOk && verified.tons && verified.highOut;
  const multi =
    includedMulti + excludedMulti > 0
      ? {
          score: (includedMulti === 0 || verified.score) && (excludedMulti === 0 || verified.outsideAvg === true),
          f9: (includedMulti === 0 || verified.f9) && (excludedMulti === 0 || verified.outsideAvg === true),
        }
      : undefined;
  const excludedNote = excluded > 0 ? `n01の平均の対象外（ignore_avg）の${excluded}ゲームは得点・投数・First 9の照合に含めていません` : undefined;
  if (!verified.score) {
    return { tournamentId, oid, state: 'mismatch', games: mine.length, reconstructed, verified: NONE, compared, ...extra, ...(multi ? { multi: { score: false, f9: false } } : {}), reason: `復元値 ${score}点/${darts}投 と n01公式 ${official.score ?? '—'}点/${official.darts ?? '—'}投 が一致しません${excludedNote ? `（${excludedNote}）` : ''}` };
  }
  const every = verified.f9 && verified.tons && verified.highOut && verified.break && (excluded === 0 || verified.outsideAvg === true);
  return { tournamentId, oid, state: every ? 'verified' : 'partly-verified', games: mine.length, reconstructed, verified, compared, ...extra, ...(multi ? { multi } : {}), ...(excludedNote ? { reason: excludedNote } : {}) };
}

/** Per game, per player: only the fields that passed the season checksum. */
export type VerifiedContribution = Partial<Omit<Contribution, 'bestLeg'>> & { bestLeg?: number | null };
export type PlayerContributions = Map<string, Map<string, VerifiedContribution>>;

/**
 * Adds one player-season's per-game figures to `into`, each field by its own evidence:
 *  - a **singles** game: every field, from its legs alone — one thrower, and the legs add up to
 *    the game's row (a reconstruction is only passed in when they do). Another kind of game failing
 *    the checksum does not hold it back;
 *  - a multi-thrower game: score / darts and First 9 when the attribution was admitted for that
 *    kind of game ({@link SeasonCheck.multi}); 100+–180 and High Finish when they matched n01's
 *    totals; Break from the legs (a side's figure, credited to each partner as n01 does).
 */
export function addVerified(into: PlayerContributions, check: SeasonCheck, games: readonly ClassifiedGame[], reconstructions: ReadonlyMap<string, GameReconstruction>): void {
  for (const game of games) {
    const rebuilt = reconstructions.get(game.gameId);
    const c = rebuilt?.ok ? rebuilt.perPlayer[check.oid] : undefined;
    if (!c) continue;
    let v: VerifiedContribution;
    if (isSinglesOf(game, check.oid)) {
      v = { score: c.score, darts: c.darts, f9Score: c.f9Score, f9Darts: c.f9Darts, ton00: c.ton00, ton40: c.ton40, ton70: c.ton70, ton80: c.ton80, highOut: c.highOut, bestLeg: c.bestLeg };
      if (Number.isFinite(c.breakLegs)) Object.assign(v, { breakLegs: c.breakLegs, breakWins: c.breakWins });
    } else {
      const averaged = game.avgExcluded !== true;
      const scoreOk = averaged ? check.verified.score : check.verified.outsideAvg === true;
      const f9Ok = averaged ? check.verified.f9 : check.verified.outsideAvg === true;
      v = {};
      if (scoreOk) Object.assign(v, { score: c.score, darts: c.darts });
      if (scoreOk && f9Ok) Object.assign(v, { f9Score: c.f9Score, f9Darts: c.f9Darts });
      if (check.verified.tons) Object.assign(v, { ton00: c.ton00, ton40: c.ton40, ton70: c.ton70, ton80: c.ton80 });
      if (check.verified.highOut) v.highOut = c.highOut;
      if (Number.isFinite(c.breakLegs)) Object.assign(v, { breakLegs: c.breakLegs, breakWins: c.breakWins });
    }
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
