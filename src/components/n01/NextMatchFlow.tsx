import { useCallback, useEffect, useRef, useState } from 'react';
import type { ParticipantConfig, Player, Team } from '../../domain/types';
import { DEFAULT_N01_SETTINGS } from '../../domain/types';
import type { N01MatchIntelligenceSnapshot, N01NextMatch } from '../../domain/n01/intelligence';
import { describeChanges, hasImportantChanges } from '../../domain/n01/changes';
import { formatSyncTime, freshness, isLatest } from '../../domain/n01/freshness';
import { buildNextMatchOrder, eligiblePlayers, previousAvailability, type NextMatchOrder } from '../../domain/n01/nextMatch';
import { CONFIDENCE_LABELS } from '../../domain/prediction/confidence';
import { formatStrengthLine } from '../ui';
import { withEffectivePpr } from '../../domain/n01/effectivePpr';
import { describeN01Error } from '../../integrations/n01/client';
import type { N01SyncStep, N01TeamSelection } from '../../integrations/n01/sync';
import { N01_SYNC_STEPS } from '../../integrations/n01/sync';
import { useAppStore } from '../../state/appStore';
import { useN01Environment } from '../../state/n01Environment';
import { useN01FreshSync, useN01LinkResolution, type FreshSyncResult } from '../../state/useN01FreshSync';
import { createId } from '../../utils/id';
import { finalizeMember, isGuest, newGuest, newMember } from '../../domain/players/newPlayer';
import { PlayerEditor } from '../PlayerEditor';
import { PendingLinks } from './PendingLinks';
import { Sheet, useToast } from '../ui';
import { Icon } from '../icons';
import { SyncProgress, type SyncProgressState } from './SyncProgress';

/**
 * 「次戦のオーダーを作る」 (MASTER SPEC Phase 5).
 *
 *   fresh sync → (change summary, only when something important changed)
 *   → (next-match picker, only when ambiguous) → today's attendance → generate
 *
 * When n01 cannot be reached the captain is told when the data on the device was last
 * synced and chooses to continue with it — nothing old is ever presented as current.
 */
type SyncedOk = Extract<FreshSyncResult, { kind: 'ok' }>;

type Phase =
  | { kind: 'syncing' }
  | { kind: 'offline'; message: string }
  | { kind: 'season'; options: { tournamentId: string; title: string; teamTpid: string }[] }
  | { kind: 'notFound' }
  | { kind: 'links'; result: SyncedOk; then: Phase }
  | { kind: 'changes'; lines: string[] }
  | { kind: 'pickMatch'; options: N01NextMatch[] }
  | { kind: 'noMatch' }
  | { kind: 'attendance'; fresh: boolean };

export function NextMatchFlow({
  team,
  currentParticipants,
  onClose,
  onGenerate,
  onRelink,
  onManual,
}: {
  team: Team;
  /** The attendance being worked on in this session, when it belongs to this team. */
  currentParticipants: readonly ParticipantConfig[] | null;
  onClose: () => void;
  onGenerate: (order: NextMatchOrder) => void;
  onRelink: () => void;
  /** Leaves the flow for the ordinary SETUP screen. */
  onManual: () => void;
}): React.JSX.Element {
  const store = useAppStore();
  const env = useN01Environment();
  const freshSync = useN01FreshSync();
  const [phase, setPhase] = useState<Phase>({ kind: 'syncing' });
  const [progress, setProgress] = useState<SyncProgressState>({});
  // The attendance choices live here, not in the attendance step: a re-sync or a trip
  // through the change summary must never undo a tick the captain made, and a guest is a
  // person of this order only — they are held here until the order is generated.
  const [choices, setChoices] = useState<Map<string, boolean>>(new Map());
  const [guests, setGuests] = useState<Player[]>([]);
  const [resolving, setResolving] = useState(false);
  const resolveLinks = useN01LinkResolution();
  const toast = useToast();
  const run = useRef(0);
  const n01Settings = store.settings.n01 ?? DEFAULT_N01_SETTINGS;

  const cache = store.n01CacheFor(team.id);
  const intel = cache.find((record): record is N01MatchIntelligenceSnapshot => record.kind === 'intel') ?? null;
  const lastSync = cache.find((record) => record.kind === 'sync');

  const afterIntel = useCallback((snapshot: N01MatchIntelligenceSnapshot | null, fresh: boolean): Phase => {
    if (snapshot?.nextMatchStatus === 'ambiguous') return { kind: 'pickMatch', options: snapshot.nextMatchOptions };
    if (snapshot?.nextMatchStatus === 'none') return { kind: 'noMatch' };
    return { kind: 'attendance', fresh };
  }, []);

  const sync = useCallback(
    async (selection?: N01TeamSelection, chosenMatchId?: string) => {
      const attempt = ++run.current;
      setPhase({ kind: 'syncing' });
      setProgress({});
      const report = (step: N01SyncStep, status: SyncProgressState[N01SyncStep]): void => {
        if (attempt === run.current && status) setProgress((current) => ({ ...current, [step]: status }));
      };
      try {
        const result = await freshSync(team, { onProgress: report, selection, chosenMatchId, isCurrent: () => attempt === run.current });
        if (!result || attempt !== run.current) return;
        if (result.kind === 'seasonAmbiguous') return setPhase({ kind: 'season', options: result.options });
        if (result.kind === 'teamNotFound') return setPhase({ kind: 'notFound' });
        const next = afterIntel(result.intel, true);
        const staged: Phase =
          hasImportantChanges(result.plan.changes) && next.kind === 'attendance'
            ? { kind: 'changes', lines: describeChanges(result.plan.changes) }
            : next;
        // n01 players who might be members added by hand are confirmed first, never merged
        // or added twice on a guess.
        setPhase(result.plan.roster.pending.length > 0 ? { kind: 'links', result, then: staged } : staged);
      } catch (error) {
        if (attempt === run.current) setPhase({ kind: 'offline', message: describeN01Error(error) });
      }
    },
    [freshSync, team, afterIntel],
  );

  const started = useRef(false);
  useEffect(() => {
    if (started.current) return;
    started.current = true;
    if (n01Settings.autoSync || !intel) void sync();
    // Without auto sync the cached analysis is used; it is "current" only if it was
    // fetched by a successful sync in this session a moment ago.
    else setPhase(afterIntel(intel, isLatest(store.n01SessionSyncAt(team.id), env.now())));
  }, [n01Settings.autoSync, intel, sync, afterIntel, store, team.id, env]);
  useEffect(
    () => () => {
      run.current += 1;
    },
    [],
  );

  return (
    <Sheet title="次戦のオーダーを作る" onClose={onClose} className="next-match-flow">
      {phase.kind === 'syncing' ? <SyncProgress steps={N01_SYNC_STEPS} state={progress} /> : null}

      {phase.kind === 'offline' ? (
        <div className="flow-block" role="alert" data-testid="flow-offline">
          <p className="notice danger">
            <Icon name="alert" size={18} />
            <span className="small-text">{phase.message}</span>
          </p>
          {lastSync ? (
            <p className="body-text">
              前回: <strong>{formatSyncTime(lastSync.fetchedAt)}</strong> ({freshness(lastSync.fetchedAt, env.now()).label}) のデータがあります。
              このデータは最新ではありません。
            </p>
          ) : (
            <p className="body-text">この端末には前回のデータがありません。</p>
          )}
          <div className="flow-actions">
            {lastSync && intel ? (
              <button type="button" className="btn" onClick={() => setPhase(afterIntel(intel, false))}>
                前回データで続ける
              </button>
            ) : (
              <button type="button" className="btn" onClick={onManual}>
                手動で作成
              </button>
            )}
            <button type="button" className="btn primary" onClick={() => void sync()}>
              <Icon name="refresh" size={18} />
              再試行
            </button>
          </div>
        </div>
      ) : null}

      {phase.kind === 'season' ? (
        <div className="flow-block">
          <p className="body-text">このチームは複数の開催中シーズンに登録されています。どのシーズンの試合ですか？</p>
          <ul className="choice-list">
            {phase.options.map((option) => (
              <li key={`${option.tournamentId}:${option.teamTpid}`}>
                <button
                  type="button"
                  className="list-row"
                  onClick={() =>
                    void sync({
                      leagueId: team.n01!.leagueId,
                      leagueTitle: team.n01!.leagueTitle,
                      tournamentId: option.tournamentId,
                      teamTpid: option.teamTpid,
                    })
                  }
                >
                  <span className="grow title">{option.title}</span>
                  <Icon name="chevronRight" size={18} className="chevron" />
                </button>
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {phase.kind === 'notFound' ? (
        <div className="notice warn" role="alert">
          <Icon name="alert" size={18} />
          <span className="grow small-text">
            n01 の現在のシーズンに「{team.n01?.lastTeamName}」が見つかりません。チーム名が変わったか、まだ登録されていない可能性があります。
          </span>
          <button type="button" className="btn small" onClick={onRelink}>
            チームを選び直す
          </button>
        </div>
      ) : null}

      {phase.kind === 'links' ? (
        <PendingLinks
          pending={phase.result.plan.roster.pending}
          busy={resolving}
          onSkip={() => setPhase(phase.then)}
          onApply={(answers) => {
            setResolving(true);
            resolveLinks(team, phase.result, answers)
              .then(() => setPhase(phase.then))
              .catch((error: unknown) => toast.show(`確認内容を保存できませんでした: ${describeN01Error(error)}`, 'error'))
              .finally(() => setResolving(false));
          }}
        />
      ) : null}

      {phase.kind === 'changes' ? (
        <div className="flow-block" data-testid="flow-changes">
          <p className="body-text">
            <strong>n01 で変更がありました</strong>
          </p>
          <ul className="change-list">
            {phase.lines.map((line) => (
              <li key={line}>{line}</li>
            ))}
          </ul>
          <div className="flow-actions">
            <button type="button" className="btn primary" onClick={() => setPhase(afterIntel(intel, true))}>
              確認して続ける
            </button>
          </div>
        </div>
      ) : null}

      {phase.kind === 'pickMatch' ? (
        <div className="flow-block">
          <p className="body-text">次の試合を 1 つに決められませんでした。どの試合のオーダーですか？</p>
          <ul className="choice-list">
            {phase.options.map((option) => (
              <li key={option.matchId}>
                <button type="button" className="list-row" onClick={() => void sync(undefined, option.matchId)}>
                  <span className="grow">
                    <span className="title">vs {option.opponentName}</span>
                    <span className="meta">{option.title}</span>
                  </span>
                  <Icon name="chevronRight" size={18} className="chevron" />
                </button>
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {phase.kind === 'noMatch' ? (
        <div className="flow-block">
          <p className="body-text">このシーズンの残り試合は見つかりませんでした。</p>
          <div className="flow-actions">
            <button type="button" className="btn primary" onClick={onManual}>
              手動でオーダーを作る
            </button>
          </div>
        </div>
      ) : null}

      {phase.kind === 'attendance' ? (
        <Attendance
          team={team}
          intel={intel}
          fresh={phase.fresh}
          currentParticipants={currentParticipants}
          choices={choices}
          onChoices={setChoices}
          guests={guests}
          onGuests={setGuests}
          onGenerate={onGenerate}
        />
      ) : null}
    </Sheet>
  );
}

function Attendance({
  team,
  intel,
  fresh,
  currentParticipants,
  choices,
  onChoices,
  guests,
  onGuests,
  onGenerate,
}: {
  team: Team;
  intel: N01MatchIntelligenceSnapshot | null;
  fresh: boolean;
  currentParticipants: readonly ParticipantConfig[] | null;
  /** The captain’s own ticks; everything else starts from last time (see below). */
  choices: ReadonlyMap<string, boolean>;
  onChoices: (next: Map<string, boolean>) => void;
  guests: readonly Player[];
  onGuests: (next: Player[]) => void;
  onGenerate: (order: NextMatchOrder) => void;
}): React.JSX.Element {
  const store = useAppStore();
  const env = useN01Environment();
  const players = store.players.filter((player) => player.teamId === team.id);
  const lastOrder = store.orders.filter((order) => order.teamId === team.id).sort((a, b) => b.createdAt - a.createdAt)[0] ?? null;
  // Today’s attendance: what the captain ticked, else what they chose last time (a player
  // nobody has chosen for yet is here). A member added from this screen is ticked at once.
  const previous = previousAvailability(players, currentParticipants, lastOrder);
  const isHere = (id: string): boolean => choices.get(id) ?? previous.get(id) ?? false;
  const setHere = (id: string, here: boolean): void => onChoices(new Map(choices).set(id, here));
  const format = store.formats.find((entry) => entry.id === team.n01?.managedFormatId) ?? null;
  const roster = eligiblePlayers(players);
  const everyone = [...roster, ...guests];
  const count = everyone.filter((player) => isHere(player.id)).length;
  const age = intel ? freshness(intel.generatedAt, env.now()) : null;
  const [editor, setEditor] = useState<{ kind: 'guest' | 'member'; player: Player } | null>(null);

  const generate = (): void => {
    if (!format) return;
    const order = buildNextMatchOrder({
      team,
      players,
      guests,
      format,
      pairs: store.pairs.filter((pair) => pair.teamId === team.id),
      settings: store.settings,
      intel,
      attending: new Set(everyone.filter((player) => isHere(player.id)).map((player) => player.id)),
      previous: currentParticipants ?? lastOrder?.input.participants,
    });
    onGenerate(order);
  };

  const blank = { name: '', rating: null, ppr: null, skills: {} };
  const openEditor = (kind: 'guest' | 'member'): void =>
    setEditor({
      kind,
      player:
        kind === 'guest'
          ? newGuest(team.id, createId('gst'), blank, Date.now())
          : newMember(team.id, createId('pl'), blank, Date.now()),
    });

  return (
    <div className="flow-block" data-testid="flow-attendance">
      {intel?.nextMatch ? (
        <div className="next-match-line">
          <span className="kicker">NEXT MATCH</span>
          <strong>vs {intel.nextMatch.opponentName}</strong>
          {intel.nextMatch.date ? <span> {Number(intel.nextMatch.date.slice(5, 7))}/{Number(intel.nextMatch.date.slice(8, 10))}</span> : null}
          <span className="next-match-conf small-text secondary">相手データの信頼度: {CONFIDENCE_LABELS[intel.orderConfidence]}</span>
        </div>
      ) : (
        <p className="small-text">次戦の相手データがないため、勝利優先で作成します。</p>
      )}
      {!fresh && age ? (
        <p className={`stale-note level-${age.level}`} data-testid="flow-stale">
          <Icon name="alert" size={16} /> {age.label} ({intel ? formatSyncTime(intel.generatedAt) : ''}) のデータを使用しています。最新ではありません。
        </p>
      ) : null}
      <p className="attendance-title">
        本日参加 <span className="badge">{count} / {everyone.length}</span>
      </p>
      <ul className="attendance" aria-label="本日の参加者">
        {everyone.map((player) => (
          <li key={player.id}>
            <label>
              <input type="checkbox" checked={isHere(player.id)} onChange={(event) => setHere(player.id, event.target.checked)} />
              <span className="grow">
                {player.name}
                {isGuest(player) ? <span className="n01-tag guest-tag" data-testid="guest-tag">助っ人 (今回のみ)</span> : null}
                {!isGuest(player) && !player.n01 ? <span className="n01-tag muted-tag" data-testid="manual-tag">n01 未連携</span> : null}
              </span>
              <span className="small-text secondary">{formatStrengthLine(withEffectivePpr(player))}</span>
            </label>
            {isGuest(player) ? (
              <button
                type="button"
                className="btn small"
                onClick={() => onGuests(guests.filter((entry) => entry.id !== player.id))}
                aria-label={`助っ人 ${player.name} を外す`}
              >
                外す
              </button>
            ) : null}
          </li>
        ))}
      </ul>
      <div className="flow-actions add-people">
        <button type="button" className="btn small" onClick={() => openEditor('guest')}>
          <Icon name="plus" size={16} strokeWidth={2.6} />
          今回だけ助っ人を追加
        </button>
        <button type="button" className="btn small" onClick={() => openEditor('member')}>
          <Icon name="plus" size={16} strokeWidth={2.6} />
          次回から参加するメンバーを追加
        </button>
      </div>
      {!format ? <p className="notice warn small-text">n01 のフォーマットがありません。n01 を再同期してください。</p> : null}
      <div className="flow-actions sticky">
        <button type="button" className="btn primary grow" onClick={generate} disabled={!format || count === 0}>
          <Icon name="target" size={18} />
          このメンバーで作成
        </button>
      </div>

      {editor ? (
        <PlayerEditor
          player={editor.player}
          isNew
          mode={editor.kind}
          title={editor.kind === 'guest' ? '今回だけ助っ人を追加' : '次回から参加するメンバーを追加'}
          saveLabel={editor.kind === 'guest' ? '助っ人として追加' : 'メンバーに追加'}
          existingNames={everyone.map((entry) => entry.name)}
          onClose={() => setEditor(null)}
          onSave={(saved) => {
            if (editor.kind === 'guest') {
              onGuests([...guests, saved]);
            } else {
              // An ordinary roster player from now on, whether or not n01 knows them yet.
              store.savePlayer(finalizeMember(saved));
            }
            setHere(saved.id, true);
            setEditor(null);
          }}
        />
      ) : null}
    </div>
  );
}
