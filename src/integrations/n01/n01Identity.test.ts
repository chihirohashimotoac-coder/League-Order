import { describe, expect, it } from 'vitest';
import { buildOpponentContext } from '../../domain/prediction/opponentContext';
import { aggregatePlayer } from '../../domain/n01/history';
import { planRosterSync, type RosterSourcePlayer } from '../../domain/n01/roster';
import type { HistoricalPlayerStats } from '../../domain/n01/history';
import { rosterSource } from './rosterResolver';
import { indexStats, statsFor } from './statsResolver';
import {
  BEFORE,
  CURRENT,
  PREVIOUS,
  buildIntel,
  linkedPlayer,
  managedFormat,
  orderEntry,
  rosterPlayer,
  row,
} from '../../test/n01/intelFixtures';

/**
 * F02: one `opid` is not always one person.
 *
 * The real ATDO 2026 3rd roster lists 植村 俊互 (oid WUnd) and 松本 崚 (oid 3ome) under the
 * same opid `02-0111`, and past "助っ人" rows share an opid across many people. Stats,
 * history, roster matching and the opponent position model must never hand one person's
 * numbers to another, and must still follow a person whose opid is unique.
 */

const SHARED = '02-0111';
const UEMURA = { opid: SHARED, oid: 'WUnd', name: '植村 俊互' };
const MATSUMOTO = { opid: SHARED, oid: '3ome', name: '松本 崚' };

const pprOf = (stats: HistoricalPlayerStats | undefined, seasonIndex: number): number | undefined => {
  const line = stats?.seasons.find((entry) => entry.seasonIndex === seasonIndex);
  return line ? Math.round((3 * line.score) / line.darts) : undefined;
};

describe('statsFor / rosterSource (current-season join)', () => {
  const rows = [row(SHARED, 'WUnd', '植村 俊互', 60), row(SHARED, '3ome', '松本 崚', 36)];

  it('prefers the exact oid of the same season over a shared opid', () => {
    const index = indexStats(rows);
    expect(statsFor(index, { opid: SHARED, oid: '3ome' })?.name).toBe('松本 崚');
    expect(statsFor(index, { opid: SHARED, oid: 'WUnd' })?.name).toBe('植村 俊互');
  });

  it('never answers a shared opid with somebody else’s row', () => {
    // 松本 has no row; his opid is shared with 植村 (the roster says so), so 植村's numbers are not his.
    const index = indexStats(
      [row(SHARED, 'WUnd', '植村 俊互', 60)],
      [
        { opid: SHARED, oid: 'WUnd', name: '植村 俊互' },
        { opid: SHARED, oid: '3ome', name: '松本 崚' },
      ],
    );
    expect(statsFor(index, { opid: SHARED, oid: '3ome' })).toBeNull();
    expect(statsFor(index, { opid: SHARED, oid: 'WUnd' })?.name).toBe('植村 俊互');
  });

  it('still follows a unique opid when the oid differs (a transfer inside the season)', () => {
    const index = indexStats([row('op_unique', 'old_oid', '田中 太郎', 50)]);
    expect(statsFor(index, { opid: 'op_unique', oid: 'new_oid' })?.name).toBe('田中 太郎');
  });

  it('gives each roster player their own PPR', () => {
    const source = rosterSource(
      [rosterPlayer(SHARED, 'WUnd', '植村 俊互'), rosterPlayer(SHARED, '3ome', '松本 崚')],
      rows,
      CURRENT,
      1_000,
    );
    expect(source.map((player) => [player.name, player.stats?.ppr])).toEqual([
      ['植村 俊互', 60],
      ['松本 崚', 36],
    ]);
  });

  it('leaves a shared-opid player without stats rather than lending them a namesake’s', () => {
    const source = rosterSource(
      [rosterPlayer(SHARED, 'WUnd', '植村 俊互'), rosterPlayer(SHARED, '3ome', '松本 崚')],
      [row(SHARED, 'WUnd', '植村 俊互', 60)],
      CURRENT,
      1_000,
    );
    expect(source[0].stats?.ppr).toBe(60);
    expect(source[1].stats).toBeNull();
  });
});

describe('history across seasons', () => {
  const sharedRoster = [rosterPlayer(SHARED, 'WUnd', '植村 俊互'), rosterPlayer(SHARED, '3ome', '松本 崚')];
  const sharedHistory = [
    row(SHARED, 'pU', '植村 俊互', 72),
    row(SHARED, 'pM', '松本 崚', 27),
  ];

  it('does not copy a shared opid’s past rows onto either person', () => {
    const intel = buildIntel({
      roster: sharedRoster,
      stats: [row(SHARED, 'WUnd', '植村 俊互', 60), row(SHARED, '3ome', '松本 崚', 36)],
      history: [{ id: PREVIOUS, title: '2026 2nd', seasonIndex: 1, stats: sharedHistory }],
    });
    const uemura = intel.ourStats.find((entry) => entry.name === '植村 俊互');
    const matsumoto = intel.ourStats.find((entry) => entry.name === '松本 崚');
    expect(intel.ourStats).toHaveLength(2);
    expect(uemura!.key).not.toBe(matsumoto!.key);
    // Each keeps their own current-season row and nothing from the ambiguous past rows.
    expect(pprOf(uemura, 0)).toBe(60);
    expect(pprOf(matsumoto, 0)).toBe(36);
    expect(uemura!.seasons.map((line) => line.seasonIndex)).toEqual([0]);
    expect(matsumoto!.seasons.map((line) => line.seasonIndex)).toEqual([0]);
  });

  it('keeps the person with no current row apart from the namesake who has one', () => {
    const intel = buildIntel({
      roster: sharedRoster,
      stats: [row(SHARED, 'WUnd', '植村 俊互', 60)],
      history: [{ id: PREVIOUS, title: '2026 2nd', seasonIndex: 1, stats: sharedHistory }],
    });
    const matsumoto = intel.ourStats.find((entry) => entry.name === '松本 崚');
    expect(matsumoto!.seasons).toEqual([]);
    expect(aggregatePlayer(matsumoto).ppr).toBeNull();
  });

  it('follows a unique opid across seasons even when the name changed', () => {
    const intel = buildIntel({
      roster: [rosterPlayer('op_k', 'k1', '田中 太郎')],
      stats: [row('op_k', 'k1', '田中 太郎', 50)],
      history: [
        { id: PREVIOUS, title: '2026 2nd', seasonIndex: 1, stats: [row('op_k', 'old1', '田中 太朗', 44, 1200, THEM_TEAM)] },
        { id: BEFORE, title: '2026 1st', seasonIndex: 2, stats: [row('op_k', 'old2', '田中 太朗', 40)] },
      ],
    });
    const tanaka = intel.ourStats[0];
    expect(tanaka.key).toBe('op_k');
    expect(tanaka.seasons.map((line) => line.seasonIndex)).toEqual([0, 1, 2]);
    expect(pprOf(tanaka, 1)).toBe(44);
  });

  it('does not use a label shared by many people (助っ人) as a person’s identity', () => {
    const guests = ['A', 'B', 'C'].map((name, index) => row('助っ人', `g${index}`, `ゲスト${name}`, 30 + index * 10));
    const intel = buildIntel({
      roster: [rosterPlayer('助っ人', 'cur_g', 'ゲストX'), rosterPlayer('op_ok', 'ok1', '佐藤 一郎')],
      stats: [row('助っ人', 'cur_g', 'ゲストX', 55), row('op_ok', 'ok1', '佐藤 一郎', 62)],
      history: [{ id: PREVIOUS, title: '2026 2nd', seasonIndex: 1, stats: [...guests, row('op_ok', 'ok0', '佐藤 一郎', 58)] }],
    });
    const guest = intel.ourStats.find((entry) => entry.name === 'ゲストX')!;
    const sato = intel.ourStats.find((entry) => entry.name === '佐藤 一郎')!;
    expect(guest.key).not.toBe('助っ人');
    expect(guest.seasons.map((line) => line.seasonIndex)).toEqual([0]);
    expect(sato.seasons.map((line) => line.seasonIndex)).toEqual([0, 1]);
  });

  it('is unaffected for people with no opid: only the current season’s oid is used', () => {
    const intel = buildIntel({
      roster: [rosterPlayer(null, 'n1', '無印 太郎')],
      stats: [row(null, 'n1', '無印 太郎', 48)],
      history: [{ id: PREVIOUS, title: '2026 2nd', seasonIndex: 1, stats: [row(null, 'n1', '別人 花子', 20)] }],
    });
    expect(intel.ourStats[0].seasons.map((line) => line.seasonIndex)).toEqual([0]);
  });
});

describe('the opponent’s side', () => {
  const opponentRoster = [
    rosterPlayer(SHARED, 'WUnd', '植村 俊互', 'T2'),
    rosterPlayer(SHARED, '3ome', '松本 崚', 'T2'),
    rosterPlayer('op_x', 'x1', '山田 次郎', 'T2'),
  ];

  it('keeps both shared-opid opponents on the roster as different people', () => {
    const intel = buildIntel({
      roster: [rosterPlayer('op_me', 'me1', '自分')],
      stats: [row('op_me', 'me1', '自分', 50)],
      withOpponent: true,
      opponentRoster,
    });
    const names = intel.opponent!.players.map((player) => player.name).sort();
    expect(names).toEqual(['山田 次郎', '松本 崚', '植村 俊互'].sort());
    const keys = new Set(intel.opponent!.players.map((player) => player.key));
    expect(keys.size).toBe(3);
    const slot = intel.opponent!.positionModel.slots[0];
    expect(slot.players).toHaveLength(3);
  });

  it('does not credit a shared opid’s past line-ups to either person', () => {
    const intel = buildIntel({
      roster: [rosterPlayer('op_me', 'me1', '自分')],
      stats: [row('op_me', 'me1', '自分', 50)],
      withOpponent: true,
      opponentRoster,
      history: [
        {
          id: PREVIOUS,
          title: '2026 2nd',
          seasonIndex: 1,
          stats: [row(SHARED, 'pU', '植村 俊互', 70, 1200, 'T2')],
          opponentOrders: [
            orderEntry('pm1', 's1', [{ opid: SHARED, oid: 'pU', name: '植村 俊互' }]),
            orderEntry('pm2', 's1', [{ opid: SHARED, oid: 'pU', name: '植村 俊互' }]),
          ],
        },
      ],
    });
    const slot = intel.opponent!.positionModel.slots.find((entry) => entry.signature === 'SINGLES|01|1')!;
    const sharedKeys = new Set(
      intel.opponent!.players.filter((player) => player.name !== '山田 次郎').map((player) => player.key),
    );
    for (const player of slot.players) {
      if (sharedKeys.has(player.key)) expect(player.appearanceCount).toBe(0);
    }
  });

  it('credits the opponent’s current orders to the person named by oid', () => {
    const intel = buildIntel({
      roster: [rosterPlayer('op_me', 'me1', '自分')],
      stats: [row('op_me', 'me1', '自分', 50)],
      withOpponent: true,
      opponentRoster,
      opponentOrders: [
        orderEntry('c1', 's1', [{ opid: SHARED, oid: '3ome', name: '松本 崚' }]),
        orderEntry('c2', 's1', [{ opid: SHARED, oid: '3ome', name: '松本 崚' }]),
      ],
    });
    const slot = intel.opponent!.positionModel.slots.find((entry) => entry.signature === 'SINGLES|01|1')!;
    const byName = new Map(intel.opponent!.players.map((player) => [player.name, player.key]));
    const seats = (name: string): number => slot.players.find((player) => player.key === byName.get(name))!.appearanceCount;
    expect(seats('松本 崚')).toBeGreaterThan(0);
    expect(seats('植村 俊互')).toBe(0);
  });
});

describe('our players in the opponent context', () => {
  const build = () =>
    buildIntel({
      roster: [rosterPlayer(SHARED, 'WUnd', '植村 俊互'), rosterPlayer(SHARED, '3ome', '松本 崚')],
      stats: [row(SHARED, 'WUnd', '植村 俊互', 66), row(SHARED, '3ome', '松本 崚', 36)],
      withOpponent: true,
      opponentRoster: [rosterPlayer('op_x', 'x1', '山田 次郎', 'T2')],
    });

  it('gives two people sharing an opid their own strengths', () => {
    const intel = build();
    const a = linkedPlayer('pl_a', UEMURA, { statsPpr: 66 });
    const b = linkedPlayer('pl_b', MATSUMOTO, { statsPpr: 36 });
    const context = buildOpponentContext({ snapshot: intel, games: managedFormat().games, players: [a, b] })!;
    expect(context.players.pl_a.strength).toBeGreaterThan(context.players.pl_b.strength + 10);
    expect(context.players.pl_a.imputed).toBe(false);
    expect(context.players.pl_b.imputed).toBe(false);
  });

  it('reads an older cached snapshot that merged them as ambiguous, not as one person', () => {
    const intel = build();
    // What the previous build stored: both people under the bare opid, one history.
    const legacy = {
      ...intel,
      ourPlayers: intel.ourPlayers.map((player) => ({ ...player, key: SHARED })),
      ourStats: [{ ...intel.ourStats[0], key: SHARED }],
    };
    const a = linkedPlayer('pl_a', UEMURA, { statsPpr: 66 });
    const b = linkedPlayer('pl_b', MATSUMOTO, { statsPpr: 36 });
    const context = buildOpponentContext({ snapshot: legacy, games: managedFormat().games, players: [a, b] })!;
    // Neither borrows the single merged history: both fall back to their own PPR at low confidence.
    expect(context.players.pl_a.confidence).toBe('LOW');
    expect(context.players.pl_b.confidence).toBe('LOW');
    expect(context.players.pl_a.strength).toBeGreaterThan(context.players.pl_b.strength);
  });

  it('points at the right history by oid even though the current opid is shared', () => {
    const intel = build();
    const keyOf = (oid: string): string => intel.ourPlayers.find((player) => player.oid === oid)!.key;
    expect(keyOf('WUnd')).not.toBe(keyOf('3ome'));
    expect(intel.ourStats.map((entry) => entry.key).sort()).toEqual([keyOf('WUnd'), keyOf('3ome')].sort());
  });
});

const THEM_TEAM = 'T2';

describe('roster matching', () => {
  const source = (opid: string | null, oid: string, name: string): RosterSourcePlayer => ({ opid, oid, teamId: 'T1', name, stats: null });
  let n = 0;
  const sync = (local: ReturnType<typeof linkedPlayer>[], roster: RosterSourcePlayer[]) =>
    planRosterSync({ teamId: 'team_test', localPlayers: local, source: roster, tournamentId: CURRENT, now: 2_000, newId: () => `pl_new${++n}` });

  it('matches two people who share an opid to their own records by oid, whatever the order', () => {
    const uemura = linkedPlayer('pl_u', UEMURA);
    const matsumoto = linkedPlayer('pl_m', MATSUMOTO);
    const result = sync([uemura, matsumoto], [source(SHARED, '3ome', '松本 崚'), source(SHARED, 'WUnd', '植村 俊互')]);
    expect(result.added).toEqual([]);
    expect(result.renamed).toEqual([]);
    expect(result.deactivated).toEqual([]);
    expect(result.upserts.filter((player) => player.id === 'pl_u' && player.name !== '植村 俊互')).toEqual([]);
    expect(result.upserts.filter((player) => player.id === 'pl_m' && player.name !== '松本 崚')).toEqual([]);
  });

  it('adds a newcomer who shares an opid instead of merging them into the namesake', () => {
    const uemura = linkedPlayer('pl_u', UEMURA);
    const result = sync([uemura], [source(SHARED, 'WUnd', '植村 俊互'), source(SHARED, '3ome', '松本 崚')]);
    expect(result.added.map((entry) => entry.name)).toEqual(['松本 崚']);
    expect(result.renamed).toEqual([]);
  });

  it('still follows a unique opid through a rename and a new oid', () => {
    const tanaka = linkedPlayer('pl_t', { opid: 'op_k', oid: 'old_oid', name: '田中 太朗' });
    const result = sync([tanaka], [source('op_k', 'new_oid', '田中 太郎')]);
    expect(result.added).toEqual([]);
    expect(result.renamed).toEqual([{ playerId: 'pl_t', from: '田中 太朗', to: '田中 太郎' }]);
  });
});
