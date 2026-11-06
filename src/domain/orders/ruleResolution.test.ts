import { describe, expect, it } from 'vitest';
import type { GameKind, GameSlotDef, LeagueFormat, StructuralKind } from '../types';
import {
  NO_CAP,
  YES_CAP,
  parseRuleAnswers,
  questionKinds,
  resolveOrderRules,
  ruleScopeOf,
  withAnswers,
  withoutAnswer,
} from './ruleResolution';
import { LEAGUE_RULE_CATALOG, catalogEntryForLeague } from './ruleCatalog';
import { leagueRuleViolations, parseLeagueRules } from './leagueRules';
import { generateOrder, evaluateManualOrder } from '../../optimizer/generateOrder';
import { validateHardConstraints } from '../../optimizer/constraints/validate';
import { orderInput, player } from '../../test/factories';
import { createBackup, parseBackup, serialiseBackup } from '../../storage/backup';
import { DEFAULT_SETTINGS } from '../../storage/seed';

const ATDO = 'lg_l3hI_3397';
const TDO = 'lg_3qgW_6619';

/** A format with the given number of games per kind (01 games, n01 kinds as the resolver sets them). */
function shape(counts: Partial<Record<StructuralKind, number>>, playerCount: Partial<Record<StructuralKind, number>> = {}): GameSlotDef[] {
  const heads: Record<StructuralKind, number> = { SINGLES: 1, DOUBLES: 2, TRIOS: 3, GALLON: 4, TEAM: 4, ...playerCount };
  const games: GameSlotDef[] = [];
  for (const kind of ['TEAM', 'GALLON', 'TRIOS', 'DOUBLES', 'SINGLES'] as StructuralKind[]) {
    for (let i = 0; i < (counts[kind] ?? 0); i += 1) {
      games.push({ id: `${kind}${i + 1}`, order: games.length + 1, name: `${kind} ${i + 1}`, kinds: [kind, 'G501'] as GameKind[], playerCount: heads[kind] });
    }
  }
  return games;
}

function manual(games: GameSlotDef[], id = 'fmt_manual'): LeagueFormat {
  return { id, teamId: 't', name: 'manual', discipline: 'SOFT', games, createdAt: 0 };
}

function managed(leagueId: string, games: GameSlotDef[]): LeagueFormat {
  return {
    ...manual(games, `n01fmt_${leagueId}`),
    source: { provider: 'n01', leagueId, leagueTitle: 'L', tournamentId: 't_x', tournamentTitle: 'S', divisionIndex: 0, divisionTitle: 'A', syncedAt: 0 },
  };
}

describe('questions are shown only for kinds played two or more times', () => {
  it.each([
    [{ GALLON: 0, TRIOS: 0, DOUBLES: 2, SINGLES: 4 }, ['DOUBLES', 'SINGLES']],
    [{ GALLON: 1, TRIOS: 0, DOUBLES: 1, SINGLES: 4 }, ['SINGLES']],
    [{ GALLON: 2, TRIOS: 1, DOUBLES: 2, SINGLES: 1 }, ['GALLON', 'DOUBLES']],
    [{ GALLON: 0, TRIOS: 0, DOUBLES: 1, SINGLES: 1 }, []],
    [{ GALLON: 0, TRIOS: 2, DOUBLES: 0, SINGLES: 0 }, ['TRIOS']],
  ] as const)('%o → %o', (counts, expected) => {
    const games = shape(counts);
    expect(questionKinds(games)).toEqual(expected);
    // An unknown league asks exactly those, in Gallon → Trios → Doubles → Singles order.
    expect(resolveOrderRules(manual(games), undefined).pending).toEqual(expected);
    expect(resolveOrderRules(managed('lg_unknown_1', games), undefined).pending).toEqual(expected);
  });

  it('never asks about a Team game, and a format the kinds cannot place is never guessed', () => {
    const resolution = resolveOrderRules(manual(shape({ TEAM: 2 })), undefined);
    expect(resolution.pending).toEqual([]);
    expect(resolution.kinds).toEqual([{ kind: 'TEAM', games: 2, state: 'free' }]);
    // A 4-player game is Gallon only when the format says so (n01: the game's name).
    const fourPlayer = shape({ GALLON: 2 });
    expect(questionKinds(fourPlayer)).toEqual(['GALLON']);
    expect(questionKinds(shape({ TEAM: 2 }))).toEqual([]);
  });

  it('an unanswered kind is neither allowed nor forbidden: it has no cap and blocks generation', () => {
    const resolution = resolveOrderRules(manual(shape({ DOUBLES: 2, SINGLES: 4 })), undefined);
    expect(resolution.rules).toBeUndefined();
    expect(resolution.pending).toEqual(['DOUBLES', 'SINGLES']);
  });

  it('a partly known format asks only the unknown part', () => {
    const format = { ...manual(shape({ DOUBLES: 2, SINGLES: 4 })), leagueRules: { maxPerStructure: { SINGLES: 1 } } };
    const resolution = resolveOrderRules(format, undefined);
    expect(resolution.pending).toEqual(['DOUBLES']);
    expect(resolution.kinds.find((row) => row.kind === 'SINGLES')).toMatchObject({ state: 'decided', cap: 1, origin: 'format' });
  });
});

describe('answers', () => {
  const format = manual(shape({ DOUBLES: 2, SINGLES: 4 }));
  const scope = ruleScopeOf(format);

  it('いいえ = 1, はい = 2 (never more), and they become hard rules labelled as answers', () => {
    const answers = withAnswers(undefined, scope, { DOUBLES: NO_CAP, SINGLES: YES_CAP }, 5);
    const resolution = resolveOrderRules(format, answers);
    expect(resolution.pending).toEqual([]);
    expect(resolution.rules).toEqual({
      maxPerStructure: { DOUBLES: 1, SINGLES: 2 },
      origins: { 'structure:DOUBLES': 'answer', 'structure:SINGLES': 'answer' },
    });
  });

  it('are reused in the same scope only, and re-checked when the format changes', () => {
    const answers = withAnswers(undefined, scope, { SINGLES: 1 }, 1);
    expect(resolveOrderRules(format, answers).pending).toEqual(['DOUBLES']);
    expect(resolveOrderRules(manual(shape({ DOUBLES: 2, SINGLES: 4 }), 'other'), answers).pending).toEqual(['DOUBLES', 'SINGLES']);
    // The format now plays Trios twice: that is asked, the Singles answer still holds.
    expect(resolveOrderRules({ ...format, games: shape({ TRIOS: 2, SINGLES: 2 }) }, answers).pending).toEqual(['TRIOS']);
    // One game of a kind needs no answer, and a stored answer does not turn into a rule for it.
    expect(resolveOrderRules({ ...format, games: shape({ SINGLES: 1, DOUBLES: 1 }) }, answers).rules).toBeUndefined();
  });

  it('an n01 league shares its answers across its formats; withdrawing one asks again', () => {
    const one = managed('lg_unknown_1', shape({ DOUBLES: 2 }));
    const answers = withAnswers(undefined, ruleScopeOf(one), { DOUBLES: 2 }, 1);
    expect(ruleScopeOf(one)).toBe('n01:lg_unknown_1');
    expect(resolveOrderRules({ ...one, id: 'another_division' }, answers).pending).toEqual([]);
    expect(resolveOrderRules(one, withoutAnswer(answers, ruleScopeOf(one), 'DOUBLES', 2)).pending).toEqual(['DOUBLES']);
  });

  it('a damaged stored answer is dropped (asked again), never read as 0 or as allowed', () => {
    expect(parseRuleAnswers({ 'format:x': { caps: { SINGLES: 0, DOUBLES: 'x', TRIOS: 2.5, GALLON: 2 }, updatedAt: 3 } })).toEqual({
      'format:x': { caps: { GALLON: 2 }, updatedAt: 3 },
    });
    expect(parseRuleAnswers(null)).toEqual({});
  });
});

describe('ATDO and TDO', () => {
  // The ATDO league night: Team 1001 ×1, Doubles ×2, Singles ×4.
  const night = shape({ TEAM: 1, DOUBLES: 2, SINGLES: 4 });

  it.each([ATDO, TDO])('%s: Singles and Doubles are capped at once per player without asking', (leagueId) => {
    const resolution = resolveOrderRules(managed(leagueId, night), undefined);
    expect(resolution.pending).toEqual([]);
    expect(resolution.catalog?.leagueIds).toContain(leagueId);
    expect(resolution.rules?.maxPerStructure).toEqual({ SINGLES: 1, DOUBLES: 1 });
    expect(resolution.rules?.origins).toEqual({ 'structure:SINGLES': 'requirement', 'structure:DOUBLES': 'requirement' });
    // A stored answer cannot loosen a league rule.
    const loose = withAnswers(undefined, ruleScopeOf(managed(leagueId, night)), { SINGLES: 2, DOUBLES: 2 }, 1);
    expect(resolveOrderRules(managed(leagueId, night), loose).rules?.maxPerStructure).toEqual({ SINGLES: 1, DOUBLES: 1 });
  });

  it('is recorded as the user’s requirement, never as confirmed official regulations', () => {
    for (const entry of LEAGUE_RULE_CATALOG) {
      expect(entry.basis).toBe('requirement');
      expect(entry.officialCheck.status).toBe('unconfirmed');
      expect(entry.scope.ttype).toBe('lg');
    }
    expect(catalogEntryForLeague('lg_Ev9v_7379')).toBeNull(); // TDA: no rule known → asked
    // A manual copy of an ATDO format is not the league's: it is asked about.
    expect(resolveOrderRules(manual(night), undefined).pending).toEqual(['DOUBLES', 'SINGLES']);
  });

  const players = Array.from({ length: 6 }, (_, i) => player({ id: `p${i + 1}`, name: `P${i + 1}`, rating: 16 - i * 2, ppr: 60 - i * 4 }));
  const rules = resolveOrderRules(managed(TDO, night), undefined).rules!;

  it('generation never fields a player twice in Singles or twice in Doubles (Singles + Doubles once each is fine)', () => {
    const input = { ...orderInput(players, night, { preset: 'WIN_FIRST' }), leagueRules: rules };
    const result = generateOrder(input, { timeLimitMs: 1500 });
    if (!result.ok) throw new Error('generation failed');
    for (const candidate of result.candidates) {
      expect(leagueRuleViolations(rules, night, candidate.assignments, input.participants, String)).toEqual([]);
      const singles = candidate.assignments.filter((a) => a.gameId.startsWith('SINGLES')).flatMap((a) => a.playerIds);
      const doubles = candidate.assignments.filter((a) => a.gameId.startsWith('DOUBLES')).flatMap((a) => a.playerIds);
      expect(new Set(singles).size).toBe(singles.length);
      expect(new Set(doubles).size).toBe(doubles.length);
    }
  });

  it('with too few players nothing is generated and the reason is given; the cap is never relaxed', () => {
    const input = { ...orderInput(players.slice(0, 3), night), leagueRules: rules };
    const result = generateOrder(input, { timeLimitMs: 800 });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.diagnostics.map((d) => d.message).join(' ')).toMatch(/[ぁ-んァ-ン一-龥]/u);
  });

  it('a hand edit that plays someone twice in Doubles cannot be finalized, with the league named', () => {
    const input = { ...orderInput(players, night), leagueRules: rules };
    const assignments = [
      { gameId: 'TEAM1', playerIds: ['p1', 'p2', 'p3', 'p4'] },
      { gameId: 'DOUBLES1', playerIds: ['p1', 'p2'] },
      { gameId: 'DOUBLES2', playerIds: ['p1', 'p3'] },
      { gameId: 'SINGLES1', playerIds: ['p1'] },
      { gameId: 'SINGLES2', playerIds: ['p2'] },
      { gameId: 'SINGLES3', playerIds: ['p3'] },
      { gameId: 'SINGLES4', playerIds: ['p4'] },
    ];
    const violations = validateHardConstraints(input, assignments);
    expect(violations.map((v) => v.message)).toContain('P1 は既にダブルスに出場しています。TDOでは同じ対戦でダブルスに 2 回出場できません (2 回配置)。');
    expect(evaluateManualOrder(input, assignments).violations.length).toBeGreaterThan(0);
  });
});

describe('the rules travel with the order', () => {
  it('origins and the catalog id survive JSON export / import; an unknown origin is dropped', () => {
    const rules = resolveOrderRules(managed(ATDO, shape({ DOUBLES: 2, SINGLES: 4 })), undefined).rules!;
    expect(parseLeagueRules(JSON.parse(JSON.stringify(rules)))).toEqual(rules);
    expect(parseLeagueRules({ maxPerStructure: { SINGLES: 1 }, origins: { 'structure:SINGLES': 'rumour' } })).toEqual({ maxPerStructure: { SINGLES: 1 } });
  });

  it('answers are part of the JSON backup', () => {
    const snapshot = {
      teams: [{ id: 't', name: 'T', createdAt: 0 }],
      players: [],
      formats: [],
      pairs: [],
      orders: [],
      seasonCommits: [],
      settings: { ...DEFAULT_SETTINGS, activeTeamId: 't', ruleAnswers: { 'n01:lg_x_1': { caps: { DOUBLES: 1 }, updatedAt: 9 } } },
    };
    expect(createBackup(snapshot).data.settings.ruleAnswers).toBeDefined();
    const parsed = parseBackup(serialiseBackup(snapshot));
    if (!parsed.ok) throw new Error(parsed.errors.join(' / '));
    expect(parsed.snapshot.settings.ruleAnswers).toEqual({ 'n01:lg_x_1': { caps: { DOUBLES: 1 }, updatedAt: 9 } });
  });
});
