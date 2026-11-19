/**
 * ハリマル素材 v0.2 (待機・歩行・睡眠) のスプライトシート。
 *
 * 横 4 列 × 縦 3 行、1 コマ 30×20 CSS px。行 0 = 待機 (コマ 1 は瞬き)、行 1 = 歩行、
 * 行 2 = 睡眠 (0→3 で丸まる)。元の絵は左向きで、右へ進むときは左右反転する (反転は確定仕様で許可)。
 * 端末の画素密度に合う 1 枚だけを読み込む (1x / 2x / 3x)。
 */
import atlas1x from './assets/harimaru_atlas@1x.png';
import atlas2x from './assets/harimaru_atlas@2x.png';
import atlas3x from './assets/harimaru_atlas@3x.png';
import { SPRITE } from './params';

export const ATLAS = { columns: 4, rows: 3 } as const;

export const ROW = { idle: 0, walk: 1, sleep: 2 } as const;
export type SpriteRow = (typeof ROW)[keyof typeof ROW];

export const IDLE_OPEN = 0;
export const IDLE_BLINK = 1;
/** 待機のコマ 3: 少し正面を向く (周囲を見る・顔を出したときに使う)。 */
export const IDLE_LOOK = 2;
/** 睡眠のコマ 1・2: 目を開けて伏せる / 目を閉じて伏せる (休むときに使う)。 */
export const REST_OPEN = 0;
export const REST_BLINK = 1;
/** 歩行のコマ 2: 前後の足が開いた姿 (ジャンプの空中で使う)。 */
export const WALK_AIR = 1;
export const SLEEP_FRAMES = 4;
export const WALK_FRAMES = 4;

/** 画素密度に合う素材の URL。 */
export function atlasFor(devicePixelRatio: number): string {
  if (!(devicePixelRatio > 1)) return atlas1x;
  if (devicePixelRatio <= 2) return atlas2x;
  return atlas3x;
}

/** background-position の値。 */
export function framePosition(row: SpriteRow, column: number): string {
  return `${-column * SPRITE.width}px ${-row * SPRITE.height}px`;
}

export const BACKGROUND_SIZE = `${ATLAS.columns * SPRITE.width}px ${ATLAS.rows * SPRITE.height}px`;

// ------------------------------------------------------------------ 追加素材 v0.9 (14 動作・68 コマ)

/**
 * 追加素材 v0.9 の動作ごとのアトラス (横 1 行、1 コマ 30×20 CSS px、元の絵は左向き)。
 * 値は素材の manifest.json (v0.9) の写し。画像は素材の `clips/` をそのまま使う (加工しない)。
 *
 * - `anchors`: コマの左上から測った描画の基準点 (CSS px)。縁・カーソルの「掴む点」(カードの上辺の線の上の点、
 *   またはカーソルの先端) に合わせて置く。立ち姿では足元 (y = 20)。null のコマは足元を枠の下端に置く。
 * - `moveX`: 掴む点に対する、コマごとの横のずれ (CSS px、左向きの絵での右が正)。
 * - 左右反転 (右向き) では、基準点の x は 30 - x、横のずれは符号を反転する。
 */
export type ClipId =
  | 'hang' | 'slip' | 'climb' | 'cursorHang' | 'tumble' | 'sleepyFall' | 'groom'
  | 'stretch' | 'lookUp' | 'surprise' | 'tilt' | 'play' | 'run' | 'happy';

export interface ClipSpec {
  frameCount: number;
  durationsMs: readonly number[];
  loop: boolean;
  anchors: readonly (readonly [number, number] | null)[];
  moveX?: readonly number[];
}

const none = (n: number): null[] => Array.from({ length: n }, () => null);

export const CLIPS: Record<ClipId, ClipSpec> = {
  hang: { frameCount: 4, durationsMs: [95, 115, 115, 95], loop: true, anchors: [[10.1, 11.5], [10.1, 11.5], [10.1, 11.5], [10.1, 11.5]] },
  slip: {
    frameCount: 5,
    durationsMs: [220, 110, 85, 85, 95],
    loop: false,
    anchors: [[9.7, 20], [9.7, 18.9], [9.7, 15.7], [10, 15], [10.1, 11.5]],
    moveX: [3, 2, 1, 0, 0],
  },
  climb: {
    frameCount: 6,
    durationsMs: [95, 105, 115, 135, 135, 315],
    loop: false,
    anchors: [[10.1, 11.5], [10.8, 14.4], [10.6, 15.0], [10.7, 17.2], [10.2, 19.5], [9.7, 20]],
  },
  cursorHang: { frameCount: 4, durationsMs: [115, 115, 125, 115], loop: true, anchors: [[9.5, 11.8], [9.5, 11.9], [9.5, 12.2], [9.5, 11.8]] },
  tumble: { frameCount: 7, durationsMs: [100, 75, 75, 75, 80, 115, 210], loop: false, anchors: none(7), moveX: [5, 3, 1, -1, -3, -5, -6] },
  sleepyFall: {
    frameCount: 4,
    durationsMs: [270, 150, 130, 225],
    loop: false,
    anchors: [[15, 20], [15, 18.8], [15, 17.4], [15, 20]],
    moveX: [2, 1, 0, 2],
  },
  groom: { frameCount: 5, durationsMs: [145, 155, 215, 140, 155], loop: false, anchors: none(5) },
  stretch: { frameCount: 5, durationsMs: [140, 135, 230, 130, 170], loop: false, anchors: none(5) },
  lookUp: { frameCount: 5, durationsMs: [160, 135, 260, 125, 170], loop: false, anchors: none(5) },
  surprise: { frameCount: 5, durationsMs: [120, 80, 190, 125, 160], loop: false, anchors: none(5) },
  tilt: { frameCount: 5, durationsMs: [150, 130, 270, 140, 150], loop: false, anchors: none(5) },
  play: { frameCount: 5, durationsMs: [130, 100, 95, 120, 155], loop: false, anchors: none(5) },
  run: { frameCount: 4, durationsMs: [78, 72, 78, 72], loop: true, anchors: none(4) },
  happy: { frameCount: 4, durationsMs: [120, 125, 275, 175], loop: false, anchors: none(4) },
};

export const CLIP_IDS = Object.keys(CLIPS) as ClipId[];

/** 素材の URL (ビルド時にハッシュ付きの名前になる)。キーは `${id}@${density}x`。 */
const CLIP_URLS = import.meta.glob<string>('./assets/v09/*.png', { eager: true, import: 'default', query: '?url' });

/** 画素密度に合う、動作のアトラスの URL。 */
export function clipUrlFor(id: ClipId, devicePixelRatio: number): string | null {
  const density = !(devicePixelRatio > 1) ? 1 : devicePixelRatio <= 2 ? 2 : 3;
  return CLIP_URLS[`./assets/v09/${id}@${density}x.png`] ?? null;
}

export function clipBackgroundSize(id: ClipId): string {
  return `${CLIPS[id].frameCount * SPRITE.width}px ${SPRITE.height}px`;
}

export function clipFramePosition(column: number): string {
  return `${-column * SPRITE.width}px 0px`;
}

/**
 * 基準点を使う動作で、掴む点 (grip) に対するコマの左上の位置。
 * @param dir 向き (-1 = 左向き = 元の絵、1 = 左右反転)
 * @returns 表示枠の左上 (left, top) から掴む点までの差を引いた位置 = grip.x + dx, grip.y + dy
 */
export function clipOffset(id: ClipId, frame: number, dir: -1 | 1): { dx: number; dy: number } {
  const spec = CLIPS[id];
  const anchor = spec.anchors[frame] ?? [SPRITE.width / 2, SPRITE.height];
  const ax = dir < 0 ? anchor[0] : SPRITE.width - anchor[0];
  const mx = (spec.moveX?.[frame] ?? 0) * (dir < 0 ? 1 : -1);
  return { dx: mx - ax, dy: -anchor[1] };
}

// ------------------------------------------------------------------ PR3 観戦リアクション素材 v0.5 (6 種・49 コマ)

/**
 * n01 観戦のリアクション素材 v0.5。本体 (30×20 CSS px、足元 y = 20) とエフェクト (52×42 CSS px、本体の
 * 左上から x = -11、y = -18) の 2 枚のアトラス (横 1 行) を重ねて描く。値は素材の manifest.json の写し。
 * 合成済みアトラス・GIF・制作元画像はアプリに入れない。
 *
 * - `bodyOffsets`: 本体だけを動かす量 (CSS px)。エフェクトは本体の動く前の位置に固定する (manifest の composite と同じ)。
 * - `effectsInFront`: エフェクトを本体の前に重ねるか (180 のボードは本体の後ろ)。
 * - `effectBox`: エフェクトの描かれる範囲 (左向き、本体の左上から、CSS px)。3x 素材の不透明度 16/255 以上の
 *   画素を全コマで包む範囲を外側へ丸めた値 (検品スクリプトで測定)。安全な余白の判定に使う。
 */
export type ReactionId = 'victory' | 'cheer' | 'panic' | 'anxious' | 'frustrated' | 'surprise180';

export interface ReactionSpec {
  frameCount: number;
  durationsMs: readonly number[];
  bodyOffsets: readonly (readonly [number, number])[];
  effectsInFront: boolean;
  effectBox: { left: number; top: number; right: number; bottom: number };
  /** 文字を描いたコマ (左右反転してはいけない)。 */
  textFrames?: readonly number[];
}

export const EFFECT_CELL = { width: 52, height: 42, offsetX: -11, offsetY: -18 } as const;

export const REACTIONS: Record<ReactionId, ReactionSpec> = {
  victory: {
    frameCount: 10,
    durationsMs: [70, 110, 100, 170, 100, 80, 150, 100, 190, 120],
    bodyOffsets: [[0, 0], [0, 0], [0, -4], [0, -7], [0, 0], [0, 0], [0, -5], [0, 0], [0, 0], [0, 0]],
    effectsInFront: true,
    effectBox: { left: -7, top: -12, right: 35, bottom: 9 },
  },
  cheer: {
    frameCount: 6,
    durationsMs: [70, 100, 90, 160, 120, 120],
    bodyOffsets: [[0, 0], [0, 0], [-1, 0], [-1, 0], [0, 0], [0, 0]],
    effectsInFront: true,
    effectBox: { left: -6, top: 0, right: 3, bottom: 14 },
  },
  panic: {
    frameCount: 8,
    durationsMs: [70, 90, 140, 190, 100, 100, 130, 120],
    bodyOffsets: [[0, 0], [1, 0], [0, 0], [-1, 0], [0, 0], [1, 0], [0, 0], [0, 0]],
    effectsInFront: true,
    effectBox: { left: 6, top: -11, right: 20, bottom: 0 },
  },
  anxious: {
    frameCount: 8,
    durationsMs: [80, 120, 130, 140, 130, 180, 170, 130],
    bodyOffsets: [[0, 0], [1, 0], [0, 0], [1, 0], [-1, 0], [1, 0], [0, 0], [0, 0]],
    effectsInFront: true,
    effectBox: { left: 16, top: -6, right: 35, bottom: 12 },
  },
  frustrated: {
    frameCount: 8,
    durationsMs: [100, 120, 110, 160, 320, 290, 170, 140],
    bodyOffsets: [[0, 0], [0, 0], [0, 0], [-1, 0], [-1, 0], [-1, 0], [0, 0], [0, 0]],
    effectsInFront: true,
    effectBox: { left: -5, top: 13, right: 9, bottom: 20 },
  },
  surprise180: {
    frameCount: 9,
    durationsMs: [80, 130, 150, 170, 390, 310, 160, 170, 110],
    bodyOffsets: [[0, 0], [0, 0], [0, 0], [0, -1], [0, -2], [0, -1], [0, 0], [0, 0], [0, 0]],
    effectsInFront: false,
    effectBox: { left: -8, top: -14, right: 35, bottom: 16 },
    textFrames: [2, 3, 4, 5, 6],
  },
};

export const REACTION_IDS = Object.keys(REACTIONS) as ReactionId[];

const REACTION_URLS = import.meta.glob<string>('./assets/pr3/*/*.png', { eager: true, import: 'default', query: '?url' });

/** 画素密度に合う、リアクションの本体・エフェクトのアトラスの URL。 */
export function reactionUrlFor(id: ReactionId, layer: 'body' | 'effect', devicePixelRatio: number): string | null {
  const density = !(devicePixelRatio > 1) ? 1 : devicePixelRatio <= 2 ? 2 : 3;
  return REACTION_URLS[`./assets/pr3/${layer}/${id}@${density}x.png`] ?? null;
}
