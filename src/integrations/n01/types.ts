/**
 * Normalised n01 data (docs/N01_DATA_MODEL.md).
 *
 * Every response from n01 passes through `validation.ts` before anything else reads it,
 * and comes out as one of these types. Nothing outside `validation.ts` ever touches a
 * raw response, so a change in n01's wire format is absorbed in one file.
 *
 * Field comments name the n01 field each value is read from.
 */

/** Tournament status codes as n01 reports them. */
export const N01_STATUS = {
  /** Accepting entries / preparing. */
  OPEN: 20,
  /** In progress. */
  RUNNING: 30,
  /** Finished. */
  FINISHED: 40,
} as const;

export interface N01LeagueSummary {
  /** `lgid` */
  leagueId: string;
  /** League title; empty when n01 did not include it. */
  title: string;
}

export interface N01TournamentSummary {
  /** `tdid` */
  tournamentId: string;
  title: string;
  /** `status` (20 / 30 / 40 …), `null` when absent or not a number. */
  status: number | null;
  /** Start date as epoch ms when n01 provides a parsable date, else `null`. */
  startedAt: number | null;
  /** Position in n01's list (0-based), used for ordering when no date is given. */
  listIndex: number;
}

export interface N01LeagueTournaments {
  league: N01LeagueSummary;
  tournaments: N01TournamentSummary[];
}

/** One team entered in a tournament (`entry_list`). */
export interface N01Entry {
  /** `tpid` — scoped to this tournament. */
  teamId: string;
  name: string;
}

/** One division of the league table (`lg_table[i]`). */
export interface N01Division {
  /** Position in `lg_table`; the key `game_setting[].round` refers to. */
  index: number;
  /** `lg_title` */
  title: string;
  /** `tpid`s of the teams in the division. */
  teamIds: string[];
}

/** One game of the match format (`lg_setting.schedule[i]`). */
export interface N01ScheduleSlot {
  schid: string;
  /** `num_part`: players per side. */
  numPart: number;
  subtitle: string | null;
  /** `match_type`, lower-cased (`01`, `cricket`, …). */
  matchType: string;
  /** `start_score` (501, 701, 1001 …) when given. */
  startScore: number | null;
  /** `limit_leg_count`: legs needed to win, when given. */
  limitLegCount: number | null;
  group: string | null;
}

/** Division-specific format override (`lg_setting.game_setting[i]`). */
export interface N01GameSetting {
  /** `round` — the division index the override applies to. */
  round: number;
  schedule: N01ScheduleSlot[];
}

/** Game result inside a finished match (`lg_result[…].games[i]`), when n01 reports it. */
export interface N01GameResult {
  schid: string;
  /** `tpid` of the winning side; `null` for a drawn / unplayed game. */
  winnerTeamId: string | null;
}

/** Result of one league match (`lg_result`). */
export interface N01MatchResult {
  /** `lsid` of the match. */
  matchId: string;
  finished: boolean;
  games: N01GameResult[];
}

export interface N01Tournament {
  tournamentId: string;
  title: string;
  leagueId: string | null;
  status: number | null;
  /** `softdarts`: 1 → true, 0 → false, missing → null. Never guessed from the title. */
  softdarts: boolean | null;
  entries: N01Entry[];
  divisions: N01Division[];
  /** `lg_setting.schedule` — the base format. */
  schedule: N01ScheduleSlot[];
  /** `lg_setting.game_setting` — per-division overrides. */
  gameSettings: N01GameSetting[];
  /** `lg_result`, keyed by match id. */
  results: Map<string, N01MatchResult>;
}

/** One player on a team's roster (`team/player/list`). */
export interface N01RosterPlayer {
  /** Stable player id across seasons; `null` when n01 omitted it. */
  opid: string | null;
  /** Tournament-scoped player id. */
  oid: string;
  /** `tpid` of the team in this tournament. */
  teamId: string;
  /** `oname` */
  name: string;
}

/**
 * Per-player tournament statistics (`tournament/stats` → `player_stats_list`).
 * Optional metrics are `null` when n01 did not report them — never 0.
 */
export interface N01PlayerStats {
  opid: string | null;
  oid: string | null;
  teamId: string | null;
  name: string | null;
  score: number;
  darts: number;
  legs: number | null;
  /** Matches (games) played, when reported. */
  matches: number | null;
  legsWon: number | null;
  first9Score: number | null;
  first9Darts: number | null;
  highOut: number | null;
  bestLeg: number | null;
  ton: number | null;
  ton40: number | null;
  ton70: number | null;
  ton80: number | null;
}

/** One league fixture (`league/schedule/get`). */
export interface N01Fixture {
  /** `lsid` */
  matchId: string;
  /** Raw title as n01 shows it. */
  title: string;
  /** The two sides; the second is `null` for a bye. */
  homeTeamId: string;
  awayTeamId: string | null;
  /** `YYYY-MM-DD` when a date could be parsed, else `null`. */
  date: string | null;
  /** Position in n01's list, used for ordering when there is no date. */
  listIndex: number;
}

/** One game a team fielded in a past match (`team/order/list`). */
export interface N01OrderEntry {
  /** `lsid` of the match, when given. */
  matchId: string | null;
  schid: string;
  /** `position` of the game in the match order (1-based), when given. */
  position: number | null;
  /** The players fielded, as tournament-scoped ids (`oid`) with `opid` when present. */
  players: { oid: string | null; opid: string | null; name: string | null }[];
}
