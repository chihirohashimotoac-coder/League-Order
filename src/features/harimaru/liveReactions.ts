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

interface GameMemory {
  legs: [number, number];
  /** 味方が Leg の数で負けている状態を見たか / 逆転を演出したか。 */
  trailed: boolean;
  comeback: boolean;
  /** 投てき: Leg ごとの見た投てき (`side:round`) と、側ごとの最大ラウンド。 */
  visits: Map<number, { seen: Set<string>; maxRound: [number, number] }>;
  maxLeg: number;
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

  constructor(allyId: string | null) {
    this.allyId = allyId;
  }

  /** 次に受け取る状態を基準にし直す (それまでの出来事には反応しない)。 */
  rebaseline(): void {
    this.needBaseline = true;
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
    const other = (1 - side) as 0 | 1;
    const sets = usesSets(state);
    const matchEnded = state.cardEnded || (!sets && state.gameEnded);

    // 試合全体の勝敗 (n01 が終了を確定させたときだけ、1 回)。
    if (matchEnded && !this.unitDone) {
      this.unitDone = true;
      const score = sets ? state.sets : state.legs;
      if (score[side] > score[other]) events.push({ reaction: 'victory', key: `${unit}:result` });
      else if (score[side] < score[other]) events.push({ reaction: 'frustrated', key: `${unit}:result` });
    }

    // 個別のゲーム (セット) の勝敗 (勝数がちょうど 1 増えたとき) と、対戦の逆転。
    if (sets && this.sets) {
      const gained: [number, number] = [state.sets[0] - this.sets[0], state.sets[1] - this.sets[1]];
      if (gained[side] === 1 && gained[other] === 0) events.push({ reaction: 'gameWin', key: `${unit}:game:${state.sets.join('-')}` });
      else if (gained[other] === 1 && gained[side] === 0) events.push({ reaction: 'gameLoss', key: `${unit}:game:${state.sets.join('-')}` });
    }
    if (sets) {
      const diff = state.sets[side] - state.sets[other];
      if (diff < 0) this.unitTrailed = true;
      else if (diff > 0 && this.unitTrailed && !this.unitComeback) {
        this.unitComeback = true;
        events.push({ reaction: 'comeback', key: `${unit}:comeback` });
      }
      this.sets = [state.sets[0], state.sets[1]];
    }

    // 同じゲームの Leg の勝敗と、ゲームの中の逆転。
    let game = this.games.get(state.mid);
    if (!game) {
      // 新しいゲーム (対戦の次のゲーム): いまの Leg の数を基準にする (比べるものがない)。
      game = this.rememberGame(state, side);
      this.pushMid(state.mid);
    } else {
      const gained: [number, number] = [state.legs[0] - game.legs[0], state.legs[1] - game.legs[1]];
      if (gained[side] === 1 && gained[other] === 0) events.push({ reaction: 'legWin', key: `${state.mid}:leg:${state.legs.join('-')}` });
      const diff = state.legs[side] - state.legs[other];
      if (diff < 0) game.trailed = true;
      else if (diff > 0 && game.trailed && !game.comeback) {
        game.comeback = true;
        events.push({ reaction: 'comeback', key: `${state.mid}:comeback` });
      }
      game.legs = [state.legs[0], state.legs[1]];
    }

    // 01 の得点。
    const visit = this.newVisits(state, game);
    for (const entry of visit) {
      const reaction = scoreReaction(entry, entry.side === side);
      if (reaction) events.push({ reaction, key: `${state.mid}:${state.leg?.index ?? 0}:${entry.side}:${entry.round}` });
    }

    if (events.length === 0) return null;
    // 優先度の高いもの。同じ優先度では、味方の出来事・先に見つけたものを選ぶ。
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
    }
    const sets = usesSets(state);
    const matchEnded = state.cardEnded || (!sets && state.gameEnded);
    // 最初から終わっていた試合には、勝敗の演出をしない。
    this.unitDone = this.unitDone || matchEnded;
    this.sets = sets ? [state.sets[0], state.sets[1]] : null;
    if (sets && state.sets[side] < state.sets[1 - side]) this.unitTrailed = true;
    const game = this.games.get(state.mid);
    if (game) {
      game.legs = [state.legs[0], state.legs[1]];
      if (state.legs[side] < state.legs[1 - side]) game.trailed = true;
      // 基準にする: いまの投てきはすべて見たことにする。
      this.markSeen(state, game);
    } else {
      this.rememberGame(state, side, true);
      this.pushMid(state.mid);
    }
  }

  private rememberGame(state: LiveState, side: 0 | 1, markAll = false): GameMemory {
    const game: GameMemory = {
      legs: [state.legs[0], state.legs[1]],
      trailed: state.legs[side] < state.legs[1 - side],
      comeback: false,
      visits: new Map(),
      maxLeg: state.leg?.index ?? 0,
    };
    this.games.set(state.mid, game);
    if (markAll) this.markSeen(state, game);
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

  private legMemory(game: GameMemory, index: number): { seen: Set<string>; maxRound: [number, number] } {
    let memory = game.visits.get(index);
    if (!memory) {
      memory = { seen: new Set(), maxRound: [-Infinity, -Infinity] };
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
  }

  /** 新しい 01 の投てき (初めて見た `side:round` で、その側のこれまでのラウンドより後のもの)。 */
  private newVisits(state: LiveState, game: GameMemory): LiveThrow01[] {
    const leg = state.leg;
    if (!leg) return [];
    // 過去の Leg (いまより前の Leg の状態) の投てきには反応しない。
    if (leg.index < game.maxLeg) return [];
    game.maxLeg = leg.index;
    const memory = this.legMemory(game, leg.index);
    const fresh = leg.throws.filter((entry) => !memory.seen.has(`${entry.side}:${entry.round}`));
    const later = fresh.filter((entry) => entry.round > memory.maxRound[entry.side]);
    for (const entry of fresh) {
      memory.seen.add(`${entry.side}:${entry.round}`);
      memory.maxRound[entry.side] = Math.max(memory.maxRound[entry.side], entry.round);
    }
    // Cricket の得点は対象外。取りこぼしのあと (一度に多く届いた) は新しさを保証できない。
    if (state.matchType !== '01' || fresh.length > MAX_NEW_VISITS) return [];
    return later.filter((entry): entry is LiveThrow01 => entry.kind === '01');
  }
}
