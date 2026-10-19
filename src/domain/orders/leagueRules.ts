import type {
  GameAssignment,
  GameId,
  GameSlotDef,
  LeagueRules,
  LeagueStatus,
  ParticipantConfig,
  PlayerId,
  RulePlayKind,
  StructuralKind,
} from '../types';
import { GAME_KIND_LABELS, LEAGUE_STATUSES, RULE_PLAY_KINDS, STRUCTURAL_KINDS } from '../types';
import { structuralKindsOf } from '../games/format';
import { pairKey } from '../games/pairKey';

/**
 * League rules (リーグ規則): optional hard conditions a manual format can carry.
 *
 * This module is the only place that says how they are counted. The validator, the search,
 * the diagnostics and the screens all read these functions, so a rule can never be counted
 * one way while generating and another way while checking.
 *
 * Counting:
 * - One placement in one game is one appearance. The throwing order and the number of legs
 *   the game is played over never add to it.
 * - The player-count category (人数区分: Singles, Doubles …) and the competition kind
 *   (競技区分: 01, Cricket …) are two axes counted independently. A Doubles 01 placement is
 *   one Doubles and one 01. A medley game carrying both 01 and Cricket counts one 01 and one
 *   Cricket — and is still one appearance in total; no leg structure is assumed.
 * - The same-pair rule reads Doubles games only, and a pair is two player ids regardless of
 *   order (A/B = B/A). Two players sharing a Trios or Team game are not a Doubles pair.
 * - The helper rule counts distinct helpers actually placed: one helper in three games is
 *   one helper, a helper who sits out is none.
 */

export type LeagueRuleViolationCode =
  | 'LEAGUE_RULE_INVALID'
  | 'LEAGUE_STRUCTURE_LIMIT'
  | 'LEAGUE_PLAY_KIND_LIMIT'
  | 'LEAGUE_PAIR_LIMIT'
  | 'LEAGUE_HELPER_LIMIT'
  | 'LEAGUE_STATUS_UNSET';

export interface LeagueRuleViolation {
  code: LeagueRuleViolationCode;
  message: string;
  gameId?: GameId;
  playerId?: PlayerId;
}

/** A per-player cap on one category of game. */
export interface PerPlayerLimit {
  /** `structure:SINGLES`, `play:G501` … */
  key: string;
  axis: 'structure' | 'play';
  kind: StructuralKind | RulePlayKind;
  /** `Singles`, `01` … */
  label: string;
  cap: number;
  /** True when one appearance in `game` counts towards this cap. */
  matches(game: Pick<GameSlotDef, 'kinds'>): boolean;
}

/** Display label of a capped kind (01 is shown as the family name, as in the format editor). */
export function ruleKindLabel(kind: StructuralKind | RulePlayKind): string {
  return kind === 'G501' ? '01' : GAME_KIND_LABELS[kind];
}

/** A cap is a whole number of games, 0 or more. */
export function isValidCap(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0;
}

/** True when at least one rule is written (an empty object is no rules). */
export function hasLeagueRules(rules: LeagueRules | null | undefined): rules is LeagueRules {
  if (!rules) return false;
  return (
    Object.values(rules.maxPerStructure ?? {}).some((value) => value !== undefined) ||
    Object.values(rules.maxPerPlayKind ?? {}).some((value) => value !== undefined) ||
    rules.maxSameDoublesPair !== undefined ||
    rules.maxHelpers !== undefined
  );
}

/** Rules whose value is not a whole number ≥ 0 (a damaged import, never the editor). */
export function leagueRuleIssues(rules: LeagueRules | null | undefined): string[] {
  if (!rules) return [];
  const issues: string[] = [];
  const check = (label: string, value: unknown): void => {
    if (value !== undefined && !isValidCap(value)) {
      issues.push(`リーグ規則「${label}」の上限 (${String(value)}) が 0 以上の整数ではありません。`);
    }
  };
  for (const kind of STRUCTURAL_KINDS) check(`${ruleKindLabel(kind)} の出場上限`, rules.maxPerStructure?.[kind]);
  for (const kind of RULE_PLAY_KINDS) check(`${ruleKindLabel(kind)} の出場上限`, rules.maxPerPlayKind?.[kind]);
  check('ダブルス同一ペアの上限', rules.maxSameDoublesPair);
  check('助っ人の人数上限', rules.maxHelpers);
  return issues;
}

/** Every per-player cap that is written, in a fixed order (人数区分 first, then 競技区分). */
export function perPlayerLimits(rules: LeagueRules | null | undefined): PerPlayerLimit[] {
  if (!rules) return [];
  const limits: PerPlayerLimit[] = [];
  for (const kind of STRUCTURAL_KINDS) {
    const cap = rules.maxPerStructure?.[kind];
    if (cap === undefined) continue;
    limits.push({
      key: `structure:${kind}`,
      axis: 'structure',
      kind,
      label: ruleKindLabel(kind),
      cap,
      matches: (game) => structuralKindsOf(game).includes(kind),
    });
  }
  for (const kind of RULE_PLAY_KINDS) {
    const cap = rules.maxPerPlayKind?.[kind];
    if (cap === undefined) continue;
    limits.push({
      key: `play:${kind}`,
      axis: 'play',
      kind,
      label: ruleKindLabel(kind),
      cap,
      matches: (game) => game.kinds.includes(kind),
    });
  }
  return limits;
}

/** True for a game whose two players form a Doubles pair under the same-pair rule. */
export function isDoublesPairGame(game: Pick<GameSlotDef, 'kinds' | 'playerCount'>): boolean {
  return game.playerCount === 2 && structuralKindsOf(game).includes('DOUBLES');
}

/** The status stated for a participant, or `null` when none (or an unreadable one) is stored. */
export function leagueStatusOf(config: Pick<ParticipantConfig, 'leagueStatus'> | undefined): LeagueStatus | null {
  const status = config?.leagueStatus;
  return status !== undefined && (LEAGUE_STATUSES as readonly string[]).includes(status) ? status : null;
}

/** The helper rule needs every fielded player's status. */
export function needsLeagueStatus(rules: LeagueRules | null | undefined): boolean {
  return rules?.maxHelpers !== undefined;
}

export interface PairTally {
  key: string;
  a: PlayerId;
  b: PlayerId;
  count: number;
  gameIds: GameId[];
}

export interface LimitTally {
  limit: PerPlayerLimit;
  /** Appearances per player in games of this category (players with none are absent). */
  counts: Map<PlayerId, number>;
}

export interface LeagueRuleTally {
  limits: LimitTally[];
  /** Doubles pairs that played together, by pair key. */
  pairs: Map<string, PairTally>;
  /** Distinct placed players with status HELPER, in first-placement order. */
  helpers: PlayerId[];
  /** Distinct placed players with no stated status. */
  unstated: PlayerId[];
}

/**
 * Counts an assignment against the rules. Empty slots count for nothing, and a player listed
 * twice in one game is still one placement in that game (the duplicate itself is reported by
 * the hard-constraint validator).
 */
export function tallyLeagueRules(
  rules: LeagueRules | null | undefined,
  games: readonly GameSlotDef[],
  assignments: readonly GameAssignment[],
  participants: readonly ParticipantConfig[],
): LeagueRuleTally {
  const limits: LimitTally[] = perPlayerLimits(rules).map((limit) => ({ limit, counts: new Map() }));
  const pairs = new Map<string, PairTally>();
  const helpers: PlayerId[] = [];
  const unstated: PlayerId[] = [];
  const seenPlaced = new Set<PlayerId>();
  const gameById = new Map(games.map((game) => [game.id, game]));
  const configById = new Map(participants.map((config) => [config.playerId, config]));

  for (const assignment of assignments) {
    const game = gameById.get(assignment.gameId);
    if (!game) continue;
    const members = [...new Set(assignment.playerIds.filter((id) => !!id))];
    for (const playerId of members) {
      for (const entry of limits) {
        if (entry.limit.matches(game)) entry.counts.set(playerId, (entry.counts.get(playerId) ?? 0) + 1);
      }
      if (seenPlaced.has(playerId)) continue;
      seenPlaced.add(playerId);
      const status = leagueStatusOf(configById.get(playerId));
      if (status === 'HELPER') helpers.push(playerId);
      else if (status === null) unstated.push(playerId);
    }
    if (isDoublesPairGame(game) && members.length === 2) {
      const [x, y] = members;
      const key = pairKey(x, y);
      const entry = pairs.get(key) ?? { key, a: x < y ? x : y, b: x < y ? y : x, count: 0, gameIds: [] };
      entry.count += 1;
      entry.gameIds.push(game.id);
      pairs.set(key, entry);
    }
  }
  return { limits, pairs, helpers, unstated };
}

/**
 * Every breach of the rules by an assignment. A cap reached exactly is allowed; one more is a
 * breach. Returns nothing when the order has no rules.
 */
export function leagueRuleViolations(
  rules: LeagueRules | null | undefined,
  games: readonly GameSlotDef[],
  assignments: readonly GameAssignment[],
  participants: readonly ParticipantConfig[],
  nameOf: (playerId: PlayerId) => string,
): LeagueRuleViolation[] {
  if (!hasLeagueRules(rules)) return [];
  const invalid = leagueRuleIssues(rules);
  if (invalid.length > 0) {
    // A cap that is not a number of games cannot be checked: the order is not taken as legal.
    return invalid.map((message) => ({ code: 'LEAGUE_RULE_INVALID', message: `${message} フォーマットで修正してください。` }));
  }
  const violations: LeagueRuleViolation[] = [];
  const tally = tallyLeagueRules(rules, games, assignments, participants);

  for (const { limit, counts } of tally.limits) {
    for (const [playerId, count] of counts) {
      if (count <= limit.cap) continue;
      violations.push({
        code: limit.axis === 'structure' ? 'LEAGUE_STRUCTURE_LIMIT' : 'LEAGUE_PLAY_KIND_LIMIT',
        playerId,
        message: `リーグ規則: ${nameOf(playerId)} は ${limit.label} の出場上限 ${limit.cap} 回を超えて ${count} 回配置されています。`,
      });
    }
  }

  const pairCap = rules.maxSameDoublesPair;
  if (pairCap !== undefined) {
    for (const pair of tally.pairs.values()) {
      if (pair.count <= pairCap) continue;
      violations.push({
        code: 'LEAGUE_PAIR_LIMIT',
        gameId: pair.gameIds[pair.gameIds.length - 1],
        message: `リーグ規則: ダブルスの同一ペア (${nameOf(pair.a)} / ${nameOf(pair.b)}) が上限 ${pairCap} 回を超えて ${pair.count} 回組まれています。`,
      });
    }
  }

  const helperCap = rules.maxHelpers;
  if (helperCap !== undefined) {
    for (const playerId of tally.unstated) {
      violations.push({
        code: 'LEAGUE_STATUS_UNSET',
        playerId,
        message: `リーグ規則: ${nameOf(playerId)} の大会資格 (正規登録 / 助っ人) が未設定のため、助っ人の人数上限を確認できません。オーダー設定の「条件」で資格を選んでください。`,
      });
    }
    if (tally.helpers.length > helperCap) {
      violations.push({
        code: 'LEAGUE_HELPER_LIMIT',
        message: `リーグ規則: 助っ人が上限 ${helperCap} 名を超えて ${tally.helpers.length} 名配置されています (${tally.helpers.map(nameOf).join('、')})。`,
      });
    }
  }
  return violations;
}

/** One line per written rule, for the screens (`Singles 1人 2 回まで` …). */
export function describeLeagueRules(rules: LeagueRules | null | undefined): string[] {
  if (!hasLeagueRules(rules)) return [];
  const lines = perPlayerLimits(rules).map((limit) => `${limit.label}: 1人 ${limit.cap} 回まで`);
  if (rules.maxSameDoublesPair !== undefined) lines.push(`ダブルス同一ペア: ${rules.maxSameDoublesPair} 回まで`);
  if (rules.maxHelpers !== undefined) lines.push(`助っ人: ${rules.maxHelpers} 名まで`);
  return lines;
}

/** A deep copy (formats, order inputs and versions never share one rule object). */
export function cloneLeagueRules(rules: LeagueRules): LeagueRules {
  return {
    ...(rules.maxPerStructure ? { maxPerStructure: { ...rules.maxPerStructure } } : {}),
    ...(rules.maxPerPlayKind ? { maxPerPlayKind: { ...rules.maxPerPlayKind } } : {}),
    ...(rules.maxSameDoublesPair !== undefined ? { maxSameDoublesPair: rules.maxSameDoublesPair } : {}),
    ...(rules.maxHelpers !== undefined ? { maxHelpers: rules.maxHelpers } : {}),
  };
}

/** The rules an order made with this format snapshots (`undefined` when it has none). */
export function leagueRulesSnapshot(rules: LeagueRules | null | undefined): LeagueRules | undefined {
  return hasLeagueRules(rules) ? cloneLeagueRules(rules) : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Reads stored or imported rules. Only known keys are kept. A value that is not a number is
 * kept as `NaN`, not dropped: dropping it would silently remove a rule, while `NaN` is
 * reported by `leagueRuleIssues` and blocks generation until the format is corrected.
 */
export function parseLeagueRules(value: unknown): LeagueRules | undefined {
  if (!isRecord(value)) return undefined;
  const read = (raw: unknown): number | undefined =>
    raw === undefined || raw === null ? undefined : typeof raw === 'number' ? raw : Number.NaN;
  const rules: LeagueRules = {};
  if (isRecord(value.maxPerStructure)) {
    const caps: Partial<Record<StructuralKind, number>> = {};
    for (const kind of STRUCTURAL_KINDS) {
      const cap = read(value.maxPerStructure[kind]);
      if (cap !== undefined) caps[kind] = cap;
    }
    if (Object.keys(caps).length > 0) rules.maxPerStructure = caps;
  }
  if (isRecord(value.maxPerPlayKind)) {
    const caps: Partial<Record<RulePlayKind, number>> = {};
    for (const kind of RULE_PLAY_KINDS) {
      const cap = read(value.maxPerPlayKind[kind]);
      if (cap !== undefined) caps[kind] = cap;
    }
    if (Object.keys(caps).length > 0) rules.maxPerPlayKind = caps;
  }
  const pair = read(value.maxSameDoublesPair);
  if (pair !== undefined) rules.maxSameDoublesPair = pair;
  const helpers = read(value.maxHelpers);
  if (helpers !== undefined) rules.maxHelpers = helpers;
  return hasLeagueRules(rules) ? rules : undefined;
}

/** Reads a stored participant status; anything unreadable is "not stated". */
export function parseLeagueStatus(value: unknown): LeagueStatus | undefined {
  return typeof value === 'string' && (LEAGUE_STATUSES as readonly string[]).includes(value)
    ? (value as LeagueStatus)
    : undefined;
}

// ---------------------------------------------------------------------------
// Editor text ↔ rules
// ---------------------------------------------------------------------------

/** One editable cap: `structure:SINGLES`, `play:G501`, `pair`, `helpers`. */
export type RuleCapKey = `structure:${StructuralKind}` | `play:${RulePlayKind}` | 'pair' | 'helpers';

/** What the editor's inputs hold. An empty string is "no rule"; `0` is a cap of zero. */
export type RuleCapText = Partial<Record<RuleCapKey, string>>;

/** The largest cap the editor accepts (no league plays more games than this in one order). */
export const MAX_RULE_CAP = 99;

export function leagueRulesToText(rules: LeagueRules | null | undefined): RuleCapText {
  const text: RuleCapText = {};
  if (!rules) return text;
  const put = (key: RuleCapKey, value: number | undefined): void => {
    // A damaged stored value is shown as it is (and fails validation), never blanked —
    // blanking it would quietly turn the rule off on the next save.
    if (value !== undefined) text[key] = String(value);
  };
  for (const kind of STRUCTURAL_KINDS) put(`structure:${kind}`, rules.maxPerStructure?.[kind]);
  for (const kind of RULE_PLAY_KINDS) put(`play:${kind}`, rules.maxPerPlayKind?.[kind]);
  put('pair', rules.maxSameDoublesPair);
  put('helpers', rules.maxHelpers);
  return text;
}

export type CapParse = { ok: true; value: number | undefined } | { ok: false; message: string };

/** Reads one cap input: blank = no rule, otherwise a whole number 0..MAX_RULE_CAP (全角数字可). */
export function parseCapText(raw: string | undefined): CapParse {
  const text = (raw ?? '').trim().replace(/[０-９]/g, (digit) => String.fromCharCode(digit.charCodeAt(0) - 0xfee0));
  if (text === '') return { ok: true, value: undefined };
  if (!/^\d+$/.test(text)) {
    return { ok: false, message: '0 以上の整数で入力してください (空欄 = 上限なし)。' };
  }
  const value = Number(text);
  if (value > MAX_RULE_CAP) return { ok: false, message: `${MAX_RULE_CAP} 以下で入力してください。` };
  return { ok: true, value };
}

export type RulesParse =
  | { ok: true; rules: LeagueRules | undefined }
  | { ok: false; errors: Partial<Record<RuleCapKey, string>> };

/** Builds the rules from the editor's inputs; any invalid input fails the whole set. */
export function leagueRulesFromText(text: RuleCapText): RulesParse {
  const errors: Partial<Record<RuleCapKey, string>> = {};
  const read = (key: RuleCapKey): number | undefined => {
    const parsed = parseCapText(text[key]);
    if (!parsed.ok) {
      errors[key] = parsed.message;
      return undefined;
    }
    return parsed.value;
  };
  const maxPerStructure: Partial<Record<StructuralKind, number>> = {};
  for (const kind of STRUCTURAL_KINDS) {
    const value = read(`structure:${kind}`);
    if (value !== undefined) maxPerStructure[kind] = value;
  }
  const maxPerPlayKind: Partial<Record<RulePlayKind, number>> = {};
  for (const kind of RULE_PLAY_KINDS) {
    const value = read(`play:${kind}`);
    if (value !== undefined) maxPerPlayKind[kind] = value;
  }
  const pair = read('pair');
  const helpers = read('helpers');
  if (Object.keys(errors).length > 0) return { ok: false, errors };
  const rules: LeagueRules = {
    ...(Object.keys(maxPerStructure).length > 0 ? { maxPerStructure } : {}),
    ...(Object.keys(maxPerPlayKind).length > 0 ? { maxPerPlayKind } : {}),
    ...(pair !== undefined ? { maxSameDoublesPair: pair } : {}),
    ...(helpers !== undefined ? { maxHelpers: helpers } : {}),
  };
  return { ok: true, rules: hasLeagueRules(rules) ? rules : undefined };
}
