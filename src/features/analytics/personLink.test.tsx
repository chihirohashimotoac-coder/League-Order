import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import type { Team } from '../../domain/types';
import type { Player } from '../../domain/types';
import { aggregatePlayers } from './aggregate';
import { applyLinks, idSpelling, linkPeople, nameRelation, NO_DECISIONS } from './personLink';
import { findPersonInPeriod } from './playerView';
import { buildSeasonData } from './seasonData';
import type { SeasonData } from './seasonData';
import { emptyLoad } from './service/periodService';
import type { PeriodLoad } from './service/periodService';
import { playerRow, roster, season, simpleLine, tournament } from './testFixtures';
import { PlayerAnalytics } from './ui/PlayerAnalytics';

/**
 * ⑨ 本人照合 and ⑩ a member without figures in the base season, on a made-up league (lg_test, four
 * seasons s3 newest … s0 oldest). The cases follow the ATDO ones (2026-11-18) without their data:
 *  - P "山田花子" member id X-1 in s3 and s2 (team KAL), and "山田 花子" as 助っ人 in s1 (KAL);
 *  - Q "佐藤 一郎" with the same id X-1 in s0, another team (an id passed on): never mixed with P;
 *  - H "堀田 和夫" X-65: registered in s3 without stats, stats in s2 and s1, and as "X-065" in s0;
 *  - E "江口 一" registered in s3 only, never played.
 */
afterEach(cleanup);

const TEAMS = [{ id: 'KAL', name: 'kala' }, { id: 'HOL', name: 'holic' }];
const line = (n: number) => simpleLine(600 * n, 30 * n, n, 2 * n);

function league(): SeasonData[] {
  const s = (id: string, rows: { oid: string; opid: string | null; team: string; name: string; stats?: number }[]) =>
    buildSeasonData(season({ tournament: tournament(id, TEAMS), roster: roster(rows), playerStats: rows.filter((r) => r.stats).map((r) => playerRow(r.oid, r.opid, r.team, r.name, line(r.stats!))) }));
  return [
    s('s3', [{ oid: 'p3', opid: 'X-1', team: 'KAL', name: '山田花子', stats: 3 }, { oid: 'h3', opid: 'X-65', team: 'KAL', name: '堀田 和夫' }, { oid: 'e3', opid: 'X-9', team: 'KAL', name: '江口 一' }, { oid: 'z3', opid: 'Z-1', team: 'HOL', name: '他 人', stats: 1 }]),
    s('s2', [{ oid: 'p2', opid: 'X-1', team: 'KAL', name: '山田花子', stats: 2 }, { oid: 'h2', opid: 'X-65', team: 'KAL', name: '堀田 和夫', stats: 2 }, { oid: 'z2', opid: 'Z-1', team: 'HOL', name: '他 人', stats: 1 }]),
    s('s1', [{ oid: 'g1', opid: '助っ人', team: 'KAL', name: '山田 花子', stats: 1 }, { oid: 'h1', opid: 'X-65', team: 'KAL', name: '堀田 和夫', stats: 1 }, { oid: 'z1', opid: 'Z-1', team: 'HOL', name: '他 人', stats: 1 }]),
    s('s0', [{ oid: 'q0', opid: 'X-1', team: 'HOL', name: '佐藤 一郎', stats: 4 }, { oid: 'h0', opid: 'X-065', team: 'KAL', name: '堀田 和夫', stats: 1 }]),
  ];
}

describe('⑨ names and ids', () => {
  it('a name is split only where it was written with a space somewhere; never by guess', () => {
    const splits = new Map<string, [string, string] | null>([['山田花子', ['山田', '花子']]]);
    expect(nameRelation('山田花子', '山田 花子', splits)).toBe('same');
    expect(nameRelation('山田花子', '佐藤 一郎', splits)).toBe('different');
    expect(nameRelation('鈴木 恵', '田中 恵', splits)).toBe('surname-change');
    expect(nameRelation('高橋太郎', '伊藤 次郎', splits)).toBe('unknown');
    expect(idSpelling('02-065')).toBe(idSpelling('02-0065'));
  });
});

describe('⑨ 本人照合 on a period', () => {
  it('the same id with both names different is another person; 助っ人 joins by team, name and the next season; a spelling variant of an id joins', () => {
    const seasons = league();
    const links = linkPeople(seasons);
    const p = links.keyOf.get('s3:p3')!;
    expect(links.keyOf.get('s2:p2')).toBe(p);
    expect(links.keyOf.get('s1:g1')).toBe(p);
    expect(links.keyOf.get('s0:q0')).not.toBe(p);
    expect(links.people.get(p)!.find((e) => e.row.key === 's1:g1')).toMatchObject({ basis: 'guest', undoable: true });
    const h = links.keyOf.get('s3:h3')!;
    expect(['s2:h2', 's1:h1', 's0:h0'].map((k) => links.keyOf.get(k))).toEqual([h, h, h]);
    expect(links.people.get(h)!.find((e) => e.row.key === 's0:h0')!.basis).toBe('id-variant');
    const people = aggregatePlayers(applyLinks(seasons, links));
    const P = people.find((x) => x.personKey === p)!;
    expect(P.seasons.map((x) => x.tournamentId)).toEqual(['s3', 's2', 's1']); // Q's s0 stays Q's
    expect(people.find((x) => x.personKey === links.keyOf.get('s0:q0'))!.seasons.map((x) => x.tournamentId)).toEqual(['s0']);
  });

  it('an undone join stays undone (also after reading again); a held row is joined only when confirmed', () => {
    const seasons = league();
    const undone = linkPeople(seasons, { unlinks: ['s1:g1'], confirms: {} });
    expect(undone.keyOf.get('s1:g1')).not.toBe(undone.keyOf.get('s3:p3'));
    // Two candidates (two 山田 花子 in s2 of KAL under other ids): held, not joined.
    const two = league();
    two[1] = buildSeasonData(season({ tournament: tournament('s2', TEAMS), roster: roster([{ oid: 'p2', opid: 'X-1', team: 'KAL', name: '山田花子' }, { oid: 'p2b', opid: 'X-2', team: 'KAL', name: '山田 花子' }]), playerStats: [playerRow('p2', 'X-1', 'KAL', '山田花子', line(2)), playerRow('p2b', 'X-2', 'KAL', '山田 花子', line(1))] }));
    const held = linkPeople(two);
    expect(held.held.find((h) => h.row.key === 's1:g1')).toBeTruthy();
    expect(held.keyOf.get('s1:g1')).not.toBe(held.keyOf.get('s3:p3'));
    const confirmed = linkPeople(two, { unlinks: [], confirms: { 's1:g1': 's3:p3' } });
    expect(confirmed.keyOf.get('s1:g1')).toBe(confirmed.keyOf.get('s3:p3'));
  });

  it('a surname change joins only with the given name, the team and the next season; otherwise it is held', () => {
    const s = (id: string, name: string, team: string) => buildSeasonData(season({ tournament: tournament(id, TEAMS), roster: roster([{ oid: `r${id}`, opid: 'Y-1', team, name }, { oid: `o${id}`, opid: 'O-1', team: team === 'KAL' ? 'HOL' : 'KAL', name: '他 人' }]), playerStats: [playerRow(`r${id}`, 'Y-1', team, name, line(1))] }));
    const same = linkPeople([s('b', '田中 恵', 'KAL'), s('a', '鈴木 恵', 'KAL')]);
    expect(same.keyOf.get('b:rb')).toBe(same.keyOf.get('a:ra'));
    expect(same.people.get(same.keyOf.get('b:rb')!)!.find((e) => e.row.key === 'b:rb')).toMatchObject({ basis: 'rename', undoable: true });
    const moved = linkPeople([s('b', '田中 恵', 'HOL'), s('a', '鈴木 恵', 'KAL')]);
    expect(moved.keyOf.get('b:rb')).not.toBe(moved.keyOf.get('a:ra'));
    expect(moved.held.map((h) => h.row.key)).toEqual(['b:rb']);
    const unsplit = linkPeople([s('b', '高橋太郎', 'KAL'), s('a', '伊藤次郎', 'KAL')]);
    expect(unsplit.keyOf.get('b:rb')).not.toBe(unsplit.keyOf.get('a:ra'));
    expect(unsplit.held[0].reason).toContain('区切り');
  });
});

describe('⑩ a member without figures in the base season', () => {
  const seasons = league();
  const links = linkPeople(seasons);
  const linked = applyLinks(seasons, links);
  const figures = new Set(aggregatePlayers(linked).map((p) => p.personKey));
  const base = linked[0];
  const H = { opid: 'X-65', currentOid: 'h3', lastSeenTournamentId: 's3' };
  const E = { opid: 'X-9', currentOid: 'e3', lastSeenTournamentId: 's3' };

  it('found across the period (registered now, played before); 今季 says 今季は出場記録なし; nothing in the period says so', () => {
    expect(findPersonInPeriod(linked, base, H, links, true, figures)).toMatchObject({ state: 'found', inBase: false, personKey: links.keyOf.get('s3:h3') });
    expect(findPersonInPeriod(linked, base, H, links, false, figures)).toMatchObject({ state: 'none-base', reason: '今季は出場記録なし' });
    expect(findPersonInPeriod(linked, base, E, links, true, figures)).toMatchObject({ state: 'none-period', reason: '選択期間に出場記録なし' });
  });

  it('the screen: 直近3季 lists H with figures and 今季は出場記録なし; switching to 今季 never shows H’s period figures', () => {
    const team = { id: 't', name: 'kala', createdAt: 0, n01: { provider: 'n01', leagueId: 'lg_test', leagueTitle: 'L', stableIdentity: { kind: 'name', value: 'kala' }, lastTournamentId: 's3', lastTournamentTitle: 's3', lastTeamId: 'KAL', lastTeamName: 'kala', lastDivisionIndex: 0, lastDivisionTitle: 'A', discipline: 'SOFT', managedFormatId: null, linkedAt: 0, lastSuccessfulSyncAt: 0 } } as unknown as Team;
    const member = (id: string, name: string, n01: object) => ({ id, name, teamId: 't', archived: false, n01: { ...n01, currentTpid: 'KAL', sourceName: name, rosterActive: true, lastSeenAt: 0, stats: null } }) as unknown as Player;
    const players = [member('m-h', '堀田 和夫', H), member('m-e', '江口 一', E)];
    const role = (load: PeriodLoad) => ({ scope: 'all01' as const, adoption: [], games: { status: 'idle' as const, load: null, needed: [], retry: () => undefined }, detail: { running: null, results: new Map(), contributions: new Map(), partial: new Set<string>(), run: () => undefined, focus: () => undefined, ensure: () => undefined }, identity: { links: linkPeople(load.seasons), controls: { decisions: { unlinks: [], confirms: {} }, unlink: () => undefined, confirm: () => undefined, reset: () => undefined } } });
    const last3: PeriodLoad = { ...emptyLoad({ mode: 'last3', currentTournamentId: 's3' }, {}), seasons: linked.slice(0, 3), complete: true };
    const view = render(<PlayerAnalytics team={team} players={players} load={last3} baseTournamentId="s3" role={role(last3)} />);
    const rows = () => screen.getAllByRole('button').filter((b) => b.classList.contains('list-row'));
    expect(rows()[0].textContent).toContain('3DA 60.00');
    expect(rows()[0].textContent).toContain('今季は出場記録なし');
    expect(rows()[1].textContent).toContain('選択期間に出場記録なし');
    expect(screen.getByTestId('analytics-detail').textContent).toContain('堀田 和夫');
    expect(screen.getByTestId('player-no-base')).toBeTruthy();
    expect(screen.getByTestId('identity-links').textContent).toContain('本人照合（3季');
    // 今季: the same member has no figures there — not selectable, no period figures shown.
    const current: PeriodLoad = { ...emptyLoad({ mode: 'current', currentTournamentId: 's3' }, {}), seasons: linked.slice(0, 1), complete: true };
    view.rerender(<PlayerAnalytics team={team} players={players} load={current} baseTournamentId="s3" role={role(current)} />);
    expect(rows()[0].textContent).toContain('今季は出場記録なし');
    expect((rows()[0] as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByTestId('analytics-detail').textContent).not.toContain('60.00');
  });
});

describe('⑧⑩ switching the period never shows the previous period as the new one', () => {
  it('right after the request changes, the held load is marked as another request’s', async () => {
    const { renderHook, waitFor } = await import('@testing-library/react');
    const { usePeriodLoad } = await import('./ui/usePeriodLoad');
    const { AnalyticsApi } = await import('./api/readApi');
    const { AnalyticsCache } = await import('./cache/analyticsCache');
    const transport = { request: async () => ({ result: 0, list: [] }) };
    const services = { createApi: (signal: AbortSignal) => new AnalyticsApi({ transport, signal }), cache: new AnalyticsCache({ memoryOnly: true }) };
    const hook = renderHook(({ mode }) => usePeriodLoad(services, 'lg_test', { mode, currentTournamentId: 's3' }, 0), { initialProps: { mode: 'current' as 'current' | 'last3' } });
    await waitFor(() => expect(hook.result.current.status).toBe('done'));
    expect(hook.result.current.loadKey).toBe(hook.result.current.requestKey);
    hook.rerender({ mode: 'last3' });
    // The same render that asks for 直近3季: the load held is 今季's, and says so.
    expect(hook.result.current.requestKey).toContain('last3');
    expect(hook.result.current.loadKey).not.toBe(hook.result.current.requestKey);
    await waitFor(() => expect(hook.result.current.loadKey).toBe(hook.result.current.requestKey));
  });
});

describe('Codex audit (2026-11-18): reused ids, undone rows, gaps and held rows', () => {
  it('a member last seen as another person under a reused id is never switched to the new holder of the id', () => {
    const seasons = league();
    const links = linkPeople(seasons);
    const linked = applyLinks(seasons, links);
    const figures = new Set(aggregatePlayers(linked).map((p) => p.personKey));
    const Q = { opid: 'X-1', currentOid: 'q0', lastSeenTournamentId: 's0', name: '佐藤 一郎' };
    // 直近12季-like: the member's own row (s0) is in the period.
    expect(findPersonInPeriod(linked, linked[0], Q, links, true, figures).personKey).toBe(links.keyOf.get('s0:q0'));
    // 今季: only the new holder of X-1 is there — not taken.
    const current = linked.slice(0, 1);
    expect(findPersonInPeriod(current, current[0], Q, linkPeople(current), false, figures)).toMatchObject({ personKey: null, reason: expect.stringContaining('再利用') });
  });

  it('an undone row is not a target either: the older spelling of the id does not join it', () => {
    const seasons = league();
    const links = linkPeople(seasons, { unlinks: ['s3:h3'], confirms: {} });
    expect(links.keyOf.get('s3:h3')).not.toBe(links.keyOf.get('s2:h2'));
    expect(links.people.get(links.keyOf.get('s3:h3')!)!.map((e) => e.row.key)).toEqual(['s3:h3']);
  });

  it('a season between two that could not be read: the guest row is held, not joined', () => {
    const seasons = league();
    // Window: s3, s2, (failed), s1, s0 — s2 and s1 are not adjacent any more.
    const positions = new Map([['s3', 0], ['s2', 1], ['s1', 3], ['s0', 4]]);
    const links = linkPeople(seasons, NO_DECISIONS, positions);
    expect(links.keyOf.get('s1:g1')).not.toBe(links.keyOf.get('s2:p2'));
    expect(links.held.find((h) => h.row.key === 's1:g1')?.reason).toContain('間の季');
  });

  it('a held row is out of every figure (and of the population) until confirmed', () => {
    const two = league();
    two[1] = buildSeasonData(season({ tournament: tournament('s2', TEAMS), roster: roster([{ oid: 'p2', opid: 'X-1', team: 'KAL', name: '山田花子' }, { oid: 'p2b', opid: 'X-2', team: 'KAL', name: '山田 花子' }, { oid: 'z2', opid: 'Z-1', team: 'HOL', name: '他 人' }]), playerStats: [playerRow('p2', 'X-1', 'KAL', '山田花子', line(2)), playerRow('p2b', 'X-2', 'KAL', '山田 花子', line(1))] }));
    const links = linkPeople(two);
    expect(links.held.some((h) => h.row.key === 's1:g1')).toBe(true);
    const linked = applyLinks(two, links);
    expect(linked[2].players.some((p) => p.oid === 'g1')).toBe(false);
    expect(linked[2].heldPlayers?.map((p) => p.oid)).toEqual(['g1']);
    expect(aggregatePlayers(linked).some((p) => p.seasons.some((x) => x.tournamentId === 's1' && x.teamId === 'KAL' && p.name.includes('山田')))).toBe(false);
  });
});
