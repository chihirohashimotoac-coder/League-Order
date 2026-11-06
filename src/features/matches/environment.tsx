import { createContext, useContext, type ReactNode } from 'react';
import { MatchesApi } from './api';

/**
 * How the match screens reach n01. The default is the public read API through the app's audited
 * transport; tests (and the review preview, which cannot reach n01 from its sandbox) supply
 * another factory. One API instance is made per screen visit / refresh.
 */
export type MatchesApiFactory = (options?: { maxRequests?: number }) => MatchesApi;

const defaultFactory: MatchesApiFactory = (options) => new MatchesApi(options);

const MatchesApiContext = createContext<MatchesApiFactory>(defaultFactory);

export function MatchesApiProvider({ value, children }: { value: MatchesApiFactory; children: ReactNode }): React.JSX.Element {
  return <MatchesApiContext.Provider value={value}>{children}</MatchesApiContext.Provider>;
}

export function useMatchesApiFactory(): MatchesApiFactory {
  return useContext(MatchesApiContext);
}
