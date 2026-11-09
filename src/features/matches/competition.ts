import { isTeamEvent } from './parse';
import type { GameRow } from './parse';

/**
 * Any n01 competition, not only league seasons: tournaments (elimination brackets), round
 * robins, single-match events — and games outside any competition (n01 Online / n01 Live).
 *
 * A match row's `tmid` says where it belongs: `<tdid>_<ttype>_<round>_<tpid>_<tpid>`, league
 * events with a division and card id in between (`<tdid>_lg_<div>_<lsid>_<a>_<b>`).
 */

type Rec = Record<string, unknown>;
const isRec = (value: unknown): value is Rec => typeof value === 'object' && value !== null && !Array.isArray(value);
const str = (value: unknown): string | null => (typeof value === 'string' && value !== '' ? value : null);
const num = (value: unknown): number | null => (typeof value === 'number' && Number.isFinite(value) ? value : null);

export const TTYPE_LABELS: Record<string, string> = {
  lg: 'リーグ',
  rr: 'ラウンドロビン',
  t: 'トーナメント',
  t3: '3位決定戦',
  s2: 'トーナメント2',
  s2_3: 'トーナメント2 3位決定戦',
  dw: 'ダブルイリミ (勝者側)',
  dl: 'ダブルイリミ (敗者側)',
  m: 'マッチ',
};

export interface MatchPlace {
  ttype: string;
  /** League: division; round robin: group; brackets: round (0-based). */
  stage: number;
  /** League card id, when any. */
  lsid: string | null;
  teamIds: [string, string];
}

/** Where a `tmid` sits, or `null` for anything unreadable. Longer ttypes are tried first. */
export function parseTmid(tmid: string | null, tdid: string | null): MatchPlace | null {
  if (!tmid || !tdid || !tmid.startsWith(`${tdid}_`)) return null;
  const rest = tmid.slice(tdid.length + 1);
  for (const ttype of ['s2_3', 'lg', 'rr', 't3', 's2', 'dw', 'dl', 't', 'm']) {
    if (!rest.startsWith(`${ttype}_`)) continue;
    const parts = rest.slice(ttype.length + 1).split('_');
    if (ttype === 'lg' && parts.length === 4) return { ttype, stage: Number(parts[0]), lsid: parts[1], teamIds: [parts[2], parts[3]] };
    if (parts.length === 3 && Number.isInteger(Number(parts[0]))) return { ttype, stage: Number(parts[0]), lsid: null, teamIds: [parts[1], parts[2]] };
  }
  return null;
}

/** "ラウンドロビン グループ2", "トーナメント 1回戦", "リーグ A Division". */
export function stageLabel(place: MatchPlace, names: { rrGroups?: string[]; divisions?: string[]; rounds?: Record<string, string[]> } = {}): string {
  const base = TTYPE_LABELS[place.ttype] ?? place.ttype;
  if (place.ttype === 'lg') return `${base} ${names.divisions?.[place.stage] ?? `Division ${place.stage + 1}`}`;
  if (place.ttype === 'rr') return `${base} ${names.rrGroups?.[place.stage] ?? `グループ ${place.stage + 1}`}`;
  const custom = names.rounds?.[place.ttype]?.[place.stage];
  if (custom) return `${base} ${custom}`;
  if (place.ttype === 'm' || place.ttype === 't3' || place.ttype === 's2_3') return base;
  return `${base} ${place.stage + 1}回戦`;
}

export interface CompetitionDoc {
  tdid: string;
  title: string;
  status: number | null;
  leagueId: string | null;
  url: string | null;
  teamGames: boolean;
  entries: Map<string, string>;
  divisions: string[];
  rrGroups: string[];
  rounds: Record<string, string[]>;
}

export function parseCompetition(raw: unknown, tdid: string): CompetitionDoc {
  if (!isRec(raw) || !isRec(raw.tournament)) throw new Error('tournament/get: トーナメントがありません。');
  const t = raw.tournament;
  const entries = new Map<string, string>();
  if (Array.isArray(t.entry_list)) for (const entry of t.entry_list) if (isRec(entry) && str(entry.tpid)) entries.set(str(entry.tpid)!, str(entry.name) ?? str(entry.tpid)!);
  const titles = (value: unknown): string[] => (Array.isArray(value) ? value.map((entry) => (typeof entry === 'string' ? entry : '')) : []);
  const rounds: Record<string, string[]> = {};
  for (const ttype of ['t', 's2', 'dw', 'dl']) {
    const list = titles(t[`${ttype}_title`]);
    if (list.some(Boolean)) rounds[ttype] = list;
  }
  return {
    tdid: str(t.tdid) ?? tdid,
    title: str(t.title) ?? tdid,
    status: num(t.status),
    leagueId: str(t.lgid),
    url: typeof raw.url === 'string' && raw.url.startsWith('https://n01darts.com/') ? raw.url : null,
    teamGames: isTeamEvent(t),
    entries,
    divisions: titles(t.lg_title),
    rrGroups: titles(t.rr_title),
    rounds,
  };
}

export interface CompetitionSummary {
  tdid: string;
  title: string;
  status: number | null;
  leagueId: string | null;
}

export function parseCompetitionList(raw: unknown): CompetitionSummary[] {
  if (!isRec(raw) || !Array.isArray(raw.list)) throw new Error('tournament/list: 一覧がありません。');
  return raw.list
    .filter(isRec)
    .map((row) => ({ tdid: str(row.tdid) ?? '', title: str(row.title) ?? '', status: num(row.status), leagueId: str(row.lgid) }))
    .filter((row) => row.tdid !== '');
}

export interface StandingRow {
  teamId: string;
  name: string;
  rank: number;
  played: number;
  won: number;
  drawn: number;
  lost: number;
  diff: number | null;
  points: number | null;
}

export interface StandingGroup {
  kind: string;
  index: number;
  title: string;
  rows: StandingRow[];
}

/** `tournament/standings`, every kind (league divisions and round-robin groups). */
export function parseAllStandings(raw: unknown): StandingGroup[] {
  if (!isRec(raw)) return [];
  if (typeof raw.result === 'number' && raw.result < 0) return [];
  if (!Array.isArray(raw.groups)) return [];
  return raw.groups.filter(isRec).map((group) => ({
    kind: str(group.kind) ?? '',
    index: num(group.index) ?? 0,
    title: str(group.title) ?? '',
    rows: (Array.isArray(group.players) ? group.players : []).filter(isRec).map((row) => ({
      teamId: str(row.tpid) ?? '',
      name: str(row.name) ?? '',
      rank: num(row.rank) ?? 0,
      played: num(row.p) ?? 0,
      won: num(row.w) ?? 0,
      drawn: num(row.d) ?? 0,
      lost: num(row.l) ?? 0,
      diff: num(row.diff),
      points: num(row.pts),
    })),
  }));
}

/** One match of a competition: one game, or the games of one card (team events). */
export interface CompetitionMatch {
  key: string;
  place: MatchPlace | null;
  games: GameRow[];
  /** Names from the rows themselves (the entry list is used when they are missing). */
  names: [string, string];
  finished: boolean;
  /** Games (team events) or legs / sets won, row side order of the first game. */
  score: [number, number];
  startTime: number | null;
  updateTime: number | null;
}

export function groupMatches(rows: readonly GameRow[], entries: Map<string, string>, tdid: string | null): CompetitionMatch[] {
  const byKey = new Map<string, GameRow[]>();
  for (const row of rows) {
    const key = row.tmid ?? row.mid;
    byKey.set(key, [...(byKey.get(key) ?? []), row]);
  }
  return [...byKey.entries()].map(([key, games]) => {
    const sorted = [...games].sort((a, b) => (a.startTime ?? 0) - (b.startTime ?? 0));
    const first = sorted[0];
    const left = first.sides[0].teamId;
    const place = parseTmid(first.tmid, tdid);
    const many = sorted.length > 1 || (first.schid ?? '') !== '';
    let score: [number, number] = [0, 0];
    if (many) {
      for (const game of sorted) {
        const [a, b] = [game.sides[0].legsWon ?? 0, game.sides[1].legsWon ?? 0];
        if (!game.finished || a === b) continue;
        const winner = a > b ? 0 : 1;
        const winnerLeft = game.sides[winner].teamId === left;
        score = winnerLeft ? [score[0] + 1, score[1]] : [score[0], score[1] + 1];
      }
    } else {
      const sets = [first.sides[0].setsWon ?? 0, first.sides[1].setsWon ?? 0];
      score = sets[0] + sets[1] > 0 ? (sets as [number, number]) : [first.sides[0].legsWon ?? 0, first.sides[1].legsWon ?? 0];
    }
    const name = (index: 0 | 1): string => entries.get(first.sides[index].teamId) ?? first.sides[index].name ?? '—';
    return {
      key,
      place,
      games: sorted,
      names: [name(0), name(1)],
      finished: sorted.every((game) => game.finished) && (!many || sorted.some((game) => game.cardFinished) || !sorted.some((game) => !game.finished)),
      score,
      startTime: first.startTime,
      updateTime: Math.max(0, ...sorted.map((game) => game.updateTime ?? 0)) || null,
    };
  });
}

/** Reads what a viewer pasted: a league, a tournament, or one match (id or n01 page link). */
export type CompetitionReference = { kind: 'league'; id: string } | { kind: 'tournament'; id: string } | { kind: 'match'; id: string } | null;

export function parseCompetitionReference(text: string): CompetitionReference {
  const value = (() => {
    try {
      return decodeURIComponent(text.trim());
    } catch {
      return text.trim();
    }
  })();
  const league = /lg_[A-Za-z0-9]{2,16}_\d{1,10}/u.exec(value);
  if (league) return { kind: 'league', id: league[0] };
  const tournament = /t_[A-Za-z0-9]{2,16}_\d{1,10}/u.exec(value);
  if (tournament) return { kind: 'tournament', id: tournament[0] };
  const match = /(?:^|[^A-Za-z0-9])([A-Za-z0-9]{8}_\d{13})(?:$|[^0-9])/u.exec(value);
  if (match) return { kind: 'match', id: match[1] };
  return null;
}
