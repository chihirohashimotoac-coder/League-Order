import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { seededRng } from './behavior';
import { DEFAULT_LIVE, HarimaruController } from './controller';
import { DEFAULT_BEHAVIOR, DEFAULT_INTERACTION, DEFAULT_MOTION } from './params';
import { CLIP_IDS, REACTION_IDS, REACTIONS } from './sprite';
import type { Rect } from './terrain';
import type { MeasuredTerrain } from './terrainDom';

/**
 * 観戦リアクション (PR3) の演出: 本体とエフェクトの再生、エフェクトの位置と向き (180 の文字は反転しない)、
 * 優先順位・割り込み・得点のクールダウン、休止中の出来事を捨てる、足場の外では重要な出来事だけ待つ、
 * エフェクトの範囲の安全判定、素材の読み込み失敗、後片付け。
 */

const VIEW = { top: 0, bottom: 800, left: 0, right: 1_000 };
let now = 0;
let root: HTMLElement;
let app: HTMLElement;
let sprite: HTMLElement;
let effect: HTMLElement;
let card: HTMLElement;
let controller: HarimaruController;
let obstacles: Rect[];

const domRect = (r: Rect) => ({ ...r, width: r.right - r.left, height: r.bottom - r.top, x: r.left, y: r.top, toJSON: () => ({}) }) as DOMRect;
const CARD: Rect = { left: 100, right: 500, top: 300, bottom: 400 };

const terrain = (): MeasuredTerrain => ({
  platforms: [{ left: CARD.left, right: CARD.right, top: CARD.top }],
  elements: [card],
  obstacles: [],
  bounds: { left: 0, right: 1_000 },
  view: VIEW,
});

const quiet = {
  ...DEFAULT_BEHAVIOR,
  weights: { idle: 1, rest: 0, look: 0, walk: 0, run: 0, hop: 0, jump: 0, hide: 0, sleep: 0, groom: 0, stretch: 0 },
  sleepWhenInactive: 0,
  slipChance: 0,
  sleepyFallChance: 0,
};

function make(options: { seed?: number; reactions?: boolean } = {}): HarimaruController {
  controller = new HarimaruController({
    // 登場の端からカードまでの空白は 100px 前後 (この組のテストは登場の距離の上限を調べない)。
    motion: { ...DEFAULT_MOTION, entryMaxGap: 120 },
    sprite,
    effect,
    root,
    watch: app,
    platformSelector: '.x',
    rng: seededRng(options.seed ?? 1),
    now: () => now,
    measure: () => terrain(),
    obstaclesIn: () => obstacles,
    behavior: quiet,
    finePointer: false,
    interaction: DEFAULT_INTERACTION,
  });
  controller.setSheet('base', 'base.png');
  for (const id of CLIP_IDS) controller.setSheet(id, `${id}.png`);
  if (options.reactions !== false) for (const id of REACTION_IDS) controller.setReactionSheets(id, `${id}-body.png`, `${id}-effect.png`);
  return controller;
}

function advance(ms: number): void {
  for (let t = 0; t < ms; t += 16) {
    now += 16;
    vi.advanceTimersByTime(16);
  }
}

function standing(options: Parameters<typeof make>[0] = {}): HarimaruController {
  make(options).start();
  // 画面の端から入って (のぞいて引っ込む回もある)、足場の上で待機するまで。
  for (let i = 0; i < 2_000 && !(controller.snapshot().placed && controller.snapshot().action === 'idle'); i += 1) advance(16);
  expect(controller.snapshot().placed).toBe(true);
  return controller;
}

const translate = (el: HTMLElement) => {
  const m = /translate3d\(([-\d.]+)px, ([-\d.]+)px/.exec(el.style.transform)!;
  return { left: Number(m[1]), top: Number(m[2]), flipped: /scaleX\(-1\)/.test(el.style.transform) };
};

/** 1 フレームごとに、本体とエフェクトのコマ・位置を記録する。 */
function record(ms: number) {
  const out = [];
  for (let t = 0; t < ms; t += 16) {
    advance(16);
    out.push({
      ...controller.snapshot(),
      body: sprite.dataset.frame ?? '',
      effect: effect.dataset.active === 'true' ? effect.dataset.frame ?? '' : '',
      front: effect.dataset.front,
      bodyAt: translate(sprite),
      effectAt: effect.style.transform ? translate(effect) : null,
    });
  }
  return out;
}

const order = (list: readonly string[]) => list.filter((f, i, all) => f !== all[i - 1]);

beforeEach(() => {
  vi.useFakeTimers();
  now = 0;
  obstacles = [];
  app = document.createElement('div');
  root = document.createElement('main');
  card = document.createElement('div');
  card.getBoundingClientRect = () => domRect(CARD);
  root.append(card);
  app.append(root);
  document.body.append(app);
  sprite = document.createElement('div');
  effect = document.createElement('div');
  document.body.append(sprite, effect);
});

afterEach(() => {
  controller?.destroy();
  document.body.innerHTML = '';
  vi.useRealTimers();
});

describe('観戦リアクションの再生', () => {
  it('6 種それぞれ、本体とエフェクトのコマを manifest の順に 1 回再生し、エフェクトを消して待機に戻る', () => {
    standing();
    for (const id of REACTION_IDS) {
      for (let i = 0; i < 400 && controller.snapshot().action !== 'idle'; i += 1) advance(16);
      now += DEFAULT_LIVE.scoreCooldownMs;
      expect(controller.reactLive(id), id).toBe(true);
      const spec = REACTIONS[id];
      const frames = record(spec.durationsMs.reduce((a, b) => a + b, 0) + 200);
      const body = order(frames.map((f) => f.body));
      const fx = order(frames.map((f) => f.effect).filter(Boolean));
      const expected = Array.from({ length: spec.frameCount }, (_, k) => k);
      // 最初のコマ (k = 0) は reactLive の時点で描かれている。
      expect([`rx:${id}:0`, ...body].filter((f, i, all) => f !== all[i - 1]).slice(0, spec.frameCount + 1)).toEqual([...expected.map((k) => `rx:${id}:${k}`), 'base:0:0']);
      expect(fx).toEqual(expected.map((k) => `${id}:${k}`));
      // 重ね順: 180 のボードは本体の後ろ、ほかは前。
      expect(frames.find((f) => f.effect)?.front).toBe(spec.effectsInFront ? 'true' : 'false');
      const end = controller.snapshot();
      expect(end.effect).toBeNull();
      expect(effect.dataset.active).toBe('false');
      expect(end.live).toBeNull();
      expect(end.poseX).toBe(0);
      expect(end.poseY).toBe(0);
      expect(end.sheet).toBe('base');
    }
  });

  it('エフェクトは本体の動く前の左上から (-11, -18)。本体の移動 (勝利の跳躍) はエフェクトに加えない', () => {
    standing();
    const { x, top } = controller.snapshot();
    controller.reactLive('victory');
    const frames = record(1_300).filter((f) => f.effect);
    for (const f of frames) {
      expect(f.effectAt!.left).toBeCloseTo(Math.round(x) - 11, 6);
      expect(f.effectAt!.top).toBeCloseTo(top - 20 - 18, 6);
    }
    // 跳躍のコマ 3 は本体だけ 7px 上。
    const jump = frames.find((f) => f.body === 'rx:victory:3')!;
    expect(jump.bodyAt.top).toBeCloseTo(top - 20 - 7, 6);
    // 全高 20 CSS px の枠は変えない。
    expect(sprite.style.width).toBe('');
  });

  it('右向きではエフェクトも本体の中心で左右反転する。180 は本体だけ反転し、ボードは反転せず本体の中心で折り返した位置へずらす', () => {
    for (let seed = 1; seed < 20; seed += 1) {
      standing({ seed });
      if (controller.snapshot().dir > 0) break;
      controller.destroy();
    }
    expect(controller.snapshot().dir).toBe(1);
    controller.reactLive('cheer');
    const cheer = record(300).filter((f) => f.effect);
    expect(cheer.every((f) => f.effectAt!.flipped && f.bodyAt.flipped)).toBe(true);
    // 本体の移動量 (-1, 0) も右向きでは +1。
    const moved = cheer.find((f) => f.body === 'rx:cheer:2')!;
    expect(moved.poseX).toBe(1);
    for (let i = 0; i < 400 && controller.snapshot().action !== 'idle'; i += 1) advance(16);
    const { x } = controller.snapshot();
    controller.reactLive('surprise180');
    const board = record(1_800).filter((f) => f.effect);
    expect(board.length).toBeGreaterThan(0);
    for (const f of board) {
      expect(f.effectAt!.flipped, f.effect).toBe(false);
      expect(f.bodyAt.flipped, f.body).toBe(true);
      // ボード (x = -1.33〜24.33) を本体の中心で折り返す: 7px 右へ。
      expect(f.effectAt!.left).toBeCloseTo(Math.round(x) - 11 + 7, 6);
    }
    expect(new Set(board.map((f) => f.effect))).toEqual(new Set(REACTIONS.surprise180.durationsMs.map((_, k) => `surprise180:${k}`)));
  });
});

describe('優先順位・割り込み・クールダウン', () => {
  it('再生中は、より重要な出来事だけが割り込む (同じか低いものは捨てる)。エフェクトの残像を残さない', () => {
    standing();
    controller.reactLive('cheer');
    advance(100);
    expect(controller.reactLive('anxious')).toBe(false);
    expect(controller.snapshot().events.at(-1)).toBe('live:anxious:dropped:busy');
    expect(controller.reactLive('victory')).toBe(true);
    let s = controller.snapshot();
    expect(s.live).toBe('victory');
    expect(s.effect).toBe('victory:0');
    expect(effect.dataset.frame).toBe('victory:0');
    advance(100);
    expect(controller.reactLive('surprise180')).toBe(false);
    expect(controller.reactLive('frustrated')).toBe(false);
    advance(1_400);
    s = controller.snapshot();
    expect(s.live).toBeNull();
    expect(effect.dataset.active).toBe('false');
  });

  it('通常の得点は、前の得点の反応から一定時間は捨てる。勝敗・180 などの重要な出来事はクールダウンを受けない', () => {
    standing();
    controller.reactLive('cheer');
    advance(800);
    expect(controller.reactLive('panic')).toBe(false);
    expect(controller.snapshot().events.at(-1)).toBe('live:panic:dropped:cooldown');
    expect(controller.reactLive('surprise180')).toBe(true);
    advance(1_800);
    expect(controller.reactLive('legWin')).toBe(true);
    advance(1_000);
    now += DEFAULT_LIVE.scoreCooldownMs;
    expect(controller.reactLive('panic')).toBe(true);
  });

  it('休止中 (モーダル) に届いた出来事は捨て、休止が解けてもまとめて再生しない', async () => {
    standing();
    const modal = document.createElement('div');
    modal.setAttribute('aria-modal', 'true');
    app.append(modal);
    await Promise.resolve();
    expect(controller.reactLive('victory')).toBe(false);
    expect(controller.snapshot().events.at(-1)).toBe('live:victory:dropped:paused');
    modal.remove();
    await Promise.resolve();
    advance(3_000);
    expect(controller.snapshot().events).not.toContain('live:victory');
  });

  it('演出中にモーダルが開いたら、エフェクトごと即座に隠す', async () => {
    standing();
    controller.reactLive('victory');
    advance(200);
    const modal = document.createElement('div');
    modal.setAttribute('aria-modal', 'true');
    app.append(modal);
    await Promise.resolve();
    expect(sprite.dataset.visible).toBe('false');
    expect(effect.dataset.active).toBe('false');
    expect(controller.snapshot().live).toBeNull();
  });

  it('縁にしがみついている途中: 重要な出来事は待ってから (よじ登ったあと) 演出し、得点は捨てる', () => {
    standing();
    expect(controller.trigger('slip')).toBe(true);
    advance(700);
    expect(controller.reactLive('cheer')).toBe(false);
    expect(controller.reactLive('gameWin')).toBe(false);
    expect(controller.snapshot().pendingLive).toBe('gameWin');
    const seen = new Set<string>();
    for (let i = 0; i < 300 && !seen.has('live:gameWin'); i += 1) {
      advance(16);
      for (const e of controller.snapshot().events) seen.add(e);
    }
    expect(seen.has('live:gameWin')).toBe(true);
    expect(seen.has('action:climb')).toBe(true);
  });

  it('待っている間に足場が消えて (スクロールなど) 出直したら、待っていた出来事は別の場所で再生しない', () => {
    standing();
    controller.trigger('slip');
    advance(700);
    controller.reactLive('surprise180');
    expect(controller.snapshot().pendingLive).toBe('surprise180');
    window.dispatchEvent(new Event('scroll'));
    expect(controller.snapshot().pendingLive).toBeNull();
    for (let i = 0; i < 300; i += 1) {
      advance(16);
      expect(controller.snapshot().live).toBeNull();
    }
  });

  it('待っている間に休止したら捨てる。待てる時間を過ぎても捨てる', async () => {
    standing();
    controller.trigger('slip');
    advance(700);
    controller.reactLive('victory');
    expect(controller.snapshot().pendingLive).toBe('victory');
    const modal = document.createElement('div');
    modal.setAttribute('aria-modal', 'true');
    app.append(modal);
    await Promise.resolve();
    expect(controller.snapshot().pendingLive).toBeNull();
    modal.remove();
  });
});

describe('安全: エフェクトの範囲・素材の読み込み・後片付け', () => {
  it('足元より下に出るエフェクト (敗北の砂ぼこり) は、カードの面の文字に重なっても演出する。見えている範囲の下で切れるなら演出しない', () => {
    standing();
    const { x, top } = controller.snapshot();
    // カードの面 (足元のすぐ下) に、砂ぼこりにかかる幅の文字。
    obstacles = [{ left: x - 20, right: x + 50, top: top + 1, bottom: top + 3 }];
    expect(controller.reactLive('frustrated')).toBe(true);
    advance(4_000);
    // 見えている範囲の下端が足元のすぐ下 (下部ナビ): 砂ぼこりが切れる。同じ高さのどこでも切れるので見送る。
    advance(DEFAULT_LIVE.scoreCooldownMs);
    const bottom = VIEW.bottom;
    VIEW.bottom = top + 2;
    try {
      expect(controller.reactLive('frustrated')).toBe(false);
      expect(controller.snapshot().events.at(-1)).toBe('live:frustrated:skipped:room');
    } finally {
      VIEW.bottom = bottom;
    }
  });

  it('観戦の対象が変わった (cancelLive): 演出中のリアクションをエフェクトごとやめ、待っている出来事を捨てる', () => {
    standing();
    controller.reactLive('victory');
    advance(100);
    controller.cancelLive();
    expect(controller.snapshot().live).toBeNull();
    expect(effect.dataset.active).toBe('false');
    expect(controller.snapshot().action).toBe('idle');
    for (let i = 0; i < 400 && controller.snapshot().action !== 'idle'; i += 1) advance(16);
    controller.trigger('slip');
    advance(700);
    controller.reactLive('victory');
    expect(controller.snapshot().pendingLive).toBe('victory');
    controller.cancelLive();
    expect(controller.snapshot().pendingLive).toBeNull();
    for (let i = 0; i < 250; i += 1) {
      advance(16);
      expect(controller.snapshot().live).toBeNull();
    }
  });

  it('体とエフェクトは文字・ボタンなどほかの UI に重なってよい。見えている範囲で切れる (固定ヘッダーの裏) なら演出しない。演出中に切れたらやめる', async () => {
    standing();
    const { top } = controller.snapshot();
    // 180 のボードの高さに文字・ボタン: 重なってよい。
    obstacles = [{ left: 0, right: 1_000, top: top - 20 - 12, bottom: top - 20 - 2 }];
    expect(controller.reactLive('surprise180')).toBe(true);
    advance(4_000);
    // 見えている範囲の上端 (固定ヘッダーの下端) がボードの途中: 同じ高さのどこでも切れるので見送る。
    const viewTop = VIEW.top;
    VIEW.top = top - 20 - 4;
    try {
      expect(controller.reactLive('surprise180')).toBe(false);
      expect(controller.snapshot().events.at(-1)).toBe('live:surprise180:skipped:room');
      VIEW.top = viewTop;
      expect(controller.reactLive('surprise180')).toBe(true);
      advance(200);
      // 演出中に画面が変わり、ボードが見えている範囲から切れた。
      VIEW.top = top - 20 - 4;
      root.append(document.createElement('p'));
      await Promise.resolve();
      advance(32);
      expect(controller.snapshot().events).toContain('live:stopped:room');
      expect(effect.dataset.active).toBe('false');
    } finally {
      VIEW.top = viewTop;
    }
  });

  it('その場では見えている範囲で切れるなら、振り向くか、同じ足場の近くで収まる位置へ歩いてから演出する (重要な出来事だけ)', () => {
    standing();
    const { x } = controller.snapshot();
    // 見えている範囲の左端が、いまの位置のボードの左側にかかる (ピンチズームなど)。振り向くか、右へ寄れば収まる。
    const left = VIEW.left;
    VIEW.left = x - 4;
    try {
      controller.reactLive('surprise180');
      const first = controller.snapshot().events.at(-1);
      expect(['live:surprise180', 'live:surprise180:seeking']).toContain(first);
      advance(6_000);
      expect(controller.snapshot().events).toContain('live:surprise180');
      expect(controller.snapshot().events.filter((e) => e === 'live:surprise180:skipped:room')).toEqual([]);
      const after = controller.snapshot().x;
      expect(Math.abs(after - x)).toBeLessThanOrEqual(DEFAULT_LIVE.roomSearchPx);
      // 体のいる位置で、どちらかの向きなら収まる (演出した位置)。
      expect(after).toBeGreaterThanOrEqual(x);
      // 通常の得点 (重要でない) は探さずに見送る (左右とも切れる位置)。
      VIEW.left = after - 4;
      VIEW.right = after + 30 + 4;
      advance(DEFAULT_LIVE.scoreCooldownMs + 2_000);
      for (let i = 0; i < 400 && controller.snapshot().action !== 'idle'; i += 1) advance(16);
      controller.reactLive('cheer');
      expect(controller.snapshot().events.at(-1)).not.toBe('live:cheer:seeking');
    } finally {
      VIEW.left = left;
      VIEW.right = 1_000;
    }
  });

  it('リアクションの画像を読み込めていなければ演出しない (逆転・Leg やゲームの結果は PR2 の動作で演出する)', () => {
    standing({ reactions: false });
    expect(controller.reactLive('victory')).toBe(false);
    expect(controller.snapshot().events.at(-1)).toBe('live:victory:skipped:asset');
    expect(controller.reactLive('comeback')).toBe(true);
    const frames = order(record(1_200).map((f) => f.body));
    expect(frames.some((f) => f.startsWith('happy:'))).toBe(true);
  });

  it('逆転: 喜ぶコマで 2 回跳ねてから、もう一度跳ねる。Leg の勝ちは跳ねずに控えめに喜ぶ', () => {
    standing();
    controller.reactLive('comeback');
    let frames = record(1_400);
    // 喜ぶコマを再生しながら跳ね、喜ぶコマのあと (待機コマ) でもう一度跳ねる。
    expect(frames.some((f) => f.body.startsWith('happy:') && f.lift > 0)).toBe(true);
    expect(frames.some((f) => f.body === 'base:0:0' && f.lift > 0 && f.live === 'comeback')).toBe(true);
    expect(controller.snapshot().lift).toBe(0);
    for (let i = 0; i < 400 && controller.snapshot().action !== 'idle'; i += 1) advance(16);
    controller.reactLive('legWin');
    frames = record(900);
    expect(Math.max(...frames.map((f) => f.lift))).toBe(0);
    expect(order(frames.map((f) => f.body)).some((f) => f.startsWith('happy:'))).toBe(true);
  });

  it('演出中にスクロール・リサイズ・見える範囲の変化があったら、エフェクトをすぐにやめる (止まっても出し直さない)', () => {
    for (const fire of [
      () => window.dispatchEvent(new Event('scroll')),
      () => window.dispatchEvent(new Event('resize')),
    ]) {
      standing();
      expect(controller.reactLive('victory')).toBe(true);
      advance(200);
      expect(effect.dataset.active).toBe('true');
      fire();
      expect(controller.snapshot().events).toContain('live:stopped:view');
      expect(controller.snapshot().live).toBeNull();
      expect(effect.dataset.active).toBe('false');
      advance(1_500);
      expect(controller.snapshot().events.filter((e) => e === 'live:victory')).toHaveLength(1);
      controller.destroy();
    }
  });

  it('スクロールの途中に届いた出来事: 得点は捨て、重要な出来事はスクロールが止まってから演出する', () => {
    standing();
    window.dispatchEvent(new Event('scroll'));
    advance(16);
    expect(controller.reactLive('cheer')).toBe(false);
    expect(controller.snapshot().events.at(-1)).toBe('live:cheer:dropped:busy');
    expect(controller.reactLive('victory')).toBe(false);
    expect(controller.snapshot().pendingLive).toBe('victory');
    expect(controller.snapshot().live).toBeNull();
    const seen = new Set<string>();
    for (let i = 0; i < 100 && !seen.has('live:victory'); i += 1) {
      advance(16);
      for (const e of controller.snapshot().events) seen.add(e);
    }
    expect(seen.has('live:victory')).toBe(true);
  });

  it('観戦の演出中は、速いスクロールのあとでも「転ぶ」を始めない', () => {
    standing();
    expect(controller.reactLive('legWin')).toBe(true);
    let y = 0;
    const scrollY = vi.spyOn(window, 'scrollY', 'get').mockImplementation(() => y);
    for (let i = 0; i < 5; i += 1) {
      y += 120;
      window.dispatchEvent(new Event('scroll'));
      advance(16);
    }
    const seen = new Set<string>();
    for (let i = 0; i < 40; i += 1) {
      advance(16);
      for (const e of controller.snapshot().events) seen.add(e);
    }
    scrollY.mockRestore();
    expect(seen.has('tumble:skipped:live')).toBe(true);
    expect([...seen].some((e) => e.startsWith('react:tumble') || e === 'action:tumble')).toBe(false);
  });

  it('演出中のタップには反応しない (一度に 1 つ)', () => {
    standing();
    controller.reactLive('victory');
    advance(100);
    const { x, top } = controller.snapshot();
    const event = (type: string) => {
      const e = new MouseEvent(type, { bubbles: true, clientX: x + 8, clientY: top - 10, button: 0 });
      Object.defineProperty(e, 'pointerId', { value: 1 });
      Object.defineProperty(e, 'pointerType', { value: 'touch' });
      window.dispatchEvent(e);
    };
    event('pointerdown');
    advance(60);
    event('pointerup');
    expect(controller.snapshot().events.some((e) => e.startsWith('react:'))).toBe(false);
  });

  it('destroy でタイマー・待ち・エフェクトを残さない', () => {
    standing();
    controller.trigger('slip');
    advance(700);
    controller.reactLive('victory');
    controller.destroy();
    expect(vi.getTimerCount()).toBe(0);
    expect(effect.dataset.active).toBe('false');
  });
});
