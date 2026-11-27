import { describe, expect, it } from 'vitest';
import type { Rect } from './terrain';
import { collectObstacles, isSolid, topCornerRadius } from './terrainDom';

const style = (values: Record<string, string>): CSSStyleDeclaration =>
  ({
    overflowX: values.overflowX ?? 'visible',
    overflowY: values.overflowY ?? 'visible',
    backgroundImage: values.backgroundImage ?? 'none',
    backgroundColor: values.backgroundColor ?? 'rgba(0, 0, 0, 0)',
    getPropertyValue: (name: string) => values[name] ?? '',
  }) as unknown as CSSStyleDeclaration;

describe('isSolid (箱全体を障害物にする要素)', () => {
  it('操作部品・画像・役割のある要素', () => {
    for (const tag of ['button', 'a', 'input', 'img', 'label']) expect(isSolid(document.createElement(tag), style({}))).toBe(true);
    const div = document.createElement('div');
    div.setAttribute('role', 'button');
    expect(isSolid(div, style({}))).toBe(true);
    const focusable = document.createElement('div');
    focusable.setAttribute('tabindex', '0');
    expect(isSolid(focusable, style({}))).toBe(true);
  });
  it('色・背景画像・枠のある要素', () => {
    const div = document.createElement('div');
    expect(isSolid(div, style({ backgroundColor: 'rgb(255, 255, 255)' }))).toBe(true);
    expect(isSolid(div, style({ backgroundColor: 'rgb(255, 0, 0)' }))).toBe(true);
    expect(isSolid(div, style({ backgroundColor: 'rgba(0, 0, 0, 0.05)' }))).toBe(true);
    expect(isSolid(div, style({ backgroundImage: 'linear-gradient(red, blue)' }))).toBe(true);
    expect(isSolid(div, style({ 'border-top-width': '1px', 'border-top-style': 'solid', 'border-top-color': 'rgb(0, 0, 0)' }))).toBe(true);
  });
  it('透明な入れ物は箱ではなく中の文字だけを数える', () => {
    const div = document.createElement('div');
    expect(isSolid(div, style({}))).toBe(false);
    expect(isSolid(div, style({ backgroundColor: 'rgb(0 0 0 / 0)' }))).toBe(false);
    expect(isSolid(div, style({ backgroundColor: 'transparent', 'border-top-width': '1px', 'border-top-style': 'solid', 'border-top-color': 'transparent' }))).toBe(false);
    expect(isSolid(div, style({ 'border-top-width': '2px', 'border-top-style': 'none', 'border-top-color': 'rgb(0, 0, 0)' }))).toBe(false);
  });
});

describe('スクロール領域', () => {
  const box = (scroll: number, client: number): HTMLElement => {
    const el = document.createElement('ul');
    Object.defineProperty(el, 'scrollWidth', { value: scroll });
    Object.defineProperty(el, 'clientWidth', { value: client });
    Object.defineProperty(el, 'scrollHeight', { value: 40 });
    Object.defineProperty(el, 'clientHeight', { value: 40 });
    return el;
  };
  it('中身がはみ出してスクロールできるときだけ、箱全体を障害物にする (収まっていれば中身だけを数える)', () => {
    expect(isSolid(box(900, 400), style({ overflowX: 'auto' }))).toBe(true);
    expect(isSolid(box(400, 400), style({ overflowX: 'auto' }))).toBe(false);
    // 1 px のはみ出しでもスクロールできる。
    expect(isSolid(box(401, 400), style({ overflowX: 'scroll' }))).toBe(true);
    expect(isSolid(box(401, 400), style({ overflowX: 'auto' }))).toBe(true);
    expect(isSolid(box(900, 400), style({ overflowX: 'hidden' }))).toBe(false);
  });
});

describe('collectObstacles の seeThrough (カードの内側を調べる)', () => {
  const rect = (left: number, top: number, right: number, bottom: number) => () =>
    ({ left, top, right, bottom, width: right - left, height: bottom - top, x: left, y: top, toJSON: () => ({}) }) as DOMRect;

  it('カード・色の付いた箱・ボタンは障害物にしない (足場の候補で、体が重なってよい)。入力欄・重要な表示は hard', async () => {
    const { collectObstacles, obstacleKind } = await import('./terrainDom');
    const root = document.createElement('main');
    const card = document.createElement('div');
    card.style.backgroundColor = 'rgb(255, 255, 255)';
    card.getBoundingClientRect = rect(100, 300, 500, 400);
    const badge = document.createElement('span');
    badge.style.backgroundColor = 'rgb(200, 0, 0)';
    badge.getBoundingClientRect = rect(120, 304, 160, 318);
    const button = document.createElement('button');
    button.getBoundingClientRect = rect(300, 304, 360, 330);
    const input = document.createElement('input');
    input.getBoundingClientRect = rect(200, 304, 280, 330);
    const score = document.createElement('div');
    score.className = 'live-score';
    score.getBoundingClientRect = rect(400, 304, 480, 330);
    card.append(badge, button, input, score);
    root.append(card);
    document.body.append(root);
    const region = { left: 100, top: 300, right: 500, bottom: 340 };
    const found = collectObstacles(root, [region], window);
    expect(found).not.toContainEqual({ left: 100, top: 300, right: 500, bottom: 400 });
    expect(found).not.toContainEqual({ left: 120, top: 304, right: 160, bottom: 318 });
    expect(found).not.toContainEqual({ left: 300, top: 304, right: 360, bottom: 330 });
    expect(found).toEqual([
      { left: 200, top: 304, right: 280, bottom: 330 },
      { left: 400, top: 304, right: 480, bottom: 330 },
    ]);
    expect(found.map(obstacleKind)).toEqual(['hard', 'hard']);
    // 範囲の外の入力欄は数えない。
    expect(collectObstacles(root, [{ left: 0, top: 0, right: 90, bottom: 90 }], window)).toEqual([]);
    root.remove();
  });

  it('操作部品は入れ物にしない (containersOf)', async () => {
    const { containersOf } = await import('./terrainDom');
    const root = document.createElement('main');
    const outer = document.createElement('section');
    const sheet = document.createElement('div');
    outer.append(sheet);
    const link = document.createElement('a');
    link.append(document.createElement('div'));
    root.append(outer, link);
    document.body.append(root);
    expect(containersOf([sheet], root).has(outer)).toBe(true);
    expect(containersOf([link.firstElementChild!], root).has(link)).toBe(false);
    root.remove();
  });

  it('topCornerRadius は上辺の左右の角丸の大きい方', async () => {
    const { topCornerRadius } = await import('./terrainDom');
    const card = document.createElement('div');
    card.style.borderTopLeftRadius = '14px';
    card.style.borderTopRightRadius = '18px';
    document.body.append(card);
    expect(topCornerRadius(card, window)).toBe(18);
    card.remove();
  });
});

describe('collectObstacles の soft (通過中だけ短くかぶってよいもの)', () => {
  it('画像・役割が img の要素は soft。背景の画像・色だけの箱は数えない。seeThrough の要素自身の画像は数えない', async () => {
    const { obstacleKind } = await import('./terrainDom');
    const root = document.createElement('main');
    document.body.append(root);
    const make = (tag: string, style: Partial<CSSStyleDeclaration>): HTMLElement => {
      const el = document.createElement(tag);
      Object.assign(el.style, style);
      el.getBoundingClientRect = () => ({ left: 0, top: 0, right: 100, bottom: 50, width: 100, height: 50, x: 0, y: 0, toJSON: () => ({}) }) as DOMRect;
      root.append(el);
      return el;
    };
    make('div', { backgroundColor: 'rgb(255, 255, 255)' });
    make('div', { backgroundImage: 'url("a.png")' });
    make('button', {});
    const img = make('img', {});
    const icon = make('span', {});
    icon.setAttribute('role', 'img');
    const region = [{ left: 0, top: 0, right: 100, bottom: 50 }];
    const found = collectObstacles(root, region, window) as (Rect & { source?: Element })[];
    // 箱の要素がどれかを (列挙しない) source で持つ。
    expect(found.map((o) => o.source)).toEqual([img, icon]);
    expect(found.map(obstacleKind)).toEqual(['soft', 'soft']);
    expect(collectObstacles(root, region, window, img).map((o) => (o as Rect & { source?: Element }).source)).toEqual([icon]);
    expect(collectObstacles(root, region, window, new Set<Element>([img, icon]))).toEqual([]);
    root.remove();
  });

  it('印のない矩形は hard として扱う', async () => {
    const { obstacleKind } = await import('./terrainDom');
    expect(obstacleKind({ left: 0, top: 0, right: 1, bottom: 1 })).toBe('hard');
  });
});

describe('topCornerRadius', () => {
  const button = (width: number, height: number, radius: string): HTMLElement => {
    const el = document.createElement('button');
    for (const corner of ['borderTopLeftRadius', 'borderTopRightRadius', 'borderBottomLeftRadius', 'borderBottomRightRadius'] as const) el.style[corner] = radius;
    el.getBoundingClientRect = () => ({ left: 0, top: 0, right: width, bottom: height, width, height, x: 0, y: 0, toJSON: () => ({}) }) as DOMRect;
    document.body.append(el);
    return el;
  };

  it('CSS が縮めて描く大きな半径 (999px の丸いボタン) は、縮めたあとの横の半径', () => {
    expect(topCornerRadius(button(200, 40, '999px'))).toBeCloseTo(20, 6);
    expect(topCornerRadius(button(200, 40, '16px'))).toBe(16);
  });

  it('楕円の角丸 (50%) は横の半径が幅の半分 (平らな上辺がない)', () => {
    expect(topCornerRadius(button(120, 32, '50%'))).toBeCloseTo(60, 6);
  });
});

describe('measureTerrain: 見えているデザインはすべて足場の候補', () => {
  const rect = (left: number, top: number, right: number, bottom: number) => () =>
    ({ left, top, right, bottom, width: right - left, height: bottom - top, x: left, y: top, toJSON: () => ({}) }) as DOMRect;

  it('背景・上の枠・影のある要素は上辺、下の枠線だけの仕切りは下の線。文字だけ・入力欄・固定・見えない要素は使わない', async () => {
    const { measureTerrain } = await import('./terrainDom');
    const root = document.createElement('main');
    document.body.append(root);
    const add = (tag: string, style: Partial<CSSStyleDeclaration>, box: [number, number, number, number], parent: Element = root): HTMLElement => {
      const el = document.createElement(tag);
      Object.assign(el.style, style);
      el.getBoundingClientRect = rect(...box);
      parent.append(el);
      return el;
    };
    const band = add('div', { backgroundColor: 'rgb(240, 240, 240)' }, [0, 100, 300, 140]);
    const framed = add('div', { borderTop: '1px solid rgb(0, 0, 0)' }, [0, 200, 300, 260]);
    const shadowed = add('nav', { boxShadow: '0 1px 2px rgb(0, 0, 0)' }, [0, 300, 300, 340]);
    const divider = add('div', { borderBottom: '1px solid rgb(200, 200, 200)' }, [0, 400, 300, 420]);
    const plain = add('p', {}, [0, 500, 300, 520]);
    plain.textContent = '文字だけ';
    add('input', { backgroundColor: 'rgb(255, 255, 255)' }, [0, 560, 300, 590]);
    add('div', { backgroundColor: 'rgb(0, 0, 0)', position: 'fixed' }, [0, 600, 300, 640]);
    add('div', { backgroundColor: 'rgb(0, 0, 0)', visibility: 'hidden' }, [0, 660, 300, 700]);
    const scroller = add('div', { overflowX: 'auto' }, [0, 720, 300, 800]);
    add('div', { backgroundColor: 'rgb(0, 0, 0)' }, [0, 730, 200, 760], scroller);
    const { elements, platforms } = measureTerrain(root, '', window);
    expect(elements).toEqual([band, framed, shadowed, divider]);
    expect(platforms.map((p) => p.top)).toEqual([100, 200, 300, 420]);
    root.remove();
  });

  it('スタイルの控えは invalidateStyleCache で捨てる (クラス・style の変化を次の計測に反映する)', async () => {
    const { measureTerrain, invalidateStyleCache } = await import('./terrainDom');
    const root = document.createElement('main');
    document.body.append(root);
    const el = document.createElement('div');
    el.getBoundingClientRect = rect(0, 100, 300, 140);
    root.append(el);
    invalidateStyleCache();
    expect(measureTerrain(root, '', window).elements).toEqual([]);
    el.style.backgroundColor = 'rgb(0, 0, 0)';
    // 控えを捨てるまでは前の結果のまま。
    expect(measureTerrain(root, '', window).elements).toEqual([]);
    invalidateStyleCache();
    expect(measureTerrain(root, '', window).elements).toEqual([el]);
    root.remove();
  });
});
