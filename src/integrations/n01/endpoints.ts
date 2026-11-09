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

/**
 * The origin the app reads n01 from.
 *
 * The manual (n01 外部連携API マニュアル, served at https://push.n01darts.com/api/v1/n01_api_manual_ja.html
 * and documented with the base URL https://api.n01darts.com/api/v1) names `api.n01darts.com`.
 * Checked on 2026-11-06: `push.n01darts.com` serves the same API (the manual itself, `league/list`,
 * `match/live` …) with `Access-Control-Allow-Origin: *`, and every contract check
 * (`npm run verify:n01`, `verify:analytics-n01`, `verify:analytics-roles`) passes against it.
 * `api.n01darts.com` could not be reached from the environment that made the check (its network
 * policy refused the host), so its CORS and behaviour are unverified there — the origin is kept
 * as it is rather than switched blind. Switching is this one constant plus the allow-list below,
 * after the same checks pass against the new host.
 */
export const N01_API_BASE_URL = 'https://push.n01darts.com/api/v1';

/**
 * Hosts the client will talk to. Anything else is refused before a request is made.
 * `n01darts.com` / `www.n01darts.com` are the league pages a captain may paste a link to.
 */
export const N01_ALLOWED_HOSTS: readonly string[] = ['push.n01darts.com', 'n01darts.com', 'www.n01darts.com'];

export const N01_OPERATIONS = [
  'league/list',
  'league/tournament/list',
  'league/schedule/get',
  'tournament/get',
  'tournament/stats',
  'team/player/list',
  'team/order/list',
  'match/list',
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
