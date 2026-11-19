import { describe, expect, it } from 'vitest';
import { isSolid } from './terrainDom';

const style = (values: Record<string, string>): CSSStyleDeclaration =>
  ({
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
