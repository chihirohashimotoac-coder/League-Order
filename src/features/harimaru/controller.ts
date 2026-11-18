/**
 * ハリマルの動作エンジン (命令的な小さなクラス)。React の外で 1 つの要素の transform・clip-path・
 * background-position だけを書き換え、アプリ全体を再描画しない。
 *
 * - 行動: 待機・休む・周囲を見る・歩く・駆け足・跳ねる・ジャンプ (カード間)・カード裏に隠れて別の場所から
 *   顔を出す・眠る/目覚める。触れ合い: 喜ぶ・振り向く・逃げる・近づく。素材のない動作は選ばない (clips.ts)。
 * - 休止の条件: 画面が非表示、モーダル・シート表示中、入力中、キャラクターが画面外 (スクロール)。
 *   休止中はタイマー・requestAnimationFrame を残さない。
 * - 足場は実 DOM を計測して決める (terrainDom)。DOM の変化・リサイズ・スクロール停止で計測し直し、
 *   いまの足場が消えた・動いたら、その場で姿を消して安全な場所から出直す。
 * - ユーザーの操作は「最後に操作した時刻」を記録するだけ (受動的なリスナー)。既定の動作は止めない。
 */
import { actionWeights, decideNext, between, clamp, type Decision, type HarimaruAction, type Rng } from './behavior';
import { isAvailable, type MotionId } from './clips';
import { classifyGesture, cursorReaction, reactionFor, recentTimes, touchZone, type Reaction } from './interaction';
import {
  DEFAULT_ANIMATION,
  DEFAULT_BEHAVIOR,
  DEFAULT_INTERACTION,
  DEFAULT_TERRAIN,
  DEFAULT_TIMING,
  SPRITE,
  type AnimationParams,
  type BehaviorParams,
  type InteractionParams,
  type TimingParams,
} from './params';
import { framePosition, IDLE_BLINK, IDLE_LOOK, IDLE_OPEN, REST_BLINK, REST_OPEN, ROW, SLEEP_FRAMES, WALK_AIR, WALK_FRAMES, type SpriteRow } from './sprite';
import {
  arcAt,
  arcBounds,
  arcIsClear,
  boxIsClear,
  computeSegments,
  findSegment,
  jumpCandidates,
  spriteBox,
  visibleSegments,
  type JumpPlan,
  type Rect,
  type Segment,
} from './terrain';
import { collectObstacles, measureTerrain, type MeasuredTerrain } from './terrainDom';

/**
 * 休止の理由。hidden = タブ非表示、modal = モーダル・シート表示中、offscreen = キャラクターが画面外、
 * shift = 足場の近くで位置・大きさの変わるアニメーション中 (ホバーで浮くタイルなど。終わるまで隠す)。
 */
export type PauseReason = 'hidden' | 'modal' | 'offscreen' | 'shift' | 'input';

/** 行動中の状態 (自分から選ぶ行動と、触れ合いの反応)。 */
export type ActionState = HarimaruAction | 'happy' | 'turn' | 'flee' | 'approach' | 'peek' | 'enter';

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
  interaction?: InteractionParams;
  /** テスト用: 素材のある動作か (既定: clips.ts の表)。 */
  available?: (id: MotionId) => boolean;
  /** テスト用: マウスでホバーできる画面か (既定: matchMedia で判定)。 */
  finePointer?: boolean;
  /** テスト用: 経路の障害物の集め方の差し替え。 */
  obstaclesIn?: (root: Element, regions: readonly Rect[], win: Window) => Rect[];
}

const MODAL_SELECTOR = '[aria-modal="true"], .sheet-backdrop';
/** 押しても反応しない (既存の操作に任せる) 要素。 */
const CONTROL_SELECTOR =
  'a[href], button, input, select, textarea, label, summary, [role="button"], [role="link"], [role="tab"], [role="checkbox"], [role="radio"], [role="switch"], [role="slider"], [contenteditable=""], [contenteditable="true"], [tabindex]:not([tabindex="-1"])';
/** 入力中は休む (文字入力・選択の邪魔をしない)。 */
const INPUT_SELECTOR = 'input:not([type="button"]):not([type="submit"]):not([type="reset"]):not([type="checkbox"]):not([type="radio"]), textarea, select, [contenteditable=""], [contenteditable="true"]';
/** 記録しておく出来事 (テスト・調整用) の数。 */
const EVENT_LOG = 20;
/** 着地の失敗・縁で足を滑らせる確率 (素材が届くまでは記録だけ)。 */
const MISHAP_CHANCE = 0.12;
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
  private readonly interaction: InteractionParams;
  private readonly available: (id: MotionId) => boolean;
  private readonly finePointer: boolean;
  private readonly obstaclesIn: (root: Element, regions: readonly Rect[], win: Window) => Rect[];

  /** 行動に属するタイマー (中断で消す)。 */
  private readonly actionTimers = new Set<number>();
  /** 計測・スクロール停止などの補助タイマー。 */
  private remeasureTimer: number | null = null;
  private scrollTimer: number | null = null;
  private shiftTimer: number | null = null;
  private frame: number | null = null;
  /** 足場の近くで動いているトランジション・アニメーションの対象。 */
  private readonly shifting = new Map<EventTarget, Set<string>>();
  /** 動いている足場 (乗ったまま上辺に合わせる) と、その追従のフレーム・保険のタイマー。 */
  private readonly riding = new Map<EventTarget, Set<string>>();
  private rideFrame: number | null = null;
  /** DOM の変化・リサイズの確認 (1 フレームに 1 回にまとめる)。 */
  private checkFrame: number | null = null;
  private rideTimer: number | null = null;
  /** 最後の計測での足場の要素。 */
  private platformEls: readonly Element[] = [];
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
  /** 跳ねる・ジャンプで足元から浮いている高さ、カード裏へ沈んでいる深さ (CSS px)。 */
  private lift = 0;
  private sink = 0;
  /** ジャンプの途中 (足場の外を飛んでいる)。 */
  private airborne = false;
  /** いまの足場の一覧 (最後の計測)。 */
  private segments: readonly Segment[] = [];
  private action: ActionState | null = null;
  private history: HarimaruAction[] = [];
  private lastActivityAt: number;
  private wakeRolled = false;
  /** 触れ合い: 押している指、体に触れた時刻、最後の反応の時刻、カーソル、スクロールの速さ。 */
  private gesture: {
    id: number;
    x: number;
    y: number;
    t: number;
    maxMove: number;
    pointers: number;
    cancelled: boolean;
    secondary: boolean;
    onControl: boolean;
  } | null = null;
  private readonly activePointers = new Set<number>();
  private touches: number[] = [];
  private lastReactionAt = -Infinity;
  private cursor: { x: number; y: number; t: number; stillSince: number; speed: number } | null = null;
  private cursorTimer: number | null = null;
  private lastScroll: { y: number; t: number } | null = null;
  private scrollPeak = 0;
  /** 最近の出来事 (行動・反応・素材待ちで見送った反応)。テストと調整に使う。 */
  private readonly events: string[] = [];

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
    this.interaction = options.interaction ?? DEFAULT_INTERACTION;
    this.available = options.available ?? ((id) => isAvailable(id));
    this.finePointer =
      options.finePointer ??
      (typeof this.win.matchMedia === 'function' && this.win.matchMedia('(hover: hover) and (pointer: fine)').matches);
    this.obstaclesIn = options.obstaclesIn ?? collectObstacles;
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
    if (this.typing()) this.pauses.add('input');
    // 休止中は登場を予約しない (休止が解けたときに予約する)。
    if (!this.blocked()) this.scheduleEnter(between(this.rng, this.timing.enterDelayMs));
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.interrupt();
    this.clearAuxTimers();
    this.cancelCheck();
    this.stopCursorWatch();
    this.stopRide();
    for (const cleanup of this.cleanups.splice(0)) cleanup();
    this.setVisible(false);
  }

  /** テスト・デバッグ用の現在の状態。 */
  snapshot(): {
    placed: boolean;
    action: ActionState | null;
    x: number;
    top: number;
    dir: -1 | 1;
    lift: number;
    sink: number;
    airborne: boolean;
    paused: PauseReason[];
    timers: number;
    auxTimers: number;
    frame: boolean;
    events: string[];
  } {
    return {
      placed: this.placed,
      action: this.action,
      x: this.x,
      top: this.top,
      dir: this.dir,
      lift: this.lift,
      sink: this.sink,
      airborne: this.airborne,
      paused: [...this.pauses],
      timers: this.actionTimers.size,
      auxTimers: [this.remeasureTimer, this.scrollTimer, this.shiftTimer, this.rideTimer, this.cursorTimer, this.checkFrame].filter((id) => id !== null).length,
      frame: this.frame !== null,
      events: [...this.events],
    };
  }

  private log(event: string): void {
    this.events.push(event);
    if (this.events.length > EVENT_LOG) this.events.shift();
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
    // 触れ合い: すべて受動的なリスナーで位置と時刻を読むだけ (既定の動作・伝播は止めない)。
    add(win, 'pointerdown', (event) => this.onPointerDown(event), { passive: true, capture: true });
    add(win, 'pointermove', (event) => this.onPointerMove(event), { passive: true, capture: true });
    add(win, 'pointerup', (event) => this.onPointerUp(event), { passive: true, capture: true });
    add(win, 'pointercancel', (event) => this.onPointerCancel(event), { passive: true, capture: true });
    // 入力欄にフォーカスがある間は休む。
    const onFocus = (): void => (this.typing() ? this.pause('input') : this.resume('input'));
    doc.addEventListener('focusin', onFocus, { passive: true });
    doc.addEventListener('focusout', onFocus, { passive: true });
    this.cleanups.push(() => {
      doc.removeEventListener('focusin', onFocus);
      doc.removeEventListener('focusout', onFocus);
    });
    add(win, 'scroll', () => this.onScroll(), { passive: true });
    add(win, 'resize', () => {
      this.abortAirborne();
      this.scheduleRemeasure();
    });

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

    // 位置の変わるトランジション・アニメーションが始まったとき:
    // - 足場そのもの (ホバーで浮くタイルなど) なら、消さずに上辺に合わせて一緒に動く。
    // - 足場以外の要素がキャラクターの周りで動くなら、重ならないよう終わるまで隠す。
    // 同じ要素でも、位置のトランジション (プロパティごと) とアニメーション (名前ごと) を別々に数える。
    const shiftKey = (event: Event): string =>
      event.type.startsWith('transition')
        ? `transition:${(event as TransitionEvent).propertyName ?? ''}`
        : `animation:${(event as AnimationEvent).animationName ?? ''}`;
    const onShiftStart = (event: Event): void => {
      if (event.type === 'transitionrun' && !GEOMETRY_PROPERTY.test((event as TransitionEvent).propertyName ?? '')) return;
      // タブ非表示・モーダルの休止中は計測しない (休止が解けたときに計測し直す)。
      if (this.destroyed || this.pauses.has('hidden') || this.pauses.has('modal')) return;
      if (!event.target || !this.placed) return;
      // 空中では、着地先の足場が浮く・沈むと着地の高さが合わなくなる: 位置の変わる動きがあれば中断して出直す。
      if (this.abortAirborne()) return;
      if (this.isPlatform(event.target)) {
        const keys = this.riding.get(event.target) ?? new Set<string>();
        keys.add(shiftKey(event));
        this.riding.set(event.target, keys);
        this.ride();
        return;
      }
      if (!this.nearSprite(event.target)) return;
      const keys = this.shifting.get(event.target) ?? new Set<string>();
      keys.add(shiftKey(event));
      this.shifting.set(event.target, keys);
      this.pause('shift');
      this.shiftChecks = 0;
      this.armShiftFallback();
    };
    const onShiftEnd = (event: Event): void => {
      const rideKeys = event.target ? this.riding.get(event.target) : undefined;
      if (rideKeys?.delete(shiftKey(event))) {
        if (rideKeys.size === 0) this.riding.delete(event.target!);
        if (this.riding.size === 0) this.stopRide();
      }
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
        this.checkSoon();
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
        this.checkSoon();
        this.scheduleRemeasure();
      });
      observer.observe(this.watch, { childList: true, subtree: true });
      this.cleanups.push(() => observer.disconnect());
    }
    const fonts = (doc as Document & { fonts?: FontFaceSet }).fonts;
    fonts?.ready.then(() => this.scheduleRemeasure()).catch(() => undefined);
  }

  /** 要素が足場 (またはその中身) か。 */
  private isPlatform(target: EventTarget): boolean {
    if (!(target instanceof Node)) return false;
    return this.platformEls.some((platform) => platform === target || platform.contains(target));
  }

  /**
   * いま立っている足場の上辺 (ページ座標)。表示枠の見える部分の真下にある足場の要素のうち、最も高いもの。
   * 足場の要素が分からない (計測の差し替えなど) ときは null。
   */
  private footTop(): number | null {
    if (this.platformEls.length === 0) return null;
    const sx = this.win.scrollX;
    const sy = this.win.scrollY;
    const left = this.x + SPRITE.sideInset;
    const right = this.x + SPRITE.width - SPRITE.sideInset;
    let top: number | null = null;
    for (const platform of this.platformEls) {
      const rect = platform.getBoundingClientRect();
      if (rect.width <= 0 || rect.right + sx <= left || rect.left + sx >= right) continue;
      const edge = rect.top + sy;
      // 足元から離れた段 (別のカード) は数えない。
      if (Math.abs(edge - this.top) > SNAP_TOLERANCE + 1) continue;
      top = top === null ? edge : Math.min(top, edge);
    }
    return top;
  }

  /** 足元を、真下の足場の上辺に合わせる (足場が浮いても食い込まない)。 */
  private followFeet(): void {
    const top = this.footTop();
    if (top === null || top === this.top) return;
    this.top = top;
    this.place();
  }

  /** 動いている足場に乗ったまま、毎フレーム足元を合わせる。 */
  private ride(): void {
    if (this.rideTimer !== null) this.win.clearTimeout(this.rideTimer);
    // 終了イベントが届かなくても、追従を続けたままにしない。
    this.rideTimer = this.win.setTimeout(() => {
      this.rideTimer = null;
      this.riding.clear();
      this.stopRide();
    }, SHIFT_FALLBACK_MS);
    if (this.rideFrame !== null) return;
    const step = (): void => {
      this.rideFrame = null;
      if (this.destroyed || !this.placed || this.blocked()) return;
      this.followFeet();
      if (this.riding.size > 0) this.rideFrame = this.requestFrame(step);
    };
    this.rideFrame = this.requestFrame(step);
  }

  private stopRide(): void {
    if (this.rideFrame !== null) {
      if (typeof this.win.cancelAnimationFrame === 'function') this.win.cancelAnimationFrame(this.rideFrame);
      else this.win.clearTimeout(this.rideFrame);
      this.rideFrame = null;
    }
    if (this.rideTimer !== null) {
      this.win.clearTimeout(this.rideTimer);
      this.rideTimer = null;
    }
    this.riding.clear();
    if (this.placed && !this.destroyed && !this.blocked()) {
      this.followFeet();
      this.scheduleRemeasure();
    }
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
    return this.pauses.has('hidden') || this.pauses.has('modal') || this.pauses.has('shift') || this.pauses.has('input');
  }

  /** 入力欄にフォーカスがあるか (focusout の直後は、まだ次の要素に移っていないことがあるので activeElement で見る)。 */
  private typing(): boolean {
    const active = this.win.document.activeElement;
    return active instanceof Element && active.matches(INPUT_SELECTOR);
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

  /** ジャンプの途中で画面が動いた・変わった: 経路の安全を保てないので、即座に隠れて安全な足場から出直す。 */
  private abortAirborne(): boolean {
    if (!this.airborne) return false;
    this.log('jump:aborted');
    this.vanish(between(this.rng, this.timing.enterDelayMs));
    return true;
  }

  private onScroll(): void {
    this.abortAirborne();
    this.noteActivity();
    // スクロールの速さ (CSS px / 秒) の最大を、止まるまで覚えておく。
    const t = this.now();
    const y = this.win.scrollY;
    if (this.lastScroll && t > this.lastScroll.t) {
      const speed = (Math.abs(y - this.lastScroll.y) / (t - this.lastScroll.t)) * 1000;
      this.scrollPeak = Math.max(this.scrollPeak, speed);
    }
    this.lastScroll = { y, t };
    this.clearTimer('scroll');
    if (this.destroyed || this.blocked()) return;
    this.scrollTimer = this.win.setTimeout(() => {
      this.scrollTimer = null;
      this.onScrollEnd();
    }, this.timing.scrollIdleMs);
  }

  private onScrollEnd(): void {
    const fast = this.scrollPeak >= this.interaction.fastScroll;
    this.scrollPeak = 0;
    this.lastScroll = null;
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
      // 速いスクロールのあとは転ぶ (素材待ち。素材がなければ見送る)。
      if (fast && this.placed && this.pauses.size === 0) this.react('tumble');
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
    this.cancelCheck();
    this.stopCursorWatch();
    // 足場への追従もやめる (休止が解けたときに計測し直す)。
    this.stopRide();
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

  /**
   * DOM の変化の確認を、次の描画の直前 (requestAnimationFrame) に 1 回だけ行う。
   * 変化が描画されるより前に確かめられ、ライブの更新のように変化が続いても計測は 1 フレーム 1 回で済む。
   */
  private checkSoon(): void {
    // 空中にいるときは、変化が描画される前 (いま) に中断して隠れる。
    if (this.abortAirborne()) return;
    if (this.checkFrame !== null || this.destroyed || !this.placed || this.pauses.size > 0) return;
    const run = (): void => {
      this.checkFrame = null;
      this.checkNow();
    };
    this.checkFrame = typeof this.win.requestAnimationFrame === 'function' ? this.win.requestAnimationFrame(run) : this.win.setTimeout(run, 0);
  }

  private cancelCheck(): void {
    if (this.checkFrame === null) return;
    if (typeof this.win.cancelAnimationFrame === 'function') this.win.cancelAnimationFrame(this.checkFrame);
    else this.win.clearTimeout(this.checkFrame);
    this.checkFrame = null;
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
    this.platformEls = terrain.elements ?? [];
    this.segments = computeSegments(terrain);
    this.segment = findSegment(this.segments, this.top, this.x, SNAP_TOLERANCE);
    // 小さなずれ (フォントの読み込み・端数・ホバーで浮くタイル) は、足元を新しい上辺に合わせ直す。
    if (this.segment) {
      // 段の高さ (最も高い上辺) ではなく、真下の足場の上辺に立つ。
      const top = this.footTop() ?? this.segment.top;
      if (top !== this.top) {
        this.top = top;
        if (this.placed) this.place();
      }
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
    this.view = terrain.view;
    this.platformEls = terrain.elements ?? [];
    this.segments = computeSegments(terrain);
    const candidates = visibleSegments(this.segments, terrain.view);
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
    // 段の高さではなく、真下の足場の上辺に立つ。
    this.top = this.footTop() ?? chosen.top;
    this.dir = this.rng() < 0.5 ? -1 : 1;
    this.history = [];
    this.lift = 0;
    this.airborne = false;
    // 画面に着いたとき: ふわっと現れるか、カード裏からひょっこり顔を出す (気まぐれ)。
    if (this.available('peek') && this.rng() < 0.5) {
      this.sink = SPRITE.height + 2;
      this.setVisible(true);
      this.action = 'enter';
      this.log('enter:peek');
      this.place();
      this.emerge();
      return;
    }
    this.sink = 0;
    this.log('enter:fade');
    this.run({ action: 'idle', durationMs: between(this.rng, this.behavior.idleMs) });
    this.setVisible(true);
  }

  /** 姿を消して (フェード)、delay 後に安全な場所から出直す。 */
  private vanish(delay: number): void {
    this.interrupt();
    this.setVisible(false);
    this.placed = false;
    this.airborne = false;
    this.lift = 0;
    this.sink = 0;
    this.segment = null;
    this.after(this.animation.fadeMs + delay, () => this.tryEnter());
  }

  // ------------------------------------------------------------------ 行動

  /** いまの足場で、横方向に見えている範囲 (ピンチズーム) に収めた左端 x の範囲。見えなければ null。 */
  private walkBounds(segment: Segment): { minX: number; maxX: number } | null {
    const viewLeft = this.view?.left ?? -Infinity;
    const viewRight = this.view?.right ?? Infinity;
    const minX = Math.max(segment.minX, viewLeft - SPRITE.sideInset);
    const maxX = Math.min(segment.maxX, viewRight - SPRITE.width + SPRITE.sideInset);
    if (maxX < minX || this.x < minX - 1 || this.x > maxX + 1) return null;
    return { minX, maxX };
  }

  /** その場で跳ねる空き (頭の上 hopHeight + 2px に障害物がなく、見える範囲) があるか。 */
  private hopRoom(height = this.animation.hopHeight): boolean {
    const region: Rect = {
      left: this.x + SPRITE.sideInset,
      right: this.x + SPRITE.width - SPRITE.sideInset,
      top: this.top - SPRITE.height - height - 2,
      bottom: this.top - SPRITE.height,
    };
    if (!this.view) return false;
    return boxIsClear(region, this.obstaclesIn(this.root, [region], this.win), this.view);
  }

  /** 安全なジャンプの候補 (経路の全体で障害物に重ならず、見える範囲に収まるもの)。 */
  private safeJumps(segment: Segment): JumpPlan[] {
    if (!this.view) return [];
    const view = this.view;
    const targets = visibleSegments(this.segments, view);
    const plans = jumpCandidates(segment, targets, this.animation.jumpApex, DEFAULT_TERRAIN);
    if (plans.length === 0) return [];
    const obstacles = this.obstaclesIn(this.root, plans.map(arcBounds), this.win);
    return plans.filter((plan) => arcIsClear(plan, obstacles, view));
  }

  /** 隠れて移れる場所 (見えている別の足場、または同じ足場の 40px 以上離れた位置)。 */
  private relocationTargets(segment: Segment): Segment[] {
    if (!this.view) return [];
    return visibleSegments(this.segments, this.view).filter(
      (s) => s.top !== segment.top || s.minX !== segment.minX || Math.abs(s.maxX - s.minX) >= 40,
    );
  }

  private nextAction(): void {
    if (this.destroyed || this.pauses.size > 0 || !this.placed) return;
    // 画面のアニメーション中は位置がずれて見えるので、最後に確かめた足場を使う。
    const segment = this.animating() ? this.segment : this.currentSegment();
    if (!segment) {
      this.vanish(between(this.rng, this.timing.enterDelayMs));
      return;
    }
    // ピンチズーム中は、横方向に見えている範囲の中だけを歩く。見えない位置にいれば休む (スクロールで再開)。
    const bounds = this.walkBounds(segment);
    if (!bounds) {
      this.pause('offscreen');
      return;
    }
    const input = {
      now: this.now(),
      lastActivityAt: this.lastActivityAt,
      history: this.history,
      x: this.x,
      minX: bounds.minX,
      maxX: bounds.maxX,
      canHop: this.available('hop') && this.hopRoom(),
      canRelocate: this.available('hide') && this.relocationTargets(segment).length > 0,
      available: this.available,
    };
    // ジャンプの経路の計測 (障害物の収集) は重いので、ジャンプが選ばれうるときだけ行う。
    const jumpPossible = actionWeights({ ...input, canJump: true }, this.behavior).jump > 0;
    const jumps = jumpPossible ? this.safeJumps(segment) : [];
    const decision = decideNext({ ...input, canJump: jumps.length > 0 }, this.rng, this.behavior);
    if (decision.action === 'jump') {
      const plan = jumps[Math.floor(this.rng() * jumps.length)];
      this.recordAction('jump');
      this.jump(plan);
      return;
    }
    this.run(decision);
  }

  private recordAction(action: HarimaruAction): void {
    this.interrupt();
    this.action = action;
    this.history = [...this.history, action].slice(-HISTORY_LENGTH);
    this.log(`action:${action}`);
  }

  private run(decision: Decision): void {
    this.recordAction(decision.action);
    switch (decision.action) {
      case 'walk':
      case 'run':
        this.walk(decision.targetX ?? this.x, decision.action === 'run', () => this.idle(between(this.rng, this.behavior.idleMs)));
        return;
      case 'sleep':
        this.sleep(decision.durationMs);
        return;
      case 'rest':
        this.rest(decision.durationMs);
        return;
      case 'look':
        this.look(decision.durationMs);
        return;
      case 'hop':
        this.hop(1, () => this.idle(between(this.rng, this.behavior.idleMs)));
        return;
      case 'hide':
        this.hideAndMove(decision.durationMs, decision.walkToEdge === true);
        return;
      default:
        this.idle(decision.durationMs);
    }
  }

  /** 立ち止まる (ときどき瞬き)。 */
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

  /** 何もせず伏せて休む (目を開けたまま、ときどき瞬き)。 */
  private rest(durationMs: number): void {
    this.render(ROW.sleep, REST_OPEN);
    const blink = (): void => {
      this.after(between(this.rng, this.animation.blinkEveryMs), () => {
        this.render(ROW.sleep, REST_BLINK);
        this.after(this.animation.blinkMs * 2, () => {
          this.render(ROW.sleep, REST_OPEN);
          blink();
        });
      });
    };
    blink();
    this.after(durationMs, () => this.nextAction());
  }

  /** 周囲を見る (少し正面を向いたり、左右に向きを変えたり)。 */
  private look(durationMs: number): void {
    this.render(ROW.idle, IDLE_LOOK);
    const turn = (): void => {
      this.after(between(this.rng, this.animation.lookTurnMs), () => {
        if (this.rng() < 0.6) this.dir = this.dir > 0 ? -1 : 1;
        this.render(ROW.idle, this.rng() < 0.5 ? IDLE_LOOK : IDLE_OPEN);
        turn();
      });
    };
    turn();
    this.after(durationMs, () => this.nextAction());
  }

  /** 歩く・駆け足で targetX まで行き、done を呼ぶ。 */
  private walk(targetX: number, running: boolean, done: () => void): void {
    const startX = this.x;
    const distance = targetX - startX;
    if (Math.abs(distance) < 0.5) {
      done();
      return;
    }
    this.dir = distance > 0 ? 1 : -1;
    const speed = running ? this.behavior.runSpeed : this.behavior.walkSpeed;
    const frameMs = running ? this.animation.runFrameMs : this.animation.walkFrameMs;
    const durationMs = (Math.abs(distance) / speed) * 1000;
    let column = 0;
    this.render(ROW.walk, column);
    const step = (): void => {
      this.after(frameMs, () => {
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
      // 歩いて浮いたタイルに乗り移るときも、足元をそのタイルの上辺に合わせる。
      this.followFeet();
      this.place();
      if (progress >= 1) {
        this.frame = null;
        this.clearActionTimers();
        done();
        return;
      }
      this.frame = this.requestFrame(tick);
    };
    this.frame = this.requestFrame(tick);
  }

  /** その場で times 回跳ねて、done を呼ぶ (頭の上の空きは呼ぶ側で確かめる)。 */
  private hop(times: number, done: () => void): void {
    let count = 0;
    const once = (): void => {
      const startedAt = this.now();
      this.render(ROW.idle, IDLE_OPEN);
      const tick = (): void => {
        const t = Math.min(1, (this.now() - startedAt) / this.animation.hopMs);
        this.lift = 4 * this.animation.hopHeight * t * (1 - t);
        this.place();
        if (t >= 1) {
          this.lift = 0;
          this.place();
          this.frame = null;
          count += 1;
          if (count < times) once();
          else done();
          return;
        }
        this.frame = this.requestFrame(tick);
      };
      this.frame = this.requestFrame(tick);
    };
    once();
  }

  /** 踏切の位置まで歩いてから、放物線で別の足場へ跳ぶ (経路の安全は確かめ済み)。 */
  private jump(plan: JumpPlan): void {
    this.walk(plan.from.x, false, () => {
      // 歩いている間に画面が変わったかもしれない: 経路をもう一度確かめる。
      const current = this.currentSegment();
      const again = current ? this.safeJumps(current).find((p) => p.target.top === plan.target.top && p.target.minX === plan.target.minX) : undefined;
      if (!again) {
        this.idle(between(this.rng, this.behavior.idleMs));
        return;
      }
      this.dir = again.to.x > again.from.x ? 1 : -1;
      const durationMs = Math.max(this.animation.jumpMinMs, Math.abs(again.to.x - again.from.x) * this.animation.jumpMsPerPx);
      const startedAt = this.now();
      this.airborne = true;
      this.render(ROW.walk, WALK_AIR);
      const tick = (): void => {
        const t = Math.min(1, (this.now() - startedAt) / durationMs);
        const point = arcAt(again, t);
        this.x = point.x;
        this.top = again.to.top;
        this.lift = again.to.top - point.foot;
        this.place();
        if (t >= 1) {
          this.frame = null;
          this.airborne = false;
          this.lift = 0;
          this.top = again.to.top;
          this.segment = again.target;
          this.action = 'idle';
          this.render(ROW.idle, IDLE_OPEN);
          this.idle(between(this.rng, this.behavior.idleMs));
          // ときどき着地に失敗して転ぶ (素材待ち: 素材がなければ記録だけ)。
          if (this.rng() < MISHAP_CHANCE) this.react('tumble');
          return;
        }
        this.frame = this.requestFrame(tick);
      };
      this.frame = this.requestFrame(tick);
    });
  }

  /** カード上辺の線より下へ沈む (下の部分は切り取って見せない = カードの裏に隠れる)。 */
  private sinkTo(target: number, durationMs: number, done: () => void): void {
    const from = this.sink;
    const startedAt = this.now();
    const tick = (): void => {
      const t = durationMs > 0 ? Math.min(1, (this.now() - startedAt) / durationMs) : 1;
      // ゆっくり始まり、ゆっくり止まる。
      const eased = t < 0.5 ? 2 * t * t : 1 - 2 * (1 - t) * (1 - t);
      this.sink = from + (target - from) * eased;
      this.place();
      if (t >= 1) {
        this.frame = null;
        done();
        return;
      }
      this.frame = this.requestFrame(tick);
    };
    this.frame = this.requestFrame(tick);
  }

  /** カード裏に隠れて、別の安全な場所から顔を出す。端まで歩いてから隠れることもある (画面の外へ消えるように)。 */
  private hideAndMove(hiddenMs: number, walkToEdge: boolean): void {
    const segment = this.segment;
    const go = (): void => {
      this.render(ROW.idle, IDLE_OPEN);
      this.sinkTo(SPRITE.height + 2, this.animation.sinkMs, () => {
        this.after(hiddenMs, () => this.reappear());
      });
    };
    if (walkToEdge && segment) {
      const edge = this.x - segment.minX < segment.maxX - this.x ? segment.minX : segment.maxX;
      this.walk(edge, false, () => {
        // 端でときどき足を滑らせる (素材待ち: 素材がなければ記録だけして、そのまま隠れる)。
        if (this.rng() < MISHAP_CHANCE && !this.available('slip')) this.log('react:slip:pending-asset');
        go();
      });
      return;
    }
    go();
  }

  /** 隠れたまま、見えている安全な足場の別の位置へ移って顔を出す。移れる先がなければ同じ場所から出る。 */
  private reappear(near?: number): void {
    if (this.destroyed || this.pauses.size > 0) return;
    const current = this.currentSegment();
    const targets = current ? this.relocationTargets(current) : visibleSegments(this.segments, this.view ?? { top: -Infinity, bottom: Infinity });
    if (targets.length === 0 && !current) {
      this.vanish(between(this.rng, this.timing.enterDelayMs));
      return;
    }
    if (targets.length > 0) {
      let target: Segment;
      let x: number;
      if (near !== undefined && current) {
        target = current;
        x = clamp(near - SPRITE.width / 2, current.minX, current.maxX);
      } else {
        target = targets[Math.floor(this.rng() * targets.length)];
        // 同じ足場なら、いまの位置から離れたところへ。
        const far = target === current;
        x = target.minX + (target.maxX - target.minX) * this.rng();
        if (far && Math.abs(x - this.x) < 40) x = this.x - target.minX > target.maxX - this.x ? target.minX : target.maxX;
      }
      this.top = target.top;
      this.segment = target;
      this.x = x;
      this.top = this.footTop() ?? target.top;
      this.dir = this.rng() < 0.5 ? -1 : 1;
      this.place();
    }
    this.peekThenEmerge();
  }

  /** 耳と目だけを出してしばらく様子を見て、出てくる (たまにまた引っ込む)。 */
  private peekThenEmerge(): void {
    this.action = 'peek';
    this.log('action:peek');
    this.render(ROW.idle, IDLE_LOOK);
    this.sinkTo(SPRITE.height - this.animation.peekVisible, this.animation.sinkMs / 2, () => {
      this.after(between(this.rng, [800, 2_200]), () => {
        if (this.rng() < 0.6) this.dir = this.dir > 0 ? -1 : 1;
        this.render(ROW.idle, IDLE_OPEN);
        this.after(between(this.rng, [400, 1_200]), () => this.emerge());
      });
    });
  }

  /** カード裏から出てくる (沈んだ深さ → 0)。 */
  private emerge(): void {
    this.render(ROW.idle, IDLE_OPEN);
    this.sinkTo(0, this.animation.sinkMs, () => {
      this.sink = 0;
      this.action = 'idle';
      this.place();
      this.idle(between(this.rng, this.behavior.idleMs));
    });
  }

  private sleep(durationMs: number): void {
    this.wakeRolled = false;
    let column = 0;
    this.render(ROW.sleep, column);
    const curl = (): void => {
      if (column >= SLEEP_FRAMES - 1) {
        // 足場の端で眠ると、寝ぼけて落ちそうになることがある (素材待ち: 素材がなければ記録だけ)。
        const segment = this.segment;
        const nearEdge = segment ? Math.min(this.x - segment.minX, segment.maxX - this.x) < 8 : false;
        if (nearEdge && this.rng() < 0.3 && !this.available('sleepyFall')) this.log('react:sleepyFall:pending-asset');
        return;
      }
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
    this.log('wake');
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

  // ------------------------------------------------------------------ 触れ合い

  /** 押し始め: 指の数と、押した要素が操作部品かを覚える。 */
  private onPointerDown(event: PointerEvent): void {
    this.activePointers.add(event.pointerId);
    if (this.gesture) {
      this.gesture.pointers = Math.max(this.gesture.pointers, this.activePointers.size);
      return;
    }
    const target = event.target instanceof Element ? event.target : null;
    this.gesture = {
      id: event.pointerId,
      x: event.clientX,
      y: event.clientY,
      t: this.now(),
      maxMove: 0,
      pointers: this.activePointers.size,
      cancelled: false,
      secondary: event.pointerType === 'mouse' && event.button !== 0,
      onControl: !!target?.closest(CONTROL_SELECTOR),
    };
  }

  private onPointerMove(event: PointerEvent): void {
    if (this.gesture && event.pointerId === this.gesture.id) {
      this.gesture.maxMove = Math.max(this.gesture.maxMove, Math.hypot(event.clientX - this.gesture.x, event.clientY - this.gesture.y));
    }
    if (event.pointerType === 'mouse' && this.finePointer) this.trackCursor(event);
  }

  private onPointerCancel(event: PointerEvent): void {
    this.activePointers.delete(event.pointerId);
    if (this.gesture && event.pointerId === this.gesture.id) this.gesture.cancelled = true;
    if (this.activePointers.size === 0) this.gesture = null;
  }

  /** 離したとき: 短いタップ・クリックだけを採用して、触れた場所に応じて反応する。 */
  private onPointerUp(event: PointerEvent): void {
    this.activePointers.delete(event.pointerId);
    const gesture = this.gesture;
    if (!gesture || event.pointerId !== gesture.id) return;
    this.gesture = null;
    const rejected = classifyGesture(
      {
        durationMs: this.now() - gesture.t,
        maxMove: Math.max(gesture.maxMove, Math.hypot(event.clientX - gesture.x, event.clientY - gesture.y)),
        pointers: gesture.pointers,
        cancelled: gesture.cancelled,
        secondaryButton: gesture.secondary,
        onControl: gesture.onControl,
        selectedText: !!this.win.getSelection?.()?.toString().trim(),
      },
      this.interaction,
    );
    if (rejected) {
      this.log(`tap:ignored:${rejected}`);
      return;
    }
    this.onTap({ x: event.clientX + this.win.scrollX, y: event.clientY + this.win.scrollY });
  }

  /** 採用したタップ (ページ座標)。 */
  private onTap(point: { x: number; y: number }): void {
    if (!this.placed || this.pauses.size > 0 || this.airborne || this.sink > 0) return;
    const zone = touchZone(point, { x: this.x, top: this.top, dir: this.dir }, this.interaction);
    if (zone === null) return;
    // 見えている体の外 (近く・背後、体の周りの余裕の部分) へのタップは、文字・操作部品・色の付いた要素
    // (足元のカード面など) のない余白で成立したものだけ。
    const box = spriteBox(this.x, this.top);
    const onBody = point.x >= box.left && point.x <= box.right && point.y >= box.top && point.y <= box.bottom;
    if (!onBody && !this.emptySpace(point)) {
      this.log('tap:ignored:content');
      return;
    }
    const t = this.now();
    if (zone !== 'near') this.touches = [...recentTimes(this.touches, t, this.interaction.fleeWindowMs), t];
    if (t - this.lastReactionAt < this.interaction.reactionCooldownMs) return;
    // 眠っていたら、触れると目を覚ます (反応はそのあと)。
    if (this.action === 'sleep' && zone !== 'near') {
      this.log('tap:wake');
      this.lastReactionAt = t;
      this.interrupt();
      this.wake();
      return;
    }
    const reaction = reactionFor(zone, this.touches.length, this.rng, this.interaction);
    if (!reaction) return;
    this.lastReactionAt = t;
    this.react(reaction, point.x);
  }

  /** ページ座標の点の周り (指の幅 ±6px) が、文字・操作部品・色の付いた要素のない余白か。 */
  private emptySpace(point: { x: number; y: number }): boolean {
    const region: Rect = { left: point.x - 6, right: point.x + 6, top: point.y - 6, bottom: point.y + 6 };
    return this.obstaclesIn(this.root, [region], this.win).every(
      (o) => !(o.right > region.left && o.left < region.right && o.bottom > region.top && o.top < region.bottom),
    );
  }

  /** 反応を始める。素材のない反応は見送る (記録だけ残す)。 */
  private react(reaction: Exclude<Reaction, null> | 'tumble' | 'peekNear' | 'lookUp' | 'play' | 'cursorHang', pointX?: number): void {
    // 背後から触れたときの「驚く」は素材待ち: 素材が届くまでは、振り向く反応にする。
    let chosen: string = reaction;
    if (reaction === 'surprise' && !this.available('surprise')) {
      this.log('react:surprise:pending-asset');
      chosen = 'turn';
    }
    const motion: MotionId = chosen === 'peekNear' ? 'peek' : (chosen as MotionId);
    if (!this.available(motion)) {
      this.log(`react:${chosen}:pending-asset`);
      return;
    }
    this.log(`react:${chosen}`);
    this.interrupt();
    this.lift = 0;
    const settle = (): void => this.idle(between(this.rng, this.behavior.idleMs));
    switch (chosen) {
      case 'happy':
        this.action = 'happy';
        if (this.hopRoom()) this.hop(2, settle);
        else settle();
        return;
      case 'turn':
        this.action = 'turn';
        this.dir = this.dir > 0 ? -1 : 1;
        this.render(ROW.idle, IDLE_OPEN);
        this.after(500, settle);
        return;
      case 'flee': {
        this.action = 'flee';
        this.touches = [];
        const segment = this.segment;
        if (!segment) return settle();
        // 触れた側と反対の端へ駆けていき、カード裏に隠れて別の場所へ。
        const away = pointX !== undefined && pointX > this.x + SPRITE.width / 2 ? segment.minX : segment.maxX;
        this.walk(away, true, () => {
          this.render(ROW.idle, IDLE_OPEN);
          this.sinkTo(SPRITE.height + 2, this.animation.sinkMs / 2, () => this.after(between(this.rng, this.behavior.hiddenMs), () => this.reappear()));
        });
        return;
      }
      case 'approach': {
        this.action = 'approach';
        const segment = this.segment;
        if (!segment || pointX === undefined) return settle();
        // 少し手前で止まって、そちらを向く。
        const center = this.x + SPRITE.width / 2;
        const stop = pointX > center ? pointX - SPRITE.width - 6 : pointX + 6;
        const target = clamp(stop, segment.minX, segment.maxX);
        this.walk(target, false, () => {
          this.dir = pointX > this.x + SPRITE.width / 2 ? 1 : -1;
          this.render(ROW.idle, IDLE_LOOK);
          this.after(between(this.rng, this.behavior.idleMs), () => this.nextAction());
        });
        return;
      }
      case 'peekNear':
        this.action = 'peek';
        this.render(ROW.idle, IDLE_OPEN);
        this.sinkTo(SPRITE.height + 2, this.animation.sinkMs, () => this.after(600, () => this.reappear(pointX)));
        return;
      default:
        settle();
    }
  }

  /** PC のカーソル: 位置と速さを覚え、近くにいる間だけ低い頻度で反応を考える。 */
  private trackCursor(event: PointerEvent): void {
    const t = this.now();
    const x = event.clientX + this.win.scrollX;
    const y = event.clientY + this.win.scrollY;
    const previous = this.cursor;
    let speed = 0;
    if (previous && t > previous.t) speed = (Math.hypot(x - previous.x, y - previous.y) / (t - previous.t)) * 1000;
    const moved = !previous || Math.hypot(x - previous.x, y - previous.y) > 2;
    this.cursor = {
      x,
      y,
      t,
      stillSince: moved ? t : previous.stillSince,
      // なめらかにした速さ (ぶれを抑える)。
      speed: previous ? previous.speed * 0.6 + speed * 0.4 : speed,
    };
    if (this.cursorTimer === null && this.placed && this.pauses.size === 0) {
      this.cursorTimer = this.win.setTimeout(() => this.considerCursor(), this.interaction.cursorCheckMs);
    }
  }

  private considerCursor(): void {
    this.cursorTimer = null;
    const cursor = this.cursor;
    if (!cursor || this.destroyed || !this.placed || this.pauses.size > 0 || this.airborne || this.sink > 0) return;
    const t = this.now();
    // カーソルが 10 秒動かなければ見張りをやめる (次に動いたら再開)。
    const stillMs = t - cursor.stillSince;
    if (stillMs > 10_000) return;
    const centerX = this.x + SPRITE.width / 2;
    const centerY = this.top - SPRITE.height / 2;
    const distance = Math.hypot(cursor.x - centerX, cursor.y - centerY);
    // 静かな行動の間だけ、気まぐれに反応する (歩いている途中や反応の直後は見送る)。
    const calm = this.action === 'idle' || this.action === 'look' || this.action === 'rest';
    if (calm && t - this.lastReactionAt >= this.interaction.reactionCooldownMs * 3) {
      const reaction = cursorReaction(
        {
          distance,
          stillMs,
          speed: cursor.speed,
          available: (id) => (id === 'peekNear' ? this.available('peek') && this.available('hide') : this.available(id)),
        },
        this.rng,
        this.interaction,
      );
      if (reaction) {
        this.lastReactionAt = t;
        // 足場の段から縦に離れたカーソルには近づかない (横に寄るだけ)。
        this.react(reaction, cursor.x);
        return;
      }
      // 素材待ちの反応 (じゃれる・見上げる・ぶら下がる) が選ばれうる場面を記録する。
      if (distance <= this.interaction.cursorNear && (cursor.speed >= this.interaction.fastCursor || stillMs >= this.interaction.cursorStillMs)) {
        const pending = cursor.speed >= this.interaction.fastCursor ? 'play' : distance <= 48 ? 'lookUp' : null;
        if (pending && !this.available(pending)) this.log(`react:${pending}:pending-asset`);
      }
    }
    this.cursorTimer = this.win.setTimeout(() => this.considerCursor(), this.interaction.cursorCheckMs);
  }

  private stopCursorWatch(): void {
    if (this.cursorTimer !== null) this.win.clearTimeout(this.cursorTimer);
    this.cursorTimer = null;
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
    // 足元が足場に食い込まないよう、上側の画素へ切り捨てる。跳ねている間は lift だけ上、沈んでいる間は sink だけ下。
    const y = Math.floor((this.top - SPRITE.height - this.lift + this.sink) * dpr + 1e-6) / dpr;
    // 元の絵は左向き。右へ向くときだけ左右反転する。
    this.sprite.style.transform = `translate3d(${x}px, ${y}px, 0) scaleX(${this.dir > 0 ? -1 : 1})`;
    // カードの裏に沈んでいる部分 (足場の上辺より下) は描かない。
    const hidden = Math.min(SPRITE.height, Math.max(0, this.sink));
    this.sprite.style.clipPath = hidden > 0 ? `inset(0 0 ${hidden.toFixed(2)}px 0)` : '';
    this.sprite.dataset.sunk = hidden >= SPRITE.height ? 'true' : 'false';
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

  /** いまの行動を止める (タイマー・フレームを残さない)。跳ねた高さ・沈んだ深さ・空中の状態も戻す。 */
  private interrupt(): void {
    this.clearActionTimers();
    this.cancelFrame();
    if (this.lift !== 0 || this.sink !== 0 || this.airborne) {
      this.lift = 0;
      this.sink = 0;
      this.airborne = false;
      if (this.placed) this.place();
    }
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
