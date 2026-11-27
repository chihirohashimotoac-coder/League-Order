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
  /** 足場の要素の箱 (ページ座標、elements と同じ順)。側面・角の判定に使う。 */
  boxes?: readonly Rect[];
  /** 文書の下端 (ページ座標)。キャラクターをこれより下に置かない (スクロールできる範囲を広げない)。 */
  docBottom?: number;
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
  // 1 px でもはみ出していればスクロールできる (scrollWidth・clientWidth は整数)。
  const scrollsX = /(auto|scroll)/.test(style.overflowX ?? '') && el.scrollWidth > el.clientWidth;
  const scrollsY = /(auto|scroll)/.test(style.overflowY ?? '') && el.scrollHeight > el.clientHeight;
  // overflow を 1 つの値で指定した古い書き方 (overflowX / Y が空) は、どちらの向きでも数える。
  const either = !style.overflowX && !style.overflowY && (el.scrollWidth > el.clientWidth || el.scrollHeight > el.clientHeight);
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
 * 障害物の種類。hard = どんなときも重ならない (入力欄・フォーカスの輪・スコアなどの重要な表示)。soft = 見えている
 * 文字・アイコン・画像 (移動の途中に短くかぶるのはよいが、その上で待たない)。種類のない矩形は hard とみなす。
 */
export type ObstacleKind = 'hard' | 'soft';

/** 障害物の種類 (列挙しないので、座標の比較には影響しない)。 */
export function obstacleKind(rect: Rect): ObstacleKind {
  return (rect as Rect & { kind?: ObstacleKind }).kind ?? 'hard';
}

function tag(rect: Rect, kind: ObstacleKind, source?: Element): Rect {
  Object.defineProperty(rect, 'kind', { value: kind, enumerable: false });
  if (source) Object.defineProperty(rect, 'source', { value: source, enumerable: false });
  return rect;
}

/** 入力欄 (文字の入力・選択の邪魔をしない)。 */
const INPUT_LIKE = 'input:not([type="button"]):not([type="submit"]):not([type="reset"]), select, textarea, [contenteditable=""], [contenteditable="true"], [role="textbox"], [role="combobox"], [role="slider"], [role="spinbutton"]';
/** スコアなどの重要な表示 (移動の途中でも重ならない)。 */
const IMPORTANT = '[class*="score"], .n01-sheet, .scoreboard';
/** 画像・アイコン (見えている内容。その上では待たない)。 */
const MEDIA_TAGS = new Set(['IMG', 'SVG', 'CANVAS', 'VIDEO', 'PICTURE', 'IFRAME', 'OBJECT', 'EMBED', 'PROGRESS', 'METER']);

/**
 * 範囲 (ページ座標の矩形の一覧) に重なる障害物を集める。
 * - hard: 入力欄・スコアなどの重要な表示・フォーカスの輪 (要素の外側 4px まで)
 * - soft: 直下の文字の矩形・画像やアイコン・疑似要素の内容・中身がスクロールする領域
 * カード・ボタン・タブ・枠・帯などのデザインの箱そのものは障害物にしない (足場の候補。体が重なってよい)。
 * @param seeThrough この要素自身の箱 (疑似要素・画像) は数えない (中の文字・要素は数える)。
 * @param _containers 互換のための引数 (デザインの箱を数えなくなったので使わない)。
 */
export function collectObstacles(root: Element, regions: readonly Rect[], win: Window = window, seeThrough?: Element | ReadonlySet<Element>, _containers?: ReadonlySet<Element>): Rect[] {
  const through = (el: Element): boolean => (seeThrough instanceof Set ? seeThrough.has(el) : seeThrough === el);
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
    if (box.right <= box.left || box.bottom <= box.top) continue;
    // キーボードのフォーカスの輪 (要素の外側に描かれる) は、要素の箱より広く数える。
    if (focusRing(el)) {
      const ring = { left: box.left - FOCUS_RING, top: box.top - FOCUS_RING, right: box.right + FOCUS_RING, bottom: box.bottom + FOCUS_RING };
      if (inRegion(ring)) obstacles.push(tag(ring, 'hard', el));
    }
    if (!inRegion(box)) continue;
    const info = styleOf(el, win);
    if (info.contents || info.hidden) continue;
    if (el.matches(INPUT_LIKE) || el.matches(IMPORTANT)) {
      obstacles.push(tag(box, 'hard', el));
      continue;
    }
    if (!through(el) && (MEDIA_TAGS.has(el.tagName.toUpperCase()) || el.getAttribute('role') === 'img' || info.pseudo || info.scrolls)) {
      obstacles.push(tag(box, 'soft', el));
      if (!info.scrolls) continue;
    }
    for (const node of Array.from(el.childNodes)) {
      if (node.nodeType !== 3 || !node.textContent?.trim()) continue;
      range.selectNodeContents(node);
      for (const rect of Array.from(range.getClientRects())) {
        if (rect.width > 0 && rect.height > 0) obstacles.push(tag(toPage(rect, sx, sy), 'soft', el));
      }
    }
  }
  range.detach();
  return obstacles;
}

// ------------------------------------------------------------------ 計算したスタイルの控え

interface StyleInfo {
  /** 背景 (色・画像)・枠・影のある、見えているデザインか。 */
  design: boolean;
  /** 上の枠線・下の枠線だけで描かれる仕切りか (下の線を足場にする)。 */
  bottomLine: boolean;
  /** 位置が固定・sticky か。中身がスクロールする (はみ出している) か。 */
  fixed: boolean;
  scrolls: boolean;
  /** overflow が auto・scroll の入れ物か (中の要素はページのスクロールとは別に動きうる)。 */
  scrollBox: boolean;
  /** 見えない (visibility・display・ほぼ透明) か。display: contents か。 */
  hidden: boolean;
  contents: boolean;
  /** 疑似要素の内容 (アイコンなど) があるか。 */
  pseudo: boolean;
}

/** 計算したスタイルの控え。DOM の変化 (クラス・style など) で invalidateStyleCache を呼んで捨てる。 */
let styleCache = new WeakMap<Element, StyleInfo>();

/** スタイルの控えを捨てる (DOM・クラス・style が変わったとき)。 */
export function invalidateStyleCache(): void {
  styleCache = new WeakMap<Element, StyleInfo>();
}

function borderVisible(style: CSSStyleDeclaration, side: 'top' | 'bottom'): boolean {
  const width = parseFloat(style.getPropertyValue(`border-${side}-width`) || '0');
  return width > 0 && style.getPropertyValue(`border-${side}-style`) !== 'none' && !transparent(style.getPropertyValue(`border-${side}-color`));
}

function styleOf(el: Element, win: Window): StyleInfo {
  const cached = styleCache.get(el);
  if (cached) return cached;
  const style = win.getComputedStyle(el);
  const fill = (!!style.backgroundColor && !transparent(style.backgroundColor)) || (!!style.backgroundImage && style.backgroundImage !== 'none');
  const top = borderVisible(style, 'top');
  const bottom = borderVisible(style, 'bottom');
  const shadow = !!style.boxShadow && style.boxShadow !== 'none';
  const info: StyleInfo = {
    design: fill || top || shadow,
    bottomLine: bottom && !fill && !top && !shadow,
    scrollBox: /(auto|scroll)/.test(`${style.overflowX ?? ''} ${style.overflowY ?? ''}`),
    fixed: style.position === 'fixed' || style.position === 'sticky',
    scrolls: /(auto|scroll)/.test(`${style.overflowX ?? ''} ${style.overflowY ?? ''}`) && overflows(el, style),
    hidden: style.visibility === 'hidden' || style.visibility === 'collapse' || style.display === 'none' || parseFloat(style.opacity || '1') < 0.05,
    contents: style.display === 'contents',
    pseudo: hasPseudoContent(el, win),
  };
  styleCache.set(el, info);
  return info;
}

/** フォーカスの輪として、要素の外側に数える幅 (CSS px)。 */
const FOCUS_RING = 4;

function focusRing(el: Element): boolean {
  if (el !== el.ownerDocument.activeElement) return false;
  try {
    return el.matches(':focus-visible');
  } catch {
    return false;
  }
}

/** 要素の上辺の角丸の半径 (左右の大きい方、CSS px)。 */
export function topCornerRadius(el: Element, win: Window = window): number {
  const style = win.getComputedStyle(el);
  const rect = el.getBoundingClientRect();
  /** 角の横・縦の半径 (「12px 8px」は横 縦。% は横は幅、縦は高さに対する割合)。 */
  const corner = (value: string): [number, number] => {
    const parts = (value || '0').trim().split(/\s+/);
    const size = (part: string, length: number): number => {
      const n = parseFloat(part) || 0;
      return part.endsWith('%') ? (length * n) / 100 : n;
    };
    return [size(parts[0], rect.width), size(parts[1] ?? parts[0], rect.height)];
  };
  const tl = corner(style.borderTopLeftRadius);
  const tr = corner(style.borderTopRightRadius);
  const bl = corner(style.borderBottomLeftRadius);
  const br = corner(style.borderBottomRightRadius);
  // CSS は辺ごとの半径の和が辺の長さを超えると、すべての半径を同じ割合で縮めて描く (999px の丸いボタン・楕円)。
  let f = 1;
  if (rect.width > 0 && rect.height > 0) {
    for (const [sum, length] of [[tl[0] + tr[0], rect.width], [bl[0] + br[0], rect.width], [tl[1] + bl[1], rect.height], [tr[1] + br[1], rect.height]]) {
      if (sum > length) f = Math.min(f, length / sum);
    }
  }
  return Math.max(tl[0], tr[0]) * f;
}

/**
 * いま見えている範囲 (ページ座標)。固定ヘッダー・下部ナビ・固定操作バーの内側で、ピンチズーム中は実際に見えている
 * 範囲 (visual viewport)。固定バーと画面の大きさだけを読む軽い計測 (スクロールのたびに呼べる)。
 */
export function viewport(win: Window = window): MeasuredTerrain['view'] {
  const doc = win.document;
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
  let viewLeft = 0;
  let viewRight = viewportWidth;
  const visual = win.visualViewport;
  if (visual) {
    viewTop = Math.max(viewTop, visual.offsetTop);
    viewBottom = Math.min(viewBottom, visual.offsetTop + visual.height);
    viewLeft = Math.max(viewLeft, visual.offsetLeft);
    viewRight = Math.min(viewRight, visual.offsetLeft + visual.width);
  }
  return { top: sy + viewTop, bottom: sy + viewBottom, left: sx + viewLeft, right: sx + viewRight };
}

/** フォーカスの表示 (キーボード操作の輪) が、要素かその中に出ているか。その上には立たない。 */
function focusShown(el: Element): boolean {
  const active = el.ownerDocument.activeElement;
  if (!active || active === el.ownerDocument.body || !el.contains(active)) return false;
  try {
    return active.matches(':focus-visible');
  } catch {
    return true;
  }
}

/** 足場の候補にしない要素 (入力欄・メディア)。 */
function notPlatform(el: Element): boolean {
  return el.matches(INPUT_LIKE) || MEDIA_TAGS.has(el.tagName.toUpperCase());
}

/** 要素 (またはその祖先) が固定・sticky・内側のスクロール領域の中・見えない、のどれかか (控えを使う)。 */
function unusable(el: Element, root: Element, win: Window): boolean {
  for (let node: Element | null = el; node && node !== root.parentElement; node = node.parentElement) {
    const info = styleOf(node, win);
    if (info.hidden) return true;
    if (node === root) break;
    if (info.fixed) return true;
    if (node !== el && info.scrollBox) return true;
  }
  return false;
}

/**
 * 辺の見えている区間: 辺のすぐ内側の点で、いちばん手前に描かれているのがその要素かその中身なら見えている。
 * 左・中・右の 3 点がすべて見えていれば null (辺の全体)。そうでなければ EDGE_STEP ごとに確かめて、見えている区間
 * (画面の座標) を返す (ほかの要素に覆われた部分は使わない。すべて覆われていれば空)。画面の外は確かめられないので
 * 見えているとみなす。
 */
function edgeVisible(el: Element, left: number, right: number, y: number, win: Window): [number, number][] | null {
  const doc = el.ownerDocument;
  if (typeof doc.elementFromPoint !== 'function') return null;
  if (y < 0 || y >= win.innerHeight) return null;
  const width = doc.documentElement.clientWidth || win.innerWidth;
  const shown = (x: number): boolean => {
    if (x < 0 || x >= width) return true;
    const top = doc.elementFromPoint(x, y);
    // 描画レイヤー (クリックを受け取らない) は elementFromPoint に出ない。
    return top !== null && (top === el || el.contains(top));
  };
  const probes = [left + (right - left) * 0.2, (left + right) / 2, left + (right - left) * 0.8].map(shown);
  if (probes.every(Boolean)) return null;
  // 一部が覆われている: EDGE_STEP ごとに確かめて、見えている区間だけを返す (覆われた部分を歩かない)。
  const runs: [number, number][] = [];
  let start: number | null = null;
  const xs: number[] = [];
  for (let x = left + 1; x < right - 1; x += EDGE_STEP) xs.push(x);
  xs.push(right - 1);
  for (let i = 0; i < xs.length; i += 1) {
    const ok = shown(xs[i]);
    if (ok && start === null) start = i === 0 ? left : xs[i];
    if (!ok && start !== null) {
      runs.push([start, xs[i - 1]]);
      start = null;
    }
  }
  if (start !== null) runs.push([start, right]);
  return runs;
}

/** 一部が覆われた辺を確かめる間隔 (CSS px)。 */
const EDGE_STEP = 6;

/**
 * 計測する。root (例: `.app-main`) の中だけを見る。
 * 足場の候補は、登録したセレクターの要素と、見えているデザイン (背景・枠・影のある要素。カード・ボタン・タブ・
 * メニュー・枠・帯・装飾) の上辺、下の枠線だけの仕切りの線。入力欄・画像・固定や sticky・内側のスクロール領域の中・
 * 見えない要素・フォーカスの輪が出ている要素・ほかの要素に覆われた辺は使わない。文字そのものは足場にしない。
 * 計測は見えている範囲の上下 1 画面ぶんの要素だけ (長いページでも重くならない)。
 */
export function measureTerrain(root: Element, platformSelector: string, win: Window = window): MeasuredTerrain {
  const doc = root.ownerDocument;
  const sx = win.scrollX;
  const sy = win.scrollY;
  const viewportWidth = doc.documentElement.clientWidth || win.innerWidth;
  const view = viewport(win);
  const reach = Math.max(win.innerHeight, 400);

  const platforms: Platform[] = [];
  const elements: Element[] = [];
  const boxes: Rect[] = [];
  const listed = new Set(platformSelector ? Array.from(root.querySelectorAll(platformSelector)) : []);
  for (const el of Array.from(root.querySelectorAll('*'))) {
    const rect = el.getBoundingClientRect();
    if (rect.width < 8 || rect.height <= 0) continue;
    const page = toPage(rect, sx, sy);
    if (page.bottom < view.top - reach || page.top > view.bottom + reach) continue;
    if (notPlatform(el) || el.parentElement?.closest('svg')) continue;
    const info = styleOf(el, win);
    const line = !listed.has(el) && !info.design && info.bottomLine;
    if (!listed.has(el) && !info.design && !line) continue;
    if (unusable(el, root, win) || focusShown(el)) continue;
    // 上辺 (仕切りの線は下の線) が、ほかの要素に覆われずに見えているか。
    const y = line ? rect.bottom - 0.5 : rect.top + 1;
    const runs = edgeVisible(el, rect.left, rect.right, y, win);
    // 上辺の角丸 (半径が大きい要素ほど、平らな部分は短い)。立てる範囲から除く幅に使う。
    const inset = line ? 0 : Math.min(topCornerRadius(el, win), rect.width / 2);
    const top = line ? page.bottom : page.top;
    for (const [l, r] of runs ?? [[rect.left, rect.right]]) {
      if (r - l < 8) continue;
      const left = l + sx;
      const right = r + sx;
      platforms.push({ left, right, top, inset });
      elements.push(el);
      boxes.push({ ...page, left, right, top, inset } as Rect);
    }
  }

  const bands: Rect[] = platforms.map((p) => ({
    left: p.left,
    right: p.right,
    top: p.top - SPRITE.height - DEFAULT_TERRAIN.clearanceTop,
    bottom: p.top,
  }));
  const containers = containersOf(elements, root);
  const obstacles = collectObstacles(root, bands, win, undefined, containers);

  return {
    platforms,
    elements,
    boxes,
    containers,
    obstacles,
    bounds: { left: sx + 4, right: sx + viewportWidth - 4 },
    view,
    docBottom: Math.max(doc.documentElement.scrollHeight, doc.body?.scrollHeight ?? 0),
  };
}
