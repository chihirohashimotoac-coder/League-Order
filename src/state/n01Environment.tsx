import { createContext, useContext, type ReactNode } from 'react';
import { N01Client, createFetchTransport, type N01Transport } from '../integrations/n01/client';

/**
 * How the app reaches n01 (docs/N01_MASTER_DESIGN.md §4).
 *
 * Screens never call `fetch`: they ask this environment for a client, one per sync, and
 * for the time. The default talks to the public read API; tests and the E2E fixture
 * server provide a canned transport and a fixed clock instead.
 */
export interface N01Environment {
  createClient(options?: { signal?: AbortSignal }): N01Client;
  now(): number;
}

let defaultTransport: N01Transport | null = null;

export const defaultN01Environment: N01Environment = {
  createClient: (options) => {
    defaultTransport ??= createFetchTransport();
    return new N01Client(defaultTransport, { signal: options?.signal });
  },
  now: () => Date.now(),
};

const N01EnvironmentContext = createContext<N01Environment>(defaultN01Environment);

export function N01EnvironmentProvider({
  value,
  children,
}: {
  value: N01Environment;
  children: ReactNode;
}): React.JSX.Element {
  return <N01EnvironmentContext.Provider value={value}>{children}</N01EnvironmentContext.Provider>;
}

export function useN01Environment(): N01Environment {
  return useContext(N01EnvironmentContext);
}
