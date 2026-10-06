import { paginate, wrapText, type MeasureText } from './layout';
import type { ShareLayout } from './types';

/**
 * Canvas 2D share-image renderer (docs/DESIGN.md 追補 §S1–§S3).
 *
 * Drawn directly with the Canvas 2D API rather than through a DOM-to-image library:
 * the app's CSS uses `color-mix()` and `backdrop-filter`, which those libraries cannot
 * reproduce; and more importantly a Canvas draw needs no web font, so Japanese renders
 * correctly with the device's own fonts and the whole thing works offline (要件 §12).
 *
 * `measureText` drives every layout decision, so names are wrapped rather than clipped
 * and long orders are split across pages rather than squeezed (要件 §10, §13).
 */

/** CJK faces first: a Latin-first `system-ui` would fall back per-glyph and look uneven. */
const FONT_STACK =
  '"Hiragino Sans", "Hiragino Kaku Gothic ProN", "Yu Gothic", "YuGothic", "Noto Sans JP", "Noto Sans CJK JP", Meiryo, system-ui, -apple-system, sans-serif';

const WIDTH = 540;
const PAD = 24;
/** Roughly a 1:2.6 aspect ratio — taller images get unreadable in a chat preview. */
const MAX_PAGE_HEIGHT = 1400;
/** Beyond this the PNG gets slow to encode and awkward to send. */
const MAX_PIXELS = 12_000_000;

/**
 * Arena Scoreboard palette — the same tokens as the app (src/styles/app.css). Status
 * colours appear only on the version badge; the order itself is white on graphite so it
 * stays legible when LINE shrinks the image to a thumbnail.
 */
const COLORS = {
  background: '#0d0f12',
  panel: '#12161b',
  card: '#171c22',
  numberPanel: '#1d242c',
  line: '#2a323b',
  lineStrong: '#394652',
  accent: '#22d3ee',
  text: '#f4f7fa',
  secondary: '#b4bec9',
  muted: '#87929e',
  rings: 'rgba(34, 211, 238, 0.08)',
  tone: {
    draft: '#fbbf24',
    finalized: '#34d399',
    updated: '#fb923c',
  },
};

function font(size: number, weight: 'normal' | 'bold' | 'heavy' = 'normal'): string {
  const w = weight === 'heavy' ? '900 ' : weight === 'bold' ? '700 ' : '';
  return `${w}${size}px ${FONT_STACK}`;
}

/** Letter-spacing where the canvas supports it (Chrome, recent Safari); a no-op elsewhere. */
function setTracking(ctx: CanvasRenderingContext2D, px: number): void {
  const target = ctx as CanvasRenderingContext2D & { letterSpacing?: string };
  if ('letterSpacing' in target) target.letterSpacing = `${px}px`;
}

export interface ShareImageOptions {
  /** Device pixel ratio to honour. Defaults to the current window's. */
  devicePixelRatio?: number;
  /** Overrides the page height limit; used by tests. */
  maxPageHeight?: number;
}

export interface RenderedShareImage {
  dataUrl: string;
  /** Output pixel size (logical size × scale). */
  width: number;
  height: number;
  /** 1-based page number. */
  page: number;
  pageCount: number;
}

/** A measured, self-contained chunk of the image. */
interface Block {
  height: number;
  draw(ctx: CanvasRenderingContext2D, y: number): void;
}

function measurer(ctx: CanvasRenderingContext2D, fontSpec: string, tracking = 0): MeasureText {
  return (text: string) => {
    ctx.font = fontSpec;
    setTracking(ctx, tracking);
    const width = ctx.measureText(text).width;
    setTracking(ctx, 0);
    return width;
  };
}

function roundedRectPath(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  width: number,
  height: number,
  radius: number,
): void {
  const r = Math.min(radius, width / 2, height / 2);
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + width, y, x + width, y + height, r);
  ctx.arcTo(x + width, y + height, x, y + height, r);
  ctx.arcTo(x, y + height, x, y, r);
  ctx.arcTo(x, y, x + width, y, r);
  ctx.closePath();
}

function drawRoundedRect(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  width: number,
  height: number,
  radius: number,
): void {
  roundedRectPath(ctx, x, y, width, height, radius);
  ctx.fill();
}

function strokeRoundedRect(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  width: number,
  height: number,
  radius: number,
): void {
  roundedRectPath(ctx, x, y, width, height, radius);
  ctx.stroke();
}

// ---------------------------------------------------------------------------
// Block builders
// ---------------------------------------------------------------------------

/**
 * Match-card header: league, team, VS, opponent, date, version — in that reading order,
 * centred, with the team name as the largest thing on the image.
 */
function buildHeaderBlock(ctx: CanvasRenderingContext2D, layout: ShareLayout): Block {
  const inner = WIDTH - PAD * 2;
  const { header } = layout;
  const titleLines = wrapText(header.title.toUpperCase(), inner, measurer(ctx, font(14, 'heavy'), 2.5));
  const teamLines = header.teamName ? wrapText(header.teamName, inner, measurer(ctx, font(38, 'heavy'))) : [];
  const opponentLines = header.opponentName
    ? wrapText(header.opponentName, inner, measurer(ctx, font(28, 'heavy')))
    : [];
  const dateText = header.dateText.replace(/\//g, '.');

  const titleH = titleLines.length * 20;
  const teamH = teamLines.length * 46;
  const vsH = opponentLines.length > 0 ? 34 : 0;
  const opponentH = opponentLines.length * 36;
  const dateH = dateText ? 30 : 0;
  const versionH = header.versionText ? 40 : 0;
  const height = 18 + titleH + 10 + teamH + vsH + opponentH + dateH + versionH + 34;

  return {
    height,
    draw(target, top) {
      let y = top + 18;
      target.textAlign = 'center';

      target.fillStyle = COLORS.accent;
      target.font = font(14, 'heavy');
      setTracking(target, 2.5);
      for (const line of titleLines) {
        target.fillText(line, WIDTH / 2, y);
        y += 20;
      }
      setTracking(target, 0);
      y += 10;

      target.fillStyle = COLORS.text;
      target.font = font(38, 'heavy');
      for (const line of teamLines) {
        target.fillText(line, WIDTH / 2, y);
        y += 46;
      }

      if (opponentLines.length > 0) {
        // "VS" as a small outlined plate between the two team names.
        target.font = font(13, 'heavy');
        setTracking(target, 2);
        const vsWidth = 52;
        target.strokeStyle = COLORS.lineStrong;
        target.lineWidth = 1.5;
        strokeRoundedRect(target, (WIDTH - vsWidth) / 2, y + 4, vsWidth, 22, 6);
        target.fillStyle = COLORS.secondary;
        target.fillText('VS', WIDTH / 2 + 1, y + 8);
        setTracking(target, 0);
        y += 34;

        target.fillStyle = COLORS.text;
        target.font = font(28, 'heavy');
        for (const line of opponentLines) {
          target.fillText(line, WIDTH / 2, y);
          y += 36;
        }
      }

      if (dateText) {
        target.fillStyle = COLORS.secondary;
        target.font = font(18, 'bold');
        setTracking(target, 1.5);
        target.fillText(dateText, WIDTH / 2, y + 4);
        setTracking(target, 0);
        y += 30;
      }

      // Version badge: always present once an order has a state, coloured by state, and
      // labelled in text so it never relies on colour (追加要件 §6).
      if (header.versionText) {
        const tone = header.versionTone === 'none' ? COLORS.secondary : COLORS.tone[header.versionTone];
        const label =
          header.versionTone === 'updated' ? header.versionText.replace('更新版', 'UPDATED') : header.versionText;
        target.font = font(15, 'heavy');
        setTracking(target, 1.5);
        const textWidth = target.measureText(label).width;
        const dot = 8;
        const boxWidth = textWidth + 22 + dot + 10;
        const boxX = (WIDTH - boxWidth) / 2;
        target.fillStyle = COLORS.panel;
        drawRoundedRect(target, boxX, y + 8, boxWidth, 30, 15);
        target.strokeStyle = tone;
        target.lineWidth = 1.5;
        strokeRoundedRect(target, boxX, y + 8, boxWidth, 30, 15);
        target.fillStyle = tone;
        target.beginPath();
        target.arc(boxX + 14 + dot / 2, y + 23, dot / 2, 0, Math.PI * 2);
        target.fill();
        target.textAlign = 'left';
        target.fillText(label, boxX + 14 + dot + 8, y + 15);
        target.textAlign = 'center';
        setTracking(target, 0);
        y += 40;
      }

      // Section rule: ── ORDER ──
      const ruleY = top + height - 14;
      target.font = font(12, 'heavy');
      setTracking(target, 3);
      const label = 'ORDER';
      const labelWidth = target.measureText(label).width + 24;
      target.strokeStyle = COLORS.line;
      target.lineWidth = 1;
      target.beginPath();
      target.moveTo(PAD, ruleY);
      target.lineTo((WIDTH - labelWidth) / 2, ruleY);
      target.moveTo((WIDTH + labelWidth) / 2, ruleY);
      target.lineTo(WIDTH - PAD, ruleY);
      target.stroke();
      target.fillStyle = COLORS.muted;
      target.fillText(label, WIDTH / 2 + 1.5, ruleY - 7);
      setTracking(target, 0);
      target.textAlign = 'left';
    },
  };
}

/** One game: big number panel on the left, game name, then each player on a line. */
function buildGameBlock(ctx: CanvasRenderingContext2D, row: ShareLayout['games'][number]): Block {
  const numberWidth = 78;
  const textLeft = PAD + numberWidth + 16;
  const textWidth = WIDTH - PAD - textLeft - 14;

  const nameLines = wrapText(row.gameName.toUpperCase(), textWidth, measurer(ctx, font(15, 'heavy'), 1.2));
  // Large, bold player names: this is the one line a member actually reads (要件 §3).
  const playerLines = row.playerNames.flatMap((name) =>
    wrapText(name, textWidth, measurer(ctx, font(27, 'heavy'))),
  );

  const contentH = nameLines.length * 20 + 6 + playerLines.length * 35;
  const cardHeight = Math.max(92, contentH + 30);
  const height = cardHeight + 10;
  const number = row.no.replace(/^G/, '').padStart(2, '0');

  return {
    height,
    draw(target, top) {
      target.fillStyle = COLORS.card;
      drawRoundedRect(target, PAD, top, WIDTH - PAD * 2, cardHeight, 14);

      // Number panel, clipped to the card's rounded corners.
      target.save();
      roundedRectPath(target, PAD, top, WIDTH - PAD * 2, cardHeight, 14);
      target.clip();
      target.fillStyle = COLORS.numberPanel;
      target.fillRect(PAD, top, numberWidth, cardHeight);
      target.fillStyle = COLORS.accent;
      target.fillRect(PAD, top, 4, cardHeight);
      target.restore();

      target.textAlign = 'center';
      target.fillStyle = COLORS.muted;
      target.font = font(10, 'heavy');
      setTracking(target, 2);
      target.fillText('GAME', PAD + numberWidth / 2 + 3, top + cardHeight / 2 - 26);
      setTracking(target, 0);
      target.fillStyle = COLORS.text;
      target.font = font(34, 'heavy');
      target.fillText(number, PAD + numberWidth / 2 + 2, top + cardHeight / 2 - 12);
      target.textAlign = 'left';

      let y = top + (cardHeight - contentH) / 2;
      target.fillStyle = COLORS.secondary;
      target.font = font(15, 'heavy');
      setTracking(target, 1.2);
      for (const line of nameLines) {
        target.fillText(line, textLeft, y);
        y += 20;
      }
      setTracking(target, 0);
      y += 6;
      target.fillStyle = COLORS.text;
      target.font = font(27, 'heavy');
      for (const line of playerLines) {
        target.fillText(line, textLeft, y);
        y += 35;
      }
    },
  };
}

function buildSectionLabel(label: string): Block {
  return {
    height: 46,
    draw(target, top) {
      target.fillStyle = COLORS.accent;
      target.fillRect(PAD, top + 18, 4, 16);
      target.fillStyle = COLORS.secondary;
      target.font = font(14, 'heavy');
      setTracking(target, 2);
      target.fillText(label, PAD + 14, top + 18);
      setTracking(target, 0);
    },
  };
}

/**
 * Detail variant: appearances as a two-column grid, the count as the largest figure.
 * Two per row keeps a typical five-to-eight-player detail image on a single page.
 */
function buildTallyRowBlock(
  ctx: CanvasRenderingContext2D,
  cells: readonly ShareLayout['tally'][number][],
): Block {
  const gap = 10;
  const cellWidth = (WIDTH - PAD * 2 - gap) / 2;
  const countWidth = 56;
  const nameWidth = cellWidth - countWidth - 28;
  const layouts = cells.map((cell) => ({
    cell,
    nameLines: wrapText(cell.name, Math.max(60, nameWidth), measurer(ctx, font(19, 'heavy'))),
  }));
  const lines = Math.max(...layouts.map((entry) => entry.nameLines.length));
  const cardHeight = Math.max(70, lines * 25 + 44);
  const height = cardHeight + 8;

  return {
    height,
    draw(target, top) {
      layouts.forEach(({ cell, nameLines }, index) => {
        const x = PAD + index * (cellWidth + gap);
        target.fillStyle = COLORS.card;
        drawRoundedRect(target, x, top, cellWidth, cardHeight, 10);

        let y = top + 12;
        target.fillStyle = COLORS.text;
        target.font = font(19, 'heavy');
        for (const line of nameLines) {
          target.fillText(line, x + 14, y);
          y += 25;
        }
        target.fillStyle = COLORS.secondary;
        target.font = font(13, 'bold');
        target.fillText(`${cell.rating} ・ シーズン ${cell.seasonTotal}`, x + 14, y + 3);

        const right = x + cellWidth - 14;
        target.textAlign = 'right';
        target.fillStyle = COLORS.text;
        target.font = font(32, 'heavy');
        target.fillText(String(cell.count), right, top + cardHeight / 2 - 24);
        target.fillStyle = COLORS.muted;
        target.font = font(10, 'heavy');
        setTracking(target, 1.5);
        target.fillText('GAMES', right + 1.5, top + cardHeight / 2 + 12);
        setTracking(target, 0);
        target.textAlign = 'left';
      });
    },
  };
}

function buildNoteBlock(ctx: CanvasRenderingContext2D, text: string): Block {
  const lines = wrapText(text, WIDTH - PAD * 2, measurer(ctx, font(14)));
  return {
    height: lines.length * 20 + 8,
    draw(target, top) {
      target.fillStyle = COLORS.muted;
      target.font = font(14);
      let y = top + 4;
      for (const line of lines) {
        target.fillText(line, PAD, y);
        y += 20;
      }
    },
  };
}

/** Background shared by every page: graphite, a cyan top rule and faint dartboard rings. */
function drawBackdrop(ctx: CanvasRenderingContext2D, height: number): void {
  ctx.fillStyle = COLORS.background;
  ctx.fillRect(0, 0, WIDTH, height);

  ctx.save();
  ctx.strokeStyle = COLORS.rings;
  ctx.lineWidth = 2;
  for (let radius = 34; radius <= 300; radius += 26) {
    ctx.beginPath();
    ctx.arc(WIDTH + 24, -24, radius, 0, Math.PI * 2);
    ctx.stroke();
  }
  ctx.restore();

  ctx.fillStyle = COLORS.accent;
  ctx.fillRect(0, 0, WIDTH, 5);
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

function createCanvas(width: number, height: number): HTMLCanvasElement | null {
  if (typeof document === 'undefined') return null;
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  return canvas;
}

/**
 * Renders the layout to one or more portrait PNGs.
 *
 * Returns an empty array when no 2D context is available (e.g. jsdom); callers fall
 * back to text sharing in that case.
 */
export function renderShareImages(
  layout: ShareLayout,
  options: ShareImageOptions = {},
): RenderedShareImage[] {
  const probe = createCanvas(1, 1);
  const probeCtx = probe?.getContext('2d');
  if (!probe || !probeCtx) return [];

  const headerBlock = buildHeaderBlock(probeCtx, layout);
  const blocks: Block[] = layout.games.map((row) => buildGameBlock(probeCtx, row));

  if (layout.variant === 'detail') {
    if (layout.tally.length > 0) {
      blocks.push(buildSectionLabel('APPEARANCES  出場回数'));
      for (let index = 0; index < layout.tally.length; index += 2) {
        blocks.push(buildTallyRowBlock(probeCtx, layout.tally.slice(index, index + 2)));
      }
    }
    if (layout.orderTypeLabel) {
      blocks.push(buildNoteBlock(probeCtx, `オーダータイプ: ${layout.orderTypeLabel}`));
    }
    for (const note of layout.notes) blocks.push(buildNoteBlock(probeCtx, note));
  }

  const footerHeight = 40;
  const maxPageHeight = options.maxPageHeight ?? MAX_PAGE_HEIGHT;
  const contentBudget = Math.max(
    120,
    maxPageHeight - headerBlock.height - footerHeight - PAD * 2,
  );
  const pages = paginate(
    blocks.map((block) => block.height),
    contentBudget,
  );

  const dpr = options.devicePixelRatio ?? (typeof window === 'undefined' ? 2 : window.devicePixelRatio);
  const baseScale = Math.min(3, Math.max(2, Math.round(dpr || 2)));

  return pages.map((indices, pageIndex) => {
    const contentHeight = indices.reduce((acc, index) => acc + blocks[index].height, 0);
    const logicalHeight = PAD + headerBlock.height + contentHeight + footerHeight + PAD;

    // Guard against a canvas so large that mobile Safari refuses it or the PNG becomes
    // unwieldy to send.
    const scale = WIDTH * logicalHeight * baseScale * baseScale > MAX_PIXELS ? 2 : baseScale;

    const canvas = createCanvas(Math.round(WIDTH * scale), Math.round(logicalHeight * scale))!;
    const ctx = canvas.getContext('2d')!;
    ctx.scale(scale, scale);
    ctx.textBaseline = 'top';

    drawBackdrop(ctx, logicalHeight);

    let y = PAD;
    headerBlock.draw(ctx, y);
    y += headerBlock.height;

    for (const index of indices) {
      blocks[index].draw(ctx, y);
      y += blocks[index].height;
    }

    // Footer: a quiet wordmark, and the page count when the order spans pages.
    const footerY = logicalHeight - PAD - 16;
    ctx.fillStyle = COLORS.muted;
    ctx.font = font(11, 'heavy');
    setTracking(ctx, 2);
    ctx.fillText('DARTS LEAGUE ORDER', PAD, footerY);
    setTracking(ctx, 0);
    if (pages.length > 1) {
      ctx.font = font(14, 'heavy');
      ctx.textAlign = 'right';
      ctx.fillText(`${pageIndex + 1} / ${pages.length}`, WIDTH - PAD, footerY - 2);
      ctx.textAlign = 'left';
    }

    return {
      dataUrl: canvas.toDataURL('image/png'),
      width: canvas.width,
      height: canvas.height,
      page: pageIndex + 1,
      pageCount: pages.length,
    };
  });
}

export { WIDTH as SHARE_IMAGE_WIDTH, MAX_PAGE_HEIGHT as SHARE_MAX_PAGE_HEIGHT };
