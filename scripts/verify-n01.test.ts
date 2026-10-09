import { describe, expect, it } from 'vitest';
import { N01Client } from '../src/integrations/n01/client';
import type { N01Request } from '../src/integrations/n01/endpoints';
import { FIXTURE_NOW } from '../src/test/n01/leagues';
import { allFixtureDatasets, createFixtureTransport, fixtureResponse } from '../src/test/n01/transport';
import { verifyLeague } from './verify-n01';

/**
 * The live check must fail on a whole roster that is not every registered team's — a
 * well-formed 2-of-18 response would otherwise pass it (and `fetchIntelligence` would trust it).
 */

const ATDO = 'lg_l3hI_3397';
const isWholeRoster = (request: N01Request): boolean => request.operation === 'team/player/list' && request.params.tpid === undefined;

async function wholeRosterCheck(override?: (request: N01Request) => unknown) {
  const client = new N01Client(createFixtureTransport({ override }), { now: () => FIXTURE_NOW });
  const checks = await verifyLeague(client, ATDO, 'ATDO');
  return checks.find((check) => check.step === 'whole roster');
}

describe('verify:n01 — the whole-roster check', () => {
  it('passes when the response holds every registered team', async () => {
    const check = await wholeRosterCheck();
    expect(check?.ok).toBe(true);
  });

  it('fails on a well-formed response that holds only some of the registered teams', async () => {
    const check = await wholeRosterCheck((request) => {
      if (!isWholeRoster(request)) return undefined;
      const full = fixtureResponse(request, allFixtureDatasets()) as { list: { tpid: string }[] };
      const keep = new Set([...new Set(full.list.map((entry) => entry.tpid))].slice(0, 2));
      return { ...full, list: full.list.filter((entry) => keep.has(entry.tpid)) };
    });
    expect(check?.ok).toBe(false);
    expect(check?.detail).toMatch(/registered/);
  });

  it('passes, and says so, when the response also names teams that are not registered', async () => {
    const check = await wholeRosterCheck((request) => {
      if (!isWholeRoster(request)) return undefined;
      const full = fixtureResponse(request, allFixtureDatasets()) as { list: unknown[] };
      return { ...full, list: [...full.list, { opid: 'zz-1', oid: 'zzO', tpid: 'NOT_REGISTERED', oname: '登録外' }] };
    });
    expect(check?.ok).toBe(true);
    expect(check?.detail).toMatch(/1 .*not registered|1 extra|extra/i);
  });
});
