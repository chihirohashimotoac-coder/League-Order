import { describe, expect, it } from 'vitest';
import type { LiveState, LiveThrow } from '../matches/parse';
import { allySide, LiveReactionTracker, scoreReaction } from './liveReactions';

/** 味方 = A (tpid 'A')、相手 = B。既定は 01・チーム対戦 (isSchedule) の 1 ゲーム目、Leg 0。 */
function live(over: Partial<LiveState> & { throws?: LiveThrow[]; legIndex?: number; legEnded?: boolean; legWinner?: 0 | 1 | null } = {}): LiveState {
  const { throws = [], legIndex = 0, legEnded = false, legWinner = null, ...rest } = over;
  return {
    changed: true,
    mid: 'm1',
    scid: null,
    tdid: 'T',
    tmid: 'card1',
    schid: 's1',
    title: '',
    matchType: '01',
    updateTime: 1,
    gameEnded: false,
    cardEnded: false,
    isSchedule: true,
    sets: [0, 0],
    showSets: false,
    legs: [0, 0],
    limitLeg: 3,
    limitSet: null,
    drawMode: null,
    startScore: 501,
    currentLeg: legIndex,
    currentSet: null,
    legCount: null,
    sides: [
      { name: 'A', teamId: 'A', members: [], rate: null },
      { name: 'B', teamId: 'B', members: [], rate: null },
    ],
    leg: {
      index: legIndex,
      first: 0,
      ended: legEnded,
      winner: legWinner,
      thrower: 0,
      round: 1,
      member: null,
      left: [501, 501],
      start: [501, 501],
      numbers: null,
      marks: null,
      points: null,
      throws,
      bull: false,
      dartsTotal: null,
    },
    ...rest,
  };
}

const v = (side: 0 | 1, round: number, score: number, extra: Partial<LiveThrow & { kind: '01' }> = {}): LiveThrow => ({
  kind: '01',
  side,
  round,
  score,
  left: 501 - score,
  darts: 3,
  finish: false,
  member: null,
  ...extra,
});

/** 基準の状態を渡してから、次の状態の出来事を返す。 */
function after(base: LiveState, next: LiveState, ally: string | null = 'A'): string | null {
  const tracker = new LiveReactionTracker(ally);
  expect(tracker.update(base)).toBeNull();
  return tracker.update(next)?.reaction ?? null;
}

describe('scoreReaction (確定仕様の閾値)', () => {
  it('味方: 40 / 41 / 99 / 100 / 179 / 180、0 (バスト)・フィニッシュ・欠損', () => {
    const ally = (score: number, finish = false) => scoreReaction({ score, finish }, true);
    expect(ally(1)).toBe('panic');
    expect(ally(40)).toBe('panic');
    expect(ally(41)).toBeNull();
    expect(ally(99)).toBeNull();
    expect(ally(100)).toBe('cheer');
    expect(ally(179)).toBe('cheer');
    expect(ally(180)).toBe('surprise180');
    expect(ally(0)).toBeNull();
    expect(ally(120, true)).toBeNull();
    expect(ally(32, true)).toBeNull();
    expect(ally(Number.NaN)).toBeNull();
    expect(ally(40.5)).toBeNull();
    expect(ally(181)).toBeNull();
    expect(ally(-1)).toBeNull();
  });
  it('相手: 100 以上 (180 も) は anxious、99 以下・低得点は反応しない', () => {
    const opp = (score: number) => scoreReaction({ score, finish: false }, false);
    expect(opp(99)).toBeNull();
    expect(opp(100)).toBe('anxious');
    expect(opp(180)).toBe('anxious');
    expect(opp(20)).toBeNull();
    expect(opp(0)).toBeNull();
  });
});

describe('allySide (味方の判定)', () => {
  const sides = (a: string | null, b: string | null) => ({ sides: [{ name: '', teamId: a, members: [], rate: null }, { name: '', teamId: b, members: [], rate: null }] as LiveState['sides'] });
  it('チーム ID がちょうど片方と一致したときだけ', () => {
    expect(allySide(sides('A', 'B'), 'A')).toBe(0);
    expect(allySide(sides('B', 'A'), 'A')).toBe(1);
    expect(allySide(sides('B', 'C'), 'A')).toBeNull();
    expect(allySide(sides('A', 'A'), 'A')).toBeNull();
    expect(allySide(sides('A', null), 'A')).toBeNull();
    expect(allySide(sides(null, null), 'A')).toBeNull();
    expect(allySide(sides('A', 'B'), null)).toBeNull();
  });
});

describe('LiveReactionTracker: 01 の得点', () => {
  it('新しい投てきの得点に、味方・相手の別で反応する (画面の左右には依存しない)', () => {
    expect(after(live(), live({ throws: [v(0, 1, 140)] }))).toBe('cheer');
    expect(after(live(), live({ throws: [v(0, 1, 180)] }))).toBe('surprise180');
    expect(after(live(), live({ throws: [v(0, 1, 26)] }))).toBe('panic');
    expect(after(live(), live({ throws: [v(1, 1, 140)] }))).toBe('anxious');
    expect(after(live(), live({ throws: [v(1, 1, 180)] }))).toBe('anxious');
    expect(after(live(), live({ throws: [v(0, 1, 60)] }))).toBeNull();
    // 味方が右 (sides[1]) のとき。
    const flipped = { sides: [live().sides[1], live().sides[0]] as LiveState['sides'] };
    expect(after(live(flipped), live({ ...flipped, throws: [v(1, 1, 140)] }))).toBe('cheer');
    expect(after(live(flipped), live({ ...flipped, throws: [v(0, 1, 140)] }))).toBe('anxious');
  });

  it('初回の状態 (それまでの投てき) には反応しない。同じ応答の再取得にも反応しない', () => {
    const tracker = new LiveReactionTracker('A');
    const first = live({ throws: [v(0, 1, 180), v(1, 1, 140)] });
    expect(tracker.update(first)).toBeNull();
    expect(tracker.update(first)).toBeNull();
    expect(tracker.update(live({ throws: [v(0, 1, 180), v(1, 1, 140)] }))).toBeNull();
  });

  it('連続するポーリング: 投てきごとに 1 回だけ反応し、同じ投てきには 2 回反応しない', () => {
    const tracker = new LiveReactionTracker('A');
    tracker.update(live());
    const one = [v(0, 1, 100)];
    expect(tracker.update(live({ throws: one }))?.reaction).toBe('cheer');
    expect(tracker.update(live({ throws: one }))).toBeNull();
    const two = [...one, v(1, 1, 45)];
    expect(tracker.update(live({ throws: two }))).toBeNull();
    const three = [...two, v(0, 2, 30)];
    expect(tracker.update(live({ throws: three }))?.reaction).toBe('panic');
  });

  it('得点の訂正・削除からの復元・前のラウンドには反応しない', () => {
    const tracker = new LiveReactionTracker('A');
    tracker.update(live({ throws: [v(0, 1, 60), v(1, 1, 60)] }));
    expect(tracker.update(live({ throws: [v(0, 1, 60), v(1, 1, 60), v(0, 2, 45)] }))).toBeNull();
    // 訂正 (同じラウンドの点が 45 → 140)。
    expect(tracker.update(live({ throws: [v(0, 1, 60), v(1, 1, 60), v(0, 2, 140)] }))).toBeNull();
    // 削除して復元。
    expect(tracker.update(live({ throws: [v(0, 1, 60), v(1, 1, 60)] }))).toBeNull();
    expect(tracker.update(live({ throws: [v(0, 1, 60), v(1, 1, 60), v(0, 2, 140)] }))).toBeNull();
  });

  it('一度に 3 つ以上の新しい投てき (取りこぼし・再接続のあと) は、新しさを保証できないので反応しない', () => {
    const tracker = new LiveReactionTracker('A');
    tracker.update(live());
    expect(tracker.update(live({ throws: [v(0, 1, 180), v(1, 1, 60), v(0, 2, 140)] }))).toBeNull();
    // そのあとの新しい投てきには反応する。
    expect(tracker.update(live({ throws: [v(0, 1, 180), v(1, 1, 60), v(0, 2, 140), v(1, 2, 140)] }))?.reaction).toBe('anxious');
  });

  it('同じ更新で 2 つ届いたら、優先度の高い方 (味方の 180) だけ', () => {
    expect(after(live(), live({ throws: [v(1, 1, 140), v(0, 1, 180)] }))).toBe('surprise180');
    expect(after(live(), live({ throws: [v(0, 1, 140), v(1, 1, 140)] }))).toBe('cheer');
  });

  it('Cricket の得点には反応しない', () => {
    const cricket = { matchType: 'cricket' as const };
    const hit: LiveThrow = { kind: 'cricket', side: 0, round: 1, hits: [], marks: 9, points: 60, member: null };
    expect(after(live(cricket), live({ ...cricket, throws: [hit] }))).toBeNull();
  });

  it('過去の Leg の状態には反応しない。新しい Leg の投てきには反応する', () => {
    const tracker = new LiveReactionTracker('A');
    tracker.update(live({ legIndex: 1, throws: [v(0, 1, 60)] }));
    expect(tracker.update(live({ legIndex: 0, throws: [v(0, 5, 140)] }))).toBeNull();
    expect(tracker.update(live({ legIndex: 2, throws: [v(0, 1, 140)] }))?.reaction).toBe('cheer');
  });

  it('チームが分からない・味方がいない対戦・個人戦 (ID なし) は中立で、何にも反応しない', () => {
    expect(after(live(), live({ throws: [v(0, 1, 180)] }), null)).toBeNull();
    expect(after(live(), live({ throws: [v(0, 1, 180)] }), 'Z')).toBeNull();
    const solo = { sides: [{ name: 'p', teamId: null, members: [], rate: null }, { name: 'q', teamId: null, members: [], rate: null }] as LiveState['sides'] };
    expect(after(live(solo), live({ ...solo, throws: [v(0, 1, 180)] }))).toBeNull();
  });

  it('タブが非表示から戻ったら (rebaseline)、その間の投てき・決着には反応しない', () => {
    const tracker = new LiveReactionTracker('A');
    tracker.update(live());
    tracker.rebaseline();
    expect(tracker.update(live({ throws: [v(0, 1, 180)], cardEnded: true, sets: [3, 1] }))).toBeNull();
  });
});

describe('LiveReactionTracker: 勝敗・逆転', () => {
  it('試合全体 (チーム対戦) の勝敗: end_schedule とゲームの勝数。同点・2 回目・最初から終了済みには反応しない', () => {
    expect(after(live({ sets: [2, 1] }), live({ sets: [3, 1], cardEnded: true, gameEnded: true }))).toBe('victory');
    expect(after(live({ sets: [1, 2] }), live({ sets: [1, 3], cardEnded: true, gameEnded: true }))).toBe('frustrated');
    expect(after(live({ sets: [2, 1] }), live({ sets: [2, 2], cardEnded: true }))).toBe('gameLoss');
    expect(after(live({ sets: [2, 2] }), live({ sets: [2, 2], cardEnded: true }))).toBeNull();
    const tracker = new LiveReactionTracker('A');
    tracker.update(live({ sets: [2, 1] }));
    expect(tracker.update(live({ sets: [3, 1], cardEnded: true }))?.reaction).toBe('victory');
    expect(tracker.update(live({ sets: [3, 1], cardEnded: true, updateTime: 2 }))).toBeNull();
    // 最初から終わっていた試合。
    expect(after(live({ sets: [3, 1], cardEnded: true }), live({ sets: [3, 1], cardEnded: true, updateTime: 2 }))).toBeNull();
  });

  it('ゲームの終了 (end_match) を対戦の終了と混同しない: チーム対戦のゲームの勝ちは控えめな gameWin', () => {
    expect(after(live({ sets: [0, 0] }), live({ sets: [1, 0], gameEnded: true, legs: [2, 1] }))).toBe('gameWin');
    expect(after(live({ sets: [1, 0] }), live({ sets: [1, 1], gameEnded: true, legs: [1, 2] }))).toBe('gameLoss');
  });

  it('1 ゲームの対戦 (チーム対戦でない) は end_match が試合の終了: Leg の勝数で勝敗', () => {
    const single = { isSchedule: false, tmid: 'card2' };
    expect(after(live({ ...single, legs: [1, 1] }), live({ ...single, legs: [2, 1], gameEnded: true }))).toBe('victory');
    expect(after(live({ ...single, legs: [1, 1] }), live({ ...single, legs: [1, 2], gameEnded: true }))).toBe('frustrated');
    // 引き分け (draw_mode)。
    expect(after(live({ ...single, legs: [1, 0] }), live({ ...single, legs: [1, 1], gameEnded: true }))).toBeNull();
  });

  it('Leg の勝ち (Leg の勝数が 1 増え、その Leg の終了と合う) は legWin、負けには反応しない。フィニッシュの投てきで二重に反応しない', () => {
    // 終わった Leg の勝者が味方 (同じ Leg の状態)。
    expect(after(live({ legs: [0, 0], throws: [v(0, 1, 100)] }), live({ legs: [1, 0], legEnded: true, legWinner: 0, throws: [v(0, 1, 100), v(0, 2, 120, { finish: true, left: 0 })] }))).toBe('legWin');
    // 次の Leg へ 1 つ進んだ。
    expect(after(live({ legs: [0, 0] }), live({ legs: [1, 0], legIndex: 1 }))).toBe('legWin');
    expect(after(live({ legs: [0, 0] }), live({ legs: [0, 1], legEnded: true, legWinner: 1, throws: [v(1, 1, 140, { finish: true, left: 0 })] }))).toBeNull();
    // 勝数だけが増えて、Leg の終了が分からない (勝者なし・同じ Leg) ときは確定させない。
    expect(after(live({ legs: [0, 0] }), live({ legs: [1, 0] }))).toBeNull();
    expect(after(live({ legs: [0, 0] }), live({ legs: [1, 0], legEnded: true, legWinner: null }))).toBeNull();
  });

  it('逆転: 確定した勝数で負けていた状態を見たあとに勝ち越したら 1 回だけ。対戦の勝利と同時なら勝利を優先', () => {
    const tracker = new LiveReactionTracker('A');
    tracker.update(live({ sets: [0, 1] }));
    expect(tracker.update(live({ mid: 'm2', sets: [1, 1] }))?.reaction).toBe('gameWin');
    expect(tracker.update(live({ mid: 'm3', sets: [2, 1] }))?.reaction).toBe('comeback');
    expect(tracker.update(live({ mid: 'm4', sets: [2, 2] }))?.reaction).toBe('gameLoss');
    expect(tracker.update(live({ mid: 'm5', sets: [3, 2] }))?.reaction).toBe('gameWin');
    // 勝利と同時に成立。
    const t2 = new LiveReactionTracker('A');
    t2.update(live({ sets: [1, 2] }));
    expect(t2.update(live({ mid: 'm2', sets: [2, 2] }))?.reaction).toBe('gameWin');
    expect(t2.update(live({ mid: 'm3', sets: [3, 2], cardEnded: true }))?.reaction).toBe('victory');
    // 一度も負けていなければ逆転ではない。
    const t3 = new LiveReactionTracker('A');
    t3.update(live({ sets: [0, 0] }));
    expect(t3.update(live({ mid: 'm2', sets: [1, 0] }))?.reaction).toBe('gameWin');
  });

  it('ゲームの中の逆転 (Leg の数): 0-1 → 1-1 → 2-1', () => {
    const tracker = new LiveReactionTracker('A');
    tracker.update(live({ legs: [0, 1], legIndex: 1 }));
    expect(tracker.update(live({ legs: [1, 1], legIndex: 2 }))?.reaction).toBe('legWin');
    expect(tracker.update(live({ legs: [2, 1], legIndex: 3 }))?.reaction).toBe('comeback');
  });

  it('ゲームが切り替わって左右の並びが入れ替わっても、味方・相手を取り違えない', () => {
    const tracker = new LiveReactionTracker('A');
    tracker.update(live({ sets: [0, 1] }));
    const swapped = { sides: [live().sides[1], live().sides[0]] as LiveState['sides'] };
    // 味方 (A) が勝って 1-1。新しいゲームでは A が右 (sides[1]) なので sets は [B, A] = [1, 1]。
    expect(tracker.update(live({ ...swapped, mid: 'm2', sets: [1, 1] }))?.reaction).toBe('gameWin');
    expect(tracker.update(live({ mid: 'm3', sets: [2, 1] }))?.reaction).toBe('comeback');
  });

  it('ゲームの終了と合わない勝数の増加は確定させず、終了が届いたら 1 回だけ。表示中より前の Leg の状態は丸ごと無視', () => {
    const tracker = new LiveReactionTracker('A');
    tracker.update(live({ sets: [0, 0] }));
    expect(tracker.update(live({ sets: [1, 0] }))).toBeNull();
    expect(tracker.update(live({ sets: [1, 0], gameEnded: true }))?.reaction).toBe('gameWin');
    expect(tracker.update(live({ mid: 'm2', sets: [1, 0] }))).toBeNull();
    const t2 = new LiveReactionTracker('A');
    t2.update(live({ legIndex: 2, legs: [1, 1] }));
    expect(t2.update(live({ legIndex: 1, legs: [2, 1], legEnded: true, legWinner: 0, throws: [v(0, 1, 180)] }))).toBeNull();
  });

  it('対戦の終了を見たあとに届いた状態 (訂正など) からは、ゲームの勝敗も出さない', () => {
    const tracker = new LiveReactionTracker('A');
    tracker.update(live({ sets: [1, 0], cardEnded: true }));
    expect(tracker.update(live({ sets: [2, 0], cardEnded: true, gameEnded: true }))).toBeNull();
    const t2 = new LiveReactionTracker('A');
    t2.update(live({ sets: [2, 1] }));
    expect(t2.update(live({ sets: [3, 1], cardEnded: true }))?.reaction).toBe('victory');
    expect(t2.update(live({ sets: [3, 2], cardEnded: true, gameEnded: true }))).toBeNull();
  });

  it('投てきの欠落 (ラウンドの飛び)・Leg の飛び越しのあとの投てきには反応しない', () => {
    const tracker = new LiveReactionTracker('A');
    tracker.update(live({ throws: [v(0, 1, 60)] }));
    expect(tracker.update(live({ throws: [v(0, 1, 60), v(0, 5, 180)] }))).toBeNull();
    const t2 = new LiveReactionTracker('A');
    t2.update(live({ legIndex: 0, throws: [v(0, 1, 60)] }));
    expect(t2.update(live({ legIndex: 3, throws: [v(0, 1, 180)] }))).toBeNull();
    // 次の Leg (1 つの進み) の最初の投てきには反応する。
    const t3 = new LiveReactionTracker('A');
    t3.update(live({ legIndex: 0, throws: [v(0, 1, 60)] }));
    expect(t3.update(live({ legIndex: 1, throws: [v(1, 1, 140)] }))?.reaction).toBe('anxious');
  });

  it('決着済みのゲーム・Leg の勝数の訂正を、新しい勝利として扱わない', () => {
    const tracker = new LiveReactionTracker('A');
    tracker.update(live({ sets: [0, 0] }));
    expect(tracker.update(live({ sets: [1, 0], gameEnded: true }))?.reaction).toBe('gameWin');
    // 同じ mid (決着済み) の勝数が 1-0 → 2-0 に訂正。
    expect(tracker.update(live({ sets: [2, 0], gameEnded: true }))).toBeNull();
    // 次のゲームへ切り替わっても、決着済みのゲームの訂正を拾わない。
    expect(tracker.update(live({ mid: 'm2', sets: [2, 0] }))).toBeNull();
    const t2 = new LiveReactionTracker('A');
    t2.update(live({ legs: [0, 0] }));
    expect(t2.update(live({ legs: [1, 0], legEnded: true, legWinner: 0 }))?.reaction).toBe('legWin');
    expect(t2.update(live({ legs: [2, 0], legEnded: true, legWinner: 0 }))).toBeNull();
  });

  it('付いている Leg が古い応答でも、対戦の終了は見落とさない (Leg の結果・投てきは見ない)', () => {
    const tracker = new LiveReactionTracker('A');
    tracker.update(live({ legIndex: 2, sets: [2, 1] }));
    expect(tracker.update(live({ legIndex: 1, sets: [3, 1], cardEnded: true, gameEnded: true, throws: [v(0, 1, 180)] }))?.reaction).toBe('victory');
  });

  it('前に見た投てきが消えた・点が変わった応答では、新しく現れた投てきにも反応しない', () => {
    const tracker = new LiveReactionTracker('A');
    tracker.update(live({ throws: [v(0, 1, 60)] }));
    // 第 1 ラウンドが消えて、第 2 ラウンドの 180 だけが載る。
    expect(tracker.update(live({ throws: [v(0, 2, 180)] }))).toBeNull();
    const t2 = new LiveReactionTracker('A');
    t2.update(live({ throws: [v(0, 1, 60)] }));
    // 第 1 ラウンドの点が 60 → 45 に訂正され、同時に第 2 ラウンドが届く。
    expect(t2.update(live({ throws: [v(0, 1, 45), v(0, 2, 140)] }))).toBeNull();
    // そのあと、ふつうに続けば反応する。
    expect(t2.update(live({ throws: [v(0, 1, 45), v(0, 2, 140), v(1, 1, 60), v(0, 3, 26)] }))?.reaction).toBe('panic');
  });

  it('1 ゲームの対戦: 付いている Leg が表示中より古い終了の応答 (古い勝数) では勝敗を決めず、整合する応答で 1 回だけ', () => {
    const single = { isSchedule: false, tmid: 'card2' };
    const tracker = new LiveReactionTracker('A');
    tracker.update(live({ ...single, legIndex: 2, legs: [1, 1] }));
    // 古い Leg 1 の勝数 (1-0 のころ) のまま end_match が付いた応答: 勝利にしない。
    expect(tracker.update(live({ ...single, legIndex: 1, legs: [1, 0], gameEnded: true }))).toBeNull();
    expect(tracker.update(live({ ...single, legIndex: 2, legs: [1, 2], gameEnded: true, legEnded: true, legWinner: 1 }))?.reaction).toBe('frustrated');
    expect(tracker.update(live({ ...single, legIndex: 2, legs: [1, 2], gameEnded: true, legEnded: true, legWinner: 1, updateTime: 9 }))).toBeNull();
    // 監査の再現手順: Leg 2・2-0 を見たあとに、Leg 1・0-1・end_match の応答 → 敗北にしない。
    const t2 = new LiveReactionTracker('A');
    t2.update(live({ ...single, legIndex: 2, legs: [2, 0] }));
    expect(t2.update(live({ ...single, legIndex: 1, legs: [0, 1], gameEnded: true }))).toBeNull();
    expect(t2.update(live({ ...single, legIndex: 2, legs: [3, 0], gameEnded: true, legEnded: true, legWinner: 0 }))?.reaction).toBe('victory');
  });

  it('Leg を 2 つ以上飛び越した応答の勝数の増加は Leg の勝ちにしない (飛ばした Leg の後着の結果も)。次の Leg の勝ちには反応する', () => {
    const tracker = new LiveReactionTracker('A');
    tracker.update(live({ legIndex: 0, legs: [0, 0] }));
    expect(tracker.update(live({ legIndex: 2, legs: [1, 0] }))).toBeNull();
    expect(tracker.update(live({ legIndex: 2, legs: [1, 0], updateTime: 3 }))).toBeNull();
    expect(tracker.update(live({ legIndex: 2, legs: [2, 0], legEnded: true, legWinner: 0, updateTime: 4 }))?.reaction).toBe('legWin');
    // 監査の再現手順: Leg 0・0-0 → Leg 2・1-0 → Leg 3・1-0 (勝数は変わらない) → 反応しない。
    const t2 = new LiveReactionTracker('A');
    t2.update(live({ legIndex: 0, legs: [0, 0] }));
    expect(t2.update(live({ legIndex: 2, legs: [1, 0] }))).toBeNull();
    expect(t2.update(live({ legIndex: 3, legs: [1, 0] }))).toBeNull();
  });

  it('前に見た投てきの残り点・フィニッシュだけが変わった訂正でも、新しい投てきに反応しない。残り 0 (フィニッシュの欠け) の点にも反応しない', () => {
    const tracker = new LiveReactionTracker('A');
    tracker.update(live({ throws: [v(0, 1, 60)] }));
    expect(tracker.update(live({ throws: [v(0, 1, 60, { left: 400 }), v(0, 2, 180, { left: 220 })] }))).toBeNull();
    const t2 = new LiveReactionTracker('A');
    t2.update(live({ throws: [v(0, 1, 60)] }));
    expect(t2.update(live({ throws: [v(0, 1, 60, { finish: true }), v(1, 1, 140)] }))).toBeNull();
    const t3 = new LiveReactionTracker('A');
    t3.update(live({ throws: [v(0, 1, 60, { left: 40 })] }));
    expect(t3.update(live({ throws: [v(0, 1, 60, { left: 40 }), v(0, 2, 40, { left: 0 })] }))).toBeNull();
    expect(scoreReaction({ score: 40, finish: false, left: 0 }, true)).toBeNull();
    expect(scoreReaction({ score: 40, finish: false, left: 1 }, true)).toBe('panic');
  });

  it('基準で見た結果は、訂正から復元されても演出しない', () => {
    const tracker = new LiveReactionTracker('A');
    tracker.update(live({ legs: [1, 0], legIndex: 1 }));
    expect(tracker.update(live({ legs: [0, 0], legIndex: 1 }))).toBeNull();
    expect(tracker.update(live({ legs: [1, 0], legIndex: 2 }))).toBeNull();
    expect(tracker.update(live({ legs: [2, 0], legIndex: 3 }))?.reaction).toBe('legWin');
  });

  it('古い mid の遅れた応答・別の対戦への切り替え・味方の切り替え', () => {
    const tracker = new LiveReactionTracker('A');
    tracker.update(live({ mid: 'm1' }));
    expect(tracker.update(live({ mid: 'm2', sets: [1, 0] }))?.reaction).toBe('gameWin');
    // 前のゲームの遅れた応答 (高得点を含む) は無視する。
    expect(tracker.update(live({ mid: 'm1', throws: [v(0, 9, 180)] }))).toBeNull();
    expect(tracker.update(live({ mid: 'm2', sets: [1, 0], throws: [v(0, 1, 140)] }))?.reaction).toBe('cheer');
    // 別の対戦 (tmid) に切り替わったら、その最初の状態は基準。
    expect(tracker.update(live({ tmid: 'card9', mid: 'x1', throws: [v(0, 1, 180)], sets: [3, 0], cardEnded: true }))).toBeNull();
    // 味方が変わったら (判定は作り直す): 新しい判定の最初の状態は基準。
    const other = new LiveReactionTracker('B');
    expect(other.update(live({ throws: [v(1, 1, 180)] }))).toBeNull();
    expect(other.update(live({ throws: [v(1, 1, 180), v(0, 1, 140)] }))?.reaction).toBe('anxious');
  });

  it('セット形式 (scid) のセットの切り替え: 新しいセット (mid) の最初の状態は基準 (いつ投げたか分からない投てきには反応しない)', () => {
    const set = { tmid: null, scid: 'sc1', isSchedule: false };
    const tracker = new LiveReactionTracker('A');
    tracker.update(live({ ...set, mid: 'set1', throws: [v(0, 1, 60)] }));
    expect(tracker.update(live({ ...set, mid: 'set2', throws: [v(0, 1, 140)] }))).toBeNull();
    expect(tracker.update(live({ ...set, mid: 'set2', throws: [v(0, 1, 140), v(1, 1, 60), v(0, 2, 120)] }))?.reaction).toBe('cheer');
    expect(tracker.update(live({ ...set, mid: 'set1', throws: [v(0, 1, 60), v(0, 2, 180)] }))).toBeNull();
  });

  it('対戦の次のゲーム (新しい mid) の最初の状態にすでにある投てき (味方の 180 など) には反応しない', () => {
    const tracker = new LiveReactionTracker('A');
    tracker.update(live({ mid: 'g1' }));
    expect(tracker.update(live({ mid: 'g2', throws: [v(0, 1, 180)] }))).toBeNull();
    expect(tracker.update(live({ mid: 'g2', throws: [v(0, 1, 180), v(1, 1, 60), v(0, 2, 180)] }))?.reaction).toBe('surprise180');
  });

  it('勝数の訂正 (減る・両方変わる) では反応せず、同じ結果に 2 回反応しない。訂正の前後をつないで逆転にしない', () => {
    const tracker = new LiveReactionTracker('A');
    tracker.update(live({ legs: [0, 0] }));
    expect(tracker.update(live({ legs: [1, 0], legIndex: 1 }))?.reaction).toBe('legWin');
    expect(tracker.update(live({ legs: [0, 0], legIndex: 1 }))).toBeNull();
    expect(tracker.update(live({ legs: [1, 0], legIndex: 1, legEnded: true, legWinner: 0 }))).toBeNull();
    const t2 = new LiveReactionTracker('A');
    t2.update(live({ sets: [0, 1] }));
    // 0-1 → 1-0 (両方変わった = 訂正)。
    expect(t2.update(live({ mid: 'm2', sets: [1, 0] }))).toBeNull();
    expect(t2.update(live({ mid: 'm3', sets: [2, 0] }))?.reaction).toBe('gameWin');
    const t3 = new LiveReactionTracker('A');
    t3.update(live({ sets: [0, 1] }));
    // 2 つ増えた (取りこぼし) も確かな出来事ではない。
    expect(t3.update(live({ mid: 'm2', sets: [2, 1] }))).toBeNull();
  });

  it('対戦が変わったら、前の対戦の「終了済み」を持ち越さない', () => {
    const tracker = new LiveReactionTracker('A');
    tracker.update(live({ tmid: 'A1', sets: [3, 1], cardEnded: true }));
    tracker.update(live({ tmid: 'B1', mid: 'b1', sets: [2, 2] }));
    expect(tracker.update(live({ tmid: 'B1', mid: 'b1', sets: [3, 2], cardEnded: true }))?.reaction).toBe('victory');
  });

  it('終わったのを見た Leg に後から届いた投てき・ラウンドの分からない投てきには反応しない', () => {
    const tracker = new LiveReactionTracker('A');
    tracker.update(live({ legEnded: true, throws: [v(0, 1, 60)] }));
    expect(tracker.update(live({ legEnded: true, throws: [v(0, 1, 60), v(0, 2, 180)] }))).toBeNull();
    const t2 = new LiveReactionTracker('A');
    t2.update(live());
    expect(t2.update(live({ throws: [v(0, 0, 180)] }))).toBeNull();
  });

  it('セット形式: 1 セットの終了 (end_match) は試合の終了ではない。セットの勝ちは控えめ、end_schedule でセット数の勝敗', () => {
    const set = { tmid: null, scid: 'sc1', isSchedule: false };
    expect(after(live({ ...set, sets: [0, 0], legs: [2, 1] }), live({ ...set, sets: [1, 0], legs: [3, 1], gameEnded: true }))).toBe('gameWin');
    expect(after(live({ ...set, sets: [1, 1] }), live({ ...set, sets: [1, 2], gameEnded: true }))).toBe('gameLoss');
    expect(after(live({ ...set, sets: [1, 1] }), live({ ...set, sets: [2, 1], gameEnded: true, cardEnded: true }))).toBe('victory');
  });
});
