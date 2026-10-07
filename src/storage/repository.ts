import { DEFAULT_N01_SETTINGS } from '../domain/types';
import type {
  AppSettings,
  LeagueFormat,
  PairSetting,
  Player,
  SavedOrder,
  SeasonCommit,
  Team,
} from '../domain/types';
import { DEFAULT_OPTIMIZER_SETTINGS, DEFAULT_WEIGHTS } from '../domain/orders/presets';
import type { N01CacheRecord } from '../domain/n01/types';
import { mergeDefined } from '../utils/merge';
import { normaliseFormat, normalisePlayer, normaliseSavedOrder } from '../domain/normalise';
import { openBackend, type BackendKind, type StorageBackend } from './db';

/**
 * Typed repository over the storage backend.
 *
 * Everything is scoped by team (spec §24): players, pairs, saved orders and
 * team-specific formats are kept apart, so switching team never mixes data.
 */

const SETTINGS_ID = 'app';

interface SettingsRecord extends AppSettings {
  id: typeof SETTINGS_ID;
}

export const DEFAULT_SETTINGS: AppSettings = {
  activeTeamId: null,
  optimizer: DEFAULT_OPTIMIZER_SETTINGS,
  lastPreset: 'BALANCED',
  customWeights: DEFAULT_WEIGHTS,
  n01: DEFAULT_N01_SETTINGS,
};

export interface Snapshot {
  teams: Team[];
  players: Player[];
  formats: LeagueFormat[];
  pairs: PairSetting[];
  orders: SavedOrder[];
  /** Season-commit ledger: what each order has already contributed to season totals. */
  seasonCommits: SeasonCommit[];
  settings: AppSettings;
}

export class Repository {
  constructor(private readonly backend: StorageBackend) {}

  static async open(): Promise<Repository> {
    return new Repository(await openBackend());
  }

  get backendKind(): BackendKind {
    return this.backend.kind;
  }

  /** Loads everything in one go — the dataset is small and the app works offline. */
  async loadAll(): Promise<Snapshot> {
    const [teams, players, formats, pairs, orders, seasonCommits, settingsRows] = await Promise.all([
      this.backend.getAll<Team>('teams'),
      this.backend.getAll<Player>('players'),
      this.backend.getAll<LeagueFormat>('formats'),
      this.backend.getAll<PairSetting>('pairs'),
      this.backend.getAll<SavedOrder>('orders'),
      this.backend.getAll<SeasonCommit>('seasonCommits'),
      this.backend.getAll<SettingsRecord>('settings'),
    ]);

    const stored = settingsRows.find((row) => row.id === SETTINGS_ID);
    const settings: AppSettings = stored
      ? {
          activeTeamId: stored.activeTeamId ?? null,
          // Merge rather than replace so a stored settings object written by an older
          // build still gains any newly introduced optimizer option. `mergeDefined`
          // skips undefined values, which a plain spread would copy over the default.
          optimizer: mergeDefined(DEFAULT_OPTIMIZER_SETTINGS, stored.optimizer),
          lastPreset: stored.lastPreset ?? 'BALANCED',
          customWeights: mergeDefined(DEFAULT_WEIGHTS, stored.customWeights),
          n01: mergeDefined(DEFAULT_N01_SETTINGS, stored.n01),
        }
      : DEFAULT_SETTINGS;

    // Records written by older builds are upgraded on read (PPR → Unknown, discipline →
    // UNSPECIFIED, …). Nothing is written back: the stored data stays exactly as it was.
    return {
      teams: teams.sort((a, b) => a.createdAt - b.createdAt),
      players: players.map(normalisePlayer),
      formats: formats.map(normaliseFormat),
      pairs,
      // Orders written by a build without versioning are read back as drafts.
      orders: orders.map(normaliseSavedOrder).sort((a, b) => b.createdAt - a.createdAt),
      seasonCommits,
      settings,
    };
  }

  saveTeam(team: Team): Promise<void> {
    return this.backend.put('teams', team);
  }

  async deleteTeam(teamId: string): Promise<void> {
    const [players, formats, pairs, orders, commits, cache] = await Promise.all([
      this.backend.getAll<Player>('players'),
      this.backend.getAll<LeagueFormat>('formats'),
      this.backend.getAll<PairSetting>('pairs'),
      this.backend.getAll<SavedOrder>('orders'),
      this.backend.getAll<SeasonCommit>('seasonCommits'),
      this.backend.getAll<N01CacheRecord>('n01Cache'),
    ]);
    await Promise.all([
      ...players.filter((p) => p.teamId === teamId).map((p) => this.backend.remove('players', p.id)),
      ...formats.filter((f) => f.teamId === teamId).map((f) => this.backend.remove('formats', f.id)),
      ...pairs.filter((p) => p.teamId === teamId).map((p) => this.backend.remove('pairs', p.id)),
      ...orders.filter((o) => o.teamId === teamId).map((o) => this.backend.remove('orders', o.id)),
      ...commits.filter((c) => c.teamId === teamId).map((c) => this.backend.remove('seasonCommits', c.id)),
      ...cache.filter((c) => c.teamId === teamId).map((c) => this.backend.remove('n01Cache', c.id)),
    ]);
    await this.backend.remove('teams', teamId);
  }

  /** Cached n01 data for every team (offline use, "last synced"). */
  loadN01Cache(): Promise<N01CacheRecord[]> {
    return this.backend.getAll<N01CacheRecord>('n01Cache');
  }

  /**
   * Stores the result of an n01 sync in one batch: the team (with its binding), the
   * changed players, the managed format and the cache records. On IndexedDB this is a
   * single transaction, so a sync is never half-applied.
   */
  applyN01Sync(change: {
    team: Team;
    players: readonly Player[];
    format: LeagueFormat | null;
    cache: readonly N01CacheRecord[];
    removeCache?: readonly string[];
    settings?: AppSettings;
  }): Promise<void> {
    return this.backend.writeBatch([
      { store: 'teams', put: [change.team] },
      { store: 'players', put: change.players },
      { store: 'formats', put: change.format ? [change.format] : [] },
      { store: 'n01Cache', put: change.cache, remove: change.removeCache ?? [] },
      ...(change.settings ? [{ store: 'settings' as const, put: [{ id: SETTINGS_ID, ...change.settings }] }] : []),
    ]);
  }

  saveN01Cache(records: readonly N01CacheRecord[]): Promise<void> {
    return this.backend.putMany('n01Cache', records);
  }

  savePlayer(player: Player): Promise<void> {
    return this.backend.put('players', player);
  }

  savePlayers(players: readonly Player[]): Promise<void> {
    return this.backend.putMany('players', players);
  }

  deletePlayer(playerId: string): Promise<void> {
    return this.backend.remove('players', playerId);
  }

  saveFormat(format: LeagueFormat): Promise<void> {
    return this.backend.put('formats', format);
  }

  deleteFormat(formatId: string): Promise<void> {
    return this.backend.remove('formats', formatId);
  }

  savePair(pair: PairSetting): Promise<void> {
    return this.backend.put('pairs', pair);
  }

  savePairs(pairs: readonly PairSetting[]): Promise<void> {
    return this.backend.putMany('pairs', pairs);
  }

  deletePair(pairId: string): Promise<void> {
    return this.backend.remove('pairs', pairId);
  }

  saveOrder(order: SavedOrder): Promise<void> {
    return this.backend.put('orders', order);
  }

  /**
   * Deletes a saved order — unless its season contribution is still counted.
   *
   * Removing the order while a ledger entry exists would strand the appearances it
   * added to the players' season totals: the amounts would stay in the totals with no
   * record of where they came from and no way left to withdraw them. The ledger entry
   * is therefore treated as a lock, and the refusal is enforced here rather than only
   * in the UI, so no caller can corrupt the totals by skipping the check.
   *
   * Withdrawing the contribution is a separate, explicit user action (`withdrawSeason`);
   * deleting must never roll season totals back on its own.
   */
  async deleteOrder(orderId: string): Promise<'deleted' | 'blocked'> {
    const commit = await this.backend.get<SeasonCommit>('seasonCommits', orderId);
    if (commit) return 'blocked';
    await this.backend.remove('orders', orderId);
    return 'deleted';
  }

  saveSeasonCommit(commit: SeasonCommit): Promise<void> {
    return this.backend.put('seasonCommits', commit);
  }

  deleteSeasonCommit(orderId: string): Promise<void> {
    return this.backend.remove('seasonCommits', orderId);
  }

  saveSettings(settings: AppSettings): Promise<void> {
    return this.backend.put<SettingsRecord>('settings', { id: SETTINGS_ID, ...settings });
  }

  /** Replaces the whole database. Used by JSON import in `replace` mode. */
  async replaceAll(snapshot: Snapshot): Promise<void> {
    await this.backend.clearAll();
    await Promise.all([
      this.backend.putMany('teams', snapshot.teams),
      this.backend.putMany('players', snapshot.players),
      this.backend.putMany('formats', snapshot.formats),
      this.backend.putMany('pairs', snapshot.pairs),
      this.backend.putMany('orders', snapshot.orders),
      this.backend.putMany('seasonCommits', snapshot.seasonCommits),
    ]);
    await this.saveSettings(snapshot.settings);
  }

  /** Upserts without clearing. Used by JSON import in `merge` mode. */
  async mergeAll(snapshot: Snapshot): Promise<void> {
    await Promise.all([
      this.backend.putMany('teams', snapshot.teams),
      this.backend.putMany('players', snapshot.players),
      this.backend.putMany('formats', snapshot.formats),
      this.backend.putMany('pairs', snapshot.pairs),
      this.backend.putMany('orders', snapshot.orders),
      this.backend.putMany('seasonCommits', snapshot.seasonCommits),
    ]);
  }

  clearEverything(): Promise<void> {
    return this.backend.clearAll();
  }
}
