import type { GameKind, LeagueStatus, ParticipantConfig, Player } from '../domain/types';
import { GAME_KIND_LABELS, LEAGUE_STATUS_LABELS } from '../domain/types';
import { leagueStatusOf } from '../domain/orders/leagueRules';
import { maxAppearancesFor, minAppearancesFor } from '../domain/orders/participants';
import { Field, RadioCards, Sheet, Stepper, formatRating } from './ui';

/**
 * A participant's day-of conditions (出場条件): games and kinds they cannot play, the window they
 * are here for (遅刻・早退), appearance counts, a rating for today. Used by ORDER SETUP and by the
 * next-match flow, so both edit the same fields with the same checks.
 */

export function describeRestrictions(
  config: ParticipantConfig,
  games: readonly { id: string; name: string; order: number }[],
): string[] {
  const notes: string[] = [];
  if (!config.include) return ['不参加'];
  if (config.excludedGameIds.length > 0) {
    const names = config.excludedGameIds
      .map((id) => {
        const game = games.find((entry) => entry.id === id);
        return game ? `G${game.order}` : id;
      })
      .join(', ');
    notes.push(`不可: ${names}`);
  }
  if (config.excludedKinds.length > 0) {
    notes.push(`不可: ${config.excludedKinds.map((kind) => GAME_KIND_LABELS[kind]).join(', ')}`);
  }
  if (config.window) {
    notes.push(`範囲 G${config.window.fromOrder ?? 1}〜${config.window.toOrder ?? '最終'}`);
  }
  if (config.minAppearances !== undefined) notes.push(`最小${config.minAppearances}`);
  if (config.maxAppearances !== undefined) notes.push(`最大${config.maxAppearances}`);
  if (config.maxConsecutive !== undefined) notes.push(`連続≤${config.maxConsecutive}`);
  if (config.ratingOverride !== undefined) {
    notes.push(`今回 ${formatRating(config.ratingOverride)}`);
  }
  return notes;
}

/** The league status of a participant under a helper rule, always in words. */
export function LeagueStatusTag({ status }: { status: LeagueStatus | null }): React.JSX.Element {
  return status === null ? (
    <span className="n01-tag status-tag unset" data-testid="league-status-tag">
      大会資格 未設定
    </span>
  ) : (
    <span className={`n01-tag status-tag ${status === 'HELPER' ? 'helper' : 'regular'}`} data-testid="league-status-tag">
      大会: {LEAGUE_STATUS_LABELS[status]}
    </span>
  );
}

export function ParticipantDetail({
  player,
  config,
  games,
  defaultMaxConsecutive,
  statusRequired,
  onChange,
  onClose,
  inline = false,
}: {
  /** Shown in place (beside the participant list on a large screen) instead of in a sheet. */
  inline?: boolean;
  player: Player;
  config: ParticipantConfig;
  games: readonly { id: string; name: string; order: number }[];
  defaultMaxConsecutive: number;
  /** The format has a helper rule, so this order needs the player's league status. */
  statusRequired: boolean;
  onChange: (change: Partial<ParticipantConfig>) => void;
  onClose: () => void;
}): React.JSX.Element {
  const gameCount = games.length;
  const kinds: GameKind[] = ['SINGLES', 'DOUBLES', 'TRIOS', 'G501', 'CRICKET', 'GALLON', 'TEAM'];
  const min = minAppearancesFor(config);
  const max = maxAppearancesFor(config, games as never);
  const status = leagueStatusOf(config);

  const body = (
    <>
      {statusRequired || status !== null ? (
        <div className="sheet-section" data-testid="league-status-picker">
          <RadioCards<LeagueStatus | ''>
            label="大会資格 (リーグ規則・このオーダーのみ)"
            hint={
              status === null
                ? '未設定です。助っ人の人数上限を確認するため、どちらかを選んでください (未設定のまま正規登録とはみなしません)。'
                : '助っ人の人数上限の確認に使います。「今回だけの助っ人」として追加したかどうかとは別に選べます。大会側の登録確認ではありません。'
            }
            columns={2}
            value={status ?? ''}
            options={[
              { key: 'REGULAR', label: LEAGUE_STATUS_LABELS.REGULAR, hint: 'チームの登録選手' },
              { key: 'HELPER', label: LEAGUE_STATUS_LABELS.HELPER, hint: '人数上限の対象' },
            ]}
            onChange={(next) => onChange({ leagueStatus: next === '' ? undefined : next })}
          />
        </div>
      ) : null}

      <div className="sheet-section">
        <span className="kicker">絶対条件 ・ 出場できないゲーム</span>
        <div className="chip-row">
          {games.map((game) => (
            <button
              type="button"
              key={game.id}
              className={`chip${config.excludedGameIds.includes(game.id) ? ' danger-on' : ''}`}
              aria-pressed={config.excludedGameIds.includes(game.id)}
              onClick={() =>
                onChange({
                  excludedGameIds: config.excludedGameIds.includes(game.id)
                    ? config.excludedGameIds.filter((id) => id !== game.id)
                    : [...config.excludedGameIds, game.id],
                })
              }
            >
              {game.order}. {game.name}
            </button>
          ))}
        </div>
      </div>

      <div className="sheet-section">
        <span className="kicker">絶対条件 ・ 出場できない種別</span>
        <div className="chip-row">
          {kinds.map((kind) => (
            <button
              type="button"
              key={kind}
              className={`chip${config.excludedKinds.includes(kind) ? ' danger-on' : ''}`}
              aria-pressed={config.excludedKinds.includes(kind)}
              onClick={() =>
                onChange({
                  excludedKinds: config.excludedKinds.includes(kind)
                    ? config.excludedKinds.filter((entry) => entry !== kind)
                    : [...config.excludedKinds, kind],
                })
              }
            >
              {GAME_KIND_LABELS[kind]}
            </button>
          ))}
        </div>
      </div>

      <div className="sheet-section">
        <span className="kicker">出場可能範囲 (遅刻・早退)</span>
        <div className="chip-row" style={{ marginBottom: 10 }}>
          <button type="button" className="chip" onClick={() => onChange({ window: undefined })}>
            制限なし
          </button>
          <button
            type="button"
            className="chip"
            onClick={() => onChange({ window: { toOrder: Math.ceil(gameCount / 2) } })}
          >
            前半のみ
          </button>
          <button
            type="button"
            className="chip"
            onClick={() => onChange({ window: { fromOrder: Math.floor(gameCount / 2) + 1 } })}
          >
            後半のみ
          </button>
        </div>
        <div className="row between" style={{ marginBottom: 8 }}>
          <span className="small-text secondary">最初に出られる Game</span>
          <Stepper
            label="最初に出られるゲーム"
            value={config.window?.fromOrder ?? 1}
            min={1}
            max={gameCount}
            onChange={(next) =>
              onChange({ window: { ...config.window, fromOrder: next === 1 ? undefined : next } })
            }
          />
        </div>
        <div className="row between">
          <span className="small-text secondary">最後に出られる Game</span>
          <Stepper
            label="最後に出られるゲーム"
            value={config.window?.toOrder ?? gameCount}
            min={1}
            max={gameCount}
            onChange={(next) =>
              onChange({
                window: { ...config.window, toOrder: next === gameCount ? undefined : next },
              })
            }
          />
        </div>
      </div>

      <div className="sheet-section">
        <span className="kicker">出場回数</span>
        <div className="row between" style={{ marginBottom: 8 }}>
          <span className="small-text secondary">最小 (0 = 指定なし)</span>
          <Stepper
            label="最小出場回数"
            value={min}
            min={0}
            max={gameCount}
            onChange={(next) => onChange({ minAppearances: next === 0 ? undefined : next })}
          />
        </div>
        <div className="row between" style={{ marginBottom: 8 }}>
          <span className="small-text secondary">最大</span>
          <Stepper
            label="最大出場回数"
            value={max}
            min={0}
            max={gameCount}
            onChange={(next) => onChange({ maxAppearances: next >= gameCount ? undefined : next })}
          />
        </div>
        <div className="row between">
          <span className="small-text secondary">最大連続出場 (既定 {defaultMaxConsecutive})</span>
          <Stepper
            label="最大連続出場"
            value={config.maxConsecutive ?? defaultMaxConsecutive}
            min={1}
            max={gameCount}
            onChange={(next) =>
              onChange({ maxConsecutive: next === defaultMaxConsecutive ? undefined : next })
            }
          />
        </div>
      </div>

      <Field
        label="今回だけの Rating 上書き (任意)"
        hint="空欄で選手登録の Rating を使用します。"
      >
        <input
          type="number"
          step="0.01"
          inputMode="decimal"
          value={config.ratingOverride === undefined || config.ratingOverride === null ? '' : config.ratingOverride}
          onChange={(event) => {
            const text = event.target.value.trim();
            if (text === '') {
              onChange({ ratingOverride: undefined });
              return;
            }
            const parsed = Number(text);
            if (Number.isFinite(parsed)) onChange({ ratingOverride: parsed });
          }}
          placeholder={player.rating === null ? '未入力 (不明)' : String(player.rating)}
        />
      </Field>
    </>
  );
  if (!inline) {
    return (
      <Sheet title={`${player.name} の出場条件`} onClose={onClose}>
        {body}
      </Sheet>
    );
  }
  return (
    <section className="card participant-panel" aria-labelledby="participant-panel-title" data-testid="participant-panel">
      <div className="participant-panel-head">
        <span>
          <span className="kicker">選択中の参加者</span>
          <h3 id="participant-panel-title">{player.name} の出場条件</h3>
        </span>
        <button type="button" className="btn small ghost" onClick={onClose}>
          閉じる
        </button>
      </div>
      {body}
    </section>
  );
}
