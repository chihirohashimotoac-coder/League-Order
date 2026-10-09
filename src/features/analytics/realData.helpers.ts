import type { SeasonData } from './seasonData';
import { buildTeamPopulation, rankTeams } from './teamView';

/** Thin re-exports so the real-data test reads as one pipeline. */
export { rankTeams };
export function buildTeamPopulationForTest(seasons: SeasonData[]) {
  return buildTeamPopulation(seasons, { kind: 'league' }, seasons[0].tournamentId);
}
