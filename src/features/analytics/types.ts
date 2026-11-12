/**
 * Analytics data contract (docs: League-Order-Player-Team-Analytics-Design-2026-10-09.md).
 *
 * Everything here is analytics-only. Nothing in this folder writes to the optimizer, the
 * stores or the n01 sync; it reads n01's public API and computes numbers from raw counts.
 *
 * Rule that runs through all of it: a value n01 did not report is `null`, never 0, and a
 * ratio is always carried as its numerator and denominator so periods can be pooled
 * correctly (Σ numerator / Σ denominator) instead of averaging averages.
 */

/** Raw counters of one stats row (a team's or a player's season totals). `null` = not reported. */
export interface StatLine {
  score: number | null;
  darts: number | null;
  f9Score: number | null;
  f9Darts: number | null;
  leg: number | null;
  winLeg: number | null;
  set: number | null;
  winSet: number | null;
  /** Legs thrown first-to-break ("a_b"): the denominator of Break. */
  breakLegs: number | null;
  /** Legs won among {@link breakLegs} ("w_b"). */
  breakWins: number | null;
  /** Appearances (matches / games the row took part in). Never a win count for players. */
  match: number | null;
  /** Teams only: wins as n01's stats report them. Players' value is not meaningful (always 0 in practice). */
  winMatch: number | null;
  ton00: number | null;
  ton40: number | null;
  ton70: number | null;
  ton80: number | null;
  /** 0 and absent both mean "no record" → null. */
  highOut: number | null;
  bestLeg: number | null;
  /**
   * The rest of n01's stats row, read only to show n01's own stats table (スタッツの「全て表示」).
   * Optional: lines built elsewhere (tests, pooled periods) simply do not carry them.
   */
  n01?: N01StatExtras;
}

/** Fields of an n01 stats row beyond the pooled counters above (raw, `null` = not reported). */
export interface N01StatExtras {
  /** `worst`: the most darts a won leg took. */
  worstLeg: number | null;
  /** `highOutCount`: checkouts of 100 or more. */
  highOutCount: number | null;
  /** `a` / `acnt`: averages entered by hand (submitted results) that n01 blends into the 3-dart average. */
  manualAvg: number | null;
  manualAvgCount: number | null;
  /** `ho` / `hc`: the row has 01 / Cricket games (n01 shows the 01 or Cricket columns by them). */
  has01: boolean;
  hasCricket: boolean;
  /** Cricket: `cLeg`, `cDarts`, `cMarks`, hand-entered MPR `ca` / `cacnt`, and the 9-6 mark rounds. */
  cricketLegs: number | null;
  cricketDarts: number | null;
  cricketMarks: number | null;
  manualMpr: number | null;
  manualMprCount: number | null;
  mark9: number | null;
  mark8: number | null;
  mark7: number | null;
  mark6: number | null;
}

export const STAT_FIELDS = [
  'score',
  'darts',
  'f9Score',
  'f9Darts',
  'leg',
  'winLeg',
  'set',
  'winSet',
  'breakLegs',
  'breakWins',
  'match',
  'winMatch',
  'ton00',
  'ton40',
  'ton70',
  'ton80',
  'highOut',
  'bestLeg',
] as const satisfies readonly (keyof StatLine)[];

/** The pooled counters of a {@link StatLine} (everything but the n01-only extras). */
export type StatCounter = (typeof STAT_FIELDS)[number];

export interface TeamStatsRow {
  /** `tpid` (the key of `stats_list`). */
  teamId: string;
  /** `r_g`: division index when n01 reports it. */
  divisionIndex: number | null;
  line: StatLine;
}

export interface PlayerStatsRow {
  /** Tournament-scoped id (the key of `player_stats_list`). */
  oid: string;
  opid: string | null;
  teamId: string | null;
  name: string | null;
  divisionIndex: number | null;
  line: StatLine;
}

/** One row of `tournament/standings` (groups[kind=lg]). */
export interface OfficialStandingRow {
  teamId: string;
  name: string;
  /** 0 = not ranked yet (no match played). Never shown as a rank. */
  rank: number;
  played: number;
  won: number;
  drawn: number;
  lost: number;
  points: number;
}

export interface OfficialStandingGroup {
  divisionIndex: number;
  title: string;
  rows: OfficialStandingRow[];
}

/** What a stat can mean for a given season: `ok` or why it is unusable. */
export type Reliability = 'none' | 'reference' | 'sufficient';

export type MetricId =
  | 'ppr'
  | 'first9'
  | 'legRate'
  | 'setRate'
  | 'keep'
  | 'break'
  | 'ton00Rate'
  | 'ton40Rate'
  | 'ton70Rate'
  | 'ton80Rate';

/** A pooled ratio: `value = num / den`, `null` when no season has a usable denominator. */
export interface Ratio {
  num: number;
  den: number;
  value: number | null;
}

export interface Extremes {
  /** Largest recorded High Finish (0 / missing ignored). */
  highOut: number | null;
  /** Fewest darts in a won leg (0 / missing ignored). */
  bestLeg: number | null;
}

export interface Counts {
  ton00: number | null;
  ton40: number | null;
  ton70: number | null;
  ton80: number | null;
  /** Appearances; not a win count. */
  match: number | null;
}

export interface Metrics {
  ppr: Ratio;
  first9: Ratio;
  legRate: Ratio;
  setRate: Ratio;
  keep: Ratio;
  break: Ratio;
  ton00Rate: Ratio;
  ton40Rate: Ratio;
  ton70Rate: Ratio;
  ton80Rate: Ratio;
  extremes: Extremes;
  counts: Counts;
  /** Seasons that contributed at least one usable line. */
  seasons: number;
}
