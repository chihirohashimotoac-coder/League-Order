import type { GameSlotDef, MatchInfo, OrderSolution, Player } from '../domain/types';
import {
  GENERIC_TITLE,
  buildGameRows,
  buildPlayerSchedules,
  buildShareLayout,
  formatMatchDate,
  formatMatchDateShort,
  matchupLine,
} from './layout';
import type { PlayerSchedule, ShareTextFormat } from './types';

/**
 * Text renderers for sharing (要件 §6, docs/DESIGN.md 追補 §S5).
 *
 * Pure: the same functions back the clipboard, the OS share sheet and the on-screen
 * preview. Decoration is kept minimal — a single emoji in the LINE variant and nothing
 * in the others — so the text stays readable when a chat app reflows it.
 */

/** Drops leading/trailing blank lines and collapses runs of 3+ blank lines to 1. */
function tidy(lines: readonly string[]): string {
  return lines
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/^\n+|\n+$/g, '');
}

function headerLines(match: MatchInfo, options: { emoji: boolean; shortDate: boolean }): string[] {
  const title = match.leagueName.trim() || GENERIC_TITLE;
  const date = options.shortDate ? formatMatchDateShort(match.matchDate) : formatMatchDate(match.matchDate);
  const lead = [date, title].filter(Boolean).join(' ');
  const matchup = matchupLine(match);
  return [options.emoji ? `🎯 ${lead}` : lead, matchup].filter((line) => line.trim().length > 0);
}

/** LINE-oriented: one emoji, a full-width separator, player names on their own line. */
export function renderLineText(
  games: readonly GameSlotDef[],
  players: readonly Player[],
  solution: OrderSolution,
  match: MatchInfo,
): string {
  const rows = buildGameRows(games, players, solution);
  const body = rows.flatMap((row) => [`${row.no}｜${row.gameName}`, row.players, '']);
  return tidy([...headerLines(match, { emoji: true, shortDate: true }), '', ...body]);
}

/** Plain variant: no emoji, one line per game. */
export function renderSimpleText(
  games: readonly GameSlotDef[],
  players: readonly Player[],
  solution: OrderSolution,
  match: MatchInfo,
): string {
  const rows = buildGameRows(games, players, solution);
  return tidy([
    ...headerLines(match, { emoji: false, shortDate: false }),
    '',
    ...rows.map((row) => `${row.no} ${row.gameName} : ${row.players}`),
  ]);
}

/**
 * Captain's record: adds appearances, ratings, the order type and notes.
 *
 * It still omits the optimisation score, the component percentages and the search
 * statistics — those belong on the result screen, not in a shared message (要件 §4).
 */
export function renderDetailText(
  games: readonly GameSlotDef[],
  players: readonly Player[],
  solution: OrderSolution,
  match: MatchInfo,
): string {
  const layout = buildShareLayout(games, players, solution, match, 'detail');
  const lines: string[] = [...headerLines(match, { emoji: false, shortDate: false }), ''];

  lines.push('--- ORDER ---');
  for (const row of layout.games) lines.push(`${row.no} ${row.gameName} : ${row.players}`);

  lines.push('', '--- 出場回数 ---');
  for (const row of layout.tally) {
    lines.push(`${row.name} ${row.rating} 今回${row.count}回 / Season${row.seasonTotal}回`);
  }

  if (layout.orderTypeLabel) lines.push('', `オーダータイプ: ${layout.orderTypeLabel}`);
  if (layout.notes.length > 0) lines.push('', ...layout.notes);

  return tidy(lines);
}

export function renderShareText(
  games: readonly GameSlotDef[],
  players: readonly Player[],
  solution: OrderSolution,
  match: MatchInfo,
  format: ShareTextFormat,
): string {
  switch (format) {
    case 'line':
      return renderLineText(games, players, solution, match);
    case 'simple':
      return renderSimpleText(games, players, solution, match);
    case 'detail':
      return renderDetailText(games, players, solution, match);
    default:
      return renderSimpleText(games, players, solution, match);
  }
}

/** One player's own schedule (要件 §5). */
export function renderPlayerText(schedule: PlayerSchedule, match: MatchInfo): string {
  const lines: string[] = [...headerLines(match, { emoji: false, shortDate: false }), '', schedule.name, ''];

  if (schedule.entries.length === 0) {
    lines.push('出場なし');
    return tidy(lines);
  }

  for (const entry of schedule.entries) {
    lines.push(entry.no, entry.gameName);
    if (entry.partners.length > 0) lines.push(`Partner: ${entry.partners.join(' / ')}`);
    lines.push('');
  }
  return tidy(lines);
}

/** Every player's schedule in one message, for pasting into the team chat. */
export function renderAllPlayersText(
  games: readonly GameSlotDef[],
  players: readonly Player[],
  solution: OrderSolution,
  match: MatchInfo,
): string {
  const schedules = buildPlayerSchedules(games, players, solution);
  const blocks = schedules.map((schedule) => {
    const lines: string[] = [`■ ${schedule.name}`];
    if (schedule.entries.length === 0) {
      lines.push('出場なし');
      return lines.join('\n');
    }
    for (const entry of schedule.entries) {
      const partners = entry.partners.length > 0 ? ` (Partner: ${entry.partners.join(' / ')})` : '';
      lines.push(`${entry.no} ${entry.gameName}${partners}`);
    }
    return lines.join('\n');
  });

  return tidy([...headerLines(match, { emoji: false, shortDate: false }), '', blocks.join('\n\n')]);
}
