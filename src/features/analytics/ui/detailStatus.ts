import { doublesCoverage, needsRetry, singlesCoverage } from '../service/detailService';
import type { PlayerDetailResult } from '../service/detailService';

/**
 * What the singles / doubles views say about the automatic leg read of the shown player, in four
 * states a reader can tell apart: 取得中 (`waiting` / `running`), 部分集計 (`partial`), 取得失敗
 * (`failed`, with a retry) and 記録不足・対象外 (`unavailable` / `none`). `done`: everything the
 * period holds was read and checked.
 */
export type DetailStatus =
  | { kind: 'waiting'; text: string }
  | { kind: 'running'; text: string }
  | { kind: 'none'; text: string }
  | { kind: 'unavailable'; text: string }
  | { kind: 'failed'; text: string }
  | { kind: 'partial'; text: string; retry: boolean }
  | { kind: 'done'; text: string };

export const STATUS_BADGE: Record<DetailStatus['kind'], string> = {
  waiting: '取得中',
  running: '取得中',
  partial: '部分集計',
  failed: '取得失敗',
  unavailable: '記録不足・対象外',
  none: '対象外',
  done: '取得済み',
};

export type DetailRole = 'singles' | 'doubles';

const ROLE_LABEL: Record<DetailRole, string> = { singles: 'シングルス01', doubles: 'ダブルス01' };
const METRICS_OF: Record<DetailRole, string> = { singles: 'First 9・Keep率・Break率', doubles: '個人の3DA・First 9' };

export interface Exposure {
  games: number;
  unknownSeasons: number;
  seasons: string[];
}

export function hasRetry(status: DetailStatus): boolean {
  return status.kind === 'failed' || (status.kind === 'partial' && status.retry);
}

/** Seasons of the role that passed the checks the role's leg figures need. */
function verifiedSeasons(role: DetailRole, result: PlayerDetailResult, exposure: Exposure): { seasons: number; verified: number; checked: number } {
  if (role === 'doubles') {
    const c = doublesCoverage(result);
    const checked = result.checks.filter((k) => exposure.seasons.includes(k.tournamentId) && k.state !== 'incomplete').length;
    return { seasons: Math.max(c.seasons, exposure.seasons.length), verified: c.scoreVerified, checked };
  }
  const c = singlesCoverage(result, exposure.seasons);
  return { seasons: c.seasons, verified: c.scoreVerified, checked: c.checked };
}

export function detailStatusOf(input: {
  role: DetailRole;
  gamesLoading: boolean;
  exposure: Exposure | null;
  running: boolean;
  /** More parts of the read are under way or will follow. */
  partial: boolean;
  /** The result was checked against game lists that have since been read again with other content. */
  outdated?: boolean;
  result: PlayerDetailResult | undefined;
}): DetailStatus {
  const { role, exposure, result } = input;
  const label = ROLE_LABEL[role];
  if (!exposure) return { kind: 'waiting', text: 'ゲーム記録を取得中…' };
  if (exposure.games === 0) {
    if (exposure.unknownSeasons > 0) {
      return input.gamesLoading
        ? { kind: 'waiting', text: `ゲーム記録を取得中…（${label}の出場を確認しています）` }
        : { kind: 'failed', text: `ゲーム記録を取得できないため、${label}の出場を確認できません（「集計の内訳」の「ゲーム記録を再試行」で取り直せます）` };
    }
    return { kind: 'none', text: `この期間に${label}の出場がないため、Leg明細から求める個人成績の対象はありません` };
  }
  if (!result) return input.running ? { kind: 'running', text: 'Leg明細を取得中…（この選手のゲームのみ）' } : { kind: 'waiting', text: 'Leg明細の取得を準備中…' };
  const v = verifiedSeasons(role, result, exposure);
  if (input.outdated) return { kind: 'running', text: 'ゲーム記録が更新されたため、Leg明細を照合し直しています（取得済みの明細は再利用します）' };
  if (input.running || input.partial) {
    return { kind: 'running', text: `Leg明細を取得中…（${label}出場${v.seasons}季中${v.checked}季を照合済み。照合できた季から表示しています）` };
  }
  const retry = needsRetry(result);
  if (result.checks.length === 0 && result.failures.length > 0) return { kind: 'failed', text: result.failures[0] };
  if (v.verified === 0) {
    if (retry) return { kind: 'failed', text: `一部のLeg明細を取得できなかったため、${METRICS_OF[role]}は表示していません` };
    return { kind: 'unavailable', text: `n01公式の通算値と一致した季がないため、${METRICS_OF[role]}は表示していません（記録不足）` };
  }
  const waitingSeasons = exposure.unknownSeasons > 0 && input.gamesLoading;
  if (v.verified < v.seasons || exposure.unknownSeasons > 0) {
    const tail = waitingSeasons ? '。残りの季のゲーム記録を取得中（そろい次第更新）' : exposure.unknownSeasons > 0 ? '。ゲーム記録を取得できない季は含めていません' : '（残りは表示に含めていません）';
    return { kind: 'partial', text: `部分集計：${label}出場${v.seasons}季中${v.verified}季で公式値と一致${tail}`, retry };
  }
  if (retry) return { kind: 'partial', text: `${label}出場${v.seasons}季すべてで公式値と一致。一部のLeg明細を取得できませんでした（採否は「照合の内訳」を参照）`, retry };
  return { kind: 'done', text: `取得済み：${label}出場${v.seasons}季すべてで公式値と一致` };
}

/**
 * The note of a card whose figure comes from the leg read (`undefined`: the generic note).
 * `verified`: seasons of the role whose check admitted this metric.
 */
export function legCardNote(metricLabel: string, hasValue: boolean, status: DetailStatus | null, verified: number, seasons: number): string | undefined {
  if (!status) return undefined;
  if (!hasValue) {
    if (status.kind === 'done' || status.kind === 'partial') return `${metricLabel}は公式値と一致した季がないため表示しません（記録不足）`;
    return status.text;
  }
  const base = 'Leg明細から復元（公式値と一致した季のみ）';
  if (status.kind === 'waiting' || status.kind === 'running') return `取得中・照合済みの季のみ：${base}`;
  return verified < seasons ? `部分集計：${seasons}季中${verified}季。${base}` : base;
}
