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
