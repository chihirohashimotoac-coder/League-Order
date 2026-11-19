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
  /** 足場の要素 (platforms と同じ順)。足場がホバーなどで動くとき、上辺に合わせて一緒に動くために使う。 */
  elements?: readonly Element[];
  /** 足場を包む入れ物 (containersOf)。経路・余白の障害物を集めるときに渡す。 */
  containers?: ReadonlySet<Element>;
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
  // 中身がスクロールする領域は、見えている文字が入れ替わるので箱全体を障害物にする。中身が収まっていて
  // スクロールできない領域 (はみ出していない) は動かないので、ふつうの入れ物と同じく中身だけを数える
  // (PR3: 観戦のライブ画面の、1 枚だけのカードの帯・ゲームの切り替えの列)。はみ出すようになれば DOM の変化で計測し直す。
  if (/(auto|scroll)/.test(`${style.overflowX ?? ''} ${style.overflowY ?? ''}`) && overflows(el, style)) return true;
  if (style.backgroundImage && style.backgroundImage !== 'none') return true;
  if (style.backgroundColor && !transparent(style.backgroundColor)) return true;
  for (const side of ['Top', 'Right', 'Bottom', 'Left'] as const) {
    const width = parseFloat(style.getPropertyValue(`border-${side.toLowerCase()}-width`) || '0');
    const color = style.getPropertyValue(`border-${side.toLowerCase()}-color`);
    if (width > 0 && style.getPropertyValue(`border-${side.toLowerCase()}-style`) !== 'none' && !transparent(color)) return true;
  }
  return false;
}

/** スクロールできる (中身がはみ出している) か。スクロールしない向きは数えない。 */
function overflows(el: Element, style: CSSStyleDeclaration): boolean {
  const scrollsX = /(auto|scroll)/.test(style.overflowX ?? '') && el.scrollWidth > el.clientWidth + 1;
  const scrollsY = /(auto|scroll)/.test(style.overflowY ?? '') && el.scrollHeight > el.clientHeight + 1;
  // overflow を 1 つの値で指定した古い書き方 (overflowX / Y が空) は、どちらの向きでも数える。
  const either = !style.overflowX && !style.overflowY && (el.scrollWidth > el.clientWidth + 1 || el.scrollHeight > el.clientHeight + 1);
  return scrollsX || scrollsY || either;
}

function hasPseudoContent(el: Element, win: Window): boolean {
  for (const pseudo of ['::before', '::after']) {
    const content = win.getComputedStyle(el, pseudo).content;
    if (content && content !== 'none' && content !== 'normal') return true;
  }
  return false;
}

/**
 * 足場の要素が、ページのスクロールとは別に動くか (固定・sticky、内側のスクロール領域の中)。
 * そうした足場はページ座標で追えないので使わない。
 */
export function movesOnItsOwn(el: Element, root: Element, win: Window): boolean {
  for (let node: Element | null = el; node && node !== root; node = node.parentElement) {
    const style = win.getComputedStyle(node);
    if (style.position === 'fixed' || style.position === 'sticky') return true;
    if (node !== el && /(auto|scroll)/.test(`${style.overflowX} ${style.overflowY}`)) return true;
  }
  return false;
}

/** 操作部品・役割のある要素か (足場を包んでいても、箱全体を障害物にする)。 */
function interactive(el: Element): boolean {
  if (SOLID_TAGS.has(el.tagName.toUpperCase())) return true;
  const role = el.getAttribute('role');
  if (role && INTERACTIVE_ROLES.has(role)) return true;
  const tabindex = el.getAttribute('tabindex');
  if (tabindex !== null && Number(tabindex) >= 0) return true;
  return (el as HTMLElement).isContentEditable === true;
}

/**
 * 足場を包む入れ物 (足場の要素の祖先のうち、root より内側で、操作部品でないもの)。足場はその入れ物の上に
 * 描かれているので、入れ物の背景・枠は足場の上の帯をふさがない (中の文字・部品はふつうに数える)。
 * PR3: 観戦のライブ画面で、白いカードの中のスコア表の上辺に立てるようにするため。
 */
export function containersOf(elements: readonly Element[], root: Element): Set<Element> {
  const containers = new Set<Element>();
  for (const element of elements) {
    for (let node = element.parentElement; node && node !== root && root.contains(node); node = node.parentElement) {
      if (!interactive(node)) containers.add(node);
    }
  }
  return containers;
}

/**
 * 範囲 (ページ座標の矩形の一覧) に重なる障害物を集める。
 * 操作部品・画像・色や枠の付いた要素・スクロール領域・疑似要素の内容がある要素は箱全体、それ以外は直下の文字の矩形。
 * @param seeThrough カードの内側を調べるとき、そのカード自身 (背景・枠・装飾の疑似要素) は障害物にしない。
 *   カード直下の文字と、カードの中の要素はふつうに数える。
 * @param containers 足場を包む入れ物 (containersOf)。色・枠・スクロール領域でも箱全体は数えない (疑似要素の内容が
 *   ある入れ物は数える)。直下の文字はふつうに数える。
 */
export function collectObstacles(root: Element, regions: readonly Rect[], win: Window = window, seeThrough?: Element, containers?: ReadonlySet<Element>): Rect[] {
  const doc = root.ownerDocument;
  const sx = win.scrollX;
  const sy = win.scrollY;
  const inRegion = (r: Rect): boolean => regions.some((g) => r.bottom > g.top && r.top < g.bottom && r.right > g.left && r.left < g.right);
  const obstacles: Rect[] = [];
  if (regions.length === 0) return obstacles;
  const range = doc.createRange();
  for (const el of Array.from(root.querySelectorAll('*'))) {
    // SVG の子要素は親の svg で数える。
    if (el.parentElement?.closest('svg')) continue;
    const box = toPage(el.getBoundingClientRect(), sx, sy);
    if (box.right <= box.left || box.bottom <= box.top || !inRegion(box)) continue;
    const style = win.getComputedStyle(el);
    if (style.display === 'contents') continue;
    // 入れ物を数えないのは、重なっている範囲をすべて包んでいるときだけ (帯の一部にかかるだけの別の色付きの枠は数える)。
    const behind = containers?.has(el) === true && regions.every((g) => !(box.bottom > g.top && box.top < g.bottom && box.right > g.left && box.left < g.right) || (box.left <= g.left && box.right >= g.right && box.top <= g.top && box.bottom >= g.bottom));
    const solid = isSolid(el, style) && !behind;
    if (el !== seeThrough && (solid || hasPseudoContent(el, win))) {
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
  return obstacles;
}

/** 要素の上辺の角丸の半径 (左右の大きい方、CSS px)。 */
export function topCornerRadius(el: Element, win: Window = window): number {
  const style = win.getComputedStyle(el);
  const radius = (value: string): number => {
    // 「12px 8px」(横 縦) は横の半径を使う。% は要素の幅に対する割合。
    const first = (value || '0').trim().split(/\s+/)[0];
    const n = parseFloat(first) || 0;
    return first.endsWith('%') ? (el.getBoundingClientRect().width * n) / 100 : n;
  };
  return Math.max(radius(style.borderTopLeftRadius), radius(style.borderTopRightRadius));
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
  const elements: Element[] = [];
  for (const el of Array.from(root.querySelectorAll(platformSelector))) {
    const rect = el.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) continue;
    if (movesOnItsOwn(el, root, win)) continue;
    platforms.push({ left: rect.left + sx, right: rect.right + sx, top: rect.top + sy });
    elements.push(el);
  }

  const bands: Rect[] = platforms.map((p) => ({
    left: p.left,
    right: p.right,
    top: p.top - SPRITE.height - DEFAULT_TERRAIN.clearanceTop,
    bottom: p.top,
  }));
  const containers = containersOf(elements, root);
  const obstacles = collectObstacles(root, bands, win, undefined, containers);

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
    elements,
    containers,
    obstacles,
    bounds: { left: sx + 4, right: sx + viewportWidth - 4 },
    view: { top: sy + viewTop, bottom: sy + viewBottom, left: sx + viewLeft, right: sx + viewRight },
  };
}
