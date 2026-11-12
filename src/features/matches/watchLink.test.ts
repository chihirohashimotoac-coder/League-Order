// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { closeWatchLink, formatWatchLink, parseWatchLink, pushWatchLink, readWatchLink, replaceWatchLink } from './watchLink';
import { shortTitles } from './titles';

describe('watch links', () => {
  afterEach(() => window.history.replaceState(null, '', '/'));

  it('round-trips the public ids of a league card and its game', () => {
    const link = { league: 'lg_l3hI_3397', season: 't_ABvC_5234', card: '1_ls0007', game: 'sch_3' };
    expect(parseWatchLink(formatWatchLink(link))).toEqual(link);
  });

  it('drops anything that is not a plain id, and a card without its season', () => {
    expect(parseWatchLink('#/watch?l=lg_a_1&c=1_x&m=<script>')).toEqual({ league: 'lg_a_1' });
    expect(parseWatchLink('#/elsewhere')).toBeNull();
    expect(parseWatchLink('#/watch?t=t_a_1&g=sch_1')).toEqual({ season: 't_a_1' });
  });

  it('lives in the fragment, so the page path (a GitHub Pages sub-path) is kept', () => {
    window.history.replaceState(null, '', '/League-Order/');
    pushWatchLink({ league: 'lg_a_1', season: 't_a_1', card: '0_ls1' });
    expect(window.location.pathname).toBe('/League-Order/');
    expect(readWatchLink()).toEqual({ league: 'lg_a_1', season: 't_a_1', card: '0_ls1' });
  });

  it('closing a link opened directly (no list behind it) rewrites it to the list instead of leaving the app', () => {
    replaceWatchLink({ league: 'lg_a_1', season: 't_a_1', card: '0_ls1' });
    closeWatchLink({ league: 'lg_a_1', season: 't_a_1' });
    expect(readWatchLink()).toEqual({ league: 'lg_a_1', season: 't_a_1' });
  });
});

describe('shortTitles', () => {
  it('drops the words every long event title shares, keeping what tells them apart', () => {
    const map = shortTitles(['JDO2026 ATDO OPEN メンズシングルス', 'JDO2026 ATDO OPEN レディースシングルス', 'JDO2026 ATDO OPEN ダブルス']);
    expect(map.get('JDO2026 ATDO OPEN メンズシングルス')).toBe('メンズシングルス');
    expect(map.get('JDO2026 ATDO OPEN ダブルス')).toBe('ダブルス');
  });

  it('keeps short season names whole (the year and the season number stay)', () => {
    const map = shortTitles(['2026 ATDO 3rd', '2026 ATDO 2nd', '2025 ATDO 4th']);
    expect(map.get('2026 ATDO 3rd')).toBe('2026 ATDO 3rd');
  });
});
