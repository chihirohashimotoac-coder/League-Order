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
