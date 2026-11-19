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
 *   1 回の更新で 3 つ以上の新しい投てきが届いた・ラウンドが連続していない・Leg を飛び越した (取りこぼしのあと)
 *   ときは、新しさを保証できないので反応しない。新しいゲーム (mid) の最初の状態の投てきも基準にする。
 * - 勝敗: n01 が確定させたものだけ。試合全体の終了は、チーム対戦・セット形式は `end_schedule` (`cardEnded`)、
 *   1 ゲームの対戦は `end_match` (既存の LivePoller の終了判定と同じ)。勝敗は、チーム対戦はゲームの勝数、
 *   セット形式はセットの勝数 (どちらも `sets`)、1 ゲームの対戦は Leg の勝数 (既存の `cardWithLive` と同じ)。
 *   個別のゲーム (セット) の勝敗は、`sets` がちょうど 1 増え、そのゲームの終了 (`end_match` か、次のゲームへの切り替え)
 *   と合っているとき。Leg の勝敗は、同じゲームの Leg の勝数がちょうど 1 増え、その Leg の終了 (終わった Leg の勝者か、
 *   次の Leg への 1 つの進み、またはゲームの終了) と合っているとき。どちらも、それまでに見た最大の勝数を超えたときだけ
 *   (訂正からの復元・基準で見た結果に反応しない)。勝数は、ゲームごとに左右が入れ替わっても味方・相手の順にそろえて比べる。
 *   同点・勝者不明・最初から終わっていた試合・終了を見たあとの対戦には反応しない。
 * - 逆転: 同じ対戦 (またはゲーム) の確定した勝数で、味方が負けている状態を見たあとに勝ち越したとき 1 回だけ。
 *   訂正・取りこぼしがあったら、その前後をつながない。
 * - 古い `mid` (すでに次のゲームへ進んだあとに届いた前のゲーム) の状態は無視する。
 */
import type { LiveState, LiveThrow, LiveThrow01 } from '../matches/parse';

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
  /** 見た投てき (`side:round` → 点) と、側ごとの最大ラウンド。 */
  seen: Map<string, number>;
  maxRound: [number, number];
  /** 終わった (`end`) のを見た Leg: そのあとに届いた投てきは後着 (反応しない)。 */
  ended: boolean;
}

/** 味方・相手の順の組 ([味方, 相手])。 */
type Pair = [number, number];

interface GameMemory {
  /** Leg の勝数 (味方・相手の順) と、それまでに見た最大。 */
  legs: Pair;
  legsMax: Pair;
  /** 味方が Leg の数で負けている状態を、確かな流れの中で見たか / 逆転を演出したか。 */
  trailed: boolean;
  comeback: boolean;
  visits: Map<number, LegMemory>;
  maxLeg: number;
  /** 結果を確定させた (または終わっているのを見た) Leg。そのあとの勝数の変化は訂正として扱う。 */
  resolvedLegs: Set<number>;
}

/** 勝数の変化: どちらか片方がちょうど 1 増えた (0 = 味方、1 = 相手)・変わらない・それ以外 (訂正・取りこぼし)。 */
function step(before: Pair, after: Pair): 0 | 1 | 'same' | null {
  const d0 = after[0] - before[0];
  const d1 = after[1] - before[1];
  if (d0 === 0 && d1 === 0) return 'same';
  if (d0 === 1 && d1 === 0) return 0;
  if (d1 === 1 && d0 === 0) return 1;
  return null;
}

const maxPair = (a: Pair, b: Pair): Pair => [Math.max(a[0], b[0]), Math.max(a[1], b[1])];

/** 投てきの点 (訂正を見分けるため)。Cricket はマーク数と点。 */
function visitScore(entry: LiveThrow): number {
  return entry.kind === '01' ? entry.score : entry.marks * 1000 + entry.points;
}

export class LiveReactionTracker {
  private readonly allyId: string | null;
  private needBaseline = true;
  /** 対戦の単位 (`tmid`、なければ `scid`、なければ `mid`)。 */
  private unit: string | null = null;
  /** ゲーム (セット) の勝数 (味方・相手の順) と、それまでに見た最大。 */
  private sets: Pair | null = null;
  private setsMax: Pair = [0, 0];
  private unitDone = false;
  private unitTrailed = false;
  private unitComeback = false;
  private readonly mids: string[] = [];
  private readonly games = new Map<string, GameMemory>();
  /** 結果を確定させた (または終わっているのを見た) ゲーム (mid)。そのあとの勝数の変化は訂正として扱う。 */
  private readonly resolvedGames = new Set<string>();

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
    const norm = (pair: readonly [number, number]): Pair => (side === 0 ? [pair[0], pair[1]] : [pair[1], pair[0]]);
    const unit = state.tmid ?? state.scid ?? state.mid;
    // すでに次のゲームへ進んだあとに届いた、前のゲームの状態は無視する。
    const lastMid = this.mids[this.mids.length - 1];
    if (unit === this.unit && lastMid !== undefined && lastMid !== state.mid && this.mids.includes(state.mid)) return null;
    if (this.needBaseline || unit !== this.unit) {
      this.baseline(state, unit, side);
      return null;
    }
    const known = this.games.get(state.mid);
    // 表示中より前の Leg が付いた応答: その Leg の結果・投てきは見ない (対戦の終了・ゲームの勝数は見る)。
    const staleLeg = known !== undefined && state.leg !== null && state.leg.index < known.maxLeg;
    // 対戦の終了を見たあと: 記録を更新するだけで、何にも反応しない。
    if (this.unitDone) {
      if (!staleLeg) this.record(state, side);
      return null;
    }

    const events: LiveEvent[] = [];
    const push = (reaction: LiveReaction, key: string): void => {
      events.push({ reaction, key });
    };
    const sets = usesSets(state);
    const matchEnded = state.cardEnded || (!sets && state.gameEnded);

    // 試合全体の勝敗 (n01 が終了を確定させたときだけ、1 回)。
    if (matchEnded) {
      this.unitDone = true;
      const score = norm(sets ? state.sets : state.legs);
      if (score[0] > score[1]) push('victory', `${unit}:result`);
      else if (score[0] < score[1]) push('frustrated', `${unit}:result`);
    }

    // 個別のゲーム (セット) の勝敗と、対戦の逆転。勝数がちょうど 1 増え、そのゲームの終了と合っているときだけ。
    if (sets && this.sets) {
      const now = norm(state.sets);
      const change = step(this.sets, now);
      // 決着したゲーム: 同じ mid の終了 (end_match・end_schedule)、または次のゲームへの切り替え (前のゲーム)。
      const settledMid = state.gameEnded || state.cardEnded ? state.mid : lastMid !== undefined && state.mid !== lastMid ? lastMid : null;
      // すでに結果を確定させた (終わっているのを見た) ゲームの勝数の変化は、訂正として扱う。
      const gameOver = settledMid !== null && !this.resolvedGames.has(settledMid);
      if (settledMid !== null) this.resolvedGames.add(settledMid);
      if (change === null) {
        // 訂正・取りこぼし: 前後をつないで逆転とみなさない。
        this.unitTrailed = false;
        this.sets = now;
      } else if (change !== 'same' && !gameOver && settledMid !== null) {
        // 決着済みのゲームへの訂正: 記録だけ合わせる。
        this.unitTrailed = false;
        this.sets = now;
      } else if (change !== 'same' && gameOver) {
        // それまでに見た最大を超えたときだけ (訂正からの復元・基準で見た結果には反応しない)。
        if (now[change] > this.setsMax[change]) {
          push(change === 0 ? 'gameWin' : 'gameLoss', `${unit}:game:${now.join('-')}`);
          if (now[0] < now[1]) this.unitTrailed = true;
          else if (now[0] > now[1] && this.unitTrailed && !this.unitComeback) {
            this.unitComeback = true;
            push('comeback', `${unit}:comeback`);
          }
        }
        this.sets = now;
      }
      // 終了と合わない 1 の増加は、終了が届くまで確定させない (this.sets・最大はそのまま)。
      this.setsMax = maxPair(this.setsMax, this.sets);
    }

    if (staleLeg) return this.pick(events);
    let game = known;
    if (!game) {
      // 新しいゲーム (対戦の次のゲーム): いまの状態を基準にする (投てきも、いつ投げられたか分からないので見たことにする)。
      game = this.rememberGame(state, side);
      this.pushMid(state.mid);
      return this.pick(events);
    }

    // 同じゲームの Leg の勝敗と、ゲームの中の逆転。Leg の終了 (終わった Leg の勝者・次の Leg への 1 つの進み・
    // ゲームの終了) と合っているときだけ。
    const legsNow = norm(state.legs);
    const legChange = step(game.legs, legsNow);
    const leg = state.leg;
    const winner = leg && leg.ended && (leg.winner === 0 || leg.winner === 1) ? (leg.winner === side ? 0 : 1) : null;
    // 決着した Leg: 同じ Leg の終了 (勝者あり)、次の Leg への 1 つの進み (前の Leg)、ゲームの終了 (いまの Leg)。
    const settledLeg =
      leg !== null && leg.index === game.maxLeg + 1 ? game.maxLeg : leg !== null && leg.index === game.maxLeg && (winner !== null || state.gameEnded) ? leg.index : null;
    // すでに結果を確定させた (終わっているのを見た) Leg の勝数の変化は、訂正として扱う。
    const legOver = settledLeg !== null && !game.resolvedLegs.has(settledLeg);
    if (settledLeg !== null) game.resolvedLegs.add(settledLeg);
    if (legChange === null || (legChange !== 'same' && !legOver && settledLeg !== null)) {
      game.trailed = false;
      game.legs = legsNow;
    } else if (legChange !== 'same' && legOver && (winner === null || winner === legChange || leg?.index !== game.maxLeg)) {
      if (legsNow[legChange] > game.legsMax[legChange]) {
        if (legChange === 0) push('legWin', `${state.mid}:leg:${legsNow.join('-')}`);
        if (legsNow[0] < legsNow[1]) game.trailed = true;
        else if (legsNow[0] > legsNow[1] && game.trailed && !game.comeback) {
          game.comeback = true;
          push('comeback', `${state.mid}:comeback`);
        }
      }
      game.legs = legsNow;
    }
    // 終了と合わない 1 の増加は確定させない (記録・最大はそのまま)。
    game.legsMax = maxPair(game.legsMax, game.legs);

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

  /** 反応しないで、勝数・投てきの記録だけを新しい状態に合わせる。 */
  private record(state: LiveState, side: 0 | 1): void {
    const norm = (pair: readonly [number, number]): Pair => (side === 0 ? [pair[0], pair[1]] : [pair[1], pair[0]]);
    if (usesSets(state)) {
      this.sets = norm(state.sets);
      this.setsMax = maxPair(this.setsMax, this.sets);
    }
    const game = this.games.get(state.mid);
    if (!game) {
      this.rememberGame(state, side);
      this.pushMid(state.mid);
      return;
    }
    game.legs = norm(state.legs);
    game.legsMax = maxPair(game.legsMax, game.legs);
    this.markSeen(state, game);
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
      this.setsMax = [0, 0];
      this.resolvedGames.clear();
    }
    const norm = (pair: readonly [number, number]): Pair => (side === 0 ? [pair[0], pair[1]] : [pair[1], pair[0]]);
    const sets = usesSets(state);
    const matchEnded = state.cardEnded || (!sets && state.gameEnded);
    // 最初から終わっていた試合には、勝敗の演出をしない (同じ対戦の基準の取り直しでは、終わった記録を残す)。
    this.unitDone = this.unitDone || matchEnded;
    this.sets = sets ? norm(state.sets) : null;
    if (this.sets) this.setsMax = maxPair(this.setsMax, this.sets);
    // 基準の取り直しでは、前後をつないで逆転とみなさない。基準で負けていれば、そこからの流れを見る。
    this.unitTrailed = this.sets !== null && this.sets[0] < this.sets[1];
    // 基準で終わっているのを見たゲーム・前のゲームは、結果を確定済みとして扱う。
    if (state.gameEnded || state.cardEnded) this.resolvedGames.add(state.mid);
    for (const mid of this.mids) if (mid !== state.mid) this.resolvedGames.add(mid);
    const game = this.games.get(state.mid);
    if (game) {
      game.legs = norm(state.legs);
      game.legsMax = maxPair(game.legsMax, game.legs);
      game.trailed = game.legs[0] < game.legs[1];
      this.markSeen(state, game);
    } else {
      this.rememberGame(state, side);
      this.pushMid(state.mid);
    }
  }

  /** 初めて見るゲーム: いまの Leg の数と投てきを基準にする。 */
  private rememberGame(state: LiveState, side: 0 | 1): GameMemory {
    const legs: Pair = side === 0 ? [state.legs[0], state.legs[1]] : [state.legs[1], state.legs[0]];
    const game: GameMemory = {
      legs,
      legsMax: [legs[0], legs[1]],
      trailed: legs[0] < legs[1],
      comeback: false,
      visits: new Map(),
      maxLeg: state.leg?.index ?? 0,
      resolvedLegs: new Set(),
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
      memory = { seen: new Map(), maxRound: [0, 0], ended: false };
      game.visits.set(index, memory);
    }
    return memory;
  }

  private markSeen(state: LiveState, game: GameMemory): void {
    const leg = state.leg;
    if (!leg) return;
    game.maxLeg = Math.max(game.maxLeg, leg.index);
    // いまより前の Leg と、終わっているのを見た Leg は、結果を確定済みとして扱う。
    for (let index = 0; index < leg.index; index += 1) game.resolvedLegs.add(index);
    if (leg.ended || state.gameEnded) game.resolvedLegs.add(leg.index);
    const memory = this.legMemory(game, leg.index);
    for (const entry of leg.throws) {
      memory.seen.set(`${entry.side}:${entry.round}`, visitScore(entry));
      memory.maxRound[entry.side] = Math.max(memory.maxRound[entry.side], entry.round);
    }
    if (leg.ended) memory.ended = true;
  }

  /**
   * 新しい 01 の投てき。初めて見た `side:round` で、その側のこれまでのラウンドのすぐ次から連続しているものだけ。
   * 終わったのを見た Leg への後着・ラウンドの分からない投てき (欠損は 0 に補われる)・欠けたラウンドのある列・
   * Leg の飛び越し・一度に多く届いたとき (取りこぼしのあと) は、記録だけして返さない。
   */
  private newVisits(state: LiveState, game: GameMemory): LiveThrow01[] {
    const leg = state.leg;
    if (!leg) return [];
    // Leg を 2 つ以上飛び越した: その間の投てきを取りこぼしている。記録だけして反応しない。
    const skipped = leg.index > game.maxLeg + 1;
    game.maxLeg = Math.max(game.maxLeg, leg.index);
    const memory = this.legMemory(game, leg.index);
    const settled = memory.ended;
    const before: [number, number] = [memory.maxRound[0], memory.maxRound[1]];
    // 前に見た投てきが消えた・点が変わった (削除・訂正・ラウンドの付け替え) 応答では、新しい投てきにも反応しない。
    const current = new Map<string, number>(leg.throws.map((entry) => [`${entry.side}:${entry.round}`, visitScore(entry)]));
    const rewritten = [...memory.seen].some(([key, score]) => current.get(key) !== score);
    const fresh = leg.throws.filter((entry) => !memory.seen.has(`${entry.side}:${entry.round}`));
    for (const [key, score] of current) memory.seen.set(key, score);
    for (const entry of fresh) memory.maxRound[entry.side] = Math.max(memory.maxRound[entry.side], entry.round);
    if (leg.ended) memory.ended = true;
    // Cricket の得点は対象外。取りこぼしのあと・終わった Leg への後着・書き換えのある応答は新しさを保証できない。
    if (state.matchType !== '01' || settled || skipped || rewritten || fresh.length > MAX_NEW_VISITS) return [];
    // 側ごとに、これまでの最大ラウンドのすぐ次から欠けなく続いていること (ラウンドは 1 から)。
    for (const sideIndex of [0, 1] as const) {
      const rounds = fresh.filter((entry) => entry.side === sideIndex).map((entry) => entry.round).sort((a, b) => a - b);
      for (let i = 0; i < rounds.length; i += 1) {
        if (!Number.isInteger(rounds[i]) || rounds[i] !== before[sideIndex] + 1 + i) return [];
      }
    }
    return fresh.filter((entry): entry is LiveThrow01 => entry.kind === '01');
  }
}
