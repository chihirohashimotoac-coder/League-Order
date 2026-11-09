import { useEffect, useState } from 'react';

/**
 * Searching and paging a ranking that is already in memory (スタッツ): no request is sent.
 *
 * The rank of a row is its place under the chosen filters and sort, computed **before** the
 * name search — searching for a player shows where they really stand, not "1". Rows are shown
 * {@link RANK_PAGE} at a time with a way to the rest, so every player can be reached.
 */

export const RANK_PAGE = 60;

/** Name as typed vs. as listed: full / half width, case and spaces do not matter. */
export function normalizeName(value: string): string {
  return value.normalize('NFKC').toLowerCase().replace(/\s+/gu, '');
}

export function matchesQuery(name: string, query: string): boolean {
  const needle = normalizeName(query);
  return needle === '' || normalizeName(name).includes(needle);
}

export interface Ranked<T> {
  rank: number;
  item: T;
}

/** Ranks 1…n in the given order, then keeps the rows whose name matches. */
export function rankThenSearch<T>(sorted: readonly T[], query: string, nameOf: (item: T) => string): Ranked<T>[] {
  return sorted.map((item, index) => ({ rank: index + 1, item })).filter((entry) => matchesQuery(nameOf(entry.item), query));
}

/** How many rows are shown; back to one page whenever `resetKey` (filters, sort, query) changes. */
export function useShownCount(resetKey: string): [number, (next: number) => void] {
  const [shown, setShown] = useState(RANK_PAGE);
  useEffect(() => setShown(RANK_PAGE), [resetKey]);
  return [shown, setShown];
}

export function RankingSearch({ value, onChange, label }: { value: string; onChange: (next: string) => void; label: string }): React.JSX.Element {
  return (
    <input
      type="search"
      className="ranking-search"
      value={value}
      onChange={(event) => onChange(event.target.value)}
      placeholder={label}
      aria-label={label}
      enterKeyHint="search"
      autoComplete="off"
    />
  );
}

/**
 * "60 / 136 人を表示" and the way to the rest. With a search, says how many matched; with no
 * match, says so (an empty search result is not an empty ranking).
 */
export function RankingFooter({
  shown,
  matched,
  total,
  query,
  onMore,
}: {
  shown: number;
  matched: number;
  total: number;
  query: string;
  onMore: (next: number) => void;
}): React.JSX.Element {
  const searching = query.trim() !== '';
  return (
    <div className="ranking-footer small-text" data-testid="ranking-footer">
      <p className="muted" role="status">
        {searching
          ? matched === 0
            ? `「${query.trim()}」に一致する選手はいません (対象 ${total} 人)`
            : `「${query.trim()}」に一致 ${matched} 人 (対象 ${total} 人)`
          : `${Math.min(shown, matched)} / ${matched} 人を表示`}
      </p>
      {shown < matched ? (
        <div className="row wrap" style={{ gap: 8 }}>
          <button type="button" className="btn small" onClick={() => onMore(shown + RANK_PAGE)}>
            さらに {Math.min(RANK_PAGE, matched - shown)} 人
          </button>
          <button type="button" className="btn small ghost" onClick={() => onMore(matched)}>
            すべて表示
          </button>
        </div>
      ) : null}
    </div>
  );
}
