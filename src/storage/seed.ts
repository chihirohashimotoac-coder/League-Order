import type { LeagueFormat, Player, Team } from '../domain/types';
import { createId } from '../utils/id';
import type { Snapshot } from './repository';
import { DEFAULT_SETTINGS } from './repository';

/**
 * First-run seed data.
 *
 * A brand-new install opens on a usable example rather than an empty screen: one team,
 * the five-player roster from spec §38 and a six-game format that mixes Singles,
 * Doubles and Trios, so "generate" works immediately.
 */
export function buildSeed(): Snapshot {
  const now = Date.now();
  const team: Team = { id: createId('team'), name: 'マイチーム', createdAt: now };

  const roster: { name: string; rating: number | null; skills: Player['skills'] }[] = [
    { name: '青木', rating: 14, skills: { G501: 5, CRICKET: 4, SINGLES: 5, DOUBLES: 4, TRIOS: 3 } },
    { name: '馬場', rating: 14, skills: { G501: 4, CRICKET: 5, SINGLES: 4, DOUBLES: 5, TRIOS: 4 } },
    { name: '千葉', rating: 11, skills: { G501: 3, CRICKET: 3, SINGLES: 3, DOUBLES: 4, TRIOS: 4 } },
    { name: '土井', rating: 8, skills: { G501: 3, CRICKET: 2, SINGLES: 2, DOUBLES: 3, TRIOS: 3 } },
    { name: '遠藤', rating: 4, skills: { G501: 2, CRICKET: 2, SINGLES: 2, DOUBLES: 2, TRIOS: 3 } },
  ];

  const players: Player[] = roster.map((entry, index) => ({
    id: createId('pl'),
    teamId: team.id,
    name: entry.name,
    rating: entry.rating,
    skills: entry.skills,
    seasonAppearances: 0,
    seasonAppearancesByKind: {},
    archived: false,
    createdAt: now + index,
  }));

  const format: LeagueFormat = {
    id: createId('fmt'),
    teamId: team.id,
    name: '標準6ゲーム (Singles/Doubles/Trios)',
    games: [
      { id: createId('gm'), order: 1, name: 'Singles 501', kinds: ['SINGLES', 'G501'], playerCount: 1 },
      { id: createId('gm'), order: 2, name: 'Singles Cricket', kinds: ['SINGLES', 'CRICKET'], playerCount: 1 },
      { id: createId('gm'), order: 3, name: 'Doubles 501', kinds: ['DOUBLES', 'G501'], playerCount: 2 },
      { id: createId('gm'), order: 4, name: 'Doubles Cricket', kinds: ['DOUBLES', 'CRICKET'], playerCount: 2 },
      { id: createId('gm'), order: 5, name: 'Trios', kinds: ['TRIOS'], playerCount: 3 },
      { id: createId('gm'), order: 6, name: 'Singles 501', kinds: ['SINGLES', 'G501'], playerCount: 1 },
    ],
    createdAt: now,
  };

  return {
    teams: [team],
    players,
    formats: [format],
    pairs: [],
    orders: [],
    settings: { ...DEFAULT_SETTINGS, activeTeamId: team.id },
  };
}
