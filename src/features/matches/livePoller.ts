import { N01Error } from '../../integrations/n01/client';
import type { LiveResponse, LiveState } from './parse';

/**
 * Polling of `match/live` for one card (`tmid`) or one game (`mid`) — manual §2: "2 回目以降は
 * 前回の updateTime を since に付けて 1〜2 秒ごとに".
 *
 * - One request at a time; the next one is scheduled only after the previous one settles.
 * - `since` = the `updateTime` of the last applied state: an unchanged game costs a tiny reply.
 * - A reply older than the state on screen is dropped (never shown as the latest).
 * - Another `mid` (the next game of the card, the next set) replaces the state wholesale.
 * - Hidden page → no request until it is visible again. Finished → stops by itself.
 * - Failures back off (×2 up to 30 s); n01's "too many requests" waits 60 s.
 * - A hard budget of requests per poller; reaching it pauses until `resume()`.
 */

export type LiveStatus =
  | { kind: 'idle' }
  | { kind: 'polling'; lastOkAt: number | null }
  | { kind: 'paused-hidden' }
  | { kind: 'retrying'; attempt: number; retryInMs: number; message: string }
  | { kind: 'finished' }
  | { kind: 'budget'; requests: number };

export interface LiveSample {
  /** Round trip of the request that brought the change (ms). */
  rttMs: number;
  /** Arrival time minus n01's `updateTime` of the change (ms): server write → this screen. */
  ageMs: number;
}

export interface LiveSource {
  live(target: { tmid: string } | { mid: string }, since: number | null, signal?: AbortSignal): Promise<LiveResponse>;
}

export interface LivePollerOptions {
  intervalMs?: number;
  maxRequests?: number;
  now?: () => number;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
  onState: (state: LiveState) => void;
  onStatus: (status: LiveStatus) => void;
  onSample?: (sample: LiveSample) => void;
}

export const LIVE_INTERVAL_MS = 1500;
export const LIVE_MAX_INTERVAL_MS = 30_000;
export const LIVE_RATE_LIMIT_WAIT_MS = 60_000;
/** About 50 minutes at 1.5 s; then the viewer is asked whether to go on. */
export const LIVE_MAX_REQUESTS = 2000;

export class LivePoller {
  private state: LiveState | null = null;
  private since: number | null = null;
  private timer: unknown = null;
  private running = false;
  private inFlight = false;
  private hidden = false;
  private failures = 0;
  private stopped = true;
  private controller: AbortController | null = null;
  requests = 0;
  private lastOkAt: number | null = null;
  private readonly interval: number;
  private readonly maxRequests: number;
  private readonly now: () => number;
  private readonly setTimer: (fn: () => void, ms: number) => unknown;
  private readonly clearTimer: (handle: unknown) => void;

  constructor(
    private readonly source: LiveSource,
    private readonly target: { tmid: string } | { mid: string },
    private readonly options: LivePollerOptions,
  ) {
    this.interval = options.intervalMs ?? LIVE_INTERVAL_MS;
    this.maxRequests = options.maxRequests ?? LIVE_MAX_REQUESTS;
    this.now = options.now ?? (() => Date.now());
    this.setTimer = options.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
    this.clearTimer = options.clearTimer ?? ((handle) => clearTimeout(handle as ReturnType<typeof setTimeout>));
  }

  get current(): LiveState | null {
    return this.state;
  }

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    this.running = true;
    this.schedule(0);
  }

  stop(): void {
    this.stopped = true;
    this.running = false;
    this.controller?.abort();
    if (this.timer !== null) this.clearTimer(this.timer);
    this.timer = null;
  }

  /** Continue after the request budget was reached. */
  resume(): void {
    this.requests = 0;
    if (!this.stopped) return;
    this.start();
  }

  setHidden(hidden: boolean): void {
    this.hidden = hidden;
    if (hidden) {
      if (this.timer !== null) this.clearTimer(this.timer);
      this.timer = null;
      if (this.running) this.options.onStatus({ kind: 'paused-hidden' });
    } else if (this.running && !this.inFlight && this.timer === null) {
      this.schedule(0);
    }
  }

  private schedule(ms: number): void {
    if (!this.running || this.hidden) {
      if (this.hidden && this.running) this.options.onStatus({ kind: 'paused-hidden' });
      return;
    }
    if (this.timer !== null) this.clearTimer(this.timer);
    this.timer = this.setTimer(() => {
      this.timer = null;
      void this.tick();
    }, ms);
  }

  private finish(): void {
    this.running = false;
    this.stopped = true;
    this.options.onStatus({ kind: 'finished' });
  }

  private async tick(): Promise<void> {
    if (!this.running || this.hidden || this.inFlight) return;
    if (this.requests >= this.maxRequests) {
      this.running = false;
      this.stopped = true;
      this.options.onStatus({ kind: 'budget', requests: this.requests });
      return;
    }
    this.inFlight = true;
    this.requests += 1;
    this.controller = new AbortController();
    const sentAt = this.now();
    try {
      const reply = await this.source.live(this.target, this.since, this.controller.signal);
      if (this.stopped) return;
      this.failures = 0;
      this.lastOkAt = this.now();
      if (reply.changed) this.apply(reply, this.now() - sentAt);
      // "Unchanged" about another game: the card moved on — read it whole next time.
      else if (reply.mid && this.state && reply.mid !== this.state.mid) this.since = null;
      this.options.onStatus({ kind: 'polling', lastOkAt: this.lastOkAt });
      const done = this.state && ('tmid' in this.target ? this.state.cardEnded || (!this.state.isSchedule && this.state.gameEnded) : this.state.gameEnded);
      if (done) this.finish();
      else this.schedule(this.interval);
    } catch (error) {
      if (this.stopped) return;
      this.failures += 1;
      const limited = error instanceof N01Error && error.kind === 'http' && error.status === 429;
      const wait = limited ? LIVE_RATE_LIMIT_WAIT_MS : Math.min(LIVE_MAX_INTERVAL_MS, this.interval * 2 ** this.failures);
      const message = limited
        ? 'n01 へのアクセスが多すぎるため、60 秒待ってから再開します。'
        : error instanceof Error
          ? error.message
          : '通信に失敗しました。';
      this.options.onStatus({ kind: 'retrying', attempt: this.failures, retryInMs: wait, message });
      this.schedule(wait);
    } finally {
      this.inFlight = false;
      this.controller = null;
    }
  }

  private apply(next: LiveState, rttMs: number): void {
    const previous = this.state;
    // A reply about the same game that is older than what is shown is stale: drop it.
    if (previous && previous.mid === next.mid && next.updateTime < previous.updateTime) return;
    this.state = next;
    this.since = next.updateTime;
    this.options.onState(next);
    this.options.onSample?.({ rttMs, ageMs: Math.max(0, this.now() - next.updateTime) });
  }
}

/** The median of the last samples, `null` with fewer than 3. */
export function medianMs(samples: readonly number[]): number | null {
  if (samples.length < 3) return null;
  const sorted = [...samples].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}
