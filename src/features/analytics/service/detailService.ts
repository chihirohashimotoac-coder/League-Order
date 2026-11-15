import { describeN01Error } from '../../../integrations/n01/client';
import { N01_STATUS } from '../../../integrations/n01/types';
import { RequestBudgetError } from '../api/readApi';
import { TTL } from '../cache/analyticsCache';
import { addVerified, bestLegsByStart, checkPlayerSeason, safeReconstruct } from '../reconstruct';
import type { GameReconstruction, PlayerContributions, SeasonCheck } from '../reconstruct';
import { classifyGames } from '../roleGames';
import type { ClassifiedGame, SeasonGames } from '../roleGames';
import type { SeasonData } from '../seasonData';
import type { StatLine } from '../types';
import type { HighInRecord, RawGameDetail } from '../api/parse';
import { isStartTally } from '../startRate';
import type { SeasonStart, StartGameExclusion } from '../startRate';
import { gameStartRule, highInEvidence, seasonRule } from '../startRule';
import type { HighInEvidence } from '../startRule';
import type { GamesContext } from './gamesLoader';
import { fingerprint, gamesVersion } from './gamesLoader';
import { isTransient, withRetry } from './retry';

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
/** n01's player totals of a season, read for one version of its game list. */
export const officialKey = (tournamentId: string, version: string): string => `official:${tournamentId}@${version}`;
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
   * This part of the load stopped because its request budget ran out (not an error): what it read
   * is cached, and another part continues from there.
   */
  budgetStopped?: boolean;
  /** Requests answered in this part (a part that read nothing is not worth repeating at once). */
  fetched?: number;
  /** Some failures could pass on their own (connection, timeout, n01 busy): retried when back online. */
  transient?: boolean;
  /** Seasons (and the version of their game list) whose list was complete at the time of the run. */
  coverage?: string;
  /** The game-list version each season was checked against: figures of another version are not shown. */
  versions?: Record<string, string>;
  /** The season of each game with figures in {@link contributions}. */
  gameSeason?: Record<string, string>;
  /** The browser's storage refused a write: the legs read stay for this screen only. */
  saveFailed?: boolean;
  /** Seasons withheld because their game list was read again with other content (`currentResult`). */
  outdatedSeasons?: string[];
  /**
   * Seasons whose list changed and whose rebuilt figures do not (yet) match n01's player totals read
   * after the change — possibly n01 has not counted the change yet: offered again (「再試行」).
   */
  awaitingOfficial?: string[];
  /**
   * 個人スタート率 per season of the period the player appears in (doubles 01, double-in slots
   * only; see `startRate.ts` / `startRule.ts`). Pooled by `periodStart`.
   */
  starts: SeasonStart[];
}

/** Cached reconstructions of one season, with the time each game was read. */
interface CachedDetail {
  v: 2;
  games: Record<string, { r: GameReconstruction; at: number; fp?: string }>;
}

/** `fp`: the game's list-row fingerprint when its legs were read (a corrected row makes them due). */
type Held = Map<string, { r: GameReconstruction; at: number; fp?: string }>;

/**
 * What one open screen has read (legs per season, high-in records). Reads consult it before the
 * browser's storage and add to it, so a part of a long read never asks n01 again for what an
 * earlier part read — even when the storage refused to keep it.
 */
export interface DetailMemory {
  games: Map<string, Held>;
  highIns: Map<string, { records: HighInRecord[]; at: number }>;
  officials: Map<string, { lines: Record<string, StatLine>; at: number }>;
}

export const newDetailMemory = (): DetailMemory => ({ games: new Map(), highIns: new Map(), officials: new Map() });

/**
 * n01's player totals of a season for one version of its game list (`player_stats_list`, one
 * request, kept per version: the same list never asks again, a changed list asks once). `recheck`
 * asks n01 again (the retry of a season whose totals did not reflect the change yet).
 */
async function loadOfficial(
  ctx: GamesContext,
  season: SeasonData,
  version: string,
  memory: DetailMemory | undefined,
  recheck: boolean,
): Promise<{ lines: Record<string, StatLine> | null; budget: boolean; failure?: string; fetched: boolean; transient?: boolean; saveFailed?: boolean }> {
  const key = officialKey(season.tournamentId, version);
  const ttl = season.status === N01_STATUS.FINISHED ? TTL.finishedSeason : TTL.runningSeason;
  if (!recheck) {
    const kept = memory?.officials.get(key);
    if (kept && kept.at >= (ctx.freshAfter ?? 0) && ctx.now() - kept.at < ttl) return { lines: kept.lines, budget: false, fetched: false };
    const cached = await ctx.cache.get<Record<string, StatLine>>(key);
    if (cached && ctx.cache.isFresh(cached) && !ctx.forceRefresh && cached.fetchedAt >= (ctx.freshAfter ?? 0)) return { lines: cached.value, budget: false, fetched: false };
  }
  if (ctx.signal?.aborted) return { lines: null, budget: true, fetched: false };
  try {
    const rows = await withRetry(ctx, () => ctx.api.playerStats(season.tournamentId));
    const lines: Record<string, StatLine> = {};
    for (const row of rows) lines[row.oid] = row.line;
    memory?.officials.set(key, { lines, at: ctx.now() });
    const saved = await ctx.cache.put(key, lines, ttl);
    return { lines, budget: false, fetched: true, saveFailed: !saved };
  } catch (error) {
    return { lines: null, budget: error instanceof RequestBudgetError, failure: describeN01Error(error), fetched: false, transient: isTransient(error) };
  }
}

async function readStored(ctx: GamesContext, tournamentId: string): Promise<Held> {
  const entry = await ctx.cache.get<CachedDetail | Record<string, GameReconstruction>>(detailKey(tournamentId));
  if (!entry) return new Map();
  const value = entry.value as Partial<CachedDetail>;
  if (value && value.v === 2 && value.games) return new Map(Object.entries(value.games));
  // Written before per-game times were kept: each game is as old as the entry.
  return new Map(Object.entries(entry.value as Record<string, GameReconstruction>).map(([id, r]) => [id, { r, at: entry.fetchedAt }]));
}

/** The season's stored reconstructions merged into the screen's memory (the newer read wins); reads add to it. */
async function readCached(ctx: GamesContext, tournamentId: string, memory?: DetailMemory): Promise<Held> {
  const stored = await readStored(ctx, tournamentId);
  const kept = memory?.games.get(tournamentId);
  if (!kept) {
    memory?.games.set(tournamentId, stored);
    return stored;
  }
  for (const [id, entry] of stored) {
    const mine = kept.get(id);
    if (!mine || mine.at < entry.at) kept.set(id, entry);
  }
  return kept;
}

const toRebuilt = (held: Held): Map<string, GameReconstruction> => new Map([...held].map(([id, entry]) => [id, entry.r]));

/** A cached reconstruction made before start attempts were counted (not "0 attempts": not counted). */
const lacksStart = (entry: { r: GameReconstruction } | undefined): boolean => !!entry && entry.r.ok && entry.r.start !== null && !isStartTally(entry.r.start);

/**
 * The season's high-in records (one request, cached like the season), or `null` when they
 * cannot be read: the slots are then "unknown", never assumed double-in.
 */
async function loadHighIns(ctx: GamesContext, season: SeasonData, memory?: DetailMemory): Promise<{ records: HighInRecord[] | null; budget: boolean; failure?: string; fetched: boolean; saveFailed?: boolean }> {
  // Only a cross-check: a failure here never removes a verdict, a 3DA or a First 9.
  const key = highInKey(season.tournamentId);
  const ttl = season.status === N01_STATUS.FINISHED ? TTL.finishedSeason : TTL.runningSeason;
  const kept = memory?.highIns.get(season.tournamentId);
  if (kept && !ctx.forceRefresh && kept.at >= (ctx.freshAfter ?? 0) && ctx.now() - kept.at < ttl) return { records: kept.records, budget: false, fetched: false };
  const cached = await ctx.cache.get<HighInRecord[]>(key);
  if (cached && ctx.cache.isFresh(cached) && !ctx.forceRefresh && cached.fetchedAt >= (ctx.freshAfter ?? 0)) return { records: cached.value, budget: false, fetched: false };
  if (ctx.signal?.aborted) return { records: cached?.value ?? null, budget: true, fetched: false };
  try {
    const records = await withRetry(ctx, () => ctx.api.highIns(season.tournamentId));
    memory?.highIns.set(season.tournamentId, { records, at: ctx.now() });
    const saved = await ctx.cache.put(key, records, ttl);
    return { records, budget: false, fetched: true, saveFailed: !saved };
  } catch (error) {
    return { records: cached?.value ?? null, budget: error instanceof RequestBudgetError, failure: cached ? undefined : describeN01Error(error), fetched: false };
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
  /** Why the high-in records are missing, when they were wanted (shown as a note only). */
  highInNote?: string;
}): SeasonStart {
  const { season, oid } = input;
  const doubles = input.mine.filter((g) => g.family.family === '01' && g.role === 'doubles');
  const out: SeasonStart = { tournamentId: season.tournamentId, title: season.title, doublesGames: doubles.length, counted: 0, attempts: 0, successes: 0, legs: 0, excludedLegs: {}, excludedGames: {}, ruleNotes: [], highInAgreements: 0 };
  const leave = (why: StartGameExclusion): void => void (out.excludedGames[why] = (out.excludedGames[why] ?? 0) + 1);
  if (input.highInNote && doubles.length > 0) out.ruleNotes.push(input.highInNote);
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
      // A record without usable points or time says nothing about who started: not compared.
      if (record.schid !== game.schid || record.time === null || !record.oid || record.highIn === null || record.highIn <= 0) continue;
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

/**
 * The seasons of the player whose game list is complete: what a reconstruction run can cover. A
 * result made with fewer of them is superseded once more lists arrive.
 */
export function detailCoverage(seasons: readonly SeasonData[], games: ReadonlyMap<string, SeasonGames>, personKey: string): string {
  return seasons
    .filter((s) => games.get(s.tournamentId)?.complete && s.players.some((p) => p.personKey === personKey))
    .map((s) => `${s.tournamentId}@${gamesVersion(games.get(s.tournamentId)!)}`)
    .join(',');
}

export const OUTDATED_REASON = 'ゲーム記録が更新されたため、この季は照合し直しています';

/**
 * A result as it may be shown with the game lists loaded now: every season whose list was read
 * again with other content (or is no longer complete) gives nothing — no per-game figures, no
 * check, no start attempts (the season is "not examined", with the reason), and Best Leg is held —
 * until the player is checked against the new list. Results made before versions were kept are
 * returned as they are.
 */
export function currentResult(result: PlayerDetailResult, games: ReadonlyMap<string, SeasonGames> | null): PlayerDetailResult {
  if (!games || !result.versions) return result;
  const outdated = new Set(
    Object.entries(result.versions)
      .filter(([tid, version]) => {
        const raw = games.get(tid);
        return !raw?.complete || gamesVersion(raw) !== version;
      })
      .map(([tid]) => tid),
  );
  if (outdated.size === 0) return result;
  return {
    ...result,
    checks: result.checks.filter((c) => !outdated.has(c.tournamentId)),
    starts: result.starts.map((s) =>
      outdated.has(s.tournamentId)
        ? { tournamentId: s.tournamentId, title: s.title, doublesGames: null, counted: 0, attempts: 0, successes: 0, legs: 0, excludedLegs: {}, excludedGames: {}, ruleNotes: [], highInAgreements: 0, seasonReason: OUTDATED_REASON }
        : s,
    ),
    contributions: currentContributions(result, games),
    bestLegs: new Map(),
    bestLegHeld: { all: true, starts: [], reasons: [OUTDATED_REASON, ...result.bestLegHeld.reasons] },
    outdatedSeasons: [...outdated],
  };
}

/**
 * A result's per-game figures that still belong to the loaded game lists: a season whose list
 * was read again with other content (a correction, a game added) gives none until it is checked
 * again. Results made before versions were kept give all of theirs.
 */
export function currentContributions(result: PlayerDetailResult, games: ReadonlyMap<string, SeasonGames> | null): PlayerContributions {
  if (!games || !result.versions || !result.gameSeason) return result.contributions;
  const out: PlayerContributions = new Map();
  for (const [gameId, players] of result.contributions) {
    const tid = result.gameSeason[gameId];
    const raw = tid ? games.get(tid) : undefined;
    if (tid && raw && result.versions[tid] === gamesVersion(raw)) out.set(gameId, players);
  }
  return out;
}

const classifiedCache = new WeakMap<SeasonGames, { slots: SeasonData['slots']; games: ClassifiedGame[] }>();

/** {@link classifyGames}, kept per loaded list (the screens ask again on every update of a long load). */
function classifiedOf(season: SeasonData, raw: SeasonGames): ClassifiedGame[] {
  const hit = classifiedCache.get(raw);
  if (hit && hit.slots === season.slots) return hit.games;
  const games = classifyGames(season, raw.games);
  classifiedCache.set(raw, { slots: season.slots, games });
  return games;
}

/**
 * The legs describe the game as the list shows it: per side, the rebuilt players' points and darts
 * add up to the row's totals. Otherwise they belong to another state of the game (n01 not yet
 * showing a correction in one of the two), and are not used.
 */
function matchesRow(game: ClassifiedGame, rebuilt: GameReconstruction): boolean {
  if (!rebuilt.ok) return true;
  return game.sides.every((side) => {
    if (side.score === null || side.darts === null) return true;
    let score = 0;
    let darts = 0;
    for (const p of side.players) {
      const c = p.oid ? rebuilt.perPlayer[p.oid] : undefined;
      if (!c) return false;
      score += c.score;
      darts += c.darts;
    }
    return score === side.score && darts === side.darts;
  });
}

/** The legs list the same players, in the same throwing order, on each side as the list's row. */
function sameOrder(game: ClassifiedGame, detail: RawGameDetail): boolean {
  return game.sides.every((side, i) => {
    const theirs = detail.sides[i]?.players ?? [];
    return theirs.length === side.players.length && side.players.every((p, k) => p.oid === theirs[k]?.oid);
  });
}

/** Stands for "read, but not for the row the list shows": such legs are always read again. */
const UNMATCHED = 'unmatched';

function personGames(classified: readonly ClassifiedGame[], oid: string): ClassifiedGame[] {
  return classified.filter((g) => g.family.family === '01' && g.sides.some((s) => s.players.some((p) => p.oid === oid)));
}

export async function reconstructPerson(
  ctx: GamesContext,
  input: {
    seasons: readonly SeasonData[];
    games: ReadonlyMap<string, SeasonGames>;
    personKey: string;
    concurrency?: number;
    memory?: DetailMemory;
    /** The list versions the player's previous result was checked against (a season read again since counts as changed). */
    previousVersions?: Record<string, string>;
    /** Ask n01 again for the totals of changed seasons (the retry). */
    recheckOfficial?: boolean;
  },
): Promise<PlayerDetailResult> {
  const result: PlayerDetailResult = { personKey: input.personKey, checks: [], contributions: new Map(), bestLegs: new Map(), bestLegHeld: { all: false, starts: [], reasons: [] }, notAttempted: [], stale: [], failures: [], requestsSent: 0, starts: [] };
  const held = new Set<number>();
  const holdAll = (reason: string): void => {
    result.bestLegHeld.all = true;
    result.bestLegHeld.reasons.push(reason);
  };
  let stopped = false;
  let budgetStopped = false;
  let fetched = 0;
  const concurrency = Math.max(1, input.concurrency ?? 3);
  result.coverage = detailCoverage(input.seasons, input.games, input.personKey);
  result.versions = {};
  result.gameSeason = {};
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
    let highInNote: string | undefined;
    if (doublesCount > 0 && 'rule' in seasonRule(season)) {
      const loaded = await loadHighIns(ctx, season, input.memory);
      if (loaded.saveFailed) result.saveFailed = true;
      highIns = loaded.records;
      // Not a failure of the read: the start attempts still count, without the cross-check.
      if (loaded.failure) highInNote = `${season.title}: n01のハイイン記録を取得できず、Legごとの照合はしていません（${loaded.failure}）`;
      if (loaded.fetched) fetched += 1;
      if (loaded.budget) {
        stopped = true;
        budgetStopped = !ctx.signal?.aborted;
      }
    }
    const evidence = highIns ? highInEvidence(highIns) : null;
    const stored = await readCached(ctx, season.tournamentId, input.memory);
    const version = gamesVersion(raw);
    result.versions[season.tournamentId] = version;
    // The season's list changed since it was known (read again with other content, or another
    // version than the player's previous check): its check must not use what was read before.
    const previous = input.previousVersions?.[season.tournamentId];
    const listChanged = !!raw.changedFrom || (previous !== undefined && previous !== version);
    const rowPrint = new Map(raw.games.map((g) => [g.gameId, fingerprint(g)]));
    const ttl = season.status === N01_STATUS.FINISHED ? TTL.finishedSeason : TTL.runningSeason;
    const now = ctx.now();
    const freshAfter = ctx.freshAfter ?? 0;
    // A game's legs are read again when its list row is not the row they were read for (a score,
    // a player, the finished state changed). Legs stored before rows were recorded count as such
    // only in a season whose list changed. Unchanged games keep their valid legs.
    const due = (id: string): boolean => {
      const entry = stored.get(id);
      if (!entry || ctx.forceRefresh === true || entry.at < freshAfter || now - entry.at >= ttl) return true;
      return entry.fp !== undefined ? entry.fp !== rowPrint.get(id) : listChanged;
    };
    // n01's totals as they stand after the change (the period's are from before it).
    let official: StatLine = me.line;
    if (listChanged) {
      const loaded = await loadOfficial(ctx, season, version, input.memory, input.recheckOfficial === true);
      if (loaded.saveFailed) result.saveFailed = true;
      if (loaded.fetched) fetched += 1;
      const line = loaded.lines?.[me.oid];
      if (!loaded.lines || !line) {
        if (loaded.budget) {
          stopped = true;
          budgetStopped = !ctx.signal?.aborted;
        }
        const reason = !loaded.lines
          ? `ゲーム一覧が更新された季のn01公式通算を取得できませんでした${loaded.failure ? `（${loaded.failure}）` : ''}`
          : 'ゲーム一覧が更新された季のn01公式通算に、この選手の行がありません';
        if (loaded.budget) result.notAttempted.push({ tournamentId: season.tournamentId, title: season.title });
        else {
          result.failures.push(`${season.title}: ${reason}`);
          if (loaded.transient || loaded.lines) result.transient = true;
        }
        result.checks.push({ tournamentId: season.tournamentId, oid: me.oid, state: 'incomplete', games: mine.length, reconstructed: 0, verified: { score: false, f9: false, tons: false, highOut: false, break: false }, compared: null, reason });
        holdAll(`${season.title}: ${reason}`);
        if (doublesCount > 0) result.starts.push(unexamined(doublesCount, reason));
        continue;
      }
      official = line;
    }
    // Cached before start attempts were counted, in a slot where they count: read again for that
    // only (its 3DA figures stay as they are if the read fails).
    const startOnly = new Set(mine.filter((g) => !due(g.gameId) && lacksStart(stored.get(g.gameId)) && gameStartRule(season, g, evidence).rule === 'double-in').map((g) => g.gameId));
    const readAgain = new Set<string>();
    let failedAgain = 0;
    // Reads `games` (multi-thrower games first: they are what only a reconstruction can split).
    const fetchGames = async (games: readonly ClassifiedGame[]): Promise<void> => {
      const pending = [...games].sort((a, b) => Number(a.sides[0].players.length === 1) - Number(b.sides[0].players.length === 1));
      for (let i = 0; i < pending.length && !stopped; i += concurrency) {
        if (ctx.signal?.aborted) {
          stopped = true;
          break;
        }
        const batch = pending.slice(i, i + concurrency);
        const outcomes = await Promise.allSettled(batch.map((g) => withRetry(ctx, () => ctx.api.gameDetail(g.gameId))));
        let batchAdded = 0;
        outcomes.forEach((outcome, index) => {
          const id = batch[index].gameId;
          if (outcome.status === 'fulfilled') {
            const r = safeReconstruct(outcome.value);
            // Recorded as the legs of this row only when they show it: same players and order, same totals.
            stored.set(id, { r, at: ctx.now(), fp: matchesRow(batch[index], r) && sameOrder(batch[index], outcome.value) ? rowPrint.get(id) : UNMATCHED });
            readAgain.add(id);
            batchAdded += 1;
            fetched += 1;
            return;
          }
          if (stored.has(id) && !startOnly.has(id)) failedAgain += 1;
          if (outcome.reason instanceof RequestBudgetError) {
            stopped = true;
            budgetStopped = true;
          } else if (!ctx.signal?.aborted) {
            result.failures.push(`${season.title}: ${describeN01Error(outcome.reason)}`);
            if (isTransient(outcome.reason)) result.transient = true;
          }
        });
        // Kept at once: a load cut off later (budget, the screen left, the tab closed) never reads these again.
        if (batchAdded > 0 && !(await ctx.cache.put(detailKey(season.tournamentId), { v: 2, games: Object.fromEntries(stored) } satisfies CachedDetail, ttl))) result.saveFailed = true;
      }
    };
    await fetchGames(mine.filter((g) => due(g.gameId) || startOnly.has(g.gameId)));
    // Only legs read for the row the list shows now are used (the game counts as not rebuilt
    // otherwise): their row fingerprint must be this row's — a stored entry of an older row that
    // could not be read again is never used, however its totals look. Entries stored before rows
    // were recorded count only in a season whose list did not change, and their totals must match.
    const validFor = (g: ClassifiedGame): boolean => {
      const entry = stored.get(g.gameId);
      if (!entry) return false;
      if (entry.fp !== undefined ? entry.fp !== rowPrint.get(g.gameId) : listChanged) return false;
      return matchesRow(g, entry.r);
    };
    const usable = (): Map<string, GameReconstruction> => {
      const all = toRebuilt(stored);
      for (const g of mine) if (all.has(g.gameId) && !validFor(g)) all.delete(g.gameId);
      return all;
    };
    let rebuilt = usable();

    // Read again, once, what the cache may hold from before a correction: every cached game when
    // the rebuilt totals disagree with n01's, otherwise the cached games that could not be rebuilt
    // (a record entered partly, or wrongly, when it was cached). Then check again.
    const composition = season.composition.composition;
    if (!stopped) {
      const cachedOnly = mine.filter((g) => stored.has(g.gameId) && !readAgain.has(g.gameId));
      const first = composition === 'unknown' ? null : checkPlayerSeason(season.tournamentId, me.oid, official, classified, rebuilt, composition === 'pure01');
      // Only games read at least MISMATCH_REREAD_MS ago: a season that disagrees for another
      // reason (a limit of the reconstruction) must not re-read everything on every run.
      const old = (g: ClassifiedGame): boolean => now - stored.get(g.gameId)!.at >= MISMATCH_REREAD_MS;
      // In a season whose list changed, legs recorded for the current row are valid: a disagreement
      // there is n01's totals catching up (or the changed games), not a reason to read them all again.
      const pinned = (g: ClassifiedGame): boolean => listChanged && stored.get(g.gameId)!.fp === rowPrint.get(g.gameId);
      const suspect = first?.state === 'mismatch' ? cachedOnly.filter((g) => old(g) && !pinned(g)) : cachedOnly.filter((g) => !stored.get(g.gameId)!.r.ok && old(g) && !pinned(g));
      if (suspect.length > 0) {
        await fetchGames(suspect);
        rebuilt = usable();
      }
    }
    const overdue = mine.filter((g) => stored.has(g.gameId) && !readAgain.has(g.gameId) && (ctx.forceRefresh === true || stored.get(g.gameId)!.at < freshAfter || now - stored.get(g.gameId)!.at >= ttl)).length;
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
    // Kept until the season's check: a season whose list changed publishes its Best Leg only once
    // it matches n01's totals again.
    const seasonBest = bestLegsByStart(me.oid, mine, rebuilt);
    const publishBest = (verified: boolean): void => {
      if (listChanged && !verified) {
        holdAll(`${season.title}: ゲーム一覧が更新され、n01公式値との照合が済んでいないため保留`);
        return;
      }
      for (const [start, darts] of seasonBest) result.bestLegs.set(start, Math.min(result.bestLegs.get(start) ?? Infinity, darts));
    };

    if (composition === 'unknown') {
      publishBest(false);
      result.checks.push({ tournamentId: season.tournamentId, oid: me.oid, state: 'mismatch', games: mine.length, reconstructed: mine.filter((g) => rebuilt.get(g.gameId)?.ok).length, verified: { score: false, f9: false, tons: false, highOut: false, break: false }, compared: null, reason: '種別不明のゲーム枠を含むため、n01公式値と照合できません' });
      if (doublesCount > 0) result.starts.push(seasonStartOf({ season, oid: me.oid, mine, rebuilt, attributionVerified: false, evidence, highIns, highInNote }));
      continue;
    }
    const unmatched = mine.filter((g) => stored.has(g.gameId) && stored.get(g.gameId)!.r.ok && !rebuilt.has(g.gameId) && stored.get(g.gameId)!.fp !== rowPrint.get(g.gameId)).length;
    const check = checkPlayerSeason(season.tournamentId, me.oid, official, classified, rebuilt, composition === 'pure01');
    if (unmatched > 0) {
      check.reason = `${check.reason ? `${check.reason}。` : ''}Leg明細がゲーム一覧の内容（得点・投数・投順）と一致しないゲームが${unmatched}件あります（n01の反映待ちの可能性。「再試行」で取り直します）`;
      if (!(result.awaitingOfficial ?? []).includes(season.tournamentId)) (result.awaitingOfficial ??= []).push(season.tournamentId);
    }
    if (listChanged && !check.verified.score && check.state !== 'incomplete' && !(result.awaitingOfficial ?? []).includes(season.tournamentId)) {
      // n01 may not have counted the change yet: say so, and offer to check again later.
      check.reason = `${check.reason ?? ''}（一覧の更新がn01の公式通算にまだ反映されていない可能性があります。「再試行」で公式通算を取り直します）`;
      (result.awaitingOfficial ??= []).push(season.tournamentId);
    }
    result.checks.push(check);
    publishBest(check.verified.score && !(result.awaitingOfficial ?? []).includes(season.tournamentId));
    if (doublesCount > 0) result.starts.push(seasonStartOf({ season, oid: me.oid, mine, rebuilt, attributionVerified: check.verified.score, evidence, highIns, highInNote }));
    addVerified(result.contributions, check, classified, rebuilt);
    for (const g of mine) if (result.contributions.has(g.gameId)) result.gameSeason[g.gameId] = season.tournamentId;
  }
  // Only confirmed start scores are published; a partial minimum could be worse than the real one.
  if (result.bestLegHeld.all) result.bestLegs.clear();
  for (const start of held) result.bestLegs.delete(start);
  result.bestLegHeld.starts = [...held].sort((a, b) => a - b);
  result.requestsSent = ctx.api.requestCount;
  result.budgetStopped = budgetStopped;
  result.fetched = fetched;
  return result;
}

/**
 * The player's 01 games of one role in the loaded game lists — known before any `match/get`, so a
 * player without such a game is never fetched for. `unknownSeasons`: seasons of the player whose
 * game list is missing, incomplete or still being read; `seasons`: seasons with such a game.
 */
export function roleExposure(seasons: readonly SeasonData[], games: ReadonlyMap<string, SeasonGames> | null, personKey: string, role: 'singles' | 'doubles'): { games: number; unknownSeasons: number; seasons: string[] } {
  let count = 0;
  let unknownSeasons = 0;
  const withGames: string[] = [];
  for (const season of seasons) {
    const me = season.players.find((p) => p.personKey === personKey);
    if (!me) continue;
    const raw = games?.get(season.tournamentId);
    if (!raw?.complete) {
      unknownSeasons += 1;
      continue;
    }
    const n = personGames(classifiedOf(season, raw), me.oid).filter((g) => g.role === role).length;
    count += n;
    if (n > 0) withGames.push(season.tournamentId);
  }
  return { games: count, unknownSeasons, seasons: withGames };
}

/** {@link roleExposure} of doubles. */
export function doublesExposure(seasons: readonly SeasonData[], games: ReadonlyMap<string, SeasonGames> | null, personKey: string): { games: number; unknownSeasons: number } {
  const { games: n, unknownSeasons } = roleExposure(seasons, games, personKey, 'doubles');
  return { games: n, unknownSeasons };
}

/**
 * Seasons with singles games of the player (`seasons`, from {@link roleExposure}), and how many of
 * them passed n01's checksum for First 9 and for Keep/Break (every 01 game of the season rebuilt).
 */
export function singlesCoverage(result: PlayerDetailResult, seasons: readonly string[]): { seasons: number; scoreVerified: number; f9Verified: number; breakVerified: number; checked: number } {
  const checkOf = (id: string) => result.checks.find((c) => c.tournamentId === id);
  return {
    seasons: seasons.length,
    scoreVerified: seasons.filter((id) => checkOf(id)?.verified.score).length,
    checked: seasons.filter((id) => { const c = checkOf(id); return !!c && c.state !== 'incomplete'; }).length,
    f9Verified: seasons.filter((id) => checkOf(id)?.verified.f9).length,
    breakVerified: seasons.filter((id) => checkOf(id)?.verified.break).length,
  };
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
  return result.budgetStopped === true || (result.awaitingOfficial?.length ?? 0) > 0 || result.failures.length > 0 || result.notAttempted.length > 0 || result.stale.length > 0 || result.checks.some((c) => c.state === 'incomplete' && c.games > 0) || result.starts.some((s) => (s.excludedGames['not-fetched'] ?? 0) > 0 || (s.excludedGames['needs-refetch'] ?? 0) > 0);
}
