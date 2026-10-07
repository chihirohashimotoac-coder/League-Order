/**
 * Freshness of cached n01 data (docs/N01_MASTER_DESIGN.md §5).
 *
 * The age of a snapshot is always shown as an age; "latest" is reserved for data that
 * the sync in progress has just fetched successfully, which this module cannot know —
 * the caller decides that. Thresholds are constants so they can be tuned later.
 */

export const STALE_WARN_MS = 24 * 60 * 60 * 1000;
export const STALE_DANGER_MS = 48 * 60 * 60 * 1000;

export type FreshnessLevel = 'recent' | 'warn' | 'danger';

export interface Freshness {
  ageMs: number;
  level: FreshnessLevel;
  /** "3分前", "12時間前", "2日前". */
  label: string;
}

export function formatAge(ageMs: number): string {
  const minutes = Math.floor(Math.max(0, ageMs) / 60_000);
  if (minutes < 1) return 'たった今';
  if (minutes < 60) return `${minutes}分前`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}時間前`;
  return `${Math.floor(hours / 24)}日前`;
}

export function freshness(fetchedAt: number, now: number): Freshness {
  const ageMs = Math.max(0, now - fetchedAt);
  const level: FreshnessLevel = ageMs >= STALE_DANGER_MS ? 'danger' : ageMs >= STALE_WARN_MS ? 'warn' : 'recent';
  return { ageMs, level, label: formatAge(ageMs) };
}

/** "10/6 20:15" in the device's local time. */
export function formatSyncTime(epochMs: number): string {
  const date = new Date(epochMs);
  const pad = (value: number): string => String(value).padStart(2, '0');
  return `${date.getMonth() + 1}/${date.getDate()} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}
