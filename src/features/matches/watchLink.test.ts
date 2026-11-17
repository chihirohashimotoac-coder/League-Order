// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { closeWatchLink, currentWatchDepth, formatWatchLink, parseWatchLink, pushWatchLink, readWatchLink, replaceWatchLink, returnToWatchEntry } from './watchLink';
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

  it('keeps the year and the season number of long season names', () => {
    const map = shortTitles(['2026 ATDO DARTS LEAGUE 3rd', '2026 ATDO DARTS LEAGUE 2nd', '2025 ATDO DARTS LEAGUE 4th']);
    expect(map.get('2026 ATDO DARTS LEAGUE 3rd')).toBe('2026 3rd');
  });

  it('keeps short season names whole (the year and the season number stay)', () => {
    const map = shortTitles(['2026 ATDO 3rd', '2026 ATDO 2nd', '2025 ATDO 4th']);
    expect(map.get('2026 ATDO 3rd')).toBe('2026 ATDO 3rd');
  });
});

describe('watch link: a game opened from 「いま n01 で進行中」', () => {
  it('keeps the now flag with the game, and drops anything but 1', () => {
    const link = parseWatchLink(formatWatchLink({ now: '1', mid: 'Dset1_1800000600000' }));
    expect(link).toEqual({ now: '1', mid: 'Dset1_1800000600000' });
    expect(parseWatchLink('#/watch?n=2&m=abc')).toEqual({ mid: 'abc' });
    // An existing game link (without the flag) is unchanged.
    expect(parseWatchLink('#/watch?m=abc')).toEqual({ mid: 'abc' });
  });
});

describe('watch link: n01 の一覧 (b=)', () => {
  afterEach(() => window.history.replaceState(null, '', '/'));

  it('一覧のカテゴリを読み、試合はオンラインの一覧とだけ組み合わせる', () => {
    expect(parseWatchLink('#/watch?b=tournament')).toEqual({ browse: 'tournament' });
    expect(parseWatchLink('#/watch?b=online&m=abc')).toEqual({ browse: 'online', mid: 'abc' });
    expect(parseWatchLink('#/watch?b=league&m=abc')).toEqual({ browse: 'league' });
    expect(parseWatchLink('#/watch?b=other')).toEqual({});
    // 既存のリンク (大会・以前の一覧) が優先。
    expect(parseWatchLink('#/watch?b=league&k=t_a_1')).toEqual({ tournament: 't_a_1' });
    expect(parseWatchLink('#/watch?b=online&n=1')).toEqual({ now: '1' });
  });

  it('一覧から開いたリーグの上にカードを開いていても、一覧の履歴まで戻る', async () => {
    window.history.replaceState(null, '', '/');
    pushWatchLink({ browse: 'league' });
    pushWatchLink({ league: 'lg_a_1' });
    const openedAt = currentWatchDepth();
    pushWatchLink({ league: 'lg_a_1', season: 't_a_1', card: '0_ls1' });
    const moved = new Promise<void>((resolve) => window.addEventListener('popstate', () => resolve(), { once: true }));
    returnToWatchEntry(openedAt, { browse: 'league' });
    await moved;
    expect(readWatchLink()).toEqual({ browse: 'league' });
  });

  it('開いた履歴が無い (再読み込み・直接開いた) ときは、今の履歴を一覧に書き換える', () => {
    window.history.replaceState(null, '', '/#/watch?l=lg_a_1');
    returnToWatchEntry(0, { browse: 'league' });
    expect(readWatchLink()).toEqual({ browse: 'league' });
  });
});
