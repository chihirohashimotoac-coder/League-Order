import type {
  N01FormatSource,
  N01GameMeta,
  N01PlayerBinding,
  N01PprStats,
  N01StableIdentity,
  N01TeamBinding,
  PprSource,
} from './types';
import { asDiscipline } from '../types';

/**
 * Validation of stored n01 bindings, for JSON import (docs/N01_DATA_MODEL.md §4).
 *
 * A binding is either complete and well-typed, or it is dropped (`undefined`) and the
 * entity is imported as a hand-made one. Half a binding — a team pointing at a league
 * but with no identity, say — would make the next sync guess, so it is never kept.
 */

type Rec = Record<string, unknown>;

function isRec(value: unknown): value is Rec {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function str(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function finite(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function nullableStr(value: unknown): string | null | undefined {
  if (value === null) return null;
  return typeof value === 'string' ? value : undefined;
}

function nullableNum(value: unknown): number | null | undefined {
  if (value === null) return null;
  return finite(value) ?? undefined;
}

export function parsePprSource(value: unknown): PprSource | undefined {
  return value === 'n01' || value === 'manual' ? value : undefined;
}

function parseIdentity(value: unknown): N01StableIdentity | null {
  if (!isRec(value)) return null;
  const kind = value.kind;
  const id = str(value.value);
  if ((kind === 'n01' || kind === 'name') && id) return { kind, value: id };
  return null;
}

export function parseTeamBinding(value: unknown): N01TeamBinding | undefined {
  if (!isRec(value) || value.provider !== 'n01') return undefined;
  const leagueId = str(value.leagueId);
  const identity = parseIdentity(value.stableIdentity);
  const tournamentId = str(value.lastTournamentId);
  const teamId = str(value.lastTeamId);
  if (!leagueId || !identity || !tournamentId || !teamId) return undefined;
  const divisionIndex = nullableNum(value.lastDivisionIndex);
  const divisionTitle = nullableStr(value.lastDivisionTitle);
  const managedFormatId = nullableStr(value.managedFormatId);
  return {
    provider: 'n01',
    leagueId,
    leagueTitle: str(value.leagueTitle) ?? leagueId,
    stableIdentity: identity,
    lastTournamentId: tournamentId,
    lastTournamentTitle: str(value.lastTournamentTitle) ?? tournamentId,
    lastTeamId: teamId,
    lastTeamName: str(value.lastTeamName) ?? '',
    lastDivisionIndex: divisionIndex ?? null,
    lastDivisionTitle: divisionTitle ?? null,
    discipline: asDiscipline(value.discipline),
    managedFormatId: managedFormatId ?? null,
    linkedAt: finite(value.linkedAt) ?? 0,
    lastSuccessfulSyncAt: finite(value.lastSuccessfulSyncAt) ?? 0,
  };
}

function parseStats(value: unknown): N01PprStats | null {
  if (!isRec(value)) return null;
  const score = finite(value.score);
  const darts = finite(value.darts);
  const tournamentId = str(value.tournamentId);
  if (score === null || darts === null || !tournamentId) return null;
  const ppr = value.ppr === null ? null : finite(value.ppr);
  return {
    ppr: ppr !== null && ppr >= 0 && ppr <= 180 ? ppr : null,
    score,
    darts,
    legs: finite(value.legs),
    tournamentId,
    syncedAt: finite(value.syncedAt) ?? 0,
  };
}

export function parsePlayerBinding(value: unknown): N01PlayerBinding | undefined {
  if (!isRec(value)) return undefined;
  const opid = nullableStr(value.opid);
  const oid = nullableStr(value.currentOid);
  const sourceName = str(value.sourceName);
  const tournamentId = str(value.lastSeenTournamentId);
  if (opid === undefined || oid === undefined || sourceName === null || !tournamentId) return undefined;
  if (!opid && !oid) return undefined;
  return {
    opid,
    currentOid: oid,
    currentTpid: nullableStr(value.currentTpid) ?? null,
    sourceName,
    rosterActive: value.rosterActive !== false,
    lastSeenTournamentId: tournamentId,
    lastSeenAt: finite(value.lastSeenAt) ?? 0,
    stats: parseStats(value.stats),
  };
}

export function parseFormatSource(value: unknown): N01FormatSource | undefined {
  if (!isRec(value) || value.provider !== 'n01') return undefined;
  const leagueId = str(value.leagueId);
  const tournamentId = str(value.tournamentId);
  if (!leagueId || !tournamentId) return undefined;
  return {
    provider: 'n01',
    leagueId,
    leagueTitle: str(value.leagueTitle) ?? leagueId,
    tournamentId,
    tournamentTitle: str(value.tournamentTitle) ?? tournamentId,
    divisionIndex: nullableNum(value.divisionIndex) ?? null,
    divisionTitle: nullableStr(value.divisionTitle) ?? null,
    syncedAt: finite(value.syncedAt) ?? 0,
  };
}

export function parseGameMeta(value: unknown): N01GameMeta | undefined {
  if (!isRec(value)) return undefined;
  const schid = str(value.schid);
  const numPart = finite(value.numPart);
  if (!schid || numPart === null) return undefined;
  return {
    schid,
    numPart,
    matchType: str(value.matchType) ?? '01',
    startScore: nullableNum(value.startScore) ?? null,
    limitLegCount: nullableNum(value.limitLegCount) ?? null,
    group: nullableStr(value.group) ?? null,
    subtitle: nullableStr(value.subtitle) ?? null,
  };
}
