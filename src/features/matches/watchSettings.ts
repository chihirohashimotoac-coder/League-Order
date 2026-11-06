import type { WatchSettings } from '../../domain/types';

const LEAGUE = /^lg_[A-Za-z0-9]{2,16}_\d{1,10}$/u;
const TOURNAMENT = /^t_[A-Za-z0-9]{2,16}_\d{1,10}$/u;

/** Reads a stored watch target; anything that is not an n01 league / tournament id is dropped. */
export function parseWatch(value: unknown): WatchSettings | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const { kind, id, title } = value as Record<string, unknown>;
  if (typeof id !== 'string') return undefined;
  const checked = kind === 'tournament' ? TOURNAMENT.test(id) : LEAGUE.test(id);
  if (!checked) return undefined;
  return { kind: kind === 'tournament' ? 'tournament' : 'league', id, title: typeof title === 'string' ? title.slice(0, 200) : id };
}
