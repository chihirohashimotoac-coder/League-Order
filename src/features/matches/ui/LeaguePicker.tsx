import { useState } from 'react';
import { KNOWN_LEAGUES, parseLeagueReference } from '../../../integrations/n01/leagueRegistry';
import { describeN01Error } from '../../../integrations/n01/client';
import { useN01Environment } from '../../../state/n01Environment';
import type { WatchSettings } from '../../../domain/types';

/**
 * Picks the league to watch: the known leagues in one tap, any other n01 League by name, id
 * or page link. Nothing is stored here; `onPick` gets the league.
 */
export function LeaguePicker({ onPick, current }: { onPick: (league: WatchSettings) => void; current?: string | null }): React.JSX.Element {
  const environment = useN01Environment();
  const [query, setQuery] = useState('');
  const [state, setState] = useState<{ kind: 'idle' } | { kind: 'busy' } | { kind: 'error'; message: string } | { kind: 'hits'; hits: WatchSettings[] }>({ kind: 'idle' });

  const search = async (): Promise<void> => {
    const text = query.trim();
    if (!text) return;
    const reference = parseLeagueReference(text);
    if (reference.ok) {
      onPick({ leagueId: reference.leagueId, leagueTitle: KNOWN_LEAGUES.find((league) => league.leagueId === reference.leagueId)?.title ?? reference.leagueId });
      return;
    }
    if (/^[a-z]+:/iu.test(text)) {
      setState({ kind: 'error', message: reference.message });
      return;
    }
    setState({ kind: 'busy' });
    try {
      const hits = await environment.createClient().searchLeagues(text);
      setState({ kind: 'hits', hits: hits.slice(0, 20).map((hit) => ({ leagueId: hit.leagueId, leagueTitle: hit.title })) });
    } catch (error) {
      setState({ kind: 'error', message: describeN01Error(error) });
    }
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
            onClick={() => onPick({ leagueId: league.leagueId, leagueTitle: league.title })}
          >
            {league.title}
          </button>
        ))}
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
          placeholder="ほかのリーグ: 名前・リーグID・n01 の URL"
          aria-label="リーグを検索"
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
              <li key={hit.leagueId}>
                <button type="button" className="btn ghost small" onClick={() => onPick(hit)}>
                  {hit.leagueTitle}
                </button>
              </li>
            ))}
          </ul>
        )
      ) : null}
    </div>
  );
}
