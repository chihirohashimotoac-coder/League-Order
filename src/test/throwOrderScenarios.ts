import type { GameSlotDef, OrderInput, Player } from '../domain/types';
import type { ConfidenceLevel } from '../domain/prediction/confidence';
import type { OpponentContext, OpponentGameContext, OpponentSideMember } from '../domain/prediction/opponentContext';
import { estimateFinish, finishPrior } from '../domain/prediction/finishing';
import { THROW_ORDER_MODEL_VERSION } from '../domain/prediction/throwOrder';
import { DEFAULT_OPTIMIZER_SETTINGS, PRESETS } from '../domain/orders/presets';
import { createParticipantConfig } from '../domain/orders/participants';

/**
 * Seeded synthetic scenarios for the throw-order and underdog backtests (test-only).
 *
 * Invented teams, drawn from a fixed PRNG so every run is identical. They exercise the decision
 * rules across many inputs; they are not real teams and say nothing about real-world results.
 */

export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const TEAM = 'synthetic';

function person(id: string, ppr: number): Player {
  return { id, teamId: TEAM, name: id, rating: null, ppr, skills: {}, seasonAppearances: 0, seasonAppearancesByKind: {}, archived: false, createdAt: 0 };
}

function baseInput(players: Player[], games: GameSlotDef[], opponent: OpponentContext, settings: Partial<OrderInput['settings']> = {}): OrderInput {
  return {
    teamId: TEAM,
    formatId: 'synthetic',
    games,
    players,
    participants: players.map((p) => createParticipantConfig(p.id)),
    pairs: [],
    locks: [],
    preset: 'OPPONENT_OPTIMIZED',
    weights: { ...PRESETS.OPPONENT_OPTIMIZED.weights },
    settings: { ...DEFAULT_OPTIMIZER_SETTINGS, ...settings },
    discipline: 'STEEL',
    opponent,
    throwOrderModel: THROW_ORDER_MODEL_VERSION,
  };
}

export interface ThrowOrderCase {
  input: OrderInput;
  /** The same case with the opponent's members in reverse throwing order. */
  reversed: OrderInput;
  confidence: ConfidenceLevel;
  orderKnown: boolean;
  /** True when the members' First 9 excess was drawn from the extreme range. */
  extreme: boolean;
}

/**
 * One game (Doubles or Trios) with exactly its members: the order is the only choice. Finishing
 * evidence (First 9 excess) is realistic (±8 points) in most cases and extreme (±18) in some.
 */
export function throwOrderCases(count: number, seed = 20261012): ThrowOrderCase[] {
  const rng = mulberry32(seed);
  const pick = <T,>(items: readonly T[]): T => items[Math.floor(rng() * items.length)];
  const cases: ThrowOrderCase[] = [];
  for (let n = 0; n < count; n += 1) {
    const k = pick([2, 3]);
    const extreme = rng() < 0.25;
    const range = extreme ? 18 : 8;
    const confidence = pick<ConfidenceLevel>(['HIGH', 'HIGH', 'MEDIUM', 'LOW']);
    const legs = confidence === 'HIGH' ? 60 : confidence === 'MEDIUM' ? 20 : 6;
    const orderKnown = rng() < 0.8;
    const strengths = Array.from({ length: k }, () => Math.round(42 + rng() * 28));
    const excess = Array.from({ length: k }, () => Math.round((rng() * 2 - 1) * range * 10) / 10);
    const opp = Array.from({ length: k }, () => Math.round(42 + rng() * 28));
    const oppExcess = Array.from({ length: k }, () => Math.round((rng() * 2 - 1) * range * 10) / 10);
    const members: OpponentSideMember[] = opp.map((s, i) => ({ strength: s, finish: Math.round(estimateFinish(s, oppExcess[i], 60, 'STEEL').rate * 1e4) / 1e4 }));
    const players = strengths.map((s, i) => person(`c${n}_${i}`, s));
    const game: GameSlotDef = {
      id: 'g',
      order: 1,
      name: k === 2 ? 'Doubles 501' : 'Trios 701',
      kinds: [k === 2 ? 'DOUBLES' : 'TRIOS', 'G501'],
      playerCount: k,
      n01: { schid: 'g', numPart: k, matchType: '01', startScore: k === 2 ? 501 : 701, limitLegCount: pick([2, 3]), group: null, subtitle: null },
    };
    const context = (ordered: OpponentSideMember[]): OpponentContext => ({
      version: 2,
      generatedAt: 0,
      matchId: `c${n}`,
      matchDate: '2026-10-20',
      opponentName: 'synthetic',
      leagueMeanPpr: 55,
      players: Object.fromEntries(
        players.map((p, i) => [p.id, { strength: strengths[i], confidence: 'HIGH', legs, imputed: false, formAdjustment: 0, first9Adjustment: 0, first9Excess: excess[i] }]),
      ),
      games: {
        g: {
          gameId: 'g',
          signature: 'g',
          numPart: k,
          legsToWin: game.n01!.limitLegCount,
          cricket: false,
          sides: [{ strength: ordered.reduce((a, m) => a + m.strength, 0) / k, probability: 1, members: ordered }],
          likely: [],
          samples: 8,
          confidence,
          startScore: game.n01!.startScore,
          order: { known: orderKnown, confidence: orderKnown ? confidence : 'LOW', samples: orderKnown ? 8 : 0, leaders: [] },
        } as OpponentGameContext,
      },
      orderConfidence: confidence,
      confidence,
      discipline: 'STEEL',
    });
    cases.push({
      input: baseInput(players, [game], context(members)),
      reversed: baseInput(players, [game], context([...members].reverse())),
      confidence,
      orderKnown,
      extreme,
    });
  }
  return cases;
}

/**
 * A weaker team (5–6 players) against a stronger opponent over 5–7 games, with the opponent's
 * strength per slot varying: the setting the underdog plan exists for.
 */
export function underdogCases(count: number, seed = 777): OrderInput[] {
  const rng = mulberry32(seed);
  const cases: OrderInput[] = [];
  for (let n = 0; n < count; n += 1) {
    const singles = 3 + Math.floor(rng() * 3);
    const doubles = 1 + Math.floor(rng() * 2);
    const size = 5 + Math.floor(rng() * 2);
    const ours = Array.from({ length: size }, () => Math.round(40 + rng() * 18));
    const gap = 6 + rng() * 16;
    const confidence: ConfidenceLevel = rng() < 0.2 ? 'LOW' : rng() < 0.5 ? 'MEDIUM' : 'HIGH';
    const players = ours.map((s, i) => person(`u${n}_${i}`, s));
    const games: GameSlotDef[] = [
      ...Array.from({ length: singles }, (_, i): GameSlotDef => ({ id: `s${i + 1}`, order: i + 1, name: `Singles ${i + 1}`, kinds: ['SINGLES', 'G501'], playerCount: 1 })),
      ...Array.from({ length: doubles }, (_, i): GameSlotDef => ({
        id: `d${i + 1}`,
        order: singles + i + 1,
        name: `Doubles ${i + 1}`,
        kinds: ['DOUBLES', 'G501'],
        playerCount: 2,
        n01: { schid: `d${i + 1}`, numPart: 2, matchType: '01', startScore: 501, limitLegCount: 2, group: null, subtitle: null },
      })),
    ];
    const mean = ours.reduce((a, b) => a + b, 0) / ours.length;
    const oppOf = new Map(games.map((game) => [game.id, Math.round(mean + gap + (rng() * 2 - 1) * 10)]));
    const context: OpponentContext = {
      version: 2,
      generatedAt: 0,
      matchId: `u${n}`,
      matchDate: '2026-10-20',
      opponentName: 'synthetic',
      leagueMeanPpr: 55,
      players: Object.fromEntries(players.map((p, i) => [p.id, { strength: ours[i], confidence: 'HIGH', legs: 60, imputed: false, formAdjustment: 0, first9Adjustment: 0, first9Excess: null }])),
      games: Object.fromEntries(
        games.map((game) => {
          const strength = oppOf.get(game.id)!;
          return [
            game.id,
            {
              gameId: game.id,
              signature: game.id,
              numPart: game.playerCount,
              legsToWin: 2,
              cricket: false,
              likely: [],
              samples: 6,
              confidence,
              sides:
                game.playerCount === 1
                  ? [{ strength, probability: 1 }]
                  : [{ strength, probability: 1, members: [0, 1].map(() => ({ strength, finish: finishPrior(strength) })) }],
              ...(game.playerCount > 1 ? { startScore: 501, order: { known: true, confidence, samples: 6, leaders: [] } } : {}),
            } as OpponentGameContext,
          ];
        }),
      ),
      orderConfidence: confidence,
      confidence,
      discipline: 'STEEL',
    };
    cases.push(baseInput(players, games, context));
  }
  return cases;
}
