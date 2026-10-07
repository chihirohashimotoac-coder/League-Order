import { describe, expect, it } from 'vitest';
import 'fake-indexeddb/auto';
import type { LeagueFormat, Player, Team } from '../domain/types';
import type { N01SyncSnapshot } from '../domain/n01/types';
import { MemoryBackend, openBackend, resetBackendCache } from './db';
import { Repository, DEFAULT_SETTINGS, type Snapshot } from './repository';
import { parseBackup, serialiseBackup } from './backup';

const team: Team = {
  id: 'team_n',
  name: 'kalavinka',
  createdAt: 1,
  n01: {
    provider: 'n01',
    leagueId: 'lg_l3hI_3397',
    leagueTitle: 'ATDO',
    stableIdentity: { kind: 'name', value: 'kalavinka' },
    lastTournamentId: 't_ABvC_5234',
    lastTournamentTitle: '2026 3rd',
    lastTeamId: 'GpiQ',
    lastTeamName: 'kalavinka',
    lastDivisionIndex: 0,
    lastDivisionTitle: 'A',
    discipline: 'STEEL',
    managedFormatId: 'fmt_n',
    linkedAt: 1,
    lastSuccessfulSyncAt: 2,
  },
};

const player: Player = {
  id: 'pl_n',
  teamId: 'team_n',
  name: '橋本 千尋',
  rating: 14,
  ppr: 61,
  pprSource: 'manual',
  skills: { SINGLES: 4 },
  seasonAppearances: 2,
  seasonAppearancesByKind: {},
  archived: false,
  createdAt: 1,
  n01: {
    opid: 'op_hashimoto',
    currentOid: 'o3_op_hashimoto',
    currentTpid: 'GpiQ',
    sourceName: '橋本 千尋',
    rosterActive: true,
    lastSeenTournamentId: 't_ABvC_5234',
    lastSeenAt: 2,
    stats: { ppr: 52.89, score: 2500, darts: 141.8, legs: 17, tournamentId: 't_ABvC_5234', syncedAt: 2 },
  },
};

const format: LeagueFormat = {
  id: 'fmt_n',
  teamId: 'team_n',
  name: 'ATDO 2026 3rd A Division',
  discipline: 'STEEL',
  createdAt: 1,
  games: [
    {
      id: 'n01g_t_ABvC_5234_c1',
      order: 1,
      name: 'Team 1001',
      kinds: ['TEAM', 'G501'],
      playerCount: 4,
      n01: { schid: 'c1', numPart: 4, matchType: '01', startScore: 1001, limitLegCount: 1, group: null, subtitle: 'Team' },
    },
  ],
  source: {
    provider: 'n01',
    leagueId: 'lg_l3hI_3397',
    leagueTitle: 'ATDO',
    tournamentId: 't_ABvC_5234',
    tournamentTitle: '2026 3rd',
    divisionIndex: 0,
    divisionTitle: 'A',
    syncedAt: 2,
  },
};

const cache: N01SyncSnapshot = {
  id: 'sync:team_n',
  kind: 'sync',
  teamId: 'team_n',
  fetchedAt: 2,
  leagueId: 'lg_l3hI_3397',
  leagueTitle: 'ATDO',
  tournamentId: 't_ABvC_5234',
  tournamentTitle: '2026 3rd',
  teamTpid: 'GpiQ',
  teamName: 'kalavinka',
  divisionIndex: 0,
  divisionTitle: 'A',
  discipline: 'STEEL',
  formatDescription: 'Team 1001 ×1',
  rosterCount: 1,
  pprCount: 1,
};

describe('IndexedDB v3 (n01Cache)', () => {
  it('upgrades a v2 database in place, keeping its data', async () => {
    await new Promise<void>((resolve, reject) => {
      const request = indexedDB.open('darts-league-order', 2);
      request.onupgradeneeded = () => {
        for (const store of ['teams', 'players', 'formats', 'pairs', 'orders', 'seasonCommits', 'settings']) {
          request.result.createObjectStore(store, { keyPath: 'id' });
        }
      };
      request.onsuccess = () => {
        const db = request.result;
        const tx = db.transaction('teams', 'readwrite');
        tx.objectStore('teams').put({ id: 'old', name: 'Old Team', createdAt: 0 });
        tx.oncomplete = () => {
          db.close();
          resolve();
        };
        tx.onerror = () => reject(tx.error);
      };
      request.onerror = () => reject(request.error);
    });

    resetBackendCache();
    const repository = new Repository(await openBackend());
    expect((await repository.loadAll()).teams.map((entry) => entry.id)).toEqual(['old']);
    expect(await repository.loadN01Cache()).toEqual([]);
  });

  it('applies a sync as one transaction: all of it, or none of it', async () => {
    const backend = await openBackend();
    await backend.clearAll();
    const repository = new Repository(backend);
    await repository.applyN01Sync({ team, players: [player], format, cache: [cache] });
    const loaded = await repository.loadAll();
    expect(loaded.teams[0].n01).toEqual(team.n01);
    expect(loaded.players[0].n01).toEqual(player.n01);
    expect(loaded.formats[0].source).toEqual(format.source);
    expect(await repository.loadN01Cache()).toEqual([cache]);

    // A record without a key makes IndexedDB abort the transaction: nothing lands.
    const renamed = { ...team, name: 'renamed' };
    await expect(
      repository.applyN01Sync({ team: renamed, players: [{ ...player, id: undefined } as unknown as Player], format, cache: [] }),
    ).rejects.toBeTruthy();
    expect((await repository.loadAll()).teams[0].name).toBe('kalavinka');
  });

  it('deleting a team removes its cached n01 data too', async () => {
    const repository = new Repository(await openBackend());
    await repository.deleteTeam('team_n');
    expect(await repository.loadN01Cache()).toEqual([]);
  });

  it('the memory fallback applies a batch with the same result', async () => {
    const repository = new Repository(new MemoryBackend());
    await repository.applyN01Sync({ team, players: [player], format, cache: [cache] });
    expect((await repository.loadAll()).players[0].pprSource).toBe('manual');
    expect(await repository.loadN01Cache()).toHaveLength(1);
  });
});

describe('JSON backup with n01 bindings', () => {
  it('round-trips bindings, PPR source and managed formats; the cache is not exported', () => {
    const snapshot: Snapshot = {
      teams: [team],
      players: [player],
      formats: [format],
      pairs: [],
      orders: [],
      seasonCommits: [],
      settings: { ...DEFAULT_SETTINGS, activeTeamId: 'team_n' },
    };
    const text = serialiseBackup(snapshot);
    expect(text).not.toContain('sync:team_n');
    const parsed = parseBackup(text);
    if (!parsed.ok) throw new Error(parsed.errors.join());
    expect(parsed.snapshot.teams[0].n01).toEqual(team.n01);
    expect(parsed.snapshot.players[0]).toMatchObject({ n01: player.n01, pprSource: 'manual', rating: 14, ppr: 61 });
    expect(parsed.snapshot.formats[0].source).toEqual(format.source);
    expect(parsed.snapshot.formats[0].games[0].n01).toEqual(format.games[0].n01);
  });

  it('imports a damaged binding as a hand-made team rather than guessing', () => {
    const text = serialiseBackup({
      teams: [{ ...team, n01: { ...team.n01!, stableIdentity: undefined } as never }],
      players: [],
      formats: [],
      pairs: [],
      orders: [],
      seasonCommits: [],
      settings: DEFAULT_SETTINGS,
    });
    const parsed = parseBackup(text);
    if (!parsed.ok) throw new Error(parsed.errors.join());
    expect(parsed.snapshot.teams[0].n01).toBeUndefined();
  });
});
