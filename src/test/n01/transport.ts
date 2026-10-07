import type { N01Transport } from '../../integrations/n01/client';
import { N01Error } from '../../integrations/n01/client';
import type { N01Request } from '../../integrations/n01/endpoints';
import { requestKey, type FixtureDataset } from './generator';
import { FIXTURE_LEAGUE_SEARCH, fixtureLeagues } from './leagues';

/**
 * In-memory n01 server over fixture datasets (test-only).
 *
 * `override` lets a test replace or break any single response (malformed JSON, schema
 * change, a missing schedule, an outage) without touching the generated data.
 */
export interface FixtureTransportOptions {
  datasets?: FixtureDataset[];
  override?: (request: N01Request) => unknown | undefined;
  /** Records every request, for request-count assertions. */
  log?: N01Request[];
}

export const FAIL = Symbol('fail');

export function fixtureResponse(request: N01Request, datasets: readonly FixtureDataset[]): unknown | undefined {
  if (request.operation === 'league/list') {
    const keyword = (request.params.keyword ?? '').toLowerCase();
    return { result: 0, list: FIXTURE_LEAGUE_SEARCH.filter((league) => league.title.toLowerCase().includes(keyword)) };
  }
  const key = requestKey(request.operation, request.params);
  for (const dataset of datasets) {
    if (dataset.has(key)) return dataset.get(key);
  }
  return undefined;
}

export function allFixtureDatasets(): FixtureDataset[] {
  const leagues = fixtureLeagues();
  return [leagues.atdo.dataset, leagues.tdo.dataset, leagues.tda.dataset];
}

export function createFixtureTransport(options: FixtureTransportOptions = {}): N01Transport {
  const datasets = options.datasets ?? allFixtureDatasets();
  return {
    async request(request) {
      options.log?.push(request);
      const overridden = options.override?.(request);
      if (overridden === FAIL) throw new N01Error('network', 'n01 に接続できませんでした。', request.operation);
      if (overridden instanceof N01Error) throw overridden;
      if (overridden !== undefined) return structuredClone(overridden);
      const response = fixtureResponse(request, datasets);
      if (response === undefined) throw new N01Error('notFound', 'n01 にデータが見つかりませんでした。', request.operation, 404);
      return structuredClone(response);
    },
  };
}
