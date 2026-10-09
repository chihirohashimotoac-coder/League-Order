import { newestFirst } from '../../../integrations/n01/seasonResolver';
import type { N01TournamentSummary } from '../../../integrations/n01/types';
import { splitByFormat } from '../aggregate';
import type { AnalyticsApi } from '../api/readApi';
import type { AnalyticsCache } from '../cache/analyticsCache';
import { buildSeasonData } from '../seasonData';
import type { SeasonData } from '../seasonData';
import { classifySeason, LAST_N } from '../seasons';
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
  /** Cap on seasons for `all`. */
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

export interface PeriodLoad {
  request: PeriodRequest;
  /** Eligible, format-compatible seasons, newest first. */
  seasons: SeasonData[];
  meta: SeasonMeta[];
  failures: { tournamentId: string; title: string; reason: string; kind: SeasonFailed['kind'] }[];
  skipped: { tournamentId: string; title: string; reason: string }[];
  /** Seasons passed over because their format differs from the base season's. */
  formatExcluded: { tournamentId: string; title: string; reason: string }[];
  /**
   * True only when every season the period calls for was read and none was dropped for
   * being unreadable. `all` must not be shown as full history unless this is true.
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

function emptyLoad(request: PeriodRequest, extra: Partial<PeriodLoad>): PeriodLoad {
  return {
    request,
    seasons: [],
    meta: [],
    failures: [],
    skipped: [],
    formatExcluded: [],
    complete: false,
    listError: null,
    offline: false,
    usedStaleCache: false,
    fetchedAt: null,
    requestsSent: 0,
    ...extra,
  };
}

export async function loadPeriod(options: PeriodServiceOptions): Promise<PeriodLoad> {
  const { api, cache, leagueId, request } = options;
  const isOnline = options.isOnline ?? (() => (typeof navigator === 'undefined' ? true : navigator.onLine !== false));
  const ctx: LoaderContext = { api, cache, isOnline, now: options.now ?? (() => Date.now()), forceRefresh: options.forceRefresh };
  const concurrency = Math.max(1, options.concurrency ?? DEFAULT_CONCURRENCY);
  const maxSeasons = options.maxSeasons ?? 12;
  const offline = !isOnline();

  const listing = await loadLeagueList(ctx, leagueId);
  if (!listing.ok || !listing.list) {
    return emptyLoad(request, {
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
  const loaded: { summary: N01TournamentSummary; data: SeasonData }[] = [];
  let complete = true;
  let usedStale = listing.source === 'stale-cache';

  // The ids to try, newest first, and how many eligible seasons are wanted.
  let queue: N01TournamentSummary[];
  let wanted: number;
  if (request.mode === 'current' || request.mode === 'specified') {
    const id = request.mode === 'current' ? request.currentTournamentId : (request.specifiedTournamentId ?? '');
    const found = byId.get(id);
    if (!found) {
      return emptyLoad(request, {
        offline,
        skipped: [{ tournamentId: id, title: '', reason: '大会がリーグの一覧にありません' }],
        usedStaleCache: usedStale,
        requestsSent: api.requestCount,
      });
    }
    queue = [found];
    wanted = 1;
  } else if (request.mode === 'last3') {
    const index = summaries.findIndex((s) => s.tournamentId === request.currentTournamentId);
    if (index < 0) complete = false;
    queue = index >= 0 ? summaries.slice(index) : summaries;
    wanted = LAST_N;
  } else {
    queue = summaries;
    wanted = maxSeasons;
  }

  // Seasons that cannot be a league season from the list alone are never fetched.
  const candidates: N01TournamentSummary[] = [];
  for (const summary of queue) {
    const pre = classifySeason(summary);
    if (pre.kind === 'excluded') skipped.push({ tournamentId: summary.tournamentId, title: summary.title, reason: pre.reason });
    else candidates.push(summary);
  }

  let cursor = 0;
  let stopped = false;
  while (loaded.length < wanted && cursor < candidates.length && !stopped) {
    if (options.signal?.aborted) {
      complete = false;
      break;
    }
    // Never fetch more than are still needed: `last3` stops after three eligible seasons.
    const batch = candidates.slice(cursor, cursor + Math.min(concurrency, wanted - loaded.length));
    cursor += batch.length;
    const results = await Promise.all(batch.map((summary) => loadSeason(ctx, summary.tournamentId)));
    results.forEach((result, i) => {
      const summary = batch[i];
      if (!result.ok) {
        failures.push({ tournamentId: summary.tournamentId, title: summary.title, reason: result.reason, kind: result.kind });
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
      if (loaded.length >= wanted) return;
      if (result.source === 'stale-cache') usedStale = true;
      meta.push(toMeta(summary, result));
      loaded.push({ summary, data: buildSeasonData(result.input) });
    });
  }

  // A cap that cut `all` short means the figure is not the full history.
  if (request.mode === 'all' && loaded.length >= wanted && cursor < candidates.length) complete = false;
  if ((request.mode === 'current' || request.mode === 'specified') && loaded.length === 0) complete = false;

  const ordered = loaded.map((l) => l.data);
  const base = request.mode === 'specified' ? request.specifiedTournamentId : request.currentTournamentId;
  const split = splitByFormat(ordered, ordered.some((s) => s.tournamentId === base) ? base : undefined);

  const times = meta.map((m) => m.fetchedAt);
  return {
    request,
    seasons: split.compatible,
    meta: meta.filter((m) => split.compatible.some((s) => s.tournamentId === m.tournamentId)),
    failures,
    skipped,
    formatExcluded: split.excluded,
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

/** What the UI may call the figure. Full history needs a complete, gap-free fetch. */
export function periodLabelAllowed(load: PeriodLoad): 'full' | 'partial' | 'none' {
  if (load.seasons.length === 0) return 'none';
  return load.complete && load.failures.length === 0 && load.formatExcluded.length === 0 ? 'full' : 'partial';
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
  if (load.failures.length > 0 || !load.complete || load.formatExcluded.length > 0) {
    const parts: string[] = [];
    if (load.failures.length > 0) parts.push(`${load.failures.length} シーズンを取得できませんでした`);
    if (load.formatExcluded.length > 0) parts.push(`${load.formatExcluded.length} シーズンは試合形式が異なるため合算していません`);
    if (parts.length === 0) parts.push('一部のシーズンを確認できていません');
    return { kind: 'partial', message: `${parts.join('。')}。取得できた範囲のみの集計です。` };
  }
  if (load.usedStaleCache) return { kind: 'stale', message: '最新の取得に失敗したため、保存済みのデータを表示しています。' };
  return { kind: 'ready', message: '' };
}
