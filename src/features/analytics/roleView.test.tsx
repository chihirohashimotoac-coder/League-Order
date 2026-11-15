import { cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Player, Team } from '../../domain/types';
import { projectSeasons } from './projection';
import type { GamesSource } from './projection';
import { desperadoGames, season2024Data, TDID_2024_2ND, withDetailSides } from './realData.roles.fixtures';
import type { GameScope } from './roleGames';
import type { PeriodLoad } from './service/periodService';
import { emptyLoad } from './service/periodService';
import type { RoleViewProps } from './ui/AnalyticsPage';
import { PlayerAnalytics } from './ui/PlayerAnalytics';
import { TeamAnalytics } from './ui/TeamAnalytics';
import { AnalysisSummary, ScopeBar } from './ui/scopeParts';
import type { GamesState } from './ui/useRoleData';
import { AnalyticsApi } from './api/readApi';
import type { AnalyticsTransport } from './api/readApi';
import { AnalyticsCache } from './cache/analyticsCache';
import { details, wireDetail } from './realData.roles.fixtures';
import { HIGH_IN_ATDO_2024_2ND } from './realData.startRate.fixtures';
import { reconstructPerson } from './service/detailService';
import type { PlayerDetailResult } from './service/detailService';

afterEach(cleanup);

const s = season2024Data();
const games: GamesSource = {
  games: new Map([[TDID_2024_2ND, { tournamentId: TDID_2024_2ND, games: withDetailSides(desperadoGames()), dropped: { unfinished: 0, unreadable: 0, nonLeague: 0 }, complete: true }]]),
  failed: new Set(),
};

function team(): Team {
  return {
    id: 'team1',
    name: 'Desperado',
    createdAt: 0,
    n01: {
      provider: 'n01', leagueId: 'lg', leagueTitle: 'ATDO', stableIdentity: { kind: 'name', value: 'desperado' }, lastTournamentId: TDID_2024_2ND, lastTournamentTitle: '2024 2nd',
      lastTeamId: 'pzDR', lastTeamName: 'Desperado', lastDivisionIndex: 1, lastDivisionTitle: 'B', discipline: 'SOFT', managedFormatId: null, linkedAt: 0, lastSuccessfulSyncAt: 0,
    },
  } as Team;
}

const players = [['p1', '和田 圭司', '63Cz'], ['p2', '永野 優子', 'g1vr']].map(
  ([id, name, oid]) =>
    ({ id, name, teamId: 'team1', archived: false, n01: { opid: null, currentOid: oid, currentTpid: 'pzDR', sourceName: name, rosterActive: true, lastSeenTournamentId: TDID_2024_2ND, lastSeenAt: 0, stats: null } }) as unknown as Player,
);

const gamesState: GamesState = { status: 'done', load: { ...games, failures: [], usedStaleCache: false, requestsSent: 6 }, needed: [TDID_2024_2ND] };

function view(scope: GameScope, run = vi.fn(), ensure = vi.fn()): { load: PeriodLoad; role: RoleViewProps } {
  const projection = projectSeasons([s], scope, games);
  const load = { ...emptyLoad({ mode: 'current', currentTournamentId: TDID_2024_2ND }, {}), seasons: projection.seasons, complete: true, window: [{ tournamentId: TDID_2024_2ND, title: s.title, state: 'loaded' as const }] };
  return { load, role: { scope, adoption: projection.adoption, games: gamesState, detail: { running: null, results: new Map(), contributions: new Map(), run, ensure } } };
}

describe('game-kind views on screen', () => {
  it('the switch offers 01全体 / シングルス / ダブルス / その他, with the parts of "その他"', async () => {
    const user = userEvent.setup();
    const onMain = vi.fn();
    const onPart = vi.fn();
    const { rerender } = render(<ScopeBar main="all01" part="others" onMain={onMain} onPart={onPart} />);
    await user.click(screen.getByRole('button', { name: 'ダブルス' }));
    expect(onMain).toHaveBeenCalledWith('doubles');
    expect(screen.queryByRole('button', { name: 'トリオス' })).toBeNull();
    rerender(<ScopeBar main="others" part="others" onMain={onMain} onPart={onPart} />);
    await user.click(screen.getByRole('button', { name: 'ガロン' }));
    expect(onPart).toHaveBeenCalledWith('gallon');
  });

  it('doubles: the shown player\'s leg details are read without a button; Leg/Set are pair results, and 3DA is not ranked', () => {
    const run = vi.fn();
    const ensure = vi.fn();
    const { load, role } = view('doubles', run, ensure);
    render(<PlayerAnalytics team={team()} players={players} load={load} baseTournamentId={TDID_2024_2ND} role={role} />);
    // Started automatically for the player shown first (和田), and for nobody else.
    expect(ensure).toHaveBeenCalledWith(s.players.find((p) => p.oid === '63Cz')!.personKey);
    expect(new Set(ensure.mock.calls.map((c) => c[0])).size).toBe(1);
    expect(run).not.toHaveBeenCalled();
    expect(screen.queryByTestId('reconstruct-run')).toBeNull();
    expect(screen.getByTestId('metric-3DA').textContent).toContain('準備中');
    expect(screen.getByTestId('metric-個人スタート率').textContent).toContain('取得待ち');
    expect(screen.getByTestId('metric-Leg勝率').textContent).toContain('ペア・チームとしての結果');
    const options = within(screen.getByLabelText('指標')).getAllByRole('option').map((o) => o.textContent);
    expect(options).toEqual(['Leg勝率', 'Set勝率']);
    expect(screen.getByTestId('player-basis').textContent).toContain('ダブルス01のゲームのみ');
  });

  it('others (trios / team …): nothing is read automatically; the reconstruction stays on request', () => {
    const run = vi.fn();
    const ensure = vi.fn();
    const { load, role } = view('others', run, ensure);
    render(<PlayerAnalytics team={team()} players={players} load={load} baseTournamentId={TDID_2024_2ND} role={role} />);
    expect(ensure.mock.calls.every((c) => c[0] === null)).toBe(true); // released only, never a read
    expect(screen.getByTestId('metric-3DA').textContent).toContain('個人別に復元できません');
    expect(screen.queryByTestId('metric-個人スタート率')).toBeNull();
    screen.getByTestId('reconstruct-run').click();
    expect(run).toHaveBeenCalledWith(s.players.find((p) => p.oid === '63Cz')!.personKey);
  });

  it('singles and 01全体 never start the doubles read (they only release it: ensure(null))', () => {
    for (const scope of ['singles', 'all01'] as const) {
      const ensure = vi.fn();
      const { load, role } = view(scope, vi.fn(), ensure);
      const { unmount } = render(<PlayerAnalytics team={team()} players={players} load={load} baseTournamentId={TDID_2024_2ND} role={role} />);
      expect(ensure.mock.calls.every((c) => c[0] === null)).toBe(true);
      unmount();
    }
  });

  it('leaving ダブルス, or closing the player view, releases the automatic read (Codex audit)', () => {
    const ensure = vi.fn();
    const doubles = view('doubles', vi.fn(), ensure);
    const { rerender, unmount } = render(<PlayerAnalytics team={team()} players={players} load={doubles.load} baseTournamentId={TDID_2024_2ND} role={doubles.role} />);
    expect(ensure).toHaveBeenLastCalledWith(s.players.find((p) => p.oid === '63Cz')!.personKey);
    const singles = view('singles', vi.fn(), ensure);
    rerender(<PlayerAnalytics team={team()} players={players} load={singles.load} baseTournamentId={TDID_2024_2ND} role={singles.role} />);
    expect(ensure).toHaveBeenLastCalledWith(null);
    rerender(<PlayerAnalytics team={team()} players={players} load={doubles.load} baseTournamentId={TDID_2024_2ND} role={doubles.role} />);
    ensure.mockClear();
    unmount();
    expect(ensure).toHaveBeenCalledWith(null);
  });

  it('singles: the player\'s own 3DA from the game rows, ranked', () => {
    const { load, role } = view('singles');
    render(<PlayerAnalytics team={team()} players={players} load={load} baseTournamentId={TDID_2024_2ND} role={role} />);
    // 和田: 5850 points / 421 darts over 6 singles games.
    expect(screen.getByTestId('metric-3DA').textContent).toContain(((5850 * 3) / 421).toFixed(2));
    expect(screen.queryByTestId('reconstruction')).toBeNull();
  });

  it('team view in a game-kind view: team totals only, no official Match record mixed in', () => {
    const { load, role } = view('doubles');
    render(<TeamAnalytics team={team()} players={players} load={load} baseTournamentId={TDID_2024_2ND} role={role} />);
    expect(screen.getByTestId('team-basis').textContent).toContain('ダブルス01のゲームのみ');
    expect(screen.getByTestId('team-match').textContent).toContain('01全体');
    expect(screen.getByTestId('metric-3DA').textContent).toContain((((1465 + 886 + 593 + 918 + 955 + 1002 + 908 + 588) * 3) / (116 + 81 + 60 + 99 + 90 + 65 + 108 + 78)).toFixed(2));
  });

  it('the summary is one line; seasons and per-metric reasons are folded away', () => {
    const projection = projectSeasons([s], 'all01', games);
    const load: PeriodLoad = {
      ...emptyLoad({ mode: 'last12', currentTournamentId: TDID_2024_2ND }, {}),
      seasons: [s],
      window: [
        { tournamentId: TDID_2024_2ND, title: s.title, state: 'loaded' },
        { tournamentId: 'x', title: '2024 1st', state: 'failed', reason: 'ネットワークに接続できません' },
      ],
      failures: [{ tournamentId: 'x', title: '2024 1st', reason: 'ネットワークに接続できません', kind: 'network' }],
      complete: false,
    };
    render(<AnalysisSummary load={load} projection={projection} scope="all01" games={gamesState} />);
    const summary = screen.getByTestId('analysis-summary');
    expect(summary.querySelector('.summary-line')!.textContent).toContain('直近12季');
    expect(screen.getByTestId('summary-used').textContent).toBe('1');
    expect(screen.getByTestId('summary-missing').textContent).toContain('未取得 11季');
    expect(screen.getByTestId('summary-flag')).toBeTruthy();
    const details = screen.getByTestId('analysis-details') as HTMLDetailsElement;
    expect(details.open).toBe(false);
    expect(within(details).getByText('Cricketを含む')).toBeTruthy();
    expect(within(screen.getByTestId('metric-adoption')).getByText(/Keep \/ Break/).parentElement!.textContent).toContain('対象外');
  });
});

describe('final review fixes on screen', () => {
  /** 2024 2nd with n01's official standings row for Desperado (8 played, 2 won), so the Match record shows. */
  function seasonWithStandings(allZeroOne: boolean) {
    const base = season2024Data();
    const official = { teamId: 'pzDR', name: 'Desperado', rank: 4, played: 8, won: 2, drawn: 0, lost: 6, points: 4 };
    const slots = allZeroOne ? base.slots.filter((x) => x.schid !== '8kxb') : base.slots;
    return {
      ...base,
      slots,
      composition: { composition: allZeroOne ? ('pure01' as const) : ('mixed' as const), nonZeroOne: [] },
      divisionComposition: { 0: allZeroOne ? ('pure01' as const) : ('mixed' as const), 1: allZeroOne ? ('pure01' as const) : ('mixed' as const) },
      standings: [{ divisionIndex: 1, title: 'B', rows: [official] }],
      teams: base.teams.map((t) => (t.teamId === 'pzDR' ? { ...t, official, matchReconciled: true } : t)),
    };
  }

  function teamLoad(s: ReturnType<typeof seasonWithStandings>): { load: PeriodLoad; role: RoleViewProps } {
    const projection = projectSeasons([s], 'all01', games);
    const load = { ...emptyLoad({ mode: 'current', currentTournamentId: TDID_2024_2ND }, {}), seasons: projection.seasons, complete: true, window: [{ tournamentId: TDID_2024_2ND, title: s.title, state: 'loaded' as const }] };
    return { load, role: { scope: 'all01', adoption: projection.adoption, games: gamesState, detail: { running: null, results: new Map(), contributions: new Map(), run: vi.fn(), ensure: vi.fn() } } };
  }

  it('the official Match rate of a Cricket-mixed season says it includes Cricket results (numbers unchanged)', () => {
    const { load, role } = teamLoad(seasonWithStandings(false));
    render(<TeamAnalytics team={team()} players={players} load={load} baseTournamentId={TDID_2024_2ND} role={role} />);
    expect(screen.getByTestId('team-match').textContent).toContain('2勝0分6敗（8試合）');
    expect(screen.getByTestId('match-includes-cricket').textContent).toBe('Cricketの結果を含む（公式）');
  });

  it('no Cricket note for an all-01 season', () => {
    const { load, role } = teamLoad(seasonWithStandings(true));
    render(<TeamAnalytics team={team()} players={players} load={load} baseTournamentId={TDID_2024_2ND} role={role} />);
    expect(screen.getByTestId('team-match').textContent).toContain('2勝0分6敗');
    expect(screen.queryByTestId('match-includes-cricket')).toBeNull();
  });

  it('a game list with an unreadable row is shown as partial, with the reason, in the folded details', () => {
    const partial: GamesSource = {
      games: new Map([[TDID_2024_2ND, { ...games.games.get(TDID_2024_2ND)!, dropped: { unfinished: 0, unreadable: 2, nonLeague: 0 }, complete: false }]]),
      failed: new Set(),
    };
    const projection = projectSeasons([s], 'doubles', partial);
    const load: PeriodLoad = { ...emptyLoad({ mode: 'current', currentTournamentId: TDID_2024_2ND }, {}), seasons: [s], complete: true, window: [{ tournamentId: TDID_2024_2ND, title: s.title, state: 'loaded' }] };
    render(<AnalysisSummary load={load} projection={projection} scope="doubles" games={gamesState} />);
    expect(screen.getByTestId('analysis-summary').querySelector('.summary-line')!.textContent).toContain('ゲーム記録が不完全・未取得 1季');
    expect(screen.getByTestId('games-partial-reason').textContent).toContain('読めない試合記録 2件のため部分集計');
    expect(screen.getByTestId('summary-used').textContent).toBe('0');
  });
});

describe('doubles: the automatic read on screen (stored 2024 2nd data, league id set to ATDO\'s)', () => {
  const atdo = { ...s, leagueId: 'lg_l3hI_3397' };
  const transport: AnalyticsTransport = {
    async request(operation, params) {
      if (operation === 'match/get') return wired[params.mid] ?? { result: -1, error: 'not found' };
      if (operation === 'tournament/stats') return { result: 0, stats: HIGH_IN_ATDO_2024_2ND };
      throw new Error(`unexpected ${operation}`);
    },
  };
  const wired = Object.fromEntries(details().map((d) => [d.gameId, wireDetail(d)]));
  const personKey = s.players.find((p) => p.oid === '63Cz')!.personKey;

  async function shown(result: PlayerDetailResult, run = vi.fn(), ensure = vi.fn()) {
    const projection = projectSeasons([atdo], 'doubles', games, result.contributions);
    const load = { ...emptyLoad({ mode: 'current', currentTournamentId: TDID_2024_2ND }, {}), seasons: projection.seasons, complete: true, window: [{ tournamentId: TDID_2024_2ND, title: s.title, state: 'loaded' as const }] };
    const role: RoleViewProps = { scope: 'doubles', adoption: projection.adoption, games: gamesState, detail: { running: null, results: new Map([[personKey, result]]), contributions: result.contributions, run, ensure } };
    render(<PlayerAnalytics team={team()} players={players} load={load} baseTournamentId={TDID_2024_2ND} role={role} />);
    return { run };
  }

  it('3DA from the verified reconstruction and 個人スタート率 38.5%・5/13スロー, labelled as computed from the legs', async () => {
    const result = await reconstructPerson({ api: new AnalyticsApi({ transport }), cache: new AnalyticsCache({ memoryOnly: true }), isOnline: () => true, now: () => Date.now() }, { seasons: [atdo], games: games.games, personKey });
    await shown(result);
    const start = screen.getByTestId('metric-個人スタート率').textContent!;
    expect(start).toContain('38.5%');
    expect(start).toContain('5/13スロー');
    expect(start).toContain('Leg明細から算出');
    expect(start).not.toContain('公式の成功率');
    expect(screen.getByTestId('metric-3DA').textContent).toContain('Leg明細から復元');
    expect(screen.getByTestId('metric-3DA').textContent).not.toContain('—');
    expect(screen.getByTestId('start-adopted').textContent).toContain('3ゲーム中 3ゲーム');
    expect(screen.queryByTestId('reconstruct-run')).toBeNull();
  });

  it('a read that failed offers the retry (only then), and shows no figure', async () => {
    const failing: AnalyticsTransport = { request: async () => { throw new Error('offline'); } };
    const result = await reconstructPerson({ api: new AnalyticsApi({ transport: failing }), cache: new AnalyticsCache({ memoryOnly: true }), isOnline: () => false, now: () => Date.now() }, { seasons: [atdo], games: games.games, personKey });
    const user = userEvent.setup();
    const { run } = await shown(result);
    expect(screen.getByTestId('reconstruction').getAttribute('data-state')).toBe('unavailable');
    expect(screen.getByTestId('metric-個人スタート率').textContent).toContain('—');
    expect(screen.getByTestId('metric-3DA').textContent).toContain('取得できなかった');
    await user.click(screen.getByTestId('reconstruct-retry'));
    expect(run).toHaveBeenCalledWith(personKey, { fresh: false, auto: true });
  });

  it('a player without a doubles game: "対象なし", and nothing is read for them', () => {
    const ensure = vi.fn();
    const { load, role } = view('doubles', vi.fn(), ensure);
    const solo = [{ ...players[0], id: 'p9', name: '阿部', n01: { ...players[0].n01!, currentOid: 'vhqF' } } as Player];
    render(<PlayerAnalytics team={team()} players={solo} load={load} baseTournamentId={TDID_2024_2ND} role={role} />);
    expect(ensure.mock.calls.every((c) => c[0] === null)).toBe(true); // released only, never a read
    expect(screen.getByTestId('reconstruction').getAttribute('data-state')).toBe('none');
    expect(screen.getByTestId('metric-3DA').textContent).toContain('ダブルス01の出場がない');
  });
});
