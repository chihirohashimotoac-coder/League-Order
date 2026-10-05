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
  PairSetting,
  Player,
  SavedOrder,
  Team,
  TeamId,
} from '../domain/types';
import { Repository, type Snapshot } from '../storage/repository';
import type { BackendKind } from '../storage/db';
import { buildSeed } from '../storage/seed';

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
  settings: AppSettings;
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

  setActiveTeam(teamId: TeamId): void;
  saveTeam(team: Team): void;
  deleteTeam(teamId: TeamId): void;
  savePlayer(player: Player): void;
  savePlayers(players: readonly Player[]): void;
  deletePlayer(playerId: string): void;
  saveFormat(format: LeagueFormat): void;
  deleteFormat(formatId: string): void;
  savePair(pair: PairSetting): void;
  deletePair(pairId: string): void;
  saveOrder(order: SavedOrder): void;
  deleteOrder(orderId: string): void;
  saveSettings(settings: AppSettings): void;
  replaceEverything(snapshot: Snapshot): Promise<void>;
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
      novelty: 0.05,
      consecutive: 0.5,
      season: 0.25,
    },
  },
};

const STORAGE_NOTICES: Partial<Record<BackendKind, string>> = {
  localstorage:
    'IndexedDB が使用できないため localStorage に保存しています。データ量が多いと保存できない場合があります。',
  memory:
    'このブラウザ・モードでは保存領域が使用できません。データはこのタブを閉じると失われます。JSON エクスポートで控えを取ってください。',
};

export function AppStoreProvider({ children }: { children: ReactNode }): React.JSX.Element {
  const [data, setData] = useState<AppData>(EMPTY);
  const [ready, setReady] = useState(false);
  const [backendKind, setBackendKind] = useState<BackendKind | null>(null);
  const repositoryRef = useRef<Repository | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const repository = await Repository.open();
      repositoryRef.current = repository;
      let snapshot = await repository.loadAll();
      if (snapshot.teams.length === 0) {
        // First run: seed a usable example so "generate" works straight away.
        snapshot = buildSeed();
        await repository.replaceAll(snapshot);
      }
      if (cancelled) return;
      setBackendKind(repository.backendKind);
      setData(snapshot);
      setReady(true);
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  /** Applies a state change and persists it. Persistence failures never break the UI. */
  const write = useCallback(
    (update: (current: AppData) => AppData, persist: (repository: Repository) => Promise<void>) => {
      setData((current) => update(current));
      const repository = repositoryRef.current;
      if (repository) {
        void persist(repository).catch(() => {
          /* Reported through `storageNotice`; the in-memory state stays authoritative. */
        });
      }
    },
    [],
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
      settings: { ...data.settings, activeTeamId },
    });

    return {
      ...data,
      ready,
      backendKind,
      storageNotice: backendKind ? (STORAGE_NOTICES[backendKind] ?? null) : null,
      activeTeamId,
      activeTeam,
      teamPlayers,
      teamFormats,
      teamPairs,
      teamOrders,

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

      deleteTeam: (teamId) =>
        write(
          (current) => {
            const teams = current.teams.filter((team) => team.id !== teamId);
            return {
              ...current,
              teams,
              players: current.players.filter((player) => player.teamId !== teamId),
              formats: current.formats.filter((format) => format.teamId !== teamId),
              pairs: current.pairs.filter((pair) => pair.teamId !== teamId),
              orders: current.orders.filter((order) => order.teamId !== teamId),
              settings:
                current.settings.activeTeamId === teamId
                  ? { ...current.settings, activeTeamId: teams[0]?.id ?? null }
                  : current.settings,
            };
          },
          (repository) => repository.deleteTeam(teamId),
        ),

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

      deleteOrder: (orderId) =>
        write(
          (current) => ({ ...current, orders: current.orders.filter((o) => o.id !== orderId) }),
          (repository) => repository.deleteOrder(orderId),
        ),

      saveSettings: (settings) =>
        write(
          (current) => ({ ...current, settings }),
          (repository) => repository.saveSettings(settings),
        ),

      replaceEverything: async (incoming) => {
        setData(incoming);
        await repositoryRef.current?.replaceAll(incoming);
      },

      mergeEverything: async (incoming) => {
        setData((current) => ({
          teams: incoming.teams.reduce((acc, team) => upsert(acc, team), current.teams),
          players: incoming.players.reduce((acc, player) => upsert(acc, player), current.players),
          formats: incoming.formats.reduce((acc, format) => upsert(acc, format), current.formats),
          pairs: incoming.pairs.reduce((acc, pair) => upsert(acc, pair), current.pairs),
          orders: incoming.orders.reduce((acc, order) => upsert(acc, order), current.orders),
          settings: current.settings,
        }));
        await repositoryRef.current?.mergeAll(incoming);
      },

      snapshot,
    };
  }, [data, ready, backendKind, write]);

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
