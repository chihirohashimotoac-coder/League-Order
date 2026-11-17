import { parseGameRows } from './parse';
import type { GameRow } from './parse';

/**
 * n01 公式メニューの 3 つの一覧 (n01オンライン → n01トーナメント → n01リーグ) を、公開 Read API
 * の GET だけで読むための取得条件・応答の読み取り・ページの結合。React・DOM・通信には依存しない。
 *
 * 取得条件 (2026-11-17 に公開 API の実データで確認):
 * - トーナメント: `tournament/list` を更新の新しい順 (公式の初期表示「アクティブ順」に相当) で 30 件ずつ。
 *   リーグ配下のイベント (`league` 1) を除き、準備中・受付中・表作成中・開催中・終了を対象にする。
 *   `lgid` を持つ大会も公式の一覧に並ぶため、`lgid` の有無では除外しない。
 * - リーグ: `league/list` を更新の新しい順で 30 件ずつ (リーグ団体単位)。
 * - オンライン: `match/list` の進行中 (`live=1&endMatch=0`) のうち、大会 (`tdid`) と現地中継
 *   (`relayMode`) を持たない試合を、開始の新しい順に 100 件ずつ。マニュアルの `__exists` は `0|1`
 *   で、`false` を渡すと条件として効かず大会の試合が返る (2026-11-17 確認) ため `0` を使う。
 *   応答の各行も、大会・リーグ・カード・中継の識別子が無いことを確かめてから掲載する。
 *
 * どの一覧も n01 の応答順を保つ。ページを重ねたときに同じ ID が再び来た行は、最初の位置に残す。
 */

export type BrowseCategory = 'online' | 'tournament' | 'league';

/** 公式メニューと同じ順。 */
export const BROWSE_CATEGORIES: readonly { id: BrowseCategory; label: string; noun: string }[] = [
  { id: 'online', label: 'n01オンライン', noun: '試合' },
  { id: 'tournament', label: 'n01トーナメント', noun: '大会' },
  { id: 'league', label: 'n01リーグ', noun: 'リーグ' },
];

export const isBrowseCategory = (value: unknown): value is BrowseCategory => value === 'online' || value === 'tournament' || value === 'league';

export const browseLabel = (category: BrowseCategory): string => BROWSE_CATEGORIES.find((entry) => entry.id === category)!.label;

/** 公式オンラインの初期表示 (ロビー)。アプリ内の一覧とは取得対象が異なるため、外部リンクで開く。 */
export const N01_ONLINE_LOBBY_URL = 'https://n01darts.com/n01/online/';

export const TOURNAMENT_PAGE = 30;
export const LEAGUE_PAGE = 30;
export const ONLINE_PAGE = 100;

/** `tournament/list` の取得条件 (検索語・ページは呼び出し側で足す)。 */
export const TOURNAMENT_LIST_PARAMS: Readonly<Record<string, string>> = {
  sort: 'updateTime',
  order: 'desc',
  count: String(TOURNAMENT_PAGE),
  league__ne: '1',
  status__in: '10,20,25,30,40',
  fields: 'tdid,title,status,lgid,t_date,updateTime',
};

/** `league/list` の取得条件。 */
export const LEAGUE_LIST_PARAMS: Readonly<Record<string, string>> = {
  sort: 'updateTime',
  order: 'desc',
  count: String(LEAGUE_PAGE),
  fields: 'lgid,title,updateTime',
};

/** `match/list` の取得条件 (単独の進行中の試合)。 */
export const ONLINE_LIST_PARAMS: Readonly<Record<string, string>> = {
  live: '1',
  endMatch: '0',
  tdid__exists: '0',
  relayMode__exists: '0',
  sort: 'startTime',
  order: 'desc',
  count: String(ONLINE_PAGE),
};

/** n01 のトーナメントの状態 (マニュアル §4.3)。 */
export const TOURNAMENT_STATUS_LABEL: Readonly<Record<number, string>> = { 10: '準備中', 20: '受付中', 25: '表作成中', 30: '開催中', 40: '終了' };

type Rec = Record<string, unknown>;
const isRec = (value: unknown): value is Rec => typeof value === 'object' && value !== null && !Array.isArray(value);
const str = (value: unknown): string | null => (typeof value === 'string' && value.trim() !== '' ? value : null);
const num = (value: unknown): number | null => (typeof value === 'number' && Number.isFinite(value) ? value : null);

export class BrowseSchemaError extends Error {
  constructor(operation: string, message: string) {
    super(`${operation}: ${message}`);
    this.name = 'BrowseSchemaError';
  }
}

function listOf(operation: string, raw: unknown): unknown[] {
  if (!isRec(raw)) throw new BrowseSchemaError(operation, '応答が JSON オブジェクトではありません。');
  if (typeof raw.result === 'number' && raw.result < 0) throw new BrowseSchemaError(operation, `n01 がエラーを返しました (${String(raw.error ?? raw.result)})。`);
  if (!Array.isArray(raw.list)) throw new BrowseSchemaError(operation, '一覧 (list) がありません。');
  return raw.list;
}

/** 1 ページ分: 読めた行、n01 が返した行数 (次ページの有無の判断に使う)、読めなかった行数。 */
export interface BrowsePage<T> {
  items: T[];
  rows: number;
  unreadable: number;
}

export interface TournamentItem {
  tdid: string;
  title: string;
  status: number | null;
  leagueId: string | null;
  /** 開催日時 (UNIX 秒)。未登録 (0・欠損) は `null`。 */
  date: number | null;
  /** 最終更新 (UNIX ミリ秒)。 */
  updateTime: number | null;
}

export function parseTournamentPage(raw: unknown): BrowsePage<TournamentItem> {
  const list = listOf('tournament/list', raw);
  const items: TournamentItem[] = [];
  let unreadable = 0;
  for (const row of list) {
    const tdid = isRec(row) ? str(row.tdid) : null;
    if (!isRec(row) || !tdid) {
      unreadable += 1;
      continue;
    }
    const date = num(row.t_date);
    items.push({ tdid, title: str(row.title) ?? '', status: num(row.status), leagueId: str(row.lgid), date: date !== null && date > 0 ? date : null, updateTime: num(row.updateTime) });
  }
  return { items, rows: list.length, unreadable };
}

export interface LeagueItem {
  lgid: string;
  title: string;
  updateTime: number | null;
}

export function parseLeaguePage(raw: unknown): BrowsePage<LeagueItem> {
  const list = listOf('league/list', raw);
  const items: LeagueItem[] = [];
  let unreadable = 0;
  for (const row of list) {
    const lgid = isRec(row) ? str(row.lgid) : null;
    if (!isRec(row) || !lgid) {
      unreadable += 1;
      continue;
    }
    items.push({ lgid, title: str(row.title) ?? '', updateTime: num(row.updateTime) });
  }
  return { items, rows: list.length, unreadable };
}

/**
 * 大会・リーグ (リーグのイベントも `tdid` を持つ)・対戦カード・カード内のゲームに属すると読める識別子。
 * `lgid` は `match/list` の `fields` に指定できず (-51、2026-11-18 確認)、リーグの試合はリーグ配下のイベントの
 * `tdid` を持つので `tdid` で除かれる。`lgid` の検査は、応答に含まれた場合の備え。
 * `scid` (セットをまとめる ID) は含めない: 2026-11-17 の実データで、`tdid`・`relayMode` の無い個人どうしの
 * セット戦 (n01 Online) が `scid` だけを持っていた。観戦詳細は `scid` で次のセットへ切り替わる。
 */
const AFFILIATION_FIELDS = ['tdid', 'lgid', 'tmid', 'schid'] as const;

/**
 * 単独の試合 (どの大会・リーグ・中継にも属さない) と確かめられた行だけを残す。`relayMode` は値に
 * かかわらず、フィールドがあれば中継として除く (`relayMode__exists=0` と同じ扱い。中継は `scid` も持つ)。
 */
export function isStandaloneRow(row: unknown): boolean {
  if (!isRec(row)) return false;
  if ('relayMode' in row) return false;
  return AFFILIATION_FIELDS.every((field) => {
    const value = row[field];
    return value === undefined || value === null || value === '';
  });
}

export interface OnlinePage extends BrowsePage<GameRow> {
  /** n01 が返したが、単独の試合と確かめられず掲載しなかった行。 */
  excluded: number;
}

export function parseOnlinePage(raw: unknown): OnlinePage {
  const list = listOf('match/list', raw);
  const standalone = list.filter(isStandaloneRow);
  const parsed = parseGameRows({ result: 0, list: standalone });
  return { items: parsed.games, rows: list.length, unreadable: parsed.unreadable, excluded: list.length - standalone.length };
}

/**
 * 読み込み済みの一覧に次のページを足す。n01 の並びを保ち、既にある ID の行は最初の位置のまま
 * (ページの間に順位が動いた行が二重に並ばないように)。名前が同じでも ID が違えば別の行。
 */
export function appendPage<T>(held: readonly T[], next: readonly T[], id: (item: T) => string): { items: T[]; duplicates: number } {
  const seen = new Set(held.map(id));
  const items = [...held];
  let duplicates = 0;
  for (const item of next) {
    const key = id(item);
    if (seen.has(key)) {
      duplicates += 1;
      continue;
    }
    seen.add(key);
    items.push(item);
  }
  return { items, duplicates };
}

/** n01 が 1 ページを満たして返したとき、続きがある可能性がある。 */
export const mayHaveMore = (rows: number, pageSize: number): boolean => rows >= pageSize;
