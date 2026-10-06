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
import { scopeForPreset, weightsForPreset } from '../domain/orders/presets';
import { totalSlots } from '../domain/games/format';
import {
  createParticipantConfig,
  maxAppearancesFor,
  minAppearancesFor,
} from '../domain/orders/participants';
import { useAppStore } from '../state/appStore';
import { MatchInfoFields } from '../components/MatchInfoFields';
import {
  Card,
  EmptyState,
  Field,
  Metric,
  SectionHeader,
  Sheet,
  Stepper,
  formatRating,
  useToast,
} from '../components/ui';
import { Icon, type IconName } from '../components/icons';
import type { Page } from '../navigation';

/**
 * ORDER SETUP screen (spec §5–§8, §11, §26).
 *
 * Ordered by what a captain decides first at the venue: the format, who is here, the
 * policy — then the optional match header and the advanced constraint modes. Every
 * day-of change is one or two taps deep.
 */
export interface SetupDraft {
  formatId: FormatId;
  participants: ParticipantConfig[];
  preset: PresetKey;
  settings: OptimizerSettings;
}

/** Presentation for the policy cards; the weights themselves live in the domain. */
const PRESET_CARDS: Record<PresetKey, { icon: IconName; summary: string }> = {
  WIN_FIRST: { icon: 'trophy', summary: '戦力を最優先' },
  BALANCED: { icon: 'scale', summary: '勝利と公平性を両立' },
  FAIRNESS_FIRST: { icon: 'equal', summary: '出場回数を均等化' },
  DEVELOPMENT: { icon: 'sprout', summary: '出場の少ない選手を優先' },
  NEW_PAIR: { icon: 'pair', summary: '新しいペアを試す' },
  CUSTOM: { icon: 'sliders', summary: '設定画面の重みを使用' },
};

export function SetupPage({
  draft,
  onDraftChange,
  match,
  onMatchChange,
  onGenerate,
  generating,
  editing,
  onDetach,
  onNavigate,
}: {
  draft: SetupDraft;
  onDraftChange: (next: SetupDraft) => void;
  match: MatchInfo;
  onMatchChange: (next: MatchInfo) => void;
  onGenerate: (input: OrderInput) => void;
  generating: boolean;
  /** Set when these conditions belong to a saved order: generating revises it. */
  editing: { title: string; latestVersion: number | null } | null;
  /** Detaches from the saved order so the next generation starts a new one. */
  onDetach: () => void;
  onNavigate: (page: Page) => void;
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
    const noPlayers = store.teamPlayers.length === 0;
    return (
      <Card>
        <EmptyState
          kicker="SETUP REQUIRED"
          title={noPlayers ? 'メンバーが登録されていません' : 'フォーマットがありません'}
          icon={noPlayers ? 'users' : 'format'}
          action={
            <button
              type="button"
              className="btn primary"
              onClick={() => onNavigate(noPlayers ? 'players' : 'formats')}
            >
              {noPlayers ? 'メンバーを登録' : 'フォーマットを作成'}
            </button>
          }
        >
          オーダーを作るには、メンバーとフォーマットが必要です。
        </EmptyState>
      </Card>
    );
  }

  const idealPerPlayer = included.length > 0 ? slots / included.length : 0;
  const matchSummary =
    [
      match.opponentName ? `vs ${match.opponentName}` : '',
      match.matchDate,
      match.leagueName,
    ]
      .filter(Boolean)
      .join(' ・ ') || '対戦相手・試合日を入力';

  return (
    <>
      {editing ? (
        <div className="edit-banner" data-testid="editing-banner">
          <Icon name="edit" size={18} />
          <span className="grow">
            <strong>
              {editing.latestVersion ? `ORDER v${editing.latestVersion} を編集中` : '保存済みのオーダーを編集中'}
            </strong>
            <span className="muted" style={{ display: 'block' }}>
              {editing.latestVersion
                ? `生成し直すと変更点として扱われ、v${editing.latestVersion + 1} として再確定できます。`
                : '生成し直すと、このオーダーの内容が更新されます。'}
            </span>
          </span>
          <button type="button" className="btn small" onClick={onDetach}>
            新規オーダーにする
          </button>
        </div>
      ) : null}

      <SectionHeader index={1} kicker="FORMAT" title="フォーマット" />
      <Card>
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
          <Metric label="総枠" value={slots} />
          <Metric label="参加者" value={included.length} unit="名" />
          <Metric label="1人あたり" value={included.length > 0 ? idealPerPlayer.toFixed(1) : '—'} />
        </div>
      </Card>

      <SectionHeader
        index={2}
        kicker="PLAYERS"
        title={`参加者 ${included.length} / ${store.teamPlayers.length}`}
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
      />
      <ul className="participants">
        {store.teamPlayers.map((player) => {
          const config = configById.get(player.id) ?? createParticipantConfig(player.id, false);
          const restrictions = describeRestrictions(config, games);
          return (
            <li key={player.id} className={config.include ? 'participant' : 'participant is-out'}>
              {/* The whole row toggles participation; the conditions button sits outside
                  the label so it never toggles by accident. */}
              <label className="p-main">
                <span className="p-check">
                  <input
                    type="checkbox"
                    checked={config.include}
                    onChange={(event) => updateConfig(player.id, { include: event.target.checked })}
                    aria-label={`${player.name} を参加者に含める`}
                  />
                  <span className="box" aria-hidden="true">
                    <Icon name="check" size={16} strokeWidth={3} />
                  </span>
                </span>
                <span className="p-text">
                  <span className="p-name">
                    <strong>{player.name}</strong>
                    <span className={player.rating === null ? 'rt unknown' : 'rt'}>
                      {formatRating(player.rating)}
                    </span>
                  </span>
                  <span className={restrictions.length > 0 && config.include ? 'p-meta has-conditions' : 'p-meta'}>
                    {restrictions.length > 0 ? restrictions.join(' ・ ') : '条件なし'}
                  </span>
                </span>
              </label>
              <span className="p-cond">
                <button
                  type="button"
                  className="btn small"
                  onClick={() => setDetailFor(player)}
                  disabled={!config.include}
                >
                  条件
                </button>
              </span>
            </li>
          );
        })}
      </ul>

      <SectionHeader index={3} kicker="STRATEGY" title="方針" />
      <div className="preset-grid" role="radiogroup" aria-label="プリセット">
        {PRESET_KEYS.map((key) => {
          const card = PRESET_CARDS[key];
          const selected = draft.preset === key;
          return (
            <button
              type="button"
              key={key}
              role="radio"
              aria-checked={selected}
              className="preset"
              onClick={() => applyPreset(key)}
            >
              <span className="p-head">
                <Icon name={card.icon} size={18} />
                {PRESET_LABELS[key]}
                {selected ? <Icon name="check" size={18} strokeWidth={2.6} className="p-check-mark" /> : null}
              </span>
              <span className="p-desc">{card.summary}</span>
            </button>
          );
        })}
      </div>

      <SectionHeader index={4} kicker="MATCH" title="試合情報" />
      <details className="disclosure">
        <summary>
          <Icon name="calendar" />
          <span className="grow" style={{ minWidth: 0 }}>
            <span className="summary-title">試合情報 (任意)</span>
            <span className="match-summary">{matchSummary}</span>
          </span>
          <Icon name="chevronDown" className="chev" />
        </summary>
        <div className="disclosure-body" style={{ paddingTop: 14 }}>
          <p className="tiny muted" style={{ marginTop: 0 }}>
            共有する画像とテキストの見出しに使います。空欄でも生成できます。
          </p>
          <MatchInfoFields value={match} onChange={onMatchChange} />
        </div>
      </details>

      <button type="button" className="disclosure list-row" onClick={() => setShowPolicy(true)}>
        <Icon name="sliders" />
        <span className="grow">
          <span className="title" style={{ fontSize: 15.5 }}>
            詳細条件
          </span>
          <span className="meta">
            公平性 {draft.settings.fairnessScope === 'season' ? 'シーズン込み' : '今回のみ'} ・ 連続{' '}
            {draft.settings.consecutiveMode === 'hard' ? '絶対条件' : 'できるだけ考慮'}
          </span>
        </span>
        <Icon name="chevronRight" size={18} className="chevron" />
      </button>

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
            <>
              <Icon name="target" />
              オーダーを生成
            </>
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
        <Sheet title="詳細条件" onClose={() => setShowPolicy(false)}>
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
            hint="絶対条件にすると必ず守ります。少人数チームでは生成できなくなることがあります。"
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
              <option value="soft">できるだけ考慮 (避けられない時は超える)</option>
              <option value="hard">絶対条件 (絶対に超えない)</option>
            </select>
          </Field>

          <Field label="最小出場回数の扱い" hint="既定は絶対条件です。満たせない場合は理由を表示します。">
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
              <option value="hard">絶対条件 (必ず満たす)</option>
              <option value="soft">できるだけ考慮</option>
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
    </Sheet>
  );
}
