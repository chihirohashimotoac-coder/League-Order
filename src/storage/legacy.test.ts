import { describe, expect, it } from 'vitest';
import 'fake-indexeddb/auto';
import { openBackend, resetBackendCache } from './db';
import { Repository } from './repository';
import { parseBackup, serialiseBackup } from './backup';
import { buildSeed } from './seed';
import { createVersion } from '../domain/orders/lifecycle';
import { createMatchInfo } from '../domain/types';
import type { SavedOrder } from '../domain/types';
import { PRESETS } from '../domain/orders/presets';
import { evaluateManualOrder, generateOrder } from '../optimizer/generateOrder';
import { orderInput, sampleFormatGames, sampleRoster } from '../test/factories';

/**
 * Backward compatibility (vNext): data written before PPR, the soft / steel discipline
 * and role fairness existed must still load, generate, edit and round-trip — and must
 * never be read as PPR 0 or as a guessed discipline.
 */

/** Deletes the given keys, recursively through arrays of records. */
function strip<T>(value: T, keys: readonly string[]): T {
  const json = JSON.parse(JSON.stringify(value)) as unknown;
  const visit = (node: unknown): void => {
    if (Array.isArray(node)) {
      node.forEach(visit);
      return;
    }
    if (node && typeof node === 'object') {
      for (const key of keys) delete (node as Record<string, unknown>)[key];
      Object.values(node).forEach(visit);
    }
  };
  visit(json);
  return json as T;
}

const NEW_KEYS = [
  'ppr',
  'discipline',
  'roleFairness',
  'strengthWeights',
  'maxRoleConcentration',
  'averagePpr',
  'effectivePpr',
  'pprImputed',
  'alternativeTo',
];

/** A whole database as an older build would have written it. */
function legacySnapshot() {
  const seed = buildSeed();
  const input = orderInput(seed.players, sampleFormatGames(), { preset: 'BALANCED' });
  const solution = generateOrder(input, { singleCandidate: true }).candidates[0]!;
  const version = createVersion(input, solution, createMatchInfo('サンプルチーム'), [], 1);
  const order: SavedOrder = {
    id: 'ord_legacy',
    teamId: seed.teams[0].id,
    title: 'legacy',
    createdAt: 1,
    updatedAt: 1,
    input,
    solution,
    match: createMatchInfo('サンプルチーム'),
    versions: [version],
    seasonApplied: false,
  };
  return strip({ ...seed, orders: [order] }, NEW_KEYS);
}

describe('legacy JSON backup', () => {
  const legacy = legacySnapshot();
  const raw = JSON.stringify({ schemaVersion: 1, app: 'darts-league-order', exportedAt: '2026-01-01', data: legacy });

  it('is really legacy (no new fields anywhere)', () => {
    // As a property name; "roleFairness" may still appear as an explanation factor's value.
    for (const key of NEW_KEYS) expect(raw.includes(`"${key}":`), key).toBe(false);
  });

  it('reads players without `ppr` as Unknown, never 0', () => {
    const parsed = parseBackup(raw);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.snapshot.players.every((p) => p.ppr === null)).toBe(true);
  });

  it('reads formats without `discipline` as UNSPECIFIED (never guessed)', () => {
    const parsed = parseBackup(raw);
    if (!parsed.ok) throw new Error('parse failed');
    expect(parsed.snapshot.formats.every((f) => f.discipline === 'UNSPECIFIED')).toBe(true);
  });

  it('completes saved orders and versions without touching their solutions', () => {
    const parsed = parseBackup(raw);
    if (!parsed.ok) throw new Error('parse failed');
    const order = parsed.snapshot.orders[0];
    expect(order.input.discipline).toBe('UNSPECIFIED');
    expect(order.input.weights.roleFairness).toBe(PRESETS.BALANCED.weights.roleFairness);
    expect(order.input.players.every((p) => p.ppr === null)).toBe(true);
    expect(order.versions).toHaveLength(1);
    expect(order.versions[0].players.every((p) => p.ppr === null)).toBe(true);
    expect(order.versions[0].discipline).toBeUndefined();
    // Historical numbers are not invented after the fact.
    expect(order.solution.score.roleFairness).toBeUndefined();
    expect(order.solution.metrics.strengthWeights).toBeUndefined();
  });

  it('can be re-generated and hand-edited after import', () => {
    const parsed = parseBackup(raw);
    if (!parsed.ok) throw new Error('parse failed');
    const order = parsed.snapshot.orders[0];
    const regenerated = generateOrder(order.input, { singleCandidate: true });
    expect(regenerated.ok).toBe(true);
    const edited = evaluateManualOrder(order.input, order.solution.assignments);
    expect(edited.ok).toBe(true);
    expect(edited.solution?.metrics.discipline).toBe('UNSPECIFIED');
  });

  it('also works on an input that was never normalised (engine-level safety net)', () => {
    const raw = strip(orderInput(sampleRoster(), sampleFormatGames()), NEW_KEYS);
    const result = generateOrder(raw, { singleCandidate: true });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(Number.isFinite(result.candidates[0].score.total)).toBe(true);
    expect(result.candidates[0].metrics.discipline).toBe('UNSPECIFIED');
  });
});

describe('legacy IndexedDB records', () => {
  it('loads records written by an older build without rewriting them', async () => {
    resetBackendCache();
    const backend = await openBackend();
    await backend.clearAll();
    const legacy = legacySnapshot();
    await backend.putMany('teams', legacy.teams);
    await backend.putMany('players', legacy.players);
    await backend.putMany('formats', legacy.formats);
    await backend.putMany('orders', legacy.orders);

    const loaded = await new Repository(backend).loadAll();
    expect(loaded.players.every((p) => p.ppr === null)).toBe(true);
    expect(loaded.formats.every((f) => f.discipline === 'UNSPECIFIED')).toBe(true);
    expect(loaded.orders[0].input.discipline).toBe('UNSPECIFIED');
    expect(loaded.orders[0].input.weights.roleFairness).toBeDefined();

    // Read-side upgrade only: the stored records still look exactly as they were written.
    const stored = await backend.getAll<{ id: string; ppr?: unknown }>('players');
    expect(stored.every((p) => !('ppr' in p))).toBe(true);
  });
});

describe('export → import round trip', () => {
  it('keeps PPR (decimal and Unknown) and the discipline', () => {
    const seed = buildSeed();
    seed.players[0] = { ...seed.players[0], ppr: 72.45 };
    seed.players[1] = { ...seed.players[1], ppr: null };
    seed.formats[0] = { ...seed.formats[0], discipline: 'STEEL' };
    const parsed = parseBackup(serialiseBackup(seed));
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.snapshot.players[0].ppr).toBe(72.45);
    expect(parsed.snapshot.players[1].ppr).toBeNull();
    expect(parsed.snapshot.formats[0].discipline).toBe('STEEL');
  });

  it('rejects an out-of-range PPR to Unknown rather than keeping a bad value', () => {
    const seed = buildSeed();
    const raw = serialiseBackup(seed).replace('"ppr": null', '"ppr": 250');
    const parsed = parseBackup(raw);
    if (!parsed.ok) throw new Error('parse failed');
    expect(parsed.snapshot.players.every((p) => p.ppr === null)).toBe(true);
  });

  it('keeps a finalized version’s discipline snapshot', () => {
    const seed = buildSeed();
    const input = { ...orderInput(seed.players, sampleFormatGames()), discipline: 'SOFT' as const };
    const solution = generateOrder(input, { singleCandidate: true }).candidates[0]!;
    const version = createVersion(input, solution, createMatchInfo(), [], 1);
    expect(version.discipline).toBe('SOFT');
    const order: SavedOrder = {
      id: 'o1',
      teamId: seed.teams[0].id,
      title: 't',
      createdAt: 1,
      updatedAt: 1,
      input,
      solution,
      versions: [version],
      seasonApplied: false,
    };
    const parsed = parseBackup(serialiseBackup({ ...seed, orders: [order] }));
    if (!parsed.ok) throw new Error('parse failed');
    expect(parsed.snapshot.orders[0].versions[0].discipline).toBe('SOFT');
    expect(parsed.snapshot.orders[0].input.discipline).toBe('SOFT');
  });
});
