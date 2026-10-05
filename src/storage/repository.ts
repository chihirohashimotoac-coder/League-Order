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
import { mergeDefined } from '../utils/merge';
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
        }
      : DEFAULT_SETTINGS;

    return {
      teams: teams.sort((a, b) => a.createdAt - b.createdAt),
      players,
      formats,
      pairs,
      // Orders written by a build without versioning are read back as drafts.
      orders: orders
        .map((order) => ({ ...order, versions: order.versions ?? [] }))
        .sort((a, b) => b.createdAt - a.createdAt),
      seasonCommits,
      settings,
    };
  }

  saveTeam(team: Team): Promise<void> {
    return this.backend.put('teams', team);
  }

  async deleteTeam(teamId: string): Promise<void> {
    const [players, formats, pairs, orders, commits] = await Promise.all([
      this.backend.getAll<Player>('players'),
      this.backend.getAll<LeagueFormat>('formats'),
      this.backend.getAll<PairSetting>('pairs'),
      this.backend.getAll<SavedOrder>('orders'),
      this.backend.getAll<SeasonCommit>('seasonCommits'),
    ]);
    await Promise.all([
      ...players.filter((p) => p.teamId === teamId).map((p) => this.backend.remove('players', p.id)),
      ...formats.filter((f) => f.teamId === teamId).map((f) => this.backend.remove('formats', f.id)),
      ...pairs.filter((p) => p.teamId === teamId).map((p) => this.backend.remove('pairs', p.id)),
      ...orders.filter((o) => o.teamId === teamId).map((o) => this.backend.remove('orders', o.id)),
      ...commits.filter((c) => c.teamId === teamId).map((c) => this.backend.remove('seasonCommits', c.id)),
    ]);
    await this.backend.remove('teams', teamId);
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

  async deleteOrder(orderId: string): Promise<void> {
    await this.backend.remove('orders', orderId);
    // The ledger entry is meaningless without its order; the caller is responsible for
    // withdrawing the season contribution first if that is what the user wanted.
    await this.backend.remove('seasonCommits', orderId);
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
