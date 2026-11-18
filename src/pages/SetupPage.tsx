import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { SPLIT_QUERY, useMediaQuery } from '../components/useMediaQuery';
import type {
  FormatId,
  MatchInfo,
  OptimizerSettings,
  OrderInput,
  ParticipantConfig,
  Player,
  PresetKey,
  Team,
} from '../domain/types';
import { PRESET_KEYS, PRESET_LABELS, createMatchInfo, formatDiscipline } from '../domain/types';
import { leagueStatusOf, needsLeagueStatus } from '../domain/orders/leagueRules';
import { resolveOrderRules, structureCounts, withAnswers } from '../domain/orders/ruleResolution';
import type { AskableKind } from '../domain/orders/ruleResolution';
import { RuleConditionsCard, RuleQuestionSheet } from '../components/RuleConditions';
import { LeagueRulesSummary } from '../components/LeagueRules';
import { scopeForPreset, weightsForPreset } from '../domain/orders/presets';
import { formatStructureIssues, totalSlots } from '../domain/games/format';
import { createParticipantConfig, syncParticipants } from '../domain/orders/participants';
import { buildNextMatchOrder, eligiblePlayers, previousAvailability } from '../domain/n01/nextMatch';
import { NextMatchStatus, isNextMatchPending, useNextMatchSync } from '../components/n01/NextMatchFlow';
import { N01TeamWizard } from '../components/n01/N01TeamWizard';
import { finalizeMember, newGuest, newMember } from '../domain/players/newPlayer';
import { createId } from '../utils/id';
import { PlayerEditor } from '../components/PlayerEditor';
import { StrengthBasisPanel } from '../components/StrengthBasisPanel';
import { useAppStore, type AppStore } from '../state/appStore';
import { MatchInfoFields } from '../components/MatchInfoFields';
import { LeagueStatusTag, ParticipantDetail, describeRestrictions } from '../components/ParticipantConditions';
import {
  Card,
  EmptyState,
  Field,
  Metric,
  SectionHeader,
  Sheet,
  Stepper,
  DisciplineBadge,
  formatStrengthLine,
  useToast,
  RadioCards,
  onRadioGroupKeyDown,
  rovingTabIndex,
} from '../components/ui';
import { explainStrengthWeights, resolveStrength } from '../domain/players/strength';
import { Icon, type IconName } from '../components/icons';
import { effectivePpr, withEffectivePpr } from '../domain/n01/effectivePpr';
import { applyHistoryStrength, buildRoleStrengthContext } from '../domain/n01/historyStrength';
import { THROW_ORDER_MODEL_VERSION } from '../domain/prediction/throwOrder';
import type { N01MatchIntelligenceSnapshot } from '../domain/n01/intelligence';
import { buildOpponentContext } from '../domain/prediction/opponentContext';
import { CONFIDENCE_LABELS } from '../domain/prediction/confidence';
import { freshness } from '../domain/n01/freshness';
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
  /**
   * Helpers for this order only (今回限りの助っ人): in the order's players and
   * participants, in no roster. Cleared when a new order is started.
   */
  guests: Player[];
  preset: PresetKey;
  settings: OptimizerSettings;
}

/** Presentation for the policy cards; the weights themselves live in the domain. */
const PRESET_CARDS: Record<PresetKey, { icon: IconName; summary: string }> = {
  OPPONENT_OPTIMIZED: { icon: 'target', summary: '相手の予測に対して推定勝率を最大化' },
  WIN_FIRST: { icon: 'trophy', summary: '戦力を重視 (根拠が強いときだけ偏らせる)' },
  BALANCED: { icon: 'scale', summary: '勝利と公平性を両立' },
  FAIRNESS_FIRST: { icon: 'equal', summary: '出場回数を均等化' },
  DEVELOPMENT: { icon: 'sprout', summary: '出場の少ない選手を優先' },
  NEW_PAIR: { icon: 'pair', summary: '新しいペアを試す' },
  CUSTOM: { icon: 'sliders', summary: '設定画面の重みを使用' },
};

/** The active n01 team's latest analysis (opponent data for the next match), or null. */
export function activeIntel(store: Pick<AppStore, 'activeTeam' | 'n01CacheFor'>): N01MatchIntelligenceSnapshot | null {
  return store.activeTeam?.n01
    ? (store.n01CacheFor(store.activeTeam.id).find(
        (record): record is N01MatchIntelligenceSnapshot => record.kind === 'intel',
      ) ?? null)
    : null;
}

/** True when SETUP offers 対戦相手最適化 from the analysis (an opponent and a next match). */
export function hasNextOpponent(intel: N01MatchIntelligenceSnapshot | null): boolean {
  return !!intel?.opponent && !!intel.nextMatch;
}

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
  opponentIntel,
  locked = false,
  memberAdd = false,
  rosterOnly = false,
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
  /**
   * The analysis whose next match this order is for. Omitted: the active team's latest one.
   * `null`: none — another match made by hand, which must never pick up the n01 next match's
   * opponent implicitly.
   */
  opponentIntel?: N01MatchIntelligenceSnapshot | null;
  /** The conditions are not settled yet (the next match is still being fetched): no edits, no generation. */
  locked?: boolean;
  /**
   * Offers 「次回から参加するメンバーを追加」 next to the helper (the new-order SETUP): a member
   * saved to the team, here today and a candidate from now on.
   */
  memberAdd?: boolean;
  /**
   * Only players who can play in the league are offered (the next match): nobody archived or
   * no longer on the n01 roster, as the next-match attendance always was.
   */
  rosterOnly?: boolean;
}): React.JSX.Element {
  const store = useAppStore();
  const toast = useToast();
  const [detailFor, setDetailFor] = useState<Player | null>(null);
  // A large screen: the chosen participant's conditions sit beside the list (no sheet over it).
  const wide = useMediaQuery(SPLIT_QUERY);
  const [showPolicy, setShowPolicy] = useState(false);
  const [guestDraft, setGuestDraft] = useState<Player | null>(null);
  const [memberDraft, setMemberDraft] = useState<Player | null>(null);
  // `generate`: the questions were opened by the generate button, so confirming generates.
  const [asking, setAsking] = useState<null | 'edit' | 'generate'>(null);

  const format = store.teamFormats.find((entry) => entry.id === draft.formatId) ?? store.teamFormats[0];
  const games = format?.games ?? [];
  const slots = totalSlots(games);
  const structureIssues = useMemo(() => formatStructureIssues(games), [games]);
  // The caps the order is made under: league catalog, format editor, the captain's answers.
  const ruleAnswers = store.settings.ruleAnswers;
  const resolution = useMemo(() => (format ? resolveOrderRules(format, ruleAnswers) : null), [format, ruleAnswers]);

  const configById = useMemo(
    () => new Map(draft.participants.map((config) => [config.playerId, config])),
    [draft.participants],
  );

  const included = draft.participants.filter((config) => config.include);
  const discipline = formatDiscipline(format);
  // A helper cap needs every participant's league status; nobody is assumed REGULAR.
  const statusRequired = needsLeagueStatus(resolution?.rules);
  // Opponent data for the next match (n01 teams only). The context is built against the
  // format chosen here and travels inside the order, so the saved order can always be
  // re-evaluated exactly as it was generated.
  const intel = activeIntel(store);
  const opponentSource = opponentIntel === undefined ? intel : opponentIntel;
  // n01-linked players carry their PPR from n01 — this season's, or the estimate over the
  // seasons the last analysis returned — or the manual fallback: the order input snapshots
  // that value and where it came from, so a saved order keeps the PPR it was made with.
  const everyone = useMemo(
    () => [...(rosterOnly ? eligiblePlayers(store.teamPlayers) : store.teamPlayers), ...draft.guests],
    [store.teamPlayers, draft.guests, rosterOnly],
  );
  const offered = useMemo(() => new Set(everyone.map((player) => player.id)), [everyone]);
  const unstated = statusRequired
    ? everyone.filter((player) => configById.get(player.id)?.include && leagueStatusOf(configById.get(player.id)) === null)
    : [];
  const { players: effectivePlayers, basis: strengthBasis } = useMemo(
    () => applyHistoryStrength(everyone, intel),
    [everyone, intel],
  );
  const opponent = useMemo(
    () =>
      opponentSource && format
        ? buildOpponentContext({ snapshot: opponentSource, games: format.games, players: effectivePlayers, discipline: formatDiscipline(format) })
        : null,
    [opponentSource, format, effectivePlayers],
  );
  // The role evidence behind each player's strength per kind of game (docs/THROW_ORDER_MODEL.md §4).
  const roleStrength = useMemo(() => buildRoleStrengthContext(effectivePlayers, intel), [effectivePlayers, intel]);
  const n01Team = !!store.activeTeam?.n01;
  // No opponent at all → the preset is not offered. An opponent whose data cannot be
  // used here → offered, labelled 対戦データ不足, and generated as 勝利優先.
  const hasOpponent = hasNextOpponent(opponentSource);
  const visiblePresets = PRESET_KEYS.filter(
    (key) => key !== 'OPPONENT_OPTIMIZED' || hasOpponent || draft.preset === 'OPPONENT_OPTIMIZED',
  );
  // The same resolution the optimizer runs, so the blend shown here is the one used.
  const strengthText = useMemo(
    () => explainStrengthWeights(resolveStrength(discipline, effectivePlayers, draft.participants)),
    [discipline, effectivePlayers, draft.participants],
  );

  const updateConfig = (playerId: string, change: Partial<ParticipantConfig>): void => {
    onDraftChange({
      ...draft,
      participants: draft.participants.map((config) =>
        config.playerId === playerId ? { ...config, ...change } : config,
      ),
    });
  };

  const startGuest = (): void => {
    setGuestDraft(
      newGuest(store.activeTeamId ?? '', createId('gst'), { name: '', rating: null, ppr: null, skills: {} }, Date.now()),
    );
  };

  const addGuest = (guest: Player): void => {
    onDraftChange({
      ...draft,
      guests: [...draft.guests, guest],
      participants: [...draft.participants, createParticipantConfig(guest.id, true)],
    });
    setGuestDraft(null);
    toast.show(`${guest.name} を今回の助っ人として追加しました`, 'ok');
  };

  const removeGuest = (guestId: string): void => {
    onDraftChange({
      ...draft,
      guests: draft.guests.filter((guest) => guest.id !== guestId),
      participants: draft.participants.filter((config) => config.playerId !== guestId),
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

  const build = (rulesOverride?: typeof resolution): OrderInput | null => {
    const resolved = rulesOverride ?? resolution;
    if (!format) {
      toast.show('フォーマットを選択してください', 'error');
      return null;
    }
    if (included.length === 0) {
      toast.show('参加者を 1 名以上選択してください', 'error');
      return null;
    }
    if (unstated.length > 0) {
      toast.show(
        `生成できません: 大会資格が未設定の参加者がいます (${unstated.map((player) => player.name).join('、')})。「条件」で正規登録か助っ人かを選んでください。`,
        'error',
      );
      return null;
    }
    if (structureIssues.length > 0) {
      toast.show(`生成できません: ${structureIssues[0].message} フォーマット画面で修正してください。`, 'error');
      return null;
    }
    // Caps nobody has stated yet are asked first; nothing is generated on a guess.
    if (resolved && resolved.pending.length > 0) {
      setAsking('generate');
      return null;
    }
    const leagueRules = resolved?.rules;
    return {
      teamId: store.activeTeamId ?? '',
      formatId: format.id,
      games: format.games,
      players: effectivePlayers,
      // A player not offered here never plays, whatever an older condition said.
      participants: rosterOnly
        ? draft.participants.map((config) => (offered.has(config.playerId) ? config : { ...config, include: false }))
        : draft.participants,
      pairs: store.teamPairs,
      locks: [],
      preset: draft.preset,
      weights: weightsForPreset(draft.preset, store.settings.customWeights),
      settings: draft.settings,
      // Snapshot: a later edit to the format's discipline must not re-score this order.
      discipline: formatDiscipline(format),
      // Snapshot too: the order is checked against the rules it was made under.
      ...(leagueRules ? { leagueRules } : {}),
      ...(opponent ? { opponent } : {}),
      strengthBasis,
      // New orders are made with the throw-order model and keep the evidence they used, so a
      // saved order is re-evaluated exactly as it was generated (docs/THROW_ORDER_MODEL.md §9).
      throwOrderModel: THROW_ORDER_MODEL_VERSION,
      roleStrength,
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

      <div className={`setup-layout${wide ? ' is-split' : ''}${locked ? ' is-locked' : ''}`} data-testid="setup-layout">
      {/* A box-less fieldset: while locked every control below is disabled at once, and the
          layout (a grid on a large screen) is untouched. */}
      <fieldset className="setup-lock" disabled={locked}>
      <div className="setup-main">
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
        <LeagueRulesSummary rules={format?.leagueRules} />
        {resolution ? <RuleConditionsCard resolution={resolution} onEditAnswers={() => setAsking('edit')} /> : null}
        {structureIssues.length > 0 ? (
          <div className="notice warn" role="alert" data-testid="setup-format-issue">
            <Icon name="alert" size={18} />
            <span className="grow small-text">
              このフォーマットには修正が必要なゲームがあります: {structureIssues[0].message}
              {structureIssues.length > 1 ? ` ほか ${structureIssues.length - 1} 件。` : ''}
            </span>
            <button type="button" className="btn small" onClick={() => onNavigate('formats')}>
              フォーマットを修正
            </button>
          </div>
        ) : null}
        <div className="strength-basis" data-testid="setup-strength-basis">
          <DisciplineBadge discipline={discipline} />
          <span className="grow">
            <span className="basis-title">{strengthText.title}</span>
            <span className="basis-note">{strengthText.note}</span>
          </span>
        </div>
        <div className="metrics">
          <Metric label="総枠" value={slots} />
          <Metric label="参加者" value={included.length} unit="名" />
          <Metric label="1人あたり" value={included.length > 0 ? idealPerPlayer.toFixed(1) : '—'} />
        </div>
      </Card>

      <SectionHeader
        index={2}
        kicker="PLAYERS"
        title={`参加者 ${included.length} / ${everyone.length}`}
        action={
          <div className="row" style={{ gap: 6 }}>
            <button
              type="button"
              className="btn small"
              onClick={() =>
                onDraftChange({
                  ...draft,
                  participants: draft.participants.map((config) => ({ ...config, include: offered.has(config.playerId) })),
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
      <StrengthBasisPanel
        basis={strengthBasis}
        players={effectivePlayers}
        includedIds={new Set(included.map((config) => config.playerId))}
      />
      {unstated.length > 0 ? (
        <div className="notice warn" role="status" data-testid="league-status-notice">
          <Icon name="alert" size={18} />
          <span className="grow small-text">
            リーグ規則に助っ人の人数上限 ({format?.leagueRules?.maxHelpers} 名) があるため、参加者ごとの大会資格 (正規登録 / 助っ人) が必要です。
            未設定: {unstated.map((player) => player.name).join('、')}。各選手の「条件」で選んでください。
          </span>
          {unstated.some((player) => !player.guest) ? (
            <button
              type="button"
              className="btn small"
              onClick={() =>
                onDraftChange({
                  ...draft,
                  participants: draft.participants.map((config) =>
                    unstated.some((player) => player.id === config.playerId && !player.guest)
                      ? { ...config, leagueStatus: 'REGULAR' }
                      : config,
                  ),
                })
              }
            >
              名簿メンバーを正規登録にする
            </button>
          ) : null}
        </div>
      ) : null}
      <ul className="participants">
        {everyone.map((player) => {
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
                    {player.guest ? <span className="n01-tag guest-tag" data-testid="guest-tag">助っ人 (今回のみ)</span> : null}
                    {memberAdd && n01Team && !player.guest && !player.n01 ? (
                      <span className="n01-tag muted-tag" data-testid="manual-tag">n01 未連携</span>
                    ) : null}
                    {statusRequired && config.include ? <LeagueStatusTag status={leagueStatusOf(config)} /> : null}
                    <span
                      className={
                        player.rating === null && effectivePpr(player).value === null ? 'rt unknown' : 'rt'
                      }
                    >
                      {formatStrengthLine(withEffectivePpr(player))}
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
                  aria-pressed={wide ? detailFor?.id === player.id : undefined}
                  aria-label={`${player.name} の出場条件`}
                >
                  条件
                </button>
                {player.guest ? (
                  <button
                    type="button"
                    className="btn small"
                    onClick={() => removeGuest(player.id)}
                    aria-label={`助っ人 ${player.name} を外す`}
                  >
                    外す
                  </button>
                ) : null}
              </span>
            </li>
          );
        })}
      </ul>
      <button type="button" className="btn small add-guest" onClick={startGuest}>
        <Icon name="plus" size={16} strokeWidth={2.6} />
        今回だけ助っ人を追加
      </button>
      {memberAdd ? (
        <button
          type="button"
          className="btn small add-guest"
          onClick={() =>
            setMemberDraft(newMember(store.activeTeamId ?? '', createId('pl'), { name: '', rating: null, ppr: null, skills: {} }, Date.now()))
          }
        >
          <Icon name="plus" size={16} strokeWidth={2.6} />
          次回から参加するメンバーを追加
        </button>
      ) : null}
      </div>

      <div className="setup-side">
      {wide ? (
        detailFor && configById.get(detailFor.id)?.include ? (
          <ParticipantDetail
            key={detailFor.id}
            inline
            player={detailFor}
            config={configById.get(detailFor.id) ?? createParticipantConfig(detailFor.id)}
            games={games}
            defaultMaxConsecutive={draft.settings.defaultMaxConsecutive}
            statusRequired={statusRequired}
            onChange={(change) => updateConfig(detailFor.id, change)}
            onClose={() => setDetailFor(null)}
          />
        ) : (
          <section className="card participant-panel is-empty" data-testid="participant-panel-empty">
            <span className="kicker">出場条件</span>
            <p className="small-text">
              参加者の「条件」を選ぶと、ここで遅刻・早退 (出場可能範囲)、出場できないゲーム、出場回数を設定できます。参加者一覧を見ながら調整できます。
            </p>
            <ul className="plain small-text condition-summary">
              {everyone
                .filter((player) => configById.get(player.id)?.include)
                .map((player) => {
                  const notes = describeRestrictions(configById.get(player.id)!, games);
                  return notes.length > 0 ? (
                    <li key={player.id}>
                      <strong>{player.name}</strong> {notes.join(' ・ ')}
                    </li>
                  ) : null;
                })}
            </ul>
          </section>
        )
      ) : null}

      <SectionHeader index={3} kicker="STRATEGY" title="方針" />
      {n01Team && (hasOpponent || draft.preset === 'OPPONENT_OPTIMIZED') ? (
        <div className="opponent-basis" data-testid="setup-opponent">
          <Icon name="target" size={18} />
          <span className="grow">
            {opponent ? (
              <>
                <span className="basis-title">次戦: vs {opponent.opponentName}{opponent.matchDate ? ` (${Number(opponent.matchDate.slice(5, 7))}/${Number(opponent.matchDate.slice(8, 10))})` : ''}</span>
                <span className="basis-note">
                  相手の出場予測を使えます ・ データの信頼度 {CONFIDENCE_LABELS[opponent.confidence]}
                  {opponentSource ? ` ・ ${freshness(opponentSource.generatedAt, Date.now()).label}のデータ` : ''}
                </span>
              </>
            ) : (
              <>
                <span className="basis-title">対戦データ不足</span>
                <span className="basis-note">次戦の相手データがないため、対戦相手最適化は通常の勝利優先で生成します。n01 を再同期してください。</span>
              </>
            )}
          </span>
        </div>
      ) : null}
      <div className="preset-grid" role="radiogroup" aria-label="プリセット" onKeyDown={onRadioGroupKeyDown}>
        {visiblePresets.map((key, index) => {
          const card = PRESET_CARDS[key];
          const selected = draft.preset === key;
          return (
            <button
              type="button"
              key={key}
              role="radio"
              aria-checked={selected}
              tabIndex={rovingTabIndex(selected, index, visiblePresets.includes(draft.preset))}
              className="preset"
              onClick={() => applyPreset(key)}
            >
              <span className="p-head">
                <span className="p-radio" aria-hidden="true" />
                <Icon name={card.icon} size={18} />
                {PRESET_LABELS[key]}
                {selected ? <Icon name="check" size={18} strokeWidth={2.6} className="p-check-mark" /> : null}
              </span>
              <span className="p-desc">
                {key === 'OPPONENT_OPTIMIZED' && !opponent ? '対戦データ不足 (勝利優先で生成)' : card.summary}
              </span>
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
      </div>
      </fieldset>
      </div>

      <div className="action-bar">
        <button
          type="button"
          className="btn primary"
          disabled={generating || locked}
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

      {asking && resolution && format ? (
        (() => {
          const counts = structureCounts(format.games);
          const editable = resolution.kinds
            .filter((row) => row.state === 'pending' || (row.state === 'decided' && row.origin === 'answer'))
            .map((row) => row.kind as AskableKind);
          const kinds = asking === 'generate' ? resolution.pending : editable;
          return (
            <RuleQuestionSheet
              kinds={kinds}
              initial={(store.settings.ruleAnswers?.[resolution.scope]?.caps ?? {}) as Partial<Record<AskableKind, number>>}
              gamesOf={(kind) => counts.get(kind) ?? 0}
              confirmLabel={asking === 'generate' ? 'この条件で生成' : '保存'}
              onCancel={() => setAsking(null)}
              onConfirm={(caps) => {
                const answers = withAnswers(store.settings.ruleAnswers, resolution.scope, caps, Date.now());
                store.updateSettings({ ruleAnswers: answers });
                const mode = asking;
                setAsking(null);
                if (mode === 'generate') {
                  const input = build(resolveOrderRules(format, answers));
                  if (input) onGenerate(input);
                } else toast.show('出場条件を保存しました', 'ok');
              }}
            />
          );
        })()
      ) : null}

      {detailFor && !wide
        ? (() => {
            const config = configById.get(detailFor.id) ?? createParticipantConfig(detailFor.id);
            return (
              <ParticipantDetail
                player={detailFor}
                config={config}
                games={games}
                defaultMaxConsecutive={draft.settings.defaultMaxConsecutive}
                statusRequired={statusRequired}
                onChange={(change) => updateConfig(detailFor.id, change)}
                onClose={() => setDetailFor(null)}
              />
            );
          })()
        : null}

      {guestDraft ? (
        <PlayerEditor
          player={guestDraft}
          isNew
          mode="guest"
          title="今回だけ助っ人を追加"
          saveLabel="助っ人として追加"
          existingNames={everyone.map((entry) => entry.name)}
          onClose={() => setGuestDraft(null)}
          onSave={addGuest}
        />
      ) : null}

      {memberDraft ? (
        <PlayerEditor
          player={memberDraft}
          isNew
          mode="member"
          title="次回から参加するメンバーを追加"
          saveLabel="メンバーに追加"
          existingNames={everyone.map((entry) => entry.name)}
          onClose={() => setMemberDraft(null)}
          onSave={(saved) => {
            // An ordinary roster player from now on, whether or not n01 knows them yet; the
            // roster sync adds them to this order as here today.
            store.savePlayer(finalizeMember(saved));
            // Here today: ticked at once (players that arrive any other way start unticked here).
            onDraftChange({ ...draft, participants: [...draft.participants, createParticipantConfig(saved.id, true)] });
            setMemberDraft(null);
          }}
        />
      ) : null}

      {showPolicy ? (
        <Sheet title="詳細条件" onClose={() => setShowPolicy(false)}>
          <RadioCards
            label="公平性の評価範囲"
            hint="「シーズン込み」にすると、累計出場が少ない選手が優先されます。"
            columns={2}
            value={draft.settings.fairnessScope}
            options={[
              { key: 'today', label: '今回のみ', hint: 'この試合の出場回数で評価' },
              { key: 'season', label: 'シーズン込み', hint: 'シーズン累計も評価に含める' },
            ]}
            onChange={(next: OptimizerSettings['fairnessScope']) =>
              onDraftChange({ ...draft, settings: { ...draft.settings, fairnessScope: next } })
            }
          />

          <RadioCards
            label="最大連続出場の扱い"
            hint="絶対条件にすると必ず守ります。少人数チームでは生成できなくなることがあります。"
            value={draft.settings.consecutiveMode}
            options={[
              { key: 'soft', label: 'できるだけ考慮', hint: '避けられない時は超える' },
              { key: 'hard', label: '絶対条件', hint: '絶対に超えない' },
            ]}
            onChange={(next: OptimizerSettings['consecutiveMode']) =>
              onDraftChange({ ...draft, settings: { ...draft.settings, consecutiveMode: next } })
            }
          />

          <RadioCards
            label="最小出場回数の扱い"
            hint="既定は絶対条件です。満たせない場合は理由を表示します。"
            value={draft.settings.minAppearanceMode}
            options={[
              { key: 'hard', label: '絶対条件', hint: '必ず満たす' },
              { key: 'soft', label: 'できるだけ考慮' },
            ]}
            onChange={(next: OptimizerSettings['minAppearanceMode']) =>
              onDraftChange({ ...draft, settings: { ...draft.settings, minAppearanceMode: next } })
            }
          />

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


/** One of the two matches the new-order SETUP can be for, each with conditions of its own. */
interface MatchSetup {
  draft: SetupDraft;
  match: MatchInfo;
}

type NewOrderMode = 'next' | 'manual';

/** The draft kept in step with the roster and the formats, as the shell keeps its own. */
function resyncSetup(setup: MatchSetup, players: readonly Player[], formatIds: readonly string[]): MatchSetup {
  const formatId = formatIds.includes(setup.draft.formatId) ? setup.draft.formatId : (formatIds[0] ?? '');
  // A member who appears while this page is open (a sync answering late, a member added on
  // another screen) is offered, never ticked behind the captain's back.
  const known = new Set(setup.draft.participants.map((config) => config.playerId));
  const participants = syncParticipants(setup.draft.participants, players, setup.draft.guests).map((config) =>
    known.has(config.playerId) ? config : { ...config, include: false },
  );
  return { ...setup, draft: { ...setup.draft, formatId, participants } };
}

/**
 * ORDER SETUP for a new order, opened from HOME's one button (「次戦のオーダーを作る」 /
 * 「オーダーを作る」).
 *
 * The page opens at once. For an n01 team with a next match the match is fetched here — its
 * state shown at the top — and its opponent, date, managed format, today's attendance and
 * day-of conditions fill the same SETUP fields the captain then edits. 「別の試合を作る」
 * switches the same page to a match set by hand, with conditions of its own: the next
 * match's opponent, date, opponent data, attendance changes and helpers never leak into it,
 * and 「n01の次戦を使う」 returns to the next match as it was left.
 *
 * Nothing is generated until 「オーダーを生成」, and the work already open in this session is
 * left as it is until then: generating asks first when that work is unsaved (`onGenerate`).
 */
export function NewOrderSetup({
  baseDraft,
  currentParticipants,
  working,
  onResume,
  onGenerate,
  generating,
  onNavigate,
}: {
  /** The shell's SETUP draft: a match made by hand starts from it, without its helpers. */
  baseDraft: SetupDraft | null;
  /** The attendance being worked on in this session (the next match starts from it). */
  currentParticipants: readonly ParticipantConfig[] | null;
  /** The order open in this session, if any (offered to resume, never replaced here). */
  working: { label: string } | null;
  onResume: () => void;
  onGenerate: (input: OrderInput, match: MatchInfo, draft: SetupDraft, origin: 'next' | 'other') => void;
  generating: boolean;
  onNavigate: (page: Page) => void;
}): React.JSX.Element | null {
  const store = useAppStore();
  const team = store.activeTeam;
  if (!team) return null;
  return (
    <NewOrderSetupFor
      team={team}
      baseDraft={baseDraft}
      currentParticipants={currentParticipants}
      working={working}
      onResume={onResume}
      onGenerate={onGenerate}
      generating={generating}
      onNavigate={onNavigate}
    />
  );
}

function NewOrderSetupFor({
  team,
  baseDraft,
  currentParticipants,
  working,
  onResume,
  onGenerate,
  generating,
  onNavigate,
}: {
  team: Team;
  baseDraft: SetupDraft | null;
  currentParticipants: readonly ParticipantConfig[] | null;
  working: { label: string } | null;
  onResume: () => void;
  onGenerate: (input: OrderInput, match: MatchInfo, draft: SetupDraft, origin: 'next' | 'other') => void;
  generating: boolean;
  onNavigate: (page: Page) => void;
}): React.JSX.Element {
  const store = useAppStore();
  const sync = useNextMatchSync(team);
  const linked = !!team.n01;
  const intel = activeIntel(store);
  // n01 says there is no match left: the page opens for a match set by hand. Otherwise an
  // n01 team starts from its next match, fetched here if it is not known yet.
  const [mode, setMode] = useState<NewOrderMode>(() => (linked && intel?.nextMatchStatus !== 'none' ? 'next' : 'manual'));
  const [wizard, setWizard] = useState(false);
  const titleRef = useRef<HTMLHeadingElement>(null);
  const formatIds = useMemo(() => store.teamFormats.map((format) => format.id), [store.teamFormats]);

  const [manual, setManual] = useState<MatchSetup>(() => {
    const base: SetupDraft = baseDraft ?? {
      formatId: store.teamFormats[0]?.id ?? '',
      participants: [],
      guests: [],
      preset: store.settings.lastPreset,
      settings: store.settings.optimizer,
    };
    // Without the next match there is no opponent to optimise against.
    const preset = base.preset === 'OPPONENT_OPTIMIZED' ? 'WIN_FIRST' : base.preset;
    const draft: SetupDraft = {
      ...base,
      // A helper plays one order: a new one starts without them.
      guests: [],
      // Another match starts from the roster: nobody's attendance or day-of conditions of the
      // order open in this session (made for its own match) carry over to it.
      participants: syncParticipants([], store.teamPlayers),
      preset,
      settings: { ...base.settings, fairnessScope: scopeForPreset(preset, base.settings.fairnessScope) },
    };
    const leagueName = team.leagueName?.trim() || team.n01?.leagueTitle || '';
    return resyncSetup({ draft, match: createMatchInfo(team.name, leagueName) }, store.teamPlayers, formatIds);
  });
  const [next, setNext] = useState<MatchSetup | null>(null);
  const builtFor = useRef<number | null>(null);

  /** The next match's conditions, exactly as 「次戦のオーダーを作る」 always set them up. */
  const buildNext = useCallback(
    (snapshot: N01MatchIntelligenceSnapshot | null): MatchSetup | null => {
      const format = store.teamFormats.find((entry) => entry.id === team.n01?.managedFormatId) ?? store.teamFormats[0];
      if (!format) return null;
      const players = store.teamPlayers;
      const lastOrder = [...store.teamOrders].sort((a, b) => b.createdAt - a.createdAt)[0] ?? null;
      const here = previousAvailability(players, currentParticipants, lastOrder);
      const order = buildNextMatchOrder({
        team,
        players,
        format,
        pairs: store.teamPairs,
        settings: store.settings,
        intel: snapshot,
        attending: new Set([...here].filter(([, present]) => present).map(([id]) => id)),
        // Day-of conditions (遅刻・早退 …) carry over from last time, as on ORDER SETUP.
        previous: currentParticipants ?? lastOrder?.input.participants ?? [],
      });
      return resyncSetup(
        {
          draft: {
            formatId: order.input.formatId,
            participants: order.input.participants,
            guests: [],
            preset: order.input.preset,
            settings: order.input.settings,
          },
          match: order.match,
        },
        players,
        formatIds,
      );
    },
    [store, team, currentParticipants, formatIds],
  );

  // Starts once per page: the sync (or the data on the device) for the next match. Later
  // starts are the captain's: switching back, 再試行, or the team linked again (`relinked`).
  const startSync = useRef(sync.start);
  startSync.current = sync.start;
  const [relinked, setRelinked] = useState(0);
  const opening = useRef(mode);
  useEffect(() => {
    if (relinked > 0 || opening.current === 'next') startSync.current();
  }, [relinked]);

  // The next match is made with its n01 format only: without it, nothing is generated for it.
  const managedMissing = linked && !store.teamFormats.some((format) => format.id === team.n01?.managedFormatId);

  // The next match is settled: its conditions are built once per sync that settled it — and
  // only with its n01 format (a format arriving later builds them then, never a stand-in).
  useEffect(() => {
    if (sync.phase.kind !== 'ready' || builtFor.current === sync.phase.run || managedMissing) return;
    builtFor.current = sync.phase.run;
    setNext(buildNext(sync.intel));
  }, [sync.phase, sync.intel, buildNext, managedMissing]);

  // n01 has no match left: the same page, set by hand.
  useEffect(() => {
    if (sync.phase.kind === 'noMatch') setMode('manual');
  }, [sync.phase.kind]);

  // Roster or formats changed (a sync adds members, the managed format arrives …).
  useEffect(() => {
    setManual((current) => resyncSetup(current, store.teamPlayers, formatIds));
    setNext((current) => (current ? resyncSetup(current, store.teamPlayers, formatIds) : current));
  }, [store.teamPlayers, formatIds]);

  // A step answered from the status area removes the button that was pressed: focus moves to
  // the match title rather than being lost to the page.
  useEffect(() => {
    if (document.activeElement === document.body || document.activeElement === null) titleRef.current?.focus({ preventScroll: true });
  }, [sync.phase.kind, mode]);

  const pending = isNextMatchPending(sync.phase);
  const locked = mode === 'next' && (pending || next === null || managedMissing);
  // Until the next match is settled the page shows what is known from the device, locked.
  const provisional = useMemo(
    () => (mode === 'next' && next === null ? buildNext(intel?.nextMatchStatus === 'resolved' ? intel : null) : null),
    [mode, next, buildNext, intel],
  );
  const shown: MatchSetup = mode === 'manual' ? manual : (next ?? provisional ?? manual);

  const toManual = (): void => {
    // A fetch still running would answer into a page that is no longer about it.
    if (pending) sync.cancel();
    setMode('manual');
  };
  const toNext = (): void => {
    setMode('next');
    if (sync.phase.kind === 'idle') sync.start();
  };
  const canUseNext = linked && sync.phase.kind !== 'noMatch' && !(sync.phase.kind === 'idle' && intel?.nextMatchStatus === 'none');

  const update = (change: Partial<MatchSetup>): void => {
    if (mode === 'manual') setManual((current) => ({ ...current, ...change }));
    else setNext((current) => (current ? { ...current, ...change } : current));
  };

  const nextMatch = next?.match.opponentName
    ? { opponentName: next.match.opponentName, date: next.match.matchDate }
    : intel?.nextMatchStatus === 'resolved' && intel.nextMatch
      ? { opponentName: intel.nextMatch.opponentName, date: intel.nextMatch.date ?? '' }
      : null;
  const sourceTitle =
    mode === 'manual'
      ? '手動で設定'
      : nextMatch
        ? `vs ${nextMatch.opponentName}`
        : sync.phase.kind === 'pickMatch'
          ? '次戦の候補が複数あります'
          : sync.phase.kind === 'ready'
            ? '次戦の相手データなし'
            : '次戦: 未取得';

  return (
    <>
      <section className="card match-source" aria-labelledby="match-source-title" data-testid="match-source">
        <div className="match-source-top">
          <div className="grow" style={{ minWidth: 0 }}>
            <span className="kicker">{mode === 'next' ? 'n01 の次戦' : '作成する試合'}</span>
            <h2 className="match-source-name" id="match-source-title" tabIndex={-1} ref={titleRef}>
              {sourceTitle}
              {mode === 'next' && nextMatch?.date ? (
                <span className="match-source-date">
                  {' '}
                  {Number(nextMatch.date.slice(5, 7))}/{Number(nextMatch.date.slice(8, 10))}
                </span>
              ) : null}
            </h2>
          </div>
          {mode === 'next' ? (
            <button type="button" className="btn small" onClick={toManual}>
              別の試合を作る
            </button>
          ) : canUseNext ? (
            <button type="button" className="btn small" onClick={toNext}>
              n01の次戦を使う
            </button>
          ) : null}
        </div>
        {mode === 'next' || sync.phase.kind === 'noMatch' ? (
          <NextMatchStatus team={team} sync={sync} onRelink={() => setWizard(true)} />
        ) : null}
        {mode === 'next' && managedMissing ? (
          <p className="notice warn small-text" role="alert">
            n01 のフォーマットがありません。n01 を再同期してください。「別の試合を作る」から手動では作成できます。
          </p>
        ) : null}
      </section>

      {working ? (
        <button type="button" className="resume-card setup-resume" onClick={onResume}>
          <Icon name="target" />
          <span className="grow">
            <span className="title">作業中のオーダーを開く</span>
            <span className="meta">{working.label}</span>
          </span>
          <Icon name="chevronRight" size={18} className="chevron" />
        </button>
      ) : null}

      <SetupPage
        // Each match has its own conditions; a sheet left open on one never edits the other.
        key={mode}
        draft={shown.draft}
        onDraftChange={(draft) => update({ draft })}
        match={shown.match}
        onMatchChange={(match) => update({ match })}
        onGenerate={(input) => {
          // Which match the order is for travels with it (see App's `origin`).
          if (!locked) onGenerate(input, shown.match, shown.draft, mode === 'next' ? 'next' : 'other');
        }}
        generating={generating}
        editing={null}
        onDetach={() => undefined}
        onNavigate={onNavigate}
        // A match set by hand never takes the next match's opponent data.
        opponentIntel={mode === 'next' ? intel : null}
        locked={locked}
        memberAdd
        rosterOnly={mode === 'next'}
      />

      {wizard ? (
        <N01TeamWizard
          mode={{ kind: 'link', team }}
          onClose={() => setWizard(false)}
          onDone={() => {
            setWizard(false);
            // The team is linked again: fetch its next match with the new link.
            setMode('next');
            setRelinked((count) => count + 1);
          }}
        />
      ) : null}
    </>
  );
}
