/**
 * Analytics-only cache (design §6). It is a **separate IndexedDB database**
 * (`league-order-analytics`), so the app's database (`darts-league-order`, v3), its backup
 * format (v1) and the n01 sync cache are never opened, upgraded or written from here.
 *
 * Everything in it is re-fetchable from n01. Consequently:
 *  - entries expire (TTL) and the store is bounded (entry count and bytes, least recently
 *    used first);
 *  - no failure — IndexedDB blocked, quota exceeded, corrupt entry — may escape: the cache
 *    degrades to memory (for the open screen only) or to "no cache", and says so via
 *    {@link AnalyticsCache.mode}, but analytics and order generation keep working.
 */

export const ANALYTICS_DB_NAME = 'league-order-analytics';
export const ANALYTICS_DB_VERSION = 1;
const STORE = 'entries';

/** Bump when the cached shapes change; older entries are then treated as misses. */
export const ANALYTICS_CACHE_SCHEMA = 1;

export interface CacheEntry<T = unknown> {
  key: string;
  schema: number;
  fetchedAt: number;
  /** After this the entry is stale: usable offline, never presented as fresh. */
  expiresAt: number;
  lastAccess: number;
  bytes: number;
  value: T;
}

export interface CacheLimits {
  maxEntries: number;
  maxBytes: number;
}

export const DEFAULT_CACHE_LIMITS: CacheLimits = { maxEntries: 80, maxBytes: 12 * 1024 * 1024 };

/** How long an entry counts as fresh (ms). Finished seasons barely change; a running one does. */
export const TTL = {
  finishedSeason: 7 * 24 * 60 * 60 * 1000,
  runningSeason: 6 * 60 * 60 * 1000,
  leagueList: 6 * 60 * 60 * 1000,
} as const;

interface RawStore {
  all(): Promise<CacheEntry[]>;
  get(key: string): Promise<CacheEntry | undefined>;
  put(entry: CacheEntry): Promise<void>;
  delete(keys: readonly string[]): Promise<void>;
  clear(): Promise<void>;
}

class MemoryStore implements RawStore {
  private readonly map = new Map<string, CacheEntry>();
  async all() {
    return [...this.map.values()];
  }
  async get(key: string) {
    return this.map.get(key);
  }
  async put(entry: CacheEntry) {
    this.map.set(entry.key, entry);
  }
  async delete(keys: readonly string[]) {
    for (const key of keys) this.map.delete(key);
  }
  async clear() {
    this.map.clear();
  }
}

function request<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error('IndexedDB request failed'));
  });
}

class IdbStore implements RawStore {
  private constructor(private readonly db: IDBDatabase) {}

  static async open(): Promise<IdbStore> {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const open = indexedDB.open(ANALYTICS_DB_NAME, ANALYTICS_DB_VERSION);
      open.onupgradeneeded = () => {
        if (!open.result.objectStoreNames.contains(STORE)) open.result.createObjectStore(STORE, { keyPath: 'key' });
      };
      open.onsuccess = () => resolve(open.result);
      open.onerror = () => reject(open.error ?? new Error('IndexedDB open failed'));
      open.onblocked = () => reject(new Error('IndexedDB open blocked'));
    });
    return new IdbStore(db);
  }

  private store(mode: IDBTransactionMode): IDBObjectStore {
    return this.db.transaction(STORE, mode).objectStore(STORE);
  }
  async all() {
    return request(this.store('readonly').getAll() as IDBRequest<CacheEntry[]>);
  }
  async get(key: string) {
    return request(this.store('readonly').get(key) as IDBRequest<CacheEntry | undefined>);
  }
  async put(entry: CacheEntry) {
    await new Promise<void>((resolve, reject) => {
      const tx = this.db.transaction(STORE, 'readwrite');
      tx.objectStore(STORE).put(entry);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error ?? new Error('IndexedDB write failed'));
      tx.onabort = () => reject(tx.error ?? new Error('IndexedDB write aborted'));
    });
  }
  async delete(keys: readonly string[]) {
    if (keys.length === 0) return;
    await new Promise<void>((resolve, reject) => {
      const tx = this.db.transaction(STORE, 'readwrite');
      for (const key of keys) tx.objectStore(STORE).delete(key);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error ?? new Error('IndexedDB delete failed'));
    });
  }
  async clear() {
    await request(this.store('readwrite').clear());
  }
}

/** Where the cache is living right now. `none` = writes are being dropped. */
export type CacheMode = 'indexeddb' | 'memory' | 'none';

export interface AnalyticsCacheOptions {
  limits?: CacheLimits;
  now?: () => number;
  /** Forces the in-memory store (tests, or a browser without IndexedDB). */
  memoryOnly?: boolean;
}

export class AnalyticsCache {
  private store: RawStore | null = null;
  private opening: Promise<RawStore> | null = null;
  private currentMode: CacheMode = 'memory';
  private readonly limits: CacheLimits;
  private readonly now: () => number;

  constructor(private readonly options: AnalyticsCacheOptions = {}) {
    this.limits = options.limits ?? DEFAULT_CACHE_LIMITS;
    this.now = options.now ?? (() => Date.now());
  }

  get mode(): CacheMode {
    return this.currentMode;
  }

  private async backend(): Promise<RawStore> {
    if (this.store) return this.store;
    this.opening ??= (async () => {
      if (!this.options.memoryOnly && typeof indexedDB !== 'undefined') {
        try {
          const store = await IdbStore.open();
          this.currentMode = 'indexeddb';
          return store;
        } catch {
          // fall through to memory: analytics must work without durable storage
        }
      }
      this.currentMode = 'memory';
      return new MemoryStore();
    })();
    this.store = await this.opening;
    return this.store;
  }

  /** The entry, or `null` on a miss / wrong schema / any storage error. */
  async get<T>(key: string): Promise<CacheEntry<T> | null> {
    try {
      const store = await this.backend();
      const entry = await store.get(key);
      if (!entry || entry.schema !== ANALYTICS_CACHE_SCHEMA) return null;
      // Touching the entry is best effort; a failed touch must not turn a hit into a miss.
      store.put({ ...entry, lastAccess: this.now() }).catch(() => undefined);
      return entry as CacheEntry<T>;
    } catch {
      return null;
    }
  }

  isFresh(entry: CacheEntry): boolean {
    return entry.expiresAt > this.now();
  }

  /** Stores a JSON-safe value. Returns false when it could not be kept (never throws). */
  async put<T>(key: string, value: T, ttlMs: number): Promise<boolean> {
    let bytes: number;
    try {
      bytes = JSON.stringify(value).length;
    } catch {
      return false;
    }
    if (bytes > this.limits.maxBytes) return false;
    const at = this.now();
    const entry: CacheEntry<T> = { key, schema: ANALYTICS_CACHE_SCHEMA, fetchedAt: at, expiresAt: at + ttlMs, lastAccess: at, bytes, value };
    try {
      const store = await this.backend();
      await this.makeRoom(store, key, bytes);
      await store.put(entry);
      return true;
    } catch {
      // Quota or a broken database: drop the oldest half once and retry before giving up.
      try {
        const store = await this.backend();
        await this.evictOldest(store, 0.5);
        await store.put(entry);
        return true;
      } catch {
        this.currentMode = 'none';
        return false;
      }
    }
  }

  private async makeRoom(store: RawStore, incomingKey: string, incomingBytes: number): Promise<void> {
    const entries = (await store.all()).filter((e) => e.key !== incomingKey);
    // Entries of an older schema can never be read again. Merely expired ones stay: they are
    // the offline fallback, and leave only by LRU.
    const dead = entries.filter((e) => e.schema !== ANALYTICS_CACHE_SCHEMA).map((e) => e.key);
    const live = entries.filter((e) => !dead.includes(e.key)).sort((a, b) => a.lastAccess - b.lastAccess);
    let bytes = live.reduce((sum, e) => sum + e.bytes, 0) + incomingBytes;
    const evict = [...dead];
    while (live.length + 1 > this.limits.maxEntries || bytes > this.limits.maxBytes) {
      const oldest = live.shift();
      if (!oldest) break;
      evict.push(oldest.key);
      bytes -= oldest.bytes;
    }
    await store.delete(evict);
  }

  private async evictOldest(store: RawStore, fraction: number): Promise<void> {
    const entries = (await store.all()).sort((a, b) => a.lastAccess - b.lastAccess);
    await store.delete(entries.slice(0, Math.max(1, Math.ceil(entries.length * fraction))).map((e) => e.key));
  }

  async keys(): Promise<string[]> {
    try {
      return (await (await this.backend()).all()).map((e) => e.key);
    } catch {
      return [];
    }
  }

  async clear(): Promise<void> {
    try {
      await (await this.backend()).clear();
    } catch {
      // nothing to clear
    }
  }
}
