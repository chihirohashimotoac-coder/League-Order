/**
 * Retrospective check of the live leg estimate (`legChance`, the 参考予測 on the live sheet)
 * against finished public n01 games (`npm run validate:live-estimate -- --tdid <id> --games 60`).
 *
 * For every visit of every finished, throw-decided 01 leg it rebuilds what the live sheet knew
 * just before that visit — the points left, who throws, and the game's averages from the throws
 * before it (earlier legs and this leg so far) — asks the model for side 0's chance of taking the
 * leg, and compares it with who did. Nothing after the visit is used (no leakage), and the model
 * has no parameter fitted to data: its constants are fixed in `checkout.ts`, so there is no
 * training period to keep apart from the test period.
 *
 * `--raw` checks the model before recalibration (`rawLegChance`, what LEG_CALIBRATION was
 * fitted on); `--out <file>` writes every prediction for re-fitting offline.
 *
 * Reported: predictions, legs, games; Brier score (and the 0.25 of always saying 50 %); the
 * Brier of the first visit of each leg only; calibration in ten bins (mean predicted vs observed,
 * count). The game estimate is not checked (`limit_leg` is not in the game list).
 *
 * Read-only anonymous GETs through the app's own adapter: one `match/list` page per 100 games
 * of the season, then one `match/throws` per sampled game, one at a time.
 */
import { realpathSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describeN01Error } from '../src/integrations/n01/client';
import { MatchesApi } from '../src/features/matches/api';
import type { LiveThrow, ThrowLeg } from '../src/features/matches/parse';
import { gameStats } from '../src/features/matches/gameStats';
import { legChance, rawLegChance, shrunkAverage } from '../src/features/matches/checkout';

type Visit = Extract<LiveThrow, { kind: '01' }>;

export interface Prediction {
  p: number;
  won: boolean;
  firstOfLeg: boolean;
}

/** Every prediction the live sheet would have shown for one finished game. */
export function predictionsOf(legs: readonly ThrowLeg[], model: typeof legChance = legChance): Prediction[] {
  const out: Prediction[] = [];
  const played: ThrowLeg[] = [];
  for (const leg of [...legs].sort((a, b) => a.index - b.index)) {
    const visits = leg.throws.filter((entry): entry is Visit => entry.kind === '01');
    const decided = leg.ended && (leg.winner === 0 || leg.winner === 1) && !leg.bull;
    if (decided && leg.start && visits.length > 0) {
      const left: [number, number] = [leg.start[0], leg.start[1]];
      visits.forEach((visit, k) => {
        const sofar: ThrowLeg = { ...leg, ended: false, winner: null, throws: visits.slice(0, k), dartsTotal: null };
        const stats = gameStats([...played, sofar], false);
        const average: [number, number] = [shrunkAverage(stats[0].rate, stats[0].darts), shrunkAverage(stats[1].rate, stats[1].darts)];
        out.push({ p: model([left[0], left[1]], average, visit.side), won: leg.winner === 0, firstOfLeg: k === 0 });
        left[visit.side] = visit.left;
      });
    }
    played.push(leg);
  }
  return out;
}

export function brier(predictions: readonly Prediction[]): number | null {
  if (predictions.length === 0) return null;
  return predictions.reduce((sum, entry) => sum + (entry.p - (entry.won ? 1 : 0)) ** 2, 0) / predictions.length;
}

export function calibration(predictions: readonly Prediction[], bins = 10): { from: number; to: number; n: number; predicted: number | null; observed: number | null }[] {
  return Array.from({ length: bins }, (_, i) => {
    const from = i / bins;
    const to = (i + 1) / bins;
    const inBin = predictions.filter((entry) => entry.p >= from && (entry.p < to || (i === bins - 1 && entry.p <= 1)));
    return {
      from,
      to,
      n: inBin.length,
      predicted: inBin.length ? inBin.reduce((sum, entry) => sum + entry.p, 0) / inBin.length : null,
      observed: inBin.length ? inBin.filter((entry) => entry.won).length / inBin.length : null,
    };
  });
}

function arg(name: string, fallback: string): string {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
}

async function main(): Promise<number> {
  const tdid = arg('tdid', 't_yyGi_9918');
  const limit = Math.max(1, Number(arg('games', '60')));
  const api = new MatchesApi({ maxRequests: limit + 20 });
  try {
    const season = await api.seasonGames(tdid);
    const finished01 = season.games.filter((game) => game.finished && game.matchType === '01');
    // Spread the sample over the season rather than taking its first night only.
    const step = Math.max(1, Math.floor(finished01.length / limit));
    const sample = finished01.filter((_, i) => i % step === 0).slice(0, limit);
    const all: Prediction[] = [];
    let legs = 0;
    let read = 0;
    for (const game of sample) {
      const reply = await api.throws(game.mid, null, { finished: true });
      read += 1;
      legs += reply.legs.filter((leg) => leg.ended && !leg.bull && (leg.winner === 0 || leg.winner === 1)).length;
      all.push(...predictionsOf(reply.legs, process.argv.includes('--raw') ? rawLegChance : legChance));
    }
    const first = all.filter((entry) => entry.firstOfLeg);
    console.log(`season ${tdid}: ${finished01.length} finished 01 games, ${read} sampled (every ${step}th), ${legs} throw-decided legs`);
    console.log(`predictions (one per visit): ${all.length}  Brier ${brier(all)?.toFixed(4) ?? '—'}  (always 50 %: 0.2500)`);
    console.log(`first visit of each leg:      ${first.length}  Brier ${brier(first)?.toFixed(4) ?? '—'}`);
    console.log('calibration (predicted chance of side 0 → observed share of legs side 0 won):');
    for (const bin of calibration(all)) {
      console.log(`  ${bin.from.toFixed(1)}–${bin.to.toFixed(1)}  n=${String(bin.n).padStart(5)}  predicted ${bin.predicted?.toFixed(3) ?? '  —  '}  observed ${bin.observed?.toFixed(3) ?? '  —  '}`);
    }
    console.log(`legs won by side 0: ${(all.filter((e) => e.firstOfLeg && e.won).length / Math.max(1, first.length)).toFixed(3)}`);
    console.log(`requests: ${api.requestCount + api.pollCount}`);
    const out = arg('out', '');
    if (out) writeFileSync(out, JSON.stringify({ tdid, games: read, legs, predictions: all }));
    return 0;
  } catch (error) {
    console.error(`n01 could not be read: ${describeN01Error(error)}`);
    return 2;
  }
}

if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
  main().then((code) => process.exit(code));
}
