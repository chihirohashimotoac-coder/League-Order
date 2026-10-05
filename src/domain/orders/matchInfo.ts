import type { MatchInfo } from '../types';

/**
 * Keeps the share header's team name and league in step with the active team.
 *
 * The rule: a field that the captain has not typed into follows the team (so renaming a
 * team or switching teams updates the header), but a field they *have* customised is
 * never overwritten. `previousAuto` is what was last filled in automatically, which is
 * how "untouched" is recognised.
 *
 * Pure, because getting this wrong is silent — the shared image simply carries the old
 * name — so it is worth testing directly rather than only through the UI.
 */
export interface AutoMatchValues {
  teamName: string;
  leagueName: string;
}

export function syncMatchWithTeam(
  current: MatchInfo,
  previousAuto: AutoMatchValues,
  team: { name?: string; leagueName?: string } | null,
): MatchInfo {
  const teamName = team?.name ?? '';
  const leagueName = team?.leagueName ?? '';

  const adopt = (value: string, auto: string, next: string): string =>
    value === '' || value === auto ? next : value;

  return {
    ...current,
    teamName: adopt(current.teamName, previousAuto.teamName, teamName),
    leagueName: adopt(current.leagueName, previousAuto.leagueName, leagueName),
  };
}

export function autoValuesOf(team: { name?: string; leagueName?: string } | null): AutoMatchValues {
  return { teamName: team?.name ?? '', leagueName: team?.leagueName ?? '' };
}
