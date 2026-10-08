import { describe, expect, it } from 'vitest';
import type { AppSettings, Player, SavedOrder } from '../domain/types';
import { createMatchInfo } from '../domain/types';
import { DEFAULT_OPTIMIZER_SETTINGS, DEFAULT_WEIGHTS } from '../domain/orders/presets';
import { createVersion } from '../domain/orders/lifecycle';
import { newGuest } from '../domain/players/newPlayer';
import { buildNextMatchOrder } from '../domain/n01/nextMatch';
import { generateOrder } from '../optimizer/generateOrder';
import { format, player, sampleFormatGames, TEAM_ID } from '../test/factories';
import { DEFAULT_SETTINGS, type Snapshot } from './repository';
import { parseBackup, serialiseBackup } from './backup';

/**
 * A backup is the one copy of the data nobody can rebuild: an order that holds a helper
 * (今回限りの助っ人) and the basis of its strengths must come back with both, while the
 * roster still has no helper in it.
 */
describe('backup of an order with a one-order helper', () => {
  it('round-trips the helper, the strength basis and the gate verdict, and the roster stays without them', () => {
    const roster: Player[] = [
      player({ id: 'p1', name: 'Aoki', rating: 14, ppr: 72 }),
      player({ id: 'p2', name: 'Baba', rating: 12, ppr: 66 }),
      player({ id: 'p3', name: 'Chiba', rating: 9, ppr: 55 }),
    ];
    const helper = newGuest(TEAM_ID, 'gst_1', { name: '助っ人 太郎', rating: 8, ppr: null, skills: {} }, 5);
    const settings: AppSettings = { activeTeamId: TEAM_ID, optimizer: DEFAULT_OPTIMIZER_SETTINGS, lastPreset: 'WIN_FIRST', customWeights: DEFAULT_WEIGHTS };
    const built = buildNextMatchOrder({
      team: { id: TEAM_ID, name: 'Us', createdAt: 0 },
      players: roster,
      guests: [helper],
      format: format(sampleFormatGames()),
      pairs: [],
      settings,
      intel: null,
      attending: new Set(['p1', 'p2', 'p3', helper.id]),
    });
    const result = generateOrder(built.input, { singleCandidate: true, timeLimitMs: 2000 });
    if (!result.ok) throw new Error('should generate');
    const solution = result.candidates[0];
    const match = createMatchInfo('Us');
    const order: SavedOrder = {
      id: 'ord_1',
      teamId: TEAM_ID,
      title: 't',
      createdAt: 1,
      updatedAt: 1,
      input: built.input,
      solution,
      match,
      versions: [createVersion(built.input, solution, match, [], 10)],
      seasonApplied: false,
    };
    const snapshot: Snapshot = {
      teams: [{ id: TEAM_ID, name: 'Us', createdAt: 0 }],
      players: roster,
      formats: [],
      pairs: [],
      orders: [order],
      seasonCommits: [],
      settings: DEFAULT_SETTINGS,
    };

    const restored = parseBackup(serialiseBackup(snapshot));
    expect(restored.ok).toBe(true);
    if (!restored.ok) return;
    const back = restored.snapshot.orders[0];
    expect(back.input.players.filter((entry) => entry.guest).map((entry) => [entry.id, entry.name])).toEqual([['gst_1', '助っ人 太郎']]);
    expect(back.versions[0].players.find((entry) => entry.id === 'gst_1')).toMatchObject({ guest: true, name: '助っ人 太郎' });
    expect(back.input.strengthBasis?.players.gst_1).toMatchObject({ origin: 'unknown', ppr: null });
    expect(back.solution.meta.skewGate).toEqual(solution.meta.skewGate);
    expect(restored.snapshot.players.some((entry) => entry.id === 'gst_1')).toBe(false);
  });

  it('an order saved before any of this reads back as it was: no basis, no helper, no gate verdict', () => {
    const roster = [player({ id: 'p1', name: 'Aoki', rating: 14 }), player({ id: 'p2', name: 'Baba', rating: 12 }), player({ id: 'p3', name: 'Chiba', rating: 9 })];
    const settings: AppSettings = { activeTeamId: TEAM_ID, optimizer: DEFAULT_OPTIMIZER_SETTINGS, lastPreset: 'BALANCED', customWeights: DEFAULT_WEIGHTS };
    const built = buildNextMatchOrder({
      team: { id: TEAM_ID, name: 'Us', createdAt: 0 },
      players: roster,
      format: format(sampleFormatGames()),
      pairs: [],
      settings,
      intel: null,
      attending: new Set(['p1', 'p2', 'p3']),
    });
    const { strengthBasis: _basis, ...legacyInput } = built.input;
    void _basis;
    const result = generateOrder(legacyInput, { singleCandidate: true, timeLimitMs: 2000 });
    if (!result.ok) throw new Error('should generate');
    const solution = result.candidates[0];
    const match = createMatchInfo('Us');
    const order: SavedOrder = { id: 'ord_old', teamId: TEAM_ID, title: 't', createdAt: 1, updatedAt: 1, input: legacyInput, solution, match, versions: [], seasonApplied: false };
    const restored = parseBackup(serialiseBackup({ teams: [{ id: TEAM_ID, name: 'Us', createdAt: 0 }], players: roster, formats: [], pairs: [], orders: [order], seasonCommits: [], settings: DEFAULT_SETTINGS }));
    expect(restored.ok).toBe(true);
    if (!restored.ok) return;
    expect(restored.snapshot.orders[0].input.strengthBasis).toBeUndefined();
    expect(restored.snapshot.orders[0].input.players.some((entry) => entry.guest)).toBe(false);
    // And it still re-evaluates and regenerates (no evidence → an even split).
    expect(generateOrder(restored.snapshot.orders[0].input, { singleCandidate: true, timeLimitMs: 2000 }).ok).toBe(true);
  });
});
