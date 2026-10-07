import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import type {
  AppSettings,
  LeagueFormat,
  OrderId,
  OrderVersion,
  PairSetting,
  Player,
  SavedOrder,
  SeasonCommit,
  Team,
  TeamId,
} from '../domain/types';
import type { N01CacheRecord } from '../domain/n01/types';
import { planSeasonCommit, planSeasonWithdrawal } from '../domain/orders/seasonLedger';
import { Repository, type Snapshot } from '../storage/repository';
import type { BackendKind } from '../storage/db';
import { buildSeed } from '../storage/seed';
import { useToast } from '../components/ui';

/**
 * Application data store.
 *
 * All persistent entities live here; the optimizer and the order session never touch
 * storage. Every mutation updates React state first and then writes through to the
 * repository, so the UI stays responsive and keeps working if a write fails (which is
 * exactly what happens on the in-memory fallback backend).
 */

export interface AppData {
  teams: Team[];
  players: Player[];
  formats: LeagueFormat[];
  pairs: PairSetting[];
  orders: SavedOrder[];
  seasonCommits: SeasonCommit[];
  settings: AppSettings;
  /** Cached n01 data (derived, re-fetchable; not part of backups). */
  n01Cache: N01CacheRecord[];
}

/** Records an n01 sync writes in one batch (see `integrations/n01/sync.ts`). */
export interface N01SyncWrite {
  team: Team;
  players: readonly Player[];
  format: LeagueFormat | null;
  cache: readonly N01CacheRecord[];
}

/**
 * Outcome of a delete attempt.
 *
 * An order whose appearances are still counted in the season totals cannot be deleted:
 * see `deleteOrder` below and `Repository.deleteOrder`.
 */
export interface DeleteOrderResult {
  ok: boolean;
  reason: 'deleted' | 'seasonCommitted' | 'notFound';
  message: string;
}

export const SEASON_COMMITTED_DELETE_MESSAGE =
  'このオーダーはシーズン成績へ反映されています。先に「シーズン反映を取り消す」必要があります。';

/** Outcome of a season commit, so the UI can report exactly what moved. */
export interface SeasonCommitResult {
  ok: boolean;
  /** Number of players whose totals changed. */
  changed: number;
  /** True when the commit was already up to date and nothing was applied. */
  noop: boolean;
  /** Players whose totals had to be clamped at zero (hand-edited totals). */
  clamped: string[];
  message: string;
}

export interface AppStore extends AppData {
  ready: boolean;
  backendKind: BackendKind | null;
  /** Non-null when persistence is degraded and the user should be told. */
  storageNotice: string | null;
  activeTeamId: TeamId | null;
  activeTeam: Team | null;
  /** Players of the active team, non-archived first. */
  teamPlayers: Player[];
  /** Formats usable by the active team (team-specific plus shared). */
  teamFormats: LeagueFormat[];
  teamPairs: PairSetting[];
  teamOrders: SavedOrder[];
  /** Ledger lookup by order id. */
  seasonCommitFor(orderId: OrderId): SeasonCommit | null;

  setActiveTeam(teamId: TeamId): void;
  saveTeam(team: Team): void;
  /** Resolves once the deletion is stored, so a confirmed delete cannot come back. */
  deleteTeam(teamId: TeamId): Promise<void>;
  savePlayer(player: Player): void;
  savePlayers(players: readonly Player[]): void;
  deletePlayer(playerId: string): void;
  saveFormat(format: LeagueFormat): void;
  deleteFormat(formatId: string): void;
  savePair(pair: PairSetting): void;
  deletePair(pairId: string): void;
  saveOrder(order: SavedOrder): void;
  /**
   * Deletes a saved order, or refuses when its season contribution is still counted.
   * Deleting never rolls season totals back by itself — that is `withdrawSeason`.
   */
  deleteOrder(orderId: string): DeleteOrderResult;
  saveSettings(settings: AppSettings): void;
  /**
   * Applies a finalized version's appearances to the season totals, idempotently.
   * Re-running it for the same version changes nothing; running it for a newer version
   * applies only the difference (see `domain/orders/seasonLedger.ts`).
   */
  commitSeason(order: SavedOrder, version: OrderVersion): SeasonCommitResult;
  /** Withdraws an order's season contribution entirely. */
  withdrawSeason(orderId: OrderId): SeasonCommitResult;
  replaceEverything(snapshot: Snapshot): Promise<void>;
  /** First run: installs the sample team (labelled as demo data). */
  loadSample(): Promise<void>;
  /**
   * First run: creates the captain's own team with its roster and first format in one
   * step, and makes it the active team.
   */
  createTeamSetup(team: Team, players: readonly Player[], format: LeagueFormat): Promise<void>;
  /**
   * Stores the result of an n01 sync (team binding, players, managed format, cache) as one
   * batch, and only then shows it. `activate` makes the team the active one (new teams).
   */
  applyN01Sync(write: N01SyncWrite, options?: { activate?: boolean }): Promise<void>;
  /** Cached n01 records of a team. */
  n01CacheFor(teamId: TeamId): N01CacheRecord[];
  mergeEverything(snapshot: Snapshot): Promise<void>;
  snapshot(): Snapshot;
}

const AppStoreContext = createContext<AppStore | null>(null);

const EMPTY: AppData = {
  teams: [],
  players: [],
  formats: [],
  pairs: [],
  orders: [],
  seasonCommits: [],
  n01Cache: [],
  settings: {
    activeTeamId: null,
    optimizer: {
      defaultMaxConsecutive: 2,
      consecutiveMode: 'soft',
      minAppearanceMode: 'hard',
      fairnessScope: 'today',
      timeLimitMs: 1200,
      nodeLimit: 300_000,
      maxCombosPerGame: 400,
      beamWidth: 48,
    },
    lastPreset: 'BALANCED',
    customWeights: {
      strength: 0.6,
      gameFit: 0.5,
      pairFit: 0.4,
      fairness: 0.9,
      roleFairness: 0.3,
      novelty: 0.05,
      consecutive: 0.5,
      season: 0.25,
    },
    n01: { autoSync: true, historyDepth: 2, showPredictions: true },
  },
};

const STORAGE_NOTICES: Partial<Record<BackendKind, string>> = {
  localstorage:
    'IndexedDB が使用できないため localStorage に保存しています。データ量が多いと保存できない場合があります。',
  memory:
    'このブラウザ・モードでは保存領域が使用できません。データはこのタブを閉じると失われます。JSON エクスポートで控えを取ってください。',
};

const WRITE_FAILURE_NOTICE =
  '保存に失敗しました。表示中の内容はこのタブでは有効ですが、保存されていません。JSON エクスポートで控えを取ってください。';

export function AppStoreProvider({ children }: { children: ReactNode }): React.JSX.Element {
  const [data, setData] = useState<AppData>(EMPTY);
  const [ready, setReady] = useState(false);
  const [backendKind, setBackendKind] = useState<BackendKind | null>(null);
  /** Set once a write has actually failed, so a lost save is never silent (spec §24). */
  const [writeFailed, setWriteFailed] = useState(false);
  const repositoryRef = useRef<Repository | null>(null);
  const toast = useToast();

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const repository = await Repository.open();
      repositoryRef.current = repository;
      // No seeding here: an empty database is the first-run state, where the captain
      // chooses between their own team and the sample (see `loadSample`). Seeding
      // silently made the demo roster look like real data, and "delete everything" could
      // never get back to a clean start.
      const [snapshot, n01Cache] = await Promise.all([
        repository.loadAll(),
        // The cache is a convenience: a failure to read it must never stop the app.
        repository.loadN01Cache().catch(() => [] as N01CacheRecord[]),
      ]);
      if (cancelled) return;
      setBackendKind(repository.backendKind);
      setData({ ...snapshot, n01Cache });
      setReady(true);
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  /**
   * Applies a state change and persists it.
   *
   * A persistence failure never breaks the UI — the in-memory state stays authoritative
   * so the captain can finish the match — but it is never swallowed either: a lost write
   * is reported immediately and latched into `storageNotice`, because a save that only
   * looks successful is how an order disappears on the next reload (spec §24).
   */
  const write = useCallback(
    (update: (current: AppData) => AppData, persist: (repository: Repository) => Promise<void>) => {
      setData((current) => update(current));
      const repository = repositoryRef.current;
      if (repository) {
        void persist(repository).catch(() => {
          setWriteFailed(true);
          toast.show(WRITE_FAILURE_NOTICE, 'error');
        });
      }
    },
    [toast],
  );

  const store = useMemo<AppStore>(() => {
    const activeTeamId =
      data.settings.activeTeamId && data.teams.some((team) => team.id === data.settings.activeTeamId)
        ? data.settings.activeTeamId
        : (data.teams[0]?.id ?? null);

    const activeTeam = data.teams.find((team) => team.id === activeTeamId) ?? null;

    const teamPlayers = data.players
      .filter((player) => player.teamId === activeTeamId)
      .sort(
        (a, b) =>
          Number(a.archived) - Number(b.archived) ||
          a.createdAt - b.createdAt ||
          a.name.localeCompare(b.name, 'ja'),
      );

    const teamFormats = data.formats
      .filter((format) => format.teamId === activeTeamId || format.teamId === null)
      .sort((a, b) => a.createdAt - b.createdAt);

    const teamPairs = data.pairs.filter((pair) => pair.teamId === activeTeamId);
    const teamOrders = data.orders
      .filter((order) => order.teamId === activeTeamId)
      .sort((a, b) => b.createdAt - a.createdAt);

    const snapshot = (): Snapshot => ({
      teams: data.teams,
      players: data.players,
      formats: data.formats,
      pairs: data.pairs,
      orders: data.orders,
      seasonCommits: data.seasonCommits,
      settings: { ...data.settings, activeTeamId },
    });

    const seasonCommitFor = (orderId: OrderId): SeasonCommit | null =>
      data.seasonCommits.find((commit) => commit.id === orderId) ?? null;

    return {
      ...data,
      ready,
      backendKind,
      storageNotice: writeFailed
        ? WRITE_FAILURE_NOTICE
        : backendKind
          ? (STORAGE_NOTICES[backendKind] ?? null)
          : null,
      activeTeamId,
      activeTeam,
      teamPlayers,
      teamFormats,
      teamPairs,
      teamOrders,
      seasonCommitFor,

      setActiveTeam: (teamId) =>
        write(
          (current) => ({ ...current, settings: { ...current.settings, activeTeamId: teamId } }),
          (repository) => repository.saveSettings({ ...data.settings, activeTeamId: teamId }),
        ),

      saveTeam: (team) =>
        write(
          (current) => ({
            ...current,
            teams: upsert(current.teams, team),
            settings: current.settings.activeTeamId
              ? current.settings
              : { ...current.settings, activeTeamId: team.id },
          }),
          async (repository) => {
            await repository.saveTeam(team);
            if (!data.settings.activeTeamId) {
              await repository.saveSettings({ ...data.settings, activeTeamId: team.id });
            }
          },
        ),

      /**
       * Deletes a team and everything scoped to it.
       *
       * Unlike the ordinary writes above, this one persists *before* the UI reports the
       * team gone, and the caller awaits it. Deleting a team is confirmed, destructive
       * and unrecoverable, so the one thing it must never do is look done and then come
       * back: with the optimistic path the screen updated immediately while the removal
       * was still in flight, and reopening the app in that window brought the team back
       * with all of its data. Paying a few milliseconds here buys a deletion that means
       * what it says.
       *
       * The new active team is saved in the same step. Previously only the in-memory copy
       * moved, leaving stored settings pointing at a team that no longer existed.
       */
      deleteTeam: async (teamId) => {
        const remaining = data.teams.filter((team) => team.id !== teamId);
        const settings =
          data.settings.activeTeamId === teamId
            ? { ...data.settings, activeTeamId: remaining[0]?.id ?? null }
            : data.settings;

        const repository = repositoryRef.current;
        if (repository) {
          try {
            await repository.deleteTeam(teamId);
            await repository.saveSettings(settings);
          } catch (error) {
            setWriteFailed(true);
            toast.show(WRITE_FAILURE_NOTICE, 'error');
            throw error;
          }
        }

        setData((current) => {
          const teams = current.teams.filter((team) => team.id !== teamId);
          return {
            ...current,
            teams,
            players: current.players.filter((player) => player.teamId !== teamId),
            formats: current.formats.filter((format) => format.teamId !== teamId),
            pairs: current.pairs.filter((pair) => pair.teamId !== teamId),
            orders: current.orders.filter((order) => order.teamId !== teamId),
            seasonCommits: current.seasonCommits.filter((commit) => commit.teamId !== teamId),
            n01Cache: current.n01Cache.filter((record) => record.teamId !== teamId),
            settings:
              current.settings.activeTeamId === teamId
                ? { ...current.settings, activeTeamId: teams[0]?.id ?? null }
                : current.settings,
          };
        });
      },

      savePlayer: (player) =>
        write(
          (current) => ({ ...current, players: upsert(current.players, player) }),
          (repository) => repository.savePlayer(player),
        ),

      savePlayers: (players) =>
        write(
          (current) => ({
            ...current,
            players: players.reduce((acc, player) => upsert(acc, player), current.players),
          }),
          (repository) => repository.savePlayers(players),
        ),

      deletePlayer: (playerId) =>
        write(
          (current) => ({
            ...current,
            players: current.players.filter((player) => player.id !== playerId),
            // Pair settings that reference the removed player are meaningless.
            pairs: current.pairs.filter((pair) => pair.a !== playerId && pair.b !== playerId),
          }),
          async (repository) => {
            await repository.deletePlayer(playerId);
            for (const pair of data.pairs.filter((p) => p.a === playerId || p.b === playerId)) {
              await repository.deletePair(pair.id);
            }
          },
        ),

      saveFormat: (format) =>
        write(
          (current) => ({ ...current, formats: upsert(current.formats, format) }),
          (repository) => repository.saveFormat(format),
        ),

      deleteFormat: (formatId) =>
        write(
          (current) => ({ ...current, formats: current.formats.filter((f) => f.id !== formatId) }),
          (repository) => repository.deleteFormat(formatId),
        ),

      savePair: (pair) =>
        write(
          (current) => ({ ...current, pairs: upsert(current.pairs, pair) }),
          (repository) => repository.savePair(pair),
        ),

      deletePair: (pairId) =>
        write(
          (current) => ({ ...current, pairs: current.pairs.filter((p) => p.id !== pairId) }),
          (repository) => repository.deletePair(pairId),
        ),

      saveOrder: (order) =>
        write(
          (current) => ({ ...current, orders: upsert(current.orders, order) }),
          (repository) => repository.saveOrder(order),
        ),

      deleteOrder: (orderId) => {
        // Season totals are the one thing in this app that cannot be reconstructed from
        // anything else. An order that still has a ledger entry is therefore undeletable
        // until the captain explicitly withdraws the contribution, which keeps the two
        // steps visible instead of silently changing the standings.
        if (seasonCommitFor(orderId)) {
          return {
            ok: false,
            reason: 'seasonCommitted',
            message: SEASON_COMMITTED_DELETE_MESSAGE,
          };
        }
        if (!data.orders.some((order) => order.id === orderId)) {
          return { ok: false, reason: 'notFound', message: 'オーダーが見つかりません' };
        }

        write(
          (current) => ({
            ...current,
            orders: current.orders.filter((o) => o.id !== orderId),
          }),
          async (repository) => {
            // The repository re-checks against stored state, so the invariant survives
            // even if this in-memory copy were somehow stale.
            const outcome = await repository.deleteOrder(orderId);
            if (outcome === 'blocked') throw new Error(SEASON_COMMITTED_DELETE_MESSAGE);
          },
        );
        return { ok: true, reason: 'deleted', message: '削除しました' };
      },

      saveSettings: (settings) =>
        write(
          (current) => ({ ...current, settings }),
          (repository) => repository.saveSettings(settings),
        ),

      commitSeason: (order, version) => {
        const existing = seasonCommitFor(order.id);
        const plan = planSeasonCommit(
          order.id,
          order.teamId,
          version,
          existing,
          data.players,
          Date.now(),
        );
        const commit = plan.commit!;
        const updatedOrder: SavedOrder = { ...order, seasonApplied: true, updatedAt: Date.now() };

        write(
          (current) => ({
            ...current,
            players: plan.updatedPlayers.reduce((acc, player) => upsert(acc, player), current.players),
            orders: upsert(current.orders, updatedOrder),
            seasonCommits: upsert(current.seasonCommits, commit),
          }),
          async (repository) => {
            await repository.savePlayers(plan.updatedPlayers);
            await repository.saveOrder(updatedOrder);
            await repository.saveSeasonCommit(commit);
          },
        );

        return {
          ok: true,
          changed: plan.updatedPlayers.length,
          noop: plan.noop,
          clamped: plan.clamped,
          message: plan.noop
            ? `v${version.version} は既に反映済みです (二重加算はありません)`
            : `v${version.version} をシーズン累計へ反映しました (${plan.updatedPlayers.length} 名を更新)`,
        };
      },

      withdrawSeason: (orderId) => {
        const existing = seasonCommitFor(orderId);
        if (!existing) {
          return { ok: false, changed: 0, noop: true, clamped: [], message: 'まだ反映されていません' };
        }
        const plan = planSeasonWithdrawal(existing, data.players);
        const order = data.orders.find((entry) => entry.id === orderId);
        const updatedOrder = order ? { ...order, seasonApplied: false, updatedAt: Date.now() } : null;

        write(
          (current) => ({
            ...current,
            players: plan.updatedPlayers.reduce((acc, player) => upsert(acc, player), current.players),
            orders: updatedOrder ? upsert(current.orders, updatedOrder) : current.orders,
            seasonCommits: current.seasonCommits.filter((commit) => commit.id !== orderId),
          }),
          async (repository) => {
            await repository.savePlayers(plan.updatedPlayers);
            if (updatedOrder) await repository.saveOrder(updatedOrder);
            await repository.deleteSeasonCommit(orderId);
          },
        );

        return {
          ok: true,
          changed: plan.updatedPlayers.length,
          noop: plan.noop,
          clamped: plan.clamped,
          message: `シーズン反映を取り消しました (${plan.updatedPlayers.length} 名を更新)`,
        };
      },

      replaceEverything: async (incoming) => {
        // A replace clears every store, the n01 cache included (it is re-fetchable).
        setData({ ...incoming, n01Cache: [] });
        try {
          await repositoryRef.current?.replaceAll(incoming);
        } catch (error) {
          setWriteFailed(true);
          toast.show(WRITE_FAILURE_NOTICE, 'error');
          throw error;
        }
      },

      loadSample: async () => {
        const sample = buildSeed();
        setData({ ...sample, n01Cache: [] });
        try {
          await repositoryRef.current?.replaceAll(sample);
        } catch (error) {
          setWriteFailed(true);
          toast.show(WRITE_FAILURE_NOTICE, 'error');
          throw error;
        }
      },

      createTeamSetup: async (team, players, format) => {
        const settings = { ...data.settings, activeTeamId: team.id };
        setData((current) => ({
          ...current,
          teams: upsert(current.teams, team),
          players: players.reduce((acc, player) => upsert(acc, player), current.players),
          formats: upsert(current.formats, format),
          settings: { ...current.settings, activeTeamId: team.id },
        }));
        const repository = repositoryRef.current;
        if (!repository) return;
        try {
          await repository.saveTeam(team);
          await repository.savePlayers(players);
          await repository.saveFormat(format);
          await repository.saveSettings(settings);
        } catch (error) {
          setWriteFailed(true);
          toast.show(WRITE_FAILURE_NOTICE, 'error');
          throw error;
        }
      },

      applyN01Sync: async (change, options = {}) => {
        const settings = options.activate ? { ...data.settings, activeTeamId: change.team.id } : undefined;
        const repository = repositoryRef.current;
        if (repository) {
          try {
            await repository.applyN01Sync({ ...change, settings });
          } catch (error) {
            setWriteFailed(true);
            toast.show(WRITE_FAILURE_NOTICE, 'error');
            throw error;
          }
        }
        setData((current) => ({
          ...current,
          teams: upsert(current.teams, change.team),
          players: change.players.reduce((acc, player) => upsert(acc, player), current.players),
          formats: change.format ? upsert(current.formats, change.format) : current.formats,
          n01Cache: change.cache.reduce((acc, record) => upsert(acc, record), current.n01Cache),
          settings: options.activate
            ? { ...current.settings, activeTeamId: change.team.id }
            : current.settings,
        }));
      },

      n01CacheFor: (teamId) => data.n01Cache.filter((record) => record.teamId === teamId),

      mergeEverything: async (incoming) => {
        setData((current) => ({
          teams: incoming.teams.reduce((acc, team) => upsert(acc, team), current.teams),
          players: incoming.players.reduce((acc, player) => upsert(acc, player), current.players),
          formats: incoming.formats.reduce((acc, format) => upsert(acc, format), current.formats),
          pairs: incoming.pairs.reduce((acc, pair) => upsert(acc, pair), current.pairs),
          orders: incoming.orders.reduce((acc, order) => upsert(acc, order), current.orders),
          seasonCommits: incoming.seasonCommits.reduce(
            (acc, commit) => upsert(acc, commit),
            current.seasonCommits,
          ),
          settings: current.settings,
          n01Cache: current.n01Cache,
        }));
        try {
          await repositoryRef.current?.mergeAll(incoming);
        } catch (error) {
          setWriteFailed(true);
          toast.show(WRITE_FAILURE_NOTICE, 'error');
          throw error;
        }
      },

      snapshot,
    };
  }, [data, ready, backendKind, writeFailed, write, toast]);

  return <AppStoreContext.Provider value={store}>{children}</AppStoreContext.Provider>;
}

function upsert<T extends { id: string }>(list: readonly T[], value: T): T[] {
  const index = list.findIndex((entry) => entry.id === value.id);
  if (index < 0) return [...list, value];
  const next = [...list];
  next[index] = value;
  return next;
}

export function useAppStore(): AppStore {
  const store = useContext(AppStoreContext);
  if (!store) throw new Error('useAppStore must be used inside <AppStoreProvider>');
  return store;
}
