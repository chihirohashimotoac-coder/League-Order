import { readFileSync } from 'node:fs';
import type { Page } from '@playwright/test';
import { N01_API_BASE_URL } from '../src/integrations/n01/endpoints';
import { tdaCopies, tdaMultiResponse, tdaResponse, TDA_TDID } from '../src/features/analytics/realData.tda.fixtures';
import type { TdaSnapshot } from '../src/features/analytics/realData.tda.fixtures';

/**
 * A fixture n01 (test-only) holding the real TDA 2026年度 中期 season of team ドリズ カム トゥルー
 * (`realData.tda.json`, read 2026-11-15) — never live n01. Every request is logged.
 *
 * Options (simulated, for the long cases):
 *  - `fillerGames`: other teams' finished games put **before** the real ones in the league list
 *    (older start times), so the real games sit on the last pages; with 1,588 the list holds
 *    1,665 rows as TDO 2026/3rd did on 2026-11-15 (17 requests of 100 with overlap);
 *  - `unfinishedOf`: an unfinished copy of one of the player's games (never to be counted);
 *  - `copies`: that many seasons made of the one real season (`tdaCopies`) instead of one;
 *  - `failList`: `match/list` requests (0-based) to fail as network errors.
 */
export const SNAP = JSON.parse(readFileSync(new URL('../src/features/analytics/realData.tda.json', import.meta.url), 'utf-8')) as TdaSnapshot;

export interface TdaWorldOptions {
  fillerGames?: number;
  unfinishedOf?: string;
  copies?: number;
  failList?: number[];
}

export interface TdaWorldControl {
  log: string[];
  unanswered: string[];
  /** `match/list` requests failed so far / to fail (0-based index of the request). */
  failList: Set<number>;
  listCalls: number;
  /** Marks one of the real games unfinished (`null`: as n01 has it) — the list n01 serves from then on. */
  setUnfinished: (mid: string | null) => void;
  /** Holds the answer to the n-th `match/get` (0-based) until `release()` is called. */
  holdDetail: (n: number) => { reached: Promise<void>; release: () => void };
}

function filler(n: number): Record<string, unknown>[] {
  const side = (tpid: string, oid: string, legs: number, score: number) => ({ name: tpid, tpid, order: [{ oid, opid: '', oname: oid }], me: 0, winSets: legs > 1 ? 1 : 0, winLegs: legs, allScore: score, allDarts: 45, allMarks: 0 });
  return Array.from({ length: n }, (_, i) => ({
    mid: `filler_${i}`,
    tdid: TDA_TDID,
    tmid: `${TDA_TDID}_lg_1_f${i}_fA${i % 7}_fB${i % 5}`,
    schid: 'ykby',
    match_type: '01',
    startTime: 1_780_000_000 + i,
    endMatch: 1,
    statsData: [side(`fA${i % 7}`, `a${i % 7}`, 2, 1002), side(`fB${i % 5}`, `b${i % 5}`, 1, 900)],
  }));
}

export async function serveTdaWorld(page: Page, options: TdaWorldOptions = {}): Promise<TdaWorldControl> {
  let unfinished: string | null = null;
  const holds = new Map<number, { reached: () => void; gate: Promise<void> }>();
  let detailCalls = 0;
  const control: TdaWorldControl = {
    log: [],
    unanswered: [],
    failList: new Set(options.failList ?? []),
    listCalls: 0,
    setUnfinished: (mid) => {
      unfinished = mid;
    },
    holdDetail: (n) => {
      let reached!: () => void;
      let release!: () => void;
      const hit = new Promise<void>((resolve) => (reached = resolve));
      const gate = new Promise<void>((resolve) => (release = resolve));
      holds.set(n, { reached, gate });
      return { reached: hit, release };
    },
  };
  const copies = options.copies ? tdaCopies(SNAP, options.copies) : null;
  const games = [...filler(options.fillerGames ?? 0), ...SNAP.games];
  if (options.unfinishedOf) {
    const base = SNAP.games.find((g) => g.mid === options.unfinishedOf)!;
    games.push({ ...base, mid: `${String(base.mid)}_unfinished`, endMatch: 0, startTime: Number(base.startTime) + 999_999 });
  }
  const snapOf = (): TdaSnapshot => ({ ...SNAP, games: unfinished ? games.map((g) => (g.mid === unfinished ? { ...g, endMatch: 0 } : g)) : games });
  await page.route(`${N01_API_BASE_URL}/**`, async (route) => {
    const url = new URL(route.request().url());
    const operation = url.pathname.replace(/^.*\/api\/v1\//u, '');
    const entry = `${operation}?${url.searchParams.toString()}`;
    control.log.push(entry);
    const headers = { 'Access-Control-Allow-Origin': '*' };
    if (operation === 'match/list' && url.searchParams.get('tmid__regex') === '_lg_') {
      const index = control.listCalls;
      control.listCalls += 1;
      if (control.failList.has(index)) {
        await route.abort('internetdisconnected');
        return;
      }
    }
    if (operation === 'match/get') {
      const hold = holds.get(detailCalls);
      detailCalls += 1;
      if (hold) {
        hold.reached();
        await hold.gate;
      }
    }
    const body = copies ? tdaMultiResponse(copies, operation, url.searchParams) : tdaResponse(snapOf(), operation, url.searchParams);
    if (body === undefined) {
      control.unanswered.push(entry);
      await route.fulfill({ status: 404, body: '{}', headers });
      return;
    }
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body), headers });
  });
  return control;
}

/** The player's games (mids) of the real season. */
export function gamesOf(oid: string): string[] {
  return SNAP.games.filter((g) => (g.statsData as { order: { oid: string }[] }[]).some((s) => s.order.some((p) => p.oid === oid))).map((g) => String(g.mid));
}
