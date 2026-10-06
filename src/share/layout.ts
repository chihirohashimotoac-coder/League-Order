import type {
  GameSlotDef,
  MatchInfo,
  OrderVersion,
  Player,
  PlayerId,
} from '../domain/types';
import { sortedGames } from '../domain/games/format';
import type {
  PlayerSchedule,
  ShareGameRow,
  ShareImageVariant,
  ShareLayout,
  ShareTallyRow,
  ShareVersionInfo,
  ShareableOrder,
} from './types';

/**
 * Pure layout helpers for sharing (docs/DESIGN.md 追補 §S1–§S6).
 *
 * Nothing here touches the DOM, a canvas or the optimizer: text measurement is injected,
 * so wrapping and pagination are unit-testable without a browser.
 */

export const GENERIC_TITLE = 'DARTS LEAGUE';
const EMPTY_SLOT = '(空席)';

/** `2026-10-08` → `2026/10/08`. Returns an empty string for an unset or invalid date. */
export function formatMatchDate(iso: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso.trim());
  return match ? `${match[1]}/${match[2]}/${match[3]}` : '';
}

/** `2026-10-08` → `10/8`, for the one-line text header. */
export function formatMatchDateShort(iso: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso.trim());
  if (!match) return '';
  return `${Number(match[2])}/${Number(match[3])}`;
}

/** `kalavinka vs Team B`, or just the team name when no opponent is set. */
export function matchupLine(match: MatchInfo): string {
  const team = match.teamName.trim();
  const opponent = match.opponentName.trim();
  if (!team && !opponent) return '';
  if (!opponent) return team;
  if (!team) return opponent;
  return `${team} vs ${opponent}`;
}

function nameLookup(players: readonly Player[]): (id: PlayerId) => string {
  const map = new Map(players.map((player) => [player.id, player.name]));
  return (id) => (id ? (map.get(id) ?? id) : EMPTY_SLOT);
}

function ratingLabel(
  solution: ShareableOrder,
  playerId: PlayerId,
): string {
  const tally = solution.tallies.find((entry) => entry.playerId === playerId);
  if (!tally || tally.effectiveRating === null) return 'Rt.—';
  const value = Number.isInteger(tally.effectiveRating)
    ? String(tally.effectiveRating)
    : tally.effectiveRating.toFixed(1);
  return `Rt.${value}${tally.ratingImputed ? '*' : ''}`;
}

export function buildGameRows(
  games: readonly GameSlotDef[],
  players: readonly Player[],
  solution: ShareableOrder,
): ShareGameRow[] {
  const nameOf = nameLookup(players);
  const byGame = new Map(solution.assignments.map((entry) => [entry.gameId, entry]));
  return sortedGames(games).map((game) => {
    const assignment = byGame.get(game.id);
    const playerNames = assignment ? assignment.playerIds.map(nameOf) : ['(未配置)'];
    return {
      no: `G${game.order}`,
      gameName: game.name,
      players: playerNames.join(' / '),
      playerNames,
    };
  });
}

/**
 * Builds the model a shared image or text is rendered from.
 *
 * The detail variant adds appearances, ratings, the order type and short notes. It
 * deliberately carries **no** optimisation score, pair score or search statistics: those
 * are for the captain's on-screen review, not for the team chat (要件 §4).
 */
export function buildShareLayout(
  games: readonly GameSlotDef[],
  players: readonly Player[],
  solution: ShareableOrder,
  match: MatchInfo,
  variant: ShareImageVariant,
  version?: ShareVersionInfo,
): ShareLayout {
  const nameOf = nameLookup(players);

  const tally: ShareTallyRow[] =
    variant === 'detail'
      ? [...solution.tallies]
          .sort(
            (a, b) =>
              b.count - a.count || nameOf(a.playerId).localeCompare(nameOf(b.playerId), 'ja'),
          )
          .map((entry) => ({
            name: nameOf(entry.playerId),
            rating: ratingLabel(solution, entry.playerId),
            count: entry.count,
            seasonTotal: entry.seasonTotal,
          }))
      : [];

  const notes: string[] = [];
  if (variant === 'detail') {
    if (solution.metrics.hasImputedRating) {
      notes.push('* Rating 未入力の選手は参加者の中央値を暫定値として扱っています');
    }
    if (solution.tallies.every((entry) => entry.effectiveRating === null)) {
      notes.push('* Rating は未登録です');
    }
  }

  return {
    variant,
    header: {
      title: match.leagueName.trim() || GENERIC_TITLE,
      teamName: match.teamName.trim(),
      opponentName: match.opponentName.trim(),
      dateText: formatMatchDate(match.matchDate),
      versionText: versionText(version),
      versionTone: versionTone(version),
    },
    games: buildGameRows(games, players, solution),
    tally,
    orderTypeLabel: variant === 'detail' ? solution.meta.label : '',
    notes,
  };
}

/**
 * Transposes an order into "player → the games they play" (要件 §5), so each member can
 * see their own schedule without scanning the whole sheet.
 */
/**
 * One-line version badge (追加要件 §6, §7).
 *
 * `ORDER v1` once finalized, `ORDER v2 · 更新版` for a re-finalization so a member can
 * tell at a glance that an earlier copy is superseded, and an explicit "未確定" marker
 * for a draft so an unconfirmed order is never mistaken for the real one.
 */
export function versionText(version?: ShareVersionInfo): string {
  if (!version) return '';
  if (version.draft) return '未確定 (DRAFT)';
  if (version.version <= 0) return '';
  return version.isUpdate ? `ORDER v${version.version} · 更新版` : `ORDER v${version.version}`;
}

export function versionTone(version?: ShareVersionInfo): ShareLayout['header']['versionTone'] {
  if (!version) return 'none';
  if (version.draft) return 'draft';
  if (version.version <= 0) return 'none';
  return version.isUpdate ? 'updated' : 'finalized';
}

/** Turns a finalized snapshot into something the share renderers can read. */
export function shareableFromVersion(version: OrderVersion): ShareableOrder {
  return {
    assignments: version.assignments,
    tallies: version.tallies,
    metrics: { hasImputedRating: version.hasImputedRating },
    meta: { label: version.label },
  };
}

/** The badge describing a stored version. */
export function versionInfoOf(version: OrderVersion): ShareVersionInfo {
  return { version: version.version, isUpdate: version.version > 1, draft: false };
}

export function buildPlayerSchedules(
  games: readonly GameSlotDef[],
  players: readonly Player[],
  solution: ShareableOrder,
): PlayerSchedule[] {
  const ordered = sortedGames(games);
  const nameOf = nameLookup(players);
  const byGame = new Map(solution.assignments.map((entry) => [entry.gameId, entry]));

  const schedules = new Map<PlayerId, PlayerSchedule>();
  const ensure = (playerId: PlayerId): PlayerSchedule => {
    const existing = schedules.get(playerId);
    if (existing) return existing;
    const created: PlayerSchedule = { playerId, name: nameOf(playerId), entries: [] };
    schedules.set(playerId, created);
    return created;
  };

  for (const game of ordered) {
    const assignment = byGame.get(game.id);
    if (!assignment) continue;
    for (const playerId of assignment.playerIds) {
      if (!playerId) continue;
      ensure(playerId).entries.push({
        no: `Game ${game.order}`,
        gameName: game.name,
        partners: assignment.playerIds.filter((other) => other && other !== playerId).map(nameOf),
      });
    }
  }

  // Players with no appearances still get an (empty) entry so nobody is silently missing.
  for (const tally of solution.tallies) ensure(tally.playerId);

  return [...schedules.values()].sort(
    (a, b) => b.entries.length - a.entries.length || a.name.localeCompare(b.name, 'ja'),
  );
}

// ---------------------------------------------------------------------------
// Text wrapping
// ---------------------------------------------------------------------------

/** Measures a string in the current context. Injected so wrapping is testable. */
export type MeasureText = (text: string) => number;

/** Characters a line may break on either side of: CJK, kana and full-width forms. */
const BREAKABLE = /[\u3000-\u303F\u3040-\u30FF\u3400-\u4DBF\u4E00-\u9FFF\uF900-\uFAFF\uFF00-\uFFEF]/;

/**
 * Splits text into units that a line may break between: each CJK character, each run of
 * Latin/digits, and each space. Latin words are therefore never broken mid-word while
 * Japanese wraps naturally.
 */
export function tokenize(text: string): string[] {
  const tokens: string[] = [];
  let latin = '';
  for (const char of text) {
    if (BREAKABLE.test(char) || char === ' ') {
      if (latin) {
        tokens.push(latin);
        latin = '';
      }
      tokens.push(char);
    } else {
      latin += char;
    }
  }
  if (latin) tokens.push(latin);
  return tokens;
}

/**
 * Wraps text to `maxWidth`, never truncating.
 *
 * A single token wider than the line (one very long unbroken word) is hard-broken by
 * character rather than overflowing, so nothing is ever clipped (要件 §13).
 */
export function wrapText(text: string, maxWidth: number, measure: MeasureText): string[] {
  if (!text) return [''];
  if (maxWidth <= 0 || measure(text) <= maxWidth) return [text];

  const lines: string[] = [];
  let current = '';

  const pushCurrent = (): void => {
    const trimmed = current.replace(/\s+$/, '');
    if (trimmed) lines.push(trimmed);
    current = '';
  };

  const hardBreak = (token: string): void => {
    let chunk = '';
    for (const char of token) {
      if (chunk && measure(chunk + char) > maxWidth) {
        lines.push(chunk);
        chunk = char;
      } else {
        chunk += char;
      }
    }
    current = chunk;
  };

  for (const token of tokenize(text)) {
    if (!current && token === ' ') continue;
    const candidate = current + token;
    if (measure(candidate) <= maxWidth) {
      current = candidate;
      continue;
    }
    pushCurrent();
    if (measure(token) > maxWidth) hardBreak(token);
    else current = token === ' ' ? '' : token;
  }
  pushCurrent();

  return lines.length > 0 ? lines : [text];
}

// ---------------------------------------------------------------------------
// Pagination
// ---------------------------------------------------------------------------

/**
 * Packs measured block heights into pages (要件 §10).
 *
 * Blocks are never shrunk and never dropped: a block taller than a whole page gets a
 * page to itself. Returns the block indices belonging to each page.
 */
export function paginate(heights: readonly number[], maxContentHeight: number): number[][] {
  if (heights.length === 0) return [[]];
  const pages: number[][] = [];
  let current: number[] = [];
  let used = 0;

  for (let index = 0; index < heights.length; index += 1) {
    const height = heights[index];
    if (current.length > 0 && used + height > maxContentHeight) {
      pages.push(current);
      current = [];
      used = 0;
    }
    current.push(index);
    used += height;
  }
  if (current.length > 0) pages.push(current);
  return pages;
}
