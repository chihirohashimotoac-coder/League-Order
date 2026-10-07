/**
 * Deterministic n01 fixture generator (test-only).
 *
 * Builds raw n01 responses — exactly the shapes `integrations/n01/validation.ts` reads —
 * for a whole league over several seasons: tournament lists, entry lists, league
 * tables, formats (with division overrides), rosters, schedules, past orders, match
 * results and per-player stats.
 *
 * Results are *simulated* from each person's hidden "true" PPR with a seeded PRNG, so
 * every run produces identical data, and backtests have a ground truth to be checked
 * against. That makes the fixtures good for testing the pipeline (resolution, history,
 * leakage, metrics) — and says nothing about how well the model fits real leagues.
 */

export interface RawSlot {
  schid: string;
  num_part: number;
  match_type: string;
  start_score?: number;
  limit_leg_count?: number;
  subtitle?: string;
}

export interface FixtureTeamSpec {
  tpid: string;
  name: string;
  /** opids of the registered members, in registration order. */
  members: string[];
  /** Members that never play (no stats row at all). */
  benched?: string[];
}

export interface FixtureSeasonSpec {
  tournamentId: string;
  title: string;
  status: 20 | 25 | 30 | 40;
  startDate: string;
  schedule: RawSlot[];
  gameSettings?: { round: number; schedule: RawSlot[] }[];
  divisions: { title: string; teams: FixtureTeamSpec[] }[];
  /** Explicit rounds; when absent a single round robin is generated per division. */
  rounds?: { date: string; title?: string; pairs: [string, string | null][] }[];
  intervalDays?: number;
}

export interface FixturePerson {
  name: string;
  ppr: number;
  /** n01 omits the opid for this person (exercises the oid / name fallbacks). */
  noOpid?: boolean;
}

export interface FixtureLeagueSpec {
  leagueId: string;
  title: string;
  /** `softdarts` as n01 reports it; `null` omits the field. */
  softdarts: 0 | 1 | null;
  people: Record<string, FixturePerson>;
  /** Newest first. */
  seasons: FixtureSeasonSpec[];
  seed: number;
  /** Matches dated before this day are played. */
  today: string;
  /** opids that get a stats row with zero darts in the newest season. */
  zeroDarts?: string[];
  /**
   * Response shapes. `n01` is the real API as known from its External Integration API
   * Manual and the owner's check against live data: `{ result: 0, tournament }` with
   * `lg_table` as one array of tpids per division (`"empty"` = bye) and titles in
   * `lg_title[]`, `lg_result` keyed `<division>_<lsid>`, camelCase stats rows
   * (`leg`, `winLeg`, `match`, `f9Score`, `f9Darts`, …), fixtures nested per division as
   * `{ p: [tpid1, tpid2], lsid, t }`, order rows as `{ tmid, position, order }`.
   * `legacy` is the flat shape the integration was first written against. The parser
   * reads both, so each fixture league exercises one.
   */
  shape?: 'n01' | 'legacy';
}

/** A fixture dataset: request key → raw response. */
export type FixtureDataset = Map<string, unknown>;

export function requestKey(operation: string, params: Record<string, string>): string {
  return `${operation}?${Object.keys(params)
    .sort()
    .map((key) => `${key}=${params[key]}`)
    .join('&')}`;
}

// ---------------------------------------------------------------------------

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function addDays(iso: string, days: number): string {
  const date = new Date(`${iso}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function roundRobin(teams: readonly string[]): [string, string | null][][] {
  const list: (string | null)[] = [...teams];
  if (list.length % 2 === 1) list.push(null);
  const rounds: [string, string | null][][] = [];
  const n = list.length;
  for (let r = 0; r < n - 1; r += 1) {
    const pairs: [string, string | null][] = [];
    for (let i = 0; i < n / 2; i += 1) {
      const a = list[i];
      const b = list[n - 1 - i];
      if (a === null && b === null) continue;
      pairs.push(a === null ? [b as string, null] : [a, b]);
    }
    rounds.push(pairs);
    list.splice(1, 0, list.pop() as string | null);
  }
  return rounds;
}

interface StatAccumulator {
  opid: string;
  oid: string;
  tpid: string;
  name: string;
  score: number;
  darts: number;
  legs: number;
  legsWon: number;
  first9Score: number;
  first9Darts: number;
  matches: number;
}

/** Ground truth for backtests: every simulated game, oldest first. */
/** One player's numbers in one simulated game. */
export interface SimulatedLine {
  opid: string;
  score: number;
  darts: number;
  legs: number;
  legsWon: number;
}

export interface SimulatedGame {
  tournamentId: string;
  /** 0 = the oldest season of the league. */
  seasonOrdinal: number;
  matchId: string;
  date: string;
  schid: string;
  gameIndex: number;
  numPart: number;
  matchType: string;
  homeTpid: string;
  awayTpid: string;
  homeOpids: string[];
  awayOpids: string[];
  homeWon: boolean;
  legsToWin: number;
  /** What every player of both sides scored in this game. */
  lines: SimulatedLine[];
}

export interface GeneratedLeague {
  dataset: FixtureDataset;
  games: SimulatedGame[];
}

/** A format slot as n01 really names its fields (`startScore`, `subTitle`). */
function realSlot(slot: RawSlot): Record<string, unknown> {
  const { start_score: startScore, subtitle: subTitle, ...rest } = slot;
  return { ...rest, ...(startScore === undefined ? {} : { startScore }), ...(subTitle === undefined ? {} : { subTitle }) };
}

export function generateLeague(spec: FixtureLeagueSpec): GeneratedLeague {
  const rng = mulberry32(spec.seed);
  const dataset: FixtureDataset = new Map();
  const games: SimulatedGame[] = [];
  const opidOf = (opid: string): string | undefined => (spec.people[opid]?.noOpid ? undefined : opid);

  dataset.set(requestKey('league/tournament/list', { lgid: spec.leagueId }), {
    lgid: spec.leagueId,
    title: spec.title,
    // n01 lists tournaments in creation order (oldest first here) and dates them with
    // `t_date`; the legacy shape is newest first with `start_date`.
    list: (spec.shape === 'n01' ? [...spec.seasons].reverse() : spec.seasons).map((season) => ({
      tdid: season.tournamentId,
      title: season.title,
      status: season.status,
      ...(spec.shape === 'n01' ? { t_date: season.startDate } : { start_date: season.startDate }),
    })),
  });

  // Oldest season first, so simulated history is chronological.
  const chronological = [...spec.seasons].reverse();
  chronological.forEach((season, seasonIndex) => {
    const oid = (opid: string): string => `o${seasonIndex}_${opid}`;
    const teams = season.divisions.flatMap((division) => division.teams);
    const teamById = new Map(teams.map((team) => [team.tpid, team]));
    const stats = new Map<string, StatAccumulator>();
    const results: Record<string, { lsid: string; games: { schid: string; win_tpid: string }[] }> = {};
    const ordersByTeam = new Map<string, unknown[]>();
    const fixtures: { lsid: string; title: string; tpid1: string; tpid2: string | null; date: string }[] = [];

    // Each team keeps one preferred line-up per season; matches deviate from it at random.
    const preference = new Map<string, string[]>();
    for (const team of teams) {
      const active = team.members.filter((member) => !team.benched?.includes(member));
      const ranked = [...active].sort((a, b) => spec.people[b].ppr - spec.people[a].ppr || (a < b ? -1 : 1));
      // Swap two neighbours so a preference is not purely "strongest first".
      if (ranked.length > 3 && rng() < 0.5) [ranked[1], ranked[2]] = [ranked[2], ranked[1]];
      preference.set(team.tpid, ranked);
    }

    // Fixtures.
    const rounds =
      season.rounds ??
      (() => {
        const generated: { date: string; title?: string; pairs: [string, string | null][] }[] = [];
        const perDivision = season.divisions.map((division) => roundRobin(division.teams.map((team) => team.tpid)));
        const count = Math.max(...perDivision.map((list) => list.length));
        for (let r = 0; r < count; r += 1) {
          generated.push({
            date: addDays(season.startDate, r * (season.intervalDays ?? 7)),
            pairs: perDivision.flatMap((list) => list[r] ?? []),
          });
        }
        return generated;
      })();

    const slotsFor = (tpid: string): RawSlot[] => {
      const divisionIndex = season.divisions.findIndex((division) => division.teams.some((team) => team.tpid === tpid));
      const override = season.gameSettings?.find((setting) => setting.round === divisionIndex);
      return override?.schedule ?? season.schedule;
    };

    const pickOrder = (team: FixtureTeamSpec, slots: readonly RawSlot[]): string[][] => {
      const active = preference.get(team.tpid)!;
      const total = slots.reduce((acc, slot) => acc + slot.num_part, 0);
      const cap = Math.ceil(total / active.length) + 1;
      const counts = new Map<string, number>();
      let singles = 0;
      return slots.map((slot) => {
        const chosen: string[] = [];
        for (let k = 0; k < slot.num_part; k += 1) {
          const free = active.filter((p) => !chosen.includes(p) && (counts.get(p) ?? 0) < cap);
          const pool = free.length > 0 ? free : active.filter((p) => !chosen.includes(p));
          let pick: string;
          if (slot.num_part === 1) {
            const preferred = active[singles % active.length];
            pick = pool.includes(preferred) && rng() < 0.7 ? preferred : pool[Math.floor(rng() * pool.length)];
          } else if (slot.num_part >= pool.length) {
            pick = pool[k % pool.length];
          } else {
            pick = rng() < 0.6 ? pool[0] : pool[Math.floor(rng() * pool.length)];
          }
          chosen.push(pick);
          counts.set(pick, (counts.get(pick) ?? 0) + 1);
        }
        if (slot.num_part === 1) singles += 1;
        return chosen;
      });
    };

    const record = (team: FixtureTeamSpec, opid: string): StatAccumulator => {
      const key = oid(opid);
      let entry = stats.get(key);
      if (!entry) {
        entry = {
          opid,
          oid: key,
          tpid: team.tpid,
          name: spec.people[opid].name,
          score: 0,
          darts: 0,
          legs: 0,
          legsWon: 0,
          first9Score: 0,
          first9Darts: 0,
          matches: 0,
        };
        stats.set(key, entry);
      }
      return entry;
    };

    const playLeg = (team: FixtureTeamSpec, players: string[], start: number, won: boolean): void => {
      const sidePpr = players.reduce((acc, p) => acc + spec.people[p].ppr, 0);
      const visits = Math.max(3, Math.ceil(start / Math.max(20, sidePpr)));
      let remaining = start;
      players.forEach((opid, index) => {
        const entry = record(team, opid);
        const form = 0.85 + rng() * 0.3;
        const ppr = spec.people[opid].ppr * form;
        const share = won && index === players.length - 1 ? remaining : Math.min(remaining, Math.round(ppr * visits));
        const scored = won ? share : Math.min(share, Math.max(0, remaining - 2));
        remaining -= scored;
        entry.score += scored;
        entry.darts += visits * 3;
        entry.legs += 1;
        if (won) entry.legsWon += 1;
        entry.first9Score += Math.round(Math.min(3, visits) * ppr * 1.06);
        entry.first9Darts += Math.min(3, visits) * 3;
      });
    };

    rounds.forEach((round, roundIndex) => {
      round.pairs.forEach(([home, away], pairIndex) => {
        const lsid = `${season.tournamentId}_r${roundIndex + 1}_${pairIndex + 1}`;
        const title = round.title ?? `第${roundIndex + 1}節`;
        fixtures.push({ lsid, title, tpid1: home, tpid2: away, date: round.date });
        const played = season.status === 40 || (season.status === 30 && round.date < spec.today);
        if (!played || away === null) return;
        const homeTeam = teamById.get(home)!;
        const awayTeam = teamById.get(away)!;
        const slots = slotsFor(home);
        const homeOrder = pickOrder(homeTeam, slots);
        const awayOrder = pickOrder(awayTeam, slots);
        const gameResults: { schid: string; win_tpid: string }[] = [];
        slots.forEach((slot, gameIndex) => {
          const start = slot.start_score ?? (slot.match_type === 'cricket' ? 200 : 501);
          const need = slot.limit_leg_count ?? 1;
          const strength = (opids: string[]): number =>
            opids.reduce((acc, p) => acc + spec.people[p].ppr, 0) / opids.length;
          const diff = strength(homeOrder[gameIndex]) - strength(awayOrder[gameIndex]);
          const k = slot.match_type === 'cricket' ? 0.05 : 0.09;
          const pLeg = 1 / (1 + Math.exp(-k * diff));
          const fielded: [FixtureTeamSpec, string][] = [
            ...homeOrder[gameIndex].map((opid) => [homeTeam, opid] as [FixtureTeamSpec, string]),
            ...awayOrder[gameIndex].map((opid) => [awayTeam, opid] as [FixtureTeamSpec, string]),
          ];
          const before = fielded.map(([team, opid]) => {
            const entry = record(team, opid);
            return { opid, score: entry.score, darts: entry.darts, legs: entry.legs, legsWon: entry.legsWon };
          });
          let homeLegs = 0;
          let awayLegs = 0;
          while (homeLegs < need && awayLegs < need) {
            const homeWins = rng() < pLeg;
            if (homeWins) homeLegs += 1;
            else awayLegs += 1;
            playLeg(homeTeam, homeOrder[gameIndex], start, homeWins);
            playLeg(awayTeam, awayOrder[gameIndex], start, !homeWins);
          }
          for (const opid of homeOrder[gameIndex]) record(homeTeam, opid).matches += 1;
          for (const opid of awayOrder[gameIndex]) record(awayTeam, opid).matches += 1;
          const homeWon = homeLegs > awayLegs;
          gameResults.push({ schid: slot.schid, win_tpid: homeWon ? home : away });
          const lines = fielded.map(([team, opid], index) => {
            const entry = record(team, opid);
            return {
              opid,
              score: entry.score - before[index].score,
              darts: entry.darts - before[index].darts,
              legs: entry.legs - before[index].legs,
              legsWon: entry.legsWon - before[index].legsWon,
            };
          });
          games.push({
            tournamentId: season.tournamentId,
            seasonOrdinal: seasonIndex,
            matchId: lsid,
            date: round.date,
            schid: slot.schid,
            gameIndex,
            numPart: slot.num_part,
            matchType: slot.match_type,
            homeTpid: home,
            awayTpid: away,
            homeOpids: [...homeOrder[gameIndex]],
            awayOpids: [...awayOrder[gameIndex]],
            homeWon,
            legsToWin: need,
            lines,
          });
        });
        results[lsid] = { lsid, games: gameResults };
        for (const [team, order] of [
          [homeTeam, homeOrder],
          [awayTeam, awayOrder],
        ] as const) {
          const list = ordersByTeam.get(team.tpid) ?? [];
          order.forEach((members, gameIndex) => {
            list.push({
              lsid,
              schid: slots[gameIndex].schid,
              position: gameIndex + 1,
              players: members.map((opid) => ({ oid: oid(opid), opid: opidOf(opid), oname: spec.people[opid].name })),
            });
          });
          ordersByTeam.set(team.tpid, list);
        }
      });
    });

    if (seasonIndex === chronological.length - 1) {
      for (const opid of spec.zeroDarts ?? []) {
        const team = teams.find((candidate) => candidate.members.includes(opid));
        if (team && !stats.has(oid(opid))) {
          stats.set(oid(opid), { ...record(team, opid), score: 0, darts: 0, legs: 0 });
        }
      }
    }

    const real = spec.shape === 'n01';
    const divisionOf = (tpid: string): number => season.divisions.findIndex((division) => division.teams.some((team) => team.tpid === tpid));
    const homeOf = new Map(fixtures.map((fixture) => [fixture.lsid, fixture.tpid1]));
    const tournamentBody = real
      ? {
          tdid: season.tournamentId,
          title: season.title,
          lgid: spec.leagueId,
          status: season.status,
          ...(spec.softdarts === null ? {} : { softdarts: spec.softdarts }),
          entry_list: teams.map((team) => ({ tpid: team.tpid, name: team.name })),
          // An odd division carries an "empty" slot, as n01 shows a bye.
          lg_table: season.divisions.map((division) => [
            ...division.teams.map((team) => team.tpid),
            ...(division.teams.length % 2 === 1 ? ['empty'] : []),
          ]),
          lg_title: season.divisions.map((division) => division.title),
          lg_setting: {
            schedule: season.schedule.map(realSlot),
            game_setting: (season.gameSettings ?? []).map((setting) => ({ ...setting, schedule: setting.schedule.map(realSlot) })),
          },
          lg_result: Object.fromEntries(
            Object.entries(results).map(([lsid, result]) => [`${divisionOf(homeOf.get(lsid)!)}_${lsid}`, { games: result.games }]),
          ),
        }
      : {
          tdid: season.tournamentId,
          title: season.title,
          lgid: spec.leagueId,
          status: season.status,
          ...(spec.softdarts === null ? {} : { softdarts: spec.softdarts }),
          entry_list: teams.map((team) => ({ tpid: team.tpid, name: team.name })),
          lg_table: season.divisions.map((division) => ({
            lg_title: division.title,
            list: division.teams.map((team) => ({ tpid: team.tpid })),
          })),
          lg_setting: { schedule: season.schedule, game_setting: season.gameSettings ?? [] },
          lg_result: results,
        };
    dataset.set(
      requestKey('tournament/get', { tdid: season.tournamentId }),
      real ? { result: 0, tournament: tournamentBody } : tournamentBody,
    );

    dataset.set(requestKey('tournament/stats', { tdid: season.tournamentId, kind: 'player_stats_list' }), {
      ...(real ? { result: 0 } : {}),
      player_stats_list: [...stats.values()].map((entry) =>
        real
          ? {
              ...(opidOf(entry.opid) ? { opid: entry.opid } : { oid: entry.oid }),
              tpid: entry.tpid,
              oname: entry.name,
              score: entry.score,
              darts: entry.darts,
              leg: entry.legs,
              winLeg: entry.legsWon,
              match: entry.matches,
              f9Score: entry.first9Score,
              f9Darts: entry.first9Darts,
            }
          : {
              ...(opidOf(entry.opid) ? { opid: entry.opid } : {}),
              oid: entry.oid,
              tpid: entry.tpid,
              oname: entry.name,
              score: entry.score,
              darts: entry.darts,
              legs: entry.legs,
              win_legs: entry.legsWon,
              first9_score: entry.first9Score,
              first9_darts: entry.first9Darts,
              matches: entry.matches,
            },
      ),
    });

    for (const team of teams) {
      dataset.set(requestKey('team/player/list', { tdid: season.tournamentId, tpid: team.tpid }), {
        list: team.members.map((opid) => ({
          ...(opidOf(opid) ? { opid } : {}),
          oid: oid(opid),
          tpid: team.tpid,
          oname: spec.people[opid].name,
        })),
      });
      const orders = (ordersByTeam.get(team.tpid) ?? []) as { lsid: string; schid: string; position: number; players: unknown[] }[];
      dataset.set(requestKey('team/order/list', { tdid: season.tournamentId, tpid: team.tpid }), {
        list: real
          ? orders.map((row) => ({ tmid: row.lsid, position: row.position, order: row.players }))
          : orders,
      });
    }

    dataset.set(
      requestKey('league/schedule/get', { tdid: season.tournamentId }),
      real
        ? {
            result: 0,
            schedule: season.divisions.map((_, index) =>
              fixtures
                .filter((fixture) => divisionOf(fixture.tpid1) === index)
                .map((fixture) => ({ p: [fixture.tpid1, fixture.tpid2 ?? ''], lsid: fixture.lsid, t: fixture.date })),
            ),
          }
        : {
            list: fixtures.map((fixture) => ({
              lsid: fixture.lsid,
              title: `${fixture.title} ${Number(fixture.date.slice(5, 7))}/${Number(fixture.date.slice(8, 10))}`,
              tpid1: fixture.tpid1,
              tpid2: fixture.tpid2 ?? '',
              date: fixture.date,
            })),
          },
    );
  });

  return { dataset, games };
}
