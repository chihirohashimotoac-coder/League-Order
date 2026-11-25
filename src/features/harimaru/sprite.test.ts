import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { MOTIONS } from './clips';
import { CLIP_IDS, CLIPS, clipOffset, clipUrlFor, type ClipId } from './sprite';
import { SPRITE } from './params';

/** PNG の幅・高さ (IHDR)。 */
function pngSize(path: string): { width: number; height: number } {
  const data = readFileSync(path);
  expect(data.subarray(1, 4).toString('latin1')).toBe('PNG');
  return { width: data.readUInt32BE(16), height: data.readUInt32BE(20) };
}

describe('追加素材 v0.9 (14 動作・68 コマ)', () => {
  it('14 動作・合計 68 コマで、コマごとの時間・基準点・横のずれの数がコマ数と合う', () => {
    expect(CLIP_IDS).toHaveLength(14);
    expect(CLIP_IDS.reduce((sum, id) => sum + CLIPS[id].frameCount, 0)).toBe(68);
    for (const id of CLIP_IDS) {
      const spec = CLIPS[id];
      expect(spec.durationsMs, id).toHaveLength(spec.frameCount);
      expect(spec.anchors, id).toHaveLength(spec.frameCount);
      if (spec.moveX) expect(spec.moveX, id).toHaveLength(spec.frameCount);
      expect(MOTIONS[id].available, id).toBe(true);
    }
  });

  it('アトラスは 1x / 2x / 3x とも横 1 行 (コマ数 × 30 CSS px、高さ 20 CSS px)', () => {
    for (const id of CLIP_IDS) {
      for (const density of [1, 2, 3]) {
        const file = fileURLToPath(new URL(`./assets/v09/${id}@${density}x.png`, import.meta.url));
        expect(pngSize(file), `${id}@${density}x`).toEqual({ width: CLIPS[id].frameCount * SPRITE.width * density, height: SPRITE.height * density });
      }
      expect(clipUrlFor(id, 1)).toBeTruthy();
      expect(clipUrlFor(id, 2)).not.toBe(clipUrlFor(id, 1));
      expect(clipUrlFor(id, 3)).not.toBe(clipUrlFor(id, 2));
    }
  });

  /** コマの左上 (掴む点からのずれ) + 基準点 = 掴む点 (+ 横のずれ)。 */
  const world = (id: ClipId, frame: number, dir: -1 | 1) => {
    const o = clipOffset(id, frame, dir);
    const anchor = CLIPS[id].anchors[frame]!;
    const ax = dir < 0 ? anchor[0] : SPRITE.width - anchor[0];
    return { x: o.dx + ax, y: o.dy + anchor[1] };
  };

  it('滑る → しがみつく → よじ登る → 待機: どのコマも基準点が縁の線 (掴む点) に乗り、座標が跳ねない', () => {
    for (const dir of [-1, 1] as const) {
      const sign = dir < 0 ? 1 : -1;
      for (const id of ['slip', 'hang', 'climb'] as const) {
        for (let k = 0; k < CLIPS[id].frameCount; k += 1) {
          const p = world(id, k, dir);
          // 縦: 基準点はいつも縁の線 (y = 0)。横: 掴む点 + 横のずれ (左右反転では符号が逆)。
          expect(p.y, `${id}${k}`).toBeCloseTo(0, 9);
          expect(p.x, `${id}${k}`).toBeCloseTo(sign * (CLIPS[id].moveX?.[k] ?? 0), 9);
        }
      }
      // つなぎ目: 滑るの最後 = しがみつくの最初、しがみつくの最後 = よじ登るの最初 (同じ位置に同じ絵)。
      expect(clipOffset('slip', 4, dir)).toEqual(clipOffset('hang', 0, dir));
      expect(clipOffset('hang', 3, dir)).toEqual(clipOffset('climb', 0, dir));
      // 最初のコマと最後のコマは立ち姿 (足元 y = 20)。
      expect(clipOffset('slip', 0, dir).dy).toBe(-20);
      expect(clipOffset('climb', 5, dir).dy).toBe(-20);
      // しがみつく間、体は縁の線より下へ 8.5px 出る (隠れる動作のマスクで切り取らない)。
      expect(SPRITE.height + clipOffset('hang', 0, dir).dy).toBeCloseTo(8.5, 9);
      // 隣り合うコマで、描く位置の縦のずれは 3.5px 以下 (一度に 8.5px 跳ばない)。
      const chain = [...[0, 1, 2, 3, 4].map((k) => clipOffset('slip', k, dir)), ...[0, 1, 2, 3, 4, 5].map((k) => clipOffset('climb', k, dir))];
      for (let i = 1; i < chain.length; i += 1) {
        if (i === 5) continue; // 滑るの最後 → (しがみつく) → よじ登るの最初は同じ位置
        expect(Math.abs(chain[i].dy - chain[i - 1].dy), `step ${i}`).toBeLessThanOrEqual(3.5);
      }
    }
  });

  it('左右反転すると基準点の x は 30 - x、横のずれは符号が逆になる', () => {
    const left = clipOffset('slip', 1, -1);
    const right = clipOffset('slip', 1, 1);
    expect(left.dx).toBeCloseTo(2 - 9.7, 9);
    expect(right.dx).toBeCloseTo(-2 - (30 - 9.7), 9);
    expect(left.dy).toBe(right.dy);
  });
});
