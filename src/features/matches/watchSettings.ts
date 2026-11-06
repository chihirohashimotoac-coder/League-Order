import type { WatchSettings } from '../../domain/types';
import { isLeagueId } from '../../integrations/n01/leagueRegistry';

/** Reads a stored watched league; anything that is not an n01 league id is dropped. */
export function parseWatch(value: unknown): WatchSettings | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const { leagueId, leagueTitle } = value as Record<string, unknown>;
  if (typeof leagueId !== 'string' || !isLeagueId(leagueId)) return undefined;
  return { leagueId, leagueTitle: typeof leagueTitle === 'string' ? leagueTitle.slice(0, 200) : leagueId };
}
