import type { GameSlotDef, LeagueFormat, LeagueRuleOrigin, LeagueRules, RuleAnswerSet, StructuralKind } from '../types';
import { STRUCTURAL_KINDS } from '../types';
import { structuralKindsOf } from '../games/format';
import { cloneLeagueRules, hasLeagueRules, isValidCap } from './leagueRules';
import type { LeagueRuleCatalogEntry } from './ruleCatalog';
import { catalogEntryForLeague } from './ruleCatalog';

/**
 * Which appearance caps an order is made under, and which ones the captain still has to state
 * (出場条件の確定).
 *
 * For each player-count kind of the format the cap comes from, in this order:
 *
 * 1. the league catalog (ATDO / TDO …), for formats n01 manages for that league;
 * 2. the format editor's league rules;
 * 3. the captain's answer, stored per scope (`n01:<lgid>` for an n01 league, `format:<id>`
 *    for a manual format) and reused for the next order in that scope;
 * 4. otherwise, when the format has two or more games of the kind, it is *pending*: the order
 *    is not generated until the captain answers. A kind with one game (or none) needs no
 *    answer — one placement can never be a second appearance.
 *
 * Only Gallon, Trios, Doubles and Singles are asked about. The kind is the format's own
 * (`GameSlotDef.kinds`, which the n01 format resolver sets from n01's definition — `num_part`
 * and a "Gallon" game name), never re-guessed from a head count here.
 */

export const ASKABLE_KINDS = ['GALLON', 'TRIOS', 'DOUBLES', 'SINGLES'] as const satisfies readonly StructuralKind[];

export type AskableKind = (typeof ASKABLE_KINDS)[number];

export const ASKABLE_LABELS: Record<AskableKind, string> = {
  GALLON: 'ガロン',
  TRIOS: 'トリオス',
  DOUBLES: 'ダブルス',
  SINGLES: 'シングルス',
};

/** The cap "はい" stands for: a second appearance, and nothing beyond it is assumed. */
export const YES_CAP = 2;
/** The cap "いいえ" stands for. */
export const NO_CAP = 1;

export type KindStatus =
  | { kind: StructuralKind; games: number; state: 'decided'; cap: number; origin: LeagueRuleOrigin }
  | { kind: StructuralKind; games: number; state: 'single' }
  | { kind: StructuralKind; games: number; state: 'pending' }
  | { kind: StructuralKind; games: number; state: 'free' };

export interface RuleResolution {
  /** Where answers for this format are stored and reused. */
  scope: string;
  /** The league catalog entry applied, if any. */
  catalog: LeagueRuleCatalogEntry | null;
  /** One row per player-count kind the format has (canonical order). */
  kinds: KindStatus[];
  /** Kinds the captain must answer before generating. */
  pending: AskableKind[];
  /** The rules the order is made and checked under (`undefined` when there are none). */
  rules: LeagueRules | undefined;
}

/** `n01:<lgid>` for a format n01 manages, `format:<id>` otherwise. */
export function ruleScopeOf(format: Pick<LeagueFormat, 'id' | 'source'>): string {
  return format.source?.provider === 'n01' && format.source.leagueId ? `n01:${format.source.leagueId}` : `format:${format.id}`;
}

/** Games per player-count kind (a game carrying two kinds is a format error, counted for both). */
export function structureCounts(games: readonly Pick<GameSlotDef, 'kinds'>[]): Map<StructuralKind, number> {
  const counts = new Map<StructuralKind, number>();
  for (const game of games) {
    for (const kind of structuralKindsOf(game)) counts.set(kind, (counts.get(kind) ?? 0) + 1);
  }
  return counts;
}

/** The kinds a question would be shown for: askable, and two or more games of it. */
export function questionKinds(games: readonly Pick<GameSlotDef, 'kinds'>[]): AskableKind[] {
  const counts = structureCounts(games);
  return ASKABLE_KINDS.filter((kind) => (counts.get(kind) ?? 0) >= 2);
}

function isAskable(kind: StructuralKind): kind is AskableKind {
  return (ASKABLE_KINDS as readonly string[]).includes(kind);
}

export function resolveOrderRules(
  format: Pick<LeagueFormat, 'id' | 'source' | 'games' | 'leagueRules'>,
  answers: Record<string, RuleAnswerSet> | undefined,
): RuleResolution {
  const scope = ruleScopeOf(format);
  const catalog = format.source?.provider === 'n01' ? catalogEntryForLeague(format.source.leagueId) : null;
  const answered = answers?.[scope]?.caps ?? {};
  const base: LeagueRules = hasLeagueRules(format.leagueRules) ? cloneLeagueRules(format.leagueRules) : {};
  const origins: Partial<Record<string, LeagueRuleOrigin>> = { ...(base.origins ?? {}) };
  const caps: Partial<Record<StructuralKind, number>> = { ...(base.maxPerStructure ?? {}) };
  const counts = structureCounts(format.games);
  const kinds: KindStatus[] = [];
  const pending: AskableKind[] = [];

  for (const kind of STRUCTURAL_KINDS) {
    const games = counts.get(kind) ?? 0;
    const key = `structure:${kind}`;
    const catalogCap = catalog?.caps[kind];
    if (catalogCap !== undefined) {
      caps[kind] = catalogCap;
      origins[key] = catalog!.basis;
    } else if (caps[kind] !== undefined) {
      origins[key] = origins[key] ?? 'format';
    } else if (isAskable(kind) && isValidCap(answered[kind]) && answered[kind]! >= 1 && games >= 2) {
      caps[kind] = answered[kind];
      origins[key] = 'answer';
    }
    if (games === 0) continue;
    const cap = caps[kind];
    if (cap !== undefined) kinds.push({ kind, games, state: 'decided', cap, origin: origins[key] ?? 'format' });
    else if (games < 2) kinds.push({ kind, games, state: 'single' });
    else if (isAskable(kind)) {
      kinds.push({ kind, games, state: 'pending' });
      pending.push(kind);
    } else kinds.push({ kind, games, state: 'free' });
  }

  const rules: LeagueRules = {
    ...base,
    ...(Object.keys(caps).length > 0 ? { maxPerStructure: caps } : {}),
  };
  // Origins are kept only for caps that exist (a format-editor rule needs none).
  const kept = Object.fromEntries(Object.entries(origins).filter(([, origin]) => origin !== 'format'));
  if (Object.keys(kept).length > 0) rules.origins = kept;
  else delete rules.origins;
  if (catalog) rules.catalogId = catalog.id;
  else delete rules.catalogId;
  pending.sort((a, b) => ASKABLE_KINDS.indexOf(a) - ASKABLE_KINDS.indexOf(b));
  return { scope, catalog, kinds, pending, rules: hasLeagueRules(rules) ? rules : undefined };
}

/** Stores answers for a scope, keeping every other scope's. */
export function withAnswers(
  current: Record<string, RuleAnswerSet> | undefined,
  scope: string,
  caps: Partial<Record<AskableKind, number>>,
  now: number,
): Record<string, RuleAnswerSet> {
  const previous = current?.[scope]?.caps ?? {};
  return { ...(current ?? {}), [scope]: { caps: { ...previous, ...caps }, updatedAt: now } };
}

/** Removes the answer for one kind (so the question is asked again). */
export function withoutAnswer(
  current: Record<string, RuleAnswerSet> | undefined,
  scope: string,
  kind: AskableKind,
  now: number,
): Record<string, RuleAnswerSet> {
  const entry = current?.[scope];
  if (!entry) return current ?? {};
  const caps = { ...entry.caps };
  delete caps[kind];
  return { ...(current ?? {}), [scope]: { caps, updatedAt: now } };
}

/** Reads stored or imported answers; anything that is not a whole number ≥ 1 is dropped (= ask again). */
export function parseRuleAnswers(value: unknown): Record<string, RuleAnswerSet> {
  const out: Record<string, RuleAnswerSet> = {};
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return out;
  for (const [scope, raw] of Object.entries(value as Record<string, unknown>)) {
    if (typeof raw !== 'object' || raw === null) continue;
    const entry = raw as { caps?: unknown; updatedAt?: unknown };
    const caps: Partial<Record<StructuralKind, number>> = {};
    if (typeof entry.caps === 'object' && entry.caps !== null) {
      for (const kind of ASKABLE_KINDS) {
        const cap = (entry.caps as Record<string, unknown>)[kind];
        if (isValidCap(cap) && cap >= 1) caps[kind] = cap;
      }
    }
    out[scope] = { caps, updatedAt: typeof entry.updatedAt === 'number' ? entry.updatedAt : 0 };
  }
  return out;
}

/** The question text shown for one kind. */
export function questionText(kind: AskableKind): string {
  return `同じ選手が${ASKABLE_LABELS[kind]}に2回出場しても良いですか？`;
}

/** How a decided cap is described next to its origin. */
export function capText(kind: StructuralKind, cap: number): string {
  const label = isAskable(kind) ? ASKABLE_LABELS[kind] : kind === 'TEAM' ? 'チーム戦' : kind;
  return cap === 1 ? `${label}: 1人1回まで` : `${label}: 1人${cap}回まで`;
}
