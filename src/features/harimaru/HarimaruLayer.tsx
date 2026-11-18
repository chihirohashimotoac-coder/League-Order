/**
 * ハリマルの描画レイヤー (React との最小の接続)。
 *
 * - アプリ側は「いまの画面」を渡すだけ。足場のある画面 (PR1 はホームだけ) でのみ描画する。
 * - 表示 OFF・「動きを減らす」・素材の読み込み失敗では何も描画しない (タイマー・計測も動かない)。
 * - レイヤーは body 直下に 1 つ (portal)。既存カードの DOM 構造・overflow・z-index は変更しない。
 *   `aria-hidden`・`pointer-events: none` で、読み上げ・フォーカス・クリックに関与しない。
 * - 動きは HarimaruController が 1 要素の transform だけで描くので、React は再描画しない。
 */
import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useMediaQuery } from '../../components/useMediaQuery';
import { HarimaruController } from './controller';
import { useHarimaruEnabled } from './preference';
import { atlasFor, BACKGROUND_SIZE } from './sprite';
import './harimaru.css';

/** 画面ごとの足場 (カード・タイルの上辺)。登録のない画面には出ない。 */
export const HARIMARU_PLATFORMS: Partial<Record<string, string>> = {
  home: '.home-grid .next-match-card, .home-grid .card, .home-grid .quick-tile',
};

export const REDUCED_MOTION_QUERY = '(prefers-reduced-motion: reduce)';

export function HarimaruLayer({ page }: { page: string }): React.JSX.Element | null {
  const enabled = useHarimaruEnabled();
  const reduced = useMediaQuery(REDUCED_MOTION_QUERY);
  const [failed, setFailed] = useState(false);
  const selector = HARIMARU_PLATFORMS[page];
  if (!enabled || reduced || failed || !selector || typeof document === 'undefined') return null;
  return createPortal(
    <div className="harimaru-layer" aria-hidden="true" data-testid="harimaru-layer">
      {/* 画面ごとに作り直す: 旧画面の足場・タイマーを残さない。 */}
      <HarimaruSprite key={page} selector={selector} onFail={setFailed} />
    </div>,
    document.body,
  );
}

function HarimaruSprite({ selector, onFail }: { selector: string; onFail: (failed: boolean) => void }): React.JSX.Element {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const sprite = ref.current;
    const root = document.querySelector('.app-main');
    if (!sprite || !root) return undefined;
    let controller: HarimaruController | null = null;
    let disposed = false;
    /** いま使っている (または読み込み中の) 素材。古い要求の結果は反映しない。 */
    let requested = '';

    const load = (): void => {
      const url = atlasFor(window.devicePixelRatio || 1);
      if (url === requested) return;
      requested = url;
      const image = new Image();
      const current = (): boolean => !disposed && requested === url;
      image.onload = () => {
        if (!current()) return;
        sprite.style.backgroundImage = `url("${url}")`;
        sprite.dataset.ready = 'true';
        if (!controller) {
          controller = new HarimaruController({ sprite, root, watch: root.closest('.app') ?? root.parentElement ?? root, platformSelector: selector });
          controller.start();
        }
      };
      image.onerror = () => {
        if (!current()) return;
        // 素材が読めない: キャラクターを休止する (何も描画しない)。
        onFail(true);
      };
      image.src = url;
    };
    load();
    // ズームで画素密度が変わったら、合う解像度の素材に差し替える。
    window.addEventListener('resize', load);
    return () => {
      disposed = true;
      window.removeEventListener('resize', load);
      controller?.destroy();
      controller = null;
    };
  }, [selector, onFail]);

  return (
    <div
      ref={ref}
      className="harimaru-sprite"
      data-testid="harimaru"
      data-visible="false"
      style={{ backgroundSize: BACKGROUND_SIZE }}
    />
  );
}
