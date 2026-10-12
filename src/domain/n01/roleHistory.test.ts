import { describe, expect, it } from 'vitest';
import {
  OUTCOME_EVIDENCE_FACTOR,
  aggregateRoleEvidence,
  familyOfMatchType,
  jstDayStart,
  structureOfHeadCount,
  type RoleGameRecord,
} from './roleHistory';
import { RECENCY_WEIGHTS } from './recency';

const DAY = jstDayStart('2026-10-20')!;

function record(overrides: Partial<RoleGameRecord> & Pick<RoleGameRecord, 'sides'>): RoleGameRecord {
  return { gameId: 'g1', seasonIndex: 0, startTime: DAY - 7 * 86_400, structure: 'DOUBLES', family: '01', ...overrides };
}

const side = (teamId: string, members: [string, number | null][], legsWon: number, score: number | null, darts: number | null) => ({
  teamId,
  members: members.map(([key, base]) => ({ key, base })),
  legsWon,
  score,
  darts,
});

describe('role evidence from n01 games', () => {
  it('maps head counts and match types to roles', () => {
    expect(['SINGLES', 'DOUBLES', 'TRIOS', 'GALLON', 'GALLON']).toEqual([1, 2, 3, 4, 6].map(structureOfHeadCount));
    expect(familyOfMatchType('01')).toBe('01');
    expect(familyOfMatchType('501')).toBe('01');
    expect(familyOfMatchType('cricket')).toBe('CRICKET');
    expect(familyOfMatchType('count-up')).toBe('OTHER');
  });

  it('a 01 game: the side PPR against the members\' season PPR, credited 1/k to each member', () => {
    // Side PPR 60 (3 · 1000 / 50) against members at 50 and 54 (mean 52): residual +8.
    const games = [record({ sides: [side('A', [['a', 50], ['b', 54]], 2, 1000, 50), side('B', [['x', 50], ['y', 50]], 1, 900, 51)] })];
    const result = aggregateRoleEvidence(games, () => 'A', { before: DAY, leagueMean: 50 });
    const weight = (RECENCY_WEIGHTS[0] * 3) / 2; // 3 legs played, two members
    expect(result.games).toBe(1);
    expect(result.evidence.a['DOUBLES|01']).toEqual({ games: 1, weight, sum: weight * 8 });
    expect(result.evidence.b['DOUBLES|01']).toEqual({ games: 1, weight, sum: weight * 8 });
    expect(result.evidence.x).toBeUndefined();
  });

  it('never uses games on or after the match day (no future data)', () => {
    const games = [
      record({ gameId: 'past', sides: [side('A', [['a', 50]], 2, 501, 30), side('B', [['x', 50]], 0, 300, 30)], structure: 'SINGLES' }),
      record({ gameId: 'same-day', startTime: DAY + 3600, sides: [side('A', [['a', 50]], 2, 501, 15), side('B', [['x', 50]], 0, 300, 15)], structure: 'SINGLES' }),
      record({ gameId: 'undated', startTime: null, sides: [side('A', [['a', 50]], 2, 501, 15), side('B', [['x', 50]], 0, 300, 15)], structure: 'SINGLES' }),
    ];
    const result = aggregateRoleEvidence(games, () => 'A', { before: DAY, leagueMean: 50 });
    expect(result.games).toBe(1);
    expect(result.droppedFuture).toBe(2);
    expect(result.evidence.a['SINGLES|01']!.games).toBe(1);
  });

  it('a member whose season PPR is unknown makes the game say nothing (never read as 0)', () => {
    const games = [record({ sides: [side('A', [['a', 50], ['b', null]], 2, 1000, 50), side('B', [['x', 50], ['y', 50]], 1, 900, 51)] })];
    const result = aggregateRoleEvidence(games, () => 'A', { before: DAY, leagueMean: 50 });
    expect(result.games).toBe(0);
    expect(result.evidence).toEqual({});
  });

  it('a Cricket game counts as a shrunk, down-weighted result, not a raw win rate', () => {
    const games = [
      record({ family: 'CRICKET', sides: [side('A', [['a', 50], ['b', 50]], 2, 0, 60), side('B', [['x', 50], ['y', 50]], 0, 0, 60)] }),
    ];
    const result = aggregateRoleEvidence(games, () => 'A', { before: DAY, leagueMean: 50 });
    const cell = result.evidence.a['DOUBLES|CRICKET']!;
    expect(cell.weight).toBeCloseTo(((RECENCY_WEIGHTS[0] * 2) / 2) * OUTCOME_EVIDENCE_FACTOR, 12);
    expect(cell.sum / cell.weight).toBeGreaterThan(0);
    expect(cell.sum / cell.weight).toBeLessThanOrEqual(15);
  });

  it('older seasons weigh less, and the same game reported twice counts once', () => {
    const one = record({ seasonIndex: 1, sides: [side('A', [['a', 50]], 2, 600, 30), side('B', [['x', 50]], 0, 400, 30)], structure: 'SINGLES' });
    const result = aggregateRoleEvidence([one, { ...one }], () => 'A', { before: DAY, leagueMean: 50 });
    expect(result.games).toBe(1);
    expect(result.evidence.a['SINGLES|01']!.weight).toBeCloseTo(RECENCY_WEIGHTS[1] * 2, 12);
  });
});
