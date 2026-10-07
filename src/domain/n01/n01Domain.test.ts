import { describe, expect, it } from 'vitest';
import type { AppSettings, Player } from '../types';
import { normalizeName, sameName } from './names';
import { effectivePpr, pprFromStats, pprSourceOf, withEffectivePpr } from './effectivePpr';
import { describeChanges, emptyChangeSummary, hasImportantChanges } from './changes';
import { LATEST_WINDOW_MS, STALE_DANGER_MS, STALE_WARN_MS, formatAge, freshness, isLatest } from './freshness';
import { buildNextMatchOrder, eligiblePlayers, previousAvailability } from './nextMatch';
import { createParticipantConfig } from '../orders/participants';
import { DEFAULT_OPTIMIZER_SETTINGS, DEFAULT_WEIGHTS } from '../orders/presets';
import { TEAM_ID, format, games, player as factoryPlayer, team } from '../../test/factories';
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

describe('next match order (Phase 5)', () => {
  const settings: AppSettings = {
    activeTeamId: TEAM_ID,
    optimizer: DEFAULT_OPTIMIZER_SETTINGS,
    lastPreset: 'BALANCED',
    customWeights: DEFAULT_WEIGHTS,
  };
  const roster = [
    factoryPlayer({ id: 'a', name: 'A', ppr: 20 }),
    factoryPlayer({ id: 'b', name: 'B', ppr: 18 }),
    { ...factoryPlayer({ id: 'c', name: 'C' }), archived: true },
    { ...factoryPlayer({ id: 'd', name: 'D' }), n01: { ...binding(null), rosterActive: false } },
    factoryPlayer({ id: 'e', name: 'E' }),
  ];

  it('offers only players who can play: not archived and still on the n01 roster', () => {
    expect(eligiblePlayers(roster).map((p) => p.id)).toEqual(['a', 'b', 'e']);
  });

  it('starts availability from the working order, else the last saved order, else everyone', () => {
    const current = [createParticipantConfig('a', false)];
    const last = { input: { participants: [createParticipantConfig('b', false), createParticipantConfig('d', true)] } };
    expect([...previousAvailability(roster, current, null)]).toEqual([['a', false], ['b', true], ['e', true]]);
    expect([...previousAvailability(roster, [], last as never)]).toEqual([['a', true], ['b', false], ['e', true]]);
    expect([...previousAvailability(roster, null, null)].every(([, here]) => here)).toBe(true);
    // Another team's working order is not this team's attendance.
    const otherTeam = [createParticipantConfig('x', false)];
    expect([...previousAvailability(roster, otherTeam, last as never)]).toEqual([['a', true], ['b', false], ['e', true]]);
  });

  it('without opponent data builds a 勝利優先 order from who is here, keeping day-of exclusions', () => {
    const fmt = format(games([{ id: 'g1', name: 'S', kinds: ['G501'], playerCount: 1 }]));
    const previous = [{ ...createParticipantConfig('a'), excludedGameIds: ['g1'] }];
    const built = buildNextMatchOrder({
      team: { ...team('Kalavinka'), leagueName: 'ATDO' },
      players: eligiblePlayers(roster),
      format: fmt,
      pairs: [],
      settings,
      intel: null,
      attending: new Set(['a', 'e']),
      previous,
    });
    expect(built.opponentAvailable).toBe(false);
    expect(built.input.preset).toBe('WIN_FIRST');
    expect(built.input.opponent).toBeUndefined();
    expect(built.input.participants).toEqual([
      { ...previous[0], include: true },
      { ...createParticipantConfig('b'), include: false },
      { ...createParticipantConfig('e'), include: true },
    ]);
    expect(built.match).toEqual({ leagueName: 'ATDO', teamName: 'Kalavinka', opponentName: '', matchDate: '' });
  });
});

describe('"最新" is reserved for this session', () => {
  it('holds for LATEST_WINDOW_MS after a sync in this session only', () => {
    expect(isLatest(null, 1_000)).toBe(false);
    expect(isLatest(1_000, 1_000)).toBe(true);
    expect(isLatest(1_000, 1_000 + LATEST_WINDOW_MS - 1)).toBe(true);
    expect(isLatest(1_000, 1_000 + LATEST_WINDOW_MS)).toBe(false);
    expect(isLatest(5_000, 1_000)).toBe(false);
  });
});
