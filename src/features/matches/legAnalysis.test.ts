import { describe, expect, it } from 'vitest';
import type { LiveThrow, ThrowLeg } from './parse';
import { cardHighlights, chanceRate, finishChances, finishable, gameHighlights, raceLead, raceSeries } from './legAnalysis';

const v = (side: 0 | 1, round: number, score: number, left: number, extra: { finish?: boolean; darts?: number; member?: string } = {}): LiveThrow => ({
  kind: '01',
  side,
  round,
  score,
  left,
  darts: extra.darts ?? 3,
  finish: extra.finish ?? false,
  member: extra.member ?? null,
});

const leg = (index: number, throws: LiveThrow[], extra: Partial<ThrowLeg> = {}): ThrowLeg => ({
  index,
  first: 0,
  ended: true,
  winner: null,
  thrower: null,
  round: null,
  member: null,
  left: null,
  start: [501, 501],
  numbers: null,
  marks: null,
  points: null,
  throws,
  bull: false,
  dartsTotal: null,
  ...extra,
});

// Side 1 is 160 behind after 2 visits (341 vs 181) and again after 3 (181 vs 21), and still wins.
const comeback = leg(
  0,
  [
    v(0, 1, 180, 321, { member: 'A1' }),
    v(1, 1, 60, 441, { member: 'B1' }),
    v(0, 2, 140, 181, { member: 'A1' }),
    v(1, 2, 100, 341, { member: 'B1' }),
    v(0, 3, 160, 21, { member: 'A1' }),
    v(1, 3, 160, 181, { member: 'B1' }),
    v(0, 4, 0, 21, { member: 'A1' }),
    v(1, 4, 140, 41, { member: 'B1' }),
    v(0, 5, 0, 21, { member: 'A1' }),
    v(1, 5, 41, 0, { member: 'B1', finish: true, darts: 2 }),
  ],
  { winner: 1, dartsTotal: [15, 14] },
);

describe('finishing chances (上がり圏)', () => {
  it('counts 2–170 with a standard route, never a bogey number or 1', () => {
    expect(finishable(170)).toBe(true);
    expect(finishable(2)).toBe(true);
    for (const bogey of [169, 168, 166, 165, 163, 162, 159]) expect(finishable(bogey)).toBe(false);
    expect(finishable(171)).toBe(false);
    expect(finishable(1)).toBe(false);
  });

  it('takes the points a visit started on, busts included, and narrows to one member', () => {
    const chances = finishChances([comeback], 0);
    // A1 started visits on 501, 321, 181, 21, 21 → 21 twice (both missed).
    expect(chances.map((c) => [c.left, c.hit])).toEqual([
      [21, false],
      [21, false],
    ]);
    const b = finishChances([comeback], 1, 'B1');
    expect(b.map((c) => [c.left, c.hit])).toEqual([[41, true]]);
    expect(chanceRate(b)).toEqual({ hits: 1, chances: 1, rate: 1 });
    expect(chanceRate([])).toEqual({ hits: 0, chances: 0, rate: null });
    expect(finishChances([{ ...comeback, bull: true }], 1)).toEqual([]);
  });
});

describe('race (残り点レース)', () => {
  it('lists points left by darts, the finishing visit with its own darts', () => {
    const [a, b] = raceSeries(comeback, 501);
    expect(a.map((p) => p.darts)).toEqual([0, 3, 6, 9, 12, 15]);
    expect(b.at(-1)).toEqual({ darts: 14, left: 0 });
    expect(raceLead([a, b])).toEqual({ visits: 5, darts: 15, side: 1, by: 21 });
  });
});

describe('highlights (見どころ)', () => {
  const game = { schid: 's1', slotLabel: 'シングルス1', flip: true, names: ['Home', 'Away'] as [string, string] };

  it('finds the comeback, the 180 and the fastest-leg candidate, in card order through flip', () => {
    const found = gameHighlights([comeback], game);
    const back = found.find((h) => h.kind === 'comeback')!;
    expect(back).toMatchObject({ n01Side: 1, cardSide: 0, who: 'Home', value: 160, round: 2, detail: '残り 341 対 181 から' });
    expect(found.filter((h) => h.kind === 'ton80').map((h) => h.who)).toEqual(['A1']);
    expect(found.find((h) => h.kind === 'fastLeg')).toMatchObject({ value: 14, start: 501, who: 'B1' });
    expect(found.some((h) => h.kind === 'highOut')).toBe(false);
  });

  it('a high finish of 100 or more is a highlight; bull legs are skipped', () => {
    const high = leg(1, [v(0, 1, 100, 401), v(1, 1, 100, 401), v(0, 2, 140, 261), v(1, 2, 100, 301), v(0, 3, 140, 121), v(1, 3, 60, 241), v(0, 4, 121, 0, { finish: true, darts: 3 })], {
      winner: 0,
    });
    expect(gameHighlights([high], game).find((h) => h.kind === 'highOut')).toMatchObject({ value: 121, detail: '121 アウト' });
    expect(gameHighlights([{ ...high, bull: true }], game)).toEqual([]);
  });

  it('ranks a card: comebacks, high outs, 180s per player with a count, the fastest leg per start', () => {
    const one = gameHighlights([comeback], game);
    const two = gameHighlights([comeback], { ...game, schid: 's2', slotLabel: 'シングルス2' });
    const ranked = cardHighlights([...one, ...two]);
    expect(ranked.map((h) => h.kind)).toEqual(['comeback', 'comeback', 'ton80', 'fastLeg']);
    expect(ranked[2]).toMatchObject({ who: 'A1', value: 2, detail: '180 × 2', schid: 's1' });
    expect(ranked[3].detail).toBe('14 本 (501 の最短)');
  });
});
