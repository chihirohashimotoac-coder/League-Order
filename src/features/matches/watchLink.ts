import { useMemo, useSyncExternalStore } from 'react';

/**
 * A link to what is shown in 観戦: a league season, one of its cards (対戦カード), a game of
 * that card, a tournament, or one game by its match id. The link lives in the URL fragment
 * (`#/watch?...`), so it works under any path the app is served from (GitHub Pages' project
 * sub-path included), survives a reload and opens in a new tab.
 *
 * Only public n01 identifiers are ever written: league id, tournament id, card key
 * (`<division>_<lsid>`), game slot id, match id. Nothing of the viewer's own data.
 */
export interface WatchLink {
  /** `lgid` of the league. */
  league?: string;
  /** `tdid` of the league's season (or its event). */
  season?: string;
  /** `tdid` of a tournament watched on its own. */
  tournament?: string;
  /** `<divisionIndex>_<lsid>` of a league card. */
  card?: string;
  /** `schid` of the game opened inside the card. */
  game?: string;
  /** `mid` of one game (a tournament match, an n01 Online / Live game). */
  mid?: string;
}

const PREFIX = '#/watch';
const TOKEN = /^[A-Za-z0-9_-]{1,80}$/u;
const KEYS: [keyof WatchLink, string][] = [
  ['league', 'l'],
  ['season', 't'],
  ['tournament', 'k'],
  ['card', 'c'],
  ['game', 'g'],
  ['mid', 'm'],
];

/** The link in a URL fragment, or `null` when the fragment is not a watch link. Unknown or malformed values are dropped. */
export function parseWatchLink(hash: string): WatchLink | null {
  if (hash !== PREFIX && !hash.startsWith(`${PREFIX}?`)) return null;
  const params = new URLSearchParams(hash.slice(PREFIX.length + 1));
  const link: WatchLink = {};
  for (const [key, param] of KEYS) {
    const value = params.get(param);
    if (value && TOKEN.test(value)) link[key] = value;
  }
  // A card or a game needs its season; a game needs its card.
  if (!link.season) delete link.card;
  if (!link.card) delete link.game;
  return link;
}

export function formatWatchLink(link: WatchLink): string {
  const params = new URLSearchParams();
  for (const [key, param] of KEYS) {
    const value = link[key];
    if (value && TOKEN.test(value)) params.set(param, value);
  }
  const query = params.toString();
  return query ? `${PREFIX}?${query}` : PREFIX;
}

/** The full address of a link, for copying: the page as it is served plus the fragment. */
export function watchLinkUrl(link: WatchLink): string {
  if (typeof window === 'undefined') return formatWatchLink(link);
  return `${window.location.origin}${window.location.pathname}${window.location.search}${formatWatchLink(link)}`;
}

// ---------------------------------------------------------------------------
// The current link (browser history)
// ---------------------------------------------------------------------------

const listeners = new Set<() => void>();
const notify = (): void => listeners.forEach((listener) => listener());
const currentHash = (): string => (typeof window === 'undefined' ? '' : window.location.hash);

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  window.addEventListener('popstate', listener);
  window.addEventListener('hashchange', listener);
  return () => {
    listeners.delete(listener);
    window.removeEventListener('popstate', listener);
    window.removeEventListener('hashchange', listener);
  };
}

export function readWatchLink(): WatchLink | null {
  return parseWatchLink(currentHash());
}

/** The link in the address bar, re-read on back / forward and on every change made here. */
export function useWatchLink(): WatchLink | null {
  const hash = useSyncExternalStore(subscribe, currentHash, () => '');
  return useMemo(() => parseWatchLink(hash), [hash]);
}

interface LinkState {
  /** How many entries this app pushed on top of the page it was opened on. */
  watchDepth?: number;
}

const depth = (): number => ((window.history.state as LinkState | null)?.watchDepth ?? 0);
const bare = (): string => `${window.location.pathname}${window.location.search}`;

/** Opens something from a list: a new history entry, so the browser's back returns to the list. */
export function pushWatchLink(link: WatchLink): void {
  window.history.pushState({ watchDepth: depth() + 1 } satisfies LinkState, '', formatWatchLink(link));
  notify();
}

/** Changes what the current entry points at (a game inside the open card, another season). */
export function replaceWatchLink(link: WatchLink | null): void {
  window.history.replaceState({ watchDepth: depth() } satisfies LinkState, '', link ? formatWatchLink(link) : bare());
  notify();
}

/**
 * Back to the list. An entry this app pushed is popped, exactly like the browser's back button;
 * a link opened directly (new tab, reload) has no list behind it, so its entry is rewritten to
 * `fallback` (the list the detail belongs to) instead of leaving the app.
 */
export function closeWatchLink(fallback: WatchLink | null): void {
  if (depth() > 0) window.history.back();
  else replaceWatchLink(fallback);
}
