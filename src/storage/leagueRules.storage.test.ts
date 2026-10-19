import { describe, expect, it } from 'vitest';
import 'fake-indexeddb/auto';
import type { LeagueFormat, LeagueRules, OrderInput, SavedOrder } from '../domain/types';
import { createMatchInfo } from '../domain/types';
import { createVersion, latestVersion } from '../domain/orders/lifecycle';
import { createParticipantConfig } from '../domain/orders/participants';
import { leagueRulesSnapshot } from '../domain/orders/leagueRules';
import { newGuest } from '../domain/players/newPlayer';
import { generateOrder } from '../optimizer/generateOrder';
import { validateHardConstraints } from '../optimizer/constraints/validate';
import { format, orderInput, player, sampleFormatGames, TEAM_ID } from '../test/factories';
import { openBackend, resetBackendCache } from './db';
import { DEFAULT_SETTINGS, Repository, type Snapshot } from './repository';
import { parseBackup, serialiseBackup } from './backup';

/**
 * League rules and league status must survive everything an order goes through — saving,
 * reloading, finalizing v1 / v2, JSON export and import — and a later edit of the format
 * must never reach an order (or a version) made under the earlier rules.
 */

const RULES: LeagueRules = {
  maxPerStructure: { SINGLES: 1, DOUBLES: 2 },
  maxPerPlayKind: { CRICKET: 2 },
  maxSameDoublesPair: 1,
  maxHelpers: 1,
};

function buildOrder(): { input: OrderInput; format: LeagueFormat; order: SavedOrder } {
  const members = [
    player({ id: 'p1', name: 'Aoki', rating: 14, ppr: 70 }),
    player({ id: 'p2', name: 'Baba', rating: 12, ppr: 64 }),
    player({ id: 'p3', name: 'Chiba', rating: 10, ppr: 60 }),
    player({ id: 'p4', name: 'Doi', rating: 8, ppr: 52 }),
  ];
  const helper = newGuest(TEAM_ID, 'gst_1', { name: '助っ人 花子', rating: 9, ppr: null, skills: {} }, 5);
  const fmt: LeagueFormat = { ...format(sampleFormatGames()), leagueRules: structuredClone(RULES) };
  const players = [...members, helper];
  const input: OrderInput = {
    ...orderInput(players, fmt.games),
    participants: [
      ...members.map((m) => ({ ...createParticipantConfig(m.id), leagueStatus: m.id === 'p4' ? ('HELPER' as const) : ('REGULAR' as const) })),
      { ...createParticipantConfig(helper.id), leagueStatus: 'REGULAR' },
    ],
    leagueRules: leagueRulesSnapshot(fmt.leagueRules),
  };
  const result = generateOrder(input, { singleCandidate: true, timeLimitMs: 1500 });
  if (!result.ok) throw new Error(result.diagnostics.map((d) => d.message).join(' / '));
  const solution = result.candidates[0];
  expect(validateHardConstraints(input, solution.assignments)).toEqual([]);
  const match = createMatchInfo('Us');
  const v1 = createVersion(input, solution, match, [], 10);
  const order: SavedOrder = {
    id: 'ord_rules',
    teamId: TEAM_ID,
    title: 'rules',
    createdAt: 1,
    updatedAt: 1,
    input,
    solution,
    match,
    versions: [v1],
    seasonApplied: false,
  };
  return { input, format: fmt, order };
}

function snapshotOf(fmt: LeagueFormat, order: SavedOrder): Snapshot {
  return {
    teams: [{ id: TEAM_ID, name: 'Us', createdAt: 0 }],
    players: order.input.players.filter((p) => !p.guest),
    formats: [fmt],
    pairs: [],
    orders: [order],
    seasonCommits: [],
    settings: DEFAULT_SETTINGS,
  };
}

describe('8. league rules and status through saving and versions', () => {
  it('the input snapshot and v1 keep the rules; editing the format reaches neither', () => {
    const { input, format: fmt, order } = buildOrder();
    const v1 = order.versions[0];
    expect(v1.leagueRules).toEqual(RULES);
    expect(v1.participants.find((c) => c.playerId === 'p4')?.leagueStatus).toBe('HELPER');
    expect(v1.participants.find((c) => c.playerId === 'gst_1')?.leagueStatus).toBe('REGULAR');
    // The format is edited afterwards (a stricter Singles cap, the helper rule removed).
    fmt.leagueRules!.maxPerStructure!.SINGLES = 0;
    delete fmt.leagueRules!.maxHelpers;
    expect(input.leagueRules).toEqual(RULES);
    expect(v1.leagueRules).toEqual(RULES);
    // v2 freezes its own copy; changing v2's later input does not rewrite v1.
    const v2 = createVersion({ ...input, leagueRules: { maxHelpers: 2 } }, order.solution, order.match!, order.versions, 20);
    expect(v2.version).toBe(2);
    expect(v2.leagueRules).toEqual({ maxHelpers: 2 });
    expect(v1.leagueRules).toEqual(RULES);
  });

  it('a version made without rules carries none (old shape)', () => {
    const { order } = buildOrder();
    const bare = createVersion({ ...order.input, leagueRules: undefined }, order.solution, order.match!, [], 1);
    expect('leagueRules' in bare).toBe(false);
  });

  it('saving and reloading from IndexedDB keeps the rules, the statuses and the versions', async () => {
    const { format: fmt, order } = buildOrder();
    resetBackendCache();
    const backend = await openBackend();
    await backend.clearAll();
    const repository = new Repository(backend);
    await repository.replaceAll(snapshotOf(fmt, order));
    const loaded = await repository.loadAll();
    expect(loaded.formats[0].leagueRules).toEqual(RULES);
    const back = loaded.orders[0];
    expect(back.input.leagueRules).toEqual(RULES);
    expect(back.input.participants.map((c) => [c.playerId, c.leagueStatus])).toEqual(
      order.input.participants.map((c) => [c.playerId, c.leagueStatus]),
    );
    expect(latestVersion(back.versions)?.leagueRules).toEqual(RULES);
    expect(validateHardConstraints(back.input, back.solution.assignments)).toEqual([]);
  });
});

describe('9. JSON export / import', () => {
  it('a new backup round-trips the rules, statuses and versions; the guest stays out of the roster', () => {
    const { format: fmt, order } = buildOrder();
    const restored = parseBackup(serialiseBackup(snapshotOf(fmt, order)));
    expect(restored.ok).toBe(true);
    if (!restored.ok) return;
    expect(restored.snapshot.formats[0].leagueRules).toEqual(RULES);
    const back = restored.snapshot.orders[0];
    expect(back.input.leagueRules).toEqual(RULES);
    expect(back.versions[0].leagueRules).toEqual(RULES);
    expect(back.input.participants.find((c) => c.playerId === 'gst_1')?.leagueStatus).toBe('REGULAR');
    expect(back.input.players.find((p) => p.id === 'gst_1')?.guest).toBe(true);
    expect(restored.snapshot.players.some((p) => p.id === 'gst_1')).toBe(false);
  });

  it('an old backup without rules imports unchanged: no rules, no statuses, nothing invented', () => {
    const { format: fmt, order } = buildOrder();
    const oldFormat = { ...fmt, leagueRules: undefined };
    const oldOrder: SavedOrder = {
      ...order,
      input: {
        ...order.input,
        leagueRules: undefined,
        participants: order.input.participants.map(({ leagueStatus: _status, ...rest }) => rest),
      },
      versions: [],
    };
    const restored = parseBackup(serialiseBackup(snapshotOf(oldFormat, oldOrder)));
    expect(restored.ok).toBe(true);
    if (!restored.ok) return;
    expect(restored.snapshot.formats[0].leagueRules).toBeUndefined();
    const back = restored.snapshot.orders[0];
    expect(back.input.leagueRules).toBeUndefined();
    expect(back.input.participants.every((c) => c.leagueStatus === undefined)).toBe(true);
    expect(validateHardConstraints(back.input, back.solution.assignments)).toEqual([]);
  });

  it('a damaged rule value is imported as invalid and blocks, never silently dropped', () => {
    const { format: fmt, order } = buildOrder();
    const text = serialiseBackup(snapshotOf(fmt, order)).replace('"SINGLES": 1', '"SINGLES": "one"');
    const restored = parseBackup(text);
    expect(restored.ok).toBe(true);
    if (!restored.ok) return;
    const caps = restored.snapshot.formats[0].leagueRules?.maxPerStructure;
    expect(caps && Number.isNaN(caps.SINGLES)).toBe(true);
  });
});
