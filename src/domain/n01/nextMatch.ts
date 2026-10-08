import type {
  AppSettings,
  LeagueFormat,
  MatchInfo,
  OrderInput,
  PairSetting,
  ParticipantConfig,
  Player,
  SavedOrder,
  Team,
} from '../types';
import { formatDiscipline } from '../types';
import { createParticipantConfig } from '../orders/participants';
import { scopeForPreset, weightsForPreset } from '../orders/presets';
import { applyHistoryStrength } from './historyStrength';
import type { N01MatchIntelligenceSnapshot } from './intelligence';
import { buildOpponentContext } from '../prediction/opponentContext';

/**
 * The one-button next-match order (MASTER SPEC Phase 5 §2–§3).
 *
 * Roster = who is registered on n01; availability = who is here today. The captain only
 * confirms availability, which starts from what they chose last time (the order being
 * worked on in this session, else the team's latest saved order), never from a guess.
 * Players no longer on the n01 roster are not offered at all.
 */

/** Players who can play in the league: registered on n01 (or hand-made) and not archived. */
export function eligiblePlayers(players: readonly Player[]): Player[] {
  return players.filter((player) => !player.archived && player.n01?.rosterActive !== false);
}

export function previousAvailability(
  players: readonly Player[],
  current: readonly ParticipantConfig[] | null,
  lastOrder: Pick<SavedOrder, 'input'> | null,
): Map<string, boolean> {
  const eligible = eligiblePlayers(players);
  const ids = new Set(eligible.map((player) => player.id));
  // A working order of another team says nothing about this one.
  const usable = current?.some((config) => ids.has(config.playerId)) ? current : null;
  const source = usable ?? lastOrder?.input.participants ?? [];
  const known = new Map(source.map((config) => [config.playerId, config.include]));
  return new Map(eligible.map((player) => [player.id, known.get(player.id) ?? true]));
}

export interface NextMatchOrderInput {
  team: Team;
  players: readonly Player[];
  /**
   * One-order helpers (F06): in this order's players and participants only. Attending
   * follows the same list as everyone; a guest is never offered again next time.
   */
  guests?: readonly Player[];
  format: LeagueFormat;
  pairs: readonly PairSetting[];
  settings: AppSettings;
  intel: N01MatchIntelligenceSnapshot | null;
  /** Who is here today. */
  attending: ReadonlySet<string>;
  /** Day-of conditions to keep (exclusions, windows …) from the previous setup. */
  previous?: readonly ParticipantConfig[];
}

export interface NextMatchOrder {
  input: OrderInput;
  match: MatchInfo;
  /** False when there is no usable opponent data (the order is made as 勝利優先). */
  opponentAvailable: boolean;
}

export function buildNextMatchOrder(source: NextMatchOrderInput): NextMatchOrder {
  const { players, basis } = applyHistoryStrength([...source.players, ...(source.guests ?? [])], source.intel);
  const opponent = source.intel
    ? buildOpponentContext({ snapshot: source.intel, games: source.format.games, players })
    : null;
  const preset = opponent ? 'OPPONENT_OPTIMIZED' : 'WIN_FIRST';
  const kept = new Map((source.previous ?? []).map((config) => [config.playerId, config]));
  const participants = players.map((player) => {
    const base = kept.get(player.id) ?? createParticipantConfig(player.id);
    return { ...base, include: source.attending.has(player.id) };
  });
  const match = source.intel?.nextMatch;
  const binding = source.team.n01;
  return {
    opponentAvailable: opponent !== null,
    match: {
      leagueName: source.team.leagueName?.trim() || binding?.leagueTitle || '',
      teamName: source.team.name,
      opponentName: match?.opponentName ?? '',
      matchDate: match?.date ?? '',
    },
    input: {
      teamId: source.team.id,
      formatId: source.format.id,
      games: source.format.games,
      players,
      participants,
      pairs: [...source.pairs],
      locks: [],
      preset,
      weights: weightsForPreset(preset, source.settings.customWeights),
      settings: {
        ...source.settings.optimizer,
        fairnessScope: scopeForPreset(preset, source.settings.optimizer.fairnessScope),
      },
      discipline: formatDiscipline(source.format),
      ...(opponent ? { opponent } : {}),
      strengthBasis: basis,
    },
  };
}
