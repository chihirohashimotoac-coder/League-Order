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
const PAD = 26;
/** Roughly a 1:2.6 aspect ratio — taller images get unreadable in a chat preview. */
const MAX_PAGE_HEIGHT = 1400;
/** Beyond this the PNG gets slow to encode and awkward to send. */
const MAX_PIXELS = 12_000_000;

const COLORS = {
  background: '#0d1420',
  card: '#182131',
  cardAlt: '#1d2838',
  badge: '#0f2436',
  draftBadge: '#3a2a12',
  draftText: '#fbbf24',
  accent: '#4cc9f0',
  text: '#f2f7fd',
  muted: '#9badc4',
  dim: '#6f8299',
  line: '#2c3b50',
};

function font(size: number, weight: 'normal' | 'bold' = 'normal'): string {
  return `${weight === 'bold' ? '700 ' : ''}${size}px ${FONT_STACK}`;
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

function measurer(ctx: CanvasRenderingContext2D, fontSpec: string): MeasureText {
  return (text: string) => {
    ctx.font = fontSpec;
    return ctx.measureText(text).width;
  };
}

function drawRoundedRect(
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
  ctx.fill();
}

// ---------------------------------------------------------------------------
// Block builders
// ---------------------------------------------------------------------------

function buildHeaderBlock(ctx: CanvasRenderingContext2D, layout: ShareLayout): Block {
  const inner = WIDTH - PAD * 2;
  const titleLines = wrapText(layout.header.title, inner, measurer(ctx, font(15, 'bold')));
  const teamLines = wrapText(layout.header.teamName, inner, measurer(ctx, font(30, 'bold')));
  const opponentLines = layout.header.opponentName
    ? wrapText(layout.header.opponentName, inner, measurer(ctx, font(24, 'bold')))
    : [];

  const titleH = titleLines.length * 21;
  const teamH = teamLines.length * 38;
  const vsH = opponentLines.length > 0 ? 22 : 0;
  const opponentH = opponentLines.length * 32;
  const dateH = layout.header.dateText ? 26 : 0;
  const versionH = layout.header.versionText ? 24 : 0;
  const height = 10 + titleH + teamH + vsH + opponentH + dateH + versionH + 16;

  return {
    height,
    draw(target, top) {
      let y = top + 10;

      target.textAlign = 'center';
      target.fillStyle = COLORS.accent;
      target.font = font(15, 'bold');
      for (const line of titleLines) {
        target.fillText(line, WIDTH / 2, y);
        y += 21;
      }

      target.fillStyle = COLORS.text;
      target.font = font(30, 'bold');
      for (const line of teamLines) {
        target.fillText(line, WIDTH / 2, y);
        y += 38;
      }

      if (opponentLines.length > 0) {
        target.fillStyle = COLORS.dim;
        target.font = font(14, 'bold');
        target.fillText('vs', WIDTH / 2, y + 3);
        y += 22;

        target.fillStyle = COLORS.text;
        target.font = font(24, 'bold');
        for (const line of opponentLines) {
          target.fillText(line, WIDTH / 2, y);
          y += 32;
        }
      }

      if (layout.header.dateText) {
        target.fillStyle = COLORS.muted;
        target.font = font(17);
        target.fillText(layout.header.dateText, WIDTH / 2, y + 2);
        y += 26;
      }

      // Version badge: small and muted so it never competes with the order itself, but
      // always present once an order has been finalized (追加要件 §6).
      if (layout.header.versionText) {
        const isDraft = layout.header.versionText.includes('未確定');
        target.font = font(13, 'bold');
        const label = layout.header.versionText;
        const textWidth = target.measureText(label).width;
        const padX = 10;
        const boxWidth = textWidth + padX * 2;
        const boxX = (WIDTH - boxWidth) / 2;
        target.fillStyle = isDraft ? COLORS.draftBadge : COLORS.badge;
        drawRoundedRect(target, boxX, y + 2, boxWidth, 22, 11);
        target.fillStyle = isDraft ? COLORS.draftText : COLORS.accent;
        target.fillText(label, WIDTH / 2, y + 7);
        y += 24;
      }

      target.textAlign = 'left';
      target.strokeStyle = COLORS.line;
      target.lineWidth = 1;
      target.beginPath();
      target.moveTo(PAD, top + height - 8);
      target.lineTo(WIDTH - PAD, top + height - 8);
      target.stroke();
    },
  };
}

function buildGameBlock(
  ctx: CanvasRenderingContext2D,
  row: ShareLayout['games'][number],
  index: number,
): Block {
  const badgeWidth = 54;
  const textLeft = PAD + badgeWidth + 14;
  const textWidth = WIDTH - PAD - textLeft - 12;

  const nameLines = wrapText(row.gameName, textWidth, measurer(ctx, font(18)));
  // Large, bold player names: this is the one line a member actually reads (要件 §3).
  const playerLines = wrapText(row.players, textWidth, measurer(ctx, font(26, 'bold')));

  const contentH = nameLines.length * 24 + 4 + playerLines.length * 34;
  const height = Math.max(76, contentH + 24) + 8;

  return {
    height,
    draw(target, top) {
      const cardHeight = height - 8;
      target.fillStyle = index % 2 === 0 ? COLORS.card : COLORS.cardAlt;
      drawRoundedRect(target, PAD, top, WIDTH - PAD * 2, cardHeight, 12);

      target.fillStyle = COLORS.badge;
      drawRoundedRect(target, PAD + 12, top + 14, badgeWidth - 12, 34, 9);
      target.fillStyle = COLORS.accent;
      target.font = font(19, 'bold');
      target.textAlign = 'center';
      target.fillText(row.no, PAD + 12 + (badgeWidth - 12) / 2, top + 22);
      target.textAlign = 'left';

      let y = top + (cardHeight - contentH) / 2;
      target.fillStyle = COLORS.muted;
      target.font = font(18);
      for (const line of nameLines) {
        target.fillText(line, textLeft, y);
        y += 24;
      }
      y += 4;
      target.fillStyle = COLORS.text;
      target.font = font(26, 'bold');
      for (const line of playerLines) {
        target.fillText(line, textLeft, y);
        y += 34;
      }
    },
  };
}

function buildSectionLabel(label: string): Block {
  return {
    height: 38,
    draw(target, top) {
      target.fillStyle = COLORS.dim;
      target.font = font(14, 'bold');
      target.fillText(label, PAD, top + 14);
    },
  };
}

function buildTallyBlock(
  ctx: CanvasRenderingContext2D,
  row: ShareLayout['tally'][number],
  index: number,
): Block {
  const right = `${row.rating}  今回${row.count}  Season${row.seasonTotal}`;
  const rightWidth = measurer(ctx, font(17))(right);
  // Keep a clear gutter between the name and the figures so a long name never collides
  // with them (要件 §13).
  const nameWidth = WIDTH - PAD * 2 - rightWidth - 52;
  const nameLines = wrapText(row.name, Math.max(80, nameWidth), measurer(ctx, font(19, 'bold')));
  const height = Math.max(44, nameLines.length * 26 + 18);

  return {
    height,
    draw(target, top) {
      target.fillStyle = index % 2 === 0 ? COLORS.card : COLORS.cardAlt;
      drawRoundedRect(target, PAD, top, WIDTH - PAD * 2, height - 4, 9);

      let y = top + (height - 4 - nameLines.length * 26) / 2 + 3;
      target.fillStyle = COLORS.text;
      target.font = font(19, 'bold');
      for (const line of nameLines) {
        target.fillText(line, PAD + 14, y);
        y += 26;
      }

      target.fillStyle = COLORS.muted;
      target.font = font(17);
      target.textAlign = 'right';
      target.fillText(right, WIDTH - PAD - 14, top + (height - 4) / 2 - 9);
      target.textAlign = 'left';
    },
  };
}

function buildNoteBlock(ctx: CanvasRenderingContext2D, text: string): Block {
  const lines = wrapText(text, WIDTH - PAD * 2, measurer(ctx, font(14)));
  return {
    height: lines.length * 20 + 6,
    draw(target, top) {
      target.fillStyle = COLORS.dim;
      target.font = font(14);
      let y = top;
      for (const line of lines) {
        target.fillText(line, PAD, y);
        y += 20;
      }
    },
  };
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
  const blocks: Block[] = layout.games.map((row, index) => buildGameBlock(probeCtx, row, index));

  if (layout.variant === 'detail') {
    if (layout.tally.length > 0) {
      blocks.push(buildSectionLabel('出場回数'));
      layout.tally.forEach((row, index) => blocks.push(buildTallyBlock(probeCtx, row, index)));
    }
    if (layout.orderTypeLabel) {
      blocks.push(buildNoteBlock(probeCtx, `オーダータイプ: ${layout.orderTypeLabel}`));
    }
    for (const note of layout.notes) blocks.push(buildNoteBlock(probeCtx, note));
  }

  const footerHeight = 30;
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

    ctx.fillStyle = COLORS.background;
    ctx.fillRect(0, 0, WIDTH, logicalHeight);

    let y = PAD;
    headerBlock.draw(ctx, y);
    y += headerBlock.height;

    for (const index of indices) {
      blocks[index].draw(ctx, y);
      y += blocks[index].height;
    }

    if (pages.length > 1) {
      ctx.fillStyle = COLORS.dim;
      ctx.font = font(14, 'bold');
      ctx.textAlign = 'right';
      ctx.fillText(`${pageIndex + 1} / ${pages.length}`, WIDTH - PAD, logicalHeight - PAD - 10);
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
