import { isAllowedN01Url } from './endpoints';

/**
 * Known leagues (docs/N01_MASTER_DESIGN.md §3.1).
 *
 * League identities only. Seasons (tournaments) and teams are resolved on every sync and
 * are deliberately never written down here: a season id baked into the build would
 * point at last season the day a new one opens.
 */
export interface KnownLeague {
  key: string;
  leagueId: string;
  title: string;
}

export const KNOWN_LEAGUES: readonly KnownLeague[] = [
  { key: 'ATDO', leagueId: 'lg_l3hI_3397', title: 'ATDO' },
  { key: 'TDO', leagueId: 'lg_3qgW_6619', title: 'TDO' },
  { key: 'TDA', leagueId: 'lg_Ev9v_7379', title: 'TDA' },
];

const LEAGUE_ID = /^lg_[A-Za-z0-9]{2,16}_\d{1,10}$/u;
const LEAGUE_ID_IN_TEXT = /lg_[A-Za-z0-9]{2,16}_\d{1,10}/u;

export function isLeagueId(value: string): boolean {
  return LEAGUE_ID.test(value);
}

export type LeagueReference = { ok: true; leagueId: string } | { ok: false; message: string };

/**
 * Reads a league the captain pasted: a bare id (`lg_xxxx_1234`) or an n01 page URL that
 * contains one. A URL must be https on an n01 host with no credentials in it; anything
 * else is refused rather than "cleaned up", so a look-alike link cannot be used.
 */
export function parseLeagueReference(input: string): LeagueReference {
  const value = input.trim();
  if (value === '') return { ok: false, message: 'リーグ ID または n01 の URL を入力してください。' };
  if (isLeagueId(value)) return { ok: true, leagueId: value };
  if (/^[a-z]+:/iu.test(value)) {
    if (!isAllowedN01Url(value)) {
      return { ok: false, message: 'n01 (https://n01darts.com) の URL だけを受け付けます。' };
    }
    const match = LEAGUE_ID_IN_TEXT.exec(decodeURIComponentSafe(value));
    if (match) return { ok: true, leagueId: match[0] };
    return { ok: false, message: 'URL にリーグ ID (lg_…) が含まれていません。' };
  }
  return { ok: false, message: 'リーグ ID は lg_xxxx_1234 の形式です。' };
}

function decodeURIComponentSafe(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

export function knownLeague(leagueId: string): KnownLeague | undefined {
  return KNOWN_LEAGUES.find((league) => league.leagueId === leagueId);
}
