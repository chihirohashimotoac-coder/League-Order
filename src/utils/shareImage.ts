import type { GameSlotDef, OrderSolution, Player } from '../domain/types';
import { sortedGames } from '../domain/games/format';

/**
 * Portrait share image (spec §22, design D-15).
 *
 * Drawn directly with the Canvas 2D API rather than via a DOM-to-image library: no extra
 * dependency, no webfont loading race, and full control over the aspect ratio. The output
 * is a tall PNG sized for a phone screen, which is what gets forwarded to LINE.
 */
export interface ShareImageOptions {
  title: string;
  subtitle?: string;
  /** Device pixel scale. 2 gives a crisp image on phones without a huge file. */
  scale?: number;
}

const WIDTH = 540;
const PADDING = 28;
const COLORS = {
  background: '#0f1623',
  card: '#182131',
  cardAlt: '#1e293b',
  accent: '#38bdf8',
  text: '#f1f5f9',
  muted: '#94a3b8',
  line: '#334155',
};

interface Row {
  left: string;
  right: string;
  emphasis?: boolean;
}

/** Returns a PNG data URL, or `null` when canvas is unavailable. */
export function renderOrderImage(
  games: readonly GameSlotDef[],
  players: readonly Player[],
  solution: OrderSolution,
  options: ShareImageOptions,
): string | null {
  const scale = options.scale ?? 2;
  const nameById = new Map(players.map((player) => [player.id, player.name]));
  const ordered = sortedGames(games);
  const byGame = new Map(solution.assignments.map((a) => [a.gameId, a]));

  const orderRows: Row[] = ordered.map((game) => {
    const assignment = byGame.get(game.id);
    const members =
      assignment?.playerIds.map((id) => nameById.get(id) ?? '(空席)').join(' / ') ?? '(未配置)';
    return { left: `${game.order}. ${game.name}`, right: members, emphasis: true };
  });

  const tallyRows: Row[] = [...solution.tallies]
    .sort((a, b) => b.count - a.count || (a.playerId < b.playerId ? -1 : 1))
    .map((tally) => ({
      left: nameById.get(tally.playerId) ?? tally.playerId,
      right: `${tally.effectiveRating === null ? 'R-' : `R${tally.effectiveRating}${tally.ratingImputed ? '*' : ''}`}  今回${tally.count}  季${tally.seasonTotal}`,
    }));

  const headerHeight = options.subtitle ? 104 : 80;
  const rowHeight = 38;
  const sectionGap = 26;
  const summaryHeight = 92;
  const height =
    headerHeight +
    sectionGap +
    32 + orderRows.length * rowHeight +
    sectionGap +
    32 + tallyRows.length * rowHeight +
    sectionGap +
    summaryHeight +
    PADDING;

  const canvas = document.createElement('canvas');
  canvas.width = WIDTH * scale;
  canvas.height = height * scale;
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;
  ctx.scale(scale, scale);

  ctx.fillStyle = COLORS.background;
  ctx.fillRect(0, 0, WIDTH, height);

  let y = PADDING;

  // Header.
  ctx.fillStyle = COLORS.accent;
  ctx.fillRect(PADDING, y, 4, 30);
  ctx.fillStyle = COLORS.text;
  ctx.font = 'bold 26px system-ui, -apple-system, "Hiragino Sans", "Noto Sans JP", sans-serif';
  ctx.textBaseline = 'top';
  ctx.fillText(options.title, PADDING + 16, y + 2, WIDTH - PADDING * 2 - 16);
  y += 38;
  if (options.subtitle) {
    ctx.fillStyle = COLORS.muted;
    ctx.font = '15px system-ui, -apple-system, "Hiragino Sans", "Noto Sans JP", sans-serif';
    ctx.fillText(options.subtitle, PADDING + 16, y, WIDTH - PADDING * 2 - 16);
    y += 24;
  }
  y += 18;

  const drawSection = (label: string, rows: readonly Row[]): void => {
    ctx.fillStyle = COLORS.muted;
    ctx.font = 'bold 13px system-ui, -apple-system, sans-serif';
    ctx.fillText(label, PADDING, y);
    y += 22;

    rows.forEach((row, index) => {
      ctx.fillStyle = index % 2 === 0 ? COLORS.card : COLORS.cardAlt;
      ctx.fillRect(PADDING, y, WIDTH - PADDING * 2, rowHeight - 4);

      ctx.fillStyle = COLORS.muted;
      ctx.font = '14px system-ui, -apple-system, "Hiragino Sans", "Noto Sans JP", sans-serif';
      ctx.fillText(row.left, PADDING + 12, y + 11, 210);

      ctx.fillStyle = COLORS.text;
      ctx.font = `${row.emphasis ? 'bold ' : ''}16px system-ui, -apple-system, "Hiragino Sans", "Noto Sans JP", sans-serif`;
      ctx.textAlign = 'right';
      ctx.fillText(row.right, WIDTH - PADDING - 12, y + 10, WIDTH - PADDING * 2 - 240);
      ctx.textAlign = 'left';

      y += rowHeight;
    });
    y += sectionGap;
  };

  drawSection('ORDER', orderRows);
  drawSection('出場回数', tallyRows);

  // Summary.
  ctx.strokeStyle = COLORS.line;
  ctx.beginPath();
  ctx.moveTo(PADDING, y);
  ctx.lineTo(WIDTH - PADDING, y);
  ctx.stroke();
  y += 14;

  ctx.fillStyle = COLORS.muted;
  ctx.font = '13px system-ui, -apple-system, "Hiragino Sans", "Noto Sans JP", sans-serif';
  const summary = [
    `総合 ${solution.score.display}  最大出場差 ${solution.metrics.appearanceSpread}  最大連続 ${solution.metrics.maxConsecutive}`,
    `平均Rating ${solution.metrics.averageRating ?? '-'}  戦力 ${Math.round(solution.score.strength * 100)}%  適性 ${Math.round(solution.score.gameFit * 100)}%  公平性 ${Math.round(solution.score.fairness * 100)}%`,
  ];
  if (solution.metrics.hasImputedRating) {
    summary.push('* Rating 未入力は参加者の中央値で評価');
  }
  for (const line of summary) {
    ctx.fillText(line, PADDING, y, WIDTH - PADDING * 2);
    y += 20;
  }

  return canvas.toDataURL('image/png');
}

/** Converts a data URL into a Blob so it can be shared or downloaded. */
export function dataUrlToBlob(dataUrl: string): Blob {
  const [header, body] = dataUrl.split(',');
  const mime = /:(.*?);/.exec(header)?.[1] ?? 'image/png';
  const binary = atob(body);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return new Blob([bytes], { type: mime });
}

export interface ShareOutcome {
  method: 'share' | 'download' | 'clipboard' | 'none';
  message: string;
}

/** Copies text, preferring the async clipboard API and falling back to a textarea. */
export async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // Permission denied or insecure context — fall through to the legacy path.
  }
  try {
    const area = document.createElement('textarea');
    area.value = text;
    area.setAttribute('readonly', '');
    area.style.position = 'fixed';
    area.style.opacity = '0';
    document.body.appendChild(area);
    area.select();
    const ok = document.execCommand('copy');
    document.body.removeChild(area);
    return ok;
  } catch {
    return false;
  }
}

/** Shares a PNG through the OS share sheet when possible, else downloads it. */
export async function shareImage(dataUrl: string, fileName: string, title: string): Promise<ShareOutcome> {
  const blob = dataUrlToBlob(dataUrl);
  const file = new File([blob], fileName, { type: 'image/png' });

  if (typeof navigator.canShare === 'function' && navigator.canShare({ files: [file] })) {
    try {
      await navigator.share({ files: [file], title });
      return { method: 'share', message: '共有しました' };
    } catch (error) {
      // An AbortError means the user dismissed the sheet; anything else falls back.
      if ((error as Error)?.name === 'AbortError') {
        return { method: 'none', message: '共有を中止しました' };
      }
    }
  }

  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = fileName;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  return { method: 'download', message: '画像を保存しました' };
}

/** Downloads arbitrary text (used by JSON export). */
export function downloadText(text: string, fileName: string, mime = 'application/json'): void {
  const blob = new Blob([text], { type: `${mime};charset=utf-8` });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = fileName;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
