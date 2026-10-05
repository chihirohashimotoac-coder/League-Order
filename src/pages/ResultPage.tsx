import { useMemo, useState } from 'react';
import type {
  Diagnostic,
  GameSlotDef,
  MatchInfo,
  OrderLifecycleState,
  Player,
  SavedOrder,
  SeasonCommitStatus,
} from '../domain/types';
import { ORDER_STATE_LABELS } from '../domain/types';
import { sortedGames } from '../domain/games/format';
import {
  diffVersionWithCurrent,
  latestVersion,
  nextVersionNumber,
} from '../domain/orders/lifecycle';
import { SEASON_STATUS_LABELS } from '../domain/orders/seasonLedger';
import { ShareSheet } from '../components/ShareSheet';
import { VersionDiff } from '../components/VersionDiff';
import {
  canRedo,
  canUndo,
  lockKey,
  lockedSlots,
  type UndoableAction,
  type UndoableState,
} from '../state/orderSession';
import { Bar, Card, ConfirmDialog, EmptyState, Metric, Sheet } from '../components/ui';

/**
 * ORDER RESULT screen (spec §14–§22, §26).
 *
 * Everything the captain does after generation happens here: inspect, lock, edit by
 * hand, re-optimise part of the order, compare alternatives, read why the engine chose
 * each line-up, and share the result.
 */
export function ResultPage({
  session,
  dispatch,
  games,
  diagnostics,
  generating,
  match,
  onMatchChange,
  onRegenerate,
  onReoptimise,
  record,
  lifecycle,
  seasonStatus,
  onFinalize,
  onSaveDraft,
  onCommitSeason,
  onWithdrawSeason,
}: {
  session: UndoableState;
  dispatch: (action: UndoableAction) => void;
  games: GameSlotDef[];
  diagnostics: Diagnostic[];
  generating: boolean;
  match: MatchInfo;
  onMatchChange: (next: MatchInfo) => void;
  onRegenerate: () => void;
  onReoptimise: (keepGameId: string | null) => void;
  /** The persisted order, once it has been saved or finalized. */
  record: SavedOrder | null;
  lifecycle: OrderLifecycleState;
  seasonStatus: SeasonCommitStatus;
  onFinalize: () => void;
  onSaveDraft: () => void;
  onCommitSeason: () => void;
  onWithdrawSeason: () => void;
}): React.JSX.Element {
  const [shareOpen, setShareOpen] = useState(false);
  const [confirmSeason, setConfirmSeason] = useState(false);
  const [diffOpen, setDiffOpen] = useState(false);
  const [confirmWithdraw, setConfirmWithdraw] = useState(false);

  const state = session.present;
  const solution = state.current;
  const ordered = useMemo(() => sortedGames(games), [games]);
  const locks = useMemo(() => lockedSlots(state.input), [state.input]);
  const players = state.input.players;
  const nameById = useMemo(() => new Map(players.map((player) => [player.id, player.name])), [players]);

  if (diagnostics.length > 0 && !solution) {
    return <DiagnosticsPanel diagnostics={diagnostics} games={ordered} players={players} />;
  }

  if (!solution) {
    return (
      <Card>
        <EmptyState>
          まだオーダーがありません。
          <br />
          「オーダー」タブで条件を設定して生成してください。
        </EmptyState>
      </Card>
    );
  }

  const violatingGames = new Set(state.violations.map((violation) => violation.gameId).filter(Boolean));

  const versions = record?.versions ?? [];
  const latest = latestVersion(versions);

  // The diff a captain needs to see is "what changed since the team was last told",
  // i.e. the latest finalized version against the working copy.
  const pendingDiff =
    latest && solution
      ? diffVersionWithCurrent(latest, {
          games: ordered,
          assignments: solution.assignments,
          players,
        })
      : null;

  return (
    <>
      {state.candidates.length > 1 ? (
        <div className="candidate-tabs" role="group" aria-label="候補の切り替え">
          {state.candidates.map((candidate, index) => (
            <button
              type="button"
              key={`${candidate.meta.label}-${index}`}
              className="candidate-tab"
              aria-pressed={state.selectedCandidate === index && !state.edited}
              onClick={() => dispatch({ type: 'selectCandidate', index })}
            >
              <span className="label">
                {String.fromCharCode(65 + index)}: {candidate.meta.label}
              </span>
              <span className="score">{candidate.score.display}</span>
              <span className="meta">
                差{candidate.metrics.appearanceSpread} / 連続{candidate.metrics.maxConsecutive} / R
                {candidate.metrics.averageRating ?? '-'}
              </span>
            </button>
          ))}
        </div>
      ) : null}

      <OrderStateBanner
        lifecycle={lifecycle}
        versions={versions.length}
        latestVersion={latest?.version ?? 0}
        seasonStatus={seasonStatus}
        changeCount={pendingDiff?.changes.length ?? 0}
        onShowDiff={() => setDiffOpen(true)}
      />

      {state.edited ? (
        <div className="notice info">
          <span aria-hidden="true">✎</span>
          <span>手動編集中です。数値は編集内容で再計算されています。</span>
        </div>
      ) : null}

      {state.violations.length > 0 ? (
        <div className="notice danger">
          <span aria-hidden="true">⚠</span>
          <span>
            <strong>Hard制約に違反しています</strong>
            <ul style={{ margin: '4px 0 0', paddingLeft: 18 }}>
              {state.violations.map((violation, index) => (
                <li key={index} className="small-text">
                  {violation.message}
                </li>
              ))}
            </ul>
          </span>
        </div>
      ) : null}

      {solution.warnings.map((warning, index) => (
        <div key={index} className={warning.severity === 'warning' ? 'notice warn' : 'notice info'}>
          <span aria-hidden="true">{warning.severity === 'warning' ? '△' : 'i'}</span>
          <span className="small-text">{warning.message}</span>
        </div>
      ))}

      <h2 className="section-title">オーダー</h2>
      {ordered.map((game) => {
        const assignment = solution.assignments.find((entry) => entry.gameId === game.id);
        if (!assignment) return null;
        const gameLocked = assignment.playerIds.every((_, slot) => locks.has(lockKey(game.id, slot)));
        return (
          <div
            className={`order-game${violatingGames.has(game.id) ? ' violating' : ''}`}
            key={game.id}
          >
            {/* The name gets its own full-width row: "Doubles 501" and "Doubles Cricket"
                must stay distinguishable at phone width. */}
            <div className="order-game-head">
              <span className="no">{game.order}</span>
              <span className="name">{game.name}</span>
              <span className="badge">{game.playerCount}名</span>
            </div>

            {assignment.playerIds.map((playerId, slotIndex) => {
              const key = lockKey(game.id, slotIndex);
              const isLocked = locks.has(key);
              return (
                <div className={`slot${isLocked ? ' locked' : ''}`} key={slotIndex}>
                  <span className="slot-label">{game.playerCount > 1 ? slotIndex + 1 : '·'}</span>
                  <select
                    value={playerId}
                    disabled={isLocked}
                    aria-label={`Game ${game.order} ${game.name} のスロット ${slotIndex + 1}`}
                    onChange={(event) =>
                      dispatch({
                        type: 'assignPlayer',
                        gameId: game.id,
                        slotIndex,
                        playerId: event.target.value === '' ? null : event.target.value,
                      })
                    }
                  >
                    <option value="">(空席)</option>
                    {players.map((player) => (
                      <option key={player.id} value={player.id}>
                        {player.name}
                        {player.rating === null ? ' (R未入力)' : ` (R${player.rating})`}
                      </option>
                    ))}
                  </select>
                  <button
                    type="button"
                    className="lock-toggle"
                    aria-pressed={isLocked}
                    aria-label={`Game ${game.order} ${game.name} スロット ${slotIndex + 1} のロック`}
                    onClick={() => dispatch({ type: 'toggleLock', gameId: game.id, slotIndex })}
                  >
                    {isLocked ? '🔒' : '🔓'}
                  </button>
                </div>
              );
            })}

            <div className="order-game-actions">
              <button
                type="button"
                className="btn small ghost"
                onClick={() => dispatch({ type: 'lockGame', gameId: game.id, locked: !gameLocked })}
                aria-pressed={gameLocked}
                aria-label={`Game ${game.order} ${game.name} を全固定`}
              >
                {gameLocked ? '🔒 固定解除' : '🔓 全固定'}
              </button>
              <button
                type="button"
                className="btn small"
                disabled={generating}
                onClick={() => onReoptimise(game.id)}
                aria-label={`Game ${game.order} ${game.name} だけ再計算`}
                title="このゲーム以外を固定したまま、このゲームだけ再最適化します"
              >
                ここだけ再計算
              </button>
            </div>
          </div>
        );
      })}

      <h2 className="section-title">集計</h2>
      <Card>
        <div className="metrics" style={{ marginBottom: 12 }}>
          <Metric label="総合評価" value={solution.score.display} />
          <Metric
            label="最大出場差"
            value={solution.metrics.appearanceSpread}
            tone={solution.metrics.appearanceSpread <= 1 ? 'ok' : 'warn'}
          />
          <Metric label="最大連続" value={solution.metrics.maxConsecutive} />
          <Metric label="平均Rating" value={solution.metrics.averageRating ?? '-'} />
          <Metric label="標準偏差" value={solution.metrics.appearanceStdDev} />
          <Metric label="総枠" value={solution.metrics.totalSlots} />
        </div>

        <div className="table-scroll">
          <table className="data stack-mobile">
            <thead>
              <tr>
                <th>Player</th>
                <th className="num">Rating</th>
                <th className="num">今回</th>
                <th className="num">Season</th>
              </tr>
            </thead>
            <tbody>
              {[...solution.tallies]
                .sort((a, b) => b.count - a.count || (nameById.get(a.playerId) ?? '').localeCompare(nameById.get(b.playerId) ?? '', 'ja'))
                .map((tally) => (
                  <tr key={tally.playerId}>
                    <td>{nameById.get(tally.playerId) ?? tally.playerId}</td>
                    <td className="num" data-label="R">
                      {tally.effectiveRating === null ? '-' : tally.effectiveRating}
                      {tally.ratingImputed ? <span className="dim">*</span> : null}
                    </td>
                    <td className="num" data-label="今回">
                      {tally.count}
                    </td>
                    <td className="num" data-label="季">
                      {tally.seasonTotal}
                    </td>
                  </tr>
                ))}
            </tbody>
          </table>
        </div>
        {solution.metrics.hasImputedRating ? (
          <p className="tiny dim" style={{ marginBottom: 0 }}>
            * Rating 未入力のため、0 ではなく参加者の中央値を暫定値として評価しています。
          </p>
        ) : null}
      </Card>

      <h2 className="section-title">評価の内訳</h2>
      <Card>
        {(
          [
            ['戦力 (Rating)', solution.score.strength],
            ['ゲーム適性', solution.score.gameFit],
            ['ペア相性', solution.score.pairFit],
            ['出場回数の公平性', solution.score.fairness],
          ] as const
        ).map(([label, value]) => (
          <div key={label} style={{ marginBottom: 10 }}>
            <div className="row between" style={{ marginBottom: 3 }}>
              <span className="tiny muted">{label}</span>
              <span className="tiny dim">{Math.round(value * 100)}%</span>
            </div>
            <Bar value={value} />
          </div>
        ))}
        {(
          [
            ['連続出場ペナルティ', solution.score.consecutivePenalty],
            ['シーズン不均衡', solution.score.seasonImbalance],
          ] as const
        ).map(([label, value]) => (
          <div key={label} style={{ marginBottom: 10 }}>
            <div className="row between" style={{ marginBottom: 3 }}>
              <span className="tiny muted">{label} (低いほど良い)</span>
              <span className="tiny dim">{Math.round(value * 100)}%</span>
            </div>
            <Bar value={value} />
          </div>
        ))}
        <p className="tiny dim" style={{ margin: 0 }}>
          探索: {solution.meta.stage} / {solution.meta.nodesVisited.toLocaleString()} ノード /{' '}
          {solution.meta.elapsedMs}ms /{' '}
          {solution.meta.exhaustive ? '全探索完了 (この候補集合での最適)' : '時間内の最良解'}
        </p>
      </Card>

      <h2 className="section-title">生成理由</h2>
      <Card>
        <ul className="reason-list" style={{ padding: 0 }}>
          {solution.explanation.overall.map((factor, index) => (
            <li key={index}>
              <span className={`tone ${factor.tone}`} aria-hidden="true">
                {factor.tone === 'positive' ? '●' : factor.tone === 'negative' ? '▲' : '○'}
              </span>
              <span>
                <span className="k">{factor.label}: </span>
                {factor.detail}
              </span>
            </li>
          ))}
        </ul>
      </Card>

      {solution.explanation.games.map((explanation) => {
        const game = ordered.find((entry) => entry.id === explanation.gameId);
        return (
          <details className="reason-game" key={explanation.gameId}>
            <summary>
              <span className="badge accent">{game?.order}</span>
              <span className="grow">{game?.name}</span>
              <span className="tiny dim">
                {explanation.playerIds.map((id) => nameById.get(id) ?? id).join(' / ')}
              </span>
            </summary>
            <ul className="reason-list">
              {explanation.factors.map((factor, index) => (
                <li key={index}>
                  <span className={`tone ${factor.tone}`} aria-hidden="true">
                    {factor.tone === 'positive' ? '●' : factor.tone === 'negative' ? '▲' : '○'}
                  </span>
                  <span>
                    <span className="k">{factor.label}: </span>
                    {factor.detail}
                  </span>
                </li>
              ))}
            </ul>
          </details>
        );
      })}

      <h2 className="section-title">確定とシーズン</h2>
      <Card>
        <div className="row wrap" style={{ gap: 8, marginBottom: 10 }}>
          <button
            type="button"
            className="btn small primary"
            onClick={onFinalize}
            disabled={state.violations.length > 0}
          >
            {lifecycle === 'DRAFT'
              ? `オーダーを確定 (v${nextVersionNumber(versions)})`
              : lifecycle === 'UPDATED'
                ? `再確定 (v${nextVersionNumber(versions)})`
                : `確定済み v${latest?.version ?? 1}`}
          </button>
          {pendingDiff && pendingDiff.changed ? (
            <button type="button" className="btn small" onClick={() => setDiffOpen(true)}>
              変更点を確認 ({pendingDiff.changes.length})
            </button>
          ) : null}
          <button type="button" className="btn small" onClick={onSaveDraft}>
            下書きを保存
          </button>
        </div>

        <div className="row wrap" style={{ gap: 8 }}>
          <button
            type="button"
            className="btn small"
            onClick={() => setConfirmSeason(true)}
            disabled={lifecycle !== 'FINALIZED'}
            title={
              lifecycle === 'FINALIZED'
                ? undefined
                : '確定済みのオーダーだけがシーズン累計へ反映できます'
            }
          >
            {seasonStatus === 'none' ? 'シーズン累計へ反映' : 'シーズン累計を再反映'}
          </button>
          {seasonStatus !== 'none' ? (
            <button type="button" className="btn small danger" onClick={() => setConfirmWithdraw(true)}>
              反映を取り消す
            </button>
          ) : null}
        </div>
        <p className="tiny dim" style={{ marginBottom: 0, marginTop: 8 }}>
          {lifecycle === 'FINALIZED'
            ? '同じオーダーを何度反映しても二重加算されません (反映済みの差分だけが適用されます)。'
            : '確定するとシーズン累計へ反映できるようになります。'}
        </p>
      </Card>

      <h2 className="section-title">その他</h2>
      <Card>
        <div className="row wrap" style={{ gap: 8 }}>
          <button
            type="button"
            className="btn small"
            onClick={() => dispatch({ type: 'clearLocks' })}
            disabled={state.input.locks.length === 0}
          >
            ロック全解除 ({state.input.locks.length})
          </button>
          <button
            type="button"
            className="btn small"
            disabled={generating}
            onClick={() => onReoptimise(null)}
          >
            ロックを保ったまま再最適化
          </button>
        </div>
      </Card>

      <div className="action-bar">
        <button
          type="button"
          className="btn"
          onClick={() => dispatch({ type: 'undo' })}
          disabled={!canUndo(session)}
          aria-label="元に戻す"
        >
          ↩ 戻す
        </button>
        <button
          type="button"
          className="btn"
          onClick={() => dispatch({ type: 'redo' })}
          disabled={!canRedo(session)}
          aria-label="やり直す"
        >
          ↪
        </button>
        <button type="button" className="btn" disabled={generating} onClick={onRegenerate}>
          {generating ? <span className="spinner" aria-hidden="true" /> : '再生成'}
        </button>
        <button type="button" className="btn primary" onClick={() => setShareOpen(true)}>
          共有
        </button>
      </div>

      {shareOpen ? (
        <ShareSheet
          games={ordered}
          players={players}
          solution={solution}
          match={match}
          onMatchChange={onMatchChange}
          lifecycle={lifecycle}
          versions={versions}
          onClose={() => setShareOpen(false)}
        />
      ) : null}

      {diffOpen && pendingDiff && latest ? (
        <Sheet title={`v${latest.version} からの変更`} onClose={() => setDiffOpen(false)}>
          <VersionDiff
            diff={pendingDiff}
            beforeLabel={`v${latest.version} (確定済み)`}
            afterLabel="現在の内容"
          />
        </Sheet>
      ) : null}

      {confirmSeason ? (
        <ConfirmDialog
          title={seasonStatus === 'none' ? 'シーズン累計へ反映' : 'シーズン累計を再反映'}
          message={
            seasonStatus === 'none'
              ? `確定版 v${latest?.version ?? 1} の出場回数をシーズン累計へ反映します。反映済みの分は記録されるため、同じ内容を何度実行しても二重加算されません。`
              : `シーズン累計を確定版 v${latest?.version ?? 1} の内容に合わせます。既に反映済みの分との差分だけが適用されます。`
          }
          confirmLabel="反映する"
          onCancel={() => setConfirmSeason(false)}
          onConfirm={() => {
            onCommitSeason();
            setConfirmSeason(false);
          }}
        />
      ) : null}

      {confirmWithdraw ? (
        <ConfirmDialog
          title="シーズン反映を取り消す"
          message="このオーダーがシーズン累計へ加えた分をすべて差し戻します。反映前の数値に戻ります。"
          confirmLabel="取り消す"
          destructive
          onCancel={() => setConfirmWithdraw(false)}
          onConfirm={() => {
            onWithdrawSeason();
            setConfirmWithdraw(false);
          }}
        />
      ) : null}
    </>
  );
}

function OrderStateBanner({
  lifecycle,
  versions,
  latestVersion: latest,
  seasonStatus,
  changeCount,
  onShowDiff,
}: {
  lifecycle: OrderLifecycleState;
  versions: number;
  latestVersion: number;
  seasonStatus: SeasonCommitStatus;
  changeCount: number;
  onShowDiff: () => void;
}): React.JSX.Element {
  const tone = lifecycle === 'DRAFT' ? 'draft' : lifecycle === 'FINALIZED' ? 'finalized' : 'updated';
  const note =
    lifecycle === 'DRAFT'
      ? '確定するとバージョンが付き、チームへ共有できます。'
      : lifecycle === 'FINALIZED'
        ? `最新の確定版は v${latest} です。${SEASON_STATUS_LABELS[seasonStatus]}。`
        : `v${latest} を共有済みです。${changeCount} 件の変更があるため、再確定してから共有してください。`;

  return (
    <div className={`state-banner ${tone}`}>
      <span aria-hidden="true">{lifecycle === 'FINALIZED' ? '✓' : lifecycle === 'UPDATED' ? '!' : '✎'}</span>
      <span className="state-text">
        <span className="state-title">
          {ORDER_STATE_LABELS[lifecycle]}
          {versions > 0 ? ` ・ v${latest}` : ''}
        </span>
        <span className="state-note">{note}</span>
      </span>
      {lifecycle === 'UPDATED' ? (
        <button type="button" className="btn small" onClick={onShowDiff}>
          変更点
        </button>
      ) : null}
    </div>
  );
}

function DiagnosticsPanel({
  diagnostics,
  games,
  players,
}: {
  diagnostics: Diagnostic[];
  games: GameSlotDef[];
  players: Player[];
}): React.JSX.Element {
  const nameById = new Map(players.map((player) => [player.id, player.name]));
  const gameById = new Map(games.map((game) => [game.id, game]));

  return (
    <>
      <div className="notice danger">
        <span aria-hidden="true">⚠</span>
        <span>
          <strong>オーダーを生成できませんでした</strong>
          <br />
          Hard 制約を自動的に破ることはしません。以下の競合を解消してください。
        </span>
      </div>

      {diagnostics.map((diagnostic, index) => (
        <Card key={index}>
          <p className="small-text" style={{ marginTop: 0, fontWeight: 600 }}>
            {diagnostic.gameId ? (
              <span className="badge accent" style={{ marginRight: 6 }}>
                Game {gameById.get(diagnostic.gameId)?.order ?? '?'}
              </span>
            ) : null}
            {diagnostic.message}
          </p>
          {diagnostic.suggestions.length > 0 ? (
            <>
              <p className="tiny dim" style={{ marginBottom: 4 }}>
                解決の候補
              </p>
              <ul style={{ margin: 0, paddingLeft: 18 }}>
                {diagnostic.suggestions.map((suggestion, suggestionIndex) => (
                  <li key={suggestionIndex} className="small-text">
                    {suggestion.message}
                    {suggestion.playerId && !suggestion.message.includes(nameById.get(suggestion.playerId) ?? '§')
                      ? ` (${nameById.get(suggestion.playerId)})`
                      : ''}
                  </li>
                ))}
              </ul>
            </>
          ) : null}
        </Card>
      ))}

      <p className="tiny dim" style={{ padding: '0 4px 8px' }}>
        「オーダー」タブで条件を調整してから、もう一度生成してください。
      </p>
    </>
  );
}
