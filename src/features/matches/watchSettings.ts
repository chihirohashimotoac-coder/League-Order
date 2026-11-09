import type { FollowedPlayer, WatchSettings } from '../../domain/types';

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

/** At most this many followed players are kept. */
export const MAX_FOLLOWED = 30;

/** Reads the followed players: names of 1–60 characters, one entry per name, at most 30. */
export function parseFollowed(value: unknown): FollowedPlayer[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const out: FollowedPlayer[] = [];
  for (const entry of value) {
    if (typeof entry !== 'object' || entry === null) continue;
    const { name, team } = entry as Record<string, unknown>;
    if (typeof name !== 'string') continue;
    const trimmed = name.trim();
    if (!trimmed || trimmed.length > 60 || out.some((held) => held.name === trimmed)) continue;
    out.push({ name: trimmed, team: typeof team === 'string' && team.trim() ? team.trim().slice(0, 100) : null });
    if (out.length >= MAX_FOLLOWED) break;
  }
  return out;
}
