import type {
  DartsDiscipline,
  GameKind,
  GameSlotDef,
  LeagueFormat,
  OrderInput,
  PairAffinity,
  PairSetting,
  ParticipantConfig,
  Player,
  Ppr,
  Rating,
  ScoreWeights,
  SkillLevel,
  Team,
} from '../domain/types';
import { DEFAULT_OPTIMIZER_SETTINGS, PRESETS } from '../domain/orders/presets';
import { createParticipantConfig } from '../domain/orders/participants';
import { canonicalPair } from '../domain/games/pairKey';

/**
 * Test fixtures.
 *
 * These build ordinary inputs through the same public shapes the app uses; no test
 * reaches into optimizer internals or relies on special-cased behaviour.
 */

export const TEAM_ID = 'team_test';

export function team(name = 'Test Team'): Team {
  return { id: TEAM_ID, name, createdAt: 0 };
}

export interface PlayerSpec {
  id: string;
  name: string;
  rating?: Rating;
  ppr?: Ppr;
  skills?: Partial<Record<GameKind, SkillLevel>>;
  seasonAppearances?: number;
}

export function player(spec: PlayerSpec): Player {
  return {
    id: spec.id,
    teamId: TEAM_ID,
    name: spec.name,
    rating: spec.rating === undefined ? null : spec.rating,
    ppr: spec.ppr === undefined ? null : spec.ppr,
    skills: spec.skills ?? {},
    seasonAppearances: spec.seasonAppearances ?? 0,
    seasonAppearancesByKind: {},
    archived: false,
    createdAt: 0,
  };
}

export interface GameSpec {
  id: string;
  name: string;
  kinds: GameKind[];
  playerCount: number;
}

export function games(specs: readonly GameSpec[]): GameSlotDef[] {
  return specs.map((spec, index) => ({
    id: spec.id,
    order: index + 1,
    name: spec.name,
    kinds: spec.kinds,
    playerCount: spec.playerCount,
  }));
}

export function format(
  gameDefs: GameSlotDef[],
  name = 'Test Format',
  discipline: DartsDiscipline = 'UNSPECIFIED',
): LeagueFormat {
  return { id: 'fmt_test', teamId: TEAM_ID, name, discipline, games: gameDefs, createdAt: 0 };
}

export function pair(a: string, b: string, affinity: PairAffinity, pastTogetherCount = 0): PairSetting {
  const canonical = canonicalPair(TEAM_ID, a, b);
  return { id: `pair_${canonical.a}_${canonical.b}`, ...canonical, affinity, pastTogetherCount };
}

export interface InputOverrides {
  participants?: ParticipantConfig[];
  pairs?: PairSetting[];
  locks?: OrderInput['locks'];
  weights?: Partial<ScoreWeights>;
  settings?: Partial<OrderInput['settings']>;
  preset?: OrderInput['preset'];
  discipline?: DartsDiscipline;
}

export function orderInput(
  players: Player[],
  gameDefs: GameSlotDef[],
  overrides: InputOverrides = {},
): OrderInput {
  const preset = overrides.preset ?? 'BALANCED';
  const baseWeights = preset === 'CUSTOM' ? PRESETS.BALANCED.weights : PRESETS[preset].weights;
  return {
    teamId: TEAM_ID,
    formatId: 'fmt_test',
    games: gameDefs,
    players,
    participants: overrides.participants ?? players.map((p) => createParticipantConfig(p.id)),
    pairs: overrides.pairs ?? [],
    locks: overrides.locks ?? [],
    preset,
    weights: { ...baseWeights, ...overrides.weights },
    settings: { ...DEFAULT_OPTIMIZER_SETTINGS, ...overrides.settings },
    discipline: overrides.discipline ?? 'UNSPECIFIED',
  };
}

/**
 * The sample from spec §38: five players rated 14 / 14 / 11 / 8 / 4 and a format that
 * mixes Singles, Doubles and Trios.
 */
export function sampleRoster(): Player[] {
  return [
    player({ id: 'p1', name: 'Aoki', rating: 14, skills: { G501: 5, CRICKET: 4, SINGLES: 5, DOUBLES: 4, TRIOS: 3 } }),
    player({ id: 'p2', name: 'Baba', rating: 14, skills: { G501: 4, CRICKET: 5, SINGLES: 4, DOUBLES: 5, TRIOS: 4 } }),
    player({ id: 'p3', name: 'Chiba', rating: 11, skills: { G501: 3, CRICKET: 3, SINGLES: 3, DOUBLES: 4, TRIOS: 4 } }),
    player({ id: 'p4', name: 'Doi', rating: 8, skills: { G501: 3, CRICKET: 2, SINGLES: 2, DOUBLES: 3, TRIOS: 3 } }),
    player({ id: 'p5', name: 'Endo', rating: 4, skills: { G501: 2, CRICKET: 2, SINGLES: 2, DOUBLES: 2, TRIOS: 3 } }),
  ];
}

/** A six-game format: 2 Singles, 2 Doubles, 1 Trios, 1 Singles — 10 slots total. */
export function sampleFormatGames(): GameSlotDef[] {
  return games([
    { id: 'g1', name: 'Singles 501', kinds: ['SINGLES', 'G501'], playerCount: 1 },
    { id: 'g2', name: 'Singles Cricket', kinds: ['SINGLES', 'CRICKET'], playerCount: 1 },
    { id: 'g3', name: 'Doubles 501', kinds: ['DOUBLES', 'G501'], playerCount: 2 },
    { id: 'g4', name: 'Doubles Cricket', kinds: ['DOUBLES', 'CRICKET'], playerCount: 2 },
    { id: 'g5', name: 'Trios', kinds: ['TRIOS'], playerCount: 3 },
    { id: 'g6', name: 'Singles 501', kinds: ['SINGLES', 'G501'], playerCount: 1 },
  ]);
}

/** An eleven-slot variant used to exercise the "cannot divide evenly" fairness rule. */
export function sampleFormatGames11(): GameSlotDef[] {
  return games([
    { id: 'g1', name: 'Singles 501', kinds: ['SINGLES', 'G501'], playerCount: 1 },
    { id: 'g2', name: 'Singles Cricket', kinds: ['SINGLES', 'CRICKET'], playerCount: 1 },
    { id: 'g3', name: 'Doubles 501', kinds: ['DOUBLES', 'G501'], playerCount: 2 },
    { id: 'g4', name: 'Doubles Cricket', kinds: ['DOUBLES', 'CRICKET'], playerCount: 2 },
    { id: 'g5', name: 'Trios', kinds: ['TRIOS'], playerCount: 3 },
    { id: 'g6', name: 'Doubles 501', kinds: ['DOUBLES', 'G501'], playerCount: 2 },
  ]);
}
