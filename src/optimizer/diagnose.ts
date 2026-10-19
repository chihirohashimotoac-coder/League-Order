import type {
  Diagnostic,
  DiagnosticSuggestion,
  OrderInput,
  ParticipantConfig,
} from '../domain/types';
import { checkEligibility } from './constraints/eligibility';
import { buildAllCandidates, type GameCandidates } from './candidates/combinations';
import { prepare } from './prepare';
import { buildBoundContext } from './search/bound';
import { beamSearch } from './search/beam';
import { dfsSearch } from './search/dfs';
import { minAppearancesFor } from '../domain/orders/participants';
import {
  leagueRuleIssues,
  leagueStatusOf,
  needsLeagueStatus,
  perPlayerLimits,
} from '../domain/orders/leagueRules';
import type { PreparedContext } from './prepare';

/**
 * Infeasibility diagnostics (spec §31).
 *
 * Constraints are never silently relaxed. Instead, when no line-up exists the engine
 * explains *which* constraints conflict and *what single change* would make the order
 * possible — e.g. "allow Player X to play Trios", or "raise Player Y's maximum
 * appearances to 3".
 */

/** Static checks that do not require searching. Cheap, so always run before a search. */
export function precheck(input: OrderInput): Diagnostic[] {
  const diagnostics: Diagnostic[] = [];
  const ctx = prepare(input);
  const playerName = (index: number): string => ctx.players[index]?.name ?? '不明な選手';

  if (ctx.gameCount === 0) {
    diagnostics.push({
      code: 'NO_GAMES',
      message: 'フォーマットにゲームが登録されていません。',
      suggestions: [{ kind: 'other', message: 'FORMAT 画面でゲームを 1 つ以上追加してください。' }],
    });
    return diagnostics;
  }

  if (ctx.playerCount === 0) {
    diagnostics.push({
      code: 'NO_PARTICIPANTS',
      message: '参加者が 1 名も選択されていません。',
      suggestions: [{ kind: 'addParticipant', message: 'ORDER SETUP 画面で参加者を選択してください。' }],
    });
    return diagnostics;
  }

  for (const game of ctx.games) {
    // A fractional head count is as unusable as a missing one: no assignment can ever
    // match it, so it is reported here rather than surfacing as "no order found".
    if (!Number.isInteger(game.playerCount) || game.playerCount < 1) {
      diagnostics.push({
        code: 'INVALID_GAME',
        gameId: game.id,
        message: `${game.name}: 必要人数 (${game.playerCount}) が 1 以上の整数ではありません。`,
        suggestions: [{ kind: 'other', message: '必要人数を 1 以上の整数に設定してください。', gameId: game.id }],
      });
    }
  }
  // The remaining checks reason about head counts arithmetically, so there is nothing
  // meaningful to add until the format itself is valid.
  if (diagnostics.length > 0) return diagnostics;

  // League rules that cannot be read, or a helper rule with players whose status is not
  // stated: nothing can be checked, so nothing is generated (and nobody is assumed REGULAR).
  diagnostics.push(...leagueRuleBlockers(ctx));
  if (diagnostics.length > 0) return diagnostics;

  // Per-game eligibility.
  for (let gi = 0; gi < ctx.gameCount; gi += 1) {
    const game = ctx.games[gi];
    const eligibleCount = ctx.eligibleLists[gi].length;
    if (eligibleCount >= game.playerCount) continue;

    const blocked = ctx.configs
      .map((config, pi) => ({ config, pi, reason: checkEligibility(config, game) }))
      .filter((entry) => entry.reason !== null);

    const suggestions: DiagnosticSuggestion[] = blocked.map((entry) => ({
      kind: 'allowPlayerInGame',
      playerId: entry.config.playerId,
      gameId: game.id,
      message: `${playerName(entry.pi)} の制約を解除する (理由: ${entry.reason?.message})`,
    }));
    // A league rule cap of 0 rules players out too; the rule is the league's, so it is named
    // rather than offered as something to relax.
    const ruleBlocked = ctx.configs
      .map((config, pi) => ({ pi, reason: checkEligibility(config, game) === null ? ctx.leagueRules?.blocked[gi][pi] : null }))
      .filter((entry): entry is { pi: number; reason: string } => !!entry.reason);
    if (ruleBlocked.length > 0) {
      suggestions.push({
        kind: 'other',
        gameId: game.id,
        message: `リーグ規則 (必須条件) で出場できない選手: ${ruleBlocked.map((entry) => `${playerName(entry.pi)} (${entry.reason})`).join('、')}`,
      });
    }
    const notIncluded = input.participants.filter((config) => !config.include);
    for (const config of notIncluded.slice(0, 5)) {
      const player = input.players.find((p) => p.id === config.playerId);
      if (!player) continue;
      suggestions.push({
        kind: 'addParticipant',
        playerId: config.playerId,
        gameId: game.id,
        message: `${player.name} を参加者に追加する`,
      });
    }

    diagnostics.push({
      code: 'GAME_INSUFFICIENT_ELIGIBLE',
      gameId: game.id,
      message: `${game.name} は ${game.playerCount} 名必要ですが、出場可能なのは ${eligibleCount} 名のみです。`,
      playerIds: ctx.eligibleLists[gi].map((pi) => ctx.playerIds[pi]),
      suggestions,
    });
  }

  // Capacity: can the sum of maximums even cover every slot?
  const capacity = ctx.maxAppearances.reduce((acc, value) => acc + value, 0);
  if (capacity < ctx.totalSlots) {
    const needed = Math.ceil(ctx.totalSlots / ctx.playerCount);
    diagnostics.push({
      code: 'CAPACITY_TOO_LOW',
      message: `総枠数 ${ctx.totalSlots} に対し、最大出場回数の合計が ${capacity} しかありません。`,
      suggestions: [
        {
          kind: 'raiseMaxAppearances',
          value: needed,
          message: `全員の最大出場回数を ${needed} 回以上にすると枠を埋められます。`,
        },
      ],
    });
  }

  diagnostics.push(...leagueRuleCapacity(ctx));

  // Minimum appearances. These are only blockers when the minimum is a hard constraint;
  // in soft mode an unreachable minimum is reported as a warning on the result instead.
  const minIsHard = input.settings.minAppearanceMode === 'hard';
  const minTotal = input.participants
    .filter((config) => config.include)
    .reduce((acc, config) => acc + minAppearancesFor(config), 0);
  if (minIsHard && minTotal > ctx.totalSlots) {
    diagnostics.push({
      code: 'MIN_TOTAL_TOO_HIGH',
      message: `最小出場回数の合計 ${minTotal} が総枠数 ${ctx.totalSlots} を超えています。`,
      suggestions: [
        {
          kind: 'lowerMinAppearances',
          message: `最小出場回数の合計を ${ctx.totalSlots} 以下に下げてください。`,
          value: ctx.totalSlots,
        },
      ],
    });
  }

  // Per-player reachability of the minimum.
  for (let pi = 0; minIsHard && pi < ctx.playerCount; pi += 1) {
    const min = ctx.minAppearances[pi];
    if (min <= 0) continue;
    const available = ctx.eligible.reduce((acc, row) => acc + (row[pi] ? 1 : 0), 0);
    if (available < min) {
      diagnostics.push({
        code: 'MIN_UNREACHABLE',
        playerIds: [ctx.playerIds[pi]],
        message: `${playerName(pi)}: 最小出場回数 ${min} に対し、出場可能なゲームが ${available} しかありません。`,
        suggestions: [
          {
            kind: 'lowerMinAppearances',
            playerId: ctx.playerIds[pi],
            value: available,
            message: `${playerName(pi)} の最小出場回数を ${available} 以下にする`,
          },
          {
            kind: 'allowPlayerInGame',
            playerId: ctx.playerIds[pi],
            message: `${playerName(pi)} の出場不可／出場可能範囲の設定を緩める`,
          },
        ],
      });
    }
    if (min > ctx.maxAppearances[pi]) {
      diagnostics.push({
        code: 'MIN_UNREACHABLE',
        playerIds: [ctx.playerIds[pi]],
        message: `${playerName(pi)}: 最小出場回数 ${min} が最大出場回数 ${ctx.maxAppearances[pi]} を超えています。`,
        suggestions: [
          {
            kind: 'raiseMaxAppearances',
            playerId: ctx.playerIds[pi],
            value: min,
            message: `${playerName(pi)} の最大出場回数を ${min} 以上にする`,
          },
        ],
      });
    }
  }

  // Locks that cannot be honoured.
  for (const invalid of ctx.invalidLocks) {
    diagnostics.push({
      code: 'LOCK_INVALID',
      gameId: invalid.lock.gameId,
      playerIds: [invalid.lock.playerId],
      message: `ロックを適用できません: ${invalid.reason}。`,
      suggestions: [
        {
          kind: 'removeLock',
          gameId: invalid.lock.gameId,
          playerId: invalid.lock.playerId,
          message: 'このロックを解除する',
        },
        {
          kind: 'allowPlayerInGame',
          gameId: invalid.lock.gameId,
          playerId: invalid.lock.playerId,
          message: 'ロックされた選手がそのゲームに出場できるよう制約を緩める',
        },
      ],
    });
  }

  // A game where every combination is blocked by a forbidden pair.
  const candidates = buildAllCandidates(ctx);
  for (let gi = 0; gi < ctx.gameCount; gi += 1) {
    if (candidates[gi].combos.length > 0) continue;
    if (ctx.eligibleLists[gi].length < ctx.games[gi].playerCount) continue; // already reported
    diagnostics.push({
      code: 'GAME_ALL_COMBOS_FORBIDDEN',
      gameId: ctx.games[gi].id,
      message: `${ctx.games[gi].name}: 出場可能な人数は足りていますが、禁止ペアまたはロックの組み合わせにより有効な組が 1 つもありません。`,
      suggestions: [
        {
          kind: 'relaxForbiddenPair',
          gameId: ctx.games[gi].id,
          message: '該当選手間の「禁止」ペア設定を「非推奨」に変更する',
        },
        {
          kind: 'removeLock',
          gameId: ctx.games[gi].id,
          message: 'このゲームのロックを解除する',
        },
        {
          kind: 'addParticipant',
          gameId: ctx.games[gi].id,
          message: '参加者を追加する',
        },
      ],
    });
  }

  return diagnostics;
}

/** Rules that cannot be checked at all: unreadable caps, or unstated statuses under a helper rule. */
function leagueRuleBlockers(ctx: PreparedContext): Diagnostic[] {
  const rules = ctx.input.leagueRules;
  if (!ctx.leagueRules || !rules) return [];
  const issues = leagueRuleIssues(rules);
  if (issues.length > 0) {
    return [
      {
        code: 'LEAGUE_RULE_INVALID',
        message: `リーグ規則の値を読み取れません: ${issues.join(' ')}`,
        suggestions: [{ kind: 'other', message: 'フォーマット画面のリーグ規則で上限を 0 以上の整数に直してから生成してください。' }],
      },
    ];
  }
  if (!needsLeagueStatus(rules)) return [];
  const unstated = ctx.configs
    .map((config, pi) => ({ config, pi }))
    .filter((entry) => leagueStatusOf(entry.config) === null);
  if (unstated.length === 0) return [];
  return [
    {
      code: 'LEAGUE_STATUS_UNSET',
      message: `助っ人の人数上限 (${rules.maxHelpers} 名) を確認するには、参加者全員の大会資格が必要です。未設定: ${unstated
        .map((entry) => ctx.players[entry.pi].name)
        .join('、')}`,
      playerIds: unstated.map((entry) => entry.config.playerId),
      suggestions: [
        {
          kind: 'other',
          message: 'オーダー設定の参加者の「条件」で、正規登録か助っ人かを選んでください (未設定のまま正規登録とはみなしません)。',
        },
      ],
    },
  ];
}

/**
 * Counting arguments that need no search: a capped category with more slots than the
 * participants may fill under the cap, and more slots than regulars plus the allowed number
 * of helpers can cover.
 */
function leagueRuleCapacity(ctx: PreparedContext): Diagnostic[] {
  const rules = ctx.leagueRules;
  const source = ctx.input.leagueRules;
  if (!rules || !source) return [];
  const diagnostics: Diagnostic[] = [];
  const eligibleGames = (pi: number, matches: (gi: number) => boolean): number =>
    ctx.eligible.reduce((acc, row, gi) => acc + (row[pi] && matches(gi) ? 1 : 0), 0);

  perPlayerLimits(source).forEach((limit, k) => {
    const compiled = rules.limits[k];
    const slots = ctx.games.reduce((acc, game, gi) => acc + (compiled.games[gi] ? game.playerCount : 0), 0);
    if (slots === 0) return;
    let capacity = 0;
    for (let pi = 0; pi < ctx.playerCount; pi += 1) {
      capacity += Math.min(compiled.cap, ctx.maxAppearances[pi], eligibleGames(pi, (gi) => compiled.games[gi]));
    }
    if (capacity >= slots) return;
    diagnostics.push({
      code: 'LEAGUE_RULE_CAPACITY',
      message: `${limit.label} のゲームは ${slots} 枠ありますが、リーグ規則 (1人 ${limit.cap} 回まで) と出場条件の範囲では参加者 ${ctx.playerCount} 名で最大 ${capacity} 枠しか埋められません。`,
      suggestions: [
        { kind: 'addParticipant', message: `${limit.label} に出場できる参加者を追加する` },
        { kind: 'allowPlayerInGame', message: `${limit.label} の出場不可・最大出場回数の設定を見直す` },
      ],
    });
  });

  if (Number.isFinite(rules.helperCap)) {
    const capacity = (pi: number): number => Math.min(ctx.maxAppearances[pi], eligibleGames(pi, () => true));
    let regular = 0;
    const helpers: number[] = [];
    for (let pi = 0; pi < ctx.playerCount; pi += 1) {
      if (rules.isHelper[pi]) helpers.push(capacity(pi));
      else regular += capacity(pi);
    }
    helpers.sort((a, b) => b - a);
    const reachable = regular + helpers.slice(0, Math.max(0, rules.helperCap)).reduce((acc, value) => acc + value, 0);
    if (reachable < ctx.totalSlots) {
      diagnostics.push({
        code: 'LEAGUE_RULE_CAPACITY',
        message: `総枠 ${ctx.totalSlots} に対し、正規登録の参加者と助っ人 ${rules.helperCap} 名までで埋められるのは最大 ${reachable} 枠です (リーグ規則)。`,
        suggestions: [
          { kind: 'addParticipant', message: '正規登録の参加者を追加する' },
          { kind: 'raiseMaxAppearances', message: '正規登録の参加者の最大出場回数を見直す' },
        ],
      });
    }
  }
  return diagnostics;
}

/** One concrete relaxation to try when the search itself comes up empty. */
interface Relaxation {
  describe: string;
  suggestion: DiagnosticSuggestion;
  apply(input: OrderInput): OrderInput;
}

function withParticipant(
  input: OrderInput,
  playerId: string,
  update: (config: ParticipantConfig) => ParticipantConfig,
): OrderInput {
  return {
    ...input,
    participants: input.participants.map((config) =>
      config.playerId === playerId ? update(config) : config,
    ),
  };
}

/** Quick feasibility probe: does *any* complete line-up exist? */
function feasible(input: OrderInput, budgetMs: number): boolean {
  const ctx = prepare(input);
  if (ctx.gameCount === 0 || ctx.playerCount === 0) return false;
  if (ctx.invalidLocks.length > 0) return false;
  const candidates: GameCandidates[] = buildAllCandidates(ctx);
  if (candidates.some((entry) => entry.combos.length === 0)) return false;
  const bctx = buildBoundContext(ctx, candidates);
  const result = beamSearch(ctx, bctx, candidates, {
    width: Math.max(16, ctx.input.settings.beamWidth),
    deadline: performance.now() + budgetMs,
  });
  if (result.feasible && result.solutions.length > 0) return true;
  // With league rules the beam can dead-end while a line-up exists (see `searchOnce`).
  if (ctx.leagueRules === null) return false;
  return dfsSearch(ctx, bctx, candidates, {
    deadline: performance.now() + budgetMs,
    nodeLimit: ctx.input.settings.nodeLimit,
    incumbent: Number.NEGATIVE_INFINITY,
    fairnessUrgency: 0,
  }).foundAny;
}

/**
 * Builds relaxation candidates and reports which single change makes the order
 * feasible. Each probe is a real feasibility search, so a reported remedy is one that
 * genuinely works rather than a guess.
 */
export function analyseRelaxations(input: OrderInput, budgetMs = 400): DiagnosticSuggestion[] {
  const ctx = prepare(input);
  const relaxations: Relaxation[] = [];

  // Raise everybody's max appearances one step at a time.
  const currentMax = Math.max(...ctx.maxAppearances, 0);
  for (let target = currentMax + 1; target <= Math.min(ctx.gameCount, currentMax + 3); target += 1) {
    relaxations.push({
      describe: `最大出場回数を全員 ${target} 回にする`,
      suggestion: {
        kind: 'raiseMaxAppearances',
        value: target,
        message: `最大出場回数を全員 ${target} 回に引き上げると生成できます。`,
      },
      apply: (base) => ({
        ...base,
        participants: base.participants.map((config) => ({ ...config, maxAppearances: target })),
      }),
    });
  }

  // Drop each player's minimum appearances.
  for (let pi = 0; pi < ctx.playerCount; pi += 1) {
    if (ctx.minAppearances[pi] <= 0) continue;
    const playerId = ctx.playerIds[pi];
    const name = ctx.players[pi].name;
    relaxations.push({
      describe: `${name} の最小出場回数を解除する`,
      suggestion: {
        kind: 'lowerMinAppearances',
        playerId,
        message: `${name} の最小出場回数を解除すると生成できます。`,
      },
      apply: (base) =>
        withParticipant(base, playerId, (config) => ({ ...config, minAppearances: undefined })),
    });
  }

  // Clear each player's game/kind exclusions and window.
  for (let pi = 0; pi < ctx.playerCount; pi += 1) {
    const config = ctx.configs[pi];
    if (
      config.excludedGameIds.length === 0 &&
      config.excludedKinds.length === 0 &&
      !config.window
    ) {
      continue;
    }
    const playerId = config.playerId;
    const name = ctx.players[pi].name;
    relaxations.push({
      describe: `${name} の出場不可・出場可能範囲を解除する`,
      suggestion: {
        kind: 'allowPlayerInGame',
        playerId,
        message: `${name} の出場不可／出場可能範囲を解除すると生成できます。`,
      },
      apply: (base) =>
        withParticipant(base, playerId, (current) => ({
          ...current,
          excludedGameIds: [],
          excludedKinds: [],
          window: undefined,
        })),
    });
  }

  // Add each currently-excluded player to the roster.
  for (const config of input.participants) {
    if (config.include) continue;
    const player = input.players.find((p) => p.id === config.playerId);
    if (!player) continue;
    relaxations.push({
      describe: `${player.name} を参加者に追加する`,
      suggestion: {
        kind: 'addParticipant',
        playerId: config.playerId,
        message: `${player.name} を参加者に追加すると生成できます。`,
      },
      apply: (base) => withParticipant(base, config.playerId, (c) => ({ ...c, include: true })),
    });
  }

  // Relax the consecutive limit when it is hard.
  if (input.settings.consecutiveMode === 'hard') {
    relaxations.push({
      describe: '連続出場制限を「できるだけ考慮」にする',
      suggestion: {
        kind: 'relaxConsecutive',
        message: '最大連続出場の扱いを「絶対条件」から「できるだけ考慮」に変更すると生成できます。',
      },
      apply: (base) => ({ ...base, settings: { ...base.settings, consecutiveMode: 'soft' } }),
    });
  }

  // Drop the forbidden-pair constraints.
  if (input.pairs.some((pair) => pair.affinity === 'FORBIDDEN')) {
    relaxations.push({
      describe: '禁止ペアを解除する',
      suggestion: {
        kind: 'relaxForbiddenPair',
        message: '禁止ペア設定を「非推奨」に変更すると生成できます。',
      },
      apply: (base) => ({
        ...base,
        pairs: base.pairs.map((pair) =>
          pair.affinity === 'FORBIDDEN' ? { ...pair, affinity: 'DISCOURAGED' as const } : pair,
        ),
      }),
    });
  }

  // Remove all locks.
  if (input.locks.length > 0) {
    relaxations.push({
      describe: 'ロックを全て解除する',
      suggestion: { kind: 'removeLock', message: 'ロックを全て解除すると生成できます。' },
      apply: (base) => ({ ...base, locks: [] }),
    });
  }

  const found: DiagnosticSuggestion[] = [];
  const deadline = performance.now() + budgetMs * 4;
  for (const relaxation of relaxations) {
    if (performance.now() > deadline) break;
    if (feasible(relaxation.apply(input), budgetMs)) found.push(relaxation.suggestion);
    if (found.length >= 6) break;
  }
  return found;
}
