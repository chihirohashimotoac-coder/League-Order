import { N01Error } from '../../../integrations/n01/client';
import { RequestBudgetError } from '../api/readApi';

/**
 * Bounded retries of one analytics request (`match/list` page, `match/get`, high-in records).
 *
 * Only failures that can pass on their own are retried — a dropped connection, a timeout, n01
 * busy (HTTP 429) or failing (5xx) — at most {@link RETRY_DELAYS_MS}.length more times, and never
 * while the browser says it is offline, after a cancel, or for an exhausted request budget. Every
 * retry is a request of its own and counts against the budget of the adapter that sends it.
 */

/** Waits before each retry (ms). n01 asks clients that send too much to wait (HTTP 429): longer there. */
export const RETRY_DELAYS_MS = [1_000, 3_000] as const;
export const RATE_LIMIT_DELAYS_MS = [5_000, 15_000] as const;

export type Sleep = (ms: number, signal?: AbortSignal) => Promise<void>;

export const defaultSleep: Sleep = (ms, signal) =>
  new Promise<void>((resolve) => {
    if (signal?.aborted) {
      resolve();
      return;
    }
    const timer = setTimeout(done, ms);
    function done(): void {
      clearTimeout(timer);
      signal?.removeEventListener('abort', done);
      resolve();
    }
    signal?.addEventListener('abort', done);
  });

/** How long to wait before retry number `attempt` (0-based), or `null`: do not retry. */
export function retryDelay(error: unknown, attempt: number): number | null {
  if (error instanceof RequestBudgetError || !(error instanceof N01Error)) return null;
  const delays: readonly number[] =
    error.kind === 'http' && error.status === 429
      ? RATE_LIMIT_DELAYS_MS
      : error.kind === 'network' || error.kind === 'timeout' || (error.kind === 'http' && (error.status ?? 0) >= 500)
        ? RETRY_DELAYS_MS
        : [];
  return attempt < delays.length ? delays[attempt] : null;
}

export interface RetryContext {
  isOnline: () => boolean;
  signal?: AbortSignal;
  sleep?: Sleep;
}

export async function withRetry<T>(ctx: RetryContext, send: () => Promise<T>): Promise<T> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await send();
    } catch (error) {
      const delay = retryDelay(error, attempt);
      if (delay === null || ctx.signal?.aborted || !ctx.isOnline()) throw error;
      await (ctx.sleep ?? defaultSleep)(delay, ctx.signal);
      if (ctx.signal?.aborted) throw error;
    }
  }
}

/** A failure that a later attempt may get past (worth an automatic or a one-tap retry). */
export function isTransient(error: unknown): boolean {
  return error instanceof N01Error && (error.kind === 'network' || error.kind === 'timeout' || (error.kind === 'http' && (error.status === 429 || (error.status ?? 0) >= 500)));
}
