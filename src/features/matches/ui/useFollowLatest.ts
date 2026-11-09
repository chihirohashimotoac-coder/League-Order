import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';

/**
 * Keeps a live score sheet's own scroll box on its newest row — only while the viewer is
 * looking at the newest row (re-audit U02).
 *
 * - **Following** is decided from where the viewer is, never from what changed: at (or within
 *   about one row of) the bottom of the box, the sheet follows; scrolled further up to read the
 *   history, it does not. The box only scrolls when someone scrolls it, so new rows growing the
 *   content below never read as "the viewer scrolled up".
 * - On every update while following (a new visit, a changed cell in the same row, a corrected or
 *   removed visit), the box is set to its newest row before the browser paints, with no
 *   animation — nothing to pile up, nothing to tone down for reduced motion.
 * - While not following, nothing is moved: the row being read stays put (a box that got shorter
 *   is clamped by the browser to the nearest valid position).
 * - Back at the bottom by hand (mouse, touch, keyboard), it follows again; {@link resume} (the
 *   「最新へ」 button) does the same in one step.
 * - A new game (`game`) starts following again at its newest row; a new leg keeps the viewer's
 *   choice — following goes to the new leg's newest row, reading the history stays reading.
 * - A resize (a phone turned, a PC window widened) keeps a following box on its newest row.
 *
 * Only this element's `scrollTop` is set: the page and any outer sheet never move (no
 * `scrollIntoView`). No timer and no polling: it reacts to the box's own scroll events, to the
 * updates it is given and to the box's size.
 */
export interface FollowLatest<T extends HTMLElement> {
  ref: React.RefObject<T | null>;
  following: boolean;
  /** Back to the newest row, following again. */
  resume: () => void;
}

/** The viewer is "at the newest row" within this much of the bottom (about one row). */
function slack(element: HTMLElement): number {
  const row = element.querySelector('tbody tr:last-child');
  const height = row ? row.getBoundingClientRect().height : 0;
  return Math.max(24, height) + 2;
}

export function atBottom(element: HTMLElement): boolean {
  return element.scrollHeight - element.clientHeight - element.scrollTop <= slack(element);
}

export function useFollowLatest<T extends HTMLElement>(options: {
  /** Off: the box is left alone (Cricket's fixed board, a finished leg shown as history). */
  enabled: boolean;
  /** The game: a new one starts following again. */
  game: string;
  /** Changes with every update of the sheet's content (any value: compared by identity). */
  update: unknown;
}): FollowLatest<T> {
  const { enabled, game, update } = options;
  const ref = useRef<T | null>(null);
  const [following, setFollowingState] = useState(true);
  const followingRef = useRef(true);
  const setFollowing = useCallback((value: boolean) => {
    if (followingRef.current === value) return;
    followingRef.current = value;
    setFollowingState(value);
  }, []);

  // A new game: follow again (decided during render, so the first paint is already right).
  const [shownGame, setShownGame] = useState(game);
  if (shownGame !== game) {
    setShownGame(game);
    followingRef.current = true;
    setFollowingState(true);
  }

  const toLatest = useCallback(() => {
    const element = ref.current;
    if (!element) return;
    // `instant` also cancels a scroll animation still running in the box (a keyboard Home/End).
    if (typeof element.scrollTo === 'function') element.scrollTo({ top: element.scrollHeight, behavior: 'instant' });
    else element.scrollTop = element.scrollHeight;
  }, []);

  // Each update (and the first render, and a new game): to the newest row while following.
  useLayoutEffect(() => {
    if (enabled && followingRef.current) toLatest();
  }, [enabled, game, update, toLatest]);

  // The viewer's own scrolling decides; a resize keeps a following box at the bottom.
  useEffect(() => {
    const element = ref.current;
    if (!enabled || !element) return;
    const onScroll = (): void => setFollowing(atBottom(element));
    element.addEventListener('scroll', onScroll, { passive: true });
    let observer: ResizeObserver | null = null;
    if (typeof ResizeObserver !== 'undefined') {
      observer = new ResizeObserver(() => {
        if (followingRef.current) toLatest();
      });
      observer.observe(element);
    }
    return () => {
      element.removeEventListener('scroll', onScroll);
      observer?.disconnect();
    };
  }, [enabled, game, setFollowing, toLatest]);

  const resume = useCallback(() => {
    setFollowing(true);
    toLatest();
  }, [setFollowing, toLatest]);

  return { ref, following: enabled ? following : true, resume };
}
