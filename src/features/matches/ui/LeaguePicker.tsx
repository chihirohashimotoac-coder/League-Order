import { useState } from 'react';
import { KNOWN_LEAGUES } from '../../../integrations/n01/leagueRegistry';
import { describeN01Error } from '../../../integrations/n01/client';
import { useN01Environment } from '../../../state/n01Environment';
import type { WatchSettings } from '../../../domain/types';
import { useMatchesApiFactory } from '../environment';
import { parseCompetitionReference } from '../competition';

/**
 * What to watch: a league (its seasons), a tournament or event, or one match. The known
 * leagues are one tap; anything else on n01 by name, id or page link. Leagues and tournaments
 * are searched together.
 */

interface Hit {
  target: WatchSettings;
  note: string;
}

const STATUS: Record<number, string> = { 10: '準備中', 20: '受付中', 25: '作成中', 30: '開催中', 40: '終了' };

export function LeaguePicker({
  onPick,
  onMatch,
  onNow,
  current,
}: {
  onPick: (target: WatchSettings) => void;
  /** A pasted match id or link: open that one game. */
  onMatch?: (mid: string) => void;
  /** Browse what is being played on n01 right now. */
  onNow?: () => void;
  current?: string | null;
}): React.JSX.Element {
  const environment = useN01Environment();
  const factory = useMatchesApiFactory();
  const [query, setQuery] = useState('');
  const [state, setState] = useState<{ kind: 'idle' } | { kind: 'busy' } | { kind: 'error'; message: string } | { kind: 'hits'; hits: Hit[] }>({ kind: 'idle' });

  const search = async (): Promise<void> => {
    const text = query.trim();
    if (!text) return;
    const reference = parseCompetitionReference(text);
    if (reference?.kind === 'league') {
      onPick({ kind: 'league', id: reference.id, title: KNOWN_LEAGUES.find((league) => league.leagueId === reference.id)?.title ?? reference.id });
      return;
    }
    if (reference?.kind === 'tournament') {
      onPick({ kind: 'tournament', id: reference.id, title: reference.id });
      return;
    }
    if (reference?.kind === 'match' && onMatch) {
      onMatch(reference.id);
      return;
    }
    if (/^[a-z]+:/iu.test(text)) {
      setState({ kind: 'error', message: 'リンクからリーグ・大会・試合の ID を読み取れませんでした。' });
      return;
    }
    setState({ kind: 'busy' });
    const [leagues, tournaments] = await Promise.allSettled([environment.createClient().searchLeagues(text), factory().searchCompetitions(text)]);
    if (leagues.status === 'rejected' && tournaments.status === 'rejected') {
      setState({ kind: 'error', message: describeN01Error(leagues.reason) });
      return;
    }
    const hits: Hit[] = [
      ...(leagues.status === 'fulfilled' ? leagues.value.slice(0, 15).map((hit) => ({ target: { kind: 'league' as const, id: hit.leagueId, title: hit.title || hit.leagueId }, note: 'リーグ' })) : []),
      ...(tournaments.status === 'fulfilled'
        ? tournaments.value
            .filter((hit) => !hit.leagueId)
            .slice(0, 25)
            .map((hit) => ({ target: { kind: 'tournament' as const, id: hit.tdid, title: hit.title || hit.tdid }, note: `大会 ・ ${STATUS[hit.status ?? 0] ?? ''}` }))
        : []),
    ];
    setState({ kind: 'hits', hits });
  };

  return (
    <div className="league-picker">
      <div className="chip-row" role="group" aria-label="よく使われるリーグ">
        {KNOWN_LEAGUES.map((league) => (
          <button
            key={league.leagueId}
            type="button"
            className="chip"
            aria-pressed={current === league.leagueId}
            onClick={() => onPick({ kind: 'league', id: league.leagueId, title: league.title })}
          >
            {league.title}
          </button>
        ))}
        {onNow ? (
          <button type="button" className="chip" onClick={onNow}>
            いま n01 で進行中
          </button>
        ) : null}
      </div>
      <form
        className="row"
        style={{ gap: 8 }}
        onSubmit={(event) => {
          event.preventDefault();
          void search();
        }}
      >
        <input
          id="league-search"
          className="grow"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="リーグ・大会の名前、ID、n01 の URL"
          aria-label="リーグ・大会を検索"
          enterKeyHint="search"
        />
        <button type="submit" className="btn" disabled={state.kind === 'busy' || !query.trim()}>
          検索
        </button>
      </form>
      {state.kind === 'error' ? (
        <p className="small-text" role="alert">
          {state.message}
        </p>
      ) : null}
      {state.kind === 'hits' ? (
        state.hits.length === 0 ? (
          <p className="small-text muted">見つかりませんでした。</p>
        ) : (
          <ul className="league-hits">
            {state.hits.map((hit) => (
              <li key={`${hit.target.kind}:${hit.target.id}`}>
                <button type="button" className="btn ghost small" onClick={() => onPick(hit.target)}>
                  {hit.target.title} <span className="muted small-text">({hit.note})</span>
                </button>
              </li>
            ))}
          </ul>
        )
      ) : null}
    </div>
  );
}
