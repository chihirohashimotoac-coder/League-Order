import { useMemo, useState } from 'react';
import type {
  FormatId,
  GameKind,
  MatchInfo,
  OptimizerSettings,
  OrderInput,
  ParticipantConfig,
  Player,
  PresetKey,
} from '../domain/types';
import { GAME_KIND_LABELS, PRESET_KEYS, PRESET_LABELS } from '../domain/types';
import { PRESETS, scopeForPreset, weightsForPreset } from '../domain/orders/presets';
import { totalSlots } from '../domain/games/format';
import {
  createParticipantConfig,
  maxAppearancesFor,
  minAppearancesFor,
} from '../domain/orders/participants';
import { useAppStore } from '../state/appStore';
import { MatchInfoFields } from '../components/MatchInfoFields';
import { Card, EmptyState, Field, Sheet, Stepper, useToast } from '../components/ui';

/**
 * ORDER SETUP screen (spec §5–§8, §11, §26).
 *
 * The day-of controls live here: who is present, who cannot play what, who arrives late
 * or leaves early, and the generation policy. Everything a captain changes at the venue
 * is one or two taps deep.
 */
export interface SetupDraft {
  formatId: FormatId;
  participants: ParticipantConfig[];
  preset: PresetKey;
  settings: OptimizerSettings;
}

export function SetupPage({
  draft,
  onDraftChange,
  match,
  onMatchChange,
  onGenerate,
  generating,
}: {
  draft: SetupDraft;
  onDraftChange: (next: SetupDraft) => void;
  match: MatchInfo;
  onMatchChange: (next: MatchInfo) => void;
  onGenerate: (input: OrderInput) => void;
  generating: boolean;
}): React.JSX.Element {
  const store = useAppStore();
  const toast = useToast();
  const [detailFor, setDetailFor] = useState<Player | null>(null);
  const [showPolicy, setShowPolicy] = useState(false);

  const format = store.teamFormats.find((entry) => entry.id === draft.formatId) ?? store.teamFormats[0];
  const games = format?.games ?? [];
  const slots = totalSlots(games);

  const configById = useMemo(
    () => new Map(draft.participants.map((config) => [config.playerId, config])),
    [draft.participants],
  );

  const included = draft.participants.filter((config) => config.include);

  const updateConfig = (playerId: string, change: Partial<ParticipantConfig>): void => {
    onDraftChange({
      ...draft,
      participants: draft.participants.map((config) =>
        config.playerId === playerId ? { ...config, ...change } : config,
      ),
    });
  };

  const applyPreset = (preset: PresetKey): void => {
    onDraftChange({
      ...draft,
      preset,
      settings: {
        ...draft.settings,
        fairnessScope: scopeForPreset(preset, draft.settings.fairnessScope),
      },
    });
  };

  const build = (): OrderInput | null => {
    if (!format) {
      toast.show('フォーマットを選択してください', 'error');
      return null;
    }
    if (included.length === 0) {
      toast.show('参加者を 1 名以上選択してください', 'error');
      return null;
    }
    return {
      teamId: store.activeTeamId ?? '',
      formatId: format.id,
      games: format.games,
      players: store.teamPlayers,
      participants: draft.participants,
      pairs: store.teamPairs,
      locks: [],
      preset: draft.preset,
      weights: weightsForPreset(draft.preset, store.settings.customWeights),
      settings: draft.settings,
    };
  };

  if (store.teamPlayers.length === 0 || store.teamFormats.length === 0) {
    return (
      <Card>
        <EmptyState>
          {store.teamPlayers.length === 0 ? 'メンバーが登録されていません。' : 'フォーマットがありません。'}
          <br />
          先に「メンバー」「フォーマット」を登録してください。
        </EmptyState>
      </Card>
    );
  }

  const idealPerPlayer = included.length > 0 ? slots / included.length : 0;

  return (
    <>
      <Card title="試合情報">
        <p className="tiny dim" style={{ marginTop: 0 }}>
          共有する画像とテキストの見出しに使います。空欄でも生成できます。
        </p>
        <MatchInfoFields value={match} onChange={onMatchChange} />
      </Card>

      <Card title="フォーマット">
        <Field label="使用するフォーマット">
          <select
            value={format?.id ?? ''}
            onChange={(event) => onDraftChange({ ...draft, formatId: event.target.value })}
          >
            {store.teamFormats.map((entry) => (
              <option key={entry.id} value={entry.id}>
                {entry.name} ({entry.games.length}ゲーム / {totalSlots(entry.games)}枠)
              </option>
            ))}
          </select>
        </Field>
        <div className="metrics">
          <div className="metric">
            <span className="k">総枠</span>
            <span className="v">{slots}</span>
          </div>
          <div className="metric">
            <span className="k">参加者</span>
            <span className="v">{included.length}</span>
          </div>
          <div className="metric">
            <span className="k">1人あたり</span>
            <span className="v">{included.length > 0 ? idealPerPlayer.toFixed(1) : '-'}</span>
          </div>
        </div>
      </Card>

      <Card
        title={`参加者 (${included.length} / ${store.teamPlayers.length})`}
        action={
          <div className="row" style={{ gap: 6 }}>
            <button
              type="button"
              className="btn small"
              onClick={() =>
                onDraftChange({
                  ...draft,
                  participants: draft.participants.map((config) => ({ ...config, include: true })),
                })
              }
            >
              全員
            </button>
            <button
              type="button"
              className="btn small"
              onClick={() =>
                onDraftChange({
                  ...draft,
                  participants: draft.participants.map((config) => ({ ...config, include: false })),
                })
              }
            >
              解除
            </button>
          </div>
        }
        flush
      >
        <ul className="list">
          {store.teamPlayers.map((player) => {
            const config = configById.get(player.id) ?? createParticipantConfig(player.id, false);
            const restrictions = describeRestrictions(config, games);
            return (
              <li key={player.id}>
                <div className="row" style={{ padding: '8px 12px', gap: 10 }}>
                  <input
                    type="checkbox"
                    checked={config.include}
                    onChange={(event) => updateConfig(player.id, { include: event.target.checked })}
                    aria-label={`${player.name} を参加者に含める`}
                    style={{ width: 24, height: 24, minHeight: 24, flex: 'none' }}
                  />
                  <span className="grow" style={{ minWidth: 0 }}>
                    <span className="title" style={{ display: 'block' }}>
                      {player.name}
                      {player.rating === null ? (
                        <span className="badge" style={{ marginLeft: 6 }}>
                          R未入力
                        </span>
                      ) : (
                        <span className="dim tiny" style={{ marginLeft: 6 }}>
                          R{player.rating}
                        </span>
                      )}
                    </span>
                    <span className="meta">
                      {restrictions.length > 0 ? restrictions.join(' ・ ') : '制約なし'}
                    </span>
                  </span>
                  <button
                    type="button"
                    className="btn small"
                    onClick={() => setDetailFor(player)}
                    disabled={!config.include}
                  >
                    条件
                  </button>
                </div>
              </li>
            );
          })}
        </ul>
      </Card>

      <Card title="プリセット">
        <div className="row wrap" style={{ gap: 6 }}>
          {PRESET_KEYS.filter((key) => key !== 'CUSTOM').map((key) => (
            <button
              type="button"
              key={key}
              className="chip"
              aria-pressed={draft.preset === key}
              onClick={() => applyPreset(key)}
            >
              {PRESET_LABELS[key]}
            </button>
          ))}
          <button
            type="button"
            className="chip"
            aria-pressed={draft.preset === 'CUSTOM'}
            onClick={() => applyPreset('CUSTOM')}
          >
            カスタム
          </button>
        </div>
        <p className="tiny dim" style={{ marginBottom: 0, marginTop: 8 }}>
          {draft.preset === 'CUSTOM'
            ? '設定画面で調整した重みを使用します。'
            : PRESETS[draft.preset].description}
        </p>
        <button
          type="button"
          className="btn small ghost"
          style={{ marginTop: 10 }}
          onClick={() => setShowPolicy(true)}
        >
          公平性の範囲・制約モードを調整
        </button>
      </Card>

      <div className="action-bar">
        <button
          type="button"
          className="btn primary"
          disabled={generating}
          onClick={() => {
            const input = build();
            if (input) onGenerate(input);
          }}
        >
          {generating ? (
            <>
              <span className="spinner" aria-hidden="true" /> 生成中…
            </>
          ) : (
            'オーダーを生成'
          )}
        </button>
      </div>

      {detailFor
        ? (() => {
            const config = configById.get(detailFor.id) ?? createParticipantConfig(detailFor.id);
            return (
              <ParticipantDetail
                player={detailFor}
                config={config}
                games={games}
                defaultMaxConsecutive={draft.settings.defaultMaxConsecutive}
                onChange={(change) => updateConfig(detailFor.id, change)}
                onClose={() => setDetailFor(null)}
              />
            );
          })()
        : null}

      {showPolicy ? (
        <Sheet title="公平性と制約モード" onClose={() => setShowPolicy(false)}>
          <Field
            label="公平性の評価範囲"
            hint="「シーズン込み」にすると、累計出場が少ない選手が優先されます。"
          >
            <select
              value={draft.settings.fairnessScope}
              onChange={(event) =>
                onDraftChange({
                  ...draft,
                  settings: {
                    ...draft.settings,
                    fairnessScope: event.target.value as OptimizerSettings['fairnessScope'],
                  },
                })
              }
            >
              <option value="today">今回のみ</option>
              <option value="season">シーズン込み</option>
            </select>
          </Field>

          <Field
            label="最大連続出場の扱い"
            hint="Hard にすると絶対に超えません。少人数チームでは解が無くなることがあります。"
          >
            <select
              value={draft.settings.consecutiveMode}
              onChange={(event) =>
                onDraftChange({
                  ...draft,
                  settings: {
                    ...draft.settings,
                    consecutiveMode: event.target.value as OptimizerSettings['consecutiveMode'],
                  },
                })
              }
            >
              <option value="soft">Soft (できる限り避ける)</option>
              <option value="hard">Hard (絶対に超えない)</option>
            </select>
          </Field>

          <Field label="最小出場回数の扱い" hint="既定は Hard です。満たせない場合は理由を表示します。">
            <select
              value={draft.settings.minAppearanceMode}
              onChange={(event) =>
                onDraftChange({
                  ...draft,
                  settings: {
                    ...draft.settings,
                    minAppearanceMode: event.target.value as OptimizerSettings['minAppearanceMode'],
                  },
                })
              }
            >
              <option value="hard">Hard (必ず満たす)</option>
              <option value="soft">Soft (できる限り満たす)</option>
            </select>
          </Field>

          <div className="field">
            <span>既定の最大連続出場</span>
            <Stepper
              label="既定の最大連続出場"
              value={draft.settings.defaultMaxConsecutive}
              min={1}
              max={12}
              onChange={(next) =>
                onDraftChange({ ...draft, settings: { ...draft.settings, defaultMaxConsecutive: next } })
              }
            />
          </div>
        </Sheet>
      ) : null}
    </>
  );
}

function describeRestrictions(
  config: ParticipantConfig,
  games: readonly { id: string; name: string; order: number }[],
): string[] {
  const notes: string[] = [];
  if (!config.include) return ['不参加'];
  if (config.excludedGameIds.length > 0) {
    const names = config.excludedGameIds
      .map((id) => games.find((game) => game.id === id)?.name ?? id)
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
    notes.push(`R上書き ${config.ratingOverride ?? '未入力'}`);
  }
  return notes;
}

function ParticipantDetail({
  player,
  config,
  games,
  defaultMaxConsecutive,
  onChange,
  onClose,
}: {
  player: Player;
  config: ParticipantConfig;
  games: readonly { id: string; name: string; order: number }[];
  defaultMaxConsecutive: number;
  onChange: (change: Partial<ParticipantConfig>) => void;
  onClose: () => void;
}): React.JSX.Element {
  const gameCount = games.length;
  const kinds: GameKind[] = ['SINGLES', 'DOUBLES', 'TRIOS', 'G501', 'CRICKET', 'GALLON', 'TEAM'];
  const min = minAppearancesFor(config);
  const max = maxAppearancesFor(config, games as never);

  return (
    <Sheet title={`${player.name} の出場条件`} onClose={onClose}>
      <div className="field">
        <span>出場できないゲーム (Hard制約)</span>
        <div className="row wrap" style={{ gap: 5 }}>
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

      <div className="field">
        <span>出場できないゲーム種別 (Hard制約)</span>
        <div className="row wrap" style={{ gap: 5 }}>
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

      <div className="field">
        <span>出場可能範囲 (遅刻・早退)</span>
        <div className="row wrap" style={{ gap: 6, marginBottom: 8 }}>
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
        <div className="row" style={{ gap: 8 }}>
          <label className="grow">
            <span className="tiny dim">最初に出られる Game</span>
            <Stepper
              label="最初に出られるゲーム"
              value={config.window?.fromOrder ?? 1}
              min={1}
              max={gameCount}
              onChange={(next) =>
                onChange({ window: { ...config.window, fromOrder: next === 1 ? undefined : next } })
              }
            />
          </label>
          <label className="grow">
            <span className="tiny dim">最後に出られる Game</span>
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
          </label>
        </div>
      </div>

      <div className="field">
        <span>出場回数</span>
        <div className="row between" style={{ marginBottom: 8 }}>
          <span className="tiny dim">最小 (0 = 指定なし)</span>
          <Stepper
            label="最小出場回数"
            value={min}
            min={0}
            max={gameCount}
            onChange={(next) => onChange({ minAppearances: next === 0 ? undefined : next })}
          />
        </div>
        <div className="row between">
          <span className="tiny dim">最大</span>
          <Stepper
            label="最大出場回数"
            value={max}
            min={0}
            max={gameCount}
            onChange={(next) => onChange({ maxAppearances: next >= gameCount ? undefined : next })}
          />
        </div>
      </div>

      <div className="field">
        <span>最大連続出場 (個別指定)</span>
        <div className="row between">
          <span className="tiny dim">既定 {defaultMaxConsecutive} 試合</span>
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
          placeholder={player.rating === null ? '未入力 (Unknown)' : String(player.rating)}
        />
      </Field>
    </Sheet>
  );
}
