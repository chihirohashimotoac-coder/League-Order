import { describe, expect, it } from 'vitest';
import type { Player } from '../types';
import { normalizeName, sameName } from './names';
import { effectivePpr, pprFromStats, pprSourceOf, withEffectivePpr } from './effectivePpr';
import { describeChanges, emptyChangeSummary, hasImportantChanges } from './changes';
import { STALE_DANGER_MS, STALE_WARN_MS, formatAge, freshness } from './freshness';
import { parsePlayerBinding, parseTeamBinding } from './parse';
import type { N01PlayerBinding } from './types';

function player(overrides: Partial<Player> = {}): Player {
  return {
    id: 'p',
    teamId: 't',
    name: 'A',
    rating: null,
    ppr: null,
    skills: {},
    seasonAppearances: 0,
    seasonAppearancesByKind: {},
    archived: false,
    createdAt: 0,
    ...overrides,
  };
}

const binding = (ppr: number | null): N01PlayerBinding => ({
  opid: 'op',
  currentOid: 'o',
  currentTpid: 'tp',
  sourceName: 'A',
  rosterActive: true,
  lastSeenTournamentId: 't1',
  lastSeenAt: 0,
  stats: ppr === null ? null : { ppr, score: 1, darts: 1, legs: 1, tournamentId: 't1', syncedAt: 0 },
});

describe('name normalisation (exact, documented, nothing fuzzier)', () => {
  it('folds width, spacing and Latin case only', () => {
    expect(normalizeName('  ＫＡＬＡＶＩＮＫＡ ')).toBe('kalavinka');
    expect(sameName('橋本　千尋', '橋本 千尋')).toBe(true);
    expect(sameName('橋本  千尋', '橋本 千尋')).toBe(true);
    expect(sameName('橋本千尋', '橋本 千尋')).toBe(false);
    expect(sameName('はしもと', 'ハシモト')).toBe(false);
  });
});

describe('effective PPR rule', () => {
  it('an unlinked player uses the manual value', () => {
    expect(effectivePpr(player({ ppr: 60 }))).toEqual({ value: 60, origin: 'manual' });
    expect(pprSourceOf(player())).toBe('manual');
  });

  it('a linked player uses n01, falls back to manual (labelled), else Unknown', () => {
    expect(effectivePpr(player({ ppr: 60, n01: binding(55.5) }))).toEqual({ value: 55.5, origin: 'n01' });
    expect(effectivePpr(player({ ppr: 60, n01: binding(null) }))).toEqual({ value: 60, origin: 'manual-fallback' });
    expect(effectivePpr(player({ n01: binding(null) }))).toEqual({ value: null, origin: 'none' });
  });

  it('the captain can force the manual value on a linked player', () => {
    expect(effectivePpr(player({ ppr: 60, n01: binding(55.5), pprSource: 'manual' }))).toEqual({ value: 60, origin: 'manual' });
  });

  it('copies the effective value into ppr for the optimizer, without touching the record', () => {
    const original = player({ ppr: 60, n01: binding(55.5) });
    const copy = withEffectivePpr(original);
    expect(copy.ppr).toBe(55.5);
    expect(original.ppr).toBe(60);
    const unlinked = player({ ppr: 60 });
    expect(withEffectivePpr(unlinked)).toBe(unlinked);
  });

  it('PPR = score / darts * 3; no darts is null, never 0', () => {
    expect(pprFromStats(501, 27)).toBeCloseTo(55.67, 2);
    expect(pprFromStats(0, 0)).toBeNull();
    expect(pprFromStats(100, -3)).toBeNull();
    expect(pprFromStats(Number.NaN, 3)).toBeNull();
  });
});

describe('freshness', () => {
  it('labels ages and escalates at 24h / 48h', () => {
    expect(freshness(0, 5 * 60_000)).toMatchObject({ level: 'recent', label: '5分前' });
    expect(freshness(0, 12 * 3_600_000)).toMatchObject({ level: 'recent', label: '12時間前' });
    expect(freshness(0, STALE_WARN_MS).level).toBe('warn');
    expect(freshness(0, STALE_DANGER_MS + 1).level).toBe('danger');
    expect(formatAge(3 * 86_400_000)).toBe('3日前');
  });
});

describe('change summary', () => {
  it('the first sync is not a "change"; PPR updates alone are not important', () => {
    expect(hasImportantChanges(emptyChangeSummary(true))).toBe(false);
    const ppr = { ...emptyChangeSummary(), pprChanged: [{ name: 'A', from: 50, to: 51 }] };
    expect(hasImportantChanges(ppr)).toBe(false);
    expect(describeChanges(ppr)).toEqual(['PPR 更新: A 50→51']);
  });

  it('season, division, roster and opponent changes are important', () => {
    const summary = { ...emptyChangeSummary(), season: { from: '2nd', to: '3rd' }, rosterAdded: ['B'] };
    expect(hasImportantChanges(summary)).toBe(true);
    expect(describeChanges(summary)).toEqual(['シーズン: 2nd → 3rd', 'メンバー追加: B']);
  });
});

describe('binding parsing (import)', () => {
  it('keeps a complete binding and drops a partial one', () => {
    const team = {
      provider: 'n01',
      leagueId: 'lg_l3hI_3397',
      leagueTitle: 'ATDO',
      stableIdentity: { kind: 'name', value: 'kalavinka' },
      lastTournamentId: 't_ABvC_5234',
      lastTournamentTitle: '2026 3rd',
      lastTeamId: 'GpiQ',
      lastTeamName: 'kalavinka',
      lastDivisionIndex: 0,
      lastDivisionTitle: 'A',
      discipline: 'STEEL',
      managedFormatId: 'fmt_1',
      linkedAt: 1,
      lastSuccessfulSyncAt: 2,
    };
    expect(parseTeamBinding(team)).toEqual(team);
    expect(parseTeamBinding({ ...team, stableIdentity: { kind: 'fuzzy', value: 'x' } })).toBeUndefined();
    expect(parseTeamBinding({ ...team, provider: 'other' })).toBeUndefined();
    expect(parsePlayerBinding(binding(50))).toEqual(binding(50));
    expect(parsePlayerBinding({ ...binding(50), opid: null, currentOid: null })).toBeUndefined();
    expect(parsePlayerBinding({ ...binding(50), stats: { ppr: 999, score: 1, darts: 1, tournamentId: 't' } })?.stats?.ppr).toBeNull();
  });
});
