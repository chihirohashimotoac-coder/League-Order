import { newestFirst } from '../../integrations/n01/seasonResolver';
import type { N01ScheduleSlot, N01Tournament, N01TournamentSummary } from '../../integrations/n01/types';
import { N01_STATUS } from '../../integrations/n01/types';

/**
 * Which tournaments of a league count as "seasons" and which period a request means
 * (design §3, 期間・母集団).
 */

export type SeasonKind = 'league' | 'excluded' | 'unknown';

export interface SeasonClassification {
  kind: SeasonKind;
  reason: string;
}

/** Titles that mark a non-regular event: year-end championships, tests, practice. */
const EXCLUDED_TITLE = /チャンピオンシップ|champion(ship)?s?\b|テスト|\btest\b|試験|練習|ダミー|dummy|sample|サンプル/iu;

/**
 * A regular league season has a league table with divisions and registered teams and is
 * in progress or finished. The title only *excludes* (never includes) an event.
 */
export function classifySeason(summary: Pick<N01TournamentSummary, 'title' | 'status'>, tournament?: N01Tournament): SeasonClassification {
  if (EXCLUDED_TITLE.test(summary.title)) return { kind: 'excluded', reason: 'チャンピオンシップ・テスト等の通常リーグ戦以外' };
  if (summary.status !== N01_STATUS.RUNNING && summary.status !== N01_STATUS.FINISHED) {
    return { kind: 'excluded', reason: '開催中または終了済みではありません' };
  }
  if (!tournament) return { kind: 'unknown', reason: '大会の詳細を未取得' };
  if (EXCLUDED_TITLE.test(tournament.title)) return { kind: 'excluded', reason: 'チャンピオンシップ・テスト等の通常リーグ戦以外' };
  if (tournament.divisions.length === 0 || tournament.entries.length === 0) {
    return { kind: 'unknown', reason: 'ディビジョンまたはチーム登録を確認できません' };
  }
  return { kind: 'league', reason: '' };
}

function slotKey(slot: N01ScheduleSlot): string {
  return [slot.matchType, slot.startScore ?? '', slot.numPart, slot.limitLegCount ?? ''].join(':');
}

/**
 * Identifies the game format. Seasons with different signatures are never pooled: a
 * 501 best-of-3 3DA and a 701 one are different populations. Division overrides are part of it.
 */
export function formatSignature(tournament: Pick<N01Tournament, 'schedule' | 'gameSettings' | 'softdarts'>): string {
  const base = tournament.schedule.map(slotKey).join('|');
  const overrides = [...tournament.gameSettings]
    .sort((a, b) => a.round - b.round)
    .map((setting) => `${setting.round}=${setting.schedule.map(slotKey).join('|')}`)
    .join(';');
  return `soft=${tournament.softdarts ?? '?'};base=${base};div=${overrides}`;
}

export type PeriodMode = 'current' | 'specified' | 'last3' | 'all';

export interface PeriodRequest {
  mode: PeriodMode;
  /** The linked/current season (`current`, and the anchor of `last3`/`all`). */
  currentTournamentId: string;
  /** The chosen season for `specified`. */
  specifiedTournamentId?: string;
}

export interface SeasonCandidate {
  summary: N01TournamentSummary;
  classification: SeasonClassification;
}

export interface SeasonSelection {
  /** Seasons to fetch/aggregate, newest first. */
  seasons: N01TournamentSummary[];
  /** Seasons passed over, with the reason shown to the user. */
  skipped: { tournamentId: string; title: string; reason: string }[];
  /** `all`/`last3` asked for more seasons than the cap allows, or one was unclassified. */
  complete: boolean;
}

export const LAST_N = 3;

/**
 * Chooses the seasons of a period from the league's tournament list.
 *
 * - `last3` = the anchor season plus the two newest earlier eligible ones.
 * - `all` = every eligible season, at most `maxSeasons`; when the cap cuts it, `complete`
 *   is false so the UI cannot call it a full-history figure.
 * - A season whose classification is `unknown` (details not fetched) is never silently
 *   treated as eligible: `complete` turns false and it is listed under `skipped`.
 */
export function selectSeasons(
  candidates: readonly SeasonCandidate[],
  request: PeriodRequest,
  options: { maxSeasons?: number } = {},
): SeasonSelection {
  const maxSeasons = options.maxSeasons ?? 12;
  const byId = new Map(candidates.map((c) => [c.summary.tournamentId, c]));
  const skipped: SeasonSelection['skipped'] = [];
  const nonEligible = (c: SeasonCandidate): boolean => c.classification.kind !== 'league';
  let complete = true;

  if (request.mode === 'current' || request.mode === 'specified') {
    const id = request.mode === 'current' ? request.currentTournamentId : (request.specifiedTournamentId ?? '');
    const found = byId.get(id);
    if (!found) return { seasons: [], skipped: [{ tournamentId: id, title: '', reason: '大会がリーグの一覧にありません' }], complete: false };
    if (nonEligible(found)) {
      return { seasons: [], skipped: [{ tournamentId: id, title: found.summary.title, reason: found.classification.reason }], complete: false };
    }
    return { seasons: [found.summary], skipped, complete };
  }

  const ordered = newestFirst(candidates.map((c) => c.summary));
  const anchorIndex = ordered.findIndex((s) => s.tournamentId === request.currentTournamentId);
  // An anchor outside the list falls back to the whole list rather than guessing a position.
  const fromAnchor = request.mode === 'all' ? ordered : anchorIndex >= 0 ? ordered.slice(anchorIndex) : ordered;
  if (request.mode === 'last3' && anchorIndex < 0) complete = false;
  const eligible: N01TournamentSummary[] = [];
  for (const summary of fromAnchor) {
    const candidate = byId.get(summary.tournamentId)!;
    if (nonEligible(candidate)) {
      skipped.push({ tournamentId: summary.tournamentId, title: summary.title, reason: candidate.classification.reason });
      if (candidate.classification.kind === 'unknown') complete = false;
      continue;
    }
    eligible.push(summary);
  }
  if (request.mode === 'last3') return { seasons: eligible.slice(0, LAST_N), skipped, complete };
  if (eligible.length > maxSeasons) complete = false;
  return { seasons: eligible.slice(0, maxSeasons), skipped, complete };
}
