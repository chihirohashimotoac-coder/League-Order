import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { MOTIONS, type MotionId } from './clips';
import { createHash } from 'node:crypto';
import { CLIP_IDS, CLIPS, clipAlpha, clipAnchor, clipOffset, clipUrlFor, MOTION_CLIPS, type ClipId, type MotionClipId } from './sprite';
import { SPRITE } from './params';

/** PNG の幅・高さ (IHDR)。 */
function pngSize(path: string): { width: number; height: number } {
  const data = readFileSync(path);
  expect(data.subarray(1, 4).toString('latin1')).toBe('PNG');
  return { width: data.readUInt32BE(16), height: data.readUInt32BE(20) };
}

/** 追加素材 v0.9 の動作 (v1.0 の動作を除く)。 */
const V09_IDS = CLIP_IDS.filter((id) => !(id in MOTION_CLIPS));

describe('追加素材 v0.9 (14 動作・68 コマ)', () => {
  it('14 動作・合計 68 コマで、コマごとの時間・基準点・横のずれの数がコマ数と合う', () => {
    expect(V09_IDS).toHaveLength(14);
    expect(V09_IDS.reduce((sum, id) => sum + CLIPS[id].frameCount, 0)).toBe(68);
    for (const id of V09_IDS) {
      const spec = CLIPS[id];
      expect(spec.durationsMs, id).toHaveLength(spec.frameCount);
      expect(spec.anchors, id).toHaveLength(spec.frameCount);
      if (spec.moveX) expect(spec.moveX, id).toHaveLength(spec.frameCount);
      expect(MOTIONS[id as MotionId].available, id).toBe(true);
    }
  });

  it('アトラスは 1x / 2x / 3x とも横 1 行 (コマ数 × 30 CSS px、高さ 20 CSS px)', () => {
    for (const id of V09_IDS) {
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

/** 動作素材 v1.0 の manifest.json (Harimaru-Motion-Pack-v1.0) の SHA-256。取り込んだ 30 枚が無加工であることを確かめる。 */
const V10_SHA256: Record<MotionClipId, [string, string, string]> = {
  lookDown: ['3523739b7527cb6d97ccd9af9f6f17b1fdb3071fb6af225c495fd75a28f7521e', '3404c8f794d19729dc04cef11aef0fd3419027ecf077e98ab283dcd29c5009da', 'c278993eff8b902914986313a117156a16e5b569b1dfebc929e28af818617c05'],
  jumpPrep: ['6b0e97b7ee4a9d157028256e2276194b93dbc582b8db90f2f158cd51b544d5e2', '397b4250d6de3f3532a8a165e5f05167f266e11e164ed886213e07ab87dabab4', 'ecfaebca75e0e84e1700d6ba7faf2e7e22d3c640897edb149c42b16879ca0cb1'],
  jumpAir: ['83a817889acf2ef569ee59cf84e21b13fafee40e5cac6ecb0c41686c13793ce1', 'a2903e22f2a2d6be69230a574afa47db834f52653c0af6eb194a12ed2bc1bb30', '7d05b35ef4bd6239b0a7ccdfad90b2923e5283a6e21e669b1797434f2bada957'],
  jumpLand: ['ecd4d0ffbebbeb334f308bc7d94a1abfdabdb18afeaa93d04abb9d1aaa4a014a', '70b6505564a1a48bf3c3963e4c826925da6fd7f5606e12a3aa03142a9bcf7660', '71c3d3d602964db64387f2084f4be9eabbd1b20ec321bc917c22243aecbce79b'],
  dropAir: ['f8cd343eecc753b26252da39bfebefc74f7b5ff0c88eb76ea5db21e370dd6961', '63cc8f73a14b1bb11ba6351cd1f4b64af17386f1c9cd6a5278624fd344c50471', '69ef6e256267a7878f60de7fe0984f0ea218acf90c8dcae0e7731af4f7d16e88'],
  dropLand: ['b63a58bb48990acbc15294d33600fb71e1e4560f0ee5273e3375188c755af87b', '67ae15f9024be99625f7819116fbe64f8079760a0d3b6e28605f6d9ef90935b5', '2a33ddd667669adcacd5fbc02c00feeb0b75109e706758cee110e61dd9481b41'],
  peekTop: ['2ca3daae4a702526da86548b3a0f3a778546d3455475a44a2ff0e3abd73866dd', '7ec03e9ff507653c89a1aef16cb46486d502a1aa180cca42812366f1de766d8a', '3e3368e1910058fd7302abdeb42b7d2ad027fcb0f3047ca9d46497918a5dc270'],
  sideMount: ['7832c73003655142e1a48ca41707ea4f92e23a22652c3a444c5aa62c98017490', 'ef25df3bc080f7228f089c32274488f636943b33ed7b9db001d85dcdadd710ee', 'b539b92125add792012ac9253f900d59d1bd70c41150dd94e869b0fba3ae31cf'],
  sideClimb: ['42bfd6b964e9b8de3d41aa52736249244fdf60c5c4782f58646b07744180ad33', '74120f320bcd9f95f9807e4dd3ccd32fdda94511260ea5c90e33dc1ccfe8a2c5', '8ef5155c4ce937ca20bdaea548eb5e243b818e49ac58939eef0cc2bea2a0529a'],
  sideLedge: ['342d1f32b949558f7c0ada82d1ee949a3c7203f8144789979edea04eca32d4ff', '9d39a17527eb92ac465af025829511a18b7ebceb8744336d962b11b63d2a4fd5', '162acb86b2bf4a057b1a50b227c34cb88780b3521d55a487c88987298f2d4bfb'],
};

describe('動作素材 v1.0 (10 動作・14 コマ・30 枚)', () => {
  const ids = Object.keys(MOTION_CLIPS) as MotionClipId[];

  it('10 動作・合計 14 コマで、時間・基準点・接触点・不透明な範囲の数がコマ数と合う', () => {
    expect(ids).toHaveLength(10);
    expect(ids.reduce((sum, id) => sum + MOTION_CLIPS[id].frameCount, 0)).toBe(14);
    for (const id of ids) {
      const spec = MOTION_CLIPS[id];
      for (const list of [spec.durationsMs, spec.anchors, spec.ground, spec.wall, spec.alpha]) expect(list, id).toHaveLength(spec.frameCount);
      expect(CLIPS[id], id).toBe(spec);
      // 不透明な範囲は 30×20 のセルの中 (全高 20 CSS px を超えない)。
      for (const [l, t, r, b] of spec.alpha) {
        expect(l).toBeGreaterThanOrEqual(0);
        expect(t).toBeGreaterThanOrEqual(0);
        expect(r).toBeLessThanOrEqual(SPRITE.width);
        expect(b).toBeLessThanOrEqual(SPRITE.height);
      }
    }
    // 床に立つコマの基準点は足元の中央、側面のコマは前足の接触点。
    for (const id of ['lookDown', 'jumpPrep', 'jumpAir', 'jumpLand', 'dropAir', 'dropLand', 'peekTop'] as const) {
      for (const anchor of MOTION_CLIPS[id].anchors) expect(anchor).toEqual([15, 20]);
    }
    for (const id of ['sideMount', 'sideClimb', 'sideLedge'] as const) {
      MOTION_CLIPS[id].anchors.forEach((anchor, k) => expect(MOTION_CLIPS[id].wall[k][0]).toEqual(anchor));
    }
    // 横ジャンプの着地は前足 (2 点) → 後ろ足を下ろす (3 点)。飛び降りの着地は四足 (4 点) で、横ジャンプと別のコマ。
    expect(MOTION_CLIPS.jumpLand.ground.map((g) => g.length)).toEqual([2, 3]);
    expect(MOTION_CLIPS.dropLand.ground[0]).toHaveLength(4);
    // sideClimb は 2 コマずつの組 (つかむ・押し上げる) で前足の基準点が同じ。
    const climb = MOTION_CLIPS.sideClimb.anchors;
    expect(climb[0]).toEqual(climb[1]);
    expect(climb[2]).toEqual(climb[3]);
  });

  it('側面の最後のコマ → 上辺の角への持ち替え → 既存の climb の初コマは、原点の変化が横 1.4・縦 2.5 CSS px 以下', () => {
    for (const dir of [-1, 1] as const) {
      // 同じ角 (0, 0) に前足を置いたときのセルの左上。
      const cell = (id: ClipId, frame: number) => {
        const a = clipAnchor(id, frame, dir);
        return { x: -a.x, y: -a.y };
      };
      const chain = [cell('sideClimb', 3), cell('sideLedge', 0), cell('climb', 0)];
      for (let i = 1; i < chain.length; i += 1) {
        expect(Math.abs(chain[i].x - chain[i - 1].x)).toBeLessThanOrEqual(1.4);
        expect(Math.abs(chain[i].y - chain[i - 1].y)).toBeLessThanOrEqual(2.5);
      }
    }
  });

  it('左右反転: 基準点の x は 30 − x、不透明な範囲も左右が入れ替わる', () => {
    expect(clipAnchor('sideMount', 0, -1)).toEqual({ x: 7.67, y: 9.67 });
    expect(clipAnchor('sideMount', 0, 1).x).toBeCloseTo(30 - 7.67, 9);
    expect(clipAlpha('sideClimb', 3, -1)).toEqual({ left: 6, top: 0, right: 26, bottom: 20 });
    expect(clipAlpha('sideClimb', 3, 1)).toEqual({ left: 4, top: 0, right: 24, bottom: 20 });
  });

  it('30 枚とも manifest の大きさ・SHA-256 と一致し (無加工)、画素密度ごとに別の URL', () => {
    let files = 0;
    for (const id of ids) {
      for (const density of [1, 2, 3]) {
        const file = fileURLToPath(new URL(`./assets/v10/${id}@${density}x.png`, import.meta.url));
        expect(pngSize(file), `${id}@${density}x`).toEqual({ width: MOTION_CLIPS[id].frameCount * SPRITE.width * density, height: SPRITE.height * density });
        expect(createHash('sha256').update(readFileSync(file)).digest('hex'), `${id}@${density}x`).toBe(V10_SHA256[id][density - 1]);
        files += 1;
      }
      expect(clipUrlFor(id, 1)).toBeTruthy();
      expect(clipUrlFor(id, 2)).not.toBe(clipUrlFor(id, 1));
      expect(clipUrlFor(id, 3)).not.toBe(clipUrlFor(id, 2));
    }
    expect(files).toBe(30);
  });
});
