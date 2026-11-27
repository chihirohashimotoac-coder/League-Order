import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { seededRng } from './behavior';
import { HarimaruController } from './controller';
import { DEFAULT_ANIMATION, DEFAULT_BEHAVIOR, DEFAULT_INTERACTION, SPRITE, DEFAULT_MOTION } from './params';
import { CLIP_IDS, CLIPS, type ClipId } from './sprite';
import type { Rect } from './terrain';
import type { MeasuredTerrain } from './terrainDom';

/**
 * 追加素材 v0.9 の動作 (滑る・しがみつく・よじ登る・転ぶ・寝ぼける・毛づくろい・伸び・見上げる・首をかしげる・
 * じゃれる・驚く・喜ぶ・走る・カーソルにぶら下がる) の再生・位置・安全の確かめ・中断。
 * 時計と乱数は差し替え、足場のカードは getBoundingClientRect を固定した要素で作る。
 */

const VIEW = { top: 0, bottom: 800, left: 0, right: 1_000 };
let now = 0;
let root: HTMLElement;
let app: HTMLElement;
let sprite: HTMLElement;
let card: HTMLElement;
let cardRect: Rect;
let controller: HarimaruController;
/** カードの内側 (seeThrough = card) で見つかる障害物と、それ以外の障害物。 */
let inside: Rect[];
let outside: Rect[];

const domRect = (r: Rect) => ({ ...r, width: r.right - r.left, height: r.bottom - r.top, x: r.left, y: r.top, toJSON: () => ({}) }) as DOMRect;

function terrain(): MeasuredTerrain {
  return {
    platforms: [{ left: cardRect.left, right: cardRect.right, top: cardRect.top }],
    elements: [card],
    obstacles: [],
    bounds: { left: 0, right: 1_000 },
    view: VIEW,
  };
}

const only = (weights: Partial<typeof DEFAULT_BEHAVIOR.weights>): typeof DEFAULT_BEHAVIOR => ({
  ...DEFAULT_BEHAVIOR,
  weights: { idle: 0, rest: 0, look: 0, walk: 0, run: 0, hop: 0, jump: 0, hide: 0, sleep: 0, groom: 0, stretch: 0, ...weights },
  sleepWhenInactive: 0,
  repeatPenalty: 1,
  repeatTwicePenalty: 1,
  afterMovingPenalty: 1,
  slipChance: 0,
  sleepyFallChance: 0,
});

function make(options: { seed?: number; behavior?: typeof DEFAULT_BEHAVIOR; finePointer?: boolean; sheets?: boolean } = {}): HarimaruController {
  controller = new HarimaruController({
    // 登場の端からカードまでの空白は 100px 前後 (この組のテストは登場の距離の上限を調べない)。
    motion: { ...DEFAULT_MOTION, entryMaxGap: 120 },
    sprite,
    root,
    watch: app,
    platformSelector: '.x',
    rng: seededRng(options.seed ?? 1),
    now: () => now,
    measure: () => terrain(),
    obstaclesIn: (_root, _regions, _win, seeThrough) => (seeThrough === card ? inside : outside),
    behavior: options.behavior ?? only({ idle: 1 }),
    finePointer: options.finePointer ?? false,
    interaction: DEFAULT_INTERACTION,
  });
  controller.setSheet('base', 'base.png');
  if (options.sheets !== false) for (const id of CLIP_IDS) controller.setSheet(id, `${id}.png`);
  return controller;
}

function advance(ms: number): void {
  for (let t = 0; t < ms; t += 16) {
    now += 16;
    vi.advanceTimersByTime(16);
  }
}

/** 立って待機している状態まで進める。 */
function standing(options: Parameters<typeof make>[0] = {}): HarimaruController {
  make(options).start();
  // 画面の端から入って (のぞいて引っ込む回もある)、足場の上で待機するまで。
  for (let i = 0; i < 2_000 && !(controller.snapshot().placed && controller.snapshot().action === 'idle'); i += 1) advance(16);
  expect(controller.snapshot().placed).toBe(true);
  return controller;
}

/** 姿を消したあと、端から入り直して足場に立つまで進める。 */
function untilPlaced(): void {
  for (let i = 0; i < 2_000 && !controller.snapshot().placed; i += 1) advance(16);
}

/** 表示枠の左上 (transform の translate3d)。 */
function drawn(): { left: number; top: number; flipped: boolean } {
  const m = /translate3d\(([-\d.]+)px, ([-\d.]+)px/.exec(sprite.style.transform)!;
  return { left: Number(m[1]), top: Number(m[2]), flipped: /scaleX\(-1\)/.test(sprite.style.transform) };
}

function pointer(type: string, x: number, y: number, extra: Record<string, unknown> = {}, target: EventTarget = window): void {
  const event = new MouseEvent(type, { bubbles: true, clientX: x, clientY: y, button: 0, relatedTarget: (extra.relatedTarget as EventTarget) ?? null });
  for (const [key, value] of Object.entries({ pointerId: 1, pointerType: 'mouse', buttons: 0, ...extra })) {
    if (key !== 'relatedTarget') Object.defineProperty(event, key, { value });
  }
  target.dispatchEvent(event);
}

/** 1 フレームごとに、描いているコマ・位置を記録しながら進める。 */
function record(ms: number): { frame: string; left: number; top: number; flipped: boolean; x: number; poseX: number; poseY: number; airborne: boolean }[] {
  const out = [];
  for (let t = 0; t < ms; t += 16) {
    advance(16);
    const s = controller.snapshot();
    out.push({ frame: sprite.dataset.frame ?? '', ...drawn(), x: s.x, poseX: s.poseX, poseY: s.poseY, airborne: s.airborne });
  }
  return out;
}

beforeEach(() => {
  vi.useFakeTimers();
  now = 0;
  inside = [];
  outside = [];
  app = document.createElement('div');
  root = document.createElement('main');
  card = document.createElement('div');
  cardRect = { left: 100, right: 500, top: 300, bottom: 400 };
  card.getBoundingClientRect = () => domRect(cardRect);
  root.append(card);
  app.append(root);
  document.body.append(app);
  sprite = document.createElement('div');
  document.body.append(sprite);
});

afterEach(() => {
  controller?.destroy();
  document.body.innerHTML = '';
  vi.useRealTimers();
});

describe('滑る → しがみつく → よじ登る → 待機', () => {
  it('コマの順に再生し、前足 (基準点) は縁の線の掴む点から動かず、最後は掴む点の上に立つ (左右どちらの向きでも)', () => {
    const dirs = new Set<number>();
    for (let seed = 1; seed < 12 && dirs.size < 2; seed += 1) {
      standing({ seed });
      // 端から入ると、入った向きのまま立つ: 2 回目は振り向かせて、反対の向きでも確かめる。
      if (dirs.has(controller.snapshot().dir)) {
        controller.trigger('turn');
        for (let i = 0; i < 200 && !(controller.snapshot().action === 'idle' && !dirs.has(controller.snapshot().dir)); i += 1) advance(16);
      }
      const start = controller.snapshot();
      if (dirs.has(start.dir) || start.action !== 'idle') {
        controller.destroy();
        continue;
      }
      dirs.add(start.dir);
      const before = drawn();
      expect(controller.trigger('slip')).toBe(true);
      const frames = [{ ...controller.snapshot(), ...drawn(), frame: sprite.dataset.frame ?? '' }, ...record(4_000)];
      // 再生の順: 滑る 0→4、しがみつく (ループ)、よじ登る 0→5、待機。
      const order = frames.map((f) => f.frame).filter((f, i, all) => f !== all[i - 1]);
      const firstClimb = order.indexOf('climb:0');
      expect(order.slice(0, 5)).toEqual(['slip:0', 'slip:1', 'slip:2', 'slip:3', 'slip:4']);
      expect(order.slice(5, firstClimb).every((f) => f.startsWith('hang:'))).toBe(true);
      expect(order.slice(5, firstClimb).length).toBeGreaterThanOrEqual(4);
      expect(order.slice(firstClimb, firstClimb + 6)).toEqual(['climb:0', 'climb:1', 'climb:2', 'climb:3', 'climb:4', 'climb:5']);
      expect(order[firstClimb + 6]).toBe('base:0:0');
      // 最初のコマは、それまでの立ち姿と同じ位置に描く (跳ねない)。
      expect(frames[0].left).toBeCloseTo(before.left, 6);
      expect(frames[0].top).toBeCloseTo(before.top, 6);
      // どのコマも、基準点 (左右反転では 30 - x) が掴む点 + 横のずれ、縁の線 (y = 300) に乗る。
      const dir = start.dir;
      const gripX = start.x + (dir < 0 ? 9.7 : 30 - 9.7) - (dir < 0 ? 3 : -3);
      for (const f of frames) {
        const [id, k] = f.frame.split(':') as [ClipId | 'base', string];
        if (id === 'base') continue;
        const anchor = CLIPS[id].anchors[Number(k)]!;
        const ax = dir < 0 ? anchor[0] : SPRITE.width - anchor[0];
        const mx = (CLIPS[id].moveX?.[Number(k)] ?? 0) * (dir < 0 ? 1 : -1);
        // 描く位置は端末の画素に丸めるので 1px 未満の差は許す。
        expect(Math.abs(f.left + ax - (gripX + mx)), f.frame).toBeLessThan(1);
        expect(Math.abs(f.top + anchor[1] - 300), f.frame).toBeLessThan(1);
        expect(f.flipped).toBe(dir > 0);
      }
      // 隣り合うフレームで、描く位置が大きく跳ばない (縦はコマの基準点の差 3.5px まで、横は素材の横のずれ
      // 1.3px まで。どちらも画素への丸め 1px を含めて見る)。
      for (let i = 1; i < frames.length; i += 1) {
        expect(Math.abs(frames[i].top - frames[i - 1].top), frames[i].frame).toBeLessThanOrEqual(4);
        expect(Math.abs(frames[i].left - frames[i - 1].left), frames[i].frame).toBeLessThanOrEqual(2);
      }
      // しがみついている間は体が縁の線より 8.5px 下へ出る (切り取らない)。
      const hang = frames.find((f) => f.frame.startsWith('hang:'))!;
      expect(hang.poseY).toBeCloseTo(8.5, 6);
      expect(sprite.style.clipPath).toBe('');
      // 最後は掴む点の上に立つ (3px 前へ進む)。
      const end = controller.snapshot();
      expect(end.action).toBe('idle');
      expect(end.airborne).toBe(false);
      expect(end.poseX).toBe(0);
      expect(end.poseY).toBe(0);
      expect(end.x).toBeCloseTo(start.x + (dir < 0 ? -3 : 3), 6);
      expect(end.top).toBe(300);
      expect(end.sheet).toBe('base');
      expect(sprite.style.backgroundImage).toBe('url("base.png")');
      expect(sprite.style.backgroundSize).toBe('120px 60px');
      controller.destroy();
      expect(vi.getTimerCount()).toBe(0);
    }
    expect(dirs.size).toBe(2);
  });

  it('しがみつく間は v0.9 の画像に切り替え、背景の大きさはその動作のコマ数に合わせる', () => {
    standing();
    controller.trigger('slip');
    advance(700);
    expect(controller.snapshot().sheet).toBe('hang');
    expect(sprite.style.backgroundImage).toBe('url("hang.png")');
    expect(sprite.style.backgroundSize).toBe(`${4 * 30}px 20px`);
  });

  it('カードの中の縁の下に文字・スコア・ボタンがあれば滑らない', () => {
    standing();
    const { x } = controller.snapshot();
    inside = [{ left: x, right: x + 20, top: 306, bottom: 316 }];
    expect(controller.trigger('slip')).toBe(false);
    // カードの外 (上の帯) だけの障害物は、縁の下の判定に関係しない (立っている帯は足場の計算で確かめ済み)。
    inside = [];
    outside = [{ left: x, right: x + 20, top: 306, bottom: 316 }];
    expect(controller.trigger('slip')).toBe(true);
  });

  it('足場のカードそのものがボタン・リンクなら、その面に体を重ねない (滑らない・寝ぼけない)', () => {
    const button = document.createElement('button');
    button.getBoundingClientRect = () => domRect(cardRect);
    card.replaceWith(button);
    card = button;
    standing();
    expect(controller.trigger('slip')).toBe(false);
    expect(controller.trigger('sleepyFall')).toBe(false);
    // 立つ・歩く・転ぶ (上辺の上だけを使う動作) はふつうにできる。
    expect(controller.snapshot().placed).toBe(true);
  });

  it('カードの角丸 (半径が角の余白より大きいとき) の上では滑らない。カードが低すぎても滑らない', () => {
    card.style.borderTopLeftRadius = '200px';
    standing();
    expect(controller.trigger('slip')).toBe(false);
    card.style.borderTopLeftRadius = '0px';
    cardRect = { ...cardRect, bottom: 308 };
    expect(controller.trigger('slip')).toBe(false);
    cardRect = { ...cardRect, bottom: 400 };
    expect(controller.trigger('slip')).toBe(true);
  });

  it('しがみつく途中でスクロール・DOM の変化があったら、足場へ瞬間移動して見せずに即座に隠れ、安全な場所から出直す', async () => {
    standing();
    controller.trigger('slip');
    advance(900);
    expect(controller.snapshot().action).toBe('hang');
    window.dispatchEvent(new Event('scroll'));
    expect(sprite.dataset.visible).toBe('false');
    let s = controller.snapshot();
    expect(s.placed).toBe(false);
    expect(s.airborne).toBe(false);
    expect(s.events).toContain('jump:aborted');
    untilPlaced();
    s = controller.snapshot();
    expect(s.placed).toBe(true);
    expect(s.poseY).toBe(0);

    // DOM の変化 (足場が消えた・中身が変わった)。
    for (let i = 0; i < 400 && controller.snapshot().action !== 'idle'; i += 1) advance(16);
    controller.trigger('slip');
    advance(900);
    root.append(document.createElement('p'));
    await Promise.resolve();
    expect(sprite.dataset.visible).toBe('false');
    expect(controller.snapshot().airborne).toBe(false);
  });

  it('しがみつく途中で、掴んでいるカードがスタイルだけで消えた・動いた (DOM の構造は同じ) ときも、次の描画の前に隠れる', () => {
    standing();
    controller.trigger('slip');
    advance(900);
    expect(controller.snapshot().action).toBe('hang');
    // display: none 相当 (大きさ 0)。
    const saved = cardRect;
    cardRect = { left: 0, right: 0, top: 0, bottom: 0 };
    advance(16);
    expect(sprite.dataset.visible).toBe('false');
    expect(controller.snapshot().events).toContain('hold:lost');
    expect(controller.snapshot().airborne).toBe(false);
    cardRect = saved;
    untilPlaced();
    expect(controller.snapshot().placed).toBe(true);
    // 寝ぼけている途中にカードが 2px 下へずれた。
    for (let i = 0; i < 400 && controller.snapshot().action !== 'idle'; i += 1) advance(16);
    expect(controller.trigger('sleepyFall')).toBe(true);
    advance(100);
    cardRect = { ...saved, top: saved.top + 2 };
    advance(16);
    expect(sprite.dataset.visible).toBe('false');
    expect(controller.snapshot().poseY).toBe(0);
  });

  it('しがみつく途中でモーダルが開いたら即座に隠れ、閉じると安全な足場から (立ち姿で) 出直す', async () => {
    standing();
    controller.trigger('slip');
    advance(900);
    const modal = document.createElement('div');
    modal.setAttribute('aria-modal', 'true');
    app.append(modal);
    await Promise.resolve();
    expect(sprite.dataset.visible).toBe('false');
    expect(controller.snapshot().paused).toContain('modal');
    expect(controller.snapshot().placed).toBe(false);
    expect(controller.snapshot().timers).toBe(0);
    modal.remove();
    await Promise.resolve();
    untilPlaced();
    const s = controller.snapshot();
    expect(s.placed).toBe(true);
    expect(s.poseX).toBe(0);
    expect(s.poseY).toBe(0);
    expect(sprite.dataset.visible).toBe('true');
  });

  it('しがみついている間・転んでいる間のタップには反応しない', () => {
    standing();
    controller.trigger('slip');
    advance(900);
    const { x } = controller.snapshot();
    pointer('pointerdown', x + 10, 305, { pointerType: 'touch' });
    advance(80);
    pointer('pointerup', x + 10, 305, { pointerType: 'touch' });
    expect(controller.snapshot().events.some((e) => e.startsWith('react:'))).toBe(false);
  });

  it('歩き終わりに、気まぐれに縁で足を滑らせる (確率 slipChance)', () => {
    make({ behavior: { ...only({ walk: 1, idle: 1 }), slipChance: 1 } }).start();
    const seen = new Set<string>();
    for (let i = 0; i < 2_000 && !seen.has('action:climb'); i += 1) {
      advance(16);
      for (const e of controller.snapshot().events) seen.add(e);
    }
    expect(seen.has('action:slip')).toBe(true);
    expect(seen.has('action:hang')).toBe(true);
    expect(seen.has('action:climb')).toBe(true);
  });
});

describe('転ぶ・寝ぼける', () => {
  it('転ぶ: 7 コマを順に再生し、横のずれのぶん前へ転がって起き上がる。足元は足場の上のまま', () => {
    standing();
    const start = controller.snapshot();
    expect(controller.trigger('tumble')).toBe(true);
    const frames = record(1_200);
    const order = frames.map((f) => f.frame).filter((f, i, all) => f !== all[i - 1]);
    expect(order.slice(0, 8)).toEqual(['tumble:0', 'tumble:1', 'tumble:2', 'tumble:3', 'tumble:4', 'tumble:5', 'tumble:6', 'base:0:0']);
    for (const f of frames) expect(f.poseY).toBe(0);
    const end = controller.snapshot();
    // 5 → -6 で 11px 前へ。
    expect(end.x).toBeCloseTo(start.x + (start.dir < 0 ? -11 : 11), 6);
    expect(end.poseX).toBe(0);
    expect(end.top).toBe(300);
  });

  it('前へ転がる足場がなければ転ばない', () => {
    // 立てる範囲が 12px だけの足場: 前へ 11px 転がれるのは、後ろの端に立っているときだけ。
    cardRect = { left: 100, right: 162, top: 300, bottom: 400 };
    let refused = 0;
    for (let seed = 1; seed < 20; seed += 1) {
      standing({ seed });
      const { x, dir } = controller.snapshot();
      const room = dir < 0 ? x - 11 >= 110 - 1e-9 : x + 11 <= 122 + 1e-9;
      const ok = controller.trigger('tumble');
      expect(ok).toBe(room);
      if (!ok) {
        refused += 1;
        expect(controller.snapshot().events).toContain('tumble:skipped:room');
      }
      controller.destroy();
    }
    expect(refused).toBeGreaterThan(0);
  });

  it('寝ぼける: 眠りの姿から傾いて目を開け、伏せてから起きる。縁の下へ出るのは 2.6px だけ', () => {
    standing();
    expect(controller.trigger('sleepyFall')).toBe(true);
    const frames = record(2_000);
    const order = frames.map((f) => f.frame).filter((f, i, all) => f !== all[i - 1]);
    expect(order.slice(0, 5)).toEqual(['sleepyFall:0', 'sleepyFall:1', 'sleepyFall:2', 'sleepyFall:3', 'base:2:0']);
    expect(Math.max(...frames.map((f) => f.poseY))).toBeCloseTo(2.6, 6);
    expect(controller.snapshot().events).toContain('wake');
  });

  it('眠っている途中に、気まぐれに寝ぼける (縁の下に文字があれば見送る)', () => {
    // 眠るのは無操作になってから (inactiveSleepAfterMs)。このテストはすぐに眠らせる。
    const sleepy = { ...only({ sleep: 1, idle: 0.0001 }), inactiveSleepAfterMs: 0, sleepWhenInactive: 1, sleepMs: [14_000, 15_000] as [number, number], sleepyFallChance: 1 };
    make({ behavior: sleepy }).start();
    const seen = new Set<string>();
    for (let i = 0; i < 3_000 && !seen.has('action:sleepyFall'); i += 1) {
      advance(16);
      for (const e of controller.snapshot().events) seen.add(e);
    }
    expect(seen.has('action:sleepyFall')).toBe(true);
    controller.destroy();
    inside = [{ left: 0, right: 1_000, top: 301, bottom: 304 }];
    make({ behavior: sleepy }).start();
    seen.clear();
    for (let i = 0; i < 3_000 && !seen.has('sleepyFall:skipped'); i += 1) {
      advance(16);
      for (const e of controller.snapshot().events) seen.add(e);
    }
    expect(seen.has('sleepyFall:skipped')).toBe(true);
    expect(seen.has('action:sleepyFall')).toBe(false);
  });
});

describe('日常の動作・触れ合い', () => {
  it('毛づくろい・伸びは行動の抽選で選ばれ、コマを順に再生して待機に戻る', () => {
    for (const action of ['groom', 'stretch'] as const) {
      make({ behavior: only({ [action]: 1, idle: 1 }) }).start();
      const seen = new Set<string>();
      for (let i = 0; i < 2_000 && !seen.has(`${action}:4`); i += 1) {
        advance(16);
        seen.add(sprite.dataset.frame ?? '');
      }
      for (let k = 0; k < 5; k += 1) expect(seen.has(`${action}:${k}`), `${action}:${k}`).toBe(true);
      controller.destroy();
    }
  });

  it('見上げる・首をかしげる・じゃれる: カーソルの方を向いて 1 回再生し、待機に戻る', () => {
    standing({ finePointer: true });
    for (const name of ['lookUp', 'tilt', 'play'] as const) {
      const { x, top } = controller.snapshot();
      // カーソルは右の遠く (反応の範囲の外) に置き、向きだけを確かめる。
      pointer('pointermove', x + 400, top - 40);
      expect(controller.trigger(name)).toBe(true);
      expect(controller.snapshot().dir).toBe(1);
      const order = record(1_200).map((f) => f.frame).filter((f, i, all) => f !== all[i - 1]);
      expect(order.slice(0, 6)).toEqual([`${name}:0`, `${name}:1`, `${name}:2`, `${name}:3`, `${name}:4`, 'base:0:0']);
      expect(controller.snapshot().action).toBe('idle');
    }
  });

  it('喜ぶ: 喜ぶコマを再生しながら小さく跳ね、足元に戻る。驚く: 跳び上がってから振り向く', () => {
    standing();
    expect(controller.trigger('happy')).toBe(true);
    let frames = record(900);
    expect(new Set(frames.map((f) => f.frame))).toEqual(new Set(['happy:0', 'happy:1', 'happy:2', 'happy:3', 'base:0:0']));
    expect(controller.snapshot().lift).toBe(0);
    const before = controller.snapshot().dir;
    expect(controller.trigger('surprise')).toBe(true);
    frames = record(1_300);
    expect(frames.some((f) => f.frame === 'surprise:2')).toBe(true);
    const s = controller.snapshot();
    expect(s.dir).toBe(before > 0 ? -1 : 1);
    expect(s.lift).toBe(0);
  });

  it('背後から触れると驚く (画像があれば振り向くの代わり)', () => {
    standing();
    const { x, top, dir } = controller.snapshot();
    const behindX = dir < 0 ? x + 30 + 8 : x - 8;
    pointer('pointerdown', behindX, top - 10, { pointerType: 'touch' });
    advance(80);
    pointer('pointerup', behindX, top - 10, { pointerType: 'touch' });
    expect(controller.snapshot().events.at(-1)).toBe('react:surprise');
  });

  it('駆け足は専用の走りコマをループする (画像がなければ歩行コマを速く再生する)', () => {
    standing();
    expect(controller.trigger('run')).toBe(true);
    const frames = new Set(record(600).map((f) => f.frame));
    expect([...frames].some((f) => f.startsWith('run:'))).toBe(true);
    controller.destroy();
    standing({ sheets: false });
    controller.trigger('run');
    const fallback = new Set(record(600).map((f) => f.frame));
    expect([...fallback].some((f) => f.startsWith('base:1:'))).toBe(true);
  });
});

describe('カーソルにぶら下がる (PC)', () => {
  /** 跳びつける位置 (頭の少し上) にカーソルを置く。 */
  const hangPoint = () => {
    const { x, top } = controller.snapshot();
    return { cx: x + 20.5, cy: top - 22 };
  };

  it('左右反転して前足の基準点をカーソルの先端に合わせ、体だけが揺れる。カーソルが動いたら放して立ち位置へ戻る', () => {
    standing({ finePointer: true });
    const start = controller.snapshot();
    const { cx, cy } = hangPoint();
    pointer('pointermove', cx, cy);
    expect(controller.trigger('cursorHang')).toBe(true);
    const frames = record(900);
    const hanging = frames.filter((f) => f.frame.startsWith('cursorHang:'));
    expect(new Set(hanging.map((f) => f.frame)).size).toBe(4);
    for (const f of hanging) {
      const anchor = CLIPS.cursorHang.anchors[Number(f.frame.split(':')[1])]!;
      expect(f.flipped).toBe(true);
      expect(Math.abs(f.left + (30 - anchor[0]) - cx)).toBeLessThan(1);
      expect(Math.abs(f.top + anchor[1] - cy)).toBeLessThan(1);
      expect(f.airborne).toBe(true);
    }
    // カーソルが動いた: 放して、立っていた位置へ降りる。
    pointer('pointermove', cx + 30, cy + 5);
    expect(controller.snapshot().events).toContain('cursorHang:release');
    advance(DEFAULT_ANIMATION.cursorLeapMs + 100);
    const end = controller.snapshot();
    expect(end.airborne).toBe(false);
    expect(end.poseX).toBe(0);
    expect(end.poseY).toBe(0);
    expect(end.x).toBe(start.x);
    expect(end.top).toBe(start.top);
  });

  it('クリックが始まった・ウィンドウの外へ出たら放す。一定時間でも放す', () => {
    standing({ finePointer: true });
    let p = hangPoint();
    pointer('pointermove', p.cx, p.cy);
    controller.trigger('cursorHang');
    advance(400);
    pointer('pointerdown', p.cx, p.cy);
    pointer('pointerup', p.cx, p.cy);
    expect(controller.snapshot().events).toContain('cursorHang:release');
    advance(4_000);
    for (let i = 0; i < 400 && controller.snapshot().action !== 'idle'; i += 1) advance(16);
    p = hangPoint();
    pointer('pointermove', p.cx, p.cy);
    controller.trigger('cursorHang');
    advance(400);
    pointer('pointerout', p.cx, p.cy, { relatedTarget: null });
    expect(controller.snapshot().airborne).toBe(true);
    advance(DEFAULT_ANIMATION.cursorLeapMs + 100);
    expect(controller.snapshot().airborne).toBe(false);
    for (let i = 0; i < 400 && controller.snapshot().action !== 'idle'; i += 1) advance(16);
    p = hangPoint();
    pointer('pointermove', p.cx, p.cy);
    controller.trigger('cursorHang');
    advance(DEFAULT_ANIMATION.cursorHangMs[1] + DEFAULT_ANIMATION.cursorLeapMs * 2 + 200);
    expect(controller.snapshot().airborne).toBe(false);
  });

  it('ボタンを押している (ドラッグ中)・操作部品の上・跳びつけない位置・経路に文字があるときは、ぶら下がらない', () => {
    standing({ finePointer: true });
    const p = hangPoint();
    pointer('pointermove', p.cx, p.cy, { buttons: 1 });
    expect(controller.trigger('cursorHang')).toBe(false);
    const button = document.createElement('button');
    root.append(button);
    pointer('pointermove', p.cx, p.cy, {}, button);
    expect(controller.trigger('cursorHang')).toBe(false);
    // 高すぎる・足元より下。
    pointer('pointermove', p.cx, p.cy - 40);
    expect(controller.trigger('cursorHang')).toBe(false);
    pointer('pointermove', p.cx, p.cy + 30);
    expect(controller.trigger('cursorHang')).toBe(false);
    // 経路に文字。
    outside = [{ left: p.cx - 15, right: p.cx, top: p.cy - 5, bottom: p.cy + 2 }];
    pointer('pointermove', p.cx, p.cy);
    expect(controller.trigger('cursorHang')).toBe(false);
    outside = [];
    pointer('pointermove', p.cx + 1, p.cy);
    expect(controller.trigger('cursorHang')).toBe(true);
  });

  it('ぶら下がっている途中でスクロールしたら即座に隠れて出直す', () => {
    standing({ finePointer: true });
    const p = hangPoint();
    pointer('pointermove', p.cx, p.cy);
    controller.trigger('cursorHang');
    advance(500);
    window.dispatchEvent(new Event('scroll'));
    expect(sprite.dataset.visible).toBe('false');
    expect(controller.snapshot().airborne).toBe(false);
    expect(controller.snapshot().placed).toBe(false);
  });

  it('近くで止まったカーソルに、気まぐれに見上げる・首をかしげる・ぶら下がる (高い頻度で繰り返さない)', () => {
    // 待機の長さは、カーソルが止まってから反応を考えるまで (cursorStillMs) より長くする。
    standing({ finePointer: true, behavior: { ...only({ idle: 1 }), idleMs: [2_500, 7_000] } });
    const seen = new Set<string>();
    let reactions = 0;
    for (let i = 0; i < 60; i += 1) {
      for (let j = 0; j < 400 && !['idle', 'look', 'rest'].includes(controller.snapshot().action ?? ''); j += 1) advance(16);
      const p = hangPoint();
      pointer('pointermove', p.cx, p.cy);
      const before = controller.snapshot().events.length;
      advance(DEFAULT_INTERACTION.cursorStillMs + 1_500);
      const events = controller.snapshot().events;
      if (events.length !== before) reactions += 1;
      for (const e of events) seen.add(e);
      if (controller.snapshot().airborne) pointer('pointermove', p.cx + 20, p.cy);
      advance(1_000);
    }
    expect(['react:lookUp', 'react:tilt', 'react:cursorHang'].filter((e) => seen.has(e)).length).toBeGreaterThanOrEqual(2);
    expect(reactions).toBeLessThan(60);
  });
});

describe('後片付け', () => {
  it('いろいろな v0.9 の動作を続けても、destroy でタイマー・フレームが残らない', () => {
    make({ seed: 3, behavior: { ...DEFAULT_BEHAVIOR, inactiveSleepAfterMs: 20_000, slipChance: 0.5, sleepyFallChance: 1 } }).start();
    const seen = new Set<string>();
    for (let i = 0; i < 4_000; i += 1) {
      advance(50);
      seen.add((sprite.dataset.frame ?? '').split(':')[0]);
    }
    expect(seen.size).toBeGreaterThanOrEqual(4);
    controller.destroy();
    expect(vi.getTimerCount()).toBe(0);
  });
});
