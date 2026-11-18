/**
 * ハリマルの動作エンジン (命令的な小さなクラス)。React の外で 1 つの要素の transform と
 * background-position だけを書き換え、アプリ全体を再描画しない。
 *
 * - 状態: 登場前 / 待機 / 歩行 / 睡眠 / 休止。休止中はタイマー・requestAnimationFrame を残さない。
 * - 休止の条件: 画面が非表示、モーダル・シート表示中、キャラクターが画面外 (スクロール)。
 * - 足場は実 DOM を計測して決める (terrainDom)。DOM の変化・リサイズ・スクロール停止で計測し直し、
 *   いまの足場が消えた・動いたら、その場で姿を消して安全な場所から出直す。
 * - ユーザーの操作は「最後に操作した時刻」を記録するだけ (受動的なリスナー)。既定の動作は止めない。
 */
import { decideNext, between, clamp, type Decision, type HarimaruAction, type Rng } from './behavior';
import {
  DEFAULT_ANIMATION,
  DEFAULT_BEHAVIOR,
  DEFAULT_TIMING,
  SPRITE,
  type AnimationParams,
  type BehaviorParams,
  type TimingParams,
} from './params';
import { framePosition, IDLE_BLINK, IDLE_OPEN, ROW, SLEEP_FRAMES, WALK_FRAMES, type SpriteRow } from './sprite';
import { computeSegments, findSegment, visibleSegments, type Segment } from './terrain';
import { measureTerrain, type MeasuredTerrain } from './terrainDom';

/**
 * 休止の理由。hidden = タブ非表示、modal = モーダル・シート表示中、offscreen = キャラクターが画面外、
 * shift = 足場の近くで位置・大きさの変わるアニメーション中 (ホバーで浮くタイルなど。終わるまで隠す)。
 */
export type PauseReason = 'hidden' | 'modal' | 'offscreen' | 'shift';

export interface ControllerOptions {
  /** 動かす要素 (描画レイヤーの子)。 */
  sprite: HTMLElement;
  /** 足場を探す範囲 (例: `.app-main`)。 */
  root: Element;
  /** モーダルの出現・DOM の変化を見張る範囲 (既定: root の親 = アプリ全体)。 */
  watch?: Element;
  /** 足場にする要素のセレクター。 */
  platformSelector: string;
  win?: Window;
  rng?: Rng;
  now?: () => number;
  /** テスト用: 計測の差し替え。 */
  measure?: (root: Element, selector: string, win: Window) => MeasuredTerrain;
  behavior?: BehaviorParams;
  animation?: AnimationParams;
  timing?: TimingParams;
}

const MODAL_SELECTOR = '[aria-modal="true"], .sheet-backdrop';
const ACTIVITY_EVENTS = ['pointerdown', 'keydown', 'wheel', 'touchstart'] as const;
const HISTORY_LENGTH = 6;
const MAX_ANIMATION_WAITS = 10;
/** この CSS プロパティのトランジションは要素の位置・大きさを変える (色・影は数えない)。 */
const GEOMETRY_PROPERTY = /^(all|transform|translate|scale|rotate|top|right|bottom|left|inset.*|width|height|min-.*|max-.*|margin.*|padding.*|border(-top|-bottom)?-width|font-size|line-height)$/;
/** 位置が変わり続けても、この時間で一度計測し直す (終了イベントが届かない場合の保険)。 */
const SHIFT_FALLBACK_MS = 2_000;
/** 保険の確認を繰り返す回数。超えても動いていれば、姿を消して安全な場所から出直す。 */
const SHIFT_MAX_CHECKS = 5;
/** 足場の高さがこの範囲でずれたら、足元を合わせ直して続ける (ホバーで 2px 浮くタイルなど)。 */
const SNAP_TOLERANCE = 3;

export class HarimaruController {
  private readonly sprite: HTMLElement;
  private readonly root: Element;
  private readonly watch: Element;
  private readonly selector: string;
  private readonly win: Window;
  private readonly rng: Rng;
  private readonly now: () => number;
  private readonly measureFn: (root: Element, selector: string, win: Window) => MeasuredTerrain;
  private readonly behavior: BehaviorParams;
  private readonly animation: AnimationParams;
  private readonly timing: TimingParams;

  /** 行動に属するタイマー (中断で消す)。 */
  private readonly actionTimers = new Set<number>();
  /** 計測・スクロール停止などの補助タイマー。 */
  private remeasureTimer: number | null = null;
  private scrollTimer: number | null = null;
  private shiftTimer: number | null = null;
  private frame: number | null = null;
  /** 足場の近くで動いているトランジション・アニメーションの対象。 */
  private readonly shifting = new Map<EventTarget, Set<string>>();
  private shiftChecks = 0;
  private readonly cleanups: (() => void)[] = [];
  private readonly pauses = new Set<PauseReason>();

  private destroyed = false;
  private started = false;
  /** 足場に立っているか (登場済み)。 */
  private placed = false;
  private animationWaits = 0;
  private x = 0;
  private top = 0;
  /** 最後に確かめた足場と、そのときの表示範囲。 */
  private segment: Segment | null = null;
  private view: MeasuredTerrain['view'] | null = null;
  private dir: -1 | 1 = -1;
  private action: HarimaruAction | null = null;
  private history: HarimaruAction[] = [];
  private lastActivityAt: number;
  private wakeRolled = false;

  constructor(options: ControllerOptions) {
    this.sprite = options.sprite;
    this.root = options.root;
    this.watch = options.watch ?? options.root.parentElement ?? options.root;
    this.selector = options.platformSelector;
    this.win = options.win ?? window;
    this.rng = options.rng ?? Math.random;
    this.now = options.now ?? (() => Date.now());
    this.measureFn = options.measure ?? measureTerrain;
    this.behavior = options.behavior ?? DEFAULT_BEHAVIOR;
    this.animation = options.animation ?? DEFAULT_ANIMATION;
    this.timing = options.timing ?? DEFAULT_TIMING;
    this.lastActivityAt = this.now();
  }

  // ------------------------------------------------------------------ 公開 API

  start(): void {
    if (this.started || this.destroyed) return;
    this.started = true;
    this.setVisible(false);
    this.listen();
    if (this.win.document.hidden) this.pauses.add('hidden');
    if (this.modalOpen()) this.pauses.add('modal');
    // 休止中は登場を予約しない (休止が解けたときに予約する)。
    if (!this.blocked()) this.scheduleEnter(between(this.rng, this.timing.enterDelayMs));
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.interrupt();
    this.clearAuxTimers();
    for (const cleanup of this.cleanups.splice(0)) cleanup();
    this.setVisible(false);
  }

  /** テスト・デバッグ用の現在の状態。 */
  snapshot(): { placed: boolean; action: HarimaruAction | null; x: number; top: number; dir: -1 | 1; paused: PauseReason[]; timers: number; auxTimers: number; frame: boolean } {
    return {
      placed: this.placed,
      action: this.action,
      x: this.x,
      top: this.top,
      dir: this.dir,
      paused: [...this.pauses],
      timers: this.actionTimers.size,
      auxTimers: [this.remeasureTimer, this.scrollTimer, this.shiftTimer].filter((id) => id !== null).length,
      frame: this.frame !== null,
    };
  }

  // ------------------------------------------------------------------ 監視

  private listen(): void {
    const win = this.win;
    const doc = win.document;
    const add = <K extends keyof WindowEventMap>(target: Window, type: K, fn: (event: WindowEventMap[K]) => void, options?: AddEventListenerOptions): void => {
      target.addEventListener(type, fn, options);
      this.cleanups.push(() => target.removeEventListener(type, fn, options));
    };

    const onActivity = (): void => this.noteActivity();
    for (const type of ACTIVITY_EVENTS) add(win, type, onActivity, { passive: true, capture: true });
    add(win, 'scroll', () => this.onScroll(), { passive: true });
    add(win, 'resize', () => this.scheduleRemeasure());

    // ピンチズーム・拡大後のパン (見えている範囲が変わる)。
    const viewport = win.visualViewport;
    if (viewport) {
      const onViewportScroll = (): void => this.onScroll();
      const onViewportResize = (): void => {
        this.onScroll();
        this.scheduleRemeasure();
      };
      viewport.addEventListener('scroll', onViewportScroll, { passive: true });
      viewport.addEventListener('resize', onViewportResize, { passive: true });
      this.cleanups.push(() => {
        viewport.removeEventListener('scroll', onViewportScroll);
        viewport.removeEventListener('resize', onViewportResize);
      });
    }

    // 足場の近くで位置の変わるトランジション・アニメーションが始まったら、終わるまで隠す。
    // 同じ要素でも、位置のトランジション (プロパティごと) とアニメーション (名前ごと) を別々に数える。
    const shiftKey = (event: Event): string =>
      event.type.startsWith('transition')
        ? `transition:${(event as TransitionEvent).propertyName ?? ''}`
        : `animation:${(event as AnimationEvent).animationName ?? ''}`;
    const onShiftStart = (event: Event): void => {
      if (event.type === 'transitionrun' && !GEOMETRY_PROPERTY.test((event as TransitionEvent).propertyName ?? '')) return;
      // タブ非表示・モーダルの休止中は計測しない (休止が解けたときに計測し直す)。
      if (this.destroyed || this.pauses.has('hidden') || this.pauses.has('modal')) return;
      if (!event.target || !this.nearSprite(event.target)) return;
      const keys = this.shifting.get(event.target) ?? new Set<string>();
      keys.add(shiftKey(event));
      this.shifting.set(event.target, keys);
      this.pause('shift');
      this.shiftChecks = 0;
      this.armShiftFallback();
    };
    const onShiftEnd = (event: Event): void => {
      const keys = event.target ? this.shifting.get(event.target) : undefined;
      if (!keys || !keys.delete(shiftKey(event))) return;
      if (keys.size === 0) this.shifting.delete(event.target!);
      if (this.shifting.size > 0) return;
      this.clearTimer('shift');
      this.resume('shift');
    };
    const root = this.root;
    for (const type of ['transitionrun', 'animationstart']) root.addEventListener(type, onShiftStart, { capture: true, passive: true });
    for (const type of ['transitionend', 'transitioncancel', 'animationend', 'animationcancel']) root.addEventListener(type, onShiftEnd, { capture: true, passive: true });
    this.cleanups.push(() => {
      for (const type of ['transitionrun', 'animationstart']) root.removeEventListener(type, onShiftStart, { capture: true });
      for (const type of ['transitionend', 'transitioncancel', 'animationend', 'animationcancel']) root.removeEventListener(type, onShiftEnd, { capture: true });
    });

    const onVisibility = (): void => (doc.hidden ? this.pause('hidden') : this.resume('hidden'));
    doc.addEventListener('visibilitychange', onVisibility);
    this.cleanups.push(() => doc.removeEventListener('visibilitychange', onVisibility));

    const RO = (win as Window & { ResizeObserver?: typeof ResizeObserver }).ResizeObserver;
    if (RO) {
      // ResizeObserver の通知は描画の前に届く: その場で確かめ、立てなくなっていれば描画される前に消す。
      const observer = new RO(() => {
        this.checkNow();
        this.scheduleRemeasure();
      });
      observer.observe(this.root);
      this.cleanups.push(() => observer.disconnect());
    }
    const MO = (win as Window & { MutationObserver?: typeof MutationObserver }).MutationObserver;
    if (MO) {
      const observer = new MO(() => {
        // モーダル・シートは開いた瞬間に隠す (計測を待たない)。
        if (this.modalOpen()) this.pause('modal');
        else this.resume('modal');
        // DOM の変化 (MutationObserver の通知は描画の前) で足場が消えた・動いた・ボタンが入ったら、
        // 再計測のまとめ待ちをせず、変化が描画される前に消す。
        this.checkNow();
        this.scheduleRemeasure();
      });
      observer.observe(this.watch, { childList: true, subtree: true });
      this.cleanups.push(() => observer.disconnect());
    }
    const fonts = (doc as Document & { fonts?: FontFaceSet }).fonts;
    fonts?.ready.then(() => this.scheduleRemeasure()).catch(() => undefined);
  }

  /**
   * 要素がキャラクターの周囲、または歩ける範囲 (いまの足場の全幅) の足元にかかっているか。
   * 歩いて向かう先の足場が動く場合も含める (左右 8px、上下 40px の余裕)。
   */
  private nearSprite(target: EventTarget): boolean {
    if (!this.placed || !(target instanceof Element)) return false;
    const rect = target.getBoundingClientRect();
    const from = Math.min(this.x, this.segment?.minX ?? this.x);
    const to = Math.max(this.x, this.segment?.maxX ?? this.x);
    const left = from - this.win.scrollX - 8;
    const right = to - this.win.scrollX + SPRITE.width + 8;
    const top = this.top - this.win.scrollY - 40;
    const bottom = this.top - this.win.scrollY + 40;
    return rect.right > left && rect.left < right && rect.bottom > top && rect.top < bottom;
  }

  /** 位置変化の終了が届かない場合の保険。まだ動いていれば待ち続け、長すぎれば出直す。 */
  private armShiftFallback(): void {
    this.clearTimer('shift');
    this.shiftTimer = this.win.setTimeout(() => {
      this.shiftTimer = null;
      if (this.stillShifting() && this.shiftChecks < SHIFT_MAX_CHECKS) {
        this.shiftChecks += 1;
        this.armShiftFallback();
        return;
      }
      const moving = this.stillShifting();
      this.shifting.clear();
      if (moving) {
        // 安全を確かめられない: 非表示のまま、動きが落ち着いてから安全な場所に出直す。
        this.pauses.delete('shift');
        this.vanish(between(this.rng, this.timing.enterDelayMs));
        return;
      }
      this.resume('shift');
    }, SHIFT_FALLBACK_MS);
  }

  /** 見張っている要素で、有限のアニメーション・トランジションがまだ動いているか。 */
  private stillShifting(): boolean {
    for (const target of this.shifting.keys()) {
      const animations = (target as Element & { getAnimations?: () => Animation[] }).getAnimations?.() ?? [];
      if (animations.some((a) => a.playState === 'running' && a.effect?.getTiming().iterations !== Infinity)) return true;
    }
    return false;
  }

  /** タイマー・計測を止めておく休止 (画面外の休止はスクロール停止の確認だけ続ける)。 */
  private blocked(): boolean {
    return this.pauses.has('hidden') || this.pauses.has('modal') || this.pauses.has('shift');
  }

  private modalOpen(): boolean {
    return this.win.document.querySelector(MODAL_SELECTOR) !== null;
  }

  private noteActivity(): void {
    this.lastActivityAt = this.now();
    if (this.action === 'sleep' && !this.wakeRolled && this.pauses.size === 0) {
      this.wakeRolled = true;
      if (this.rng() < this.timing.wakeOnActivityChance) {
        this.interrupt();
        this.after(between(this.rng, [300, 1_200]), () => this.wake());
      }
    }
  }

  private onScroll(): void {
    this.noteActivity();
    this.clearTimer('scroll');
    if (this.destroyed || this.blocked()) return;
    this.scrollTimer = this.win.setTimeout(() => {
      this.scrollTimer = null;
      this.onScrollEnd();
    }, this.timing.scrollIdleMs);
  }

  private onScrollEnd(): void {
    if (this.destroyed || this.blocked()) return;
    if (!this.placed) {
      if (!this.placed) this.scheduleEnter(0);
      return;
    }
    const terrain = this.measureFn(this.root, this.selector, this.win);
    const inView =
      this.top - SPRITE.height >= terrain.view.top &&
      this.top <= terrain.view.bottom &&
      this.x + SPRITE.sideInset >= terrain.view.left &&
      this.x + SPRITE.width - SPRITE.sideInset <= terrain.view.right;
    if (inView) {
      this.resume('offscreen');
      return;
    }
    // 見えない場所にいる: 見える足場があれば、そこへこっそり移る。なければ休む。
    const segments = visibleSegments(computeSegments(terrain), terrain.view);
    if (segments.length > 0) {
      this.pauses.delete('offscreen');
      this.vanish(0);
    } else {
      this.pause('offscreen');
    }
  }

  // ------------------------------------------------------------------ 休止・再開

  private pause(reason: PauseReason): void {
    if (this.destroyed || this.pauses.has(reason)) return;
    this.pauses.add(reason);
    this.interrupt();
    if (reason === 'hidden' || reason === 'modal') {
      // 位置変化の見張りもやめる (休止が解けたときに足場を計測し直すので、ここで待つ必要はない)。
      this.clearTimer('shift');
      this.shifting.clear();
      this.pauses.delete('shift');
    }
    if (reason !== 'offscreen') {
      // 即座に消す (フェードしない)。休止中は計測・スクロールの補助タイマーも残さない。
      this.setVisible(false);
      this.clearTimer('remeasure');
      this.clearTimer('scroll');
    }
  }

  private resume(reason: PauseReason): void {
    if (this.destroyed || !this.pauses.delete(reason) || this.pauses.size > 0) return;
    if (!this.placed) {
      this.scheduleEnter(between(this.rng, this.timing.enterDelayMs) / 2);
      return;
    }
    // 休止中に画面が変わったかもしれない: 計測し直して、同じ場所に立てるときだけ続ける。
    const segment = this.currentSegment();
    if (segment) {
      this.setVisible(true);
      this.run({ action: 'idle', durationMs: between(this.rng, this.behavior.idleMs) });
    } else {
      this.placed = false;
      this.setVisible(false);
      this.scheduleEnter(between(this.rng, this.timing.enterDelayMs));
    }
  }

  // ------------------------------------------------------------------ 計測

  private scheduleRemeasure(): void {
    if (this.destroyed || this.blocked()) return;
    this.clearTimer('remeasure');
    this.remeasureTimer = this.win.setTimeout(() => {
      this.remeasureTimer = null;
      this.remeasure();
    }, this.timing.remeasureDebounceMs);
  }

  private remeasure(): void {
    if (this.destroyed || this.blocked()) return;
    if (!this.placed) {
      this.scheduleEnter(0);
      return;
    }
    if (this.animating()) {
      this.scheduleRemeasure();
      return;
    }
    const segment = this.currentSegment();
    if (!segment) {
      // 足場が動いた・消えた: 文字やボタンに重ならないよう、すぐに姿を消して出直す。
      this.vanish(between(this.rng, this.timing.enterDelayMs));
      return;
    }
    this.segment = segment;
    if (this.action === 'walk') {
      // 歩いている途中で足場が縮んだら、新しい範囲の中で止まる。
      const clamped = clamp(this.x, segment.minX, segment.maxX);
      if (clamped !== this.x) {
        this.x = clamped;
        this.run({ action: 'idle', durationMs: between(this.rng, this.behavior.idleMs) });
      }
    }
  }

  /** いまの位置にまだ立てるかを、その場で確かめる (立てなければ即座に消えて出直す)。 */
  private checkNow(): void {
    if (this.destroyed || !this.placed || this.pauses.size > 0) return;
    const segment = this.currentSegment();
    if (!segment) {
      this.vanish(between(this.rng, this.timing.enterDelayMs));
      return;
    }
    if (this.x < segment.minX || this.x > segment.maxX) {
      this.x = clamp(this.x, segment.minX, segment.maxX);
      this.run({ action: 'idle', durationMs: between(this.rng, this.behavior.idleMs) });
    }
  }

  private currentSegment(): Segment | null {
    const terrain = this.measureFn(this.root, this.selector, this.win);
    this.view = terrain.view;
    this.segment = findSegment(computeSegments(terrain), this.top, this.x, SNAP_TOLERANCE);
    // 小さなずれ (フォントの読み込み・端数・ホバーで浮くタイル) は、足元を新しい上辺に合わせ直す。
    if (this.segment && this.segment.top !== this.top) {
      this.top = this.segment.top;
      if (this.placed) this.place();
    }
    return this.segment;
  }

  /** 画面の入場アニメーション (有限のもの) が動いているか。動いている間の計測は位置がずれる。 */
  private animating(): boolean {
    const getAnimations = (this.root as Element & { getAnimations?: (o?: { subtree: boolean }) => Animation[] }).getAnimations;
    if (typeof getAnimations !== 'function') return false;
    return getAnimations.call(this.root, { subtree: true }).some((animation) => {
      const iterations = animation.effect?.getTiming().iterations;
      return animation.playState === 'running' && iterations !== Infinity;
    });
  }

  // ------------------------------------------------------------------ 登場・退場

  private scheduleEnter(delay: number): void {
    if (this.destroyed || this.placed) return;
    this.clearActionTimers();
    this.after(delay, () => this.tryEnter());
  }

  private tryEnter(): void {
    if (this.destroyed || this.placed || this.blocked()) return;
    if (this.modalOpen()) {
      this.pause('modal');
      return;
    }
    if (this.animating() && this.animationWaits < MAX_ANIMATION_WAITS) {
      this.animationWaits += 1;
      this.after(300, () => this.tryEnter());
      return;
    }
    this.animationWaits = 0;
    const terrain = this.measureFn(this.root, this.selector, this.win);
    const candidates = visibleSegments(computeSegments(terrain), terrain.view);
    // 安全な足場がない: 表示しない (DOM の変化・リサイズ・スクロールで、もう一度探す)。
    if (candidates.length === 0) return;
    // 広い足場ほど選ばれやすい。
    const total = candidates.reduce((sum, s) => sum + (s.maxX - s.minX + 1), 0);
    let roll = this.rng() * total;
    let chosen = candidates[candidates.length - 1];
    for (const candidate of candidates) {
      roll -= candidate.maxX - candidate.minX + 1;
      if (roll < 0) {
        chosen = candidate;
        break;
      }
    }
    this.pauses.delete('offscreen');
    this.placed = true;
    this.top = chosen.top;
    this.segment = chosen;
    this.x = chosen.minX + (chosen.maxX - chosen.minX) * this.rng();
    this.dir = this.rng() < 0.5 ? -1 : 1;
    this.history = [];
    this.run({ action: 'idle', durationMs: between(this.rng, this.behavior.idleMs) });
    this.setVisible(true);
  }

  /** 姿を消して (フェード)、delay 後に安全な場所から出直す。 */
  private vanish(delay: number): void {
    this.interrupt();
    this.setVisible(false);
    this.placed = false;
    this.segment = null;
    this.after(this.animation.fadeMs + delay, () => this.tryEnter());
  }

  // ------------------------------------------------------------------ 行動

  private nextAction(): void {
    if (this.destroyed || this.pauses.size > 0 || !this.placed) return;
    // 画面のアニメーション中は位置がずれて見えるので、最後に確かめた足場を使う。
    const segment = this.animating() ? this.segment : this.currentSegment();
    if (!segment) {
      this.vanish(between(this.rng, this.timing.enterDelayMs));
      return;
    }
    // ピンチズーム中は、横方向に見えている範囲の中だけを歩く。見えない位置にいれば休む (スクロールで再開)。
    const viewLeft = this.view?.left ?? -Infinity;
    const viewRight = this.view?.right ?? Infinity;
    const minX = Math.max(segment.minX, viewLeft - SPRITE.sideInset);
    const maxX = Math.min(segment.maxX, viewRight - SPRITE.width + SPRITE.sideInset);
    if (maxX < minX || this.x < minX - 1 || this.x > maxX + 1) {
      this.pause('offscreen');
      return;
    }
    const decision = decideNext(
      { now: this.now(), lastActivityAt: this.lastActivityAt, history: this.history, x: this.x, minX, maxX },
      this.rng,
      this.behavior,
    );
    this.run(decision);
  }

  private run(decision: Decision): void {
    this.interrupt();
    this.action = decision.action;
    this.history = [...this.history, decision.action].slice(-HISTORY_LENGTH);
    if (decision.action === 'walk' && decision.targetX !== undefined) this.walk(decision.targetX);
    else if (decision.action === 'sleep') this.sleep(decision.durationMs);
    else this.idle(decision.durationMs);
  }

  private idle(durationMs: number): void {
    this.render(ROW.idle, IDLE_OPEN);
    const blink = (): void => {
      this.after(between(this.rng, this.animation.blinkEveryMs), () => {
        this.render(ROW.idle, IDLE_BLINK);
        this.after(this.animation.blinkMs, () => {
          this.render(ROW.idle, IDLE_OPEN);
          blink();
        });
      });
    };
    blink();
    this.after(durationMs, () => this.nextAction());
  }

  private walk(targetX: number): void {
    const startX = this.x;
    const distance = targetX - startX;
    if (Math.abs(distance) < 0.5) {
      this.idle(between(this.rng, this.behavior.idleMs));
      return;
    }
    this.dir = distance > 0 ? 1 : -1;
    const durationMs = (Math.abs(distance) / this.behavior.walkSpeed) * 1000;
    let column = 0;
    this.render(ROW.walk, column);
    const step = (): void => {
      this.after(this.animation.walkFrameMs, () => {
        column = (column + 1) % WALK_FRAMES;
        this.render(ROW.walk, column);
        step();
      });
    };
    step();
    const startedAt = this.now();
    const tick = (): void => {
      const progress = Math.min(1, (this.now() - startedAt) / durationMs);
      const bounds = this.segment;
      this.x = startX + distance * progress;
      if (bounds) this.x = clamp(this.x, bounds.minX, bounds.maxX);
      this.place();
      if (progress >= 1) {
        this.frame = null;
        this.clearActionTimers();
        this.idle(between(this.rng, this.behavior.idleMs));
        return;
      }
      this.frame = this.requestFrame(tick);
    };
    this.frame = this.requestFrame(tick);
  }

  private sleep(durationMs: number): void {
    this.wakeRolled = false;
    let column = 0;
    this.render(ROW.sleep, column);
    const curl = (): void => {
      if (column >= SLEEP_FRAMES - 1) return;
      this.after(this.animation.sleepFrameMs, () => {
        column += 1;
        this.render(ROW.sleep, column);
        curl();
      });
    };
    curl();
    this.after(durationMs, () => this.wake());
  }

  private wake(): void {
    if (this.destroyed || this.pauses.size > 0) return;
    this.clearActionTimers();
    this.action = 'sleep';
    let column = SLEEP_FRAMES - 1;
    this.render(ROW.sleep, column);
    const uncurl = (): void => {
      this.after(this.animation.wakeFrameMs, () => {
        column -= 1;
        if (column < 0) {
          // 目覚めた直後は様子を見る (history の末尾が sleep なので、すぐには眠り直さない)。
          this.nextAction();
          return;
        }
        this.render(ROW.sleep, column);
        uncurl();
      });
    };
    uncurl();
  }

  // ------------------------------------------------------------------ 描画

  private render(row: SpriteRow, column: number): void {
    this.sprite.style.backgroundPosition = framePosition(row, column);
    this.sprite.dataset.action = this.action ?? 'idle';
    this.place();
  }

  private place(): void {
    const dpr = this.win.devicePixelRatio || 1;
    const x = Math.round(this.x * dpr) / dpr;
    // 足元が足場に食い込まないよう、上側の画素へ切り捨てる。
    const y = Math.floor((this.top - SPRITE.height) * dpr + 1e-6) / dpr;
    // 元の絵は左向き。右へ向くときだけ左右反転する。
    this.sprite.style.transform = `translate3d(${x}px, ${y}px, 0) scaleX(${this.dir > 0 ? -1 : 1})`;
  }

  private setVisible(visible: boolean): void {
    this.sprite.dataset.visible = visible ? 'true' : 'false';
  }

  // ------------------------------------------------------------------ タイマー

  private after(ms: number, fn: () => void): void {
    const id = this.win.setTimeout(() => {
      this.actionTimers.delete(id);
      if (!this.destroyed) fn();
    }, Math.max(0, ms));
    this.actionTimers.add(id);
  }

  private requestFrame(fn: () => void): number {
    return typeof this.win.requestAnimationFrame === 'function'
      ? this.win.requestAnimationFrame(() => fn())
      : this.win.setTimeout(fn, 16);
  }

  private cancelFrame(): void {
    if (this.frame === null) return;
    if (typeof this.win.cancelAnimationFrame === 'function') this.win.cancelAnimationFrame(this.frame);
    else this.win.clearTimeout(this.frame);
    this.frame = null;
  }

  private clearActionTimers(): void {
    for (const id of this.actionTimers) this.win.clearTimeout(id);
    this.actionTimers.clear();
  }

  /** いまの行動を止める (タイマー・フレームを残さない)。 */
  private interrupt(): void {
    this.clearActionTimers();
    this.cancelFrame();
  }

  private clearTimer(kind: 'remeasure' | 'scroll' | 'shift'): void {
    const id = kind === 'remeasure' ? this.remeasureTimer : kind === 'scroll' ? this.scrollTimer : this.shiftTimer;
    if (id !== null) this.win.clearTimeout(id);
    if (kind === 'remeasure') this.remeasureTimer = null;
    else if (kind === 'scroll') this.scrollTimer = null;
    else this.shiftTimer = null;
  }

  private clearAuxTimers(): void {
    this.clearTimer('remeasure');
    this.clearTimer('scroll');
    this.clearTimer('shift');
  }
}
