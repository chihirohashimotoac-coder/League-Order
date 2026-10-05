import type { GameSlotDef, MatchInfo, Player } from '../domain/types';
import type { OrderDiff } from '../domain/orders/lifecycle';
import {
  GENERIC_TITLE,
  buildGameRows,
  buildPlayerSchedules,
  buildShareLayout,
  formatMatchDate,
  formatMatchDateShort,
  matchupLine,
  versionText,
} from './layout';
import type { PlayerSchedule, ShareTextFormat, ShareVersionInfo, ShareableOrder } from './types';

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

function headerLines(
  match: MatchInfo,
  options: { emoji: boolean; shortDate: boolean },
  version?: ShareVersionInfo,
): string[] {
  const title = match.leagueName.trim() || GENERIC_TITLE;
  const date = options.shortDate ? formatMatchDateShort(match.matchDate) : formatMatchDate(match.matchDate);
  const lead = [date, title].filter(Boolean).join(' ');
  const matchup = matchupLine(match);
  return [options.emoji ? `🎯 ${lead}` : lead, matchup, versionText(version)].filter(
    (line) => line.trim().length > 0,
  );
}

/** LINE-oriented: one emoji, a full-width separator, player names on their own line. */
export function renderLineText(
  games: readonly GameSlotDef[],
  players: readonly Player[],
  solution: ShareableOrder,
  match: MatchInfo,
  version?: ShareVersionInfo,
): string {
  const rows = buildGameRows(games, players, solution);
  const body = rows.flatMap((row) => [`${row.no}｜${row.gameName}`, row.players, '']);
  return tidy([...headerLines(match, { emoji: true, shortDate: true }, version), '', ...body]);
}

/** Plain variant: no emoji, one line per game. */
export function renderSimpleText(
  games: readonly GameSlotDef[],
  players: readonly Player[],
  solution: ShareableOrder,
  match: MatchInfo,
  version?: ShareVersionInfo,
): string {
  const rows = buildGameRows(games, players, solution);
  return tidy([
    ...headerLines(match, { emoji: false, shortDate: false }, version),
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
  solution: ShareableOrder,
  match: MatchInfo,
  version?: ShareVersionInfo,
): string {
  const layout = buildShareLayout(games, players, solution, match, 'detail', version);
  const lines: string[] = [...headerLines(match, { emoji: false, shortDate: false }, version), ''];

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

/**
 * "Order changed" message for a re-finalized order (追加要件 §10).
 *
 * Leads with the change itself, because that is the only part a member who already has
 * the previous copy needs to read. `includeFullOrder` appends the complete current
 * order for anyone who missed the earlier message, which is the second of the two forms
 * the requirement asks for.
 */
export function renderUpdateText(
  games: readonly GameSlotDef[],
  players: readonly Player[],
  solution: ShareableOrder,
  match: MatchInfo,
  diff: OrderDiff,
  version: ShareVersionInfo,
  options: { includeFullOrder: boolean },
): string {
  const title = match.leagueName.trim() || GENERIC_TITLE;
  const date = formatMatchDateShort(match.matchDate);
  const lead = [date, title].filter(Boolean).join(' ');
  const lines: string[] = [
    `🎯 オーダー変更 v${version.version}`,
    [lead, matchupLine(match)].filter(Boolean).join(' / '),
    '',
  ];

  if (diff.changes.length === 0) {
    lines.push('変更はありません。');
  } else {
    lines.push('変更：');
    for (const row of diff.changes) {
      lines.push(`G${row.order} ${row.gameName}`);
      if (row.kind === 'added') {
        lines.push('(追加)', `↓`, row.afterNames.join(' / ') || '(未配置)');
      } else if (row.kind === 'removed') {
        lines.push(row.beforeNames.join(' / ') || '(未配置)', '↓', '(削除)');
      } else {
        lines.push(row.beforeNames.join(' / ') || '(未配置)', '↓', row.afterNames.join(' / ') || '(未配置)');
      }
      lines.push('');
    }
  }

  if (options.includeFullOrder) {
    lines.push('【最新オーダー】');
    for (const row of buildGameRows(games, players, solution)) {
      lines.push(`${row.no} ${row.gameName} : ${row.players}`);
    }
  }

  return tidy(lines);
}

export interface ShareTextContext {
  diff?: OrderDiff;
  version?: ShareVersionInfo;
}

export function renderShareText(
  games: readonly GameSlotDef[],
  players: readonly Player[],
  solution: ShareableOrder,
  match: MatchInfo,
  format: ShareTextFormat,
  context: ShareTextContext = {},
): string {
  const { version, diff } = context;
  switch (format) {
    case 'line':
      return renderLineText(games, players, solution, match, version);
    case 'simple':
      return renderSimpleText(games, players, solution, match, version);
    case 'detail':
      return renderDetailText(games, players, solution, match, version);
    case 'updateDiff':
    case 'updateFull':
      // Without a diff or a version there is nothing to describe as a change; fall back
      // to the ordinary LINE message rather than emitting an empty "changed" notice.
      if (!diff || !version) return renderLineText(games, players, solution, match, version);
      return renderUpdateText(games, players, solution, match, diff, version, {
        includeFullOrder: format === 'updateFull',
      });
    default:
      return renderSimpleText(games, players, solution, match, version);
  }
}

/** One player's own schedule (要件 §5). */
export function renderPlayerText(
  schedule: PlayerSchedule,
  match: MatchInfo,
  version?: ShareVersionInfo,
): string {
  const lines: string[] = [
    ...headerLines(match, { emoji: false, shortDate: false }, version),
    '',
    schedule.name,
    '',
  ];

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
  solution: ShareableOrder,
  match: MatchInfo,
  version?: ShareVersionInfo,
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

  return tidy([
    ...headerLines(match, { emoji: false, shortDate: false }, version),
    '',
    blocks.join('\n\n'),
  ]);
}
