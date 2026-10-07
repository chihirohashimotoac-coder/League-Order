import { describe, expect, it } from 'vitest';
import {
  evaluateFairness,
  excessToPenalty,
  fairnessScore,
  minimalSsd,
  minimalSsdFast,
  minimalSsdReference,
  sumSquaredDeviation,
  waterfill,
} from './fairness';

describe('waterfill', () => {
  it('splits evenly when the slots divide by the player count', () => {
    expect(waterfill([0, 0, 0, 0, 0], 10)).toEqual([2, 2, 2, 2, 2]);
  });

  it('produces a spread of exactly 1 when the slots do not divide evenly', () => {
    const counts = waterfill([0, 0, 0, 0, 0], 11);
    expect(counts.reduce((a, b) => a + b, 0)).toBe(11);
    expect(Math.max(...counts) - Math.min(...counts)).toBe(1);
    expect([...counts].sort((a, b) => b - a)).toEqual([3, 2, 2, 2, 2]);
  });

  it('levels up existing season baselines first', () => {
    expect(waterfill([5, 1, 1], 6)).toEqual([0, 3, 3]);
  });
});

describe('minimalSsd', () => {
  it('agrees with the unit-by-unit reference implementation', () => {
    // Deterministic sweep rather than random sampling, so a failure is reproducible.
    for (let n = 1; n <= 7; n += 1) {
      for (let total = 0; total <= 14; total += 1) {
        for (let pattern = 0; pattern < 1 << n; pattern += 1) {
          const baselines = Array.from({ length: n }, (_, i) => ((pattern >> i) & 1) * 3 + (i % 2));
          expect(minimalSsd(baselines, total)).toBeCloseTo(
            minimalSsdReference(baselines, total),
            10,
          );
        }
      }
    }
  });

  it('is zero when the distribution can be perfectly even', () => {
    expect(minimalSsd([0, 0, 0, 0, 0], 10)).toBeCloseTo(0, 10);
  });

  it('matches the r(N-r)/N closed form for flat baselines', () => {
    for (const n of [3, 5, 8]) {
      for (let total = 0; total <= 3 * n; total += 1) {
        const r = total % n;
        expect(minimalSsd(new Array(n).fill(0), total)).toBeCloseTo((r * (n - r)) / n, 10);
      }
    }
  });
});

describe('evaluateFairness', () => {
  it('scores a perfectly even distribution as 1', () => {
    const result = evaluateFairness([0, 0, 0, 0, 0], [2, 2, 2, 2, 2]);
    expect(result.excess).toBeCloseTo(0, 10);
    expect(result.score).toBeCloseTo(1, 10);
    expect(result.spread).toBe(0);
  });

  it('scores the best possible 11-slot split as 1 even though the spread is 1', () => {
    const result = evaluateFairness([0, 0, 0, 0, 0], [3, 2, 2, 2, 2]);
    expect(result.excess).toBeCloseTo(0, 10);
    expect(result.score).toBeCloseTo(1, 10);
    expect(result.spread).toBe(1);
  });

  it('distinguishes two distributions that share the same max spread', () => {
    const better = evaluateFairness([0, 0, 0, 0, 0], [3, 2, 2, 2, 2]);
    const worse = evaluateFairness([0, 0, 0, 0, 0], [3, 3, 2, 2, 1]);
    expect(better.spread).toBe(1);
    expect(worse.spread).toBe(2);
    expect(better.score).toBeGreaterThan(worse.score);
  });

  it('penalises an uneven split monotonically', () => {
    const even = evaluateFairness([0, 0, 0, 0, 0], [2, 2, 2, 2, 2]);
    const off = evaluateFairness([0, 0, 0, 0, 0], [3, 2, 2, 2, 1]);
    const worse = evaluateFairness([0, 0, 0, 0, 0], [4, 2, 2, 1, 1]);
    expect(even.score).toBeGreaterThan(off.score);
    expect(off.score).toBeGreaterThan(worse.score);
  });

  it('folds season baselines in so a player who has played more gets fewer slots', () => {
    const favourNewcomer = evaluateFairness([6, 0, 0], [0, 3, 3]);
    const favourVeteran = evaluateFairness([6, 0, 0], [3, 3, 0]);
    expect(favourNewcomer.score).toBeGreaterThan(favourVeteran.score);
  });
});

describe('excessToPenalty', () => {
  it('is 0 at the ideal and increases monotonically', () => {
    expect(excessToPenalty(0)).toBe(0);
    expect(excessToPenalty(2)).toBeCloseTo(0.5, 10);
    expect(excessToPenalty(6)).toBeGreaterThan(excessToPenalty(2));
    expect(excessToPenalty(-5)).toBe(0);
  });
});

describe('sumSquaredDeviation', () => {
  it('is 0 for a constant list', () => {
    expect(sumSquaredDeviation([3, 3, 3])).toBeCloseTo(0, 10);
  });
});

describe('fairnessScore (D-21)', () => {
  it('is exactly 1 at the arithmetic optimum and strictly decreasing', () => {
    expect(fairnessScore(0, 10)).toBe(1);
    let previous = 1;
    for (let excess = 2; excess <= 40; excess += 2) {
      const value = fairnessScore(excess, 10);
      expect(value).toBeLessThan(previous);
      expect(value).toBeGreaterThanOrEqual(0);
      previous = value;
    }
  });

  it('keeps charging for further imbalance instead of saturating', () => {
    // The old curve 1/(1+e/2) lost 0.5 on the first step and only ~0.1 more for the next
    // three; the linear part keeps a meaningful price on every further step.
    const step = (from: number, to: number) => fairnessScore(from, 10) - fairnessScore(to, 10);
    expect(step(10, 20)).toBeGreaterThan(0.2);
    expect(step(0, 2)).toBeLessThan(0.5);
  });
});

describe('minimalSsdFast', () => {
  it('matches the reference implementation on a deterministic grid', () => {
    const scratch = new Float64Array(8);
    for (let seed = 1; seed <= 300; seed += 1) {
      const n = 1 + (seed % 8);
      const baselines = Array.from({ length: n }, (_, i) => ((seed * 7 + i * 13) % 6) + (i % 2));
      const total = (seed * 5) % 17;
      const fast = minimalSsdFast(baselines, total, scratch.subarray(0, n));
      expect(fast).toBeCloseTo(minimalSsdReference(baselines, total), 9);
      expect(fast).toBeCloseTo(minimalSsd(baselines, total), 9);
    }
  });

  it('accepts typed arrays and a total of 0', () => {
    const scratch = new Float64Array(4);
    expect(minimalSsdFast(new Int32Array([1, 2, 3, 6]), 0, scratch)).toBeCloseTo(sumSquaredDeviation([1, 2, 3, 6]), 10);
  });
});
