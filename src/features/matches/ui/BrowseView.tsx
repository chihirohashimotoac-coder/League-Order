import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { onTabListKeyDown } from '../../../components/ui';
import { Icon } from '../../../components/icons';
import { describeN01Error } from '../../../integrations/n01/client';
import type { MatchesApi } from '../api';
import type { MatchesApiFactory } from '../environment';
import type { BrowseCategory, BrowsePage, LeagueItem, TournamentItem } from '../browse';
import { BROWSE_CATEGORIES, LEAGUE_PAGE, N01_ONLINE_LOBBY_URL, ONLINE_PAGE, TOURNAMENT_PAGE, TOURNAMENT_STATUS_LABEL, appendPage, browseLabel, mayHaveMore } from '../browse';
import type { GameRow } from '../parse';
import { formatClock, useFollowed } from './useMatchContext';

/**
 * n01 公式メニューの 3 つの一覧 (n01オンライン → n01トーナメント → n01リーグ)。冒頭に「戻る」「カテゴリ」
 * 「検索」を並べ、件数・取得時刻・並び順をその下に小さくまとめる。行全体が押せるコンパクトな一覧。
 *
 * - 選んでいるカテゴリだけを読む。検索・カテゴリ切替・次ページの古い応答は捨てる (新しい一覧を上書きしない)。
 * - 読み込んだ件数だけを示す (n01 は全体の件数を返さない)。
 * - 大会・リーグを開いて戻ったときは、カテゴリ・検索語・読み込んだ一覧・スクロール位置・フォーカスを戻す。
 */

// ---------------------------------------------------------------------------
// 戻ったときに復元する状態 (画面を離れても残す。1 カテゴリ 1 つ)
// ---------------------------------------------------------------------------

interface ListState<T> {
  status: 'loading' | 'ready' | 'error';
  items: T[];
  /** この一覧を読んだ検索語 (空 = 公式の初期表示と同じ条件)。 */
  query: string;
  fetchedAt: number | null;
  /** 次に読む位置 (n01 が返した行数の合計)。 */
  skip: number;
  more: boolean;
  loadingMore: boolean;
  /** 最後の読み込みの失敗 (一覧があるときは次ページの失敗)。 */
  error: string | null;
  /** 単独の試合と確かめられず掲載しなかった行 (オンライン)。 */
  excluded: number;
  unreadable: number;
}

interface Saved {
  state: ListState<unknown>;
  draft: string;
  scrollY: number;
  focusKey: string | null;
}

const memory = new Map<BrowseCategory, Saved>();
/** 一覧から大会・リーグ・試合を開いた: 次にこのカテゴリを表示するときは、離れたときの状態に戻す。 */
let returning: BrowseCategory | null = null;
/** 一覧を最初から表示しなおすまでの時間 (カテゴリ切替で前の一覧を使う上限)。 */
const REUSE_MS = 10 * 60_000;

/** 選手・大会・リーグの選択画面からカテゴリを開く: 公式の初期表示と同じ条件で読み直す。 */
export function startBrowse(category: BrowseCategory): void {
  memory.delete(category);
  if (returning === category) returning = null;
}

/** テスト用: 記憶をすべて消す。 */
export function resetBrowseMemory(): void {
  memory.clear();
  returning = null;
}

const initial = <T,>(query: string): ListState<T> => ({ status: 'loading', items: [], query, fetchedAt: null, skip: 0, more: false, loadingMore: false, error: null, excluded: 0, unreadable: 0 });

type PageLoader<T> = (options: { keyword?: string; skip?: number; signal: AbortSignal }) => Promise<BrowsePage<T> & { excluded?: number }>;

/**
 * 1 カテゴリの一覧の読み込み。応答は送った順の番号で照合し、後から送った読み込みがあれば捨てる
 * (検索語の変更・再読み込み・次ページ)。次ページは n01 の並びのまま後ろに足し、同じ ID は最初の位置に残す。
 */
function useBrowseList<T>(category: BrowseCategory, load: PageLoader<T>, id: (item: T) => string, pageSize: number) {
  // 最初の表示の決め方 (描画中に共有の状態を書き換えないよう、一度だけ計算して保持する)。
  const [boot] = useState(() => {
    const saved = memory.get(category);
    const ready = saved !== undefined && saved.state.status === 'ready';
    const restoring = ready && returning === category;
    const reusable = ready && saved.state.fetchedAt !== null && Date.now() - saved.state.fetchedAt < REUSE_MS;
    return { saved: restoring || reusable ? saved : undefined, restoring };
  });
  // 離れたときに続きを読み込み中だった一覧は、その読み込みを中止しているので、押せる状態で戻す。
  const [state, setState] = useState<ListState<T>>(() => (boot.saved ? { ...(boot.saved.state as ListState<T>), loadingMore: false } : initial<T>('')));
  const [draft, setDraft] = useState(() => boot.saved?.draft ?? '');
  const current = useRef(state);
  current.current = state;
  const sequence = useRef(0);
  const controller = useRef<AbortController | null>(null);
  const restore = useRef(boot.restoring && boot.saved ? { scrollY: boot.saved.scrollY, focusKey: boot.saved.focusKey } : null);
  useEffect(() => {
    if (boot.restoring && returning === category) returning = null;
  }, [boot, category]);

  const read = (query: string, append: boolean): void => {
    const ticket = ++sequence.current;
    controller.current?.abort();
    const abort = new AbortController();
    controller.current = abort;
    const from = append ? current.current.skip : 0;
    setState((held) => (append ? { ...held, loadingMore: true, error: null } : { ...initial<T>(query) }));
    load({ keyword: query, skip: from, signal: abort.signal }).then(
      (page) => {
        if (ticket !== sequence.current) return;
        setState((held) => {
          const merged = append ? appendPage(held.items, page.items, id).items : appendPage([], page.items, id).items;
          return {
            status: 'ready',
            items: merged,
            query,
            fetchedAt: append ? held.fetchedAt : Date.now(),
            skip: from + page.rows,
            more: mayHaveMore(page.rows, pageSize),
            loadingMore: false,
            error: null,
            excluded: (append ? held.excluded : 0) + (page.excluded ?? 0),
            unreadable: (append ? held.unreadable : 0) + page.unreadable,
          };
        });
      },
      (reason: unknown) => {
        if (ticket !== sequence.current) return;
        const message = describeN01Error(reason);
        setState((held) => (append ? { ...held, loadingMore: false, error: message } : { ...initial<T>(query), status: 'error', error: message }));
      },
    );
  };

  // 最初の表示: 復元・再利用できない一覧だけを読む。
  useEffect(() => {
    if (current.current.status === 'loading' && current.current.items.length === 0) read(current.current.query, false);
    return () => controller.current?.abort();
    // 最初の 1 回だけ (読み込みは利用者の操作で行う)。
  }, []);

  // 離れても戻せるように、表示中の状態を残す (読み込み途中は残さない: 戻ったら読み直す)。
  useEffect(() => {
    const held = memory.get(category);
    if (state.status === 'ready') memory.set(category, { state: state as ListState<unknown>, draft, scrollY: held?.scrollY ?? 0, focusKey: held?.focusKey ?? null });
  }, [category, state, draft]);

  /** 行を選んだ: 戻ったときにこの行・この位置へ戻す。 */
  const remember = (key: string): void => {
    const held = memory.get(category);
    if (held) memory.set(category, { ...held, draft, scrollY: window.scrollY, focusKey: key });
    returning = category;
  };

  return {
    state,
    draft,
    setDraft,
    search: (query: string) => read(query.trim(), false),
    reload: () => read(current.current.query, false),
    more: () => read(current.current.query, true),
    remember,
    restore,
  };
}

/** 復元: 一覧が描かれた直後に、離れたときのスクロール位置と行のフォーカスへ戻す。 */
function useRestore(restore: React.MutableRefObject<{ scrollY: number; focusKey: string | null } | null>, list: React.RefObject<HTMLElement | null>): void {
  useLayoutEffect(() => {
    const target = restore.current;
    if (!target) return;
    restore.current = null;
    if (typeof window.scrollTo === 'function') window.scrollTo(0, target.scrollY);
    if (target.focusKey) {
      const row = list.current?.querySelector<HTMLElement>(`[data-browse-key="${CSS.escape(target.focusKey)}"]`);
      row?.focus({ preventScroll: true });
    }
  }, [restore, list]);
}

// ---------------------------------------------------------------------------
// 共通の部品
// ---------------------------------------------------------------------------

const formatDateTime = (sec: number): string => formatClock(sec * 1000);

function Meta({ state, noun, order, onReload }: { state: ListState<unknown>; noun: string; order: string; onReload: () => void }): React.JSX.Element {
  const count = state.status === 'ready' ? `読み込み済み ${state.items.length} ${noun === '試合' ? '試合' : '件'}${state.more ? ' ・ 続きあり' : ''}` : state.status === 'loading' ? '読み込み中…' : '取得できませんでした';
  return (
    <div className="browse-meta small-text" data-testid="browse-meta">
      <span className="browse-meta-text">
        <span data-testid="browse-count">{count}</span>
        {state.fetchedAt !== null ? <span> ・ 取得 {formatClock(state.fetchedAt)}</span> : null}
        <span> ・ {order}</span>
      </span>
      <button type="button" className="btn small icon ghost" onClick={onReload} aria-label="最新の一覧を取得" disabled={state.status === 'loading'}>
        <Icon name="refresh" size={16} />
      </button>
    </div>
  );
}

function Notes({ state }: { state: ListState<unknown> }): React.JSX.Element | null {
  if (state.status !== 'ready') return null;
  const parts: string[] = [];
  if (state.excluded > 0) parts.push(`大会・リーグ・中継との区別を確認できない ${state.excluded} 行は掲載していません`);
  if (state.unreadable > 0) parts.push(`読み取れない ${state.unreadable} 行を除きました`);
  if (!parts.length) return null;
  return (
    <p className="muted small-text" data-testid="browse-notes">
      {parts.join('。')}。
    </p>
  );
}

function Footer({ state, noun, pageSize, onMore, onRetry }: { state: ListState<unknown>; noun: string; pageSize: number; onMore: () => void; onRetry: () => void }): React.JSX.Element | null {
  if (state.status === 'loading') {
    return (
      <p className="muted small-text browse-status" role="status">
        <span className="spinner" aria-hidden="true" /> n01 から読み込み中…
      </p>
    );
  }
  if (state.status === 'error') {
    return (
      <div className="notice danger browse-error" role="alert" data-testid="browse-error">
        <Icon name="alert" size={18} />
        <span className="grow small-text">一覧を取得できませんでした: {state.error}</span>
        <button type="button" className="btn small" onClick={onRetry}>
          再試行
        </button>
      </div>
    );
  }
  return (
    <div className="browse-footer">
      {state.error ? (
        <div className="notice danger browse-error" role="alert" data-testid="browse-more-error">
          <Icon name="alert" size={18} />
          <span className="grow small-text">続きを取得できませんでした: {state.error}</span>
          <button type="button" className="btn small" onClick={onMore}>
            再試行
          </button>
        </div>
      ) : null}
      {state.more && !state.error ? (
        <button type="button" className="btn small browse-more" onClick={onMore} disabled={state.loadingMore} data-testid="browse-more">
          {state.loadingMore ? (
            <>
              <span className="spinner small" aria-hidden="true" /> 読み込み中…
            </>
          ) : (
            `続きの ${pageSize} ${noun === '試合' ? '試合' : '件'}を読み込む`
          )}
        </button>
      ) : null}
      {!state.more && state.items.length > 0 ? <p className="muted small-text">n01 の一覧の最後まで読み込みました。</p> : null}
    </div>
  );
}

function Empty({ state, noun, filtered }: { state: ListState<unknown>; noun: string; filtered?: string }): React.JSX.Element | null {
  if (state.status !== 'ready') return null;
  if (filtered !== undefined) {
    return (
      <p className="small-text browse-empty" data-testid="browse-empty">
        「{filtered}」に一致する{noun}は、読み込んだ範囲にありません。
      </p>
    );
  }
  if (state.items.length > 0) return null;
  return (
    <p className="small-text browse-empty" data-testid="browse-empty">
      {state.query ? `「${state.query}」に一致する${noun}は見つかりませんでした。` : `いま n01 の一覧に表示できる${noun}はありません。`}
    </p>
  );
}

function SearchForm({ value, onChange, onSubmit, label, placeholder }: { value: string; onChange: (next: string) => void; onSubmit: (value: string) => void; label: string; placeholder: string }): React.JSX.Element {
  return (
    <form
      className="browse-search"
      role="search"
      onSubmit={(event) => {
        event.preventDefault();
        onSubmit(value);
      }}
    >
      <input type="search" value={value} onChange={(event) => onChange(event.target.value)} placeholder={placeholder} aria-label={label} enterKeyHint="search" autoComplete="off" data-testid="browse-search" />
      <button type="submit" className="btn">
        検索
      </button>
      {value ? (
        <button
          type="button"
          className="btn ghost"
          onClick={() => {
            onChange('');
            onSubmit('');
          }}
        >
          クリア
        </button>
      ) : null}
    </form>
  );
}

export function N01Row({ id, current, onOpen, title, children, aside, testId }: { id: string; current: boolean; onOpen: () => void; title: React.ReactNode; children?: React.ReactNode; aside: React.ReactNode; testId: string }): React.JSX.Element {
  return (
    <li>
      <button type="button" className="n01-row" data-browse-key={id} aria-current={current ? 'true' : undefined} onClick={onOpen} data-testid={testId}>
        <span className="n01-row-main">
          <span className="n01-row-title">{title}</span>
          {children ? <span className="n01-row-sub">{children}</span> : null}
        </span>
        {aside ? <span className="n01-row-aside">{aside}</span> : <span aria-hidden="true" />}
        <Icon name="chevronRight" size={18} className="n01-row-go" />
      </button>
    </li>
  );
}

// ---------------------------------------------------------------------------
// n01トーナメント
// ---------------------------------------------------------------------------

const STATUS_CLASS: Record<number, string> = { 10: 'state-prep', 20: 'state-entry', 25: 'state-prep', 30: 'state-live', 40: 'state-official' };

function TournamentList({ api, current, onOpen }: { api: MatchesApi; current: string | null; onOpen: (item: TournamentItem) => void }): React.JSX.Element {
  const list = useBrowseList<TournamentItem>('tournament', (options) => api.browseTournaments(options), (item) => item.tdid, TOURNAMENT_PAGE);
  const ref = useRef<HTMLUListElement>(null);
  useRestore(list.restore, ref);
  const { state } = list;
  return (
    <>
      <SearchForm value={list.draft} onChange={list.setDraft} onSubmit={list.search} label="大会名で検索" placeholder="大会名で検索 (n01 のタイトル検索)" />
      <Meta state={state} noun="大会" order={state.query ? `「${state.query}」の検索結果 ・ 更新の新しい順` : 'アクティブ順 (更新の新しい順)'} onReload={list.reload} />
      <ul className="n01-list" ref={ref} data-testid="browse-list">
        {state.items.map((item) => (
          <N01Row
            key={item.tdid}
            id={item.tdid}
            current={current === item.tdid}
            testId="browse-tournament"
            onOpen={() => {
              list.remember(item.tdid);
              onOpen(item);
            }}
            title={item.title || item.tdid}
            aside={
              <>
                <span className={`tag browse-state ${STATUS_CLASS[item.status ?? 0] ?? 'state-prep'}`}>{TOURNAMENT_STATUS_LABEL[item.status ?? 0] ?? '状態 不明'}</span>
              </>
            }
          >
            <span>{item.date !== null ? `開催 ${formatDateTime(item.date)}` : '開催日時 未登録'}</span>
            {item.updateTime !== null ? <span className="muted"> ・ 更新 {formatClock(item.updateTime)}</span> : null}
          </N01Row>
        ))}
      </ul>
      <Empty state={state} noun="大会" />
      <Notes state={state} />
      <Footer state={state} noun="大会" pageSize={TOURNAMENT_PAGE} onMore={list.more} onRetry={list.reload} />
    </>
  );
}

// ---------------------------------------------------------------------------
// n01リーグ
// ---------------------------------------------------------------------------

function LeagueList({ api, current, onOpen }: { api: MatchesApi; current: string | null; onOpen: (item: LeagueItem) => void }): React.JSX.Element {
  const list = useBrowseList<LeagueItem>('league', (options) => api.browseLeagues(options), (item) => item.lgid, LEAGUE_PAGE);
  const ref = useRef<HTMLUListElement>(null);
  useRestore(list.restore, ref);
  const { state } = list;
  return (
    <>
      <SearchForm value={list.draft} onChange={list.setDraft} onSubmit={list.search} label="リーグ名で検索" placeholder="リーグ名で検索 (n01 のタイトル検索)" />
      <Meta state={state} noun="リーグ" order={state.query ? `「${state.query}」の検索結果 ・ 更新の新しい順` : '更新の新しい順 (公式の一覧と同じ)'} onReload={list.reload} />
      <ul className="n01-list" ref={ref} data-testid="browse-list">
        {state.items.map((item) => (
          <N01Row
            key={item.lgid}
            id={item.lgid}
            current={current === item.lgid}
            testId="browse-league"
            onOpen={() => {
              list.remember(item.lgid);
              onOpen(item);
            }}
            title={item.title || item.lgid}
            aside={null}
          >
            <span>{item.updateTime !== null ? `更新 ${formatClock(item.updateTime)}` : '更新 未取得'}</span>
          </N01Row>
        ))}
      </ul>
      <Empty state={state} noun="リーグ" />
      <Notes state={state} />
      <Footer state={state} noun="リーグ" pageSize={LEAGUE_PAGE} onMore={list.more} onRetry={list.reload} />
    </>
  );
}

// ---------------------------------------------------------------------------
// n01オンライン (観戦できる公開試合)
// ---------------------------------------------------------------------------

const vsTitle = (row: GameRow): string => `${row.sides[0].name} vs ${row.sides[1].name}`;
const sideNames = (row: GameRow): string[] => [...new Set(row.sides.flatMap((side) => [side.name, ...side.members.map((member) => member.name)]).map((name) => name.trim()))];

function OnlineRow({ row, current, onOpen, testId = 'browse-online' }: { row: GameRow; current: boolean; onOpen: () => void; testId?: string }): React.JSX.Element {
  return (
    <N01Row
      id={row.mid}
      current={current}
      testId={testId}
      onOpen={onOpen}
      title={
        <span className="n01-duel">
          <span className="n01-duel-name">{row.sides[0].name}</span>
          <span className="n01-duel-score" aria-label={`Leg ${row.sides[0].legsWon ?? 0} 対 ${row.sides[1].legsWon ?? 0}`}>
            {row.sides[0].legsWon ?? 0} - {row.sides[1].legsWon ?? 0}
          </span>
          <span className="n01-duel-name">{row.sides[1].name}</span>
        </span>
      }
      aside={
        <>
          <span className="tag browse-state state-live">進行中</span>
          <span className="muted small-text">{row.matchType === 'cricket' ? 'Cricket' : '01'}</span>
        </>
      }
    >
      <span>{row.startTime ? `開始 ${formatClock(row.startTime * 1000)}` : '開始時刻 未取得'}</span>
      <span className="muted"> ・ {row.updateTime ? `最終更新 ${formatClock(row.updateTime)}` : '更新時刻 未取得'}</span>
    </N01Row>
  );
}

function OnlineList({ api, current, onGame }: { api: MatchesApi; current: string | null; onGame: (mid: string, title: string) => void }): React.JSX.Element {
  const list = useBrowseList<GameRow>('online', (options) => api.browseOnline(options), (row) => row.mid, ONLINE_PAGE);
  const ref = useRef<HTMLUListElement>(null);
  useRestore(list.restore, ref);
  const followed = useFollowed();
  const { state } = list;
  const needle = list.draft.trim().toLowerCase();
  const shown = needle ? state.items.filter((row) => sideNames(row).some((name) => name.toLowerCase().includes(needle))) : state.items;
  const starred = state.items.map((row) => ({ row, names: sideNames(row).filter((name) => followed.names.has(name)) })).filter((entry) => entry.names.length > 0);
  const open = (row: GameRow): void => {
    list.remember(row.mid);
    onGame(row.mid, vsTitle(row));
  };
  return (
    <>
      <div className="browse-lobby">
        <a className="btn small" href={N01_ONLINE_LOBBY_URL} target="_blank" rel="noopener noreferrer" data-testid="official-lobby">
          公式ロビーを開く <Icon name="external" size={14} />
          <span className="sr-only"> (新しいタブ)</span>
        </a>
        <span className="muted small-text">待機中・ゲーム中・中継中の公式の並びは公式ロビーで確認できます。</span>
      </div>
      <h3 className="section-mini browse-subhead">観戦できる公開試合</h3>
      <input
        type="search"
        className="browse-filter"
        value={list.draft}
        onChange={(event) => list.setDraft(event.target.value)}
        placeholder="選手名で絞り込み (読み込んだ範囲)"
        aria-label="選手名で絞り込み (読み込んだ範囲)"
        enterKeyHint="search"
        autoComplete="off"
        data-testid="browse-search"
      />
      <Meta state={state} noun="試合" order="開始の新しい順 (大会・リーグ・中継を除く)" onReload={list.reload} />
      {starred.length ? (
        <section className="followed-now" aria-label="注目選手" data-testid="followed-now">
          <h3 className="section-mini">
            <span aria-hidden="true">★</span> 注目選手が出場中
          </h3>
          <ul className="n01-list">
            {starred.map(({ row, names }) => (
              <N01Row key={row.mid} id={`followed:${row.mid}`} current={false} testId="followed-row" onOpen={() => open(row)} title={names.join('・')} aside={<span className="tag browse-state state-live">進行中</span>}>
                <span>
                  {row.sides[0].name} {row.sides[0].legsWon ?? 0} - {row.sides[1].legsWon ?? 0} {row.sides[1].name}
                </span>
              </N01Row>
            ))}
          </ul>
          <p className="muted small-text">選手名で照合しています (同姓同名は区別できません)。</p>
        </section>
      ) : null}
      <ul className="n01-list" ref={ref} data-testid="browse-list">
        {shown.map((row) => (
          <OnlineRow key={row.mid} row={row} current={current === row.mid} onOpen={() => open(row)} />
        ))}
      </ul>
      <Empty state={state} noun="試合" filtered={needle && state.items.length > 0 && shown.length === 0 ? list.draft.trim() : undefined} />
      <Notes state={state} />
      <Footer state={state} noun="試合" pageSize={ONLINE_PAGE} onMore={list.more} onRetry={list.reload} />
    </>
  );
}

// ---------------------------------------------------------------------------
// 画面
// ---------------------------------------------------------------------------

export function BrowseView({
  category,
  factory,
  backLabel,
  current = null,
  onBack,
  onCategory,
  onTournament,
  onLeague,
  onGame,
}: {
  category: BrowseCategory;
  factory: MatchesApiFactory;
  backLabel: string;
  /** いま見ている大会・リーグ・試合の ID (選択中の輪郭)。 */
  current?: string | null;
  onBack: () => void;
  onCategory: (next: BrowseCategory) => void;
  onTournament: (item: TournamentItem) => void;
  onLeague: (item: LeagueItem) => void;
  onGame: (mid: string, title: string) => void;
}): React.JSX.Element {
  // 一覧は利用者が操作したときだけ読む: 通信の上限 (budget) に当たらないよう、画面ごとに 1 つ。
  const api = useMemo(() => factory({ maxRequests: 100_000 }), [factory]);
  const label = browseLabel(category);
  return (
    <section className="browse" data-testid="browse-view" data-category={category} aria-labelledby="browse-heading">
      <div className="browse-head">
        <button type="button" className="btn ghost small browse-back" onClick={onBack} data-testid="browse-back">
          <Icon name="chevronLeft" size={16} /> {backLabel}
        </button>
        <h2 id="browse-heading" className="browse-title">
          {label}
        </h2>
      </div>
      <div className="segmented browse-tabs" role="tablist" aria-label="n01 の一覧" onKeyDown={onTabListKeyDown}>
        {BROWSE_CATEGORIES.map((entry) => (
          <button
            key={entry.id}
            type="button"
            role="tab"
            id={`browse-tab-${entry.id}`}
            aria-controls="browse-panel"
            aria-selected={entry.id === category}
            tabIndex={entry.id === category ? 0 : -1}
            onClick={() => {
              if (entry.id !== category) onCategory(entry.id);
            }}
          >
            {entry.label}
          </button>
        ))}
      </div>
      <div role="tabpanel" id="browse-panel" aria-labelledby={`browse-tab-${category}`} className="browse-panel">
        {category === 'online' ? <OnlineList key="online" api={api} current={current} onGame={onGame} /> : null}
        {category === 'tournament' ? <TournamentList key="tournament" api={api} current={current} onOpen={onTournament} /> : null}
        {category === 'league' ? <LeagueList key="league" api={api} current={current} onOpen={onLeague} /> : null}
      </div>
    </section>
  );
}

/** 観戦の各画面から 3 つの一覧へ (公式メニューと同じ順)。 */
export function BrowseLinks({ onBrowse, label = 'n01 の一覧から探す' }: { onBrowse: (category: BrowseCategory) => void; label?: string }): React.JSX.Element {
  return (
    <nav className="browse-links" aria-label={label}>
      <span className="muted small-text browse-links-label">{label}</span>
      <span className="chip-row">
        {BROWSE_CATEGORIES.map((entry) => (
          <button key={entry.id} type="button" className="chip" onClick={() => onBrowse(entry.id)} data-testid={`browse-link-${entry.id}`}>
            {entry.label}
          </button>
        ))}
      </span>
    </nav>
  );
}
