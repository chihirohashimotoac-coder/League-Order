import { describe, expect, it } from 'vitest';
import type { GameAssignment, LeagueRules, OrderInput, OrderSolution, ParticipantConfig } from '../domain/types';
import { validateHardConstraints } from './constraints/validate';
import { evaluateManualOrder, generateOrder, reoptimise } from './generateOrder';
import { games, orderInput, player } from '../test/factories';
import { createParticipantConfig } from '../domain/orders/participants';
import {
  hasLeagueRules,
  leagueRuleViolations,
  leagueRulesFromText,
  leagueRulesToText,
  parseCapText,
  parseLeagueRules,
  tallyLeagueRules,
} from '../domain/orders/leagueRules';
import { createUndoable, undoableReducer } from '../state/orderSession';

/**
 * League rules (リーグ規則): optional hard conditions on a manual format. Each acceptance case
 * of the request has its own block: per-category caps (人数区分 / 競技区分), the Doubles
 * same-pair cap, the helper cap and league status, and every operation that must honour them.
 */

const roster = (count: number) =>
  Array.from({ length: count }, (_, i) =>
    player({ id: `p${i + 1}`, name: `P${i + 1}`, rating: 10 + (count - i), ppr: 40 + (count - i) * 2 }),
  );

const nameOf = (id: string): string => id.toUpperCase();

function withRules(input: OrderInput, leagueRules: LeagueRules): OrderInput {
  return { ...input, leagueRules };
}

function codes(input: OrderInput, assignments: GameAssignment[]): string[] {
  return validateHardConstraints(input, assignments).map((violation) => violation.code);
}

function expectOk(result: ReturnType<typeof generateOrder>): OrderSolution[] {
  if (!result.ok) throw new Error(result.diagnostics.map((d) => d.message).join(' / '));
  return result.candidates;
}

const FAST = { timeLimitMs: 900 };

// Six Singles 01, four Doubles 01 and a Trios — enough to push every cap past its limit.
const singlesDoubles = games([
  { id: 's1', name: 'S1', kinds: ['SINGLES', 'G501'], playerCount: 1 },
  { id: 's2', name: 'S2', kinds: ['SINGLES', 'G501'], playerCount: 1 },
  { id: 's3', name: 'S3', kinds: ['SINGLES', 'CRICKET'], playerCount: 1 },
  { id: 'd1', name: 'D1', kinds: ['DOUBLES', 'G501'], playerCount: 2 },
  { id: 'd2', name: 'D2', kinds: ['DOUBLES', 'CRICKET'], playerCount: 2 },
  { id: 'd3', name: 'D3', kinds: ['DOUBLES', 'G501'], playerCount: 2 },
  { id: 'd4', name: 'D4', kinds: ['DOUBLES', 'CRICKET'], playerCount: 2 },
  { id: 'd5', name: 'D5', kinds: ['DOUBLES', 'G501'], playerCount: 2 },
  { id: 't1', name: 'T1', kinds: ['TRIOS', 'G501'], playerCount: 3 },
]);

describe('1. caps per player-count category (人数区分)', () => {
  const players = roster(6);
  const base = orderInput(players, singlesDoubles);
  const fill = (s: [string, string, string], d: string[][], t: string[]): GameAssignment[] => [
    { gameId: 's1', playerIds: [s[0]] },
    { gameId: 's2', playerIds: [s[1]] },
    { gameId: 's3', playerIds: [s[2]] },
    ...d.map((pair, i) => ({ gameId: `d${i + 1}`, playerIds: pair })),
    { gameId: 't1', playerIds: t },
  ];
  const doubles = [
    ['p3', 'p4'],
    ['p5', 'p6'],
    ['p3', 'p5'],
    ['p4', 'p6'],
    ['p2', 'p6'],
  ];

  it('Singles cap 2: two Singles pass, a third is a violation', () => {
    const input = withRules(base, { maxPerStructure: { SINGLES: 2 } });
    expect(codes(input, fill(['p1', 'p1', 'p2'], doubles, ['p2', 'p3', 'p4']))).toEqual([]);
    const over = validateHardConstraints(input, fill(['p1', 'p1', 'p1'], doubles, ['p2', 'p3', 'p4']));
    expect(over.map((violation) => violation.code)).toEqual(['LEAGUE_STRUCTURE_LIMIT']);
    expect(over[0].playerId).toBe('p1');
    expect(over[0].message).toContain('Singles の出場上限 2 回');
  });

  it('Doubles cap 4: four Doubles pass, a fifth is a violation', () => {
    const input = withRules(base, { maxPerStructure: { DOUBLES: 4 } });
    const four = [['p1', 'p2'], ['p1', 'p3'], ['p1', 'p4'], ['p1', 'p5'], ['p2', 'p6']];
    expect(codes(input, fill(['p2', 'p3', 'p4'], four, ['p4', 'p5', 'p6']))).toEqual([]);
    const five = [['p1', 'p2'], ['p1', 'p3'], ['p1', 'p4'], ['p1', 'p5'], ['p1', 'p6']];
    expect(codes(input, fill(['p2', 'p3', 'p4'], five, ['p4', 'p5', 'p6']))).toEqual(['LEAGUE_STRUCTURE_LIMIT']);
  });

  it('Trios has no cap of its own when only Singles is capped, but the total maximum still applies', () => {
    const trios = games(
      Array.from({ length: 4 }, (_, i) => ({ id: `t${i}`, name: `T${i}`, kinds: ['TRIOS' as const], playerCount: 3 })),
    );
    const input = withRules(orderInput(roster(4), trios), { maxPerStructure: { SINGLES: 1 } });
    const everyTrios = trios.map((game) => ({ gameId: game.id, playerIds: ['p1', 'p2', 'p3'] }));
    expect(codes(input, everyTrios)).toEqual([]);
    const capped: OrderInput = {
      ...input,
      participants: input.participants.map((c) => (c.playerId === 'p1' ? { ...c, maxAppearances: 3 } : c)),
    };
    expect(codes(capped, everyTrios)).toEqual(['MAX_APPEARANCES_EXCEEDED']);
  });

  it('generation never exceeds a structural cap', () => {
    const input = withRules(base, { maxPerStructure: { SINGLES: 1, DOUBLES: 2 } });
    for (const solution of expectOk(generateOrder(input, FAST))) {
      expect(validateHardConstraints(input, solution.assignments)).toEqual([]);
      const tally = tallyLeagueRules(input.leagueRules, input.games, solution.assignments, input.participants);
      for (const { limit, counts } of tally.limits) {
        for (const count of counts.values()) expect(count).toBeLessThanOrEqual(limit.cap);
      }
    }
  });
});

describe('2. caps per competition kind (競技区分), independent of the player-count category', () => {
  const medley = games([
    { id: 'm1', name: 'Singles Medley', kinds: ['SINGLES', 'G501', 'CRICKET'], playerCount: 1 },
    { id: 'm2', name: 'Doubles 01', kinds: ['DOUBLES', 'G501'], playerCount: 2 },
    { id: 'm3', name: 'Doubles Cricket', kinds: ['DOUBLES', 'CRICKET'], playerCount: 2 },
    { id: 'm4', name: 'Singles 01', kinds: ['SINGLES', 'G501'], playerCount: 1 },
  ]);
  const input = orderInput(roster(4), medley);

  it('a medley game counts once for 01 and once for Cricket, and once in total', () => {
    const assignments = [
      { gameId: 'm1', playerIds: ['p1'] },
      { gameId: 'm2', playerIds: ['p2', 'p3'] },
      { gameId: 'm3', playerIds: ['p2', 'p4'] },
      { gameId: 'm4', playerIds: ['p4'] },
    ];
    const tally = tallyLeagueRules(
      { maxPerPlayKind: { G501: 9, CRICKET: 9 }, maxPerStructure: { SINGLES: 9 } },
      medley,
      assignments,
      input.participants,
    );
    const byKey = new Map(tally.limits.map((entry) => [entry.limit.key, entry.counts]));
    expect(byKey.get('structure:SINGLES')!.get('p1')).toBe(1);
    expect(byKey.get('play:G501')!.get('p1')).toBe(1);
    expect(byKey.get('play:CRICKET')!.get('p1')).toBe(1);
    // A Doubles 01 placement is one Doubles and one 01.
    expect(byKey.get('play:G501')!.get('p3')).toBe(1);
    expect(byKey.get('play:CRICKET')!.get('p3')).toBeUndefined();
    const solution = evaluateManualOrder(input, assignments).solution!;
    expect(solution.tallies.find((t) => t.playerId === 'p1')!.count).toBe(1);
  });

  it('01 and Cricket caps are checked separately from Singles / Doubles caps', () => {
    const rules: LeagueRules = { maxPerPlayKind: { G501: 1, CRICKET: 2 }, maxPerStructure: { SINGLES: 2 } };
    const assignments = [
      { gameId: 'm1', playerIds: ['p1'] },
      { gameId: 'm2', playerIds: ['p1', 'p3'] },
      { gameId: 'm3', playerIds: ['p2', 'p4'] },
      { gameId: 'm4', playerIds: ['p4'] },
    ];
    const violations = leagueRuleViolations(rules, medley, assignments, input.participants, nameOf);
    // p1: 01 twice (medley + Doubles 01) breaks the 01 cap; Singles once is fine. p4: 01 once, Cricket once.
    expect(violations.map((v) => [v.code, v.playerId])).toEqual([['LEAGUE_PLAY_KIND_LIMIT', 'p1']]);
    expect(violations[0].message).toContain('01 の出場上限 1 回');
  });

  it('throwing order and the number of legs never add appearances', () => {
    const legs = medley.map((game) => ({
      ...game,
      n01: { schid: game.id, numPart: game.playerCount, matchType: '01', startScore: 501, limitLegCount: 3, group: null, subtitle: null },
    }));
    const rules: LeagueRules = { maxPerPlayKind: { G501: 1 }, maxPerStructure: { DOUBLES: 1 } };
    const one = [
      { gameId: 'm1', playerIds: ['p2'] },
      { gameId: 'm2', playerIds: ['p3', 'p1'] },
      { gameId: 'm3', playerIds: ['p2', 'p4'] },
      { gameId: 'm4', playerIds: ['p4'] },
    ];
    const swapped = one.map((a) => (a.gameId === 'm2' ? { ...a, playerIds: ['p1', 'p3'] } : a));
    for (const assignments of [one, swapped]) {
      // Every player is at exactly one 01 game and at most one Doubles: legal in either order.
      expect(leagueRuleViolations(rules, legs, assignments, input.participants, nameOf)).toEqual([]);
      const tally = tallyLeagueRules(rules, legs, assignments, input.participants);
      expect(tally.limits.find((entry) => entry.limit.key === 'play:G501')!.counts.get('p1')).toBe(1);
    }
    // One more 01 game for p1 is the breach, whatever the legs.
    const more = one.map((a) => (a.gameId === 'm4' ? { ...a, playerIds: ['p1'] } : a));
    expect(leagueRuleViolations(rules, legs, more, input.participants, nameOf).map((v) => v.playerId)).toEqual(['p1']);
  });
});

describe('3. same Doubles pair cap', () => {
  const doubles = games(
    Array.from({ length: 5 }, (_, i) => ({ id: `d${i + 1}`, name: `D${i + 1}`, kinds: ['DOUBLES' as const, 'G501' as const], playerCount: 2 })),
  );
  const rules: LeagueRules = { maxSameDoublesPair: 3 };
  const pairs = (list: string[][]) => list.map((ids, i) => ({ gameId: `d${i + 1}`, playerIds: ids }));
  const participants = roster(4).map((p) => createParticipantConfig(p.id));

  it('three games together pass, a fourth is a violation, and A/B equals B/A', () => {
    const three = pairs([['p1', 'p2'], ['p2', 'p1'], ['p1', 'p2'], ['p3', 'p4'], ['p1', 'p3']]);
    expect(leagueRuleViolations(rules, doubles, three, participants, nameOf)).toEqual([]);
    const four = pairs([['p1', 'p2'], ['p2', 'p1'], ['p1', 'p2'], ['p2', 'p1'], ['p3', 'p4']]);
    const violations = leagueRuleViolations(rules, doubles, four, participants, nameOf);
    expect(violations.map((v) => v.code)).toEqual(['LEAGUE_PAIR_LIMIT']);
    expect(violations[0].message).toContain('4 回');
  });

  it('two players with the same name but different ids are different pairs', () => {
    const twins = [
      player({ id: 'a1', name: 'Sato' }),
      player({ id: 'a2', name: 'Sato' }),
      player({ id: 'b', name: 'Ito' }),
      player({ id: 'c', name: 'Ueda' }),
    ];
    const list = pairs([['a1', 'b'], ['a2', 'b'], ['a1', 'b'], ['a2', 'b'], ['a1', 'c']]);
    const config = twins.map((p) => createParticipantConfig(p.id));
    expect(leagueRuleViolations({ maxSameDoublesPair: 2 }, doubles, list, config, nameOf)).toEqual([]);
    const tally = tallyLeagueRules({ maxSameDoublesPair: 2 }, doubles, list, config);
    expect([...tally.pairs.values()].map((pair) => [pair.key, pair.count]).sort()).toEqual([
      ['a1|b', 2],
      ['a1|c', 1],
      ['a2|b', 2],
    ]);
  });

  it('generation keeps every pair within the cap', () => {
    const input = withRules(orderInput(roster(4), doubles), { maxSameDoublesPair: 1 });
    for (const solution of expectOk(generateOrder(input, FAST))) {
      expect(validateHardConstraints(input, solution.assignments)).toEqual([]);
      const keys = solution.assignments.map((a) => [...a.playerIds].sort().join('|'));
      expect(new Set(keys).size).toBe(keys.length);
    }
  });
});

describe('4. only Doubles games count as pairs', () => {
  it('two players sharing several Trios games are never a Doubles pair', () => {
    const format = games([
      { id: 't1', name: 'T1', kinds: ['TRIOS'], playerCount: 3 },
      { id: 't2', name: 'T2', kinds: ['TRIOS'], playerCount: 3 },
      { id: 't3', name: 'T3', kinds: ['TRIOS'], playerCount: 3 },
      { id: 'd1', name: 'D1', kinds: ['DOUBLES'], playerCount: 2 },
    ]);
    const assignments = [
      { gameId: 't1', playerIds: ['p1', 'p2', 'p3'] },
      { gameId: 't2', playerIds: ['p1', 'p2', 'p4'] },
      { gameId: 't3', playerIds: ['p2', 'p1', 'p3'] },
      { gameId: 'd1', playerIds: ['p1', 'p2'] },
    ];
    const participants = roster(4).map((p) => createParticipantConfig(p.id));
    const tally = tallyLeagueRules({ maxSameDoublesPair: 1 }, format, assignments, participants);
    expect([...tally.pairs.values()].map((pair) => [pair.key, pair.count])).toEqual([['p1|p2', 1]]);
    expect(leagueRuleViolations({ maxSameDoublesPair: 1 }, format, assignments, participants, nameOf)).toEqual([]);
  });
});

describe('5. helper cap (distinct helpers actually placed)', () => {
  const format = games(
    Array.from({ length: 6 }, (_, i) => ({ id: `s${i + 1}`, name: `S${i + 1}`, kinds: ['SINGLES' as const], playerCount: 1 })),
  );
  const status = (helpers: string[], ids: string[]): ParticipantConfig[] =>
    ids.map((id) => ({ ...createParticipantConfig(id), leagueStatus: helpers.includes(id) ? 'HELPER' : 'REGULAR' }));
  const ids = ['p1', 'p2', 'p3', 'p4', 'p5', 'p6'];
  const rules: LeagueRules = { maxHelpers: 2 };
  const line = (list: string[]) => list.map((id, i) => ({ gameId: `s${i + 1}`, playerIds: [id] }));

  it('two placed helpers pass, a third is a violation', () => {
    const participants = status(['p1', 'p2', 'p3'], ids);
    expect(leagueRuleViolations(rules, format, line(['p1', 'p2', 'p4', 'p5', 'p6', 'p4']), participants, nameOf)).toEqual([]);
    const over = leagueRuleViolations(rules, format, line(['p1', 'p2', 'p3', 'p4', 'p5', 'p6']), participants, nameOf);
    expect(over.map((v) => v.code)).toEqual(['LEAGUE_HELPER_LIMIT']);
    expect(over[0].message).toContain('3 名');
  });

  it('the same helper in several games is one helper; a helper who sits out is none', () => {
    const participants = status(['p1', 'p2', 'p3'], ids);
    const tally = tallyLeagueRules(rules, format, line(['p1', 'p1', 'p1', 'p2', 'p4', 'p5']), participants);
    expect(tally.helpers).toEqual(['p1', 'p2']);
    expect(leagueRuleViolations({ maxHelpers: 1 }, format, line(['p1', 'p1', 'p1', 'p4', 'p5', 'p6']), participants, nameOf)).toEqual([]);
  });

  it('generation fields at most the allowed number of helpers', () => {
    const input: OrderInput = {
      ...withRules(orderInput(roster(6), format), { maxHelpers: 1 }),
      participants: status(['p1', 'p2', 'p3'], ids),
    };
    for (const solution of expectOk(generateOrder(input, FAST))) {
      expect(validateHardConstraints(input, solution.assignments)).toEqual([]);
      const fielded = new Set(solution.assignments.flatMap((a) => a.playerIds));
      expect(['p1', 'p2', 'p3'].filter((id) => fielded.has(id)).length).toBeLessThanOrEqual(1);
    }
  });
});

describe('6. league status is per order and separate from Player.guest', () => {
  const format = games([
    { id: 's1', name: 'S1', kinds: ['SINGLES'], playerCount: 1 },
    { id: 's2', name: 'S2', kinds: ['SINGLES'], playerCount: 1 },
  ]);
  const member = player({ id: 'm', name: 'Member' });
  const guest = { ...player({ id: 'g', name: 'Guest' }), guest: true };

  it('a roster member can be a helper and a one-order guest can be a regular', () => {
    const participants: ParticipantConfig[] = [
      { ...createParticipantConfig('m'), leagueStatus: 'HELPER' },
      { ...createParticipantConfig('g'), leagueStatus: 'REGULAR' },
    ];
    const input = withRules(orderInput([member, guest], format, { participants }), { maxHelpers: 0 });
    // The roster member is the helper: a cap of 0 rules them out, the guest (regular) plays both.
    const [only] = expectOk(generateOrder(input, FAST));
    expect(only.assignments.flatMap((a) => a.playerIds)).toEqual(['g', 'g']);
    expect(input.players.find((p) => p.id === 'g')!.guest).toBe(true);
    const both = withRules(orderInput([member, guest], format, { participants }), { maxHelpers: 1 });
    const [best] = expectOk(generateOrder(both, FAST));
    expect(validateHardConstraints(both, best.assignments)).toEqual([]);
  });

  it('a helper rule with an unstated status is never read as REGULAR', () => {
    const input = withRules(orderInput([member, guest], format), { maxHelpers: 2 });
    const assignments = [
      { gameId: 's1', playerIds: ['m'] },
      { gameId: 's2', playerIds: ['g'] },
    ];
    expect(codes(input, assignments)).toEqual(['LEAGUE_STATUS_UNSET', 'LEAGUE_STATUS_UNSET']);
    const result = generateOrder(input, FAST);
    expect(result.ok).toBe(false);
    expect(result.diagnostics.map((d) => d.code)).toEqual(['LEAGUE_STATUS_UNSET']);
    expect(result.diagnostics[0].message).toContain('Member');
  });

  it('an order without rules (old data) needs no status at all, guest or not', () => {
    const input = orderInput([member, guest], format);
    expect(input.leagueRules).toBeUndefined();
    const [best] = expectOk(generateOrder(input, FAST));
    expect(validateHardConstraints(input, best.assignments)).toEqual([]);
    // Only the helper rule reads the status; other rules leave it unasked.
    const capped = withRules(input, { maxPerStructure: { SINGLES: 1 } });
    expect(expectOk(generateOrder(capped, FAST)).length).toBeGreaterThan(0);
  });
});

describe('7. every operation honours the rules', () => {
  const players = roster(5);
  const input = withRules(orderInput(players, singlesDoubles), {
    maxPerStructure: { SINGLES: 1, DOUBLES: 3 },
    maxPerPlayKind: { CRICKET: 2 },
    maxSameDoublesPair: 1,
  });

  it('generation: every candidate meets every rule', () => {
    const result = generateOrder(input, FAST);
    for (const solution of expectOk(result)) {
      expect(validateHardConstraints(input, solution.assignments)).toEqual([]);
    }
  });

  it('manual edit: a breach is reported, never reported as legal', () => {
    const [best] = expectOk(generateOrder(input, FAST));
    let session = undoableReducer(createUndoable(input), { type: 'generated', candidates: [best] });
    const s1 = best.assignments.find((a) => a.gameId === 's1')!.playerIds[0];
    // Put the Singles player of S1 in S2 as well: two Singles against a cap of one.
    session = undoableReducer(session, { type: 'assignPlayer', gameId: 's2', slotIndex: 0, playerId: s1 });
    expect(session.present.violations.map((v) => v.code)).toContain('LEAGUE_STRUCTURE_LIMIT');
    expect(evaluateManualOrder(input, session.present.current!.assignments).ok).toBe(false);
    // Undo restores the legal line-up; redo the breach. The rules travel with the input.
    session = undoableReducer(session, { type: 'undo' });
    expect(session.present.violations).toEqual([]);
    expect(session.present.input.leagueRules).toEqual(input.leagueRules);
    session = undoableReducer(session, { type: 'redo' });
    expect(session.present.violations.map((v) => v.code)).toContain('LEAGUE_STRUCTURE_LIMIT');
  });

  it('partial re-optimisation keeps the locks and the rules', () => {
    const [best] = expectOk(generateOrder(input, FAST));
    let session = undoableReducer(createUndoable(input), { type: 'generated', candidates: [best] });
    session = undoableReducer(session, { type: 'lockAllExcept', gameId: 'd5' });
    const result = reoptimise(session.present.input, FAST);
    const [next] = expectOk(result);
    expect(validateHardConstraints(session.present.input, next.assignments)).toEqual([]);
    for (const lock of session.present.input.locks) {
      expect(next.assignments.find((a) => a.gameId === lock.gameId)!.playerIds[lock.slotIndex]).toBe(lock.playerId);
    }
  });

  it('a lock that breaks a rule is not "solved" by breaking it: no order, with the reason', () => {
    // Two locks put p1 in two Singles against a cap of one.
    const locked: OrderInput = {
      ...input,
      locks: [
        { gameId: 's1', slotIndex: 0, playerId: 'p1' },
        { gameId: 's2', slotIndex: 0, playerId: 'p1' },
      ],
    };
    const result = generateOrder(locked, FAST);
    expect(result.ok).toBe(false);
    expect(result.diagnostics[0].code).toBe('SEARCH_EXHAUSTED');
    expect(result.diagnostics[0].message).toContain('リーグ規則');
    // Every remedy offered was re-searched with the rules in force.
    for (const suggestion of result.diagnostics[0].suggestions) {
      if (suggestion.kind === 'removeLock') {
        expect(generateOrder({ ...locked, locks: [] }, FAST).ok).toBe(true);
      }
    }
  });

  it('a cap of 0 that leaves a game short is diagnosed up front, naming the rule', () => {
    const zero = withRules(orderInput(roster(3), singlesDoubles.slice(0, 3)), { maxPerStructure: { SINGLES: 0 } });
    const result = generateOrder(zero, FAST);
    expect(result.ok).toBe(false);
    expect(result.diagnostics[0].code).toBe('GAME_INSUFFICIENT_ELIGIBLE');
    expect(result.diagnostics[0].suggestions.some((s) => s.message.includes('リーグ規則'))).toBe(true);
  });

  it('a category cap the roster cannot fill conflicts with the total cap and is reported', () => {
    // Three Singles, two players, Singles cap 1 each: only two Singles slots can ever be filled.
    const short = withRules(orderInput(roster(2), singlesDoubles.slice(0, 3)), { maxPerStructure: { SINGLES: 1 } });
    const result = generateOrder(short, FAST);
    expect(result.ok).toBe(false);
    expect(result.diagnostics.map((d) => d.code)).toContain('LEAGUE_RULE_CAPACITY');
  });

  it('unreadable rules (a damaged import) block generation and validation rather than being ignored', () => {
    const broken = withRules(input, { maxPerStructure: { SINGLES: 1.5 } });
    const result = generateOrder(broken, FAST);
    expect(result.ok).toBe(false);
    expect(result.diagnostics.map((d) => d.code)).toEqual(['LEAGUE_RULE_INVALID']);
    const [best] = expectOk(generateOrder(input, FAST));
    expect(codes(broken, best.assignments)).toEqual(['LEAGUE_RULE_INVALID']);
  });
});

describe('10. no rules: the rule-free path is unchanged', () => {
  it('no rules, an empty rule object and absent rules produce identical orders', () => {
    const base = orderInput(roster(5), singlesDoubles, { settings: { timeLimitMs: 4000, nodeLimit: 4000 } });
    expect(hasLeagueRules({})).toBe(false);
    const strip = (result: ReturnType<typeof generateOrder>) =>
      expectOk(result).map((solution) => ({ assignments: solution.assignments, score: solution.score.total }));
    expect(strip(generateOrder({ ...base, leagueRules: {} }))).toEqual(strip(generateOrder(base)));
  });
});

describe('rule editor text', () => {
  it('blank is no rule and 0 is a cap of zero; negatives, fractions and words are refused', () => {
    expect(parseCapText('')).toEqual({ ok: true, value: undefined });
    expect(parseCapText(' 0 ')).toEqual({ ok: true, value: 0 });
    expect(parseCapText('３')).toEqual({ ok: true, value: 3 });
    for (const bad of ['-1', '1.5', 'abc', '1e2', '100']) expect(parseCapText(bad).ok).toBe(false);
  });

  it('round-trips through the editor and drops an all-blank set', () => {
    const rules: LeagueRules = { maxPerStructure: { SINGLES: 0, DOUBLES: 4 }, maxPerPlayKind: { CRICKET: 2 }, maxSameDoublesPair: 3, maxHelpers: 1 };
    expect(leagueRulesFromText(leagueRulesToText(rules))).toEqual({ ok: true, rules });
    expect(leagueRulesFromText({ 'structure:SINGLES': '  ' })).toEqual({ ok: true, rules: undefined });
    const failed = leagueRulesFromText({ pair: '-2' });
    expect(failed.ok).toBe(false);
  });

  it('a damaged stored value is kept visible (and invalid), never blanked into "no rule"', () => {
    const parsed = parseLeagueRules({ maxPerStructure: { SINGLES: 'two', BOGUS: 3 }, maxHelpers: -1, other: 1 });
    expect(Number.isNaN(parsed!.maxPerStructure!.SINGLES)).toBe(true);
    expect(parsed!.maxHelpers).toBe(-1);
    expect(Object.keys(parsed!.maxPerStructure!)).toEqual(['SINGLES']);
    const text = leagueRulesToText(parsed);
    expect(leagueRulesFromText(text).ok).toBe(false);
    expect(parseLeagueRules(undefined)).toBeUndefined();
    expect(parseLeagueRules({})).toBeUndefined();
  });
});

describe('the search counts exactly what the validator checks', () => {
  it('over many random line-ups and rule sets, the incremental counters agree with the validator', async () => {
    const { prepare } = await import('./prepare');
    const { describeCombo } = await import('./candidates/combinations');
    const { selectionMeetsLeagueRules } = await import('./search/bound');
    let seed = 7;
    const random = (): number => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return seed / 2147483648;
    };
    const players = roster(6);
    let agreed = 0;
    for (let trial = 0; trial < 300; trial += 1) {
      const rules: LeagueRules = {
        maxPerStructure: { SINGLES: Math.floor(random() * 3), DOUBLES: 1 + Math.floor(random() * 3) },
        maxPerPlayKind: { G501: 1 + Math.floor(random() * 4), CRICKET: Math.floor(random() * 3) },
        maxSameDoublesPair: Math.floor(random() * 3),
        maxHelpers: Math.floor(random() * 3),
      };
      const participants = players.map((p) => ({
        ...createParticipantConfig(p.id),
        leagueStatus: random() < 0.4 ? ('HELPER' as const) : ('REGULAR' as const),
      }));
      const input = withRules(orderInput(players, singlesDoubles, { participants }), rules);
      const ctx = prepare({ ...input, leagueRules: undefined });
      const ruled = prepare(input);
      const selection = ctx.games.map((game, gi) => {
        const pool = [...Array(ctx.playerCount).keys()].sort(() => random() - 0.5);
        return describeCombo(ruled, gi, pool.slice(0, game.playerCount).sort((a, b) => a - b));
      });
      const assignments = selection.map((combo, gi) => ({
        gameId: ctx.games[gi].id,
        playerIds: combo.members.map((pi) => ctx.playerIds[pi]),
      }));
      const byValidator = leagueRuleViolations(rules, input.games, assignments, input.participants, nameOf).length === 0;
      const zeroBlocked = selection.some((combo, gi) => combo.members.some((pi) => !ruled.eligible[gi][pi]));
      // A cap of 0 is folded into eligibility, so the search never even builds such a placement.
      const bySearch = !zeroBlocked && selectionMeetsLeagueRules(ruled, selection);
      expect(bySearch).toBe(byValidator);
      agreed += 1;
    }
    expect(agreed).toBe(300);
  });
});
