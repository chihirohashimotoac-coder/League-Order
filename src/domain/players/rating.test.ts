import { describe, expect, it } from 'vitest';
import { normaliseRating, participantRating, resolveRatings } from './rating';
import { createParticipantConfig } from '../orders/participants';
import { player } from '../../test/factories';

describe('resolveRatings (design D-06: Unknown is never 0)', () => {
  const roster = [
    player({ id: 'a', name: 'A', rating: 14 }),
    player({ id: 'b', name: 'B', rating: 8 }),
    player({ id: 'c', name: 'C', rating: null }),
  ];
  const participants = roster.map((p) => createParticipantConfig(p.id));

  it('imputes an unknown rating with the median of the known ratings', () => {
    const resolved = resolveRatings(roster, participants);
    expect(resolved.imputationValue).toBe(11);
    expect(resolved.effective.get('c')).toBe(11);
    expect(resolved.effective.get('c')).not.toBe(0);
    expect(resolved.imputed.has('c')).toBe(true);
    expect(resolved.imputed.has('a')).toBe(false);
  });

  it('uses the median rather than the mean so one outlier cannot skew it', () => {
    const skewed = [
      player({ id: 'a', name: 'A', rating: 2 }),
      player({ id: 'b', name: 'B', rating: 3 }),
      player({ id: 'c', name: 'C', rating: 4 }),
      player({ id: 'd', name: 'D', rating: 100 }),
      player({ id: 'e', name: 'E', rating: null }),
    ];
    const resolved = resolveRatings(skewed, skewed.map((p) => createParticipantConfig(p.id)));
    expect(resolved.imputationValue).toBe(3.5); // median of 2,3,4,100
    expect(resolved.effective.get('e')).toBe(3.5);
  });

  it('scores an imputed player as exactly average, not as the weakest', () => {
    const resolved = resolveRatings(roster, participants);
    const normalised = normaliseRating(resolved.effective.get('c')!, resolved);
    const weakest = normaliseRating(resolved.effective.get('b')!, resolved);
    expect(normalised).toBeGreaterThan(weakest);
    expect(normalised).toBeGreaterThan(0);
  });

  it('degenerates to a flat neutral value when nobody has a rating', () => {
    const unrated = [
      player({ id: 'a', name: 'A' }),
      player({ id: 'b', name: 'B' }),
    ];
    const resolved = resolveRatings(unrated, unrated.map((p) => createParticipantConfig(p.id)));
    expect(resolved.knownCount).toBe(0);
    expect(resolved.imputationValue).toBeNull();
    expect(resolved.effective.get('a')).toBeNull();
    expect(normaliseRating(resolved.effective.get('a') ?? null, resolved)).toBe(0.5);
  });

  it('ignores players who are not participating', () => {
    const configs = [
      createParticipantConfig('a'),
      { ...createParticipantConfig('b'), include: false },
      createParticipantConfig('c'),
    ];
    const resolved = resolveRatings(roster, configs);
    expect(resolved.knownCount).toBe(1);
    expect(resolved.imputationValue).toBe(14);
    expect(resolved.effective.has('b')).toBe(false);
  });

  it('honours an order-level rating override, including an override back to Unknown', () => {
    const configs = [
      { ...createParticipantConfig('a'), ratingOverride: 5 },
      { ...createParticipantConfig('b'), ratingOverride: null },
      createParticipantConfig('c'),
    ];
    expect(participantRating(roster[0], configs[0])).toBe(5);
    expect(participantRating(roster[1], configs[1])).toBeNull();
    const resolved = resolveRatings(roster, configs);
    expect(resolved.effective.get('a')).toBe(5);
    expect(resolved.imputed.has('b')).toBe(true);
  });
});

describe('normaliseRating', () => {
  it('maps the span onto 0..1 and collapses to 0.5 when every rating is equal', () => {
    const roster = [
      player({ id: 'a', name: 'A', rating: 4 }),
      player({ id: 'b', name: 'B', rating: 14 }),
    ];
    const resolved = resolveRatings(roster, roster.map((p) => createParticipantConfig(p.id)));
    expect(normaliseRating(4, resolved)).toBe(0);
    expect(normaliseRating(14, resolved)).toBe(1);
    expect(normaliseRating(9, resolved)).toBeCloseTo(0.5, 10);

    const flat = [player({ id: 'a', name: 'A', rating: 7 }), player({ id: 'b', name: 'B', rating: 7 })];
    const flatResolved = resolveRatings(flat, flat.map((p) => createParticipantConfig(p.id)));
    expect(normaliseRating(7, flatResolved)).toBe(0.5);
  });
});
