import { act, cleanup, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { HarimaruLayer } from './HarimaruLayer';
import { resetHarimaruPreferenceForTests, saveHarimaruEnabled } from './preference';

/** 画像の読み込みを手で成功・失敗させる。 */
class FakeImage {
  static instances: FakeImage[] = [];
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  src = '';
  constructor() {
    FakeImage.instances.push(this);
  }
}

let reduced = false;
const mediaListeners = new Set<() => void>();

beforeEach(() => {
  FakeImage.instances = [];
  reduced = false;
  vi.stubGlobal('Image', FakeImage);
  vi.stubGlobal('matchMedia', (query: string) => ({
    get matches() {
      return query.includes('prefers-reduced-motion') ? reduced : false;
    },
    media: query,
    addEventListener: (_: string, fn: () => void) => mediaListeners.add(fn),
    removeEventListener: (_: string, fn: () => void) => mediaListeners.delete(fn),
  }));
  const main = document.createElement('main');
  main.className = 'app-main';
  document.body.append(main);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  window.localStorage.clear();
  resetHarimaruPreferenceForTests();
  mediaListeners.clear();
  document.body.innerHTML = '';
});

const layer = (): Element | null => document.body.querySelector('[data-testid="harimaru-layer"]');

describe('HarimaruLayer', () => {
  it('ホームでは body 直下に aria-hidden の描画レイヤーを 1 つだけ置く', () => {
    render(<HarimaruLayer page="home" />);
    expect(document.body.querySelectorAll('[data-testid="harimaru-layer"]')).toHaveLength(1);
    expect(layer()?.parentElement).toBe(document.body);
    expect(layer()?.getAttribute('aria-hidden')).toBe('true');
    expect(document.body.querySelectorAll('[data-testid="harimaru"]')).toHaveLength(1);
    // 端末に合う素材 1 枚だけを読み込む。
    expect(FakeImage.instances).toHaveLength(1);
  });

  it('足場のない画面では何も描画しない', () => {
    render(<HarimaruLayer page="setup" />);
    expect(layer()).toBeNull();
    expect(FakeImage.instances).toHaveLength(0);
  });

  it('表示 OFF では描画せず、ON に戻すと現れる', () => {
    saveHarimaruEnabled(false);
    render(<HarimaruLayer page="home" />);
    expect(layer()).toBeNull();
    act(() => {
      saveHarimaruEnabled(true);
    });
    expect(layer()).not.toBeNull();
  });

  it('「動きを減らす」では描画しない (設定の変更にも追従する)', () => {
    render(<HarimaruLayer page="home" />);
    expect(layer()).not.toBeNull();
    act(() => {
      reduced = true;
      for (const fn of mediaListeners) fn();
    });
    expect(layer()).toBeNull();
  });

  it('素材を読み込めなければ休止する (何も描画しない)', () => {
    render(<HarimaruLayer page="home" />);
    act(() => {
      FakeImage.instances[0].onerror?.();
    });
    expect(layer()).toBeNull();
  });

  it('画素密度が変わったら新しい素材だけを反映し、古い要求の結果は無視する', () => {
    const ratio = vi.spyOn(window, 'devicePixelRatio', 'get').mockReturnValue(1);
    render(<HarimaruLayer page="home" />);
    ratio.mockReturnValue(2);
    act(() => {
      window.dispatchEvent(new Event('resize'));
    });
    expect(FakeImage.instances).toHaveLength(2);
    // 同じ画素密度での resize は要求し直さない。
    act(() => {
      window.dispatchEvent(new Event('resize'));
    });
    expect(FakeImage.instances).toHaveLength(2);
    const sprite = document.body.querySelector<HTMLElement>('[data-testid="harimaru"]')!;
    act(() => {
      FakeImage.instances[1].onload?.();
      // 古い (1x) 要求の失敗・成功は反映しない。
      FakeImage.instances[0].onerror?.();
      FakeImage.instances[0].onload?.();
    });
    expect(layer()).not.toBeNull();
    expect(sprite.style.backgroundImage).toContain('@2x');
    ratio.mockRestore();
  });

  it('読み込めたら素材を表示に使う (登場までは透明)', () => {
    render(<HarimaruLayer page="home" />);
    act(() => {
      FakeImage.instances[0].onload?.();
    });
    const sprite = document.body.querySelector<HTMLElement>('[data-testid="harimaru"]')!;
    expect(sprite.dataset.ready).toBe('true');
    expect(sprite.style.backgroundImage).toContain('harimaru_atlas');
    expect(sprite.dataset.visible).toBe('false');
  });
});
