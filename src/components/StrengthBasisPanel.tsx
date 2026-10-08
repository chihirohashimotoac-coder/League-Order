import type { Player } from '../domain/types';
import type { StrengthBasis, StrengthOrigin } from '../domain/n01/historyStrength';
import { formatSyncTime } from '../domain/n01/freshness';
import { CONFIDENCE_LABELS } from '../domain/prediction/confidence';
import { formatPpr } from '../domain/players/strength';
import { Icon } from './icons';

/**
 * 「戦力の根拠」 (F04): where each fielded player's PPR came from, read from the very
 * input the order was generated with (`OrderInput.strengthBasis`), never recomputed — an
 * order saved earlier shows what it was made with, whatever has been synced since.
 */
const ORIGIN_LABELS: Record<StrengthOrigin, string> = {
  manual: '手動入力',
  current: '今季の n01 成績',
  history: '過去 Season を加味した推定',
  carried: '前回同期の値 (今回の分析に成績なし)',
  unknown: '不明 (参加者の中央値で評価)',
};

const SEASON_NAMES = ['今季', '前季', '前々季'];
const seasonName = (index: number): string => SEASON_NAMES[index] ?? `${index} 期前`;

export function StrengthBasisPanel({
  basis,
  players,
  includedIds,
}: {
  basis: StrengthBasis | undefined;
  players: readonly Pick<Player, 'id' | 'name'>[];
  /** Only these players are listed (the participants); all of them when omitted. */
  includedIds?: ReadonlySet<string>;
}): React.JSX.Element | null {
  if (!basis) return null;
  const rows = players.filter((player) => (!includedIds || includedIds.has(player.id)) && basis.players[player.id]);
  if (rows.length === 0) return null;
  return (
    <details className="disclosure strength-basis-panel" data-testid="strength-basis-panel">
      <summary>
        <Icon name="info" />
        <span className="grow">
          <span className="summary-title">戦力の根拠</span>
          <span className="summary-note">使用した Season ・ データ量 ・ 信頼度</span>
        </span>
        <Icon name="chevronDown" className="chev" />
      </summary>
      <div className="disclosure-body">
        <p className="small-text">
          {basis.seasons.length > 0
            ? `使用 Season: ${basis.seasons.map((season) => `${season.title} (${seasonName(season.seasonIndex)}・重み ${season.weight})`).join(' / ')}`
            : 'n01 の過去成績は使用していません。'}
          {basis.generatedAt > 0 ? ` ・ 分析データ: ${formatSyncTime(basis.generatedAt)} 時点` : ''}
        </p>
        <div className="basis-list">
          {rows.map((player) => {
            const entry = basis.players[player.id];
            return (
              <p key={player.id} className="basis-row" data-origin={entry.origin}>
                <strong>{player.name}</strong>
                <span className="small-text">
                  {' '}
                  {entry.ppr !== null ? formatPpr(entry.ppr) : 'PPR —'} ・ {ORIGIN_LABELS[entry.origin]}
                  {entry.seasons.length > 0 ? ` (${entry.seasons.map(seasonName).join('+')})` : ''}
                  {entry.origin === 'manual' || entry.origin === 'unknown' ? '' : ` ・ 約 ${Math.round(entry.legs)} レッグ`}
                  {` ・ 信頼度 ${CONFIDENCE_LABELS[entry.confidence]}`}
                </span>
              </p>
            );
          })}
        </div>
        <p className="tiny muted">
          信頼度は成績のレッグ数 (新しい Season ほど重く数えます) から決めています。低い場合、強さの差を理由にした出場回数の偏りは採用しません。
        </p>
      </div>
    </details>
  );
}
