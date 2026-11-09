import { LIST_LIMITS } from '../api';
import type { ListKind } from '../api';

/**
 * What a paged game list did not bring, said in one short line next to what it did bring:
 * the page cap (`truncated`), the rows n01 sent that could not be read (`unreadable`), and a
 * page boundary on equal start times, where a game may have been skipped (`unsure`).
 * Nothing is shown for a whole list — a list of none included. The games that were read stay
 * on screen; the line goes away by itself once a refresh brings the whole list.
 */
export interface ListCoverageState {
  truncated: boolean;
  unreadable: number;
  /** Two pages met on equal start times: a game may have fallen between them (`GameList.unsure`). */
  unsure?: boolean;
}

export const listIncomplete = (state: ListCoverageState): boolean => state.truncated || state.unreadable > 0 || state.unsure === true;

export function coverageText(state: ListCoverageState, kind: ListKind): string | null {
  if (!listIncomplete(state)) return null;
  const limit = LIST_LIMITS[kind];
  const parts: string[] = [];
  if (state.truncated) parts.push(`${limit.order === 'newest' ? '新しい順' : '古い順'}に ${limit.games.toLocaleString('ja-JP')} 件まで取得 (${limit.order === 'newest' ? 'それより前' : 'それより新しい試合'}は未取得)`);
  if (state.unreadable > 0) parts.push(`読めなかった試合 ${state.unreadable} 件 (表示・集計に含めていません)`);
  if (state.unsure) parts.push('同じ開始時刻の試合がページの境目をまたぎ、欠けている可能性があります');
  return `一覧の一部を取得できていません: ${parts.join('、')}。`;
}

export function ListCoverage({ state, kind }: { state: ListCoverageState; kind: ListKind }): React.JSX.Element | null {
  const text = coverageText(state, kind);
  if (!text) return null;
  return (
    <p className="small-text list-coverage" role="status" data-testid="list-coverage">
      {text}
    </p>
  );
}
