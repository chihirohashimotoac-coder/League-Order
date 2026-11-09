import { describe, expect, it } from 'vitest';
import { biggestSwing, outlookTrail } from './cardTrail';
import { cardOutlook } from './probability';

const slots = [{ schid: 's1' }, { schid: 's2' }, { schid: 's3' }];
const chance = new Map([
  ['s1', 0.5],
  ['s2', 0.5],
  ['s3', 0.5],
]);

describe('card estimate trail (カード勝率の推移)', () => {
  it('starts from the pre-card estimate and adds a step per game in the order the games ended', () => {
    const steps = outlookTrail(slots, chance, [
      { schid: 's2', winner: 1, endedAt: 200 },
      { schid: 's1', winner: 0, endedAt: 100 },
    ]);
    expect(steps.map((step) => step.schid)).toEqual([null, 's1', 's2']);
    expect(steps[0].outlook.win).toBeCloseTo(0.5, 10);
    expect(steps[1].outlook.win).toBeCloseTo(0.75, 10); // 1-0 up: win unless both remaining are lost
    expect(steps[2].outlook.win).toBeCloseTo(0.5, 10); // 1-1, one game left
  });

  it('ends with the live game by its legs, matching the card estimate computed directly', () => {
    const steps = outlookTrail(slots, chance, [{ schid: 's1', winner: 0, endedAt: 1 }], { schid: 's2', legs: [2, 0], need: 3 });
    const last = steps[steps.length - 1];
    expect(last.live).toBe(true);
    const direct = cardOutlook([
      { state: 'done', winner: 0 },
      { state: 'live', p: 0.5, legs: [2, 0], need: 3 },
      { state: 'todo', p: 0.5 },
    ]);
    expect(last.outlook.win).toBeCloseTo(direct.win, 10);
  });

  it('marks the decided game that moved the estimate most, ignoring moves under 5 points', () => {
    const steps = outlookTrail(slots, chance, [
      { schid: 's1', winner: 0, endedAt: 1 },
      { schid: 's2', winner: 0, endedAt: 2 },
    ]);
    // 50% → 75% → 100%: both +25; the first such move is kept.
    expect(biggestSwing(steps)).toMatchObject({ index: 1 });
    expect(biggestSwing(outlookTrail(slots, chance, []))).toBeNull();
  });
});
