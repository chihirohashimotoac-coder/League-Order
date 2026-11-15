/**
 * A fixture n01 holding one real TDA season (test-only), for the singles view's automatic leg
 * read: 東京ダーツ協会（TDA） 2026年度 中期リーグ戦 (`t_Drq9_9632`), team ドリズ カム トゥルー
 * (`ml3z`), one of its players (pseudonymised: `P028`, テスト選手029). The data is `realData.tda.json`, read from the
 * n01 read API on 2026-11-15 (see its `_note`): only ml3z's rows, games and roster are kept, and
 * the leg details of that player's 25 games (9 singles, 7 doubles, 9 team games). Every player
 * name and id in it is a consistent test value (see its `_note`).
 *
 * Expected, from those responses (hand-checked in `realData.tda.test.ts`): singles 01 — 9 games,
 * 23 legs, 3DA 66.89 (487 darts), First 9 68.26 (4,710 / 207 darts), Keep 90.9% (10/11), Break
 * 33.3% (4/12). Live n01 is never contacted.
 */

export interface TdaSnapshot {
  league: { lgid: string; title: string };
  leagueEntry: Record<string, unknown>;
  tournament: Record<string, unknown>;
  roster: Record<string, unknown>[];
  /** Every team's members (the evidence that an opid is one person, so seasons can be linked). */
  fullRoster: Record<string, unknown>[];
  playerStats: Record<string, Record<string, unknown>>;
  teamStats: Record<string, Record<string, unknown>>;
  games: Record<string, unknown>[];
  details: Record<string, unknown>;
  highIn: unknown;
}

export const TDA_TDID = 't_Drq9_9632';
export const TDA_LEAGUE = 'lg_Ev9v_7379';
export const TDA_TEAM = 'ml3z';
export const TDA_PLAYER = 'P028';
/** The pseudonymised display name of {@link TDA_PLAYER}. */
export const TDA_PLAYER_NAME = 'テスト選手029';

/** The answer the fixture n01 gives, or `undefined` (unknown request: answered as not found). */
export function tdaResponse(snap: TdaSnapshot, operation: string, params: URLSearchParams | Record<string, string>): unknown {
  const get = (name: string): string | null => (params instanceof URLSearchParams ? params.get(name) : (params[name] ?? null));
  const tdid = get('tdid');
  if (operation === 'league/list') return { result: 0, list: [snap.league] };
  if (operation === 'league/tournament/list' && get('lgid') === TDA_LEAGUE) return { result: 0, list: [snap.leagueEntry] };
  if (operation === 'match/get') return snap.details[get('mid') ?? ''] ?? { result: -1, error: 'not found' };
  if (tdid !== TDA_TDID) return undefined;
  switch (operation) {
    case 'tournament/get':
      return { result: 0, tournament: snap.tournament };
    case 'team/player/list': {
      const tpid = get('tpid');
      if (!tpid) return { result: 0, list: snap.fullRoster };
      return { result: 0, list: tpid === TDA_TEAM ? snap.roster : snap.fullRoster.filter((r) => r.tpid === tpid) };
    }
    case 'tournament/standings':
      return { result: 0, tdid, groups: [] };
    case 'tournament/stats': {
      const kind = get('kind') ?? 'stats_list';
      if (kind === 'stats_list') return { result: 0, kind, stats: snap.teamStats };
      if (kind === 'player_stats_list') return { result: 0, kind, stats: snap.playerStats };
      if (kind === 'player_high_in') return snap.highIn;
      return undefined;
    }
    case 'match/list': {
      if (get('tmid__regex') !== '_lg_') return { result: 0, list: [] };
      const skip = Number(get('skip') ?? 0);
      const count = Number(get('count') ?? 100);
      return { result: 0, list: snap.games.slice(skip, skip + count) };
    }
    default:
      return undefined;
  }
}

/**
 * `n` seasons made from the one real season (test-only, **simulated**): the same games, legs and
 * totals under season ids `t_TDAcopy_<k>` (k = 0 newest … n−1) and game ids suffixed `~<k>`, so a
 * multi-season period needs more than one budget of leg details for the same player (25 games a
 * season). Every season keeps n01's own totals for its copy, so each one verifies on its own.
 */
export function tdaCopies(snap: TdaSnapshot, n: number): { seasons: TdaSnapshot[]; ids: string[]; leagueList: Record<string, unknown>[] } {
  const seasons: TdaSnapshot[] = [];
  const ids: string[] = [];
  const mids = snap.games.map((g) => String(g.mid));
  for (let k = 0; k < n; k += 1) {
    const id = `t_TDAcopy_${k}`;
    let text = JSON.stringify({ ...snap, leagueEntry: { ...snap.leagueEntry, title: `${String(snap.leagueEntry.title)}（複製${k}）`, createTime: Number(snap.leagueEntry.createTime) - k * 10_000_000, t_date: Number(snap.leagueEntry.t_date) - k * 10_000_000, status: k === 0 ? 30 : 40 } });
    text = text.split(TDA_TDID).join(id);
    for (const mid of mids) text = text.split(`"${mid}"`).join(`"${mid}~${k}"`);
    const copy = JSON.parse(text) as TdaSnapshot;
    copy.details = Object.fromEntries(Object.entries(copy.details).map(([mid, d]) => [mid.includes('~') ? mid : `${mid}~${k}`, d]));
    seasons.push(copy);
    ids.push(id);
  }
  return { seasons, ids, leagueList: seasons.map((s) => s.leagueEntry) };
}

/** {@link tdaResponse} over several seasons (see {@link tdaCopies}). */
export function tdaMultiResponse(copies: ReturnType<typeof tdaCopies>, operation: string, params: URLSearchParams | Record<string, string>): unknown {
  const get = (name: string): string | null => (params instanceof URLSearchParams ? params.get(name) : (params[name] ?? null));
  if (operation === 'league/list') return { result: 0, list: [copies.seasons[0].league] };
  if (operation === 'league/tournament/list' && get('lgid') === TDA_LEAGUE) return { result: 0, list: copies.leagueList };
  if (operation === 'match/get') {
    for (const s of copies.seasons) if (s.details[get('mid') ?? '']) return s.details[get('mid') ?? ''];
    return { result: -1, error: 'not found' };
  }
  const k = copies.ids.indexOf(get('tdid') ?? '');
  if (k < 0) return undefined;
  const real = new URLSearchParams(params instanceof URLSearchParams ? params : Object.entries(params));
  real.set('tdid', TDA_TDID);
  const body = tdaResponse(copies.seasons[k], operation, real);
  return body === undefined ? undefined : JSON.parse(JSON.stringify(body).split(TDA_TDID).join(copies.ids[k]));
}
