import { useEffect, useMemo, useRef, useState } from 'react';
import type { Team } from '../../domain/types';
import { DARTS_DISCIPLINE_LABELS } from '../../domain/types';
import { suggestLinks } from '../../domain/n01/roster';
import { divisionLabel } from '../../domain/n01/division';
import { formatPpr } from '../../domain/players/strength';
import { describeN01Error } from '../../integrations/n01/client';
import { KNOWN_LEAGUES, parseLeagueReference } from '../../integrations/n01/leagueRegistry';
import type { LeagueBrowse, N01SyncPlan, N01SyncStep, N01TeamData, N01TeamSelection } from '../../integrations/n01/sync';
import type { TeamChoice } from '../../integrations/n01/teamResolver';
import type { N01LeagueSummary } from '../../integrations/n01/types';
import { describeFormat } from '../../integrations/n01/formatResolver';
import { rosterSource } from '../../integrations/n01/rosterResolver';
import { useAppStore } from '../../state/appStore';
import { useN01Sync } from '../../state/useN01Sync';
import { DisciplineBadge, Field, Sheet, useToast } from '../ui';
import { Icon } from '../icons';
import { SyncProgress, type SyncProgressState } from './SyncProgress';

/**
 * "n01から作成" / "n01と接続" (MASTER SPEC Phase 1 §13–§14).
 *
 * The captain chooses a league and a team — nothing else. Season, division, roster, PPR,
 * discipline and format are resolved from n01 and shown in a preview; nothing is stored
 * until the preview is confirmed, and then everything is stored in one batch.
 *
 * Linking an existing team adds one step: each n01 player is matched to a local player
 * (by opid or exact name where that is unambiguous) or added as new, and the captain can
 * change every match. Local Rating, aptitudes, notes and season counts are kept.
 */
export type N01WizardMode = { kind: 'create' } | { kind: 'link'; team: Team };

type Step = 'league' | 'team' | 'season' | 'review';

const PREVIEW_STEPS: readonly N01SyncStep[] = ['season', 'team', 'roster', 'ppr', 'format'];

export function N01TeamWizard({
  mode,
  onClose,
  onDone,
}: {
  mode: N01WizardMode;
  onClose: () => void;
  onDone: (team: Team) => void;
}): React.JSX.Element {
  const sync = useN01Sync();
  const store = useAppStore();
  const toast = useToast();
  const [step, setStep] = useState<Step>('league');
  const [league, setLeague] = useState<N01LeagueSummary | null>(null);
  const [browse, setBrowse] = useState<LeagueBrowse | null>(null);
  const [choice, setChoice] = useState<TeamChoice | null>(null);
  const [selection, setSelection] = useState<N01TeamSelection | null>(null);
  const [data, setData] = useState<N01TeamData | null>(null);
  const [progress, setProgress] = useState<SyncProgressState>({});
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [explicit, setExplicit] = useState<Map<string, string | null> | null>(null);
  /** The new team being created (its id is minted once per fetch). */
  const [draftTeam, setDraftTeam] = useState<Team | null>(null);
  /** Bumped by "再試行" so a failed fetch actually runs again. */
  const [retry, setRetry] = useState(0);
  const attempt = useRef(0);

  const linkTeam = mode.kind === 'link' ? mode.team : null;
  const localPlayers = useMemo(
    () => (linkTeam ? store.players.filter((player) => player.teamId === linkTeam.id) : []),
    [linkTeam, store.players],
  );

  // League → team list.
  useEffect(() => {
    if (step !== 'team' || !league || browse) return;
    const run = ++attempt.current;
    setLoading(true);
    setError(null);
    sync
      .browse(league.leagueId, league.title)
      .then((result) => {
        if (run === attempt.current) setBrowse(result);
      })
      .catch((reason: unknown) => {
        if (run === attempt.current) setError(describeN01Error(reason));
      })
      .finally(() => {
        if (run === attempt.current) setLoading(false);
      });
  }, [step, league, browse, sync, retry]);

  // Team → everything else.
  useEffect(() => {
    if (step !== 'review' || !selection || data) return;
    const run = ++attempt.current;
    setLoading(true);
    setError(null);
    setProgress({});
    sync
      .fetch(selection, (key, status) => {
        if (run === attempt.current) setProgress((current) => ({ ...current, [key]: status }));
      })
      .then((result) => {
        if (run !== attempt.current) return;
        setData(result);
        setDraftTeam(sync.newTeam(result));
        if (linkTeam) {
          const source = rosterSource(result.roster, result.stats, result.tournament.tournamentId, 0);
          setExplicit(suggestLinks(localPlayers, source));
        }
      })
      .catch((reason: unknown) => {
        if (run === attempt.current) setError(describeN01Error(reason));
      })
      .finally(() => {
        if (run === attempt.current) setLoading(false);
      });
  }, [step, selection, data, sync, linkTeam, localPlayers, retry]);

  const plan: N01SyncPlan | null = useMemo(() => {
    const team = linkTeam ?? draftTeam;
    if (!data || !team) return null;
    return sync.plan(team, data, explicit ?? undefined);
  }, [data, explicit, linkTeam, draftTeam, sync]);

  const chooseLeague = (next: N01LeagueSummary): void => {
    setLeague(next);
    setBrowse(null);
    setChoice(null);
    setSelection(null);
    setData(null);
    setStep('team');
  };

  const chooseTeam = (next: TeamChoice): void => {
    setChoice(next);
    setData(null);
    if (next.seasons.length > 1) {
      setStep('season');
      return;
    }
    chooseSeason(next, 0);
  };

  const chooseSeason = (target: TeamChoice, index: number): void => {
    if (!league) return;
    const season = target.seasons[index];
    setSelection({ leagueId: league.leagueId, leagueTitle: league.title, tournamentId: season.tournamentId, teamTpid: season.teamId });
    setData(null);
    setStep('review');
  };

  const back = (): void => {
    attempt.current += 1;
    setError(null);
    setLoading(false);
    if (step === 'review') setStep(choice && choice.seasons.length > 1 ? 'season' : 'team');
    else if (step === 'season') setStep('team');
    else if (step === 'team') setStep('league');
    else onClose();
  };

  const save = (): void => {
    if (!plan) return;
    if (linkTeam && hasDuplicateTargets(explicit)) {
      toast.show('同じメンバーに複数の n01 選手が割り当てられています', 'error');
      return;
    }
    setSaving(true);
    void (async () => {
      // The first look at the next match is best effort: the team is created either way.
      const intel = data
        ? await sync.intelligence(plan.team.id, data, plan.format).then(
            (result) => result.snapshot,
            () => null,
          )
        : null;
      try {
        await sync.apply(plan, { activate: mode.kind === 'create', extraCache: intel ? [intel] : [] });
      } catch {
        setSaving(false);
        return;
      }
      toast.show(mode.kind === 'create' ? `${plan.team.name} を作成しました` : `${plan.team.name} を n01 と接続しました`, 'ok');
      onDone(plan.team);
    })();
  };

  const title = mode.kind === 'create' ? 'n01から作成' : 'n01と接続';

  return (
    <Sheet
      title={title}
      onClose={onClose}
      className="n01-wizard"
      footer={
        <>
          <button type="button" className="btn" onClick={back} disabled={saving}>
            {step === 'league' ? 'キャンセル' : '戻る'}
          </button>
          {step === 'review' ? (
            <button type="button" className="btn primary grow" onClick={save} disabled={!plan || saving || loading}>
              {saving ? <span className="spinner" aria-hidden="true" /> : <Icon name="check" size={18} strokeWidth={2.6} />}
              {mode.kind === 'create' ? 'このチームを作成' : 'n01と接続する'}
            </button>
          ) : null}
        </>
      }
    >
      <ol className="steps compact" aria-label="手順">
        {(['league', 'team', 'review'] as const).map((key, index) => (
          <li key={key} aria-current={step === key || (key === 'team' && step === 'season') ? 'step' : undefined}>
            {index + 1}. {key === 'league' ? 'リーグ' : key === 'team' ? 'チーム' : mode.kind === 'create' ? '確認' : '選手の対応'}
          </li>
        ))}
      </ol>

      {step === 'league' ? <LeagueStep onChoose={chooseLeague} /> : null}

      {step === 'team' ? (
        <section aria-labelledby="n01-team-title">
          <h3 id="n01-team-title" className="wizard-title">
            {league?.title} のチームを選択
          </h3>
          {loading ? <Loading label="チーム一覧を取得しています" /> : null}
          {error ? <ErrorBox message={error} onRetry={() => setRetry((count) => count + 1)} /> : null}
          {browse ? (
            <>
              <p className="tiny muted">
                シーズン: {browse.candidates.map((t) => t.title).join(' / ')}
              </p>
              <TeamList choices={browse.choices} onChoose={chooseTeam} />
            </>
          ) : null}
        </section>
      ) : null}

      {step === 'season' && choice ? (
        <section aria-labelledby="n01-season-title">
          <h3 id="n01-season-title" className="wizard-title">
            シーズンを選択
          </h3>
          <p className="tiny muted">{choice.name} は複数の開催中シーズンに登録されています。</p>
          <ul className="choice-list">
            {choice.seasons.map((season, index) => (
              <li key={season.tournamentId}>
                <button type="button" className="list-row" onClick={() => chooseSeason(choice, index)}>
                  <span className="grow">
                    <span className="title">{season.tournamentTitle}</span>
                    <span className="meta">{season.division ? divisionLabel(season.division.title) : 'ディビジョンなし'}</span>
                  </span>
                  <Icon name="chevronRight" size={18} className="chevron" />
                </button>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {step === 'review' ? (
        <section aria-labelledby="n01-review-title">
          <h3 id="n01-review-title" className="wizard-title">
            {mode.kind === 'create' ? '内容を確認' : '選手の対応を確認'}
          </h3>
          {loading ? <SyncProgress steps={PREVIEW_STEPS} state={progress} /> : null}
          {error ? <ErrorBox message={error} onRetry={() => setRetry((count) => count + 1)} /> : null}
          {plan && data ? (
            <>
              <TeamPreview plan={plan} data={data} />
              {linkTeam && explicit ? (
                <PlayerMapping
                  data={data}
                  localPlayers={localPlayers}
                  explicit={explicit}
                  onChange={(oid, target) => setExplicit(new Map(explicit).set(oid, target))}
                />
              ) : null}
            </>
          ) : null}
        </section>
      ) : null}
    </Sheet>
  );
}

function hasDuplicateTargets(explicit: Map<string, string | null> | null): boolean {
  if (!explicit) return false;
  const targets = [...explicit.values()].filter((value): value is string => value !== null);
  return new Set(targets).size !== targets.length;
}

function Loading({ label }: { label: string }): React.JSX.Element {
  return (
    <div className="loading inline" role="status">
      <span className="spinner" aria-hidden="true" />
      <span>{label}</span>
    </div>
  );
}

function ErrorBox({ message, onRetry }: { message: string; onRetry: () => void }): React.JSX.Element {
  return (
    <div className="notice danger" role="alert">
      <Icon name="alert" size={18} />
      <span className="grow small-text">{message}</span>
      <button type="button" className="btn small" onClick={onRetry}>
        再試行
      </button>
    </div>
  );
}

function LeagueStep({ onChoose }: { onChoose: (league: N01LeagueSummary) => void }): React.JSX.Element {
  const sync = useN01Sync();
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<N01LeagueSummary[] | null>(null);
  const [searching, setSearching] = useState(false);
  const [searchError, setSearchError] = useState<string | null>(null);
  const [reference, setReference] = useState('');
  const [referenceError, setReferenceError] = useState<string | null>(null);

  const search = (): void => {
    if (!query.trim()) return;
    setSearching(true);
    setSearchError(null);
    sync
      .searchLeagues(query.trim())
      .then(setResults)
      .catch((reason: unknown) => setSearchError(describeN01Error(reason)))
      .finally(() => setSearching(false));
  };

  return (
    <section aria-labelledby="n01-league-title">
      <h3 id="n01-league-title" className="wizard-title">
        リーグを選択
      </h3>
      <div className="league-quick" role="group" aria-label="よく使うリーグ">
        {KNOWN_LEAGUES.map((entry) => (
          <button
            type="button"
            key={entry.leagueId}
            className="league-chip"
            onClick={() => onChoose({ leagueId: entry.leagueId, title: entry.title })}
          >
            <Icon name="trophy" size={18} />
            {entry.title}
          </button>
        ))}
      </div>

      <details className="disclosure">
        <summary>
          <Icon name="plus" />
          <span className="grow">その他のリーグ</span>
          <Icon name="chevronDown" className="chev" />
        </summary>
        <div className="disclosure-body">
          <Field label="リーグ名で検索">
            <span className="row" style={{ gap: 8 }}>
              <input
                type="search"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') search();
                }}
                placeholder="例: ATDO"
              />
              <button type="button" className="btn small" onClick={search} disabled={searching}>
                検索
              </button>
            </span>
          </Field>
          {searchError ? <p className="tiny danger-text" role="alert">{searchError}</p> : null}
          {results ? (
            results.length === 0 ? (
              <p className="tiny muted">見つかりませんでした。</p>
            ) : (
              <ul className="choice-list">
                {results.map((entry) => (
                  <li key={entry.leagueId}>
                    <button type="button" className="list-row" onClick={() => onChoose(entry)}>
                      <span className="grow">
                        <span className="title">{entry.title}</span>
                        <span className="meta">{entry.leagueId}</span>
                      </span>
                      <Icon name="chevronRight" size={18} className="chevron" />
                    </button>
                  </li>
                ))}
              </ul>
            )
          ) : null}

          <Field label="リーグ ID / n01 の URL" hint="https://n01darts.com の URL、または lg_xxxx_1234 の形式">
            <span className="row" style={{ gap: 8 }}>
              <input
                type="text"
                value={reference}
                onChange={(event) => {
                  setReference(event.target.value);
                  setReferenceError(null);
                }}
                autoComplete="off"
                spellCheck={false}
              />
              <button
                type="button"
                className="btn small"
                onClick={() => {
                  const parsed = parseLeagueReference(reference);
                  if (parsed.ok) onChoose({ leagueId: parsed.leagueId, title: '' });
                  else setReferenceError(parsed.message);
                }}
              >
                決定
              </button>
            </span>
          </Field>
          {referenceError ? <p className="tiny danger-text" role="alert">{referenceError}</p> : null}
        </div>
      </details>
      <p className="tiny muted">n01 の公開データを読み取るだけで、n01 へ書き込むことはありません。</p>
    </section>
  );
}

function TeamList({ choices, onChoose }: { choices: TeamChoice[]; onChoose: (choice: TeamChoice) => void }): React.JSX.Element {
  const groups = new Map<string, TeamChoice[]>();
  for (const choice of choices) {
    const key = choice.seasons[0]?.division?.title ?? '—';
    groups.set(key, [...(groups.get(key) ?? []), choice]);
  }
  return (
    <>
      {[...groups.entries()].map(([division, list]) => (
        <div key={division} className="team-group">
          <p className="kicker">{division === '—' ? 'ディビジョンなし' : `${division} DIVISION`}</p>
          <ul className="choice-list">
            {list.map((choice) => (
              <li key={`${choice.identity.kind}:${choice.identity.value}`}>
                <button type="button" className="list-row" onClick={() => onChoose(choice)}>
                  <span className="grow">
                    <span className="title">{choice.name}</span>
                    {choice.seasons.length > 1 ? <span className="meta">{choice.seasons.length} シーズンに登録</span> : null}
                  </span>
                  <Icon name="chevronRight" size={18} className="chevron" />
                </button>
              </li>
            ))}
          </ul>
        </div>
      ))}
    </>
  );
}

function TeamPreview({ plan, data }: { plan: N01SyncPlan; data: N01TeamData }): React.JSX.Element {
  return (
    // Focusable so the preview can be scrolled from the keyboard (it holds no controls).
    <div className="n01-preview" data-testid="n01-preview" role="region" aria-label="取り込む内容" tabIndex={0}>
      <dl className="preview-grid">
        <dt>Team</dt>
        <dd>{data.entry.name}</dd>
        <dt>League</dt>
        <dd>{data.league.title}</dd>
        <dt>Season</dt>
        <dd>{data.tournament.title}</dd>
        <dt>Division</dt>
        <dd>{data.division?.title ?? '—'}</dd>
        <dt>種別</dt>
        <dd>
          <DisciplineBadge discipline={plan.format.discipline} /> {DARTS_DISCIPLINE_LABELS[plan.format.discipline]}
        </dd>
        <dt>Players</dt>
        <dd>{data.roster.length} 名</dd>
        <dt>PPR</dt>
        <dd>
          {plan.snapshot.pprCount} / {plan.snapshot.rosterCount} 名が n01 から取得
        </dd>
        <dt>Format</dt>
        <dd>{describeFormat(plan.format.games)}</dd>
      </dl>
      <ul className="preview-roster" aria-label="メンバー">
        {rosterSource(data.roster, data.stats, data.tournament.tournamentId, 0).map((player) => (
          <li key={player.oid}>
            <span className="grow">{player.name}</span>
            <span className={player.stats?.ppr == null ? 'muted' : ''}>
              {player.stats?.ppr == null ? 'PPR なし' : formatPpr(player.stats.ppr)}
            </span>
          </li>
        ))}
      </ul>
      <p className="tiny muted">
        Rating・適性・ペア相性・メモはこのアプリだけで管理します (n01 には送信しません)。
      </p>
    </div>
  );
}

function PlayerMapping({
  data,
  localPlayers,
  explicit,
  onChange,
}: {
  data: N01TeamData;
  localPlayers: readonly { id: string; name: string }[];
  explicit: Map<string, string | null>;
  onChange: (oid: string, target: string | null) => void;
}): React.JSX.Element {
  return (
    <div className="player-mapping">
      <p className="small-text">
        n01 の選手をこのチームのメンバーへ対応付けます。自動では opid と完全一致の名前だけを使います。
      </p>
      <ul>
        {data.roster.map((player) => {
          const target = explicit.get(player.oid) ?? null;
          const id = `map-${player.oid}`;
          return (
            <li key={player.oid}>
              <label htmlFor={id} className="grow">
                {player.name}
              </label>
              <select
                id={id}
                value={target ?? ''}
                onChange={(event) => onChange(player.oid, event.target.value === '' ? null : event.target.value)}
              >
                <option value="">新しいメンバーとして追加</option>
                {localPlayers.map((local) => (
                  <option key={local.id} value={local.id}>
                    {local.name}
                  </option>
                ))}
              </select>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
