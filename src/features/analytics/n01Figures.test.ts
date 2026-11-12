import { describe, expect, it } from 'vitest';
import { parsePlayerStats } from './api/parse';
import { n01Avg1, n01Avg3, n01Break, n01DynamicAvg, n01First9, n01Keep, n01LegDiff, n01Mpr, n01Text, n01WinRateLeg, n01WinRateSet } from './n01Figures';
import { line } from './testFixtures';

// A real row of `player_stats_list` (ATDO 2026 3rd, read 2026-11-12; the checkout record `co` left out).
const REAL = {
  result: 0,
  stats: {
    awzo: { score: 14279, darts: 554, winLeg: 30, leg: 35, a_b: 15, w_b: 11, winMatch: 0, match: 5, winSet: 15, set: 15, ton00: 41, ton40: 17, ton70: 0, ton80: 4, highOut: 105, highOutCount: 1, best: 14, worst: 23, f9Score: 7633, f9Darts: 252, a: 0, acnt: 0, ca: 0, cacnt: 0, tpid: 'RrVa', r_g: 1, opid: '02-0051', oname: '馬場 善久', hc: 0, ho: 1 },
  },
};

describe("n01's stats page figures", () => {
  const row = parsePlayerStats(REAL)[0];

  it('a real row prints what n01 prints', () => {
    expect(n01Text(n01Avg3(row.line), 'avg')).toBe('77.32');
    expect(n01Text(n01Avg1(row.line), 'avg')).toBe('25.77');
    expect(n01Text(n01First9(row.line), 'avg')).toBe('90.87');
    expect(n01Text(n01LegDiff(row.line), 'count')).toBe('25');
    expect(n01Text(n01WinRateLeg(row.line), 'rate')).toBe('85.71%');
    expect(n01Text(n01WinRateSet(row.line), 'rate')).toBe('100.00%');
    expect(n01Text(n01Keep(row.line), 'rate')).toBe('95.00%'); // (30 − 11) / (35 − 15)
    expect(n01Text(n01Break(row.line), 'rate')).toBe('73.33%'); // 11 / 15
    // 140+ is n01's own 140-169 bucket (ton40); 170+ and 180 are columns of their own.
    expect([row.line.ton00, row.line.ton40, row.line.ton70, row.line.ton80]).toEqual([41, 17, 0, 4]);
    expect(row.line.n01).toMatchObject({ worstLeg: 23, highOutCount: 1, has01: true, hasCricket: false });
  });

  it('blends hand-entered averages in as n01 does', () => {
    // 300 points in 30 darts = 30.00, plus one entered average of 60 → (30 + 60) / (1 + 1).
    const extras = { worstLeg: null, highOutCount: null, manualAvg: 60, manualAvgCount: 1, has01: true, hasCricket: false, cricketLegs: null, cricketDarts: null, cricketMarks: null, manualMpr: null, manualMprCount: null, mark9: null, mark8: null, mark7: null, mark6: null };
    expect(n01Avg3(line({ score: 300, darts: 30, n01: extras }))).toBe(45);
    // Only entered averages: their mean (120 over 2 entries).
    expect(n01Avg3(line({ n01: { ...extras, manualAvg: 120, manualAvgCount: 2 } }))).toBe(60);
    expect(n01DynamicAvg(line({ score: 300, darts: 30, winMatch: 2 }))).toBe(12); // 10.00 + 2
    // MPR: 25 marks in 30 darts = 2.5; with one entered MPR of 3.5 → (2.5 + 3.5) / (1 + 1).
    const cricket = { ...extras, cricketLegs: 1, cricketDarts: 30, cricketMarks: 25 };
    expect(n01Mpr(line({ n01: cricket }))).toBe(2.5);
    expect(n01Mpr(line({ n01: { ...cricket, manualMpr: 3.5, manualMprCount: 1 } }))).toBe(3);
  });

  it('nothing to compute from: n01 prints 0 / 0.00 / 0.00%', () => {
    const empty = line({ leg: 4, winLeg: 1, breakLegs: 0, breakWins: 0 });
    expect(n01Text(n01Avg3(empty), 'avg')).toBe('0.00');
    expect(n01Text(n01Break(empty), 'rate')).toBe('0.00%');
    expect(n01Text(n01Keep(empty), 'rate')).toBe('0.00%'); // n01 needs a leg thrown second for Keep too
    expect(n01Text(null, 'count')).toBe('0');
  });
});
