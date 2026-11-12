import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { MatchesApi } from '../api';
import type { AnalyticsOperation, AnalyticsTransport } from '../../analytics/api/readApi';
import { RequestGovernor } from '../governor';
import { buildCards } from '../cards';
import { parseFixtures, parseGameRows, parseLive, parseSeasonDocument } from '../parse';
import type { LiveState } from '../parse';
import { TDID, fixtures, gameRow, list, liveBody, side, tournamentDoc } from '../testFixtures';
import { LiveSheet } from './LiveSheet';
import { HUB_IDLE_MS, TournamentHub } from './CompetitionViews';
import { StatsTab } from './WatchPage';
import { useTodayBoard } from './useMatchContext';
import type { SeasonData } from './useMatchContext';

/** Component-level regressions of the audit of 2026-11-09 (docs/AUDIT_2026-11-09.md). */

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

type Handler = (operation: AnalyticsOperation, params: Record<string, string>) => unknown;

function apiOf(handler: Handler) {
  const calls: { operation: AnalyticsOperation; params: Record<string, string> }[] = [];
  const transport: AnalyticsTransport = {
    request: async (operation, params) => {
      calls.push({ operation, params });
      const reply = handler(operation, params);
      if (reply instanceof Error) throw reply;
      return reply;
    },
  };
  const api = new MatchesApi({ transport, governor: new RequestGovernor(100_000), pollPerMinute: 100_000 });
  return { api, calls };
}

const flush = async (): Promise<void> => {
  await act(async () => {
    for (let i = 0; i < 10; i += 1) await Promise.resolve();
  });
};

// ---------------------------------------------------------------------------
// F05 — switching games
// ---------------------------------------------------------------------------

function liveOf(mid: string, legIndex: number): LiveState {
  const state = parseLive(
    liveBody({
      mid,
      legs: [legIndex, 0],
      leg: { leg: legIndex, first: 0, end: 0, winner: null, start: [501, 501], left: [401, 501], thrower: 1, throws: [{ p: 0, r: 1, score: 100, left: 401, darts: 3 }] },
    }),
  );
  if (!state.changed) throw new Error('unchanged');
  return state;
}

const oldLegs = {
  result: 0,
  changed: 1,
  mid: 'gameA',
  updateTime: 10,
  leg_data: [0, 1].map((leg) => ({
    leg,
    first: 0,
    end: 1,
    winner: 0,
    darts: [9, 9],
    throws: [
      { p: 0, r: 1, score: 180, left: 321, darts: 3 },
      { p: 1, r: 1, score: 26, left: 475, darts: 3 },
      { p: 0, r: 2, score: 180, left: 141, darts: 3 },
      { p: 1, r: 2, score: 26, left: 449, darts: 3 },
      { p: 0, r: 3, score: 141, left: 0, darts: 3, finish: 1 },
    ],
  })),
};

describe('F05: the next game never shows the previous game’s legs', () => {
  it('game A legs 0–1 → game B leg 0 whose read fails: nothing of A, a visible failure, then B alone after the retry', async () => {
    let failB = true;
    const { api } = apiOf((operation, params) => {
      if (operation !== 'match/throws') throw new Error(operation);
      if (params.mid === 'gameA') return oldLegs;
      if (failB) return new Error('network down');
      return { result: 0, changed: 1, mid: 'gameB', updateTime: 20, leg_data: [] };
    });
    // Same component instance (no key): the hook alone must keep the games apart.
    const view = render(<LiveSheet api={api} live={liveOf('gameA', 2)} />);
    await flush();
    expect(view.container.textContent).toContain('L2:');
    expect(screen.getByLabelText('このゲームのスタッツ').textContent).toContain('2'); // two 180s

    view.rerender(<LiveSheet api={api} live={liveOf('gameB', 0)} />);
    await flush();
    const text = view.container.textContent ?? '';
    expect(text).not.toContain('L1:');
    expect(text).not.toContain('L2:');
    expect(screen.queryByLabelText('このゲームのスタッツ')).toBeNull();
    expect(screen.getByTestId('legs-status').textContent).toContain('取得できませんでした');
    expect(screen.queryByTestId('leg-chance')).toBeNull();

    failB = false;
    fireEvent.click(screen.getByRole('button', { name: '再取得' }));
    await flush();
    const stats = screen.getByLabelText('このゲームのスタッツ').textContent ?? '';
    // Game B: one visit of 100 so far — no 180, no High Finish from game A.
    expect(stats).not.toContain('141');
    expect(view.container.textContent).not.toContain('L2:');
  });

  it('opening a game reads it once (no extra since read until its leg moves on)', async () => {
    const { api, calls } = apiOf(() => ({ ...oldLegs }));
    const view = render(<LiveSheet api={api} live={liveOf('gameA', 2)} />);
    await flush();
    await flush();
    expect(calls.filter((call) => call.operation === 'match/throws')).toHaveLength(1);
    view.rerender(<LiveSheet api={api} live={liveOf('gameA', 3)} />);
    await flush();
    const reads = calls.filter((call) => call.operation === 'match/throws');
    expect(reads).toHaveLength(2);
    expect(reads[1].params.since).toBe('10');
  });

  it('a late reply for the previous game is dropped', async () => {
    let releaseA: (value: unknown) => void = () => undefined;
    const { api } = apiOf((_operation, params) => {
      if (params.mid === 'gameA') return new Promise((resolve) => (releaseA = resolve));
      return { result: 0, changed: 1, mid: 'gameB', updateTime: 20, leg_data: [] };
    });
    const view = render(<LiveSheet api={api} live={liveOf('gameA', 2)} />);
    view.rerender(<LiveSheet api={api} live={liveOf('gameB', 0)} />);
    await flush();
    releaseA(oldLegs);
    await flush();
    expect(view.container.textContent).not.toContain('L2:');
    expect(screen.getByLabelText('このゲームのスタッツ').textContent).not.toContain('141');
  });
});

// ---------------------------------------------------------------------------
// F03 / F01 / F12 — a tournament (any competition)
// ---------------------------------------------------------------------------

function competitionDoc(status: number, teamGames: number, entries: [string, string][]) {
  return { result: 0, tournament: { tdid: TDID, title: 'Open', status, team_games: teamGames, entry_list: entries.map(([tpid, name]) => ({ tpid, name })) } };
}

const liveGame = (mid: string, start: number) =>
  ({ ...(gameRow('x', 'AAAA', 'BBBB', '', [side('AAAA', [], 0, 0, 0), side('BBBB', [], 0, 0, 0)], { mid, start, finished: false }) as Record<string, unknown>), tmid: `${TDID}_t_1_AAAA_BBBB`, schid: '' });

describe('F03: a running competition with nothing on keeps checking', () => {
  it('no game yet → a game starts later → shown without a manual refresh', async () => {
    vi.useFakeTimers();
    let rows: unknown[] = [];
    const { api, calls } = apiOf((operation) => {
      if (operation === 'tournament/get') return competitionDoc(30, 0, [['AAAA', 'Alice'], ['BBBB', 'Bob']]);
      if (operation === 'tournament/standings') return { result: -51 };
      return list(rows);
    });
    render(<TournamentHub api={api} tdid={TDID} tab="live" onGame={() => undefined} />);
    await flush();
    expect(screen.getByText(/いま進行中の試合はありません/)).toBeTruthy();
    expect(screen.getByText(/始まると自動で表示します/)).toBeTruthy();
    rows = [liveGame('g1', 1_800_000_000)];
    await act(async () => {
      await vi.advanceTimersByTimeAsync(HUB_IDLE_MS * 1.25);
    });
    await flush();
    expect(screen.getAllByTestId('competition-match')).toHaveLength(1);
    expect(calls.filter((call) => call.operation === 'match/list').length).toBeGreaterThanOrEqual(2);
  });

  it('a competition that finishes while open stops being polled', async () => {
    vi.useFakeTimers();
    let status = 30;
    const { api, calls } = apiOf((operation) => {
      if (operation === 'tournament/get') return competitionDoc(status, 0, [['AAAA', 'Alice']]);
      if (operation === 'tournament/standings') return { result: -51 };
      return list([]);
    });
    render(<TournamentHub api={api} tdid={TDID} tab="live" onGame={() => undefined} />);
    await flush();
    status = 40;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(HUB_IDLE_MS * 1.25);
    });
    await flush();
    const settled = calls.length;
    expect(screen.getByText(/この大会は終了しています/)).toBeTruthy();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10 * 60_000);
    });
    expect(calls.length).toBe(settled);
  });

  it('a finished competition with nothing in progress is not polled again', async () => {
    vi.useFakeTimers();
    const { api, calls } = apiOf((operation) => {
      if (operation === 'tournament/get') return competitionDoc(40, 0, [['AAAA', 'Alice']]);
      if (operation === 'tournament/standings') return { result: -51 };
      return list([]);
    });
    render(<TournamentHub api={api} tdid={TDID} tab="live" onGame={() => undefined} />);
    await flush();
    const before = calls.length;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10 * 60_000);
    });
    expect(calls.length).toBe(before);
    expect(screen.getByText(/この大会は終了しています/)).toBeTruthy();
  });
});

describe('F01: an individual event’s player figures come from stats_list', () => {
  it('shows each entry by name from stats_list; player_stats_list is not asked', async () => {
    const { api, calls } = apiOf((operation, params) => {
      if (operation === 'tournament/get') return competitionDoc(30, 0, [['AAAA', 'Alice'], ['BBBB', 'Bob']]);
      if (operation === 'tournament/standings') return { result: -51 };
      if (operation === 'tournament/stats') {
        if (params.kind === 'stats_list') return { result: 0, kind: 'stats_list', stats: { AAAA: { score: 2228, darts: 207, winLeg: 2, leg: 5, ton80: 1, highOut: 58 }, BBBB: { score: 1000, darts: 60, winLeg: 3, leg: 4, ton80: 0, highOut: 40 } } };
        return { result: 0, kind: 'player_stats_list', stats: [] };
      }
      return list([]);
    });
    render(<TournamentHub api={api} tdid={TDID} tab="stats" onGame={() => undefined} />);
    await flush();
    await flush();
    const table = screen.getByTestId('player-ranking');
    expect(table.textContent).toContain('Alice');
    expect(table.textContent).toContain('Bob');
    expect(table.textContent).toContain(((2228 / 207) * 3).toFixed(2));
    expect(table.textContent).not.toContain('ありません');
    expect(calls.filter((call) => call.operation === 'tournament/stats').map((call) => call.params.kind)).toEqual(['stats_list']);
  });

  it('a team event keeps player_stats_list (members), never the team totals', async () => {
    const { api, calls } = apiOf((operation, params) => {
      if (operation === 'tournament/get') return competitionDoc(30, 1, [['AAAA', 'Arrows']]);
      if (operation === 'tournament/standings') return { result: -51 };
      if (operation === 'team/player/list') return { result: 0, list: [{ tpid: 'AAAA', oid: 'a1', oname: 'A1' }] };
      if (operation === 'tournament/stats') return params.kind === 'player_stats_list' ? { result: 0, stats: { a1: { oid: 'a1', tpid: 'AAAA', score: 501, darts: 30, leg: 2, winLeg: 1 } } } : new Error('team totals asked');
      return list([]);
    });
    render(<TournamentHub api={api} tdid={TDID} tab="stats" onGame={() => undefined} />);
    await flush();
    await flush();
    expect(screen.getByTestId('player-ranking').textContent).toContain('A1');
    expect(calls.filter((call) => call.operation === 'tournament/stats').map((call) => call.params.kind)).toEqual(['player_stats_list']);
  });
});

describe('F12: every player of a ranking can be reached', () => {
  const entries = Array.from({ length: 75 }, (_, i) => [`E${String(i).padStart(3, '0')}`, `Player ${String(i + 1).padStart(3, '0')}`] as [string, string]);
  // Player 001 has the best average, Player 075 the lowest.
  const stats = Object.fromEntries(entries.map(([tpid], i) => [tpid, { score: 1000 - i, darts: 30, leg: 10, winLeg: 5 }]));

  async function open() {
    const { api } = apiOf((operation) => {
      if (operation === 'tournament/get') return competitionDoc(30, 0, entries);
      if (operation === 'tournament/standings') return { result: -51 };
      if (operation === 'tournament/stats') return { result: 0, stats };
      return list([]);
    });
    render(<TournamentHub api={api} tdid={TDID} tab="stats" onGame={() => undefined} />);
    await flush();
    await flush();
  }

  it('every entry at once, as many as n01 lists; the last keeps its rank', async () => {
    await open();
    const rows = () => screen.getByTestId('player-ranking').querySelectorAll('tbody tr');
    expect(rows()).toHaveLength(75);
    expect(screen.getByTestId('ranking-footer').textContent).toContain('75 件を表示');
    expect(screen.queryByRole('button', { name: /さらに|すべて表示/u })).toBeNull();
    expect(rows()[74].textContent).toContain('75');
    expect(rows()[74].textContent).toContain('Player 075');
  });

  it('a search reaches a player beyond 60 with their real rank; no match says so', async () => {
    await open();
    fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'player 07０' } }); // full-width 0 matches
    const rows = screen.getByTestId('player-ranking').querySelectorAll('tbody tr');
    expect(rows).toHaveLength(1);
    expect(rows[0].querySelector('td')?.textContent).toBe('70');
    fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'nobody' } });
    expect(screen.getByTestId('ranking-footer').textContent).toContain('一致するエントリーはいません');
  });

  it('league スタッツ: search works with the division filter, the minimum legs and every sort', () => {
    const season = parseSeasonDocument(tournamentDoc(), TDID);
    const data: SeasonData = { season, fixtures: parseFixtures(fixtures()), games: [], cards: buildCards(season, parseFixtures(fixtures()), []), standings: [], standingsError: null, unreadableGames: 0, truncated: false };
    const players = Array.from({ length: 70 }, (_, i) => ({ oid: `o${i}`, tpid: i % 2 ? 'AAAA' : 'BBBB', oname: `Member ${String(i + 1).padStart(2, '0')}`, score: 1000 - i, darts: 30, leg: 10, winLeg: 5, ton80: i % 3 }));
    const { api } = apiOf((operation) => {
      if (operation === 'tournament/stats') return { result: 0, stats: Object.fromEntries(players.map((p) => [p.oid, p])) };
      if (operation === 'team/player/list') return { result: 0, list: [] };
      return list([]);
    });
    return (async () => {
      render(<StatsTab data={data} registered={[]} api={api} onTeam={() => undefined} onPlayer={() => undefined} />);
      await flush();
      await flush();
      const rows = () => screen.getByTestId('stats-tab').querySelectorAll('tbody tr');
      expect(rows()).toHaveLength(70);
      fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'Member 68' } });
      expect(rows()).toHaveLength(1);
      expect(rows()[0].querySelector('td')?.textContent).toBe('68');
      fireEvent.click(screen.getByRole('radio', { name: '180' }));
      expect(rows()).toHaveLength(1);
      expect(rows()[0].textContent).toContain('Member 68');
    })();
  });

  it('league スタッツ: every player n01 lists by default; the minimum legs and a missing figure leave no one out silently', async () => {
    const season = parseSeasonDocument(tournamentDoc(), TDID);
    const data: SeasonData = { season, fixtures: parseFixtures(fixtures()), games: [], cards: buildCards(season, parseFixtures(fixtures()), []), standings: [], standingsError: null, unreadableGames: 0, truncated: false };
    // 136 players as in a real season: legs 1…45 (most 45 → minimum 14), one in three has no won leg.
    const players = Array.from({ length: 136 }, (_, i) => {
      const leg = (i % 45) + 1;
      const won = i % 3 === 0 ? 0 : Math.ceil(leg / 2);
      return { oid: `p${i}`, tpid: i % 2 ? 'AAAA' : 'BBBB', oname: `P${String(i + 1).padStart(3, '0')}`, score: 3000 - i, darts: 100, leg, winLeg: won, best: won ? 18 + (i % 20) : 0 };
    });
    const qualified = players.filter((p) => p.leg >= 14).length;
    const noBest = players.filter((p) => p.best === 0).length;
    const { api } = apiOf((operation) => {
      if (operation === 'tournament/stats') return { result: 0, stats: Object.fromEntries(players.map((p) => [p.oid, p])) };
      if (operation === 'team/player/list') return { result: 0, list: [] };
      return list([]);
    });
    render(<StatsTab data={data} registered={[]} api={api} onTeam={() => undefined} onPlayer={() => undefined} />);
    await flush();
    await flush();
    const tab = screen.getByTestId('stats-tab');
    const rows = () => tab.querySelectorAll('tbody tr');
    const footer = () => screen.getByTestId('ranking-footer').textContent;
    expect(rows()).toHaveLength(136);
    expect(footer()).toContain('136 人を表示');
    const box = screen.getByRole('checkbox', { name: /規定 Leg 数以上 \(14 Leg\)/u });
    expect((box as HTMLInputElement).checked).toBe(false);
    fireEvent.click(box);
    expect(rows()).toHaveLength(qualified);
    expect(footer()).toContain(`${qualified} / 136 人を表示`);
    fireEvent.click(box);
    // Best Leg: players with no won leg stay, unranked at the end.
    fireEvent.click(screen.getByRole('radio', { name: 'Best Leg' }));
    expect(rows()).toHaveLength(136);
    const last = rows()[135].querySelectorAll('td');
    expect(last[0].textContent).toBe('—');
    expect(last[1].textContent).toBe('—');
    expect(rows()[136 - noBest - 1].querySelector('td')?.textContent).toBe(String(136 - noBest));
  });
});

// ---------------------------------------------------------------------------
// F02 — the board hook on a long evening
// ---------------------------------------------------------------------------

function Board({ api }: { api: MatchesApi }): React.JSX.Element {
  const board = useTodayBoard(api, TDID, true);
  return <p data-testid="board">{board.games ? board.games.map((game) => game.mid).join(',') : 'loading'}</p>;
}

describe('F02: the live board keeps refreshing past 120 reads', () => {
  it('500 refreshes later a game that just started is on the board', async () => {
    vi.useFakeTimers();
    let rows: unknown[] = [gameRow('c1', 'AAAA', 'BBBB', 'sg01', [side('AAAA', [['a1', 'A1']], 0, 100, 3), side('BBBB', [['b1', 'B1']], 0, 60, 3)], { mid: 'early', finished: false, start: Math.floor(Date.now() / 1000) })];
    const { api, calls } = apiOf(() => list(rows));
    render(<Board api={api} />);
    await flush();
    // Quiet board: the hook polls every 15 s (±20 %); 650 steps of 18 s drive well over 500 reads.
    for (let i = 0; i < 650; i += 1) {
      await act(async () => {
        await vi.advanceTimersByTimeAsync(18_000);
      });
    }
    expect(calls.length).toBeGreaterThanOrEqual(500);
    rows = [...rows, gameRow('c2', 'CCCC', 'DDDD', 'sg01', [side('CCCC', [['c1', 'C1']], 0, 0, 0), side('DDDD', [['d1', 'D1']], 0, 0, 0)], { mid: 'late', finished: false, start: Math.floor(Date.now() / 1000) })];
    await act(async () => {
      await vi.advanceTimersByTimeAsync(18_000);
    });
    expect(screen.getByTestId('board').textContent).toContain('late');
    expect(api.requestCount).toBe(0);
  });
});

// Keeps the import used when the fixtures change shape.
void parseGameRows;
