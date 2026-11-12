import type React from 'react';
import {
  n01Avg1,
  n01Avg3,
  n01Break,
  n01DynamicAvg,
  n01First9,
  n01Keep,
  n01LegDiff,
  n01Mpr,
  n01Text,
  n01WinRateLeg,
  n01WinRateMatch,
  n01WinRateSet,
} from '../../analytics/n01Figures';
import type { PlayerLine } from './useMatchContext';

/**
 * The columns of the スタッツ table. Every figure comes from {@link n01Figures}, the formulas of
 * n01's own stats page, so the same row never shows two different numbers here and on n01.
 *
 * - The default view: 平均 · First 9 · Leg · 180 · High Out, plus the sort's own column when it is
 *   none of those (140+ / Best Leg / Break) — first, next to the name, so a phone shows it too.
 * - 全て表示: n01's player table column for column (the table scrolls sideways), printed the way
 *   n01 prints it (0 / 0.00 / 0.00%).
 */

export type SortKey = 'avg' | 'f9' | 'legRate' | 'ton80' | 'ton40' | 'highOut' | 'bestLeg' | 'break';

export const SORTS: [SortKey, string][] = [
  ['avg', '平均'],
  ['f9', 'First 9'],
  ['legRate', 'Leg率'],
  ['ton80', '180'],
  ['ton40', '140+'],
  ['highOut', 'High Out'],
  ['bestLeg', 'Best Leg'],
  ['break', 'Break'],
];

/** The figure a row is ranked by; `null` = none (the row is listed unranked at the end). */
export function sortValue(line: PlayerLine['line'], key: SortKey): number | null {
  switch (key) {
    case 'avg':
      return n01Avg3(line);
    case 'f9':
      return n01First9(line);
    case 'legRate':
      return n01WinRateLeg(line);
    case 'ton80':
      return line.ton80;
    case 'ton40':
      return line.ton40;
    case 'highOut':
      return line.highOut;
    case 'bestLeg':
      return line.bestLeg;
    case 'break':
      return n01Break(line);
  }
}

export interface StatsColumn {
  key: string;
  /** Header text; `\n` breaks the line as n01's headers do. */
  label: string;
  /** The sort this column shows, so it is marked while that sort is chosen. */
  sort?: SortKey;
  cell: (row: PlayerLine) => React.ReactNode;
}

const dash = (value: number | null | undefined, digits?: number): string => (value === null || value === undefined ? '—' : digits === undefined ? String(value) : value.toFixed(digits));

/** "30/35" over "85.71%". */
function ofWithRate(won: number | null, of: number | null, rate: number | null): React.ReactNode {
  if (of === null || of === 0) return '—';
  return (
    <>
      {won ?? 0}/{of}
      <span className="td-sub">{n01Text(rate, 'rate')}</span>
    </>
  );
}

export function defaultColumns(sort: SortKey): StatsColumn[] {
  const columns: StatsColumn[] = [
    { key: 'avg', label: '平均', sort: 'avg', cell: (row) => dash(n01Avg3(row.line), 2) },
    { key: 'f9', label: 'First 9', sort: 'f9', cell: (row) => dash(n01First9(row.line), 2) },
    { key: 'leg', label: 'Leg', sort: 'legRate', cell: (row) => ofWithRate(row.line.winLeg, row.line.leg, n01WinRateLeg(row.line)) },
    { key: 'ton80', label: '180', sort: 'ton80', cell: (row) => dash(row.line.ton80) },
    { key: 'highOut', label: 'High Out', sort: 'highOut', cell: (row) => dash(row.line.highOut) },
  ];
  if (sort === 'ton40') columns.unshift({ key: 'ton40', label: '140+', sort: 'ton40', cell: (row) => dash(row.line.ton40) });
  if (sort === 'bestLeg') columns.unshift({ key: 'bestLeg', label: 'Best Leg', sort: 'bestLeg', cell: (row) => dash(row.line.bestLeg) });
  if (sort === 'break') columns.unshift({ key: 'break', label: 'Break', sort: 'break', cell: (row) => ofWithRate(row.line.breakWins, row.line.breakLegs, n01Break(row.line)) });
  return columns;
}

export interface AllColumnsOptions {
  /** `member` = n01's player table (ID column, no Match Won); `entry` = its team / entry table. */
  unit: 'member' | 'entry';
  /** The competition's `dynamic_avg`: n01 then shows Dynamic 平均. */
  dynamicAvg: boolean;
  divisionTitle: (row: PlayerLine) => string;
}

/** n01's stats table, in n01's order, with the columns n01 hides for this competition left out. */
export function allColumns(rows: readonly PlayerLine[], options: AllColumnsOptions): StatsColumn[] {
  const count = (pick: (row: PlayerLine) => number | null | undefined) => (row: PlayerLine) => n01Text(pick(row) ?? null, 'count');
  const avg = (pick: (row: PlayerLine) => number | null) => (row: PlayerLine) => n01Text(pick(row), 'avg');
  const rate = (pick: (row: PlayerLine) => number | null) => (row: PlayerLine) => n01Text(pick(row), 'rate');
  const positive = (value: number | null | undefined): number => (value !== null && value !== undefined && value > 0 ? value : 0);
  // n01 shows a column group only when some row has it (matches, sets, Cricket, 01).
  const matchExists = rows.some((row) => (row.line.match ?? 0) > 0);
  const setExists = rows.some((row) => (row.line.set ?? 0) > 0);
  const hasCricket = rows.some((row) => row.line.n01?.hasCricket);
  const has01 = rows.some((row) => row.line.n01?.has01);
  const show01 = !hasCricket || has01;
  const member = options.unit === 'member';
  const columns: (StatsColumn | false)[] = [
    member && { key: 'id', label: 'ID', cell: (row) => row.opid ?? '' },
    matchExists && { key: 'match', label: 'Matches\nPlayed', cell: count((row) => row.line.match) },
    matchExists && !member && { key: 'winMatch', label: 'Matches\nWon', cell: count((row) => row.line.winMatch) },
    setExists && { key: 'set', label: 'Sets\nPlayed', cell: count((row) => row.line.set) },
    setExists && { key: 'winSet', label: 'Sets\nWon', cell: count((row) => row.line.winSet) },
    { key: 'leg', label: 'Legs\nPlayed', cell: count((row) => row.line.leg) },
    { key: 'legDiff', label: 'Legs\nDiff', cell: count((row) => n01LegDiff(row.line)) },
    { key: 'winLeg', label: 'Legs\nWon', cell: count((row) => row.line.winLeg) },
    show01 && { key: 'ton00', label: '100+', cell: count((row) => row.line.ton00) },
    show01 && { key: 'ton40', label: '140+', sort: 'ton40', cell: count((row) => row.line.ton40) },
    show01 && { key: 'ton70', label: '170+', cell: count((row) => positive(row.line.ton70)) },
    show01 && { key: 'ton80', label: "180's", sort: 'ton80', cell: count((row) => row.line.ton80) },
    show01 && { key: 'highOut', label: 'High\nFinish', sort: 'highOut', cell: count((row) => positive(row.line.highOut)) },
    show01 && { key: 'highOutCount', label: '100+\nFinishes', cell: count((row) => positive(row.line.n01?.highOutCount)) },
    show01 && { key: 'bestLeg', label: 'Best\nLeg', sort: 'bestLeg', cell: count((row) => positive(row.line.bestLeg)) },
    show01 && { key: 'worstLeg', label: 'Worst\nLeg', cell: count((row) => positive(row.line.n01?.worstLeg)) },
    hasCricket && { key: 'mark9', label: '9\nMark', cell: count((row) => row.line.n01?.mark9) },
    hasCricket && { key: 'mark8', label: '8\nMark', cell: count((row) => row.line.n01?.mark8) },
    hasCricket && { key: 'mark7', label: '7\nMark', cell: count((row) => row.line.n01?.mark7) },
    hasCricket && { key: 'mark6', label: '6\nMark', cell: count((row) => row.line.n01?.mark6) },
    matchExists && !member && { key: 'winRateMatch', label: '勝率\n(Match)', cell: rate((row) => n01WinRateMatch(row.line)) },
    setExists && { key: 'winRateSet', label: '勝率\n(Sets)', cell: rate((row) => n01WinRateSet(row.line)) },
    { key: 'winRateLeg', label: '勝率\n(Legs)', sort: 'legRate', cell: rate((row) => n01WinRateLeg(row.line)) },
    show01 && { key: 'avg3', label: '3 Darts\n平均', sort: 'avg', cell: avg((row) => n01Avg3(row.line)) },
    show01 && { key: 'avg1', label: '1 Dart\n平均', cell: avg((row) => n01Avg1(row.line)) },
    show01 && options.dynamicAvg && { key: 'dynamicAvg', label: 'Dynamic\n平均', cell: avg((row) => n01DynamicAvg(row.line)) },
    show01 && { key: 'f9', label: 'First 9\n平均', sort: 'f9', cell: avg((row) => n01First9(row.line)) },
    hasCricket && { key: 'mpr', label: 'MPR', cell: avg((row) => n01Mpr(row.line)) },
    { key: 'keep', label: 'Keep', cell: rate((row) => n01Keep(row.line)) },
    { key: 'break', label: 'Break', sort: 'break', cell: rate((row) => n01Break(row.line)) },
    { key: 'secondLegs', label: 'Second\nLegs', cell: count((row) => row.line.breakLegs) },
    { key: 'breakLegs', label: 'Break\nLegs', cell: count((row) => row.line.breakWins) },
    { key: 'score', label: 'Total\nScore', cell: count((row) => row.line.score) },
    { key: 'darts', label: 'Total\nDarts', cell: count((row) => row.line.darts) },
    { key: 'group', label: 'グループ', cell: options.divisionTitle },
  ];
  return columns.filter((column): column is StatsColumn => column !== false);
}

/** A header with n01's line breaks. */
export function ColumnLabel({ label }: { label: string }): React.JSX.Element {
  const [first, ...rest] = label.split('\n');
  return (
    <>
      {first}
      {rest.map((line) => (
        <span key={line} className="th-line">
          {line}
        </span>
      ))}
    </>
  );
}
