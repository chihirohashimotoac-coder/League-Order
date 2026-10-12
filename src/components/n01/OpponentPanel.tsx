import { useMemo } from 'react';
import type { GameSlotDef, OrderInput, OrderSolution } from '../../domain/types';
import { singlesAceNote } from '../../optimizer/aceMatchup';
import { CONFIDENCE_LABELS } from '../../domain/prediction/confidence';
import { INDEPENDENCE_NOTE, formatProbability } from '../../domain/prediction/predictOrder';
import { StatusBadge } from '../ui';
import { Icon } from '../icons';

/**
 * Opponent analysis on the result screen (MASTER SPEC Phase 4 §7, §10).
 *
 * The estimated match win probability of the order shown, compared with the ordinary
 * 勝利優先 candidate when that is on screen, the games that make the difference, and the
 * confidence. Worded as an estimate throughout; nothing here promises a result.
 */
export function OpponentPanel({
  solution,
  candidates,
  games,
  input,
}: {
  solution: OrderSolution;
  candidates: readonly OrderSolution[];
  games: readonly GameSlotDef[];
  /** The order's input: needed to explain how the opponent's ace is received (Singles). */
  input?: OrderInput;
}): React.JSX.Element | null {
  const ace = useMemo(() => (input ? singlesAceNote(input, solution) : null), [input, solution]);
  const prediction = solution.prediction;
  if (!prediction) return null;
  const winFirst =
    solution.meta.presetKey === 'OPPONENT_OPTIMIZED'
      ? candidates.find((candidate) => candidate.meta.presetKey === 'WIN_FIRST' && candidate.prediction)
      : undefined;
  const baseline = winFirst?.prediction;
  const gameById = new Map(games.map((game) => [game.id, game]));
  const baselineByGame = new Map(baseline?.games.map((game) => [game.gameId, game.probability]));

  const reasons = prediction.games
    .map((game) => ({
      game,
      gain: baselineByGame.has(game.gameId) ? game.probability - (baselineByGame.get(game.gameId) ?? 0) : 0,
    }))
    .filter(({ gain }) => (baseline ? gain >= 0.03 : true))
    .sort((a, b) => (baseline ? b.gain - a.gain : b.game.probability - a.game.probability))
    .slice(0, 3)
    .map(({ game }) => {
      const def = gameById.get(game.gameId);
      const label = def ? `G${String(def.order).padStart(2, '0')} ${def.name}` : game.gameId;
      const before = baselineByGame.get(game.gameId);
      const likely = game.reasons.find((reason) => reason.startsWith('相手の予想'));
      return `${label}: 推定 ${before !== undefined && baseline ? `${formatProbability(before)}→` : ''}${formatProbability(game.probability)}${likely ? ` (${likely})` : ''}`;
    });

  const delta = baseline ? Math.round((prediction.win - baseline.win) * 100) : null;
  const tone = prediction.confidence === 'HIGH' ? 'finalized' : prediction.confidence === 'MEDIUM' ? 'accent' : 'draft';

  return (
    <section className="opponent-panel" aria-label="対戦相手の分析" data-testid="opponent-panel">
      <div className="opponent-head">
        <span className="kicker">VS</span>
        <strong className="opponent-name">{prediction.opponentName}</strong>
        <StatusBadge tone={tone} icon={prediction.confidence === 'LOW' ? 'alert' : 'info'}>
          信頼度 {CONFIDENCE_LABELS[prediction.confidence]}
          {prediction.confidence === 'LOW' ? ' (参考値)' : ''}
        </StatusBadge>
      </div>
      <div className="opponent-figures">
        <div>
          <span className="k">推定 Match 勝率</span>
          <span className="v" data-testid="estimated-match-win">{formatProbability(prediction.win)}</span>
        </div>
        <div>
          <span className="k">期待勝ちゲーム</span>
          <span className="v">
            {prediction.expectedGames.toFixed(1)}
            <small> / {prediction.gameCount}</small>
          </span>
        </div>
        {baseline && delta !== null ? (
          <div>
            <span className="k">通常の勝利優先</span>
            <span className="v">
              {formatProbability(baseline.win)}
              <small className={delta >= 0 ? 'delta up' : 'delta down'}> {delta >= 0 ? '+' : ''}{delta}pt</small>
            </span>
          </div>
        ) : null}
      </div>
      {delta !== null && delta < 0 ? (
        <p className="small-text opponent-tradeoff" data-testid="opponent-tradeoff">
          出場バランス (公平性) を保つため、勝利優先より推定 Match 勝率が {-delta}pt 低い案です。
          推定勝率を優先する場合は「勝利優先」の案を選べます。
        </p>
      ) : null}
      {ace && input ? <AceNoteText note={ace} input={input} games={games} /> : null}
      {reasons.length > 0 ? (
        <>
          <p className="opponent-sub">主な理由</p>
          <ul className="opponent-reasons">
            {reasons.map((reason) => (
              <li key={reason}>{reason}</li>
            ))}
          </ul>
        </>
      ) : null}
      <p className="tiny muted opponent-note">
        <Icon name="info" size={14} /> 推定値であり、結果を保証するものではありません。{INDEPENDENCE_NOTE}
      </p>
    </section>
  );
}

function AceNoteText({
  note,
  input,
  games,
}: {
  note: NonNullable<ReturnType<typeof singlesAceNote>>;
  input: OrderInput;
  games: readonly GameSlotDef[];
}): React.JSX.Element {
  const name = (id: string): string => input.players.find((player) => player.id === id)?.name ?? id;
  const label = (gameId: string): string => {
    const game = games.find((entry) => entry.id === gameId);
    return game ? `G${String(game.order).padStart(2, '0')} ${game.name}` : gameId;
  };
  const versus =
    note.swapped === null
      ? '入れ替えた案は出場条件を満たさないため比較していません'
      : `エースを相手エース枠に当てた場合の推定 Match 勝率 ${formatProbability(note.swapped)} / この案 ${formatProbability(note.current)}`;
  return (
    <p className="small-text opponent-ace" data-testid="opponent-ace">
      相手エース枠 {label(note.aceGameId)} (相手予想 {note.aceStrength.toFixed(1)}{note.aceLikely ? `・${note.aceLikely}` : ''}) は {name(note.receiver)} が受け、
      自軍エース {name(note.ourAce)} は {label(note.ourAceGameId)} へ。エース同士を当てる固定ルールは使わず、Match 全体の推定勝率で配置しています ({versus})。
    </p>
  );
}
