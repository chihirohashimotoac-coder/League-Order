/**
 * ハリマルの描画レイヤー (React との最小の接続)。
 *
 * - アプリ側は「いまの画面」を渡すだけ。足場のある画面 (PR1 はホームだけ) でのみ描画する。
 * - 表示 OFF・「動きを減らす」・素材の読み込み失敗では何も描画しない (タイマー・計測も動かない)。
 * - レイヤーは body 直下に 1 つ (portal)。既存カードの DOM 構造・overflow・z-index は変更しない。
 *   `aria-hidden`・`pointer-events: none` で、読み上げ・フォーカス・クリックに関与しない。
 * - 動きは HarimaruController が 1 要素の transform だけで描くので、React は再描画しない。
 * - 追加素材 v0.9 (14 動作) は、登場のあとで画素密度に合う 1 組だけを読み込む。読み込みとデコードが
 *   終わった動作から使えるようになり、読み込めなかった動作は選ばれない (待機・歩行・睡眠はそのまま動く)。
 * - 観戦リアクション (PR3): 観戦画面が流すライブの状態 (liveFeed) を聞き、新しい出来事を判定して演出する。
 *   リアクションの画像は、味方の分かる状態が初めて届いたときに読み込む。画面を離れる・表示 OFF で購読をやめる。
 */
import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useMediaQuery } from '../../components/useMediaQuery';
import { HarimaruController } from './controller';
import { useHarimaruEnabled } from './preference';
import { atlasFor, BACKGROUND_SIZE, CLIP_IDS, clipUrlFor, REACTION_IDS, reactionUrlFor, type ClipId, type ReactionId } from './sprite';
import { subscribeLive } from './liveFeed';
import type { LiveState } from '../matches/parse';
import { allySide, LiveReactionTracker } from './liveReactions';
import './harimaru.css';

/**
 * 足場にする要素 (カード・タイルの上辺)。どの画面でも、上に文字・操作部品・スコアのない余白だけを使う
 * (terrain.ts)。安全な余白のない画面では表示しない。
 * `.n01-sheet` (ライブのスコア表の枠) は PR3 で追加: 観戦のライブ画面は、本日の対戦の帯 (横スクロール) が
 * フォーカスカードの上辺をふさぎ、ほかに立てる場所がなかったため (観戦リアクションを見せる場所)。
 */
const CARDS = '.card, .next-match-card, .quick-tile, .focus-card, .board-tile, .n01-list, .browse-lobby, .n01-sheet';
/**
 * 通常のコンテンツの中のボタンも足場の候補にする (上辺の安全な区間だけを使う。中央のラベルの左右など、区間ごとに判定)。
 * 入力欄は含めない。固定ナビ・モーダルの中は従来どおり使わない (root の外・固定・休止)。見えない要素とフォーカスの
 * 輪が出ている要素は計測で除く (terrainDom)。
 */
const BUTTONS = 'button, [role="button"], a.btn';
const PLATFORMS = `${CARDS}, ${BUTTONS}`;

/** 足場を探す画面。登録のない画面には出ない。 */
export const HARIMARU_PLATFORMS: Partial<Record<string, string>> = Object.fromEntries(
  ['home', 'watch', 'live', 'matches', 'analytics', 'setup', 'result', 'players', 'formats', 'pairs', 'history', 'settings', 'more'].map((page) => [page, PLATFORMS]),
);

export const REDUCED_MOTION_QUERY = '(prefers-reduced-motion: reduce)';

/**
 * 画面遷移のとき、次の画面のハリマルが入る左右の端 (前の画面でいた位置に近い側)。座標・足場・タイマーは
 * 引き継がない (画面ごとに作り直す)。初回は記録なし (安全な経路のある左右どちらか)。
 */
let carriedSide: 'left' | 'right' | null = null;

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
  const effectRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const sprite = ref.current;
    const effect = effectRef.current;
    const root = document.querySelector('.app-main');
    if (!sprite || !root) return undefined;
    let controller: HarimaruController | null = null;
    let disposed = false;
    /** いま使っている (または読み込み中の) 素材と、その要求の番号。古い要求の結果は反映しない。 */
    let requested = '';
    let generation = 0;
    /** 追加素材: 動作ごとの要求中の URL (画素密度が変わったら要求し直す)。 */
    const clipRequested = new Map<ClipId, string>();
    /** 読み込んだ画像を保持して、画像のキャッシュから外れないようにする。 */
    const keep = new Map<ClipId, HTMLImageElement>();

    /** 観戦リアクション: 読み込みを始めたか、動作ごとの要求中の URL (本体とエフェクトの組)。 */
    let reactionsWanted = false;
    const reactionRequested = new Map<ReactionId, string>();
    const keepReactions: HTMLImageElement[] = [];
    const loadReactions = (): void => {
      if (!reactionsWanted) return;
      const dpr = window.devicePixelRatio || 1;
      for (const id of REACTION_IDS) {
        const body = reactionUrlFor(id, 'body', dpr);
        const effectUrl = reactionUrlFor(id, 'effect', dpr);
        if (!body || !effectUrl) continue;
        const pairKey = `${body} ${effectUrl}`;
        if (reactionRequested.get(id) === pairKey) continue;
        reactionRequested.set(id, pairKey);
        const images = [body, effectUrl].map((url) => {
          const image = new Image();
          image.src = url;
          return image;
        });
        const ready = images.map((image) =>
          (typeof image.decode === 'function' ? image.decode() : new Promise<void>((resolve, reject) => {
            image.onload = () => resolve();
            image.onerror = () => reject(new Error('load'));
          })),
        );
        // 両方を読み込めた反応だけを登録する (読み込めなければ、その反応は演出しない)。
        void Promise.all(ready).then(
          () => {
            if (disposed || reactionRequested.get(id) !== pairKey || !controller) return;
            keepReactions.push(...images);
            controller.setReactionSheets(id, body, effectUrl);
          },
          () => undefined,
        );
      }
    };

    const loadClips = (): void => {
      const dpr = window.devicePixelRatio || 1;
      for (const id of CLIP_IDS) {
        const url = clipUrlFor(id, dpr);
        if (!url || clipRequested.get(id) === url) continue;
        clipRequested.set(id, url);
        const image = new Image();
        const current = (): boolean => !disposed && clipRequested.get(id) === url;
        image.onload = () => {
          // デコードを済ませてから使う (初めて切り替えたときのちらつきを防ぐ)。
          const decoded = typeof image.decode === 'function' ? image.decode().catch(() => undefined) : Promise.resolve();
          void decoded.then(() => {
            if (!current() || !controller) return;
            keep.set(id, image);
            controller.setSheet(id, url);
          });
        };
        // 読み込めない動作は登録しない (選ばれない)。
        image.onerror = () => undefined;
        image.src = url;
      }
    };

    const load = (): void => {
      const url = atlasFor(window.devicePixelRatio || 1);
      if (url === requested) return;
      requested = url;
      generation += 1;
      const mine = generation;
      const image = new Image();
      // URL が 1x → 2x → 1x と戻っても、最初の 1x の結果は古い要求として扱う。
      const current = (): boolean => !disposed && mine === generation;
      image.onload = () => {
        if (!current()) return;
        sprite.style.backgroundImage = `url("${url}")`;
        sprite.dataset.ready = 'true';
        if (!controller) {
          controller = new HarimaruController({
            sprite,
            effect: effect ?? undefined,
            root,
            watch: root.closest('.app') ?? root.parentElement ?? root,
            platformSelector: selector,
            entryFrom: carriedSide,
          });
          controller.start();
          // 開発サーバーだけ: 動作の確認用に操作口を出す (本番のビルドには含まれない)。
          if (import.meta.env.DEV) (window as Window & { __harimaru?: HarimaruController }).__harimaru = controller;
        }
        controller.setSheet('base', url);
        loadClips();
        loadReactions();
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

    // 観戦リアクション: 観戦画面が流すライブの状態を聞く。判定は観戦画面 (source) と味方ごとに作り直す。
    let tracker: { source: string; allyId: string | null; judge: LiveReactionTracker } | null = null;
    /** 最後に受け取った状態の対戦の単位とゲーム (mid) (中立の状態も含む)。切り替わったら演出を取り消す。 */
    let lastUnit: string | null = null;
    let lastMid: string | null = null;
    /** 状態を判定する。react が false なら演出しない (基準にするだけ)。 */
    const take = (source: string, state: LiveState, allyId: string | null, react: boolean): void => {
      if (!tracker || tracker.source !== source || tracker.allyId !== allyId) {
        // 観戦画面・味方が変わった: 判定を作り直し、前の対戦の演出・待っている出来事を取り消す。
        if (tracker) controller?.cancelLive();
        tracker = { source, allyId, judge: new LiveReactionTracker(allyId) };
      }
      if (allyId && !reactionsWanted) {
        reactionsWanted = true;
        loadReactions();
      }
      // 同じ観戦画面の中で対戦が切り替わった (カードの選び直しなど)、または味方を決められない状態になった:
      // 前の対戦・味方の演出と待っている出来事を取り消す (判定より先に確かめる)。
      const unit = state.tmid ?? state.scid ?? state.mid;
      // 同じ対戦の次のゲーム・セット (mid) に進んだときも、前のゲームの演出・待っている出来事を取り消す
      // (その応答で確定した前のゲームの結果は、取り消したあとの判定で演出する)。
      if ((lastUnit !== null && unit !== lastUnit) || (lastMid !== null && state.mid !== lastMid) || allySide(state, allyId) === null) controller?.cancelLive();
      lastUnit = unit;
      lastMid = state.mid;
      if (!react) {
        tracker.judge.rebaseline();
        tracker.judge.update(state);
        return;
      }
      const event = tracker.judge.update(state);
      if (event && controller) controller.reactLive(event.reaction);
    };
    const unsubscribe = subscribeLive((message) => {
      if (message.kind === 'release') {
        // 観戦画面を離れた: その対戦の演出中・待っている出来事も取り消す。
        if (tracker?.source === message.source) {
          tracker = null;
          lastUnit = null;
          lastMid = null;
          controller?.cancelLive();
        }
        return;
      }
      if (message.kind === 'hold') {
        // いま反応している観戦対象の画面が過去の Leg を表示し始めた: 演出中・待っている出来事を取り消す
        // (解除のあとは基準からやり直す)。ほかの観戦対象の画面の操作では取り消さない。
        if (tracker?.source === message.source) controller?.cancelLive();
        return;
      }
      if (message.kind === 'rebase') {
        if (message.base) {
          // 過去の Leg の表示をすべて解除した: 表示中に受け取った同じ観戦対象の最新の状態を、演出せずに基準にする
          // (解除のあとに `changed: 0` が続いても、次の新しい出来事を基準として捨てない)。
          take(message.source, message.base.state, message.base.allyId, false);
        } else if (tracker?.source === message.source) {
          tracker.judge.rebaseline();
        }
        return;
      }
      take(message.source, message.state, message.allyId, true);
    });
    // タブが非表示から戻ったとき: その間に起きたこと (戻った直後の取得で届く) には反応しない。
    // (表示の切り替えより前に受け取った状態を停止の解除の基準に使わないことは、liveFeed が見張る。)
    const onVisibility = (): void => {
      if (document.visibilityState === 'visible') tracker?.judge.rebaseline();
    };
    document.addEventListener('visibilitychange', onVisibility);

    return () => {
      disposed = true;
      unsubscribe();
      document.removeEventListener('visibilitychange', onVisibility);
      tracker = null;
      keepReactions.length = 0;
      window.removeEventListener('resize', load);
      if (controller) carriedSide = controller.exitSide() ?? carriedSide;
      controller?.destroy();
      controller = null;
      keep.clear();
      if (import.meta.env.DEV) delete (window as Window & { __harimaru?: HarimaruController }).__harimaru;
    };
  }, [selector, onFail]);

  return (
    <>
      <div
        ref={ref}
        className="harimaru-sprite"
        data-testid="harimaru"
        data-visible="false"
        style={{ backgroundSize: BACKGROUND_SIZE }}
      />
      {/* 観戦リアクションのエフェクト (本体より広い 52×42 CSS px)。演出の間だけ表示する。 */}
      <div ref={effectRef} className="harimaru-effect" data-testid="harimaru-effect" data-active="false" />
    </>
  );
}
