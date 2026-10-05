import type { GenerateResult, OrderInput } from '../domain/types';
import { generateOrder, type GenerateOptions } from './generateOrder';
import type { WorkerRequest, WorkerResponse } from './order.worker';

/**
 * Runs the optimizer off the main thread when the browser allows it.
 *
 * Falls back to a direct synchronous call when `Worker` is unavailable (older
 * WebViews, the test environment), so behaviour is identical either way — the worker is
 * purely a responsiveness measure, never a behavioural difference.
 */
export interface OrderRunner {
  readonly mode: 'worker' | 'sync';
  generate(input: OrderInput, options?: GenerateOptions): Promise<GenerateResult>;
  dispose(): void;
}

class SyncRunner implements OrderRunner {
  readonly mode = 'sync' as const;

  async generate(input: OrderInput, options: GenerateOptions = {}): Promise<GenerateResult> {
    // Yield once so the caller's loading state is painted before the main thread blocks.
    await new Promise((resolve) => setTimeout(resolve, 0));
    return generateOrder(input, options);
  }

  dispose(): void {
    /* nothing to release */
  }
}

class WorkerRunner implements OrderRunner {
  readonly mode = 'worker' as const;
  private nextId = 1;
  private readonly pending = new Map<
    number,
    { resolve: (result: GenerateResult) => void; reject: (error: Error) => void }
  >();

  constructor(private readonly worker: Worker) {
    worker.onmessage = (event: MessageEvent<WorkerResponse>) => {
      const entry = this.pending.get(event.data.id);
      if (!entry) return;
      this.pending.delete(event.data.id);
      if (event.data.ok) entry.resolve(event.data.result);
      else entry.reject(new Error(event.data.error));
    };
    worker.onerror = (event) => {
      const error = new Error(event.message || 'optimizer worker failed');
      for (const entry of this.pending.values()) entry.reject(error);
      this.pending.clear();
    };
  }

  generate(input: OrderInput, options: GenerateOptions = {}): Promise<GenerateResult> {
    const id = this.nextId;
    this.nextId += 1;
    return new Promise<GenerateResult>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      const request: WorkerRequest = { id, input, options };
      this.worker.postMessage(request);
    });
  }

  dispose(): void {
    this.worker.terminate();
    this.pending.clear();
  }
}

export function createRunner(): OrderRunner {
  if (typeof Worker === 'undefined') return new SyncRunner();
  try {
    const worker = new Worker(new URL('./order.worker.ts', import.meta.url), { type: 'module' });
    return new WorkerRunner(worker);
  } catch {
    return new SyncRunner();
  }
}

/** Always-synchronous runner, for tests and for callers that need a direct result. */
export function createSyncRunner(): OrderRunner {
  return new SyncRunner();
}
