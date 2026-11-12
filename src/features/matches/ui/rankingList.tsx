/**
 * Searching and paging a ranking that is already in memory (スタッツ): no request is sent.
 *
 * The rank of a row is its place under the chosen filters and sort, computed **before** the
 * name search — searching for a player shows where they really stand, not "1". Every row is
 * shown at once, so the list holds as many players as n01's own stats page.
 */

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
 * How many rows the list holds: "136 人を表示", or "87 / 136 人を表示" when a filter leaves some
 * out (`of` = every row before the filters). With a search, says how many matched; with no match,
 * says so (an empty search result is not an empty ranking).
 */
export function RankingFooter({
  matched,
  total,
  of = total,
  query,
  noun = '選手',
}: {
  matched: number;
  /** Rows under the filters, before the search. */
  total: number;
  /** Rows before the filters (n01's own count); defaults to `total`. */
  of?: number;
  query: string;
  /** What a row is: 選手 (team members) or エントリー (an individual event's entries). */
  noun?: '選手' | 'エントリー';
}): React.JSX.Element {
  const searching = query.trim() !== '';
  const unit = noun === '選手' ? '人' : '件';
  return (
    <div className="ranking-footer small-text" data-testid="ranking-footer">
      <p className="muted" aria-live="polite">
        {searching
          ? matched === 0
            ? `「${query.trim()}」に一致する${noun}はいません (対象 ${total} ${unit})`
            : `「${query.trim()}」に一致 ${matched} ${unit} (対象 ${total} ${unit})`
          : total < of
            ? `${total} / ${of} ${unit}を表示 (絞り込み中)`
            : `${total} ${unit}を表示`}
      </p>
    </div>
  );
}
