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
 *   none of those (140+ / Best Leg / Break, or a column sorted in 全て表示) — first, next to the
 *   name, so a phone shows it too.
 * - 全て表示: n01's player table column for column (the table scrolls sideways), printed the way
 *   n01 prints it (0 / 0.00 / 0.00%).
 */

/** The sorts of the chips above the table (any numeric column can also be sorted by its header). */
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

/** A chip's sort or a header's: the id of a {@link SORT_DEFS} entry. */
export type SortId = string;

interface SortDef {
  /** Over the rank column, and the header of the column added next to the name. */
  label: string;
  /** The figure a row is ranked by; `null` = none (the row is listed unranked at the end). */
  value: (line: PlayerLine['line']) => number | null;
  /** Fewer is better (Best / Worst Leg: darts). */
  ascending?: boolean;
  /** How the column added next to the name prints it. */
  kind: 'count' | 'avg' | 'rate';
}

const positiveOrNull = (value: number | null | undefined): number | null => (value !== null && value !== undefined && value > 0 ? value : null);

export const SORT_DEFS: Record<SortId, SortDef> = {
  avg: { label: '平均', value: n01Avg3, kind: 'avg' },
  f9: { label: 'First 9', value: n01First9, kind: 'avg' },
  legRate: { label: 'Leg率', value: n01WinRateLeg, kind: 'rate' },
  ton80: { label: '180', value: (line) => line.ton80, kind: 'count' },
  ton40: { label: '140+', value: (line) => line.ton40, kind: 'count' },
  highOut: { label: 'High Out', value: (line) => line.highOut, kind: 'count' },
  bestLeg: { label: 'Best Leg', value: (line) => line.bestLeg, ascending: true, kind: 'count' },
  break: { label: 'Break', value: n01Break, kind: 'rate' },
  match: { label: 'Matches', value: (line) => line.match, kind: 'count' },
  winMatch: { label: 'Matches Won', value: (line) => line.winMatch, kind: 'count' },
  set: { label: 'Sets', value: (line) => line.set, kind: 'count' },
  winSet: { label: 'Sets Won', value: (line) => line.winSet, kind: 'count' },
  leg: { label: 'Legs', value: (line) => line.leg, kind: 'count' },
  legDiff: { label: 'Legs Diff', value: n01LegDiff, kind: 'count' },
  winLeg: { label: 'Legs Won', value: (line) => line.winLeg, kind: 'count' },
  ton00: { label: '100+', value: (line) => line.ton00, kind: 'count' },
  ton70: { label: '170+', value: (line) => line.ton70, kind: 'count' },
  highOutCount: { label: '100+ Finishes', value: (line) => line.n01?.highOutCount ?? null, kind: 'count' },
  worstLeg: { label: 'Worst Leg', value: (line) => positiveOrNull(line.n01?.worstLeg), ascending: true, kind: 'count' },
  mark9: { label: '9 Mark', value: (line) => line.n01?.mark9 ?? null, kind: 'count' },
  mark8: { label: '8 Mark', value: (line) => line.n01?.mark8 ?? null, kind: 'count' },
  mark7: { label: '7 Mark', value: (line) => line.n01?.mark7 ?? null, kind: 'count' },
  mark6: { label: '6 Mark', value: (line) => line.n01?.mark6 ?? null, kind: 'count' },
  winRateMatch: { label: '勝率 (Match)', value: n01WinRateMatch, kind: 'rate' },
  winRateSet: { label: '勝率 (Sets)', value: n01WinRateSet, kind: 'rate' },
  avg1: { label: '1 Dart 平均', value: n01Avg1, kind: 'avg' },
  dynamicAvg: { label: 'Dynamic 平均', value: n01DynamicAvg, kind: 'avg' },
  mpr: { label: 'MPR', value: n01Mpr, kind: 'avg' },
  keep: { label: 'Keep', value: n01Keep, kind: 'rate' },
  secondLegs: { label: 'Second Legs', value: (line) => line.breakLegs, kind: 'count' },
  breakLegs: { label: 'Break Legs', value: (line) => line.breakWins, kind: 'count' },
  score: { label: 'Total Score', value: (line) => line.score, kind: 'count' },
  darts: { label: 'Total Darts', value: (line) => line.darts, kind: 'count' },
};

/** An id the table knows; anything else (an old saved view) falls back to 平均. */
export function knownSort(id: SortId): SortId {
  return Object.hasOwn(SORT_DEFS, id) ? id : 'avg';
}

/** The figure a row is ranked by under a sort; `null` = none (listed unranked at the end). */
export function sortValue(line: PlayerLine['line'], id: SortId): number | null {
  return SORT_DEFS[knownSort(id)].value(line);
}

export function sortAscending(id: SortId): boolean {
  return SORT_DEFS[knownSort(id)].ascending ?? false;
}

export function sortLabel(id: SortId): string {
  return SORT_DEFS[knownSort(id)].label;
}

export interface StatsColumn {
  key: string;
  /** Header text; `\n` breaks the line as n01's headers do. */
  label: string;
  /** The sort its header sets (and that marks it while chosen); none = not sortable (text). */
  sort?: SortId;
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

const DEFAULT_SORTS: readonly SortId[] = ['avg', 'f9', 'legRate', 'ton80', 'highOut'];

export function defaultColumns(sort: SortId): StatsColumn[] {
  const columns: StatsColumn[] = [
    { key: 'avg', label: '平均', sort: 'avg', cell: (row) => dash(n01Avg3(row.line), 2) },
    { key: 'f9', label: 'First 9', sort: 'f9', cell: (row) => dash(n01First9(row.line), 2) },
    { key: 'leg', label: 'Leg', sort: 'legRate', cell: (row) => ofWithRate(row.line.winLeg, row.line.leg, n01WinRateLeg(row.line)) },
    { key: 'ton80', label: '180', sort: 'ton80', cell: (row) => dash(row.line.ton80) },
    { key: 'highOut', label: 'High Out', sort: 'highOut', cell: (row) => dash(row.line.highOut) },
  ];
  const id = knownSort(sort);
  if (!DEFAULT_SORTS.includes(id)) {
    const def = SORT_DEFS[id];
    const cell =
      id === 'break'
        ? (row: PlayerLine) => ofWithRate(row.line.breakWins, row.line.breakLegs, n01Break(row.line))
        : (row: PlayerLine) => {
            const v = def.value(row.line);
            return v === null ? '—' : def.kind === 'count' ? String(v) : def.kind === 'avg' ? v.toFixed(2) : n01Text(v, 'rate');
          };
    columns.unshift({ key: `sorted-${id}`, label: def.label, sort: id, cell });
  }
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
    matchExists && { key: 'match', label: 'Matches\nPlayed', sort: 'match', cell: count((row) => row.line.match) },
    matchExists && !member && { key: 'winMatch', label: 'Matches\nWon', sort: 'winMatch', cell: count((row) => row.line.winMatch) },
    setExists && { key: 'set', label: 'Sets\nPlayed', sort: 'set', cell: count((row) => row.line.set) },
    setExists && { key: 'winSet', label: 'Sets\nWon', sort: 'winSet', cell: count((row) => row.line.winSet) },
    { key: 'leg', label: 'Legs\nPlayed', sort: 'leg', cell: count((row) => row.line.leg) },
    { key: 'legDiff', label: 'Legs\nDiff', sort: 'legDiff', cell: count((row) => n01LegDiff(row.line)) },
    { key: 'winLeg', label: 'Legs\nWon', sort: 'winLeg', cell: count((row) => row.line.winLeg) },
    show01 && { key: 'ton00', label: '100+', sort: 'ton00', cell: count((row) => row.line.ton00) },
    show01 && { key: 'ton40', label: '140+', sort: 'ton40', cell: count((row) => row.line.ton40) },
    show01 && { key: 'ton70', label: '170+', sort: 'ton70', cell: count((row) => positive(row.line.ton70)) },
    show01 && { key: 'ton80', label: "180's", sort: 'ton80', cell: count((row) => row.line.ton80) },
    show01 && { key: 'highOut', label: 'High\nFinish', sort: 'highOut', cell: count((row) => positive(row.line.highOut)) },
    show01 && { key: 'highOutCount', label: '100+\nFinishes', sort: 'highOutCount', cell: count((row) => positive(row.line.n01?.highOutCount)) },
    show01 && { key: 'bestLeg', label: 'Best\nLeg', sort: 'bestLeg', cell: count((row) => positive(row.line.bestLeg)) },
    show01 && { key: 'worstLeg', label: 'Worst\nLeg', sort: 'worstLeg', cell: count((row) => positive(row.line.n01?.worstLeg)) },
    hasCricket && { key: 'mark9', label: '9\nMark', sort: 'mark9', cell: count((row) => row.line.n01?.mark9) },
    hasCricket && { key: 'mark8', label: '8\nMark', sort: 'mark8', cell: count((row) => row.line.n01?.mark8) },
    hasCricket && { key: 'mark7', label: '7\nMark', sort: 'mark7', cell: count((row) => row.line.n01?.mark7) },
    hasCricket && { key: 'mark6', label: '6\nMark', sort: 'mark6', cell: count((row) => row.line.n01?.mark6) },
    matchExists && !member && { key: 'winRateMatch', label: '勝率\n(Match)', sort: 'winRateMatch', cell: rate((row) => n01WinRateMatch(row.line)) },
    setExists && { key: 'winRateSet', label: '勝率\n(Sets)', sort: 'winRateSet', cell: rate((row) => n01WinRateSet(row.line)) },
    { key: 'winRateLeg', label: '勝率\n(Legs)', sort: 'legRate', cell: rate((row) => n01WinRateLeg(row.line)) },
    show01 && { key: 'avg3', label: '3 Darts\n平均', sort: 'avg', cell: avg((row) => n01Avg3(row.line)) },
    show01 && { key: 'avg1', label: '1 Dart\n平均', sort: 'avg1', cell: avg((row) => n01Avg1(row.line)) },
    show01 && options.dynamicAvg && { key: 'dynamicAvg', label: 'Dynamic\n平均', sort: 'dynamicAvg', cell: avg((row) => n01DynamicAvg(row.line)) },
    show01 && { key: 'f9', label: 'First 9\n平均', sort: 'f9', cell: avg((row) => n01First9(row.line)) },
    hasCricket && { key: 'mpr', label: 'MPR', sort: 'mpr', cell: avg((row) => n01Mpr(row.line)) },
    { key: 'keep', label: 'Keep', sort: 'keep', cell: rate((row) => n01Keep(row.line)) },
    { key: 'break', label: 'Break', sort: 'break', cell: rate((row) => n01Break(row.line)) },
    { key: 'secondLegs', label: 'Second\nLegs', sort: 'secondLegs', cell: count((row) => row.line.breakLegs) },
    { key: 'breakLegs', label: 'Break\nLegs', sort: 'breakLegs', cell: count((row) => row.line.breakWins) },
    { key: 'score', label: 'Total\nScore', sort: 'score', cell: count((row) => row.line.score) },
    { key: 'darts', label: 'Total\nDarts', sort: 'darts', cell: count((row) => row.line.darts) },
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
