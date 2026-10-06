import type { GameKind, LeagueFormat, Player, Team, TeamId } from '../domain/types';
import { createId } from '../utils/id';
import type { Snapshot } from './repository';
import { DEFAULT_SETTINGS } from './repository';

/**
 * Sample ("demo") data.
 *
 * Offered on the first-run screen as "サンプルで試す", never created silently: one team,
 * the five-player roster from spec §38 and a six-game format that mixes Singles,
 * Doubles and Trios, so "generate" works immediately. The team carries `demo: true` so
 * every screen can label it as sample data.
 */
export function buildSeed(): Snapshot {
  const now = Date.now();
  const team: Team = { id: createId('team'), name: 'サンプルチーム', demo: true, createdAt: now };

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
    ppr: null,
    skills: entry.skills,
    seasonAppearances: 0,
    seasonAppearancesByKind: {},
    archived: false,
    createdAt: now + index,
  }));

  const format = formatFromTemplate(FORMAT_TEMPLATES[0], team.id, now);

  return {
    teams: [team],
    players,
    formats: [format],
    pairs: [],
    orders: [],
    seasonCommits: [],
    settings: { ...DEFAULT_SETTINGS, activeTeamId: team.id },
  };
}

/** Starter formats offered during onboarding (and used by the sample). */
export interface FormatTemplate {
  key: string;
  name: string;
  description: string;
  games: { name: string; kinds: GameKind[]; playerCount: number }[];
}

export const FORMAT_TEMPLATES: readonly FormatTemplate[] = [
  {
    key: 'standard6',
    name: '標準6ゲーム (Singles/Doubles/Trios)',
    description: 'S501 / S Cricket / D501 / D Cricket / Trios / S501 ・ 10枠',
    games: [
      { name: 'Singles 501', kinds: ['SINGLES', 'G501'], playerCount: 1 },
      { name: 'Singles Cricket', kinds: ['SINGLES', 'CRICKET'], playerCount: 1 },
      { name: 'Doubles 501', kinds: ['DOUBLES', 'G501'], playerCount: 2 },
      { name: 'Doubles Cricket', kinds: ['DOUBLES', 'CRICKET'], playerCount: 2 },
      { name: 'Trios', kinds: ['TRIOS'], playerCount: 3 },
      { name: 'Singles 501', kinds: ['SINGLES', 'G501'], playerCount: 1 },
    ],
  },
  {
    key: 'doubles4',
    name: 'ダブルス中心4ゲーム',
    description: 'D501 / D Cricket / D501 / D Cricket ・ 8枠',
    games: [
      { name: 'Doubles 501', kinds: ['DOUBLES', 'G501'], playerCount: 2 },
      { name: 'Doubles Cricket', kinds: ['DOUBLES', 'CRICKET'], playerCount: 2 },
      { name: 'Doubles 501', kinds: ['DOUBLES', 'G501'], playerCount: 2 },
      { name: 'Doubles Cricket', kinds: ['DOUBLES', 'CRICKET'], playerCount: 2 },
    ],
  },
  {
    key: 'singles4',
    name: 'シングルス4ゲーム',
    description: 'S501 / S Cricket / S501 / S Cricket ・ 4枠',
    games: [
      { name: 'Singles 501', kinds: ['SINGLES', 'G501'], playerCount: 1 },
      { name: 'Singles Cricket', kinds: ['SINGLES', 'CRICKET'], playerCount: 1 },
      { name: 'Singles 501', kinds: ['SINGLES', 'G501'], playerCount: 1 },
      { name: 'Singles Cricket', kinds: ['SINGLES', 'CRICKET'], playerCount: 1 },
    ],
  },
];

export function formatFromTemplate(template: FormatTemplate, teamId: TeamId, now: number): LeagueFormat {
  return {
    id: createId('fmt'),
    teamId,
    name: template.name,
    discipline: 'UNSPECIFIED',
    games: template.games.map((game, index) => ({
      id: createId('gm'),
      order: index + 1,
      name: game.name,
      kinds: [...game.kinds],
      playerCount: game.playerCount,
    })),
    createdAt: now,
  };
}
