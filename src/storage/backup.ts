import type {
  AppSettings,
  LeagueFormat,
  PairSetting,
  Player,
  SavedOrder,
  SeasonCommit,
  Team,
} from '../domain/types';
import { GAME_KINDS, PAIR_AFFINITIES } from '../domain/types';
import { mergeDefined } from '../utils/merge';
import { asDiscipline } from '../domain/types';
import { normaliseSavedOrder } from '../domain/normalise';
import { parsePprInput } from '../domain/players/strength';
import {
  parseFormatSource,
  parseGameMeta,
  parsePlayerBinding,
  parsePprSource,
  parseTeamBinding,
} from '../domain/n01/parse';
import { DEFAULT_SETTINGS, type Snapshot } from './repository';

/**
 * JSON export / import (spec §23).
 *
 * Import validates the whole file before touching storage: an invalid backup is
 * rejected outright rather than applied halfway. Unknown fields are dropped and
 * missing optional fields are filled with the same defaults the app uses, so a backup
 * from an older build still imports cleanly.
 */

export const BACKUP_SCHEMA_VERSION = 1;

export interface BackupFile {
  schemaVersion: number;
  app: 'darts-league-order';
  exportedAt: string;
  data: Snapshot;
}

export function createBackup(snapshot: Snapshot): BackupFile {
  return {
    schemaVersion: BACKUP_SCHEMA_VERSION,
    app: 'darts-league-order',
    exportedAt: new Date().toISOString(),
    data: snapshot,
  };
}

export function serialiseBackup(snapshot: Snapshot): string {
  return JSON.stringify(createBackup(snapshot), null, 2);
}

export type ImportResult =
  | { ok: true; snapshot: Snapshot; warnings: string[] }
  | { ok: false; errors: string[] };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function asString(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback;
}

function asNumber(value: unknown, fallback = 0): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function asRating(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/** A PPR from a backup: a number within 0..180, otherwise Unknown (never 0). */
function asBackupPpr(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  const parsed = parsePprInput(String(value));
  return parsed.ok ? parsed.value : null;
}

function asBoolean(value: unknown, fallback = false): boolean {
  return typeof value === 'boolean' ? value : fallback;
}

function parseSkills(value: unknown): Player['skills'] {
  const skills: Player['skills'] = {};
  if (!isRecord(value)) return skills;
  for (const kind of GAME_KINDS) {
    const level = value[kind];
    if (typeof level === 'number' && level >= 1 && level <= 5) {
      skills[kind] = Math.round(level) as 1 | 2 | 3 | 4 | 5;
    }
  }
  return skills;
}

function parseKindCounts(value: unknown): Player['seasonAppearancesByKind'] {
  const counts: Player['seasonAppearancesByKind'] = {};
  if (!isRecord(value)) return counts;
  for (const kind of GAME_KINDS) {
    const count = value[kind];
    if (typeof count === 'number' && Number.isFinite(count)) counts[kind] = Math.max(0, Math.round(count));
  }
  return counts;
}

function hasArrays(value: unknown, keys: readonly string[]): boolean {
  return isRecord(value) && keys.every((key) => Array.isArray(value[key]));
}

/** True when a saved order carries the nested arrays the app and the upgrade read. */
function isUsableOrder(row: Record<string, unknown>): boolean {
  if (!hasArrays(row.input, ['games', 'players', 'participants'])) return false;
  if (!hasArrays(row.solution, ['assignments'])) return false;
  if (row.versions === undefined) return true;
  return (
    Array.isArray(row.versions) &&
    row.versions.every((version) => hasArrays(version, ['games', 'players', 'assignments']))
  );
}

/**
 * Parses and validates a backup file.
 * Returns every problem found rather than failing on the first one.
 */
export function parseBackup(raw: string): ImportResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    return { ok: false, errors: [`JSON として解析できませんでした: ${(error as Error).message}`] };
  }

  const errors: string[] = [];
  const warnings: string[] = [];

  if (!isRecord(parsed)) {
    return { ok: false, errors: ['ファイルの最上位がオブジェクトではありません。'] };
  }
  if (parsed.app !== 'darts-league-order') {
    warnings.push('このアプリで作成されたバックアップではない可能性があります。');
  }
  const version = asNumber(parsed.schemaVersion, 0);
  if (version > BACKUP_SCHEMA_VERSION) {
    errors.push(
      `バックアップのスキーマ版 ${version} はこのアプリ (対応版 ${BACKUP_SCHEMA_VERSION}) より新しいため読み込めません。`,
    );
  }
  const data = parsed.data;
  if (!isRecord(data)) {
    errors.push('data セクションがありません。');
    return { ok: false, errors };
  }

  const teams: Team[] = (Array.isArray(data.teams) ? data.teams : [])
    .filter(isRecord)
    .map((row) => ({
      id: asString(row.id),
      name: asString(row.name, '名称未設定チーム'),
      leagueName: typeof row.leagueName === 'string' ? row.leagueName : undefined,
      note: typeof row.note === 'string' ? row.note : undefined,
      demo: row.demo === true ? true : undefined,
      createdAt: asNumber(row.createdAt, Date.now()),
      // n01 link (docs/N01_DATA_MODEL.md §4): kept only when complete.
      n01: parseTeamBinding(row.n01),
    }))
    .filter((team) => team.id !== '');

  const teamIds = new Set(teams.map((team) => team.id));

  const players: Player[] = (Array.isArray(data.players) ? data.players : [])
    .filter(isRecord)
    .map((row) => ({
      id: asString(row.id),
      teamId: asString(row.teamId),
      name: asString(row.name, '名称未設定'),
      rating: asRating(row.rating),
      // Backups written before PPR existed have no `ppr`: Unknown, never 0.
      ppr: asBackupPpr(row.ppr),
      skills: parseSkills(row.skills),
      note: typeof row.note === 'string' ? row.note : undefined,
      seasonAppearances: Math.max(0, Math.round(asNumber(row.seasonAppearances, 0))),
      seasonAppearancesByKind: parseKindCounts(row.seasonAppearancesByKind),
      archived: asBoolean(row.archived),
      createdAt: asNumber(row.createdAt, Date.now()),
      n01: parsePlayerBinding(row.n01),
      pprSource: parsePprSource(row.pprSource),
    }))
    .filter((player) => player.id !== '');

  const formats: LeagueFormat[] = (Array.isArray(data.formats) ? data.formats : [])
    .filter(isRecord)
    .map((row) => ({
      id: asString(row.id),
      teamId: typeof row.teamId === 'string' ? row.teamId : null,
      name: asString(row.name, '名称未設定フォーマット'),
      note: typeof row.note === 'string' ? row.note : undefined,
      // Never guessed from the name: an old backup's format is UNSPECIFIED.
      discipline: asDiscipline(row.discipline),
      games: (Array.isArray(row.games) ? row.games : [])
        .filter(isRecord)
        .map((game, index) => ({
          id: asString(game.id, `game_${index}`),
          order: Math.max(1, Math.round(asNumber(game.order, index + 1))),
          name: asString(game.name, `Game ${index + 1}`),
          kinds: (Array.isArray(game.kinds) ? game.kinds : [])
            .filter((kind): kind is (typeof GAME_KINDS)[number] =>
              GAME_KINDS.includes(kind as (typeof GAME_KINDS)[number]),
            )
            .slice(),
          playerCount: Math.max(1, Math.round(asNumber(game.playerCount, 1))),
          n01: parseGameMeta(game.n01),
        }))
        .map((game) => (game.kinds.length === 0 ? { ...game, kinds: ['CUSTOM' as const] } : game)),
      createdAt: asNumber(row.createdAt, Date.now()),
      source: parseFormatSource(row.source),
    }))
    .filter((format) => format.id !== '');

  const pairs: PairSetting[] = (Array.isArray(data.pairs) ? data.pairs : [])
    .filter(isRecord)
    .map((row) => {
      const a = asString(row.a);
      const b = asString(row.b);
      const affinityRaw = asString(row.affinity, 'NEUTRAL');
      const affinity = PAIR_AFFINITIES.includes(affinityRaw as PairSetting['affinity'])
        ? (affinityRaw as PairSetting['affinity'])
        : 'NEUTRAL';
      return {
        id: asString(row.id),
        teamId: asString(row.teamId),
        a: a < b ? a : b,
        b: a < b ? b : a,
        affinity,
        pastTogetherCount: Math.max(0, Math.round(asNumber(row.pastTogetherCount, 0))),
      };
    })
    .filter((pair) => pair.id !== '' && pair.a !== '' && pair.b !== '');

  const orderRows = (Array.isArray(data.orders) ? data.orders : [])
    .filter(isRecord)
    .filter((row) => typeof row.id === 'string' && isRecord(row.input) && isRecord(row.solution));
  // An order whose snapshot lacks the arrays every screen reads cannot be opened, and
  // upgrading it would throw: it is skipped with a warning instead of failing the import.
  const usableOrders = orderRows.filter(isUsableOrder);
  if (usableOrders.length < orderRows.length) {
    warnings.push(
      `構造が壊れているオーダー ${orderRows.length - usableOrders.length} 件を読み込みませんでした。`,
    );
  }
  const orders: SavedOrder[] = usableOrders
    .map((row) =>
      normaliseSavedOrder({
        ...(row as unknown as SavedOrder),
        // Backups written before versioning existed carry no versions: those orders are
        // read back as drafts rather than being rejected.
        versions: Array.isArray(row.versions) ? (row.versions as SavedOrder['versions']) : [],
      }),
    );

  const seasonCommits: SeasonCommit[] = (Array.isArray(data.seasonCommits) ? data.seasonCommits : [])
    .filter(isRecord)
    .filter((row) => typeof row.id === 'string' && Array.isArray(row.appearances))
    .map((row) => ({
      id: asString(row.id),
      teamId: asString(row.teamId),
      committedVersion: Math.max(1, Math.round(asNumber(row.committedVersion, 1))),
      committedAt: asNumber(row.committedAt, Date.now()),
      appearances: (row.appearances as unknown[])
        .filter(isRecord)
        .map((record) => ({
          playerId: asString(record.playerId),
          count: Math.round(asNumber(record.count, 0)),
          byKind: parseKindCounts(record.byKind),
        }))
        .filter((record) => record.playerId !== ''),
    }));

  const settingsRow = isRecord(data.settings) ? data.settings : {};
  const settings: AppSettings = {
    activeTeamId:
      typeof settingsRow.activeTeamId === 'string' ? settingsRow.activeTeamId : null,
    optimizer: mergeDefined(
      DEFAULT_SETTINGS.optimizer,
      isRecord(settingsRow.optimizer)
        ? (settingsRow.optimizer as Partial<AppSettings['optimizer']>)
        : undefined,
    ),
    lastPreset: (asString(settingsRow.lastPreset, 'BALANCED') as AppSettings['lastPreset']) ?? 'BALANCED',
    customWeights: mergeDefined(
      DEFAULT_SETTINGS.customWeights,
      isRecord(settingsRow.customWeights)
        ? (settingsRow.customWeights as Partial<AppSettings['customWeights']>)
        : undefined,
    ),
  };

  if (teams.length === 0) errors.push('チームが 1 件も含まれていません。');
  for (const player of players) {
    if (!teamIds.has(player.teamId)) {
      warnings.push(`選手「${player.name}」の所属チームがバックアップに含まれていません。`);
    }
  }
  if (settings.activeTeamId !== null && !teamIds.has(settings.activeTeamId)) {
    settings.activeTeamId = teams[0]?.id ?? null;
  }

  if (errors.length > 0) return { ok: false, errors };
  return {
    ok: true,
    snapshot: { teams, players, formats, pairs, orders, seasonCommits, settings },
    warnings,
  };
}
