import { beforeAll, describe, expect, it } from 'vitest';
import type { OrderInput, OrderSolution } from '../domain/types';
import { generateOrder } from './generateOrder';
import { validateHardConstraints } from './constraints/validate';
import { atdoSpec, fixtureLeagues, tdoSpec } from '../test/n01/leagues';
import { playedTeamMatches, replayMatch, type ReplayedMatch } from '../test/n01/replay';
import { PERTURBATIONS, orderBacktestSummary, sensitivity } from '../test/n01/orderBacktest';

/**
 * Optimizer backtest and sensitivity (MASTER SPEC Phase 6 §3–§4), on time-travel replays
 * of the fixture leagues (src/test/n01/replay.ts): every order is made from the data a
 * captain had on the morning of the match, with the players who actually played.
 *
 * What is compared is the model's own estimate for the recommended order against its
 * estimate for the order actually fielded, under the same pre-match information. Actual
 * results cannot be a counterfactual truth — nobody knows what the other order would have
 * scored — so nothing here claims the recommended order "would have won".
 */

let atdo: ReplayedMatch[] = [];
let tdo: ReplayedMatch[] = [];
/** Every replay's candidates, generated once. */
const generated = new Map<OrderInput, OrderSolution[]>();

function run(input: OrderInput, single = false): OrderSolution[] {
  // A single run gets the same time budget as one of the four candidate runs.
  const result = generateOrder(input, single ? { singleCandidate: true, timeLimitMs: Math.floor(input.settings.timeLimitMs / 4) } : {});
  if (!result.ok) throw new Error(`generation failed: ${JSON.stringify(result.diagnostics)}`);
  return result.candidates;
}

function generate(input: OrderInput): OrderSolution[] {
  let candidates = generated.get(input);
  if (!candidates) {
    candidates = run(input);
    generated.set(input, candidates);
  }
  return candidates;
}

beforeAll(async () => {
  const leagues = fixtureLeagues();
  const atdoTargets = playedTeamMatches(leagues.atdo.games, 't_ABvC_5234');
  atdo = await Promise.all(atdoTargets.map((target) => replayMatch(atdoSpec(), leagues.atdo.games, target, 't_ABvC_5234')));
  const tdoTargets = [
    ...playedTeamMatches(leagues.tdo.games, 't_TDtu_7001').map((target) => ({ target, tournamentId: 't_TDtu_7001' })),
    ...playedTeamMatches(leagues.tdo.games, 't_TDth_7002').map((target) => ({ target, tournamentId: 't_TDth_7002' })),
  ];
  tdo = await Promise.all(tdoTargets.map(({ target, tournamentId }) => replayMatch(tdoSpec(), leagues.tdo.games, target, tournamentId)));
}, 60_000);

describe('time-travel replay (no future leakage)', () => {
  it('replays every played match of the running seasons, each from that morning’s data', () => {
    expect(atdo).toHaveLength(32);
    expect(tdo).toHaveLength(8);
    for (const replay of [...atdo, ...tdo]) {
      // The match is still the next match: it has not been played in the replayed data.
      expect(replay.intel.nextMatch?.matchId).toBe(replay.matchId);
      expect(replay.intel.generatedAt).toBe(Date.parse(`${replay.date}T03:00:00Z`));
      expect(replay.order.opponentAvailable).toBe(true);
    }
  });

  it('the stats a replay sees are exactly the games played before that day', () => {
    const full = fixtureLeagues().atdo.games;
    for (const replay of atdo) {
      const earlier = full.filter((game) => game.tournamentId === replay.tournamentId && game.date < replay.date);
      const legsBefore = new Map<string, number>();
      for (const game of earlier) for (const line of game.lines) legsBefore.set(line.opid, (legsBefore.get(line.opid) ?? 0) + line.legs);
      for (const entry of replay.intel.ourStats) {
        const current = entry.seasons.find((season) => season.seasonIndex === 0);
        expect(current?.legs ?? 0).toBe(legsBefore.get(entry.key) ?? 0);
      }
    }
  });
});

describe('optimizer backtest: model-estimated win, recommended vs actually fielded (Phase 6 §3)', () => {
  it('recommends a valid order for every replayed match, deterministically', () => {
    for (const replay of [...atdo, ...tdo]) {
      const candidates = generate(replay.order.input);
      expect(candidates[0].meta.presetKey).toBe('OPPONENT_OPTIMIZED');
      expect(validateHardConstraints(replay.order.input, candidates[0].assignments)).toEqual([]);
      expect(candidates[0].prediction).toBeDefined();
    }
    // Where the search completes, the same input gives the same order.
    const complete = [...atdo, ...tdo].filter((replay) => generate(replay.order.input)[0].meta.exhaustive);
    expect(complete.length).toBeGreaterThan(0);
    for (const replay of complete.slice(0, 3)) {
      expect(run(replay.order.input)[0].assignments).toEqual(generate(replay.order.input)[0].assignments);
    }
  });

  it('on average estimates a higher match win than the order actually fielded, and never far lower', () => {
    const summary = orderBacktestSummary([...atdo, ...tdo], generate);
    // Fairness stays a soft term, so the recommendation may give up a little estimated
    // win to share games — but only a little.
    expect(summary.meanUplift).toBeGreaterThan(0);
    expect(summary.worstUplift).toBeGreaterThan(-0.05);
    expect(summary.meanUpliftOverWinFirst).toBeGreaterThanOrEqual(0);
    for (const row of summary.rows) {
      expect(row.recommended).toBeGreaterThan(0);
      expect(row.recommended).toBeLessThan(1);
      expect(validateHardConstraints(row.input, row.actual)).toEqual([]);
    }
  });

  it('never words an estimate as a certainty', () => {
    // 絶対条件 (hard constraints) is a fine word; claims about winning are not.
    const banned = /絶対勝|確実|必勝|必ず勝/;
    for (const replay of [...atdo, ...tdo]) {
      for (const candidate of generate(replay.order.input)) {
        const texts = [
          ...candidate.warnings.map((warning) => warning.message),
          ...candidate.explanation.overall.map((factor) => `${factor.label} ${factor.detail}`),
          ...candidate.explanation.games.flatMap((game) => game.factors.map((factor) => `${factor.label} ${factor.detail}`)),
          ...(candidate.prediction?.games.flatMap((game) => game.reasons) ?? []),
        ];
        for (const text of texts) expect(text).not.toMatch(banned);
      }
    }
  });
});

// ---------------------------------------------------------------------------
// Sensitivity (Phase 6 §4)
// ---------------------------------------------------------------------------

describe('sensitivity: small parameter changes do not throw the order around (Phase 6 §4)', () => {
  it.each(PERTURBATIONS)('$name: the original order stays within a few points of the new best', (perturbation) => {
    const sample = atdo.filter((replay) => replay.format.games.length === 7).slice(0, 6);
    const result = sensitivity(sample, perturbation, (input) => run(input, true)[0]);
    expect(result.meanRegret).toBeLessThan(0.02);
    expect(result.maxRegret).toBeLessThan(0.06);
    expect(result.meanSeatChange).toBeLessThan(0.5);
  });
});
