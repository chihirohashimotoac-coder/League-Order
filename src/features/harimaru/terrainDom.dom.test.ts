import { describe, expect, it } from 'vitest';
import { isSolid } from './terrainDom';

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

  it('カード自身 (色の付いた箱) は数えず、カードの中の色の付いた要素・ボタンは数える', async () => {
    const { collectObstacles } = await import('./terrainDom');
    const root = document.createElement('main');
    const card = document.createElement('div');
    card.style.backgroundColor = 'rgb(255, 255, 255)';
    card.getBoundingClientRect = rect(100, 300, 500, 400);
    const badge = document.createElement('span');
    badge.style.backgroundColor = 'rgb(200, 0, 0)';
    badge.getBoundingClientRect = rect(120, 304, 160, 318);
    const button = document.createElement('button');
    button.getBoundingClientRect = rect(300, 350, 360, 380);
    card.append(badge, button);
    root.append(card);
    document.body.append(root);
    const region = { left: 100, top: 300, right: 500, bottom: 312 };
    // ふつうはカードの箱がまるごと障害物。
    expect(collectObstacles(root, [region], window)).toContainEqual({ left: 100, top: 300, right: 500, bottom: 400 });
    const inside = collectObstacles(root, [region], window, card);
    expect(inside).not.toContainEqual({ left: 100, top: 300, right: 500, bottom: 400 });
    expect(inside).toContainEqual({ left: 120, top: 304, right: 160, bottom: 318 });
    // 範囲の外のボタンは数えない。
    expect(inside).not.toContainEqual({ left: 300, top: 350, right: 360, bottom: 380 });
    root.remove();
  });

  it('足場を包む入れ物 (色付きのカード) は、帯を完全に包むときだけ数えない。中の文字・部品・帯の一部にかかる枠は数える', async () => {
    const { collectObstacles, containersOf } = await import('./terrainDom');
    const root = document.createElement('main');
    const outer = document.createElement('section');
    outer.style.backgroundColor = 'rgb(255, 255, 255)';
    outer.getBoundingClientRect = rect(0, 100, 400, 900);
    const sheet = document.createElement('div');
    sheet.getBoundingClientRect = rect(20, 300, 380, 600);
    const tab = document.createElement('button');
    tab.getBoundingClientRect = rect(20, 260, 80, 290);
    const panel = document.createElement('div');
    panel.style.backgroundColor = 'rgb(240, 240, 240)';
    panel.getBoundingClientRect = rect(200, 250, 300, 285);
    outer.append(tab, panel, sheet);
    root.append(outer);
    document.body.append(root);
    const containers = containersOf([sheet], root);
    expect(containers.has(outer)).toBe(true);
    const band = { left: 20, right: 380, top: 277, bottom: 300 };
    const found = collectObstacles(root, [band], window, undefined, containers);
    expect(found).not.toContainEqual({ left: 0, top: 100, right: 400, bottom: 900 });
    expect(found).toContainEqual({ left: 20, top: 260, right: 80, bottom: 290 });
    expect(found).toContainEqual({ left: 200, top: 250, right: 300, bottom: 285 });
    // 入れ物を渡さなければ、ふつうに色付きの箱として数える (PR2 までと同じ)。
    expect(collectObstacles(root, [band], window)).toContainEqual({ left: 0, top: 100, right: 400, bottom: 900 });
    // 操作部品は入れ物にしない。
    const link = document.createElement('a');
    link.append(document.createElement('div'));
    root.append(link);
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
