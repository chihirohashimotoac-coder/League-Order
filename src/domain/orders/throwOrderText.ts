import type { PlayerId, ThrowOrderRecord } from '../types';
import { CONFIDENCE_LABELS } from '../prediction/confidence';
import { ROLE_SOURCE_LABELS } from '../prediction/roleStrength';
import { ORDER_FALLBACK_LABELS } from '../prediction/throwOrder';

/**
 * Words for a throw-order decision (docs/THROW_ORDER_MODEL.md §7). One wording, read by the
 * reasons of the solution and by the result screen, so the two never disagree. Estimates are
 * called 推定; nothing is promised.
 */

/** "1投目" … for a slot of a multi-player game (0-based slot). */
export function throwSlotLabel(slotIndex: number): string {
  return `${slotIndex + 1}投目`;
}

const pt = (value: number): string => `${value >= 0 ? '+' : '−'}${Math.abs(value * 100).toFixed(1)}pt`;
const percent = (value: number): string => `${Math.round(value * 100)}%`;

export interface ThrowOrderText {
  /** Short line under the game ("投順: 強い順"). */
  summary: string;
  /** The full reason. */
  detail: string;
  /** True when the order shown is not the strong order (the screen highlights it). */
  deviates: boolean;
}

function sequence(ids: readonly PlayerId[], nameOf: (id: PlayerId) => string): string {
  return ids.map(nameOf).join(' → ');
}

function basisText(record: ThrowOrderRecord, nameOf: (id: PlayerId) => string): string {
  const unit = record.blendScale ? '' : ' (PPR換算)';
  return record.basis
    .map((member) => {
      const role = Math.abs(member.roleDelta) >= 0.05 ? `、役割補正 ${member.roleDelta >= 0 ? '+' : '−'}${Math.abs(member.roleDelta).toFixed(1)}` : '';
      const games = member.source === 'n01-role' && member.games > 0 ? ` ${member.games}試合` : '';
      return `${nameOf(member.playerId)} ${member.strength.toFixed(1)}${role} [${ROLE_SOURCE_LABELS[member.source]}${games}・信頼度 ${CONFIDENCE_LABELS[member.confidence]}]`;
    })
    .join(' / ')
    .concat(unit);
}

export function describeThrowOrder(record: ThrowOrderRecord, nameOf: (id: PlayerId) => string): ThrowOrderText {
  const strong = sequence(record.strongOrder, nameOf);
  const shown = sequence(record.order, nameOf);
  const basis = basisText(record, nameOf);
  const confidence = record.confidence ? `信頼度 ${CONFIDENCE_LABELS[record.confidence]}${record.confidence === 'LOW' ? ' (参考値)' : ''}` : null;

  if (record.adopted === 'model' && record.probability !== null && record.strongProbability !== null) {
    const gain = record.probability - record.strongProbability;
    return {
      summary: `投順: 推定勝率で選択 (強い順より ${pt(gain)})`,
      detail: [
        `通常 (強い順) なら ${strong}。`,
        `${shown} の方が推定ゲーム勝率が ${pt(gain)} 高い (${percent(record.strongProbability)} → ${percent(record.probability)}) ため採用しました。`,
        confidence ? `${confidence}。` : '',
        record.opponentTendency ? `利用した相手の傾向: ${record.opponentTendency}。` : '',
        '01 は投順で投げる回数とフィニッシュの機会が変わります (各選手のフィニッシュ推定を使用)。推定値であり、結果を保証するものではありません。',
        `役割別強度: ${basis}`,
      ]
        .filter(Boolean)
        .join(''),
      deviates: true,
    };
  }

  if (record.adopted === 'manual') {
    const toStrong = record.order.length === record.strongOrder.length && record.order.every((id, index) => id === record.strongOrder[index]);
    if (toStrong) {
      // Set back to the strong order by hand, where the estimate had chosen another order.
      const chosen =
        record.fallback === null && record.bestGain !== null && record.bestGain > 0
          ? `推定では別の投順が強い順より ${pt(record.bestGain)} 高い見込みでした。`
          : '';
      return {
        summary: '投順: 手動で強い順に変更',
        detail: `手動で強い順 (${strong}) にしています。${chosen}役割別強度: ${basis}`,
        deviates: true,
      };
    }
    const gain =
      record.probability !== null && record.strongProbability !== null ? `推定ゲーム勝率は強い順と比べて ${pt(record.probability - record.strongProbability)}。` : '';
    return {
      summary: '投順: 手動で変更',
      detail: `手動で ${shown} に変更しています (通常の強い順なら ${strong})。${gain}役割別強度: ${basis}`,
      deviates: true,
    };
  }

  const why =
    record.fallback && record.fallback !== 'single-player'
      ? `${ORDER_FALLBACK_LABELS[record.fallback]}${record.fallback === 'small-gain' && record.bestGain !== null ? ` (最大 ${pt(record.bestGain)})` : ''}。`
      : record.probability !== null
        ? '推定でも強い順が最も高い推定勝率です。'
        : '';
  return {
    summary: '投順: 強い順 (このゲームの役割別強度の高い順)',
    detail: `強い選手を先に投げる基本どおり ${strong}。${why}${confidence && record.probability !== null ? `${confidence}。` : ''}役割別強度: ${basis}`,
    deviates: false,
  };
}
