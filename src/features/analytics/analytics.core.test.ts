import { describe, expect, it } from 'vitest';
import { AnalyticsSchemaError, parsePlayerStats, parseStandings, parseTeamStats } from './api/parse';
import { aggregateLines, MIN_SAMPLE, pairOf, reliabilityOf } from './metrics';
import { pooledAverage, rankBestLeg, rankCandidates, rankMetric } from './ranking';
import { classifySeason, formatSignature, selectSeasons } from './seasons';
import { line, simpleLine, tournament } from './testFixtures';
import type { SeasonCandidate } from './seasons';
import type { N01TournamentSummary } from '../../integrations/n01/types';

// Rows copied from the real ATDO 2026 3rd responses (2026-10-09).
const TEAM_KALAVINKA = {
  score: 20101, darts: 1195, winLeg: 14, leg: 45, a_b: 24, w_b: 7, winMatch: 0, match: 2, winSet: 2, set: 14,
  ton00: 20, ton40: 6, ton70: 0, ton80: 2, highOut: 89, best: 19, f9Score: 6270, f9Darts: 405, r_g: 1,
};
const PLAYER_HASHIMOTO = {
  score: 5005, darts: 293, winLeg: 6, leg: 15, a_b: 8, w_b: 2, winMatch: 0, match: 2, winSet: 2, set: 6,
  ton00: 8, ton40: 2, ton70: 0, ton80: 1, highOut: 40, best: 26, f9Score: 1373, f9Darts: 93, tpid: 'GpiQ', r_g: 1, opid: '02-0035', oname: '橋本千尋',
};

describe('parse: live shapes', () => {
  it('team stats are keyed by tpid and keep every counter', () => {
    const [row] = parseTeamStats({ result: 0, kind: 'stats_list', stats: { GpiQ: TEAM_KALAVINKA } });
    expect(row.teamId).toBe('GpiQ');
    expect(row.divisionIndex).toBe(1);
    expect(row.line).toMatchObject({ score: 20101, darts: 1195, breakLegs: 24, breakWins: 7, f9Score: 6270, bestLeg: 19, highOut: 89 });
  });

  it('player stats are keyed by oid, carry opid / name / team', () => {
    const [row] = parsePlayerStats({ result: 0, stats: { uByO: PLAYER_HASHIMOTO } });
    expect(row).toMatchObject({ oid: 'uByO', opid: '02-0035', teamId: 'GpiQ', name: '橋本千尋' });
    expect(row.line.winMatch).toBe(0);
  });

  it('0 High Finish / Best Leg means "no record" (null), and an empty opid is null', () => {
    const [row] = parsePlayerStats({ stats: { x: { ...PLAYER_HASHIMOTO, highOut: 0, best: 0, opid: '' } } });
    expect(row.line.highOut).toBeNull();
    expect(row.line.bestLeg).toBeNull();
    expect(row.opid).toBeNull();
  });

  it('absent counters are null, never 0', () => {
    const [row] = parseTeamStats({ stats: { t1: { score: 100, darts: 30 } } });
    expect(row.line.f9Darts).toBeNull();
    expect(row.line.leg).toBeNull();
    expect(row.line.ton80).toBeNull();
  });

  it('an empty stats container is "no stats yet"; a missing container is a schema error', () => {
    expect(parseTeamStats({ result: 0, stats: {} })).toEqual([]);
    expect(() => parseTeamStats({ result: 0 })).toThrow(AnalyticsSchemaError);
    expect(() => parsePlayerStats({ result: -1, error: 'nope' })).toThrow(AnalyticsSchemaError);
  });

  it('standings: lg groups only, rank 0 kept as 0, ties kept as given', () => {
    const groups = parseStandings({
      result: 0,
      groups: [
        { kind: 'rr', index: 0, title: 'x', players: [] },
        {
          kind: 'lg', index: 2, title: 'Cディビジョン',
          players: [
            { tpid: 'UOBW', name: '雷', rank: 1, p: 2, w: 2, d: 0, l: 0, pts: 12 },
            { tpid: 'a', name: 'a', rank: 2, p: 2, w: 1, d: 0, l: 1, pts: 9 },
            { tpid: 'b', name: 'b', rank: 2, p: 2, w: 1, d: 0, l: 1, pts: 9 },
            { tpid: 'c', name: 'c', rank: 0, p: 0, w: 0, d: 0, l: 0, pts: 0 },
          ],
        },
      ],
    });
    expect(groups).toHaveLength(1);
    expect(groups[0].divisionIndex).toBe(2);
    expect(groups[0].rows.map((r) => r.rank)).toEqual([1, 2, 2, 0]);
    expect(() => parseStandings({ result: 0 })).toThrow(AnalyticsSchemaError);
  });
});

describe('metrics', () => {
  it('reproduces the design examples: kalavinka and hashimoto', () => {
    const team = aggregateLines([parseTeamStats({ stats: { GpiQ: TEAM_KALAVINKA } })[0].line]);
    expect(team.ppr.value!).toBeCloseTo(50.46, 2);
    expect(team.first9.value!).toBeCloseTo(46.44, 2);
    expect(team.legRate.value! * 100).toBeCloseTo(31.11, 2);
    const player = aggregateLines([parsePlayerStats({ stats: { uByO: PLAYER_HASHIMOTO } })[0].line]);
    expect(player.ppr.value!).toBeCloseTo(51.25, 2);
    expect(player.first9.value!).toBeCloseTo(44.29, 2);
    expect(player.legRate.value! * 100).toBeCloseTo(40, 5);
    // Break = 2/8, Keep = (6-2)/(15-8)
    expect(player.break.value).toBeCloseTo(0.25, 6);
    expect(player.keep.value).toBeCloseTo(4 / 7, 6);
  });

  it('pools numerators and denominators — not the mean of the seasons\' averages', () => {
    const a = simpleLine(900, 90, 1, 2); // 30.00
    const b = simpleLine(2400, 300, 5, 10); // 24.00
    const pooled = aggregateLines([a, b]);
    expect(pooled.ppr.value).toBeCloseTo((3 * 3300) / 390, 10);
    expect(pooled.ppr.value).not.toBeCloseTo((30 + 24) / 2, 3);
    expect(pooled.legRate).toMatchObject({ num: 6, den: 12, value: 0.5 });
  });

  it('a season without a usable denominator adds nothing (it is not a 0)', () => {
    const played = simpleLine(900, 90, 1, 2);
    const unmeasured = line({ score: 0, darts: 0, leg: 0, winLeg: 0 });
    const pooled = aggregateLines([played, unmeasured]);
    expect(pooled.ppr.den).toBe(90);
    expect(pooled.ppr.value).toBeCloseTo(30, 10);
    expect(aggregateLines([unmeasured]).ppr.value).toBeNull();
    expect(aggregateLines([]).ppr.value).toBeNull();
  });

  it('0 and missing are different: 0 wins of 10 legs is 0%, missing legs is null', () => {
    expect(pairOf('legRate', line({ winLeg: 0, leg: 10 }))).toEqual({ num: 0, den: 10 });
    expect(pairOf('legRate', line({ winLeg: 0, leg: null }))).toBeNull();
    expect(aggregateLines([line({ winLeg: 0, leg: 10 })]).legRate.value).toBe(0);
  });

  it('rejects impossible numerators (more wins than played) instead of rating them', () => {
    expect(pairOf('legRate', line({ winLeg: 12, leg: 10 }))).toBeNull();
    expect(pairOf('keep', line({ winLeg: 3, leg: 10, breakWins: 4, breakLegs: 5 }))).toBeNull();
  });

  it('High Finish is the max and Best Leg the min of recorded values; unrecorded ones are ignored', () => {
    const m = aggregateLines([line({ highOut: 90, bestLeg: 19 }), line({ highOut: 120, bestLeg: 17 }), line({ highOut: null, bestLeg: null })]);
    expect(m.extremes).toEqual({ highOut: 120, bestLeg: 17 });
    expect(aggregateLines([line({})]).extremes).toEqual({ highOut: null, bestLeg: null });
  });

  it('counts sum only reported values; all-missing stays null', () => {
    const m = aggregateLines([line({ ton80: 2 }), line({ ton80: 1 }), line({})]);
    expect(m.counts.ton80).toBe(3);
    expect(m.counts.ton40).toBeNull();
  });

  it('reliability follows the provisional thresholds', () => {
    expect(reliabilityOf('ppr', { num: 0, den: 0, value: null })).toBe('none');
    expect(reliabilityOf('ppr', { num: 270, den: MIN_SAMPLE.ppr - 1, value: 3 })).toBe('reference');
    expect(reliabilityOf('ppr', { num: 270, den: MIN_SAMPLE.ppr, value: 3 })).toBe('sufficient');
  });
});

describe('ranking', () => {
  const c = (id: string, value: number | null, sample: number) => ({ id, label: id, value, sample });

  it('gives tied values one rank and skips the next (1,2,2,4)', () => {
    const r = rankCandidates([c('a', 0.9, 30), c('b', 0.5, 30), c('c', 0.5, 30), c('d', 0.4, 30)], { minSample: 20 });
    expect(r.ranked.map((e) => [e.id, e.rank])).toEqual([['a', 1], ['b', 2], ['c', 2], ['d', 4]]);
    expect(r.population).toBe(4);
  });

  it('keeps small samples out of the ranking as reference, and no-data apart from both', () => {
    const r = rankCandidates([c('a', 0.9, 30), c('small', 1, 5), c('none', null, 0)], { minSample: 20 });
    expect(r.ranked.map((e) => e.id)).toEqual(['a']);
    expect(r.reference.map((e) => e.id)).toEqual(['small']);
    expect(r.reference[0].rank).toBeNull();
    expect(r.noData.map((e) => e.id)).toEqual(['none']);
    expect(r.excluded).toBe(2);
  });

  it('is deterministic for equal values (label then id)', () => {
    const r1 = rankCandidates([c('z', 1, 30), c('y', 1, 30)], { minSample: 1 });
    const r2 = rankCandidates([c('y', 1, 30), c('z', 1, 30)], { minSample: 1 });
    expect(r1.ranked.map((e) => e.id)).toEqual(['y', 'z']);
    expect(r2.ranked.map((e) => e.id)).toEqual(r1.ranked.map((e) => e.id));
  });

  it('ranks metrics by their own thresholds', () => {
    const items = [
      { id: 'a', metrics: aggregateLines([simpleLine(3000, 300, 10, 20)]) },
      { id: 'b', metrics: aggregateLines([simpleLine(3600, 300, 4, 10)]) }, // leg sample 10 < 20
    ];
    const ppr = rankMetric(items, 'ppr', (i) => i.id, (i) => i.id);
    expect(ppr.ranked.map((e) => e.id)).toEqual(['b', 'a']);
    const leg = rankMetric(items, 'legRate', (i) => i.id, (i) => i.id);
    expect(leg.ranked.map((e) => e.id)).toEqual(['a']);
    expect(leg.reference.map((e) => e.id)).toEqual(['b']);
  });

  it('Best Leg: fewer darts is better, unrecorded is no data (not the best)', () => {
    const items = [
      { id: 'fast', metrics: aggregateLines([line({ bestLeg: 15 })]) },
      { id: 'slow', metrics: aggregateLines([line({ bestLeg: 24 })]) },
      { id: 'zero', metrics: aggregateLines([line({ bestLeg: 0 })]) },
    ];
    const r = rankBestLeg(items, (i) => i.id, (i) => i.id);
    expect(r.ranked.map((e) => e.id)).toEqual(['fast', 'slow']);
    expect(r.noData.map((e) => e.id)).toEqual(['zero']);
  });

  it('pooledAverage is Σnum / Σden and skips empty denominators', () => {
    const avg = pooledAverage([
      { num: 90, den: 30, value: 3 },
      { num: 10, den: 10, value: 1 },
      { num: 0, den: 0, value: null },
    ]);
    expect(avg.value).toBe(2.5);
  });
});

describe('seasons', () => {
  const summary = (id: string, startedAt: number, status = 40, title = id): N01TournamentSummary => ({ tournamentId: id, title, status, startedAt, listIndex: 0 });
  const league = (s: N01TournamentSummary): SeasonCandidate => ({ summary: s, classification: { kind: 'league', reason: '' } });
  const list = [summary('s4', 4000, 30), summary('s3', 3000), summary('s2', 2000), summary('s1', 1000)];

  it('classifies championships, tests and unstarted events out; the title never includes', () => {
    expect(classifySeason({ title: '2025 イヤーズチャンピオンシップ', status: 40 }).kind).toBe('excluded');
    expect(classifySeason({ title: 'テスト大会', status: 40 }).kind).toBe('excluded');
    expect(classifySeason({ title: '2026 3rd', status: 20 }).kind).toBe('excluded');
    expect(classifySeason({ title: '2026 3rd', status: 40 }).kind).toBe('unknown');
    const t = tournament('x', [{ id: 'a', name: 'A' }]);
    expect(classifySeason({ title: '2026 3rd', status: 40 }, t).kind).toBe('league');
    expect(classifySeason({ title: '2026 3rd', status: 40 }, { ...t, divisions: [] }).kind).toBe('unknown');
  });

  it('current / specified pick one season; a non-league one is refused with the reason', () => {
    const cands = [...list.map(league), { summary: summary('x', 5000, 40, 'チャンピオンシップ'), classification: { kind: 'excluded', reason: '除外' } } as SeasonCandidate];
    expect(selectSeasons(cands, { mode: 'current', currentTournamentId: 's4' }).seasons.map((s) => s.tournamentId)).toEqual(['s4']);
    expect(selectSeasons(cands, { mode: 'specified', currentTournamentId: 's4', specifiedTournamentId: 's2' }).seasons.map((s) => s.tournamentId)).toEqual(['s2']);
    const refused = selectSeasons(cands, { mode: 'specified', currentTournamentId: 's4', specifiedTournamentId: 'x' });
    expect(refused.seasons).toEqual([]);
    expect(refused.complete).toBe(false);
    expect(refused.skipped[0].reason).toBe('除外');
  });

  it('last3 = anchor + two earlier eligible seasons, skipping excluded ones', () => {
    const cands = [league(list[0]), { summary: summary('mid', 3500, 40, 'テスト'), classification: { kind: 'excluded', reason: 'test' } } as SeasonCandidate, ...list.slice(1).map(league)];
    const sel = selectSeasons(cands, { mode: 'last3', currentTournamentId: 's4' });
    expect(sel.seasons.map((s) => s.tournamentId)).toEqual(['s4', 's3', 's2']);
    expect(sel.skipped.map((s) => s.tournamentId)).toEqual(['mid']);
    expect(sel.complete).toBe(true);
  });

  it('an unclassified season makes the period incomplete rather than silently eligible', () => {
    const cands = [league(list[0]), { summary: list[1], classification: { kind: 'unknown', reason: '未取得' } } as SeasonCandidate, league(list[2])];
    const sel = selectSeasons(cands, { mode: 'all', currentTournamentId: 's4' });
    expect(sel.seasons.map((s) => s.tournamentId)).toEqual(['s4', 's2']);
    expect(sel.complete).toBe(false);
  });

  it('all is capped, and a cut makes it incomplete', () => {
    const cands = list.map(league);
    expect(selectSeasons(cands, { mode: 'all', currentTournamentId: 's4' }).complete).toBe(true);
    const capped = selectSeasons(cands, { mode: 'all', currentTournamentId: 's4' }, { maxSeasons: 2 });
    expect(capped.seasons).toHaveLength(2);
    expect(capped.complete).toBe(false);
  });

  it('format signature differs by start score, legs and division overrides', () => {
    const a = tournament('a', [{ id: 't', name: 'T' }]);
    expect(formatSignature(a)).toBe(formatSignature(tournament('b', [{ id: 't', name: 'T' }])));
    expect(formatSignature(a)).not.toBe(formatSignature(tournament('c', [{ id: 't', name: 'T' }], { startScore: 701 })));
    expect(formatSignature(a)).not.toBe(formatSignature(tournament('d', [{ id: 't', name: 'T' }], { legs: 3 })));
    expect(formatSignature(a)).not.toBe(formatSignature({ ...a, gameSettings: [{ round: 0, schedule: a.schedule }] }));
  });
});
