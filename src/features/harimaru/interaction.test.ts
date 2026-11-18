import { describe, expect, it } from 'vitest';
import { classifyGesture, cursorReaction, reactionFor, recentTimes, touchZone, type Gesture } from './interaction';
import { DEFAULT_INTERACTION as P } from './params';

const tap: Gesture = { durationMs: 120, maxMove: 2, pointers: 1, cancelled: false, secondaryButton: false, onControl: false, selectedText: false };
const always = () => 0;
const never = () => 0.999;

describe('classifyGesture (短いタップ・クリックだけを採用する)', () => {
  it('短いタップは採用', () => {
    expect(classifyGesture(tap)).toBeNull();
  });
  it('長押し・スワイプ・複数の指・キャンセル・右クリック・操作部品・文字の選択は採用しない', () => {
    expect(classifyGesture({ ...tap, durationMs: P.tapMaxMs + 1 })).toBe('long');
    expect(classifyGesture({ ...tap, maxMove: P.tapMaxMove + 1 })).toBe('moved');
    expect(classifyGesture({ ...tap, pointers: 2 })).toBe('multi');
    expect(classifyGesture({ ...tap, cancelled: true })).toBe('cancelled');
    expect(classifyGesture({ ...tap, secondaryButton: true })).toBe('button');
    expect(classifyGesture({ ...tap, onControl: true })).toBe('control');
    expect(classifyGesture({ ...tap, selectedText: true })).toBe('selection');
  });
  it('境界値: ちょうど上限は採用', () => {
    expect(classifyGesture({ ...tap, durationMs: P.tapMaxMs, maxMove: P.tapMaxMove })).toBeNull();
  });
});

describe('touchZone (体のどこに触れたか)', () => {
  // 表示枠 x 100〜130、見える部分 102〜128、足元 200 (上端 180)。
  const left = { x: 100, top: 200, dir: -1 as const };
  const right = { x: 100, top: 200, dir: 1 as const };
  it('左向きなら左側が顔、右側が背中・しっぽ。右向きなら逆', () => {
    expect(touchZone({ x: 104, y: 190 }, left)).toBe('face');
    expect(touchZone({ x: 125, y: 190 }, left)).toBe('back');
    expect(touchZone({ x: 125, y: 190 }, right)).toBe('face');
    expect(touchZone({ x: 104, y: 190 }, right)).toBe('back');
  });
  it('しっぽ側の外すぐは背後、顔側の外すぐは背後ではない', () => {
    expect(touchZone({ x: 140, y: 190 }, left)).toBe('behind');
    expect(touchZone({ x: 88, y: 190 }, right)).toBe('behind');
    expect(touchZone({ x: 88, y: 190 }, left)).toBe('near');
  });
  it('足元の段の近くは「近く」、遠く・縦に離れた場所は対象外', () => {
    expect(touchZone({ x: 250, y: 195 }, left)).toBe('near');
    expect(touchZone({ x: 100 + 15 + P.approachRange + 1, y: 195 }, left)).toBeNull();
    expect(touchZone({ x: 110, y: 300 }, left)).toBeNull();
  });
});

describe('reactionFor', () => {
  it('顔は喜ぶ、背中・しっぽは振り向く、背後は驚く', () => {
    expect(reactionFor('face', 1, always)).toBe('happy');
    expect(reactionFor('back', 1, always)).toBe('turn');
    expect(reactionFor('behind', 1, always)).toBe('surprise');
  });
  it(`${P.fleeWindowMs}ms 以内に ${P.fleeTouches} 回触られると逃げる`, () => {
    expect(reactionFor('face', P.fleeTouches - 1, always)).toBe('happy');
    expect(reactionFor('face', P.fleeTouches, always)).toBe('flee');
    expect(reactionFor('back', P.fleeTouches, always)).toBe('flee');
  });
  it('近くのタップには気まぐれに近づく', () => {
    expect(reactionFor('near', 0, always)).toBe('approach');
    expect(reactionFor('near', 0, never)).toBeNull();
    expect(reactionFor(null, 0, always)).toBeNull();
  });
  it('recentTimes は古い接触を捨てる', () => {
    expect(recentTimes([0, 1_000, 4_000], 6_000, 5_000)).toEqual([1_000, 4_000]);
  });
});

describe('cursorReaction (PC のカーソル)', () => {
  const all = () => true;
  const none = () => false;
  it('遠いカーソル・動いているカーソルには反応しない', () => {
    expect(cursorReaction({ distance: P.cursorNear * 2 + 1, stillMs: 5_000, speed: 0, available: all }, always)).toBeNull();
    expect(cursorReaction({ distance: 100, stillMs: P.cursorStillMs - 1, speed: 100, available: all }, always)).toBeNull();
  });
  it('速いカーソルにはじゃれる (素材待ちなら見送る)', () => {
    expect(cursorReaction({ distance: 60, stillMs: 0, speed: P.fastCursor, available: all }, always)).toBe('play');
    expect(cursorReaction({ distance: 60, stillMs: 0, speed: P.fastCursor, available: none }, always)).toBeNull();
  });
  it('すぐ近くで止まったカーソルは見上げる・たまにぶら下がる (素材待ちなら見送る)', () => {
    expect(cursorReaction({ distance: 30, stillMs: P.cursorStillMs, speed: 0, available: all }, always)).toBe('cursorHang');
    expect(cursorReaction({ distance: 30, stillMs: P.cursorStillMs, speed: 0, available: (id) => id === 'lookUp' }, always)).toBe('lookUp');
    expect(cursorReaction({ distance: 30, stillMs: P.cursorStillMs, speed: 0, available: none }, always)).toBeNull();
  });
  it('少し離れて止まったカーソルには近づく・近くから顔を出す', () => {
    expect(cursorReaction({ distance: 120, stillMs: P.cursorStillMs, speed: 0, available: all }, () => 0)).toBe('approach');
    expect(cursorReaction({ distance: 120, stillMs: P.cursorStillMs, speed: 0, available: all }, () => P.cursorApproachChance + 0.01)).toBe('peekNear');
    expect(cursorReaction({ distance: 120, stillMs: P.cursorStillMs, speed: 0, available: all }, never)).toBeNull();
  });
});
