import { useMemo, useState } from 'react';
import type {
  Diagnostic,
  GameKind,
  GameSlotDef,
  MatchInfo,
  OrderInput,
  OrderLifecycleState,
  OrderSolution,
  Player,
  SavedOrder,
  SeasonCommitStatus,
} from '../domain/types';
import { GAME_KIND_LABELS } from '../domain/types';
import { describeStrengthWeights, formatPpr } from '../domain/players/strength';
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
import {
  Bar,
  Card,
  ConfirmDialog,
  DisciplineBadge,
  EmptyState,
  Metric,
  STATE_META,
  SectionHeader,
  Sheet,
  StatusBadge,
  formatRating,
} from '../components/ui';
import { StrengthBasisPanel } from '../components/StrengthBasisPanel';
import { Icon } from '../components/icons';
import { OpponentPanel } from '../components/n01/OpponentPanel';
import { useAppStore } from '../state/appStore';
import type { GamePrediction } from '../domain/prediction/predictOrder';
import { formatProbability } from '../domain/prediction/predictOrder';
import { CONFIDENCE_LABELS } from '../domain/prediction/confidence';

/**
 * ORDER RESULT screen (spec §14–§22, §26).
 *
 * The order itself is the subject of this screen. Always visible: the lifecycle state,
 * the order as scoreboard cards, who plays how often, and one state-dependent primary
 * action. Everything analytical (score breakdown, reasons, search statistics) sits in a
 * single collapsed "詳細分析" panel — kept, never removed, but out of the captain's way.
 */
export function ResultPage({
  session,
  dispatch,
  games,
  diagnostics,
  diagnosticInput = null,
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
  /** The failed attempt's input, for naming its games and players. */
  diagnosticInput?: OrderInput | null;
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
  // Estimates can be hidden in the settings; they are never shown on shared images anyway.
  const showPredictions = useAppStore().settings.n01?.showPredictions !== false;

  const state = session.present;
  const solution = state.current;
  const ordered = useMemo(() => sortedGames(games), [games]);
  const locks = useMemo(() => lockedSlots(state.input), [state.input]);
  const players = state.input.players;
  const playerById = useMemo(() => new Map(players.map((player) => [player.id, player])), [players]);
  const nameById = useMemo(() => new Map(players.map((player) => [player.id, player.name])), [players]);
  const diagnosticGames = useMemo(
    () => (diagnosticInput ? sortedGames(diagnosticInput.games) : ordered),
    [diagnosticInput, ordered],
  );
  const diagnosticPlayers = diagnosticInput?.players ?? players;

  if (diagnostics.length > 0 && !solution) {
    return <DiagnosticsPanel diagnostics={diagnostics} games={diagnosticGames} players={diagnosticPlayers} />;
  }

  if (!solution) {
    return (
      <EmptyState kicker="NO ORDER YET" title="まだオーダーがありません">
        「オーダー」タブで条件を設定して生成してください。
      </EmptyState>
    );
  }

  const violatingGames = new Set(state.violations.map((violation) => violation.gameId).filter(Boolean));

  const versions = record?.versions ?? [];
  const latest = latestVersion(versions);
  const nextVersion = nextVersionNumber(versions);

  // The diff a captain needs to see is "what changed since the team was last told",
  // i.e. the latest finalized version against the working copy.
  const pendingDiff = latest
    ? diffVersionWithCurrent(latest, {
        games: ordered,
        assignments: solution.assignments,
        players,
      })
    : null;

  // Slots that differ from the generated candidate are marked as hand-edited.
  const baseline = state.edited ? state.candidates[state.selectedCandidate] : null;
  const baselineByGame = new Map(baseline?.assignments.map((entry) => [entry.gameId, entry.playerIds]));
  const hasViolations = state.violations.length > 0;

  const shareButton = (
    <button type="button" className="btn small outline" onClick={() => setShareOpen(true)}>
      <Icon name="share" size={16} />
      共有
    </button>
  );

  return (
    <>
      <div className="result-grid">
        <div className="result-main">
          {diagnostics.length > 0 ? (
            <DiagnosticsPanel
              diagnostics={diagnostics}
              games={diagnosticGames}
              players={diagnosticPlayers}
              keptPrevious
            />
          ) : null}
          <OrderStateBanner
            lifecycle={lifecycle}
            latestVersion={latest?.version ?? 0}
            nextVersion={nextVersion}
            seasonStatus={seasonStatus}
            changeCount={pendingDiff?.changes.length ?? 0}
            onShowDiff={() => setDiffOpen(true)}
          />

          {state.candidates.length > 1 ? (
            <CandidateGrid
              candidates={state.candidates}
              selected={state.edited ? -1 : state.selectedCandidate}
              onSelect={(index) => dispatch({ type: 'selectCandidate', index })}
              showPredictions={showPredictions}
            />
          ) : null}

          {showPredictions ? <OpponentPanel solution={solution} candidates={state.candidates} games={ordered} /> : null}

          <StrengthBasis solution={solution} />

          {state.edited ? (
            <div className="notice info">
              <Icon name="edit" size={18} />
              <span>手動編集中です。数値は編集内容で再計算されています。</span>
            </div>
          ) : null}

          {hasViolations ? (
            <div className="notice danger" role="alert">
              <Icon name="alert" size={18} />
              <span>
                <strong>絶対条件に違反しています</strong>
                <ul>
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
              <Icon name={warning.severity === 'warning' ? 'alert' : 'info'} size={18} />
              <span className="small-text">{warning.message}</span>
            </div>
          ))}

          <SectionHeader
            kicker="ORDER"
            title="オーダー"
            action={lifecycle === 'FINALIZED' ? null : shareButton}
          />
          <div className="order-list">
            {ordered.map((game) => {
              const assignment = solution.assignments.find((entry) => entry.gameId === game.id);
              if (!assignment) return null;
              const gameLocked = assignment.playerIds.every((_, slot) => locks.has(lockKey(game.id, slot)));
              const base = baselineByGame.get(game.id);
              return (
                <GameCard
                  key={game.id}
                  game={game}
                  playerIds={assignment.playerIds}
                  players={players}
                  playerById={playerById}
                  isLocked={(slot) => locks.has(lockKey(game.id, slot))}
                  prediction={showPredictions ? solution.prediction?.games.find((entry) => entry.gameId === game.id) : undefined}
                  isEdited={(slot, playerId) => base !== undefined && base[slot] !== playerId}
                  gameLocked={gameLocked}
                  violating={violatingGames.has(game.id)}
                  generating={generating}
                  dispatch={dispatch}
                  onReoptimise={onReoptimise}
                />
              );
            })}
          </div>
        </div>

        <div className="result-side">
          <SectionHeader kicker="APPEARANCES" title="出場回数" />
          <AppearanceSummary solution={solution} nameById={nameById} />

          <SectionHeader kicker="SEASON" title="シーズン累計" />
          <Card>
            <div className="row wrap" style={{ marginBottom: 12 }}>
              <SeasonBadge status={seasonStatus} />
            </div>
            <div className="tool-row">
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
                <Icon name="season" size={16} />
                {seasonStatus === 'none' ? 'シーズン累計へ反映' : 'シーズン累計を再反映'}
              </button>
              {seasonStatus !== 'none' ? (
                <button type="button" className="btn small danger" onClick={() => setConfirmWithdraw(true)}>
                  反映を取り消す
                </button>
              ) : null}
            </div>
            <p className="tiny muted" style={{ marginBottom: 0 }}>
              {lifecycle === 'FINALIZED'
                ? '何度反映しても二重加算されません (差分だけが適用されます)。'
                : '確定するとシーズン累計へ反映できます。'}
            </p>
          </Card>

          <SectionHeader kicker="TOOLS" title="操作" />
          <Card>
            <div className="tool-row">
              <button type="button" className="btn small" onClick={onSaveDraft}>
                <Icon name="save" size={16} />
                {lifecycle === 'DRAFT' ? '下書きを保存' : '変更を保存 (未確定)'}
              </button>
              <button
                type="button"
                className="btn small"
                onClick={() => dispatch({ type: 'clearLocks' })}
                disabled={state.input.locks.length === 0}
              >
                <Icon name="unlock" size={16} />
                ロック全解除 ({state.input.locks.length})
              </button>
              <button
                type="button"
                className="btn small"
                disabled={generating}
                onClick={() => onReoptimise(null)}
              >
                <Icon name="refresh" size={16} />
                ロックを保ったまま再最適化
              </button>
            </div>
          </Card>

          <StrengthBasisPanel
            basis={state.input.strengthBasis}
            players={players}
            includedIds={new Set(solution.tallies.map((tally) => tally.playerId))}
          />
          <AnalysisPanel solution={solution} ordered={ordered} nameById={nameById} />
        </div>
      </div>

      <div className="action-bar" data-state={lifecycle}>
        {lifecycle === 'UPDATED' ? (
          <button
            type="button"
            className="btn icon"
            onClick={() => setDiffOpen(true)}
            aria-label="変更点を確認"
            title="変更点を確認"
          >
            <Icon name="diff" />
          </button>
        ) : null}
        <button
          type="button"
          className="btn icon"
          onClick={() => dispatch({ type: 'undo' })}
          disabled={!canUndo(session)}
          aria-label="元に戻す"
          title="元に戻す"
        >
          <Icon name="undo" />
        </button>
        <button
          type="button"
          className="btn icon"
          onClick={() => dispatch({ type: 'redo' })}
          disabled={!canRedo(session)}
          aria-label="やり直す"
          title="やり直す"
        >
          <Icon name="redo" />
        </button>
        {lifecycle !== 'UPDATED' ? (
          <button
            type="button"
            className="btn icon"
            disabled={generating}
            onClick={onRegenerate}
            aria-label="再生成"
            title="条件はそのままで候補を作り直す"
          >
            {generating ? <span className="spinner" aria-hidden="true" /> : <Icon name="refresh" />}
          </button>
        ) : null}

        {lifecycle === 'FINALIZED' ? (
          <button type="button" className="btn primary" onClick={() => setShareOpen(true)}>
            <Icon name="share" />
            <span className="btn-label">共有</span>
          </button>
        ) : (
          <button type="button" className="btn primary" onClick={onFinalize} disabled={hasViolations}>
            <Icon name="check" strokeWidth={2.8} />
            <span className="btn-label">
              {lifecycle === 'DRAFT' ? 'オーダーを確定' : '再確定'} v{nextVersion}
            </span>
          </button>
        )}
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
          onFinalize={lifecycle === 'FINALIZED' || hasViolations ? undefined : onFinalize}
          nextVersion={nextVersion}
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

// ---------------------------------------------------------------------------
// Lifecycle banner
// ---------------------------------------------------------------------------

function OrderStateBanner({
  lifecycle,
  latestVersion: latest,
  nextVersion,
  seasonStatus,
  changeCount,
  onShowDiff,
}: {
  lifecycle: OrderLifecycleState;
  latestVersion: number;
  nextVersion: number;
  seasonStatus: SeasonCommitStatus;
  changeCount: number;
  onShowDiff: () => void;
}): React.JSX.Element {
  const meta = STATE_META[lifecycle];
  const content =
    lifecycle === 'DRAFT'
      ? {
          tag: 'DRAFT',
          title: '未確定',
          note: `確定すると ORDER v${nextVersion} として共有できます。`,
        }
      : lifecycle === 'FINALIZED'
        ? {
            tag: 'FINALIZED',
            title: `確定済み · ORDER v${latest}`,
            note: 'この内容でチームへ共有できます。',
          }
        : {
            tag: 'UPDATE REQUIRED',
            title: `再確定が必要 · v${latest}から${changeCount > 0 ? `${changeCount}ゲーム変更` : '内容を変更'}`,
            note: `共有する前に v${nextVersion} として再確定してください。`,
          };

  return (
    <section className={`state-banner tone-${meta.tone}`} aria-label="オーダーの状態">
      <span className="state-icon" aria-hidden="true">
        <Icon name={meta.icon} size={24} />
      </span>
      <span className="state-text">
        <span className="state-tag">{content.tag}</span>
        <span className="state-title">{content.title}</span>
        <span className="state-note">{content.note}</span>
        {lifecycle !== 'DRAFT' ? <SeasonBadge status={seasonStatus} /> : null}
      </span>
      {lifecycle === 'UPDATED' ? (
        <button type="button" className="btn small" onClick={onShowDiff}>
          変更点
        </button>
      ) : null}
    </section>
  );
}

function SeasonBadge({ status }: { status: SeasonCommitStatus }): React.JSX.Element {
  if (status === 'current') {
    return (
      <StatusBadge tone="season" icon="season">
        {SEASON_STATUS_LABELS.current}
      </StatusBadge>
    );
  }
  if (status === 'outdated') {
    return (
      <StatusBadge tone="updated" icon="alert">
        {SEASON_STATUS_LABELS.outdated}
      </StatusBadge>
    );
  }
  return (
    <StatusBadge tone="neutral" icon="season">
      {SEASON_STATUS_LABELS.none}
    </StatusBadge>
  );
}

// ---------------------------------------------------------------------------
// Candidates
// ---------------------------------------------------------------------------

function CandidateGrid({
  candidates,
  selected,
  onSelect,
  showPredictions,
}: {
  candidates: OrderSolution[];
  /** -1 while the order has been edited by hand (no candidate matches it). */
  selected: number;
  onSelect: (index: number) => void;
  showPredictions: boolean;
}): React.JSX.Element {
  return (
    <div className={`candidate-grid count-${candidates.length}`} role="group" aria-label="候補の比較">
      {candidates.map((candidate, index) => {
        const letter = String.fromCharCode(65 + index);
        return (
          <button
            type="button"
            key={`${candidate.meta.label}-${index}`}
            className="candidate-tab"
            aria-pressed={selected === index}
            aria-label={`候補 ${letter}: ${candidate.meta.label} (総合 ${candidate.score.display}${
              showPredictions && candidate.prediction ? `、推定勝率 ${formatProbability(candidate.prediction.win)}` : ''
            })${
              candidate.meta.alternativeTo ? ` ${candidate.meta.alternativeTo}と同じ最適解のため次点` : ''
            }`}
            onClick={() => onSelect(index)}
          >
            <span className="c-head">
              <span className="c-letter">{letter}</span>
              <span className="c-label">{candidate.meta.label}</span>
            </span>
            <span className="c-score">
              <small>SCORE</small>
              {candidate.score.display}
            </span>
            <dl>
              {showPredictions && candidate.prediction ? (
                <>
                  <dt>推定勝率</dt>
                  <dd>
                    {formatProbability(candidate.prediction.win)}
                    <span className="c-conf"> ({CONFIDENCE_LABELS[candidate.prediction.confidence]})</span>
                  </dd>
                  <dt>期待勝数</dt>
                  <dd>{candidate.prediction.expectedGames.toFixed(1)}</dd>
                </>
              ) : null}
              <dt>出場差</dt>
              <dd>{candidate.metrics.appearanceSpread}</dd>
              {candidate.metrics.maxRoleConcentration !== undefined ? (
                <>
                  <dt title="同じ役割 (Singles 等) を 1 人が担う最多回数">役割最多</dt>
                  <dd>{candidate.metrics.maxRoleConcentration}</dd>
                </>
              ) : null}
              <dt>連続</dt>
              <dd>{candidate.metrics.maxConsecutive}</dd>
              <dt>平均</dt>
              <dd>{formatRating(candidate.metrics.averageRating)}</dd>
            </dl>
            {candidate.meta.alternativeTo ? (
              <span className="c-note">{candidate.meta.alternativeTo}と同じ最適解のため次点</span>
            ) : null}
            <span className="c-current">
              <Icon name="check" size={13} strokeWidth={3} />
              選択中
            </span>
          </button>
        );
      })}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Strength basis
// ---------------------------------------------------------------------------

/**
 * "戦力評価 Rating 70% / PPR 30%": what "strong" meant for this order. Hidden for orders
 * saved before the blend was recorded, rather than guessing what it was.
 */
function StrengthBasis({ solution }: { solution: OrderSolution }): React.JSX.Element | null {
  const weights = solution.metrics.strengthWeights;
  const discipline = solution.metrics.discipline;
  if (!weights || !discipline) return null;
  const blend = describeStrengthWeights(weights);
  return (
    <div className="strength-basis" data-testid="result-strength-basis">
      <DisciplineBadge discipline={discipline} />
      <span className="grow">
        <span className="basis-title">{blend ? `戦力評価 ${blend}` : '戦力評価なし'}</span>
        <span className="basis-note">
          {blend
            ? 'Rating と PPR をそれぞれ参加者内で 0〜1 に正規化してから合成しています。'
            : 'Rating・PPR に差が無いため、適性と公平性で生成しています。'}
        </span>
      </span>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Game card
// ---------------------------------------------------------------------------

/** Kinds shown as tags, in reading order: structure first, then the game. */
const TAG_ORDER: GameKind[] = ['SINGLES', 'DOUBLES', 'TRIOS', 'TEAM', 'G501', 'CRICKET', 'GALLON', 'CUSTOM'];

function GameCard({
  game,
  playerIds,
  players,
  playerById,
  prediction,
  isLocked,
  isEdited,
  gameLocked,
  violating,
  generating,
  dispatch,
  onReoptimise,
}: {
  game: GameSlotDef;
  playerIds: readonly string[];
  players: Player[];
  playerById: Map<string, Player>;
  /** 推定ゲーム勝率 for this game, when the order has opponent data. */
  prediction?: GamePrediction;
  isLocked: (slot: number) => boolean;
  isEdited: (slot: number, playerId: string) => boolean;
  gameLocked: boolean;
  violating: boolean;
  generating: boolean;
  dispatch: (action: UndoableAction) => void;
  onReoptimise: (keepGameId: string | null) => void;
}): React.JSX.Element {
  const number = String(game.order).padStart(2, '0');
  const tags = TAG_ORDER.filter((kind) => game.kinds.includes(kind));
  const classes = ['order-game', violating ? 'violating' : '', gameLocked ? 'all-locked' : '']
    .filter(Boolean)
    .join(' ');

  return (
    <article className={classes} aria-label={`Game ${game.order} ${game.name}`}>
      <div className="order-game-head">
        <span className="no" aria-hidden="true">
          <small>GAME</small>
          <b>{number}</b>
        </span>
        <span className="head-text">
          {/* Wrapped, never truncated: "Doubles 501" and "Doubles Cricket" must stay
              distinguishable at phone width. */}
          <span className="name">{game.name}</span>
          <span className="tags">
            {tags.map((kind) => (
              <span className="tag" key={kind}>
                {GAME_KIND_LABELS[kind]}
              </span>
            ))}
            <span className="tag count">{game.playerCount}名</span>
            {prediction ? (
              <span className="tag predict" title={prediction.reasons.join(' ・ ')}>
                推定 {formatProbability(prediction.probability)} ・ {CONFIDENCE_LABELS[prediction.confidence]}
              </span>
            ) : null}
          </span>
        </span>
        <span className="head-actions">
          <button
            type="button"
            className="btn icon small"
            onClick={() => dispatch({ type: 'lockGame', gameId: game.id, locked: !gameLocked })}
            aria-pressed={gameLocked}
            aria-label={`Game ${game.order} ${game.name} を全固定`}
            title={gameLocked ? 'このゲームの固定を解除' : 'このゲームを全員固定'}
          >
            <Icon name={gameLocked ? 'lock' : 'unlock'} size={18} />
          </button>
          <button
            type="button"
            className="btn icon small"
            disabled={generating}
            onClick={() => onReoptimise(game.id)}
            aria-label={`Game ${game.order} ${game.name} だけ再計算`}
            title="このゲームだけ再計算 (他のゲームは固定)"
          >
            <Icon name="refresh" size={18} />
          </button>
        </span>
      </div>

      <div className="slots">
        {playerIds.map((playerId, slotIndex) => {
          const locked = isLocked(slotIndex);
          const edited = isEdited(slotIndex, playerId);
          const player = playerId ? playerById.get(playerId) : undefined;
          const classes = [
            'slot',
            locked ? 'locked' : '',
            edited ? 'edited' : '',
            playerId ? '' : 'empty',
          ]
            .filter(Boolean)
            .join(' ');
          return (
            <div className={classes} key={slotIndex}>
              <div className="slot-field">
                <span className="slot-top" aria-hidden="true">
                  <span>{game.playerCount > 1 ? `PLAYER ${slotIndex + 1}` : 'PLAYER'}</span>
                  {locked ? (
                    <span className="slot-flag locked">
                      <Icon name="lock" size={12} strokeWidth={2.6} />
                      LOCKED
                    </span>
                  ) : null}
                  {edited ? (
                    <span className="slot-flag edited">
                      <Icon name="edit" size={12} strokeWidth={2.6} />
                      EDITED
                    </span>
                  ) : null}
                </span>
                <span className="slot-main" aria-hidden="true">
                  <span className="slot-name">{player ? player.name : '空席'}</span>
                  {player ? (
                    <span className={player.rating === null ? 'rt unknown' : 'rt'}>
                      {formatRating(player.rating)}
                    </span>
                  ) : null}
                </span>
                {locked ? null : <Icon name="chevronDown" size={16} className="slot-caret" />}
                <select
                  value={playerId}
                  disabled={locked}
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
                  {players.map((option) => (
                    <option key={option.id} value={option.id}>
                      {option.name} ({formatRating(option.rating)})
                    </option>
                  ))}
                </select>
              </div>
              <button
                type="button"
                className="lock-toggle"
                aria-pressed={locked}
                aria-label={`Game ${game.order} ${game.name} スロット ${slotIndex + 1} のロック`}
                title={locked ? 'ロック中 (タップで解除)' : 'この選手で固定'}
                onClick={() => dispatch({ type: 'toggleLock', gameId: game.id, slotIndex })}
              >
                <Icon name={locked ? 'lock' : 'unlock'} size={19} />
              </button>
            </div>
          );
        })}
      </div>

    </article>
  );
}

// ---------------------------------------------------------------------------
// Appearance summary
// ---------------------------------------------------------------------------

function AppearanceSummary({
  solution,
  nameById,
}: {
  solution: OrderSolution;
  nameById: Map<string, string>;
}): React.JSX.Element {
  const rows = [...solution.tallies].sort(
    (a, b) =>
      b.count - a.count ||
      (nameById.get(a.playerId) ?? '').localeCompare(nameById.get(b.playerId) ?? '', 'ja'),
  );
  const pipCount = Math.min(8, Math.max(1, ...rows.map((row) => row.count)));

  return (
    <Card>
      <div className="metrics" style={{ marginBottom: 12 }}>
        <Metric
          label="最大出場差"
          value={solution.metrics.appearanceSpread}
          tone={solution.metrics.appearanceSpread <= 1 ? 'ok' : 'warn'}
        />
        <Metric label="最大連続" value={solution.metrics.maxConsecutive} />
        <Metric label="平均 Rt." value={solution.metrics.averageRating ?? '—'} />
        {solution.metrics.strengthWeights && solution.metrics.strengthWeights.ppr > 0 ? (
          <Metric label="平均 PPR" value={solution.metrics.averagePpr ?? '—'} />
        ) : null}
        <Metric label="総枠" value={solution.metrics.totalSlots} />
      </div>
      <ul className="tally-list" aria-label="選手ごとの出場回数">
        {rows.map((tally) => (
          <li key={tally.playerId} className={tally.count === 0 ? 'tally-row zero' : 'tally-row'}>
            <span>
              <span className="t-name">{nameById.get(tally.playerId) ?? tally.playerId}</span>
              <span className="t-sub">
                {formatRating(tally.effectiveRating)}
                {tally.ratingImputed ? '*' : ''}
                {tally.effectivePpr !== undefined && tally.effectivePpr !== null
                  ? ` · ${formatPpr(tally.effectivePpr)}${tally.pprImputed ? '*' : ''}`
                  : ''}{' '}
                ・ シーズン {tally.seasonTotal}
              </span>
            </span>
            <span className="pips" aria-hidden="true">
              {Array.from({ length: pipCount }, (_, index) => (
                <i key={index} className={index < tally.count ? 'on' : undefined} />
              ))}
            </span>
            <span className="t-count">
              <b>{tally.count}</b>
              <small>GAMES</small>
            </span>
          </li>
        ))}
      </ul>
      {solution.metrics.hasImputedRating || solution.tallies.some((tally) => tally.pprImputed) ? (
        <p className="tiny muted" style={{ marginBottom: 0 }}>
          * 未入力のため、0 ではなく参加者の中央値を暫定値として評価しています。
        </p>
      ) : null}
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Analysis (collapsed)
// ---------------------------------------------------------------------------

function ToneMark({ tone }: { tone: 'positive' | 'negative' | 'neutral' }): React.JSX.Element {
  return (
    <span className={`tone ${tone}`} aria-hidden="true">
      {tone === 'positive' ? '●' : tone === 'negative' ? '▲' : '○'}
    </span>
  );
}

function AnalysisPanel({
  solution,
  ordered,
  nameById,
}: {
  solution: OrderSolution;
  ordered: GameSlotDef[];
  nameById: Map<string, string>;
}): React.JSX.Element {
  return (
    <details className="disclosure analysis">
      <summary>
        <Icon name="info" />
        <span className="grow">
          <span className="summary-title">詳細分析</span>
          <span className="summary-note">評価の内訳・生成理由・技術情報 ・ 総合評価 {solution.score.display}</span>
        </span>
        <Icon name="chevronDown" className="chev" />
      </summary>
      <div className="disclosure-body">
        <h3 className="sub-head">評価の内訳</h3>
        <div className="metrics" style={{ marginBottom: 12 }}>
          <Metric label="総合評価" value={solution.score.display} />
          <Metric label="標準偏差" value={solution.metrics.appearanceStdDev} />
        </div>
        {(
          [
            ['戦力 (Rating / PPR)', solution.score.strength],
            ['ゲーム適性', solution.score.gameFit],
            ['ペア相性', solution.score.pairFit],
            ['出場回数の公平性', solution.score.fairness],
            ['役割の分散 (Singles 等)', solution.score.roleFairness],
          ] as [string, number | undefined][]
        )
          // Orders saved before role fairness existed have no value for it: skip, not 0.
          .filter((entry): entry is [string, number] => entry[1] !== undefined)
          .map(([label, value]) => (
          <div key={label} className="score-line">
            <div className="row between">
              <span className="secondary">{label}</span>
              <span className="num">{Math.round(value * 100)}%</span>
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
          <div key={label} className="score-line">
            <div className="row between">
              <span className="secondary">{label} (低いほど良い)</span>
              <span className="num">{Math.round(value * 100)}%</span>
            </div>
            <Bar value={value} tone="muted" />
          </div>
        ))}

        <h3 className="sub-head">生成理由</h3>
        <ul className="reason-list" style={{ padding: 0 }}>
          {solution.explanation.overall.map((factor, index) => (
            <li key={index}>
              <ToneMark tone={factor.tone} />
              <span>
                <span className="k">{factor.label}: </span>
                {factor.detail}
              </span>
            </li>
          ))}
        </ul>

        <h3 className="sub-head">ゲーム別の理由</h3>
        {solution.explanation.games.map((explanation) => {
          const game = ordered.find((entry) => entry.id === explanation.gameId);
          return (
            <details className="reason-game" key={explanation.gameId}>
              <summary>
                <span className="badge">{String(game?.order ?? 0).padStart(2, '0')}</span>
                <span className="grow">{game?.name}</span>
                <span className="players">
                  {explanation.playerIds.map((id) => nameById.get(id) ?? id).join(' / ')}
                </span>
              </summary>
              <ul className="reason-list">
                {explanation.factors.map((factor, index) => (
                  <li key={index}>
                    <ToneMark tone={factor.tone} />
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

        <h3 className="sub-head">技術情報</h3>
        <dl className="tech-meta">
          <dt>探索方式</dt>
          <dd>{solution.meta.stage}</dd>
          <dt>探索ノード</dt>
          <dd>{solution.meta.nodesVisited.toLocaleString()}</dd>
          <dt>所要時間</dt>
          <dd>{solution.meta.elapsedMs} ms</dd>
          <dt>結果</dt>
          <dd>{solution.meta.exhaustive ? '全探索完了 (この候補集合での最適)' : '時間内の最良解'}</dd>
        </dl>
      </div>
    </details>
  );
}

// ---------------------------------------------------------------------------
// Diagnostics
// ---------------------------------------------------------------------------

function DiagnosticsPanel({
  diagnostics,
  games,
  players,
  keptPrevious = false,
}: {
  diagnostics: Diagnostic[];
  games: GameSlotDef[];
  players: Player[];
  /** True when the previous order is still shown below. */
  keptPrevious?: boolean;
}): React.JSX.Element {
  const nameById = new Map(players.map((player) => [player.id, player.name]));
  const gameById = new Map(games.map((game) => [game.id, game]));

  return (
    <>
      <section className="state-banner tone-danger" aria-label="生成結果">
        <span className="state-icon" aria-hidden="true">
          <Icon name="alert" size={24} />
        </span>
        <span className="state-text">
          <span className="state-tag">NO SOLUTION</span>
          <span className="state-title">オーダーを生成できませんでした</span>
          <span className="state-note">絶対条件を自動的に破ることはしません。以下の競合を解消してください。</span>
        </span>
      </section>

      {diagnostics.map((diagnostic, index) => (
        <Card key={index} className="diag-card">
          <p className="small-text" style={{ marginTop: 0, fontWeight: 700 }}>
            {diagnostic.gameId ? (
              <span className="badge" style={{ marginRight: 6 }}>
                Game {gameById.get(diagnostic.gameId)?.order ?? '?'}
              </span>
            ) : null}
            {diagnostic.message}
          </p>
          {diagnostic.suggestions.length > 0 ? (
            <>
              <span className="kicker">解決の候補</span>
              <ul style={{ margin: '4px 0 0', paddingLeft: 18 }}>
                {diagnostic.suggestions.map((suggestion, suggestionIndex) => (
                  <li key={suggestionIndex} className="small-text secondary">
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

      <p className="tiny muted" style={{ padding: '0 4px 8px' }}>
        戻る (‹) で条件を調整してから、もう一度生成してください。
        {keptPrevious ? ' 下には直前のオーダーをそのまま表示しています。' : ''}
      </p>
    </>
  );
}
