import type { LiveLeg, LiveThrow } from '../parse';

/**
 * The 01 score sheet as n01's viewer draws it (`n01_view.js` `initScore` / `addRound`,
 * `n01.css` `.ton`), shared by the live board and the finished game history:
 *
 * - five fixed columns, Scored / To Go per side, the darts thrown so far in the middle
 *   (3, 6, 9 … — n01's "darts" round display), a start row with the starting points;
 * - a visit of 100 or more has the score circled (n01's `circleTon`), drawn as a background
 *   so the cell keeps its size and the number its font size;
 * - the finishing visit shows the darts used at the double, `x1` / `x2` / `x3`, in the Scored
 *   cell with the To Go cell blank (n01 never writes 0 there) and no circle;
 * - League Order adds what n01 does not: 100+ bold, 140+ in the accent colour, 180 in red.
 *
 * `order` maps the two columns to n01's sides (the card's left team first).
 */

/**
 * League Order's own marking on top of n01's circle: 100+ bold, 140+ bold in the accent
 * colour, 180 heavier in red (n01 draws every score in one colour).
 */
const tone = (score: number): string => (score === 180 ? ' ton t180' : score >= 140 ? ' ton t140' : score >= 100 ? ' ton t100' : '');

type Visit = Extract<LiveThrow, { kind: '01' }>;
type CricketVisit = Extract<LiveThrow, { kind: 'cricket' }>;

export function ZeroOneGrid({
  leg,
  startScore = null,
  thrower = null,
  order = [0, 1],
  names,
  minRows = 0,
  spare = 0,
  label,
}: {
  leg: Pick<LiveLeg, 'throws' | 'start' | 'first'>;
  startScore?: number | null;
  /** Live: the side to throw next, whose next cell is highlighted. */
  thrower?: 0 | 1 | null;
  order?: [0 | 1, 0 | 1];
  /** Names over the columns (column order); the first thrower is marked `*` as in n01. */
  names?: [string, string];
  minRows?: number;
  /** Empty rows kept after the last visit (live). */
  spare?: number;
  label?: string;
}): React.JSX.Element {
  const rounds = new Map<number, [Visit | null, Visit | null]>();
  for (const entry of leg.throws) {
    if (entry.kind !== '01') continue;
    const row = rounds.get(entry.round) ?? [null, null];
    row[entry.side] = entry;
    rounds.set(entry.round, row);
  }
  const last = Math.max(0, ...rounds.keys());
  // The round the next visit goes into.
  const nextRound = thrower === null ? null : leg.throws.filter((entry) => entry.side === thrower).length + 1;
  const shown = Math.max(minRows, last + spare, nextRound ?? 0);
  const start = leg.start ?? [startScore ?? 501, startScore ?? 501];

  const cells = (side: 0 | 1, round: number): React.JSX.Element[] => {
    const entry = rounds.get(round)?.[side] ?? null;
    if (entry?.finish) {
      return [
        <td key="s" className="sc out" aria-label={`${entry.score} で上がり (${entry.darts}本目)`}>
          x{entry.darts}
        </td>,
        <td key="g" className="tg" />,
      ];
    }
    const waiting = !entry && nextRound === round && thrower === side;
    return [
      <td key="s" className={`sc${waiting ? ' waiting' : ''}${entry ? tone(entry.score) : ''}`}>
        {entry ? entry.score : waiting ? <span className="ns-dot" aria-label="投擲中" /> : ''}
      </td>,
      <td key="g" className="tg">
        {entry ? entry.left : ''}
      </td>,
    ];
  };

  const firstCol = leg.first === null ? null : leg.first === order[0] ? 0 : 1;
  return (
    <table className="ns-table" data-testid="score-sheet" aria-label={label}>
      <colgroup>
        <col className="c-side" />
        <col className="c-side" />
        <col className="c-mid" />
        <col className="c-side" />
        <col className="c-side" />
      </colgroup>
      <thead>
        {names ? (
          <tr className="names">
            <th scope="colgroup" colSpan={2}>
              {firstCol === 0 ? '* ' : ''}
              {names[0]}
            </th>
            <th aria-hidden="true" />
            <th scope="colgroup" colSpan={2}>
              {firstCol === 1 ? '* ' : ''}
              {names[1]}
            </th>
          </tr>
        ) : null}
        <tr>
          <th scope="col">Scored</th>
          <th scope="col">To Go</th>
          <th scope="col" aria-label="ダーツ数" />
          <th scope="col">Scored</th>
          <th scope="col">To Go</th>
        </tr>
      </thead>
      <tbody>
        <tr className="start">
          <td className="sc" />
          <td className="tg">{start[order[0]]}</td>
          <td className="mid" />
          <td className="sc" />
          <td className="tg">{start[order[1]]}</td>
        </tr>
        {Array.from({ length: shown }, (_, i) => i + 1).map((round) => (
          <tr key={round}>
            {cells(order[0], round)}
            <td className="mid">{round * 3}</td>
            {cells(order[1], round)}
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/** A finished Cricket leg in the same grid: hits and marks per visit, darts in the middle. */
export function CricketGrid({
  leg,
  order = [0, 1],
  names,
  label,
}: {
  leg: Pick<LiveLeg, 'throws' | 'first'>;
  order?: [0 | 1, 0 | 1];
  names?: [string, string];
  label?: string;
}): React.JSX.Element {
  const rounds = new Map<number, [CricketVisit | null, CricketVisit | null]>();
  for (const entry of leg.throws) {
    if (entry.kind !== 'cricket') continue;
    const row = rounds.get(entry.round) ?? [null, null];
    row[entry.side] = entry;
    rounds.set(entry.round, row);
  }
  const last = Math.max(0, ...rounds.keys());
  const firstCol = leg.first === null ? null : leg.first === order[0] ? 0 : 1;
  const hits = (entry: CricketVisit): string =>
    entry.hits.map((hit) => `${hit.mark === 3 ? 'T' : hit.mark === 2 ? 'D' : 'S'}${hit.number === 25 ? 'B' : hit.number}`).join(' ') || '—';
  const cells = (side: 0 | 1, round: number): React.JSX.Element[] => {
    const entry = rounds.get(round)?.[side] ?? null;
    return [
      <td key="h" className="hits">
        {entry ? hits(entry) : ''}
      </td>,
      <td key="m" className={`sc${entry && entry.marks >= 5 ? ' t140' : ''}`}>
        {entry ? `${entry.marks}M${entry.points ? ` +${entry.points}` : ''}` : ''}
      </td>,
    ];
  };
  return (
    <table className="ns-table cricket-sheet" data-testid="score-sheet" aria-label={label}>
      <colgroup>
        <col className="c-hits" />
        <col className="c-marks" />
        <col className="c-mid" />
        <col className="c-hits" />
        <col className="c-marks" />
      </colgroup>
      <thead>
        {names ? (
          <tr className="names">
            <th scope="colgroup" colSpan={2}>
              {firstCol === 0 ? '* ' : ''}
              {names[0]}
            </th>
            <th aria-hidden="true" />
            <th scope="colgroup" colSpan={2}>
              {firstCol === 1 ? '* ' : ''}
              {names[1]}
            </th>
          </tr>
        ) : null}
        <tr>
          <th scope="col">Hits</th>
          <th scope="col">Marks</th>
          <th scope="col" aria-label="ダーツ数" />
          <th scope="col">Hits</th>
          <th scope="col">Marks</th>
        </tr>
      </thead>
      <tbody>
        {Array.from({ length: last }, (_, i) => i + 1).map((round) => (
          <tr key={round}>
            {cells(order[0], round)}
            <td className="mid">{round * 3}</td>
            {cells(order[1], round)}
          </tr>
        ))}
      </tbody>
    </table>
  );
}
