import { useEffect, useState } from 'react';

/**
 * Whether a CSS media query matches, kept in step with the window. Where `matchMedia` does not
 * exist (tests, very old browsers) the answer is `false`: every caller treats that as the
 * single-column phone layout, which works at any width.
 */
export function useMediaQuery(query: string): boolean {
  const read = (): boolean => typeof window !== 'undefined' && typeof window.matchMedia === 'function' && window.matchMedia(query).matches;
  const [matches, setMatches] = useState(read);
  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return;
    const list = window.matchMedia(query);
    const onChange = (): void => setMatches(list.matches);
    onChange();
    list.addEventListener('change', onChange);
    return () => list.removeEventListener('change', onChange);
  }, [query]);
  return matches;
}

/** Width from which a list and its detail are shown side by side. */
export const SPLIT_MIN_WIDTH = 1100;
export const SPLIT_QUERY = `(min-width: ${SPLIT_MIN_WIDTH}px)`;
