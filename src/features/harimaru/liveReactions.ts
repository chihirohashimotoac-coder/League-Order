/**
 * n01 観戦のリアクションの判定 (純関数に近い小さなクラス。DOM・React・時計に依存しない)。
 *
 * 既存のライブのポーラー (LivePoller) が画面に渡した `LiveState` の列を受け取り、「いま新しく起きた、確かな出来事」
 * だけを 1 回に 1 つ返す。ポーラーには何も足さない (n01 への通信は増えない)。
 *
 * - 味方: League Order で選んでいる登録チームの、そのシーズンの n01 チーム ID (`tpid`) が、`sides[].teamId` の
 *   ちょうど片方と一致したときだけ。一致しない・ID がない・両方一致・個人戦などは中立で、何も返さない。
 * - 最初に受け取った状態は基準 (それまでに起きたことには反応しない)。見ているもの (対戦・味方) が変わったとき、
 *   `rebaseline()` (タブが非表示から戻ったときなど) のあとも、次の状態を基準にし直す。
 * - 01 の得点: `mid`・Leg・投げた側・ラウンドが初めて出てきた投てきだけ。訂正・削除からの復元 (一度見た投てき、
 *   それより前のラウンド)・過去の Leg・フィニッシュ (Leg の結果として扱う)・0 点 (バスト)・欠損は反応しない。
 *   1 回の更新で 3 つ以上の新しい投てきが届いたら (取りこぼしのあと)、新しさを保証できないので反応しない。
 * - 勝敗: n01 が確定させたものだけ。試合全体の終了は、チーム対戦・セット形式は `end_schedule` (`cardEnded`)、
 *   1 ゲームの対戦は `end_match` (既存の LivePoller の終了判定と同じ)。勝敗は、チーム対戦はゲームの勝数、
 *   セット形式はセットの勝数 (どちらも `sets`)、1 ゲームの対戦は Leg の勝数 (既存の `cardWithLive` と同じ)。
 *   個別のゲーム (セット) の勝敗は `sets` の 1 増加、Leg の勝敗は同じゲーム (`mid`) の Leg の勝数の 1 増加で判定する。
 *   同点・勝者不明・最初から終わっていた試合には反応しない。
 * - 逆転: 同じ対戦 (またはゲーム) の確定した勝数で、味方が負けている状態を見たあとに勝ち越したとき 1 回だけ。
 * - 古い `mid` (すでに次のゲームへ進んだあとに届いた前のゲーム) の状態は無視する。
 */
import type { LiveState, LiveThrow01 } from '../matches/parse';

export type LiveReaction =
  | 'victory'
  | 'frustrated'
  | 'surprise180'
  | 'comeback'
  | 'gameWin'
  | 'gameLoss'
  | 'legWin'
  | 'cheer'
  | 'panic'
  | 'anxious';

/** 小さいほど優先 (1 = 試合全体の勝敗)。 */
export const LIVE_PRIORITY: Record<LiveReaction, number> = {
  victory: 1,
  frustrated: 1,
  surprise180: 2,
  comeback: 3,
  gameWin: 4,
  gameLoss: 4,
  legWin: 4,
  cheer: 5,
  panic: 5,
  anxious: 5,
};

export interface LiveEvent {
  reaction: LiveReaction;
  /** 出来事の識別子 (同じ出来事に 2 回反応しないため、テスト・記録用)。 */
  key: string;
}

/** 01 の得点の分類 (確定仕様の閾値)。null = 反応しない。 */
export function scoreReaction(visit: Pick<LiveThrow01, 'score' | 'finish'>, ally: boolean): 'surprise180' | 'cheer' | 'panic' | 'anxious' | null {
  const { score } = visit;
  // フィニッシュは Leg の結果として扱う。0 (バスト)・小数・範囲外・欠損は反応しない。
  if (visit.finish || !Number.isInteger(score) || score < 1 || score > 180) return null;
  if (ally) {
    if (score === 180) return 'surprise180';
    if (score >= 100) return 'cheer';
    if (score <= 40) return 'panic';
    return null;
  }
  return score >= 100 ? 'anxious' : null;
}

/** 味方の側 (0 / 1)。確実に決まらなければ null (中立)。 */
export function allySide(state: Pick<LiveState, 'sides'>, allyId: string | null): 0 | 1 | null {
  if (!allyId) return null;
  const [a, b] = [state.sides[0].teamId, state.sides[1].teamId];
  if (!a || !b || a === b) return null;
  if (a === allyId) return 0;
  if (b === allyId) return 1;
  return null;
}

/** 対戦の勝数を `sets` で数えるか (チーム対戦のゲーム数・セット形式のセット数)。1 ゲームの対戦は Leg の数。 */
function usesSets(state: Pick<LiveState, 'isSchedule' | 'scid'>): boolean {
  return state.isSchedule || !!state.scid;
}

/** 1 回の更新で、新しいとみなせる投てきの数の上限 (ふつうのポーリングでは 1〜2)。 */
export const MAX_NEW_VISITS = 2;
/** 覚えておく `mid` の数 (古い応答の判定用)。 */
const MID_HISTORY = 16;

interface LegMemory {
  /** 見た投てき (`side:round`) と、側ごとの最大ラウンド。 */
  seen: Set<string>;
  maxRound: [number, number];
  /** 終わった (`end`) のを見た Leg: そのあとに届いた投てきは後着 (反応しない)。 */
  ended: boolean;
}

interface GameMemory {
  legs: [number, number];
  /** 味方が Leg の数で負けている状態を、確かな変化 (1 ずつの増加) の流れの中で見たか / 逆転を演出したか。 */
  trailed: boolean;
  comeback: boolean;
  visits: Map<number, LegMemory>;
  maxLeg: number;
}

/**
 * 勝数の変化が「どちらか片方がちょうど 1 増えた」か。減った・両方変わった・2 以上増えたのは訂正や取りこぼし
 * (確かな出来事ではない) として null。変わっていなければ 'same'。
 */
function step(before: readonly [number, number], after: readonly [number, number]): 0 | 1 | 'same' | null {
  const d0 = after[0] - before[0];
  const d1 = after[1] - before[1];
  if (d0 === 0 && d1 === 0) return 'same';
  if (d0 === 1 && d1 === 0) return 0;
  if (d1 === 1 && d0 === 0) return 1;
  return null;
}

export class LiveReactionTracker {
  private readonly allyId: string | null;
  private needBaseline = true;
  /** 対戦の単位 (`tmid`、なければ `scid`、なければ `mid`)。 */
  private unit: string | null = null;
  private sets: [number, number] | null = null;
  private unitDone = false;
  private unitTrailed = false;
  private unitComeback = false;
  private readonly mids: string[] = [];
  private readonly games = new Map<string, GameMemory>();
  /** 反応した (または基準で見た) 出来事。同じ結果に 2 回反応しない。 */
  private readonly consumed = new Set<string>();

  constructor(allyId: string | null) {
    this.allyId = allyId;
  }

  /** 次に受け取る状態を基準にし直す (それまでの出来事には反応しない)。 */
  rebaseline(): void {
    this.needBaseline = true;
  }

  /** いま見ている対戦の単位 (切り替わったら、演出中・待っている出来事を取り消すために使う)。 */
  get currentUnit(): string | null {
    return this.unit;
  }

  /** 新しい状態を受け取り、反応すべき出来事のうち最も優先度の高い 1 つを返す。 */
  update(state: LiveState): LiveEvent | null {
    const side = allySide(state, this.allyId);
    if (side === null) {
      // 中立: 味方・相手に依存する反応はしない。味方が分かるようになったら、その状態を基準にする。
      this.needBaseline = true;
      return null;
    }
    const unit = state.tmid ?? state.scid ?? state.mid;
    // すでに次のゲームへ進んだあとに届いた、前のゲームの状態は無視する。
    const last = this.mids[this.mids.length - 1];
    if (unit === this.unit && last !== undefined && last !== state.mid && this.mids.includes(state.mid)) return null;
    if (this.needBaseline || unit !== this.unit) {
      this.baseline(state, unit, side);
      return null;
    }
    const events: LiveEvent[] = [];
    const push = (reaction: LiveReaction, key: string): void => {
      if (this.consumed.has(key)) return;
      this.consumed.add(key);
      events.push({ reaction, key });
    };
    const other = (1 - side) as 0 | 1;
    const sets = usesSets(state);
    const matchEnded = state.cardEnded || (!sets && state.gameEnded);

    // 試合全体の勝敗 (n01 が終了を確定させたときだけ、1 回)。
    if (matchEnded && !this.unitDone) {
      this.unitDone = true;
      const score = sets ? state.sets : state.legs;
      if (score[side] > score[other]) push('victory', `${unit}:result`);
      else if (score[side] < score[other]) push('frustrated', `${unit}:result`);
    }

    // 個別のゲーム (セット) の勝敗と、対戦の逆転。勝数がちょうど 1 増えたときだけ確かな出来事とみなす。
    if (sets && this.sets) {
      const change = step(this.sets, state.sets);
      if (change === null) {
        // 訂正・取りこぼし: 前後をつないで逆転とみなさない。
        this.unitTrailed = false;
      } else if (change !== 'same') {
        push(change === side ? 'gameWin' : 'gameLoss', `${unit}:game:${state.sets.join('-')}`);
        const diff = state.sets[side] - state.sets[other];
        if (diff < 0) this.unitTrailed = true;
        else if (diff > 0 && this.unitTrailed && !this.unitComeback) {
          this.unitComeback = true;
          push('comeback', `${unit}:comeback`);
        }
      }
    }
    if (sets) this.sets = [state.sets[0], state.sets[1]];

    // 同じゲームの Leg の勝敗と、ゲームの中の逆転。
    let game = this.games.get(state.mid);
    if (!game) {
      // 新しいゲーム (対戦の次のゲーム): いまの状態を基準にする (投てきも、いつ投げられたか分からないので見たことにする)。
      game = this.rememberGame(state, side);
      this.pushMid(state.mid);
      return this.pick(events);
    }
    const change = step(game.legs, state.legs);
    if (change === null) {
      game.trailed = false;
    } else if (change !== 'same') {
      if (change === side) push('legWin', `${state.mid}:leg:${state.legs.join('-')}`);
      const diff = state.legs[side] - state.legs[other];
      if (diff < 0) game.trailed = true;
      else if (diff > 0 && game.trailed && !game.comeback) {
        game.comeback = true;
        push('comeback', `${state.mid}:comeback`);
      }
    }
    game.legs = [state.legs[0], state.legs[1]];

    // 01 の得点。
    for (const entry of this.newVisits(state, game)) {
      const reaction = scoreReaction(entry, entry.side === side);
      if (reaction) push(reaction, `${state.mid}:${state.leg?.index ?? 0}:${entry.side}:${entry.round}`);
    }
    return this.pick(events);
  }

  /** 優先度の高いもの。同じ優先度では先に見つけたもの (結果 → 得点の順に積んである)。 */
  private pick(events: readonly LiveEvent[]): LiveEvent | null {
    if (events.length === 0) return null;
    return events.reduce((best, event) => (LIVE_PRIORITY[event.reaction] < LIVE_PRIORITY[best.reaction] ? event : best));
  }

  private baseline(state: LiveState, unit: string, side: 0 | 1): void {
    this.needBaseline = false;
    if (unit !== this.unit) {
      this.unit = unit;
      this.mids.length = 0;
      this.games.clear();
      this.unitComeback = false;
      this.unitTrailed = false;
      this.unitDone = false;
    }
    const sets = usesSets(state);
    const matchEnded = state.cardEnded || (!sets && state.gameEnded);
    // 最初から終わっていた試合には、勝敗の演出をしない (同じ対戦の基準の取り直しでは、終わった記録を残す)。
    this.unitDone = this.unitDone || matchEnded;
    this.sets = sets ? [state.sets[0], state.sets[1]] : null;
    // 基準の取り直しでは、前後をつないで逆転とみなさない。基準で負けていれば、そこからの流れを見る。
    this.unitTrailed = sets && state.sets[side] < state.sets[1 - side];
    const game = this.games.get(state.mid);
    if (game) {
      game.legs = [state.legs[0], state.legs[1]];
      game.trailed = state.legs[side] < state.legs[1 - side];
      this.markSeen(state, game);
    } else {
      this.rememberGame(state, side);
      this.pushMid(state.mid);
    }
  }

  /** 初めて見るゲーム: いまの Leg の数と投てきを基準にする。 */
  private rememberGame(state: LiveState, side: 0 | 1): GameMemory {
    const game: GameMemory = {
      legs: [state.legs[0], state.legs[1]],
      trailed: state.legs[side] < state.legs[1 - side],
      comeback: false,
      visits: new Map(),
      maxLeg: state.leg?.index ?? 0,
    };
    this.games.set(state.mid, game);
    this.markSeen(state, game);
    return game;
  }

  private pushMid(mid: string): void {
    if (this.mids[this.mids.length - 1] === mid) return;
    this.mids.push(mid);
    if (this.mids.length > MID_HISTORY) {
      const dropped = this.mids.shift();
      if (dropped !== undefined && !this.mids.includes(dropped)) this.games.delete(dropped);
    }
  }

  private legMemory(game: GameMemory, index: number): LegMemory {
    let memory = game.visits.get(index);
    if (!memory) {
      memory = { seen: new Set(), maxRound: [-Infinity, -Infinity], ended: false };
      game.visits.set(index, memory);
    }
    return memory;
  }

  private markSeen(state: LiveState, game: GameMemory): void {
    const leg = state.leg;
    if (!leg) return;
    game.maxLeg = Math.max(game.maxLeg, leg.index);
    const memory = this.legMemory(game, leg.index);
    for (const entry of leg.throws) {
      memory.seen.add(`${entry.side}:${entry.round}`);
      memory.maxRound[entry.side] = Math.max(memory.maxRound[entry.side], entry.round);
    }
    if (leg.ended) memory.ended = true;
  }

  /**
   * 新しい 01 の投てき (初めて見た `side:round` で、その側のこれまでのラウンドより後のもの)。終わったのを見た Leg への
   * 後着・ラウンドの分からない投てき (欠損は 0 に補われる)・過去の Leg・取りこぼしのあとは、記録だけして返さない。
   */
  private newVisits(state: LiveState, game: GameMemory): LiveThrow01[] {
    const leg = state.leg;
    if (!leg) return [];
    if (leg.index < game.maxLeg) return [];
    game.maxLeg = leg.index;
    const memory = this.legMemory(game, leg.index);
    const settled = memory.ended;
    const fresh = leg.throws.filter((entry) => !memory.seen.has(`${entry.side}:${entry.round}`));
    const later = fresh.filter((entry) => Number.isInteger(entry.round) && entry.round >= 1 && entry.round > memory.maxRound[entry.side]);
    for (const entry of fresh) {
      memory.seen.add(`${entry.side}:${entry.round}`);
      memory.maxRound[entry.side] = Math.max(memory.maxRound[entry.side], entry.round);
    }
    if (leg.ended) memory.ended = true;
    // Cricket の得点は対象外。取りこぼしのあと (一度に多く届いた)・終わった Leg への後着は新しさを保証できない。
    if (state.matchType !== '01' || settled || fresh.length > MAX_NEW_VISITS) return [];
    return later.filter((entry): entry is LiveThrow01 => entry.kind === '01');
  }
}
