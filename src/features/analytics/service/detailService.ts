import { describeN01Error } from '../../../integrations/n01/client';
import { N01_STATUS } from '../../../integrations/n01/types';
import { RequestBudgetError } from '../api/readApi';
import { TTL } from '../cache/analyticsCache';
import { addVerified, bestLegsByStart, checkPlayerSeason, safeReconstruct } from '../reconstruct';
import type { GameReconstruction, PlayerContributions, SeasonCheck } from '../reconstruct';
import { classifyGames } from '../roleGames';
import type { ClassifiedGame, SeasonGames } from '../roleGames';
import type { SeasonData } from '../seasonData';
import type { HighInRecord } from '../api/parse';
import { isStartTally } from '../startRate';
import type { SeasonStart, StartGameExclusion } from '../startRate';
import { declaredLeague, gameStartRule, highInEvidence } from '../startRule';
import type { HighInEvidence } from '../startRule';
import type { GamesContext } from './gamesLoader';

/**
 * Leg-by-leg reconstruction for **one selected player**, on request (P2: 個人別の役割別成績).
 *
 * `match/get` is one request per game, so it is never run for a whole league: only for the
 * games of the player the user picked, newest season first, within a budget. Rebuilt games are
 * cached per season (a pair's doubles game serves both partners; a team game all four), and a
 * season counts only if the rebuilt totals equal n01's totals for the player.
 *
 * Freshness (a score corrected on n01 must reach the rebuilt figures):
 * - every cached game carries the time it was read; a game older than the season's TTL, or any
 *   game when the user asked for fresh data (`forceRefresh`), is read again — only the selected
 *   player's games, never the whole league;
 * - when the rebuilt totals disagree with n01's, the games that came from the cache are read
 *   once more (a correction made after they were cached) and the season is checked again; a
 *   cached game that could not be rebuilt is read once more in any case;
 * - a game that could not be read again keeps its old reconstruction, and the season says so
 *   (`stale`): it is never presented as freshly checked.
 */

export const detailKey = (tournamentId: string): string => `detail:${tournamentId}`;
export const highInKey = (tournamentId: string): string => `highin:${tournamentId}`;
/** `match/get` requests one reconstruction may send (≈ 2–3 seasons of one player). */
export const DETAIL_MAX_REQUESTS = 60;
/** A cached game is re-read for a disagreement with n01 only when read at least this long ago. */
export const MISMATCH_REREAD_MS = 10 * 60 * 1000;

export interface PlayerDetailResult {
  personKey: string;
  checks: SeasonCheck[];
  contributions: PlayerContributions;
  /**
   * Best Leg per start score, only for start scores whose singles games were **all** rebuilt in
   * every season of the period the player appears in. Independent of the 3DA checksum.
   */
  bestLegs: Map<number, number>;
  /** Start scores whose Best Leg is withheld (`all` when a season could not be examined at all). */
  bestLegHeld: { all: boolean; starts: number[]; reasons: string[] };
  /** Seasons not attempted because the budget ran out or the load was cancelled. */
  notAttempted: { tournamentId: string; title: string }[];
  /** Seasons using reconstructions that should have been read again but could not be. */
  stale: { tournamentId: string; title: string; games: number }[];
  failures: string[];
  requestsSent: number;
  /**
   * 個人スタート率 per season of the period the player appears in (doubles 01, double-in slots
   * only; see `startRate.ts` / `startRule.ts`). Pooled by `periodStart`.
   */
  starts: SeasonStart[];
}

/** Cached reconstructions of one season, with the time each game was read. */
interface CachedDetail {
  v: 2;
  games: Record<string, { r: GameReconstruction; at: number }>;
}

type Held = Map<string, { r: GameReconstruction; at: number }>;

async function readCached(ctx: GamesContext, tournamentId: string): Promise<Held> {
  const entry = await ctx.cache.get<CachedDetail | Record<string, GameReconstruction>>(detailKey(tournamentId));
  if (!entry) return new Map();
  const value = entry.value as Partial<CachedDetail>;
  if (value && value.v === 2 && value.games) return new Map(Object.entries(value.games));
  // Written before per-game times were kept: each game is as old as the entry.
  return new Map(Object.entries(entry.value as Record<string, GameReconstruction>).map(([id, r]) => [id, { r, at: entry.fetchedAt }]));
}

const toRebuilt = (held: Held): Map<string, GameReconstruction> => new Map([...held].map(([id, entry]) => [id, entry.r]));

/** A cached reconstruction made before start attempts were counted (not "0 attempts": not counted). */
const lacksStart = (entry: { r: GameReconstruction } | undefined): boolean => !!entry && entry.r.ok && entry.r.start !== null && !isStartTally(entry.r.start);

/**
 * The season's high-in records (one request, cached like the season), or `null` when they
 * cannot be read: the slots are then "unknown", never assumed double-in.
 */
async function loadHighIns(ctx: GamesContext, season: SeasonData): Promise<{ records: HighInRecord[] | null; budget: boolean; failure?: string }> {
  const key = highInKey(season.tournamentId);
  const cached = await ctx.cache.get<HighInRecord[]>(key);
  if (cached && ctx.cache.isFresh(cached) && !ctx.forceRefresh) return { records: cached.value, budget: false };
  if (ctx.signal?.aborted) return { records: cached?.value ?? null, budget: true };
  try {
    const records = await ctx.api.highIns(season.tournamentId);
    await ctx.cache.put(key, records, season.status === N01_STATUS.FINISHED ? TTL.finishedSeason : TTL.runningSeason);
    return { records, budget: false };
  } catch (error) {
    return { records: cached?.value ?? null, budget: error instanceof RequestBudgetError, failure: cached ? undefined : `${season.title}（ハイイン記録）: ${describeN01Error(error)}` };
  }
}

function sideOf(game: ClassifiedGame, oid: string): 0 | 1 | null {
  if (game.sides[0].players.some((p) => p.oid === oid)) return 0;
  if (game.sides[1].players.some((p) => p.oid === oid)) return 1;
  return null;
}

/**
 * One player's start attempts over their doubles 01 games of one season. A game counts only when
 * its slot is confirmed double-in, the season's attribution passed n01's checksum (the same
 * verdict that admits the player's 3DA), its legs were rebuilt, and n01's own high-in records of
 * its legs, where there are any, name the same starter and points. Anything else is left out,
 * with the reason — never counted as a failure.
 */
export function seasonStartOf(input: {
  season: SeasonData;
  oid: string;
  mine: readonly ClassifiedGame[];
  rebuilt: ReadonlyMap<string, GameReconstruction>;
  attributionVerified: boolean;
  evidence: HighInEvidence | null;
  highIns: readonly HighInRecord[] | null;
}): SeasonStart {
  const { season, oid } = input;
  const doubles = input.mine.filter((g) => g.family.family === '01' && g.role === 'doubles');
  const out: SeasonStart = { tournamentId: season.tournamentId, title: season.title, doublesGames: doubles.length, counted: 0, attempts: 0, successes: 0, legs: 0, excludedLegs: {}, excludedGames: {}, ruleNotes: [], highInAgreements: 0 };
  const leave = (why: StartGameExclusion): void => void (out.excludedGames[why] = (out.excludedGames[why] ?? 0) + 1);
  for (const game of doubles) {
    const verdict = gameStartRule(season, game, input.evidence);
    if (verdict.rule !== 'double-in') {
      if (verdict.rule === 'straight-in') leave('straight-in');
      else {
        leave('rule-unknown');
        if (!out.ruleNotes.includes(verdict.reason)) out.ruleNotes.push(verdict.reason);
      }
      continue;
    }
    const rebuilt = input.rebuilt.get(game.gameId);
    if (!rebuilt) {
      leave('not-fetched');
      continue;
    }
    if (!rebuilt.ok || rebuilt.start === null) {
      leave('unreadable');
      continue;
    }
    if (!isStartTally(rebuilt.start)) {
      leave('needs-refetch');
      continue;
    }
    if (!input.attributionVerified) {
      leave('order-unverified');
      continue;
    }
    const tally = rebuilt.start;
    const mySide = sideOf(game, oid);
    const mine = tally.perPlayer[oid];
    if (mySide === null || !mine) {
      leave('unreadable');
      continue;
    }
    // n01's high-in records of this game's legs (same slot, same leg time, a player of the game).
    let conflict = false;
    let agreements = 0;
    for (const record of input.highIns ?? []) {
      if (record.schid !== game.schid || record.time === null || !record.oid) continue;
      const recordSide = sideOf(game, record.oid);
      if (recordSide === null) continue;
      if (!tally.legTimes.includes(record.time)) continue;
      const hit = tally.hits.find((h) => h.time === record.time && sideOf(game, h.oid) === recordSide);
      if (hit && hit.oid === record.oid && hit.score === record.highIn) agreements += 1;
      else conflict = true;
    }
    if (conflict) {
      leave('order-conflict');
      continue;
    }
    out.highInAgreements += agreements;
    out.counted += 1;
    out.attempts += mine.attempts;
    out.successes += mine.successes;
    out.legs += tally.sides[mySide].legs;
    for (const [reason, n] of Object.entries(tally.sides[mySide].excluded)) {
      const key = reason as keyof SeasonStart['excludedLegs'];
      out.excludedLegs[key] = (out.excludedLegs[key] ?? 0) + (n ?? 0);
    }
  }
  return out;
}

function personGames(classified: readonly ClassifiedGame[], oid: string): ClassifiedGame[] {
  return classified.filter((g) => g.family.family === '01' && g.sides.some((s) => s.players.some((p) => p.oid === oid)));
}

export async function reconstructPerson(
  ctx: GamesContext,
  input: { seasons: readonly SeasonData[]; games: ReadonlyMap<string, SeasonGames>; personKey: string; concurrency?: number },
): Promise<PlayerDetailResult> {
  const result: PlayerDetailResult = { personKey: input.personKey, checks: [], contributions: new Map(), bestLegs: new Map(), bestLegHeld: { all: false, starts: [], reasons: [] }, notAttempted: [], stale: [], failures: [], requestsSent: 0, starts: [] };
  const held = new Set<number>();
  const holdAll = (reason: string): void => {
    result.bestLegHeld.all = true;
    result.bestLegHeld.reasons.push(reason);
  };
  let stopped = false;
  const concurrency = Math.max(1, input.concurrency ?? 3);
  for (const season of input.seasons) {
    const me = season.players.find((p) => p.personKey === input.personKey);
    if (!me) continue;
    const raw = input.games.get(season.tournamentId);
    const unexamined = (doublesGames: number | null, seasonReason: string): SeasonStart => ({ tournamentId: season.tournamentId, title: season.title, doublesGames, counted: 0, attempts: 0, successes: 0, legs: 0, excludedLegs: {}, excludedGames: {}, ruleNotes: [], highInAgreements: 0, seasonReason });
    if (!raw?.complete) {
      result.checks.push({ tournamentId: season.tournamentId, oid: me.oid, state: 'incomplete', games: 0, reconstructed: 0, verified: { score: false, f9: false, tons: false, highOut: false, break: false }, compared: null, reason: 'ゲーム一覧を取得できていません' });
      holdAll(`${season.title}: ゲーム一覧を取得できていません`);
      result.starts.push(unexamined(null, 'ゲーム一覧を取得できていません'));
      continue;
    }
    const classified = classifyGames(season, raw.games);
    const mine = personGames(classified, me.oid);
    const doublesCount = mine.filter((g) => g.role === 'doubles').length;
    if (stopped) {
      result.notAttempted.push({ tournamentId: season.tournamentId, title: season.title });
      holdAll(`${season.title}: 通信の上限のため未確認`);
      if (doublesCount > 0) result.starts.push(unexamined(doublesCount, '通信の上限または中断のため未取得'));
      continue;
    }
    // The slots' in-rule evidence (one request per season, only where a doubles game of the
    // player could count): read before the legs, so only games that can count are refetched.
    let highIns: HighInRecord[] | null = null;
    if (doublesCount > 0 && declaredLeague(season.leagueId)) {
      const loaded = await loadHighIns(ctx, season);
      highIns = loaded.records;
      if (loaded.failure) result.failures.push(loaded.failure);
      if (loaded.budget) stopped = true;
    }
    const evidence = highIns ? highInEvidence(season.slots, highIns) : null;
    const stored = await readCached(ctx, season.tournamentId);
    const ttl = season.status === N01_STATUS.FINISHED ? TTL.finishedSeason : TTL.runningSeason;
    const now = ctx.now();
    const due = (id: string): boolean => {
      const entry = stored.get(id);
      return !entry || ctx.forceRefresh === true || now - entry.at >= ttl;
    };
    // Cached before start attempts were counted, in a slot where they count: read again for that
    // only (its 3DA figures stay as they are if the read fails).
    const startOnly = new Set(mine.filter((g) => !due(g.gameId) && lacksStart(stored.get(g.gameId)) && gameStartRule(season, g, evidence).rule === 'double-in').map((g) => g.gameId));
    const readAgain = new Set<string>();
    let failedAgain = 0;
    let added = 0;
    // Reads `games` (multi-thrower games first: they are what only a reconstruction can split).
    const fetchGames = async (games: readonly ClassifiedGame[]): Promise<void> => {
      const pending = [...games].sort((a, b) => Number(a.sides[0].players.length === 1) - Number(b.sides[0].players.length === 1));
      for (let i = 0; i < pending.length && !stopped; i += concurrency) {
        if (ctx.signal?.aborted) {
          stopped = true;
          break;
        }
        const batch = pending.slice(i, i + concurrency);
        const outcomes = await Promise.allSettled(batch.map((g) => ctx.api.gameDetail(g.gameId)));
        outcomes.forEach((outcome, index) => {
          const id = batch[index].gameId;
          if (outcome.status === 'fulfilled') {
            stored.set(id, { r: safeReconstruct(outcome.value), at: ctx.now() });
            readAgain.add(id);
            added += 1;
            return;
          }
          if (stored.has(id) && !startOnly.has(id)) failedAgain += 1;
          if (outcome.reason instanceof RequestBudgetError) stopped = true;
          else result.failures.push(`${season.title}: ${describeN01Error(outcome.reason)}`);
        });
      }
    };
    await fetchGames(mine.filter((g) => due(g.gameId) || startOnly.has(g.gameId)));
    let rebuilt = toRebuilt(stored);

    // Read again, once, what the cache may hold from before a correction: every cached game when
    // the rebuilt totals disagree with n01's, otherwise the cached games that could not be rebuilt
    // (a record entered partly, or wrongly, when it was cached). Then check again.
    const composition = season.composition.composition;
    if (!stopped) {
      const cachedOnly = mine.filter((g) => stored.has(g.gameId) && !readAgain.has(g.gameId));
      const first = composition === 'unknown' ? null : checkPlayerSeason(season.tournamentId, me.oid, me.line, classified, rebuilt, composition === 'pure01');
      // Only games read at least MISMATCH_REREAD_MS ago: a season that disagrees for another
      // reason (a limit of the reconstruction) must not re-read everything on every run.
      const old = (g: ClassifiedGame): boolean => now - stored.get(g.gameId)!.at >= MISMATCH_REREAD_MS;
      const suspect = first?.state === 'mismatch' ? cachedOnly.filter(old) : cachedOnly.filter((g) => !stored.get(g.gameId)!.r.ok && old(g));
      if (suspect.length > 0) {
        await fetchGames(suspect);
        rebuilt = toRebuilt(stored);
      }
    }
    if (added > 0) {
      await ctx.cache.put(detailKey(season.tournamentId), { v: 2, games: Object.fromEntries(stored) } satisfies CachedDetail, ttl);
    }
    const overdue = mine.filter((g) => stored.has(g.gameId) && !readAgain.has(g.gameId) && (ctx.forceRefresh === true || now - stored.get(g.gameId)!.at >= ttl)).length;
    if (failedAgain > 0 || overdue > 0) result.stale.push({ tournamentId: season.tournamentId, title: season.title, games: Math.max(failedAgain, overdue) });

    // Best Leg: per start score, every singles game of the season must have been rebuilt. A game
    // not fetched (budget / network) or unreadable leaves that start score unconfirmed.
    const singlesByStart = new Map<number | null, ClassifiedGame[]>();
    for (const g of mine) {
      if (!g.sides.some((side) => side.players.length === 1 && side.players[0].oid === me.oid)) continue;
      singlesByStart.set(g.startScore, [...(singlesByStart.get(g.startScore) ?? []), g]);
    }
    for (const [start, list] of singlesByStart) {
      const missing = list.filter((g) => !rebuilt.get(g.gameId)?.ok).length;
      if (missing === 0) continue;
      const reason = `${season.title}: シングルス${list.length}ゲーム中${missing}ゲームのLeg明細を確認できていません`;
      if (start === null) holdAll(reason);
      else {
        held.add(start);
        result.bestLegHeld.reasons.push(reason);
      }
    }
    for (const [start, darts] of bestLegsByStart(me.oid, mine, rebuilt)) result.bestLegs.set(start, Math.min(result.bestLegs.get(start) ?? Infinity, darts));

    if (composition === 'unknown') {
      result.checks.push({ tournamentId: season.tournamentId, oid: me.oid, state: 'mismatch', games: mine.length, reconstructed: mine.filter((g) => rebuilt.get(g.gameId)?.ok).length, verified: { score: false, f9: false, tons: false, highOut: false, break: false }, compared: null, reason: '種別不明のゲーム枠を含むため、n01公式値と照合できません' });
      if (doublesCount > 0) result.starts.push(seasonStartOf({ season, oid: me.oid, mine, rebuilt, attributionVerified: false, evidence, highIns }));
      continue;
    }
    const check = checkPlayerSeason(season.tournamentId, me.oid, me.line, classified, rebuilt, composition === 'pure01');
    result.checks.push(check);
    if (doublesCount > 0) result.starts.push(seasonStartOf({ season, oid: me.oid, mine, rebuilt, attributionVerified: check.verified.score, evidence, highIns }));
    addVerified(result.contributions, check, classified, rebuilt);
  }
  // Only confirmed start scores are published; a partial minimum could be worse than the real one.
  if (result.bestLegHeld.all) result.bestLegs.clear();
  for (const start of held) result.bestLegs.delete(start);
  result.bestLegHeld.starts = [...held].sort((a, b) => a - b);
  result.requestsSent = ctx.api.requestCount;
  return result;
}

/**
 * The player's doubles 01 games in the loaded game lists — known before any `match/get`, so a
 * player without doubles is never fetched for. `unknownSeasons`: seasons of the player whose
 * game list is missing or incomplete.
 */
export function doublesExposure(seasons: readonly SeasonData[], games: ReadonlyMap<string, SeasonGames> | null, personKey: string): { games: number; unknownSeasons: number } {
  let count = 0;
  let unknownSeasons = 0;
  for (const season of seasons) {
    const me = season.players.find((p) => p.personKey === personKey);
    if (!me) continue;
    const raw = games?.get(season.tournamentId);
    if (!raw?.complete) {
      unknownSeasons += 1;
      continue;
    }
    count += personGames(classifyGames(season, raw.games), me.oid).filter((g) => g.role === 'doubles').length;
  }
  return { games: count, unknownSeasons };
}

/** Seasons with doubles games of the player, and how many of them passed n01's checksum (3DA / First 9). */
export function doublesCoverage(result: PlayerDetailResult): { seasons: number; scoreVerified: number; f9Verified: number } {
  const seasons = result.starts.filter((s) => s.doublesGames === null || s.doublesGames > 0);
  const checkOf = (id: string) => result.checks.find((c) => c.tournamentId === id);
  return {
    seasons: seasons.length,
    scoreVerified: seasons.filter((s) => checkOf(s.tournamentId)?.verified.score).length,
    f9Verified: seasons.filter((s) => checkOf(s.tournamentId)?.verified.f9).length,
  };
}

/** A run that should be offered again: something was not read (network, budget, cancel) — not a mismatch. */
export function needsRetry(result: PlayerDetailResult): boolean {
  return result.failures.length > 0 || result.notAttempted.length > 0 || result.stale.length > 0 || result.checks.some((c) => c.state === 'incomplete' && c.games > 0) || result.starts.some((s) => (s.excludedGames['not-fetched'] ?? 0) > 0 || (s.excludedGames['needs-refetch'] ?? 0) > 0);
}
