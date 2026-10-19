import { describe, expect, it } from 'vitest';
import { createParticipantConfig } from '../orders/participants';
import { player } from '../../test/factories';
import {
  DISCIPLINE_STRENGTH_WEIGHTS,
  describeStrengthWeights,
  effectiveStrengthWeights,
  explainStrengthWeights,
  formatPpr,
  parsePprInput,
  playerPpr,
  resolvePprs,
  resolveStrength,
} from './strength';
import type { Player } from '../types';

const everyone = (players: Player[]) => players.map((p) => createParticipantConfig(p.id));

/** The vNext fixture: five players with both a Rating and a PPR. */
function fixtureRoster(): Player[] {
  return [
    player({ id: 'pA', name: 'Player A', rating: 15, ppr: 78 }),
    player({ id: 'pB', name: 'Player B', rating: 14, ppr: 74 }),
    player({ id: 'pC', name: 'Player C', rating: 14, ppr: 67 }),
    player({ id: 'pD', name: 'Player D', rating: 11, ppr: 58 }),
    player({ id: 'pE', name: 'Player E', rating: 8, ppr: 47 }),
  ];
}

/** Rating and PPR disagree: X is the better soft player, Y the better steel player. */
function crossedRoster(): Player[] {
  return [
    player({ id: 'pX', name: 'X', rating: 16, ppr: 50 }),
    player({ id: 'pY', name: 'Y', rating: 8, ppr: 90 }),
    player({ id: 'pZ', name: 'Z', rating: 12, ppr: 70 }),
  ];
}

describe('parsePprInput', () => {
  it('reads blank as Unknown, never 0', () => {
    expect(parsePprInput('')).toEqual({ ok: true, value: null });
    expect(parsePprInput('   ')).toEqual({ ok: true, value: null });
  });

  it('accepts decimals and the theoretical maximum', () => {
    expect(parsePprInput('72.45')).toEqual({ ok: true, value: 72.45 });
    expect(parsePprInput('0')).toEqual({ ok: true, value: 0 });
    expect(parsePprInput('180')).toEqual({ ok: true, value: 180 });
  });

  it('rejects values outside 0..180 and non-numbers', () => {
    expect(parsePprInput('180.01').ok).toBe(false);
    expect(parsePprInput('-1').ok).toBe(false);
    expect(parsePprInput('abc').ok).toBe(false);
  });
});

describe('legacy players', () => {
  it('reads a player stored without `ppr` as Unknown', () => {
    const legacy = { ...player({ id: 'p1', name: 'Old', rating: 10 }) } as Partial<Player>;
    delete legacy.ppr;
    expect(playerPpr(legacy as Player)).toBeNull();
  });
});

describe('discipline weights', () => {
  it('uses Rating 70 / PPR 30 for soft and the reverse for steel', () => {
    expect(DISCIPLINE_STRENGTH_WEIGHTS.SOFT).toEqual({ rating: 0.7, ppr: 0.3 });
    expect(DISCIPLINE_STRENGTH_WEIGHTS.STEEL).toEqual({ rating: 0.3, ppr: 0.7 });
    expect(DISCIPLINE_STRENGTH_WEIGHTS.UNSPECIFIED).toEqual({ rating: 0.5, ppr: 0.5 });
  });

  it('describes the blend larger share first', () => {
    expect(describeStrengthWeights({ rating: 0.7, ppr: 0.3 })).toBe('Rating 70% / PPR 30%');
    expect(describeStrengthWeights({ rating: 0.3, ppr: 0.7 })).toBe('PPR 70% / Rating 30%');
    expect(describeStrengthWeights({ rating: 1, ppr: 0 })).toBe('Rating 100%');
    expect(describeStrengthWeights({ rating: 0, ppr: 0 })).toBeNull();
  });

  it('formats PPR without ever printing 0 for Unknown', () => {
    expect(formatPpr(68.4)).toBe('PPR 68.4');
    expect(formatPpr(72.456)).toBe('PPR 72.46');
    expect(formatPpr(null)).toBe('PPR —');
  });
});

describe('resolveStrength', () => {
  it('gives Rating the stronger influence in soft and PPR in steel', () => {
    const roster = crossedRoster();
    const soft = resolveStrength('SOFT', roster, everyone(roster));
    const steel = resolveStrength('STEEL', roster, everyone(roster));
    expect(soft.weights).toEqual({ rating: 0.7, ppr: 0.3 });
    expect(steel.weights).toEqual({ rating: 0.3, ppr: 0.7 });
    // X is the higher-rated player, Y the higher-PPR one.
    expect(soft.strength.get('pX')!).toBeGreaterThan(soft.strength.get('pY')!);
    expect(steel.strength.get('pY')!).toBeGreaterThan(steel.strength.get('pX')!);
  });

  it('normalises each metric on its own before blending (no raw sum)', () => {
    const roster = fixtureRoster();
    const model = resolveStrength('UNSPECIFIED', roster, everyone(roster));
    // A tops both metrics, E bottoms both: exactly 1 and 0, whatever the raw scales.
    expect(model.strength.get('pA')).toBeCloseTo(1, 10);
    expect(model.strength.get('pE')).toBeCloseTo(0, 10);
    // C: Rating (14-8)/7 = 0.857.., PPR (67-47)/31 = 0.645.. -> mean of the two.
    expect(model.strength.get('pC')).toBeCloseTo(0.5 * (6 / 7) + 0.5 * (20 / 31), 10);
    for (const value of model.strength.values()) {
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThanOrEqual(1);
    }
  });

  it('works with Rating only (PPR weight moves to Rating)', () => {
    const roster = fixtureRoster().map((p) => ({ ...p, ppr: null }));
    const model = resolveStrength('STEEL', roster, everyone(roster));
    expect(model.weights).toEqual({ rating: 1, ppr: 0 });
    expect(model.strength.get('pA')).toBeCloseTo(1, 10);
    expect(model.strength.get('pE')).toBeCloseTo(0, 10);
  });

  it('works with PPR only (Rating weight moves to PPR)', () => {
    const roster = fixtureRoster().map((p) => ({ ...p, rating: null }));
    const model = resolveStrength('SOFT', roster, everyone(roster));
    expect(model.weights).toEqual({ rating: 0, ppr: 1 });
    expect(model.strength.get('pA')).toBeCloseTo(1, 10);
    expect(model.strength.get('pB')).toBeCloseTo((74 - 47) / 31, 10);
  });

  it('is a neutral 0.5 for everyone when neither metric exists', () => {
    const roster = fixtureRoster().map((p) => ({ ...p, rating: null, ppr: null }));
    for (const discipline of ['SOFT', 'STEEL', 'UNSPECIFIED'] as const) {
      const model = resolveStrength(discipline, roster, everyone(roster));
      expect(model.weights).toEqual({ rating: 0, ppr: 0 });
      for (const value of model.strength.values()) expect(value).toBe(0.5);
    }
  });

  it('imputes a missing PPR with the participants median, never 0', () => {
    const roster = fixtureRoster().map((p) => (p.id === 'pA' ? { ...p, ppr: null } : p));
    const pprs = resolvePprs(roster, everyone(roster));
    // Known PPRs 74, 67, 58, 47 -> median 62.5.
    expect(pprs.imputationValue).toBe(62.5);
    expect(pprs.effective.get('pA')).toBe(62.5);
    expect(pprs.imputed.has('pA')).toBe(true);
    const model = resolveStrength('STEEL', roster, everyone(roster));
    // Under 0-imputation A's PPR would be the minimum (normPpr 0); the median puts it mid-range.
    expect(model.normPpr.get('pA')!).toBeGreaterThan(0.4);
    expect(model.normPpr.get('pA')!).toBeLessThan(0.6);
  });

  it('drops a metric that cannot tell the participants apart', () => {
    const roster = fixtureRoster().map((p) => ({ ...p, ppr: p.id === 'pA' ? 70 : null }));
    const model = resolveStrength('STEEL', roster, everyone(roster));
    // One known PPR imputes everybody else to the same value: no information.
    expect(effectiveStrengthWeights('STEEL', model.ratings, model.pprs)).toEqual({ rating: 1, ppr: 0 });
  });

  it('only looks at today’s participants', () => {
    const roster = fixtureRoster();
    const participants = everyone(roster).map((c) => (c.playerId === 'pA' ? { ...c, include: false } : c));
    const model = resolveStrength('SOFT', roster, participants);
    expect(model.strength.has('pA')).toBe(false);
    expect(model.strength.get('pB')).toBeCloseTo(1, 10);
  });
});

describe('explainStrengthWeights: the note matches the blend actually used', () => {
  const explain = (discipline: 'SOFT' | 'STEEL' | 'UNSPECIFIED', players: Player[]) =>
    explainStrengthWeights(resolveStrength(discipline, players, everyone(players)));

  it('Rating only (first manual entry): "Rating 100%" and no "same weight" claim', () => {
    const players = [
      player({ id: 'a', name: 'A', rating: 14 }),
      player({ id: 'b', name: 'B', rating: 9 }),
      player({ id: 'c', name: 'C' }),
    ];
    const text = explain('UNSPECIFIED', players);
    expect(text.title).toBe('戦力評価 Rating 100%');
    expect(text.note).toContain('PPR (3投平均) が未入力のため、Rating だけで評価します');
    expect(text.note).not.toContain('同じ比重');
    expect(text.note).toContain('未入力のRatingは 0 ではなく参加者の中央値');
  });

  it('PPR only: "PPR 100%"', () => {
    const players = [player({ id: 'a', name: 'A', ppr: 70 }), player({ id: 'b', name: 'B', ppr: 50 })];
    const text = explain('STEEL', players);
    expect(text.title).toBe('戦力評価 PPR 100%');
    expect(text.note).toBe('Rating が未入力のため、PPR (3投平均) だけで評価します。');
  });

  it('both, with the discipline’s own blend', () => {
    expect(explain('UNSPECIFIED', fixtureRoster())).toEqual({
      title: '戦力評価 Rating 50% / PPR 50%',
      note: 'ダーツ種別が未設定のため、Rating と PPR (3投平均) を同じ比重で評価します。',
    });
    expect(explain('SOFT', fixtureRoster()).title).toBe('戦力評価 Rating 70% / PPR 30%');
    expect(explain('SOFT', fixtureRoster()).note).toContain('ソフトダーツの既定の配分');
    expect(explain('STEEL', fixtureRoster()).title).toBe('戦力評価 PPR 70% / Rating 30%');
    expect(explain('STEEL', fixtureRoster()).note).toContain('ハードダーツ (スティール) の既定の配分');
  });

  it('neither entered', () => {
    const players = [player({ id: 'a', name: 'A' }), player({ id: 'b', name: 'B' })];
    expect(explain('SOFT', players)).toEqual({
      title: '戦力評価なし',
      note: '参加者の Rating・PPR (3投平均) がどちらも未入力のため、適性と公平性で生成します。',
    });
  });

  it('everybody equal', () => {
    const players = [player({ id: 'a', name: 'A', rating: 10, ppr: 60 }), player({ id: 'b', name: 'B', rating: 10, ppr: 60 })];
    expect(explain('SOFT', players)).toEqual({
      title: '戦力評価なし',
      note: 'Rating は全員同じ値、PPR (3投平均) は全員同じ値で差が無いため、適性と公平性で生成します。',
    });
    const mixed = [player({ id: 'a', name: 'A', rating: 10 }), player({ id: 'b', name: 'B', rating: 10 })];
    expect(explain('SOFT', mixed).note).toBe('Rating は全員同じ値、PPR (3投平均) は未入力で差が無いため、適性と公平性で生成します。');
    // One informative metric, the other flat.
    const flatPpr = [player({ id: 'a', name: 'A', rating: 12, ppr: 60 }), player({ id: 'b', name: 'B', rating: 8, ppr: 60 })];
    expect(explain('UNSPECIFIED', flatPpr)).toEqual({
      title: '戦力評価 Rating 100%',
      note: 'PPR (3投平均) が全員同じ値のため、Rating だけで評価します。',
    });
  });
});
