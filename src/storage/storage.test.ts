import { beforeEach, describe, expect, it } from 'vitest';
import 'fake-indexeddb/auto';
import { openBackend, resetBackendCache, MemoryBackend, type StorageBackend } from './db';
import { DEFAULT_SETTINGS, Repository, type Snapshot } from './repository';
import { BACKUP_SCHEMA_VERSION, parseBackup, serialiseBackup } from './backup';
import { buildSeed } from './seed';

async function freshRepository(): Promise<Repository> {
  resetBackendCache();
  const backend = await openBackend();
  await backend.clearAll();
  return new Repository(backend);
}

describe('storage backend', () => {
  it('uses IndexedDB when it is available', async () => {
    resetBackendCache();
    const backend = await openBackend();
    expect(backend.kind).toBe('indexeddb');
  });

  it('round-trips records through the memory fallback with the same interface', async () => {
    const backend: StorageBackend = new MemoryBackend();
    await backend.put('teams', { id: 't1', name: 'A', createdAt: 1 });
    await backend.put('teams', { id: 't2', name: 'B', createdAt: 2 });
    expect(await backend.getAll('teams')).toHaveLength(2);
    await backend.put('teams', { id: 't1', name: 'A2', createdAt: 1 });
    expect(await backend.get<{ name: string } & { id: string }>('teams', 't1')).toMatchObject({ name: 'A2' });
    await backend.remove('teams', 't1');
    expect(await backend.getAll('teams')).toHaveLength(1);
    await backend.clearAll();
    expect(await backend.getAll('teams')).toHaveLength(0);
  });
});

describe('Repository', () => {
  let repository: Repository;

  beforeEach(async () => {
    repository = await freshRepository();
  });

  it('returns defaults for an empty database', async () => {
    const snapshot = await repository.loadAll();
    expect(snapshot.teams).toEqual([]);
    expect(snapshot.settings).toEqual(DEFAULT_SETTINGS);
  });

  it('persists and reloads the seed data', async () => {
    const seed = buildSeed();
    await repository.replaceAll(seed);

    const loaded = await repository.loadAll();
    expect(loaded.teams).toHaveLength(1);
    expect(loaded.players).toHaveLength(5);
    expect(loaded.formats).toHaveLength(1);
    expect(loaded.formats[0].games).toHaveLength(6);
    expect(loaded.settings.activeTeamId).toBe(seed.teams[0].id);
  });

  it('keeps an unknown rating as null through a save/load cycle', async () => {
    const seed = buildSeed();
    seed.players[0] = { ...seed.players[0], rating: null };
    await repository.replaceAll(seed);
    const loaded = await repository.loadAll();
    const reloaded = loaded.players.find((p) => p.id === seed.players[0].id)!;
    expect(reloaded.rating).toBeNull();
    expect(reloaded.rating).not.toBe(0);
  });

  it('deletes a team together with everything scoped to it', async () => {
    const seed = buildSeed();
    await repository.replaceAll(seed);
    await repository.deleteTeam(seed.teams[0].id);
    const loaded = await repository.loadAll();
    expect(loaded.teams).toHaveLength(0);
    expect(loaded.players).toHaveLength(0);
    expect(loaded.formats).toHaveLength(0);
  });

  it('merges without clearing', async () => {
    const seed = buildSeed();
    await repository.replaceAll(seed);
    const extra: Snapshot = {
      teams: [{ id: 'team_extra', name: 'Second', createdAt: Date.now() }],
      players: [],
      formats: [],
      pairs: [],
      orders: [],
      settings: seed.settings,
    };
    await repository.mergeAll(extra);
    const loaded = await repository.loadAll();
    expect(loaded.teams).toHaveLength(2);
    expect(loaded.players).toHaveLength(5);
  });

  it('merges newly added optimizer options into stored settings', async () => {
    const seed = buildSeed();
    await repository.replaceAll(seed);
    // Simulate settings written by an older build that had no `beamWidth`.
    await repository.saveSettings({
      ...seed.settings,
      optimizer: { ...seed.settings.optimizer, beamWidth: undefined as unknown as number },
    });
    const loaded = await repository.loadAll();
    expect(loaded.settings.optimizer.beamWidth).toBe(DEFAULT_SETTINGS.optimizer.beamWidth);
  });
});

describe('JSON export / import', () => {
  it('round-trips a full snapshot', () => {
    const seed = buildSeed();
    const json = serialiseBackup(seed);
    const result = parseBackup(json);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.snapshot.teams).toEqual(seed.teams);
    expect(result.snapshot.players).toEqual(seed.players);
    expect(result.snapshot.formats).toEqual(seed.formats);
    expect(result.snapshot.settings.activeTeamId).toBe(seed.settings.activeTeamId);
  });

  it('writes a versioned, identifiable envelope', () => {
    const parsed = JSON.parse(serialiseBackup(buildSeed()));
    expect(parsed.app).toBe('darts-league-order');
    expect(parsed.schemaVersion).toBe(BACKUP_SCHEMA_VERSION);
    expect(typeof parsed.exportedAt).toBe('string');
  });

  it('preserves a null rating rather than coercing it to 0', () => {
    const seed = buildSeed();
    seed.players[1] = { ...seed.players[1], rating: null };
    const result = parseBackup(serialiseBackup(seed));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.snapshot.players[1].rating).toBeNull();
  });

  it('rejects malformed JSON without applying anything', () => {
    const result = parseBackup('{ not json');
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors[0]).toContain('JSON');
  });

  it('rejects a backup with no teams', () => {
    const result = parseBackup(JSON.stringify({ app: 'darts-league-order', schemaVersion: 1, data: {} }));
    expect(result.ok).toBe(false);
  });

  it('rejects a schema version from a newer build', () => {
    const seed = buildSeed();
    const backup = JSON.parse(serialiseBackup(seed));
    backup.schemaVersion = BACKUP_SCHEMA_VERSION + 1;
    const result = parseBackup(JSON.stringify(backup));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors.join(' ')).toContain('スキーマ版');
  });

  it('warns but still imports when the file came from elsewhere', () => {
    const seed = buildSeed();
    const backup = JSON.parse(serialiseBackup(seed));
    backup.app = 'something-else';
    const result = parseBackup(JSON.stringify(backup));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.warnings.length).toBeGreaterThan(0);
  });

  it('drops invalid aptitude levels and unknown game kinds instead of failing', () => {
    const seed = buildSeed();
    const backup = JSON.parse(serialiseBackup(seed));
    backup.data.players[0].skills = { G501: 9, CRICKET: 4, NOT_A_KIND: 3 };
    backup.data.formats[0].games[0].kinds = ['SINGLES', 'NOT_A_KIND'];
    const result = parseBackup(JSON.stringify(backup));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.snapshot.players[0].skills.G501).toBeUndefined();
    expect(result.snapshot.players[0].skills.CRICKET).toBe(4);
    expect(result.snapshot.formats[0].games[0].kinds).toEqual(['SINGLES']);
  });

  it('canonicalises pair ordering on import', () => {
    const seed = buildSeed();
    const backup = JSON.parse(serialiseBackup(seed));
    backup.data.pairs = [
      { id: 'pr1', teamId: seed.teams[0].id, a: 'zzz', b: 'aaa', affinity: 'GOOD', pastTogetherCount: 2 },
    ];
    const result = parseBackup(JSON.stringify(backup));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.snapshot.pairs[0].a).toBe('aaa');
    expect(result.snapshot.pairs[0].b).toBe('zzz');
  });

  it('import then persist then reload keeps the data identical', async () => {
    const repository = await freshRepository();
    const seed = buildSeed();
    const result = parseBackup(serialiseBackup(seed));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    await repository.replaceAll(result.snapshot);
    const loaded = await repository.loadAll();
    expect(loaded.players.map((p) => p.name).sort()).toEqual(seed.players.map((p) => p.name).sort());
  });
});
