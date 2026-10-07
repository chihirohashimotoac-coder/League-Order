/**
 * Stand-in for vite-plugin-pwa's virtual module in unit tests (it only exists inside a
 * Vite build). Tests that care replace it with `vi.mock('virtual:pwa-register', …)`.
 */
export function registerSW(): (reload?: boolean) => Promise<void> {
  return async () => undefined;
}
