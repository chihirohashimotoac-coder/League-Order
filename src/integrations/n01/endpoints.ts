/**
 * The one place that knows how n01 operations map onto HTTP (docs/N01_MASTER_DESIGN.md §1).
 *
 * The operation names are the ones the n01 public read API is described with. How they
 * are spelled as URLs could not be checked against the live service from the
 * environment this was built in, so the mapping is isolated here: if `npm run
 * verify:n01` shows a different shape, this file (and `validation.ts` for the payloads)
 * is all that changes.
 *
 * Read operations only. There is no write operation and no credential anywhere.
 */

export const N01_API_BASE_URL = 'https://n01darts.com/n01/api';

/** Hosts the client will talk to. Anything else is refused before a request is made. */
export const N01_ALLOWED_HOSTS: readonly string[] = ['n01darts.com', 'www.n01darts.com'];

export const N01_OPERATIONS = [
  'league/search',
  'league/tournament/list',
  'league/schedule/get',
  'tournament/get',
  'tournament/stats',
  'team/player/list',
  'team/order/list',
] as const;

export type N01Operation = (typeof N01_OPERATIONS)[number];

export interface N01Request {
  operation: N01Operation;
  params: Record<string, string>;
}

/** True for an https URL on an allowed n01 host with no embedded credentials. */
export function isAllowedN01Url(value: string): boolean {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  return (
    url.protocol === 'https:' &&
    url.username === '' &&
    url.password === '' &&
    N01_ALLOWED_HOSTS.includes(url.hostname.toLowerCase())
  );
}

/** `GET {base}/{operation}?{params}` with the parameters in a fixed order. */
export function buildUrl(base: string, request: N01Request): string {
  const url = new URL(`${base.replace(/\/+$/u, '')}/${request.operation}`);
  for (const key of Object.keys(request.params).sort()) {
    url.searchParams.set(key, request.params[key]);
  }
  return url.toString();
}

/** The inverse of {@link buildUrl}, for the fixture server and tests. */
export function parseRequestUrl(base: string, value: string): N01Request | null {
  let url: URL;
  let root: URL;
  try {
    url = new URL(value);
    root = new URL(base);
  } catch {
    return null;
  }
  if (url.origin !== root.origin) return null;
  const prefix = root.pathname.replace(/\/+$/u, '');
  if (!url.pathname.startsWith(`${prefix}/`)) return null;
  const operation = url.pathname.slice(prefix.length + 1) as N01Operation;
  if (!N01_OPERATIONS.includes(operation)) return null;
  const params: Record<string, string> = {};
  url.searchParams.forEach((paramValue, key) => {
    params[key] = paramValue;
  });
  return { operation, params };
}
