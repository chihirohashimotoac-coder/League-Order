/**
 * Persistence backends (docs/DESIGN.md §10).
 *
 * The app is offline-first, so storage must never be the reason it fails to start.
 * Three backends are tried in order and the first that works is used:
 *
 * 1. **IndexedDB** — the real store; survives reloads and works offline.
 * 2. **localStorage** — fallback for browsers/modes where IndexedDB is blocked.
 * 3. **memory** — last resort (private windows with all storage disabled). The app
 *    still works for the session; the UI warns that nothing will be saved.
 *
 * All three implement one interface, so nothing above this file knows which is active.
 */

export const STORE_NAMES = [
  'teams',
  'players',
  'formats',
  'pairs',
  'orders',
  'seasonCommits',
  'settings',
  // Cached n01 data (docs/N01_MASTER_DESIGN.md §5): derived, re-fetchable, never exported.
  'n01Cache',
] as const;

export type StoreName = (typeof STORE_NAMES)[number];

export interface Identified {
  id: string;
}

export type BackendKind = 'indexeddb' | 'localstorage' | 'memory';

/** One store's part of a batch: records to put and ids to remove. */
export interface BatchOperation {
  store: StoreName;
  put?: readonly Identified[];
  remove?: readonly string[];
}

export interface StorageBackend {
  readonly kind: BackendKind;
  getAll<T extends Identified>(store: StoreName): Promise<T[]>;
  get<T extends Identified>(store: StoreName, id: string): Promise<T | undefined>;
  put<T extends Identified>(store: StoreName, value: T): Promise<void>;
  putMany<T extends Identified>(store: StoreName, values: readonly T[]): Promise<void>;
  remove(store: StoreName, id: string): Promise<void>;
  clear(store: StoreName): Promise<void>;
  clearAll(): Promise<void>;
  /**
   * Applies writes to several stores as one unit. On IndexedDB this is a single
   * transaction: either every write lands or none does, so a sync can never leave a team
   * pointing at a format that was not saved.
   */
  writeBatch(operations: readonly BatchOperation[]): Promise<void>;
}

const DB_NAME = 'darts-league-order';
// v2 added the `seasonCommits` store, v3 the `n01Cache` store. The upgrade handler
// creates any store that is missing, so an existing database is upgraded in place with
// its data intact.
const DB_VERSION = 3;

function promisify<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('IndexedDB request failed'));
  });
}

class IndexedDbBackend implements StorageBackend {
  readonly kind = 'indexeddb' as const;

  private constructor(private readonly db: IDBDatabase) {}

  static async open(): Promise<IndexedDbBackend> {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, DB_VERSION);
      request.onupgradeneeded = () => {
        const upgraded = request.result;
        for (const store of STORE_NAMES) {
          if (!upgraded.objectStoreNames.contains(store)) {
            upgraded.createObjectStore(store, { keyPath: 'id' });
          }
        }
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error ?? new Error('IndexedDB open failed'));
      request.onblocked = () => reject(new Error('IndexedDB open blocked by another tab'));
    });
    return new IndexedDbBackend(db);
  }

  private tx(store: StoreName, mode: IDBTransactionMode): IDBObjectStore {
    return this.db.transaction(store, mode).objectStore(store);
  }

  async getAll<T extends Identified>(store: StoreName): Promise<T[]> {
    return promisify(this.tx(store, 'readonly').getAll() as IDBRequest<T[]>);
  }

  async get<T extends Identified>(store: StoreName, id: string): Promise<T | undefined> {
    return promisify(this.tx(store, 'readonly').get(id) as IDBRequest<T | undefined>);
  }

  async put<T extends Identified>(store: StoreName, value: T): Promise<void> {
    await promisify(this.tx(store, 'readwrite').put(value));
  }

  async putMany<T extends Identified>(store: StoreName, values: readonly T[]): Promise<void> {
    if (values.length === 0) return;
    const transaction = this.db.transaction(store, 'readwrite');
    const target = transaction.objectStore(store);
    for (const value of values) target.put(value);
    await new Promise<void>((resolve, reject) => {
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error ?? new Error('IndexedDB write failed'));
      transaction.onabort = () => reject(transaction.error ?? new Error('IndexedDB write aborted'));
    });
  }

  async remove(store: StoreName, id: string): Promise<void> {
    await promisify(this.tx(store, 'readwrite').delete(id));
  }

  async clear(store: StoreName): Promise<void> {
    await promisify(this.tx(store, 'readwrite').clear());
  }

  async clearAll(): Promise<void> {
    for (const store of STORE_NAMES) await this.clear(store);
  }

  async writeBatch(operations: readonly BatchOperation[]): Promise<void> {
    const stores = [...new Set(operations.map((operation) => operation.store))];
    if (stores.length === 0) return;
    const transaction = this.db.transaction(stores, 'readwrite');
    const done = new Promise<void>((resolve, reject) => {
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error ?? new Error('IndexedDB write failed'));
      transaction.onabort = () => reject(transaction.error ?? new Error('IndexedDB write aborted'));
    });
    try {
      for (const operation of operations) {
        const target = transaction.objectStore(operation.store);
        for (const id of operation.remove ?? []) target.delete(id);
        for (const value of operation.put ?? []) target.put(value);
      }
    } catch (error) {
      // `put` throws synchronously for a record it cannot key. The writes queued before it
      // would otherwise still commit, so the whole transaction is aborted explicitly.
      transaction.abort();
      await done.catch(() => undefined);
      throw error;
    }
    await done;
  }
}

/** Shared implementation for the two synchronous fallbacks. */
abstract class MapBackend implements StorageBackend {
  abstract readonly kind: BackendKind;

  protected abstract read(store: StoreName): Identified[];
  protected abstract write(store: StoreName, values: Identified[]): void;

  async getAll<T extends Identified>(store: StoreName): Promise<T[]> {
    return this.read(store) as T[];
  }

  async get<T extends Identified>(store: StoreName, id: string): Promise<T | undefined> {
    return this.read(store).find((entry) => entry.id === id) as T | undefined;
  }

  async put<T extends Identified>(store: StoreName, value: T): Promise<void> {
    await this.putMany(store, [value]);
  }

  async putMany<T extends Identified>(store: StoreName, values: readonly T[]): Promise<void> {
    const current = this.read(store);
    for (const value of values) {
      const index = current.findIndex((entry) => entry.id === value.id);
      if (index >= 0) current[index] = value;
      else current.push(value);
    }
    this.write(store, current);
  }

  async remove(store: StoreName, id: string): Promise<void> {
    this.write(
      store,
      this.read(store).filter((entry) => entry.id !== id),
    );
  }

  async clear(store: StoreName): Promise<void> {
    this.write(store, []);
  }

  async clearAll(): Promise<void> {
    for (const store of STORE_NAMES) await this.clear(store);
  }

  async writeBatch(operations: readonly BatchOperation[]): Promise<void> {
    // Synchronous stores: compute every new store state first, then write them all, so a
    // failure while computing leaves nothing half-applied.
    const next = new Map<StoreName, Identified[]>();
    for (const operation of operations) {
      const current = next.get(operation.store) ?? this.read(operation.store);
      const removed = new Set(operation.remove ?? []);
      const kept = current.filter((entry) => !removed.has(entry.id));
      for (const value of operation.put ?? []) {
        const index = kept.findIndex((entry) => entry.id === value.id);
        if (index >= 0) kept[index] = value;
        else kept.push(value);
      }
      next.set(operation.store, kept);
    }
    for (const [store, values] of next) this.write(store, values);
  }
}

class LocalStorageBackend extends MapBackend {
  readonly kind = 'localstorage' as const;

  protected read(store: StoreName): Identified[] {
    try {
      const raw = localStorage.getItem(`${DB_NAME}:${store}`);
      const parsed = raw ? JSON.parse(raw) : [];
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }

  protected write(store: StoreName, values: Identified[]): void {
    try {
      localStorage.setItem(`${DB_NAME}:${store}`, JSON.stringify(values));
    } catch {
      // Quota exceeded or storage disabled mid-session: the in-memory copy held by the
      // app state is still correct, so losing the write is preferable to crashing.
    }
  }
}

class MemoryBackend extends MapBackend {
  readonly kind = 'memory' as const;
  private readonly data = new Map<StoreName, Identified[]>();

  protected read(store: StoreName): Identified[] {
    return [...(this.data.get(store) ?? [])];
  }

  protected write(store: StoreName, values: Identified[]): void {
    this.data.set(store, values);
  }
}

async function probeLocalStorage(): Promise<boolean> {
  try {
    const key = `${DB_NAME}:probe`;
    localStorage.setItem(key, '1');
    localStorage.removeItem(key);
    return true;
  } catch {
    return false;
  }
}

let cached: Promise<StorageBackend> | null = null;

/** Opens (once per page load) the best backend this environment supports. */
export function openBackend(): Promise<StorageBackend> {
  if (!cached) {
    cached = (async () => {
      if (typeof indexedDB !== 'undefined') {
        try {
          return await IndexedDbBackend.open();
        } catch {
          // Fall through to the next backend.
        }
      }
      if (typeof localStorage !== 'undefined' && (await probeLocalStorage())) {
        return new LocalStorageBackend();
      }
      return new MemoryBackend();
    })();
  }
  return cached;
}

/** Test seam: forgets the cached backend so the next call re-probes. */
export function resetBackendCache(): void {
  cached = null;
}

export { IndexedDbBackend, LocalStorageBackend, MemoryBackend };
