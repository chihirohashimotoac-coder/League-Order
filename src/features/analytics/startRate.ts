import type { RawGameDetail, RawVisit } from './api/parse';

/**
 * 個人スタート率（ダブルイン）: per player, the throws that started the pair out of the throws
 * the player actually threw while the pair had not started yet.
 *
 *   個人スタート率 = 本人がペアをスタートさせたスロー数 ÷ ペアが未スタートの状態で本人が投げた、判定可能なスロー数
 *
 * One throw (visit, up to 3 darts) is one attempt. Not n01's figure: it is counted here from the
 * leg detail (`match/get`), and only for slots whose in-rule is confirmed (`startRule.ts`).
 *
 * Per leg and per side the pair starts "not started"; its visits are read in order:
 *  - visit with score 0 and the start score still left → a failed attempt;
 *  - the first visit with points that brings the score below the start score → the success;
 *    the side's later visits are not attempts;
 *  - anything else before the start (a checkout, points that do not match the rest, a left that
 *    moved without points) → the record cannot be read as start attempts: the side's leg is
 *    left out (never turned into failures).
 * The row n01 writes before the first visit (`{score: 0, left: start}`) is not a visit
 * (`parseGameDetail` drops it). A 0 recorded as a visit is a real throw and fails: n01 itself
 * counts it (its darts are in the season totals the reconstruction is checked against), and in
 * the TDO 2026/3rd example its high-in record names the partner who threw *after* that 0.
 *
 * The thrower of a visit follows n01's registered order restarting at `order[0]` each leg — the
 * rule `reconstruct.ts` verified against n01's season totals. A pair that swapped its order
 * without recording it cannot be detected (n01's own figures share that error).
 */

export const START_TALLY_VERSION = 1;

export type StartLegExclusion = 'unfinished' | 'middle-unstarted' | 'unreadable';

export const START_LEG_EXCLUSION_LABEL: Record<StartLegExclusion, string> = {
  unfinished: '未終了のLeg',
  'middle-unstarted': 'スタートしないまま投てき以外（ミドル等）で決着し、試行を確定できないLeg',
  unreadable: '残点・得点の記録の連続性を確認できないLeg',
};

export interface PlayerStartCount {
  attempts: number;
  successes: number;
}

export interface SideStartLegs {
  /** Legs of this side whose attempts were read. */
  legs: number;
  excluded: Partial<Record<StartLegExclusion, number>>;
}

/** One successful start: when (the leg's `time`), who, and with how many points. */
export interface StartHit {
  time: number | null;
  oid: string;
  score: number;
}

export interface GameStartTally {
  v: typeof START_TALLY_VERSION;
  /** Every listed player of both sides, `0/0` when they never threw before their pair started. */
  perPlayer: Record<string, PlayerStartCount>;
  sides: [SideStartLegs, SideStartLegs];
  hits: StartHit[];
  /** `time` of every played leg (to match n01's high-in records to a leg of this game). */
  legTimes: number[];
}

type SideOutcome = { kind: 'read'; attempts: { oid: string; success: boolean }[]; hit: StartHit | null } | { kind: 'excluded'; reason: StartLegExclusion };

/** The other side ended the leg with a recorded checkout (it was won by a throw). */
function closedByCheckout(opponent: readonly RawVisit[]): boolean {
  const last = opponent[opponent.length - 1];
  return !!last && last.score < 0 && last.left === 0;
}

function readSide(visits: readonly RawVisit[], start: number, order: readonly string[], legEnded: boolean, middle: boolean, time: number | null, opponentCheckedOut: boolean): SideOutcome {
  if (!legEnded) return { kind: 'excluded', reason: 'unfinished' };
  const attempts: { oid: string; success: boolean }[] = [];
  for (let i = 0; i < visits.length; i += 1) {
    const visit = visits[i];
    const oid = order[i % order.length];
    if (visit.score === 0 && visit.left === start) {
      attempts.push({ oid, success: false });
      continue;
    }
    if (visit.score > 0 && visit.left === start - visit.score && visit.left > 0) {
      attempts.push({ oid, success: true });
      return { kind: 'read', attempts, hit: { time, oid, score: visit.score } };
    }
    return { kind: 'excluded', reason: 'unreadable' };
  }
  // Never started. Every throw failed only when the other side won the leg with a checkout. A
  // leg decided otherwise — the bull-off (`middleForDiddle`), or a record that gives the leg to a
  // side that never started (ATDO 2024 2nd, a leg of 15 rounds without a point) — may hold rows
  // that are not throws: the side's leg is left out, never counted as failures.
  if (visits.length > 0 && (middle || !opponentCheckedOut)) return { kind: 'excluded', reason: 'middle-unstarted' };
  return { kind: 'read', attempts, hit: null };
}

/**
 * Start attempts of one game, or `null` when it cannot be read at all (no start score, a
 * player without id). Whether the game's rule is double-in is decided elsewhere.
 */
export function startTallyOf(detail: RawGameDetail): GameStartTally | null {
  const start = detail.startScore;
  if (start === null || start <= 0) return null;
  const orders = detail.sides.map((side) => side.players.map((p) => p.oid));
  if (orders.some((order) => order.length === 0 || order.some((oid) => !oid))) return null;
  const perPlayer: Record<string, PlayerStartCount> = {};
  for (const order of orders) for (const oid of order) perPlayer[oid as string] ??= { attempts: 0, successes: 0 };
  const sides: [SideStartLegs, SideStartLegs] = [
    { legs: 0, excluded: {} },
    { legs: 0, excluded: {} },
  ];
  const hits: StartHit[] = [];
  const legTimes: number[] = [];
  for (const leg of detail.legs) {
    if (leg.visits[0].length === 0 && leg.visits[1].length === 0) continue; // n01's trailing, unplayed leg row
    if (typeof leg.time === 'number') legTimes.push(leg.time);
    for (const sideIndex of [0, 1] as const) {
      const opponent = leg.visits[sideIndex === 0 ? 1 : 0];
      const opponentCheckedOut = leg.winner === (sideIndex === 0 ? 1 : 0) && closedByCheckout(opponent);
      const outcome = readSide(leg.visits[sideIndex], start, orders[sideIndex] as string[], leg.ended, leg.middle === true, leg.time ?? null, opponentCheckedOut);
      if (outcome.kind === 'excluded') {
        sides[sideIndex].excluded[outcome.reason] = (sides[sideIndex].excluded[outcome.reason] ?? 0) + 1;
        continue;
      }
      sides[sideIndex].legs += 1;
      for (const a of outcome.attempts) {
        perPlayer[a.oid].attempts += 1;
        if (a.success) perPlayer[a.oid].successes += 1;
      }
      if (outcome.hit) hits.push(outcome.hit);
    }
  }
  return { v: START_TALLY_VERSION, perPlayer, sides, hits, legTimes };
}

/** A start tally as read from the cache: anything else (an older entry without it) is "missing", never 0/0. */
export function isStartTally(value: unknown): value is GameStartTally {
  return typeof value === 'object' && value !== null && (value as { v?: unknown }).v === START_TALLY_VERSION && typeof (value as { perPlayer?: unknown }).perPlayer === 'object';
}

// ---- one player over a season / a period ------------------------------------------------

/** Why a doubles game of the player is not counted (shown in the breakdown). */
export type StartGameExclusion =
  | 'rule-unknown'
  | 'straight-in'
  | 'order-unverified'
  | 'order-conflict'
  | 'not-fetched'
  | 'unreadable'
  | 'needs-refetch';

export const START_GAME_EXCLUSION_LABEL: Record<StartGameExclusion, string> = {
  'rule-unknown': 'イン規則を確認できないゲーム枠',
  'straight-in': 'ストレートインのゲーム枠（対象外）',
  'order-unverified': '投順の帰属をn01公式値で確認できていない季',
  'order-conflict': '投順がn01のハイイン記録と一致しないゲーム',
  'not-fetched': 'Leg明細を取得できていないゲーム',
  unreadable: 'Leg明細の合計がゲームの記録と一致しないゲーム',
  'needs-refetch': '保存済みの明細にスタート集計がなく、再取得できなかったゲーム',
};

export interface SeasonStart {
  tournamentId: string;
  title: string;
  /** The player's doubles 01 games in the season (`null`: the game list is not complete). */
  doublesGames: number | null;
  /** Games whose attempts are counted. */
  counted: number;
  attempts: number;
  successes: number;
  /** The player's side: legs read, and legs left out by reason (counted games only). */
  legs: number;
  excludedLegs: Partial<Record<StartLegExclusion, number>>;
  excludedGames: Partial<Record<StartGameExclusion, number>>;
  /** The season could not be examined at all (game list missing, budget, …). */
  seasonReason?: string;
  /** Reasons of the rule verdicts behind `rule-unknown`, for the breakdown. */
  ruleNotes: string[];
  /** n01 high-in records that name the same player and points as the start counted here. */
  highInAgreements: number;
}

export type PeriodStartState = 'value' | 'no-trials' | 'no-games' | 'rule-unknown' | 'unavailable';

export interface PeriodStart {
  state: PeriodStartState;
  attempts: number;
  successes: number;
  /** successes / attempts; `null` unless `state === 'value'`. */
  value: number | null;
  /** Some games, legs or seasons of the player were left out. */
  partial: boolean;
  counted: number;
  doublesGames: number;
  excludedGames: Partial<Record<StartGameExclusion, number>>;
  excludedLegs: Partial<Record<StartLegExclusion, number>>;
  /** Seasons that could not be examined, with why. */
  seasonsMissing: { title: string; reason: string }[];
  ruleNotes: string[];
  /** Starts counted here that n01's own high-in records confirm (same player, same points). */
  highInAgreements: number;
  reason?: string;
}

function addInto<K extends string>(into: Partial<Record<K, number>>, from: Partial<Record<K, number>>): void {
  for (const [key, n] of Object.entries(from) as [K, number][]) into[key] = (into[key] ?? 0) + n;
}

/** Σ successes / Σ attempts over the seasons; nothing is estimated for what was left out. */
export function periodStart(seasons: readonly SeasonStart[]): PeriodStart {
  const out: PeriodStart = { state: 'unavailable', attempts: 0, successes: 0, value: null, partial: false, counted: 0, doublesGames: 0, excludedGames: {}, excludedLegs: {}, seasonsMissing: [], ruleNotes: [], highInAgreements: 0 };
  for (const s of seasons) {
    out.attempts += s.attempts;
    out.successes += s.successes;
    out.counted += s.counted;
    out.doublesGames += s.doublesGames ?? 0;
    out.highInAgreements += s.highInAgreements;
    addInto(out.excludedGames, s.excludedGames);
    addInto(out.excludedLegs, s.excludedLegs);
    if (s.seasonReason) out.seasonsMissing.push({ title: s.title, reason: s.seasonReason });
    for (const note of s.ruleNotes) if (!out.ruleNotes.includes(note)) out.ruleNotes.push(note);
  }
  const leftOutGames = Object.values(out.excludedGames).reduce((a, b) => a + (b ?? 0), 0);
  const leftOutLegs = Object.values(out.excludedLegs).reduce((a, b) => a + (b ?? 0), 0);
  out.partial = leftOutGames > 0 || leftOutLegs > 0 || out.seasonsMissing.length > 0;
  if (out.doublesGames === 0 && out.seasonsMissing.length === 0) {
    return { ...out, state: 'no-games', partial: false, reason: 'この期間にダブルス01の出場がありません' };
  }
  if (out.counted === 0) {
    const onlyRule = leftOutGames > 0 && leftOutGames === (out.excludedGames['rule-unknown'] ?? 0) + (out.excludedGames['straight-in'] ?? 0) && out.seasonsMissing.length === 0;
    if (onlyRule) {
      const straight = (out.excludedGames['straight-in'] ?? 0) === leftOutGames;
      return { ...out, state: 'rule-unknown', reason: straight ? 'ストレートインのゲーム枠のみのため対象外です' : 'ダブルインと確認できたゲーム枠の出場がないため算出しません' };
    }
    return { ...out, state: 'unavailable', reason: out.seasonsMissing[0]?.reason ?? '判定できるLeg明細がないため算出しません' };
  }
  if (out.attempts === 0) return { ...out, state: 'no-trials', reason: 'ペアが未スタートの状態で投げた記録がないため、分母が0です' };
  return { ...out, state: 'value', value: out.successes / out.attempts };
}

/** 「50%・3/6スロー」 */
export function formatStart(start: Pick<PeriodStart, 'value' | 'successes' | 'attempts'>): { value: string; sample: string } {
  if (start.value === null) return { value: '—', sample: start.attempts > 0 ? `${start.successes}/${start.attempts}スロー` : '' };
  return { value: `${Math.round(start.value * 1000) / 10}%`, sample: `${start.successes}/${start.attempts}スロー` };
}
