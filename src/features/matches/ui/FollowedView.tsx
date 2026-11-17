import { useEffect, useMemo, useRef, useState } from 'react';
import { Icon } from '../../../components/icons';
import { describeN01Error } from '../../../integrations/n01/client';
import type { MatchesApiFactory } from '../environment';
import type { GameRow } from '../parse';
import { NOW_KIND_LABEL, followedGames, nowKind } from '../followedNow';
import { formatClock, useFollowed } from './useMatchContext';
import { N01Row } from './BrowseView';

/**
 * 注目選手の試合: 登録した選手が出場中の試合を、大会・リーグ・個別の試合を横断して並べる。
 * 読むのは、この画面を開いたとき (と「更新」) の `match/list` 1 回だけ (n01 で進行中の新しい 100 試合、
 * 以前の一覧「いま n01 で進行中」と同じ範囲)。照合は選手名とメンバー名で、同姓同名は区別できない。
 * 行から既存の観戦詳細 (SetMatchPage) を開き、戻ると同じ行にフォーカスが戻る (画面は下に残る)。
 */

type State = { kind: 'loading'; rows: GameRow[] | null } | { kind: 'ready'; rows: GameRow[] } | { kind: 'error'; rows: GameRow[] | null; message: string };

export function FollowedView({ factory, backLabel, onBack, onGame }: { factory: MatchesApiFactory; backLabel: string; onBack: () => void; onGame: (mid: string, title: string) => void }): React.JSX.Element {
  const api = useMemo(() => factory({ maxRequests: 100_000 }), [factory]);
  const followed = useFollowed();
  const [state, setState] = useState<State>({ kind: 'loading', rows: null });
  const [fetchedAt, setFetchedAt] = useState<number | null>(null);
  const ticket = useRef(0);
  const controller = useRef<AbortController | null>(null);

  const load = (): void => {
    const mine = ++ticket.current;
    controller.current?.abort();
    const abort = new AbortController();
    controller.current = abort;
    setState((held) => ({ kind: 'loading', rows: held.rows }));
    api.nowLive(abort.signal).then(
      (rows) => {
        if (mine !== ticket.current) return;
        setState({ kind: 'ready', rows });
        setFetchedAt(Date.now());
      },
      (reason: unknown) => {
        if (mine !== ticket.current) return;
        setState((held) => ({ kind: 'error', rows: held.rows, message: describeN01Error(reason) }));
      },
    );
  };

  // 開いたときに読む。注目選手の設定がまだ読み込まれていない (直接開いた・再読み込み) ときは、登録が
  // そろった時点で読む。開始と中止を同じ Effect で扱うので、Effect が再実行されても (StrictMode) 読み直す
  // (中止した読み込みの応答は番号で捨てる)。以後は「更新」と「再試行」で読む。
  const hasFollowed = followed.names.size > 0;
  useEffect(() => {
    if (!hasFollowed) return;
    load();
    return () => controller.current?.abort();
  }, [api, hasFollowed]);

  const games = state.rows ? followedGames(state.rows, followed.names) : [];
  const registered = [...followed.names];

  return (
    <section className="browse followed-view" data-testid="followed-view" aria-labelledby="followed-heading">
      <div className="browse-head">
        <button type="button" className="btn ghost small browse-back" onClick={onBack} data-testid="followed-back">
          <Icon name="chevronLeft" size={16} /> {backLabel}
        </button>
        <h2 id="followed-heading" className="browse-title">
          <span aria-hidden="true">★</span> 注目選手の試合
        </h2>
      </div>
      {registered.length === 0 ? (
        <p className="small-text browse-empty" data-testid="followed-none">
          注目選手が登録されていません。観戦のスタッツや選手のカードから「注目選手に追加」で登録できます。
        </p>
      ) : (
        <>
          <p className="muted small-text followed-names" data-testid="followed-names">
            登録 {registered.length} 人: {registered.join('・')}
          </p>
          <div className="browse-meta small-text" data-testid="browse-meta">
            <span className="browse-meta-text">
              {state.kind === 'ready' ? <span data-testid="followed-count">出場中 {games.length} 試合</span> : state.kind === 'loading' ? <span>読み込み中…</span> : <span>取得できませんでした</span>}
              {fetchedAt !== null ? <span> ・ 取得 {formatClock(fetchedAt)}</span> : null}
              <span> ・ n01 で進行中の新しい 100 試合 (大会・リーグ・個別の試合) から照合</span>
            </span>
            <button type="button" className="btn small icon ghost" onClick={load} aria-label="最新の試合を取得" disabled={state.kind === 'loading'}>
              <Icon name="refresh" size={16} />
            </button>
          </div>
          {state.kind === 'error' ? (
            <div className="notice danger browse-error" role="alert" data-testid="followed-error">
              <Icon name="alert" size={18} />
              <span className="grow small-text">進行中の試合を取得できませんでした: {state.message}</span>
              <button type="button" className="btn small" onClick={load}>
                再試行
              </button>
            </div>
          ) : null}
          {state.kind === 'loading' && !state.rows ? (
            <p className="muted small-text browse-status" role="status">
              <span className="spinner" aria-hidden="true" /> n01 から読み込み中…
            </p>
          ) : null}
          {state.kind === 'ready' && games.length === 0 ? (
            <p className="small-text browse-empty" data-testid="followed-empty">
              いま出場中の注目選手はいません。
            </p>
          ) : null}
          <ul className="n01-list" data-testid="followed-list">
            {games.map(({ row, names }) => {
              const kind = nowKind(row);
              return (
                <N01Row
                  key={row.mid}
                  id={row.mid}
                  current={false}
                  testId="followed-game"
                  onOpen={() => onGame(row.mid, `${row.sides[0].name} vs ${row.sides[1].name}`)}
                  title={names.join('・')}
                  aside={
                    <>
                      <span className="tag browse-state state-prep" data-kind={kind}>
                        {NOW_KIND_LABEL[kind]}
                      </span>
                      <span className="tag browse-state state-live">進行中</span>
                    </>
                  }
                >
                  <span>
                    {row.sides[0].name} {row.sides[0].legsWon ?? 0} - {row.sides[1].legsWon ?? 0} {row.sides[1].name}
                  </span>
                  <span className="muted">
                    {row.title ? ` ・ ${row.title}` : ''} ・ {row.startTime ? `開始 ${formatClock(row.startTime * 1000)}` : '開始時刻 未取得'}
                  </span>
                </N01Row>
              );
            })}
          </ul>
          <p className="muted small-text">選手名で照合しています (ダブルス・チーム戦はメンバー名も。同姓同名は区別できません)。</p>
        </>
      )}
    </section>
  );
}
