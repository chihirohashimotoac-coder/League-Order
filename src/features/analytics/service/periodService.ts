import { newestFirst } from '../../../integrations/n01/seasonResolver';
import type { N01TournamentSummary } from '../../../integrations/n01/types';
import type { AnalyticsApi } from '../api/readApi';
import type { AnalyticsCache } from '../cache/analyticsCache';
import { buildSeasonData } from '../seasonData';
import type { SeasonData } from '../seasonData';
import { classifySeason, LAST_12, wantedSeasons } from '../seasons';
import type { PeriodRequest } from '../seasons';
import { loadLeagueList, loadSeason } from './seasonLoader';
import type { DataSource, LoaderContext, SeasonFailed, SeasonLoaded } from './seasonLoader';

/**
 * Fetches the seasons a period needs (design §3 + PR B): newest first, a few at a time,
 * stopping as soon as `last3` has its three, bounded by a request budget, and honest about
 * what it could not get.
 *
 * Nothing here throws into the caller and nothing here touches the order screens: a failure
 * becomes a field of {@link PeriodLoad}.
 */

export interface PeriodServiceOptions {
  api: AnalyticsApi;
  cache: AnalyticsCache;
  leagueId: string;
  request: PeriodRequest;
  /** Seasons fetched in parallel. Each season is up to 5 requests, so keep this small. */
  concurrency?: number;
  /** Upper bound on the seasons of a multi-season period (tests); never above 12. */
  maxSeasons?: number;
  isOnline?: () => boolean;
  now?: () => number;
  forceRefresh?: boolean;
  signal?: AbortSignal;
}

export interface SeasonMeta {
  tournamentId: string;
  title: string;
  source: DataSource;
  fetchedAt: number;
  /** Parts of the season that could not be read (official ranks / season linking are then withheld). */
  missing: ('standings' | 'roster')[];
  error?: string;
}

/** One position of the period's window, newest first. */
export interface WindowSlot {
  tournamentId: string;
  title: string;
  state: 'loaded' | 'failed' | 'not-fetched';
  reason?: string;
}

export interface PeriodLoad {
  request: PeriodRequest;
  /** Seasons the period asks for (1, 3 or 12). */
  wanted: number;
  /** Eligible seasons that were read, newest first. Formats may differ: they still pool. */
  seasons: SeasonData[];
  meta: SeasonMeta[];
  failures: { tournamentId: string; title: string; reason: string; kind: SeasonFailed['kind'] }[];
  skipped: { tournamentId: string; title: string; reason: string }[];
  /**
   * The period's window: every season position, read or not. A season that failed keeps its
   * place — it is never silently replaced by an older one.
   */
  window: WindowSlot[];
  /**
   * True only when every season the period calls for was read. A multi-season period must
   * not be shown as complete unless this is true.
   */
  complete: boolean;
  /** The season list itself could not be read (nothing else can be shown). */
  listError: { reason: string; kind: SeasonFailed['kind'] } | null;
  offline: boolean;
  usedStaleCache: boolean;
  /** Oldest and newest data timestamps behind the figures. */
  fetchedAt: { oldest: number; newest: number } | null;
  requestsSent: number;
}

const DEFAULT_CONCURRENCY = 3;

export function emptyLoad(request: PeriodRequest, extra: Partial<PeriodLoad>): PeriodLoad {
  return {
    request,
    wanted: wantedSeasons(request.mode),
    seasons: [],
    meta: [],
    failures: [],
    skipped: [],
    window: [],
    complete: false,
    listError: null,
    offline: false,
    usedStaleCache: false,
    fetchedAt: null,
    requestsSent: 0,
    ...extra,
  };
}

/** Lets the browser paint between seasons, so parsing twelve seasons never freezes the screen. */
function yieldToBrowser(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

export async function loadPeriod(options: PeriodServiceOptions): Promise<PeriodLoad> {
  const { api, cache, leagueId, request } = options;
  const isOnline = options.isOnline ?? (() => (typeof navigator === 'undefined' ? true : navigator.onLine !== false));
  const ctx: LoaderContext = { api, cache, isOnline, now: options.now ?? (() => Date.now()), forceRefresh: options.forceRefresh };
  const concurrency = Math.max(1, options.concurrency ?? DEFAULT_CONCURRENCY);
  const offline = !isOnline();
  const wanted = Math.min(wantedSeasons(request.mode), Math.max(1, options.maxSeasons ?? LAST_12));

  const listing = await loadLeagueList(ctx, leagueId);
  if (!listing.ok || !listing.list) {
    return emptyLoad(request, {
      wanted,
      offline,
      listError: { reason: listing.reason ?? 'シーズン一覧を取得できません。', kind: listing.kind ?? 'network' },
      requestsSent: api.requestCount,
    });
  }

  const summaries = newestFirst(listing.list.tournaments);
  const byId = new Map(summaries.map((s) => [s.tournamentId, s]));
  const skipped: PeriodLoad['skipped'] = [];
  const failures: PeriodLoad['failures'] = [];
  const meta: SeasonMeta[] = [];
  const window: WindowSlot[] = [];
  const loaded: SeasonData[] = [];
  let complete = true;
  let usedStale = listing.source === 'stale-cache';

  // The ids to try, newest first.
  let queue: N01TournamentSummary[];
  if (request.mode === 'current' || request.mode === 'specified') {
    const id = request.mode === 'current' ? request.currentTournamentId : (request.specifiedTournamentId ?? '');
    const found = byId.get(id);
    if (!found) {
      return emptyLoad(request, {
        wanted,
        offline,
        skipped: [{ tournamentId: id, title: '', reason: '大会がリーグの一覧にありません' }],
        usedStaleCache: usedStale,
        requestsSent: api.requestCount,
      });
    }
    queue = [found];
  } else {
    const index = summaries.findIndex((s) => s.tournamentId === request.currentTournamentId);
    // An anchor outside the list falls back to the newest seasons, and says so.
    if (index < 0) complete = false;
    queue = index >= 0 ? summaries.slice(index) : summaries;
  }

  // Seasons that cannot be a league season from the list alone are never fetched.
  const candidates: N01TournamentSummary[] = [];
  for (const summary of queue) {
    const pre = classifySeason(summary);
    if (pre.kind === 'excluded') skipped.push({ tournamentId: summary.tournamentId, title: summary.title, reason: pre.reason });
    else candidates.push(summary);
  }

  // Window positions are filled by seasons that were read *or failed*: a failure is a gap in
  // the period, not a reason to reach further back in time.
  const filled = (): number => loaded.length + failures.length;
  let cursor = 0;
  let stopped = false;
  while (filled() < wanted && cursor < candidates.length && !stopped) {
    if (options.signal?.aborted) {
      complete = false;
      break;
    }
    const batch = candidates.slice(cursor, cursor + Math.min(concurrency, wanted - filled()));
    cursor += batch.length;
    const results = await Promise.all(batch.map((summary) => loadSeason(ctx, summary.tournamentId)));
    results.forEach((result, i) => {
      const summary = batch[i];
      if (!result.ok) {
        if (filled() >= wanted) return;
        failures.push({ tournamentId: summary.tournamentId, title: summary.title, reason: result.reason, kind: result.kind });
        window.push({ tournamentId: summary.tournamentId, title: summary.title, state: 'failed', reason: result.reason });
        complete = false;
        if (result.kind === 'budget' || result.kind === 'aborted') stopped = true;
        return;
      }
      const classification = classifySeason(summary, result.input.tournament);
      if (classification.kind !== 'league') {
        skipped.push({ tournamentId: summary.tournamentId, title: summary.title, reason: classification.reason });
        if (classification.kind === 'unknown') complete = false;
        return;
      }
      if (filled() >= wanted) return;
      if (result.source === 'stale-cache') usedStale = true;
      meta.push(toMeta(summary, result));
      loaded.push(buildSeasonData(result.input));
      window.push({ tournamentId: summary.tournamentId, title: summary.title, state: 'loaded' });
    });
    await yieldToBrowser();
  }

  // Positions nobody filled: the history is shorter, or fetching stopped (budget / cancel).
  if (filled() < wanted) {
    complete = false;
    for (const summary of candidates.slice(cursor, cursor + (wanted - filled()))) {
      window.push({ tournamentId: summary.tournamentId, title: summary.title, state: 'not-fetched', reason: stopped ? '通信の上限または中断のため未取得' : undefined });
    }
  }

  const times = meta.map((m) => m.fetchedAt);
  return {
    request,
    wanted,
    seasons: loaded,
    meta,
    failures,
    skipped,
    window,
    complete,
    listError: null,
    offline,
    usedStaleCache: usedStale,
    fetchedAt: times.length > 0 ? { oldest: Math.min(...times), newest: Math.max(...times) } : null,
    requestsSent: api.requestCount,
  };
}

function toMeta(summary: N01TournamentSummary, result: SeasonLoaded): SeasonMeta {
  return {
    tournamentId: summary.tournamentId,
    title: summary.title,
    source: result.source,
    fetchedAt: result.fetchedAt,
    missing: result.missing,
    ...(result.error ? { error: result.error } : {}),
  };
}

/** What the UI may call the figure. A full period needs every wanted season, read without gaps. */
export function periodLabelAllowed(load: PeriodLoad): 'full' | 'partial' | 'none' {
  if (load.seasons.length === 0) return 'none';
  return load.complete && load.failures.length === 0 && load.seasons.length >= load.wanted ? 'full' : 'partial';
}

/** Plain-language state for the screens. */
export type LoadStateKind = 'error' | 'empty' | 'partial' | 'offline-cache' | 'stale' | 'ready';

export function describeLoad(load: PeriodLoad): { kind: LoadStateKind; message: string } {
  if (load.listError) return { kind: 'error', message: `シーズン一覧を取得できませんでした: ${load.listError.reason}` };
  if (load.seasons.length === 0) {
    const why = load.failures[0]?.reason ?? load.skipped[0]?.reason ?? '対象のシーズンがありません。';
    return { kind: load.failures.length > 0 ? 'error' : 'empty', message: why };
  }
  if (load.offline) return { kind: 'offline-cache', message: 'オフラインのため、保存済みのデータで表示しています。' };
  if (periodLabelAllowed(load) !== 'full') {
    const missing = load.wanted - load.seasons.length;
    const parts: string[] = [];
    if (load.failures.length > 0) parts.push(`${load.failures.length}季を取得できませんでした`);
    else if (missing > 0) parts.push(`${load.wanted}季のうち${load.seasons.length}季のみ取得できました`);
    if (parts.length === 0) parts.push('一部のシーズンを確認できていません');
    return { kind: 'partial', message: `${parts.join('。')}。取得できた範囲のみの集計（部分集計）です。` };
  }
  if (load.usedStaleCache) return { kind: 'stale', message: '最新の取得に失敗したため、保存済みのデータを表示しています。' };
  return { kind: 'ready', message: '' };
}
