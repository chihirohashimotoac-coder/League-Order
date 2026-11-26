/**
 * 画面端からの登場と、足場の間の移動 (横の小ジャンプ・飛び降り・側面のよじ登り) の経路 (純関数)。
 *
 * 経路は「段 (Step)」の並び。各段は描くコマ・セルの左上の位置 (ページ座標, CSS px)・向き・時間と、次の段の位置へ
 * 動く方法 (止まる・直線・放物線・落下) を持つ。同じ並びを、安全の判定 (途中を細かく取って、掃いた範囲が文字・
 * 操作部品などに重ならないか) と再生 (controller) の両方に使うので、確かめた経路と描く経路が食い違わない。
 *
 * - 登場は画面の端 (固定ヘッダー・下部ナビがあればその縁) の向こうから。端の向こうの部分は数えない (描かれない・
 *   固定バーの裏)。下端からは、画面の下へ続くカードの側面をよじ登る。
 * - 候補にしたカード・ボタン自体の箱には、体が少し (decorAllowance) 重なってよい。中の文字・アイコン・入力と、
 *   周りの要素は保護する (障害物の集め方は terrainDom)。
 * - 角丸や隙間は歩ける面としてつながない (terrain.ts)。足場の端が要素の角でなければ、そこから跳ばない・降りない。
 */
import { clamp, type Rng } from './behavior';
import { DEFAULT_MOTION, DEFAULT_TERRAIN, SPRITE, type MotionParams, type TerrainParams } from './params';
import { CLIPS, clipAlpha, clipAnchor, type ClipId } from './sprite';
import type { Rect, Segment } from './terrain';

export type Edge = 'top' | 'bottom' | 'left' | 'right';
export interface View {
  top: number;
  bottom: number;
  left: number;
  right: number;
}

/** 描くコマ: 素材 v0.2 のアトラス (行・列) か、動作のアトラスのコマ。 */
export type Pose = { sheet: 'base'; row: 0 | 1 | 2; column: number } | { sheet: ClipId; frame: number };

/** 次の段の位置へ動く方法。arc は頂点の高さ (CSS px)。fall は横は一定、縦は加速 (t²)。 */
export type Tween = 'hold' | 'linear' | 'fall' | { arc: number };

export interface Step {
  pose: Pose;
  /** この段の始まりのセルの左上 (ページ座標)。 */
  x: number;
  y: number;
  dir: -1 | 1;
  ms: number;
  tween: Tween;
}

export type EntryMode = 'peek' | 'direct' | 'retreat';

export interface MovePlan {
  kind: 'hop' | 'drop' | 'climb' | 'enter';
  edge?: Edge;
  mode?: EntryMode;
  /** 踏み切る位置まで歩く先 (立ち姿のセルの左端 x)。登場では null。 */
  startX: number | null;
  steps: Step[];
  /** 着いた先 (立ち姿のセルの左端 x・足元と足場)。のぞいて引っ込む登場では null。 */
  end: { x: number; top: number; segment: Segment } | null;
  /** 掃く範囲の外接矩形 (障害物を集める範囲)。 */
  bounds: Rect;
  /** 出発・着地・つかまる側面の要素の番号 (MeasuredTerrain.boxes の添字)。 */
  fromBox: number | null;
  toBox: number | null;
  wallBox: number | null;
  /** 経路の長さの目安 (選びやすさ)。 */
  distance: number;
}

const IDLE = { sheet: 'base', row: 0, column: 0 } as const;
const WALK = (column: number): Pose => ({ sheet: 'base', row: 1, column: column % 4 });
const clip = (sheet: ClipId, frame = 0): Pose => ({ sheet, frame });

/** 既存の climb の基準点に対する、前足を角から上辺の内側へ移す量 (素材の治具と同じ割合)。 */
const CLIMB_SHIFT = [0, 0, 0, 3, 10, 16] as const;

// ------------------------------------------------------------------ 位置と範囲

/** 段 i の途中 (t = 0〜1) のセルの左上。 */
export function stepAt(steps: readonly Step[], i: number, t: number): { x: number; y: number } {
  const step = steps[i];
  const next = steps[i + 1];
  if (!next || step.tween === 'hold') return { x: step.x, y: step.y };
  const k = clamp(t, 0, 1);
  const x = step.x + (next.x - step.x) * k;
  if (step.tween === 'linear') return { x, y: step.y + (next.y - step.y) * k };
  if (step.tween === 'fall') return { x, y: step.y + (next.y - step.y) * k * k };
  return { x, y: step.y + (next.y - step.y) * k - 4 * step.tween.arc * k * (1 - k) };
}

/** コマの不透明な範囲 (ページ座標)。 */
export function poseBox(pose: Pose, x: number, y: number, dir: -1 | 1): Rect {
  const a = clipAlpha(pose.sheet === 'base' ? 'base' : pose.sheet, pose.sheet === 'base' ? 0 : pose.frame, dir);
  return { left: x + a.left, top: y + a.top, right: x + a.right, bottom: y + a.bottom };
}

function union(a: Rect, b: Rect): Rect {
  return { left: Math.min(a.left, b.left), top: Math.min(a.top, b.top), right: Math.max(a.right, b.right), bottom: Math.max(a.bottom, b.bottom) };
}

/**
 * 経路の全体を細かく取った、掃いた範囲の並び (隣り合う 2 点の不透明な範囲を包む矩形)。点と点の間の薄い線も
 * 見逃さないよう、4 px ごと (最低 2 点) に取る。
 */
export function sweptBoxes(steps: readonly Step[]): Rect[] {
  const boxes: Rect[] = [];
  for (let i = 0; i < steps.length; i += 1) {
    const step = steps[i];
    const next = steps[i + 1];
    let previous = poseBox(step.pose, step.x, step.y, step.dir);
    boxes.push(previous);
    if (!next || step.tween === 'hold') continue;
    const end = stepAt(steps, i, 1);
    const lift = typeof step.tween === 'object' ? step.tween.arc : 0;
    const n = Math.max(2, Math.ceil((Math.hypot(end.x - step.x, end.y - step.y) + lift * 2) / 4));
    for (let k = 1; k <= n; k += 1) {
      const p = stepAt(steps, i, k / n);
      const box = poseBox(step.pose, p.x, p.y, step.dir);
      boxes.push(union(previous, box));
      previous = box;
    }
  }
  return boxes;
}

export function boundsOf(boxes: readonly Rect[]): Rect {
  return boxes.reduce(union);
}

function overlaps(a: Rect, b: Rect): boolean {
  return a.right > b.left + 0.5 && a.left < b.right - 0.5 && a.bottom > b.top + 0.5 && a.top < b.bottom - 0.5;
}

export interface ClearOptions {
  view: View;
  /** この端の向こう (画面の外・固定バーの裏) へ出た部分は数えない (登場の経路)。 */
  beyond?: Edge;
  /** 左右の端から外へ出てよい幅 (側面のよじ登り。出た部分は描かれない)。 */
  overhang?: number;
  /** 文書の下端。セルをここより下へ置かない (スクロールできる範囲を広げない)。 */
  docBottom?: number;
  /** 体が重なってよい、候補の要素自身の箱 (この幅だけ内側へ縮めて数える)。 */
  selfBoxes?: readonly Rect[];
  decor?: number;
}

/** 障害物のうち、候補の要素自身の箱を decor だけ内側へ縮める (背景・枠への軽いかぶりを許す)。 */
export function allowSelf(obstacles: readonly Rect[], selfBoxes: readonly Rect[] = [], decor = 0): Rect[] {
  if (selfBoxes.length === 0 || decor <= 0) return [...obstacles];
  const same = (a: Rect, b: Rect): boolean =>
    Math.abs(a.left - b.left) <= 1 && Math.abs(a.right - b.right) <= 1 && Math.abs(a.top - b.top) <= 1 && Math.abs(a.bottom - b.bottom) <= 1;
  return obstacles.map((o) => (selfBoxes.some((s) => same(s, o)) ? { left: o.left + decor, top: o.top, right: o.right - decor, bottom: o.bottom - decor } : o));
}

/** 経路の全体が、見えている範囲に収まり (登場の端の向こう・左右の出てよい幅を除く)、障害物に重ならないか。 */
export function stepsAreClear(steps: readonly Step[], obstacles: readonly Rect[], options: ClearOptions): boolean {
  const { view, beyond, overhang = 0, docBottom } = options;
  const list = allowSelf(obstacles, options.selfBoxes, options.decor);
  if (docBottom !== undefined && steps.some((s) => s.y + SPRITE.height > docBottom + 0.5)) return false;
  for (const raw of sweptBoxes(steps)) {
    const box = { ...raw };
    // 登場の端の向こうに出た部分は描かれない (画面の外・固定バーの裏): 見えている部分だけを確かめる。
    if (beyond === 'left') box.left = Math.max(box.left, view.left);
    if (beyond === 'right') box.right = Math.min(box.right, view.right);
    if (beyond === 'top') box.top = Math.max(box.top, view.top);
    if (beyond === 'bottom') box.bottom = Math.min(box.bottom, view.bottom);
    if (box.right <= box.left + 0.5 || box.bottom <= box.top + 0.5) continue;
    if (box.top < view.top - 0.5 || box.bottom > view.bottom + 0.5) return false;
    if (box.left < view.left - overhang - 0.5 || box.right > view.right + overhang + 0.5) return false;
    if (list.some((o) => overlaps(box, o))) return false;
  }
  return true;
}

/** 経路の周りの余裕 (0・2・4・8 px のうち、障害物を膨らませても重ならない最大)。余裕のある経路を選びやすくする。 */
export function stepsMargin(steps: readonly Step[], obstacles: readonly Rect[], options: ClearOptions): number {
  let margin = 0;
  for (const d of [2, 4, 8]) {
    const grown = obstacles.map((o) => ({ left: o.left - d, top: o.top - d, right: o.right + d, bottom: o.bottom + d }));
    const selfBoxes = options.selfBoxes?.map((o) => ({ left: o.left - d, top: o.top - d, right: o.right + d, bottom: o.bottom + d }));
    if (!stepsAreClear(steps, grown, { ...options, selfBoxes, decor: (options.decor ?? 0) + d })) break;
    margin = d;
  }
  return margin;
}

// ------------------------------------------------------------------ 足場と要素の対応

/** 足場の端 (side) が、ある要素の角 (角丸の手前) にあるとき、その要素の番号。文字などで切れた端なら null。 */
export function endBox(segment: Segment, boxes: readonly Rect[], side: 'left' | 'right', params: TerrainParams = DEFAULT_TERRAIN): number | null {
  for (let i = 0; i < boxes.length; i += 1) {
    const box = boxes[i];
    if (Math.abs(box.top - segment.top) > params.rowTolerance + 0.5) continue;
    const edge = side === 'right' ? box.right - params.cornerInset : box.left + params.cornerInset;
    if (Math.abs((side === 'right' ? segment.right : segment.left) - edge) <= 1) return i;
  }
  return null;
}

/** 要素の上辺の足場 (高さが同じで、要素の横の範囲の中)。 */
function boxOfSegment(segment: Segment, boxes: readonly Rect[], params: TerrainParams = DEFAULT_TERRAIN): number | null {
  for (let i = 0; i < boxes.length; i += 1) {
    const box = boxes[i];
    if (Math.abs(box.top - segment.top) <= params.rowTolerance + 0.5 && box.left <= segment.left + 0.5 && box.right >= segment.right - 0.5) return i;
  }
  return null;
}

// ------------------------------------------------------------------ 横の小ジャンプ・飛び降り

/** 着地点の候補 (着地先の立てる範囲の近い端から、調整幅ずつ内側)。 */
function landings(target: Segment, dir: -1 | 1, insets: readonly number[]): number[] {
  const xs: number[] = [];
  for (const k of insets) {
    const x = dir > 0 ? target.minX + k : target.maxX - k;
    if (x >= target.minX - 0.01 && x <= target.maxX + 0.01 && !xs.some((v) => Math.abs(v - x) < 1)) xs.push(x);
  }
  if (xs.length === 0) xs.push((target.minX + target.maxX) / 2);
  return xs;
}

/** 横の小ジャンプの弧の高さ (隙間が狭いほど低く、広いほど高く)。 */
export function hopArcHeight(gap: number, motion: MotionParams = DEFAULT_MOTION): number {
  return clamp(motion.hopArc.base + Math.max(0, gap) * motion.hopArc.perPx, motion.hopArc.min, motion.hopArc.max);
}

/**
 * 横の小ジャンプ: 隣の縁に目を向け (待機)、体を低くして (jumpPrep)、弧を描いて (jumpAir) 隣の上辺へ。前足 (jumpLand 0)、
 * 後ろ足 (jumpLand 1) の順に着地する。着地してからは横に動かない (前足の接地のあとに滑らない)。
 */
export function hopSteps(from: { x: number; top: number }, to: { x: number; top: number }, arc: number, motion: MotionParams = DEFAULT_MOTION): Step[] {
  const dir: -1 | 1 = to.x > from.x ? 1 : -1;
  const flight = Math.max(motion.flightMinMs, Math.abs(to.x - from.x) * motion.flightMsPerPx);
  const y0 = from.top - SPRITE.height;
  const y1 = to.top - SPRITE.height;
  return [
    { pose: IDLE, x: from.x, y: y0, dir, ms: 160, tween: 'hold' },
    { pose: clip('jumpPrep'), x: from.x, y: y0, dir, ms: CLIPS.jumpPrep.durationsMs[0], tween: 'hold' },
    { pose: clip('jumpAir'), x: from.x, y: y0, dir, ms: flight, tween: { arc } },
    { pose: clip('jumpLand', 0), x: to.x, y: y1, dir, ms: CLIPS.jumpLand.durationsMs[0], tween: 'hold' },
    { pose: clip('jumpLand', 1), x: to.x, y: y1, dir, ms: CLIPS.jumpLand.durationsMs[1], tween: 'hold' },
    { pose: IDLE, x: to.x, y: y1, dir, ms: 0, tween: 'hold' },
  ];
}

/** 同じ高さ (flatTolerance 以内) の隣の足場への小ジャンプの候補。足場の端が要素の角にあるときだけ。 */
export function hopPlans(
  current: Segment,
  segments: readonly Segment[],
  boxes: readonly Rect[],
  terrain: TerrainParams = DEFAULT_TERRAIN,
  motion: MotionParams = DEFAULT_MOTION,
): MovePlan[] {
  const plans: MovePlan[] = [];
  for (const target of segments) {
    if (target === current || (target.top === current.top && target.minX === current.minX && target.maxX === current.maxX)) continue;
    if (Math.abs(target.top - current.top) > motion.flatTolerance) continue;
    for (const dir of [1, -1] as const) {
      const ahead = dir > 0 ? target.minX > current.maxX : target.maxX < current.minX;
      if (!ahead) continue;
      const fromBox = endBox(current, boxes, dir > 0 ? 'right' : 'left', terrain);
      const toBox = endBox(target, boxes, dir > 0 ? 'left' : 'right', terrain);
      if (fromBox === null || toBox === null) continue;
      // 要素どうしの隙間 (角丸を含まない、実際の隙間)。
      const gap = dir > 0 ? boxes[toBox].left - boxes[fromBox].right : boxes[fromBox].left - boxes[toBox].right;
      const reach = dir > 0 ? target.left - current.right : current.left - target.right;
      if (reach > terrain.jumpMaxGap || reach < 4) continue;
      const arc = hopArcHeight(gap, motion);
      const fromX = dir > 0 ? current.maxX : current.minX;
      for (const x of landings(target, dir, motion.landingInsets)) {
        const steps = hopSteps({ x: fromX, top: current.top }, { x, top: target.top }, arc, motion);
        plans.push({
          kind: 'hop', startX: fromX, steps, end: { x, top: target.top, segment: target }, bounds: boundsOf(sweptBoxes(steps)),
          fromBox, toBox, wallBox: null, distance: Math.abs(x - fromX),
        });
      }
    }
  }
  return plans;
}

/** 落ちる時間 (ms)。 */
export function fallMs(height: number, motion: MotionParams = DEFAULT_MOTION): number {
  return Math.max(120, Math.sqrt((2 * Math.max(0, height)) / motion.gravity) * 1000);
}

/**
 * 飛び降り: 縁から下をのぞき (lookDown)、前足を先に出して縁を離れ (dropAir、元の要素の横へ出るまで)、落ちて (dropAir)、
 * 四足で受け止めて沈む (dropLand)。
 */
export function dropSteps(from: { x: number; top: number }, clearX: number, to: { x: number; top: number }, motion: MotionParams = DEFAULT_MOTION): Step[] {
  const dir: -1 | 1 = to.x >= from.x ? 1 : -1;
  const y0 = from.top - SPRITE.height;
  const y1 = to.top - SPRITE.height;
  const stepOff = Math.max(80, Math.abs(clearX - from.x) * motion.flightMsPerPx);
  return [
    { pose: IDLE, x: from.x, y: y0, dir, ms: 140, tween: 'hold' },
    { pose: clip('lookDown'), x: from.x, y: y0, dir, ms: CLIPS.lookDown.durationsMs[0], tween: 'hold' },
    { pose: clip('dropAir'), x: from.x, y: y0, dir, ms: stepOff, tween: { arc: 3 } },
    { pose: clip('dropAir'), x: clearX, y: y0, dir, ms: fallMs(y1 - y0, motion), tween: 'fall' },
    { pose: clip('dropLand'), x: to.x, y: y1, dir, ms: CLIPS.dropLand.durationsMs[0], tween: 'hold' },
    { pose: IDLE, x: to.x, y: y1, dir, ms: 0, tween: 'hold' },
  ];
}

/** 低い足場への飛び降りの候補。縁が要素の角にあり、その要素の横へ出てから落ちる。 */
export function dropPlans(
  current: Segment,
  segments: readonly Segment[],
  boxes: readonly Rect[],
  terrain: TerrainParams = DEFAULT_TERRAIN,
  motion: MotionParams = DEFAULT_MOTION,
): MovePlan[] {
  const plans: MovePlan[] = [];
  const air = clipAlpha('dropAir', 0, 1);
  const airLeft = clipAlpha('dropAir', 0, -1);
  for (const target of segments) {
    const height = target.top - current.top;
    if (height <= motion.flatTolerance || height > motion.dropMax) continue;
    for (const dir of [1, -1] as const) {
      const fromBox = endBox(current, boxes, dir > 0 ? 'right' : 'left', terrain);
      if (fromBox === null) continue;
      const box = boxes[fromBox];
      // 元の要素の横へ出る位置 (そこから下へ落ちても、元の要素の面に重ならない)。
      const clearX = dir > 0 ? box.right - air.left - motion.decorAllowance + 1 : box.left - airLeft.right + motion.decorAllowance - 1;
      const fromX = dir > 0 ? current.maxX : current.minX;
      if ((clearX - fromX) * dir < 0) continue;
      const near = dir > 0 ? Math.max(clearX, target.minX) : Math.min(clearX, target.maxX);
      const far = dir > 0 ? Math.min(clearX + motion.dropMaxReach, target.maxX) : Math.max(clearX - motion.dropMaxReach, target.minX);
      if ((far - near) * dir < 0) continue;
      const toBox = boxOfSegment(target, boxes, terrain);
      const xs = [0, ...motion.landingInsets].map((k) => near + dir * k).filter((x) => (far - x) * dir >= -0.01);
      for (const x of xs) {
        const steps = dropSteps({ x: fromX, top: current.top }, clearX, { x, top: target.top }, motion);
        plans.push({
          kind: 'drop', startX: fromX, steps, end: { x, top: target.top, segment: target }, bounds: boundsOf(sweptBoxes(steps)),
          fromBox, toBox, wallBox: null, distance: Math.abs(x - fromX) + height,
        });
      }
    }
  }
  return plans;
}

// ------------------------------------------------------------------ 側面のよじ登り

/** 側面の動作の基準点を、壁の線の上の掴む点 (gx, gy) に合わせたセルの左上。 */
function grip(id: ClipId, frame: number, gx: number, gy: number, dir: -1 | 1): { x: number; y: number } {
  const a = clipAnchor(id, frame, dir);
  return { x: gx - a.x, y: gy - a.y };
}

/**
 * 側面に前足をかけ (sideMount)、前足でつかんで後ろ足で押し上げる組を繰り返し (sideClimb。組の 2 コマは同じ前足の
 * 位置、次の組で掴む高さを上げる)、上辺の角へ前足を持ち替え (sideLedge)、既存の climb で上辺に乗る。
 * climb の前半は同じ角で前足を支え、後半は胴・後ろ足を上辺の内側へ移す。最後のコマの位置で待機に戻る。
 * @param face 側面の x (壁の線)。dir = -1 なら壁は体の左 (要素の右の側面)、1 なら右 (要素の左の側面)。
 * @param mountY 最初に前足をかける高さ。topY 要素の上辺。finalX 上辺に乗ったあとの立ち姿のセルの左端の目安。
 */
export function climbSteps(face: number, mountY: number, topY: number, dir: -1 | 1, finalX: number, motion: MotionParams = DEFAULT_MOTION): Step[] {
  const steps: Step[] = [];
  const m = grip('sideMount', 0, face, mountY, dir);
  steps.push({ pose: clip('sideMount'), x: m.x, y: m.y, dir, ms: CLIPS.sideMount.durationsMs[0], tween: 'hold' });
  const first = mountY - 2;
  const span = Math.max(0, first - topY);
  const pairs = Math.max(1, Math.round(span / motion.climbStep) + 1);
  const pitch = pairs > 1 ? span / (pairs - 1) : 0;
  for (let k = 0; k < pairs; k += 1) {
    const gy = first - pitch * k;
    const a = (k % 2) * 2;
    for (const frame of [a, a + 1]) {
      const p = grip('sideClimb', frame, face, gy, dir);
      steps.push({ pose: clip('sideClimb', frame), x: p.x, y: p.y, dir, ms: CLIPS.sideClimb.durationsMs[frame], tween: 'hold' });
    }
  }
  const l = grip('sideLedge', 0, face, topY, dir);
  steps.push({ pose: clip('sideLedge'), x: l.x, y: l.y, dir, ms: CLIPS.sideLedge.durationsMs[0], tween: 'hold' });
  // 既存の climb: 最後のコマ (基準点 9.7, 20) の位置が finalX になるよう、前足を内側へ移す量を決める (治具の 1〜1.5 倍)。
  const lastAnchor = clipAnchor('climb', CLIMB_SHIFT.length - 1, dir).x;
  const want = dir < 0 ? face - lastAnchor - finalX : finalX + lastAnchor - face;
  const scale = clamp(want / CLIMB_SHIFT[CLIMB_SHIFT.length - 1], 1, 1.5);
  for (let frame = 0; frame < CLIMB_SHIFT.length; frame += 1) {
    const gx = face + dir * CLIMB_SHIFT[frame] * scale;
    const p = grip('climb', frame, gx, topY, dir);
    steps.push({ pose: clip('climb', frame), x: p.x, y: p.y, dir, ms: CLIPS.climb.durationsMs[frame], tween: 'hold' });
  }
  const last = steps[steps.length - 1];
  steps.push({ pose: IDLE, x: last.x, y: topY - SPRITE.height, dir, ms: 0, tween: 'hold' });
  return steps;
}

/** よじ登ったあと、立ち姿が着いた先の立てる範囲に収まらなければ、その範囲まで歩く段を足す。 */
function settleOn(steps: Step[], target: Segment, walkSpeed: number, frameMs: number): { steps: Step[]; x: number } {
  const last = steps[steps.length - 1];
  const x = clamp(last.x, target.minX, target.maxX);
  if (Math.abs(x - last.x) < 0.5) return { steps, x: last.x };
  const dir: -1 | 1 = x > last.x ? 1 : -1;
  const out = steps.slice(0, -1);
  const distance = Math.abs(x - last.x);
  const n = Math.max(1, Math.ceil((distance / walkSpeed) * 1000 / frameMs));
  for (let k = 0; k < n; k += 1) out.push({ pose: WALK(k), x: last.x + ((x - last.x) * k) / n, y: last.y, dir, ms: frameMs, tween: 'linear' });
  out.push({ pose: IDLE, x, y: last.y, dir, ms: 0, tween: 'hold' });
  return { steps: out, x };
}

export interface Wall {
  /** 側面の x と、どちらの側面か (right = 要素の右の側面。体は右側にあり、左を向いて登る)。 */
  face: number;
  side: 'left' | 'right';
  box: number;
  /** 上辺の足場 (角まで届くもの)。 */
  target: Segment;
}

/** 上辺の足場が角まで届いている要素の側面 (よじ登ったあと、上辺に乗れる側面)。 */
export function wallsOf(segments: readonly Segment[], boxes: readonly Rect[], terrain: TerrainParams = DEFAULT_TERRAIN): Wall[] {
  const walls: Wall[] = [];
  for (const target of segments) {
    for (const side of ['left', 'right'] as const) {
      const box = endBox(target, boxes, side, terrain);
      if (box === null) continue;
      walls.push({ face: side === 'right' ? boxes[box].right : boxes[box].left, side, box, target });
    }
  }
  return walls;
}

/**
 * 高い足場へ、いまの足場の端から側面をよじ登る候補。いまの足場がその要素の側面のすぐ横で切れていて (要素そのものに
 * ふさがれて)、側面が前足をかける高さまで下へ続いていること。旧来の上向きのジャンプの代わり。
 */
export function climbPlans(
  current: Segment,
  segments: readonly Segment[],
  boxes: readonly Rect[],
  terrain: TerrainParams = DEFAULT_TERRAIN,
  motion: MotionParams = DEFAULT_MOTION,
  walk: { speed: number; frameMs: number } = { speed: 20, frameMs: 170 },
): MovePlan[] {
  const plans: MovePlan[] = [];
  for (const wall of wallsOf(segments, boxes, terrain)) {
    const box = boxes[wall.box];
    const rise = current.top - box.top;
    if (rise < motion.climbMinRise || rise > motion.climbMaxRise) continue;
    const mountY = current.top - SPRITE.height;
    if (box.bottom < mountY + 2) continue;
    const dir: -1 | 1 = wall.side === 'right' ? -1 : 1;
    // 立ち位置: 側面のすぐ横 (いまの足場の、側面の側の端)。
    const standX = dir < 0 ? current.minX : current.maxX;
    const near = dir < 0 ? standX - wall.face : wall.face - (standX + SPRITE.width);
    if (near < -3 || near > 10) continue;
    const finalX = dir < 0 ? wall.target.maxX : wall.target.minX;
    const y = current.top - SPRITE.height;
    // 側面に目を向けて、1 歩 (3 px) 寄ってから前足をかける。
    const approach: Step[] = [
      { pose: IDLE, x: standX, y, dir, ms: 150, tween: 'hold' },
      { pose: WALK(1), x: standX, y, dir, ms: 85, tween: 'linear' },
      { pose: WALK(1), x: standX + dir * 3, y, dir, ms: 0, tween: 'hold' },
    ];
    const climb = climbSteps(wall.face, mountY, box.top, dir, finalX, motion);
    const settled = settleOn([...approach, ...climb], wall.target, walk.speed, walk.frameMs);
    plans.push({
      kind: 'climb', startX: standX, steps: settled.steps, end: { x: settled.x, top: box.top, segment: wall.target },
      bounds: boundsOf(sweptBoxes(settled.steps)), fromBox: boxOfSegment(current, boxes, terrain), toBox: wall.box, wallBox: wall.box, distance: rise + Math.abs(settled.x - standX),
    });
  }
  return plans;
}

// ------------------------------------------------------------------ 画面端からの登場

export interface EntryOptions {
  /** のぞいてから入る (peek) か、立ち止まらずに入る (direct) か。引っ込む経路は retreatOf で peek から作る。 */
  mode: 'peek' | 'direct';
  /** のぞいている時間 (mode = peek / retreat)。 */
  holdMs: number;
  /** 上端から入るときの向き。 */
  dir?: -1 | 1;
  /** 文書の下端 (下端から入るとき、セルをこれより下に置かない)。 */
  docBottom?: number;
  walk?: { speed: number; frameMs: number };
}

/**
 * 足場の立てる範囲が画面の端からこの距離以内なら、端まで続いているとみなして歩いて入る (計測は画面の左右 4 px を
 * 立てる範囲から除くため)。
 */
const EDGE_WALK_GAP = 5;
/** のぞく 3 つの位置 (隠れている・耳の先・耳と目)。左右の端では、端からセルの見える幅 0 (−1)・6・12 px。 */
const PEEK_SIDE = [-1, 6, 12] as const;
/** 上端: セルの上端を端から −21・−16・−11・−6 px (頭から見せる)。 */
const PEEK_TOP = [-21, -16, -11, -6] as const;
/** 下端: セルの上端を端から +1・−5・−12・−20 px。 */
const PEEK_BOTTOM = [1, -5, -12, -20] as const;

/** 左右の端から入る経路。立てる範囲が端に届いていれば歩いて、隙間があれば端から小さく跳んで入る。 */
function sideEntry(edge: 'left' | 'right', target: Segment, view: View, landX: number, options: EntryOptions, motion: MotionParams, box?: Rect): Step[] {
  const dir: -1 | 1 = edge === 'left' ? 1 : -1;
  const y = target.top - SPRITE.height;
  const at = (visible: number): number => (edge === 'left' ? view.left - SPRITE.width + visible : view.right - visible);
  const steps: Step[] = [
    { pose: IDLE, x: at(PEEK_SIDE[0]), y, dir, ms: 100, tween: 'linear' },
    { pose: IDLE, x: at(PEEK_SIDE[1]), y, dir, ms: 75, tween: 'linear' },
  ];
  const gap = edge === 'left' ? target.left - view.left : view.right - target.right;
  // 要素そのものが画面の端まで (またはその外まで) 続いているときだけ歩いて入る (立てる範囲の端の数 px は計測で除いた余白)。
  const reaches = box !== undefined && (edge === 'left' ? box.left <= view.left + 1 : box.right >= view.right - 1);
  const fromX = at(PEEK_SIDE[2]);
  if (options.mode === 'peek') steps.push({ pose: IDLE, x: fromX, y, dir, ms: options.holdMs, tween: 'hold' });
  if (gap <= EDGE_WALK_GAP && reaches) {
    // 足場が端まで続いている: 歩いて入る。
    const walk = options.walk ?? { speed: 20, frameMs: 170 };
    const distance = Math.abs(landX - fromX);
    const n = Math.max(1, Math.ceil((distance / walk.speed) * 1000 / walk.frameMs));
    for (let k = 0; k < n; k += 1) steps.push({ pose: WALK(k), x: fromX + ((landX - fromX) * k) / n, y, dir, ms: walk.frameMs, tween: 'linear' });
    steps.push({ pose: IDLE, x: landX, y, dir, ms: 0, tween: 'hold' });
    return steps;
  }
  // 端と足場の間に隙間がある: 端の向こうから小さく跳んで入る (足は端の向こうに隠れたまま踏み切る)。
  const arc = hopArcHeight(gap, motion);
  const hop = hopSteps({ x: fromX, top: target.top }, { x: landX, top: target.top }, arc, motion);
  // 待機で縁を見る段は、のぞく段で済んでいる。立ち止まらず入るときは踏み切りの構えも省く。
  return [...steps, ...hop.slice(options.mode === 'direct' ? 2 : 1)];
}

/** 上端から入る経路: 頭から見せて (peekTop)、落ちて (dropAir)、四足で受け止める (dropLand)。 */
function topEntry(target: Segment, view: View, x: number, options: EntryOptions, motion: MotionParams): Step[] {
  const dir = options.dir ?? -1;
  const at = (dy: number): number => view.top + dy;
  const peek = clip('peekTop');
  const y1 = target.top - SPRITE.height;
  const steps: Step[] = [
    { pose: peek, x, y: at(PEEK_TOP[0]), dir, ms: 120, tween: 'linear' },
    { pose: peek, x, y: at(PEEK_TOP[1]), dir, ms: 80, tween: 'linear' },
  ];
  if (options.mode === 'peek') steps.push({ pose: peek, x, y: at(PEEK_TOP[2]), dir, ms: options.holdMs, tween: 'hold' });
  steps.push({ pose: peek, x, y: at(PEEK_TOP[2]), dir, ms: 85, tween: 'linear' });
  steps.push({ pose: clip('dropAir'), x, y: at(PEEK_TOP[3]), dir, ms: fallMs(y1 - at(PEEK_TOP[3]), motion), tween: 'fall' });
  steps.push({ pose: clip('dropLand'), x, y: y1, dir, ms: CLIPS.dropLand.durationsMs[0], tween: 'hold' });
  steps.push({ pose: IDLE, x, y: y1, dir, ms: 0, tween: 'hold' });
  return steps;
}

/** 下端から入る経路: 側面の横で耳と目から見せ (待機)、側面に前足をかけてよじ登り、上辺に乗る。 */
function bottomEntry(wall: Wall, box: Rect, view: View, options: EntryOptions, motion: MotionParams): Step[] {
  const dir: -1 | 1 = wall.side === 'right' ? -1 : 1;
  // 待機の姿の不透明な部分が、側面から 2 px だけ壁の側に入る位置 (壁の枠への軽いかぶり)。
  const x = dir < 0 ? wall.face - 4 : wall.face - SPRITE.width + 4;
  const at = (dy: number): number => view.bottom + dy;
  const rise: Step[] = [
    { pose: IDLE, x, y: at(PEEK_BOTTOM[0]), dir, ms: 120, tween: 'linear' },
    { pose: IDLE, x, y: at(PEEK_BOTTOM[1]), dir, ms: 80, tween: 'linear' },
  ];
  if (options.mode === 'peek') rise.push({ pose: IDLE, x, y: at(PEEK_BOTTOM[2]), dir, ms: options.holdMs, tween: 'hold' });
  rise.push({ pose: IDLE, x, y: at(PEEK_BOTTOM[2]), dir, ms: 80, tween: 'linear' });
  rise.push({ pose: IDLE, x, y: at(PEEK_BOTTOM[3]), dir, ms: 60, tween: 'hold' });
  const finalX = dir < 0 ? wall.target.maxX : wall.target.minX;
  const climb = climbSteps(wall.face, view.bottom - SPRITE.height + 1, box.top, dir, finalX, motion);
  return settleOn([...rise, ...climb], wall.target, options.walk?.speed ?? 20, options.walk?.frameMs ?? 170).steps;
}

/**
 * 端 edge から入る経路の候補 (安全はまだ確かめない)。左右・上は見えている足場、下は画面の下へ続く要素の側面。
 * 引っ込む (retreat) 経路は端の近くだけを通り、着いた先を持たない。
 */
export function entryPlans(
  edge: Edge,
  segments: readonly Segment[],
  boxes: readonly Rect[],
  view: View,
  options: EntryOptions,
  terrain: TerrainParams = DEFAULT_TERRAIN,
  motion: MotionParams = DEFAULT_MOTION,
): MovePlan[] {
  const plans: MovePlan[] = [];
  const make = (steps: Step[], target: Segment, toBox: number | null, wallBox: number | null, distance: number): MovePlan => {
    const last = steps[steps.length - 1];
    return {
      kind: 'enter', edge, mode: options.mode, startX: null, steps,
      end: { x: last.x, top: target.top, segment: target },
      bounds: boundsOf(sweptBoxes(steps)), fromBox: null, toBox, wallBox, distance,
    };
  };
  if (edge === 'left' || edge === 'right') {
    for (const target of segments) {
      if (target.top - SPRITE.height < view.top || target.top > view.bottom) continue;
      const gap = edge === 'left' ? target.left - view.left : view.right - target.right;
      if (gap > motion.entryMaxGap || gap < -SPRITE.width) continue;
      const dir: -1 | 1 = edge === 'left' ? 1 : -1;
      const toBox = endBox(target, boxes, edge, terrain);
      // 隙間を跳ぶときは、足場の端が要素の角であること (角の手前の文字などをまたがない)。
      if (gap > EDGE_WALK_GAP && toBox === null) continue;
      const under = boxOfSegment(target, boxes, terrain);
      for (const x of landings(target, dir, motion.landingInsets)) {
        const steps = sideEntry(edge, target, view, x, options, motion, under !== null ? boxes[under] : undefined);
        plans.push(make(steps, target, toBox ?? boxOfSegment(target, boxes, terrain), null, Math.max(0, gap) + Math.abs(x - (dir > 0 ? target.minX : target.maxX))));
      }
    }
    return plans;
  }
  if (edge === 'top') {
    for (const target of segments) {
      if (target.top - SPRITE.height < view.top || target.top > view.bottom) continue;
      const height = target.top - view.top;
      if (height > motion.entryMaxDrop) continue;
      const span = target.maxX - target.minX;
      const xs = [0.5, 0.25, 0.75, 0, 1].map((f) => target.minX + span * f);
      for (const x of xs) {
        const steps = topEntry(target, view, x, options, motion);
        plans.push(make(steps, target, boxOfSegment(target, boxes, terrain), null, height));
      }
    }
    return plans;
  }
  for (const wall of wallsOf(segments, boxes, terrain)) {
    const box = boxes[wall.box];
    if (box.bottom < view.bottom || box.top - SPRITE.height < view.top) continue;
    const height = view.bottom - box.top;
    if (height > motion.entryMaxClimb || height < motion.climbMinRise) continue;
    const steps = bottomEntry(wall, box, view, options, motion);
    plans.push(make(steps, wall.target, wall.box, wall.box, height));
  }
  return plans;
}

/**
 * のぞいて入る経路 (peek) から、のぞいたあと同じ端の外へ引っ込む経路を作る。のぞく位置まで (見えるのは端の近くだけ)
 * は同じで、そこから来た道を戻る。着いた先は持たない。
 */
export function retreatOf(plan: MovePlan): MovePlan {
  const steps = plan.steps;
  const hold = steps.findIndex((s) => s.tween === 'hold');
  const h = hold > 0 ? hold : 0;
  const out: Step[] = steps.slice(0, h + 1).map((s) => ({ ...s }));
  out.push({ ...steps[h], ms: 85, tween: 'linear' });
  for (let i = h - 1; i >= 0; i -= 1) out.push({ ...steps[i], ms: i === 0 ? 0 : Math.max(85, steps[i].ms), tween: i === 0 ? 'hold' : 'linear' });
  return { ...plan, mode: 'retreat', steps: out, end: null, bounds: boundsOf(sweptBoxes(out)) };
}

// ------------------------------------------------------------------ 選び方

/**
 * 安全な候補から 1 つ選ぶ。余裕 (margin) のある経路・近い経路ほど選ばれやすく、直前に渡った 2 つの要素の間の経路は
 * penalty を掛ける。
 */
export function pickPlan<T extends { plan: MovePlan; margin: number; penalty: number }>(rng: Rng, options: readonly T[]): T | null {
  const weights = options.map((o) => ((1 + o.margin) / (1 + o.plan.distance / 120)) * o.penalty);
  const total = weights.reduce((sum, w) => sum + w, 0);
  if (!(total > 0)) return null;
  let roll = rng() * total;
  for (let i = 0; i < options.length; i += 1) {
    roll -= weights[i];
    if (roll < 0) return options[i];
  }
  return options[options.length - 1];
}
