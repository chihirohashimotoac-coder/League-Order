/// <reference lib="webworker" />
import { generateOrder, type GenerateOptions } from './generateOrder';
import type { GenerateResult, OrderInput } from '../domain/types';

/**
 * Worker wrapper around the (pure) optimizer.
 *
 * Generation is CPU-bound for up to the configured time budget. Running it on the main
 * thread would freeze the UI — including the spinner — exactly when the captain is
 * waiting, so it runs here instead. `generateOrder` itself knows nothing about workers.
 */
export interface WorkerRequest {
  id: number;
  input: OrderInput;
  options: GenerateOptions;
}

export type WorkerResponse =
  | { id: number; ok: true; result: GenerateResult }
  | { id: number; ok: false; error: string };

self.onmessage = (event: MessageEvent<WorkerRequest>): void => {
  const { id, input, options } = event.data;
  try {
    const result = generateOrder(input, options);
    const response: WorkerResponse = { id, ok: true, result };
    self.postMessage(response);
  } catch (error) {
    const response: WorkerResponse = {
      id,
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    };
    self.postMessage(response);
  }
};
