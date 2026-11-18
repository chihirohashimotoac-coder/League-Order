/**
 * 実 DOM から足場と障害物を集める (計測専用。DOM・スタイル・スクロール位置は一切変更しない)。
 *
 * 足場はページごとに登録したセレクターの要素の上辺。障害物は、立つ帯に重なる要素のうち
 * - 操作部品・画像・色や枠の付いた要素は要素の箱全体
 * - それ以外は直下の文字 (Range の矩形)。疑似要素の内容がある要素は箱全体 (保守的に扱う)
 * とする。固定ヘッダー・下部ナビ・固定操作バーは表示範囲から除く。
 */
import { SPRITE, DEFAULT_TERRAIN } from './params';
import type { Platform, Rect, TerrainInput } from './terrain';

export interface MeasuredTerrain extends TerrainInput {
  /** いま見えている範囲 (ページ座標)。固定ヘッダー・下部ナビ・固定操作バーと、ピンチズームで見えない部分を除く。 */
  view: { top: number; bottom: number; left: number; right: number };
}

const SOLID_TAGS = new Set([
  'A', 'BUTTON', 'INPUT', 'SELECT', 'TEXTAREA', 'LABEL', 'SUMMARY', 'DETAILS', 'IMG', 'SVG', 'CANVAS',
  'VIDEO', 'AUDIO', 'IFRAME', 'PROGRESS', 'METER', 'OUTPUT', 'TABLE', 'HR', 'PICTURE', 'OBJECT', 'EMBED',
]);
const INTERACTIVE_ROLES = new Set([
  'button', 'link', 'tab', 'switch', 'checkbox', 'radio', 'menuitem', 'option', 'slider', 'textbox', 'combobox',
  'listbox', 'tablist', 'scrollbar', 'spinbutton', 'progressbar', 'img', 'dialog', 'alert', 'status', 'tooltip',
]);
/** 画面に固定された帯 (この範囲にはキャラクターを出さない)。 */
const FIXED_BARS = '.app-header, .tab-bar, .action-bar';

function toPage(rect: DOMRect, sx: number, sy: number): Rect {
  return { left: rect.left + sx, top: rect.top + sy, right: rect.right + sx, bottom: rect.bottom + sy };
}

function transparent(color: string): boolean {
  const value = color.trim();
  // 不透明度 0 の rgba(…, 0) / rgb(… / 0) だけを透明とみなす (rgb(255, 0, 0) の青 0 を透明と誤認しない)。
  return value === 'transparent' || /^rgba\([^,]+,[^,]+,[^,]+,\s*0(\.0+)?\s*\)$/.test(value) || /\/\s*0(\.0+)?%?\s*\)$/.test(value);
}

/** 箱全体を障害物として扱う要素か。 */
export function isSolid(el: Element, style: CSSStyleDeclaration): boolean {
  if (SOLID_TAGS.has(el.tagName.toUpperCase())) return true;
  const role = el.getAttribute('role');
  if (role && INTERACTIVE_ROLES.has(role)) return true;
  const tabindex = el.getAttribute('tabindex');
  if (tabindex !== null && Number(tabindex) >= 0) return true;
  if ((el as HTMLElement).isContentEditable) return true;
  if (style.backgroundImage && style.backgroundImage !== 'none') return true;
  if (style.backgroundColor && !transparent(style.backgroundColor)) return true;
  for (const side of ['Top', 'Right', 'Bottom', 'Left'] as const) {
    const width = parseFloat(style.getPropertyValue(`border-${side.toLowerCase()}-width`) || '0');
    const color = style.getPropertyValue(`border-${side.toLowerCase()}-color`);
    if (width > 0 && style.getPropertyValue(`border-${side.toLowerCase()}-style`) !== 'none' && !transparent(color)) return true;
  }
  return false;
}

function hasPseudoContent(el: Element, win: Window): boolean {
  for (const pseudo of ['::before', '::after']) {
    const content = win.getComputedStyle(el, pseudo).content;
    if (content && content !== 'none' && content !== 'normal') return true;
  }
  return false;
}

/** 計測する。root (例: `.app-main`) の中だけを見る。 */
export function measureTerrain(root: Element, platformSelector: string, win: Window = window): MeasuredTerrain {
  const doc = root.ownerDocument;
  const sx = win.scrollX;
  const sy = win.scrollY;
  const viewportWidth = doc.documentElement.clientWidth || win.innerWidth;
  const viewportHeight = win.innerHeight;

  let viewTop = 0;
  let viewBottom = viewportHeight;
  for (const bar of Array.from(doc.querySelectorAll(FIXED_BARS))) {
    const rect = bar.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) continue;
    if (rect.top < viewportHeight / 2) viewTop = Math.max(viewTop, rect.bottom);
    else viewBottom = Math.min(viewBottom, rect.top);
  }

  const platforms: Platform[] = [];
  for (const el of Array.from(root.querySelectorAll(platformSelector))) {
    const rect = el.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) continue;
    platforms.push({ left: rect.left + sx, right: rect.right + sx, top: rect.top + sy });
  }

  const bands = platforms.map((p) => [p.top - SPRITE.height - DEFAULT_TERRAIN.clearanceTop, p.top] as const);
  const inBand = (r: Rect): boolean => bands.some(([top, bottom]) => r.bottom > top && r.top < bottom);

  const obstacles: Rect[] = [];
  const range = doc.createRange();
  for (const el of Array.from(root.querySelectorAll('*'))) {
    // SVG の子要素は親の svg で数える。
    if (el.parentElement?.closest('svg')) continue;
    const box = toPage(el.getBoundingClientRect(), sx, sy);
    if (box.right <= box.left || box.bottom <= box.top || !inBand(box)) continue;
    const style = win.getComputedStyle(el);
    if (style.display === 'contents') continue;
    if (isSolid(el, style) || hasPseudoContent(el, win)) {
      obstacles.push(box);
      continue;
    }
    for (const node of Array.from(el.childNodes)) {
      if (node.nodeType !== 3 || !node.textContent?.trim()) continue;
      range.selectNodeContents(node);
      for (const rect of Array.from(range.getClientRects())) {
        if (rect.width > 0 && rect.height > 0) obstacles.push(toPage(rect, sx, sy));
      }
    }
  }
  range.detach();

  // ピンチズーム中は、実際に見えている範囲 (visual viewport) に狭める。
  let viewLeft = 0;
  let viewRight = viewportWidth;
  const visual = win.visualViewport;
  if (visual) {
    viewTop = Math.max(viewTop, visual.offsetTop);
    viewBottom = Math.min(viewBottom, visual.offsetTop + visual.height);
    viewLeft = Math.max(viewLeft, visual.offsetLeft);
    viewRight = Math.min(viewRight, visual.offsetLeft + visual.width);
  }

  return {
    platforms,
    obstacles,
    bounds: { left: sx + 4, right: sx + viewportWidth - 4 },
    view: { top: sy + viewTop, bottom: sy + viewBottom, left: sx + viewLeft, right: sx + viewRight },
  };
}
