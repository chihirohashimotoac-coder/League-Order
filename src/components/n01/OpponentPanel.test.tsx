import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import type { GameSlotDef, OrderSolution } from '../../domain/types';
import type { MatchPrediction } from '../../domain/prediction/predictOrder';
import { OpponentPanel } from './OpponentPanel';

/** Only the fields the panel reads; the rest of a solution does not matter here. */
function solution(presetKey: 'OPPONENT_OPTIMIZED' | 'WIN_FIRST', win: number, confidence: MatchPrediction['confidence']): OrderSolution {
  const prediction: MatchPrediction = {
    win,
    draw: 0,
    loss: 1 - win,
    expectedGames: 3.5,
    need: 4,
    gameCount: 7,
    confidence,
    model: 'independent',
    opponentName: 'スピンコブラ',
    games: [{ gameId: 'g1', probability: win, confidence, samples: 3, ourStrength: 55, opponentStrength: 53, reasons: ['相手の予想: 山本 剛 60%'] }],
  };
  return { meta: { presetKey }, prediction } as unknown as OrderSolution;
}

const games: GameSlotDef[] = [{ id: 'g1', order: 1, name: 'Singles 501', kinds: ['G501'], playerCount: 1 }];

describe('opponent panel wording (Phase 6 §3, prediction language policy)', () => {
  afterEach(cleanup);

  it('shows the gain over 勝利優先 as an estimate', () => {
    const optimized = solution('OPPONENT_OPTIMIZED', 0.62, 'MEDIUM');
    render(<OpponentPanel solution={optimized} candidates={[optimized, solution('WIN_FIRST', 0.58, 'MEDIUM')]} games={games} />);
    const panel = screen.getByTestId('opponent-panel');
    expect(panel).toHaveTextContent('推定 Match 勝率');
    expect(panel).toHaveTextContent('+4pt');
    expect(panel).toHaveTextContent('推定値であり、結果を保証するものではありません');
    expect(screen.queryByTestId('opponent-tradeoff')).toBeNull();
    expect(panel.textContent).not.toMatch(/絶対勝|確実|必勝/);
  });

  it('says why when the balanced order is estimated below 勝利優先, and where to find that order', () => {
    const optimized = solution('OPPONENT_OPTIMIZED', 0.568, 'MEDIUM');
    render(<OpponentPanel solution={optimized} candidates={[optimized, solution('WIN_FIRST', 0.605, 'MEDIUM')]} games={games} />);
    expect(screen.getByTestId('opponent-panel')).toHaveTextContent('-4pt');
    expect(screen.getByTestId('opponent-tradeoff')).toHaveTextContent('出場バランス (公平性) を保つため、勝利優先より推定 Match 勝率が 4pt 低い案です');
  });

  it('calls a low-confidence estimate 参考値', () => {
    const optimized = solution('OPPONENT_OPTIMIZED', 0.51, 'LOW');
    render(<OpponentPanel solution={optimized} candidates={[optimized]} games={games} />);
    expect(screen.getByTestId('opponent-panel')).toHaveTextContent('信頼度 低 (参考値)');
  });
});
