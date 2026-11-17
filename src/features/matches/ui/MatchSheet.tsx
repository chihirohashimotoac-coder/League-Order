import type { LiveStatus } from '../livePoller';

/**
 * What the live poller says, in the words shown beside the score. (A game used to open here in a
 * sheet; every game now opens on its own page, SetMatchPage, the same from wherever it is opened.)
 */
export function liveStatusText(status: LiveStatus, ended = false): { text: string; tone: 'ok' | 'paused' | 'error' | 'done' } {
  if (ended || status.kind === 'finished') return { text: '終了', tone: 'done' };
  if (status.kind === 'polling') return { text: '自動更新中', tone: 'ok' };
  if (status.kind === 'paused-hidden') return { text: '一時停止中 (非表示)', tone: 'paused' };
  if (status.kind === 'retrying') return { text: '取得失敗 (前回の値)', tone: 'error' };
  return { text: '接続中…', tone: 'paused' };
}
