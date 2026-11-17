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
 * - League Order 独自の表示: Scored の 100–139 は太字の青、140–179 は太字の青緑、180 ちょうどは
 *   さらに太い深い赤 (01 のみ。色は `.zero-one` に付けるので、`t140` を共有する Cricket の表は
 *   従来の色のまま)。To Go・中央のダーツ数・投擲中のセル・空欄・上がりの `x1` / `x2` / `x3` には
 *   色を付けない。
 * - `history` (終了した Leg を見返すとき): 列の役割ごとに背景と文字の段階を変える。Scored は明るい
 *   面で一段大きく太く、To Go は薄い青灰の面で標準ウェイト、ダーツ数はニュートラルな面で一段小さく、
 *   上がりのセルは淡いアクセント面 (`out`)。進行中の Leg はライブの見た目のまま。
 *
 * `order` maps the two columns to n01's sides (the card's left team first).
 */

/**
 * n01 の丸囲みに重ねる League Order 独自の分類 (n01 はすべて同じ色で描く):
 * 100–139 は `t100`、140–179 は `t140`、180 ちょうどは `t180`。上がりには付けない。
 */
const tone = (score: number): string => (score === 180 ? ' ton t180' : score >= 140 ? ' ton t140' : score >= 100 ? ' ton t100' : '');

export interface Mark {
  side: 0 | 1;
  round: number;
}

const marked = (mark: Mark | null, side: 0 | 1, round: number): string => (mark && mark.side === side && mark.round === round ? ' mark' : '');

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
  mark = null,
  history = false,
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
  /** A visit to point at (n01 side and round), e.g. from a highlight. */
  mark?: Mark | null;
  /** 終了した Leg を見返すとき: 履歴用の背景と文字の段階 (進行中の Leg には使わない)。 */
  history?: boolean;
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
        <td key="s" className={`sc out${marked(mark, side, round)}`} aria-label={`${entry.score} で上がり (${entry.darts}本目)`}>
          x{entry.darts}
        </td>,
        <td key="g" className="tg" />,
      ];
    }
    const waiting = !entry && nextRound === round && thrower === side;
    return [
      <td key="s" className={`sc${waiting ? ' waiting' : ''}${entry ? tone(entry.score) : ''}${marked(mark, side, round)}`}>
        {entry ? entry.score : waiting ? <span className="ns-dot" aria-label="投擲中" /> : ''}
      </td>,
      <td key="g" className="tg">
        {entry ? entry.left : ''}
      </td>,
    ];
  };

  const firstCol = leg.first === null ? null : leg.first === order[0] ? 0 : 1;
  return (
    <table className={`ns-table zero-one${history ? ' is-history' : ''}`} data-testid="score-sheet" aria-label={label}>
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
          <tr key={round} className={mark?.round === round ? 'marked' : undefined}>
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
  mark = null,
}: {
  leg: Pick<LiveLeg, 'throws' | 'first'>;
  order?: [0 | 1, 0 | 1];
  names?: [string, string];
  label?: string;
  mark?: Mark | null;
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
      <td key="h" className={`hits${marked(mark, side, round)}`}>
        {entry ? hits(entry) : ''}
      </td>,
      <td key="m" className={`sc${entry && entry.marks >= 5 ? ' t140' : ''}${marked(mark, side, round)}`}>
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
          <tr key={round} className={mark?.round === round ? 'marked' : undefined}>
            {cells(order[0], round)}
            <td className="mid">{round * 3}</td>
            {cells(order[1], round)}
          </tr>
        ))}
      </tbody>
    </table>
  );
}
