/**
 * ハリマルの調整用パラメータ (PR1)。
 *
 * ここにある確率・時間・速度は、プレビュー確認で調整するための**暫定値**であり、ユーザーが確定した
 * 値ではない (確定仕様は「全高 20 CSS px」と「気まぐれさ」「閲覧・操作を妨げない」こと)。
 * 値を変えても既存機能には影響しない。テストは乱数と時計を差し替えて全分岐を再現する。
 */
export const SPRITE = {
  /** 1 コマの表示枠 (CSS px)。キャラクターの可視高さは最大 20 CSS px (素材の透明余白を除く)。 */
  width: 30,
  height: 20,
  /** 素材の左右の透明余白 (CSS px, 実測 2.3〜3.0)。足場の判定では可視部分だけを数える。 */
  sideInset: 2,
} as const;

export interface BehaviorParams {
  /** 行動ごとの基本の重み (相対値)。idle・rest は「何もしない・休む」。 */
  weights: {
    idle: number;
    rest: number;
    look: number;
    walk: number;
    run: number;
    hop: number;
    jump: number;
    hide: number;
    sleep: number;
    groom: number;
    stretch: number;
  };
  /** 直前と同じ行動の重みに掛ける係数 / 直前 2 回とも同じときの係数 (機械的な連続を防ぐ)。 */
  repeatPenalty: number;
  repeatTwicePenalty: number;
  /** 動く行動 (歩く・走る・跳ねる・ジャンプ) のあとに、動く行動の重みに掛ける係数。2 回続いたら 0。 */
  afterMovingPenalty: number;
  /** 無操作がこの時間続くと、眠る重みを sleepWhenInactive に上げる。 */
  inactiveSleepAfterMs: number;
  sleepWhenInactive: number;
  /** 待機の長さ (最小・最大)。 */
  idleMs: [number, number];
  /** 眠りの長さ (最小・最大)。 */
  sleepMs: [number, number];
  /** 伏せて休む・周囲を見る・カード裏に隠れている長さ (最小・最大)。 */
  restMs: [number, number];
  lookMs: [number, number];
  hiddenMs: [number, number];
  /** 隠れる前に足場の端まで歩く確率 (画面の外へ消えるように見せる)。 */
  walkToEdgeChance: number;
  /** 歩く距離 (最小・最大, CSS px)。最小距離を取れない足場では歩かない。 */
  walkDistance: [number, number];
  /** 歩く速さ (CSS px / 秒)。歩行 4 コマの 1 周期で進む距離と合わせ、足が滑って見えないようにする。 */
  walkSpeed: number;
  /** 駆け足の距離 (最小・最大) と速さ。 */
  runDistance: [number, number];
  runSpeed: number;
}

export const DEFAULT_BEHAVIOR: BehaviorParams = {
  weights: { idle: 4, rest: 1.2, look: 1.5, walk: 3, run: 0.45, hop: 0.4, jump: 1.2, hide: 0.35, sleep: 0.35, groom: 0.8, stretch: 0.6 },
  repeatPenalty: 0.4,
  repeatTwicePenalty: 0.12,
  afterMovingPenalty: 0.5,
  inactiveSleepAfterMs: 45_000,
  sleepWhenInactive: 6,
  idleMs: [2_500, 7_000],
  sleepMs: [12_000, 40_000],
  restMs: [6_000, 16_000],
  lookMs: [2_400, 5_000],
  hiddenMs: [1_200, 3_500],
  walkToEdgeChance: 0.4,
  walkDistance: [18, 150],
  walkSpeed: 20,
  runDistance: [40, 180],
  runSpeed: 64,
};

export interface AnimationParams {
  /** 歩行 1 コマの時間 (素材 v0.2 のプレビューで確認した値)。 */
  walkFrameMs: number;
  /** 眠りへ移るコマ / 目覚めるコマの時間。 */
  sleepFrameMs: number;
  wakeFrameMs: number;
  /** 待機中の瞬きの間隔 (最小・最大) と長さ。 */
  blinkEveryMs: [number, number];
  blinkMs: number;
  /** 表示・非表示のフェード時間 (CSS と合わせる)。 */
  fadeMs: number;
  /** 駆け足 1 コマの時間 (歩行コマを速く再生する)。 */
  runFrameMs: number;
  /** その場で跳ねる高さと 1 回の時間。喜ぶときは 2 回。 */
  hopHeight: number;
  hopMs: number;
  /** ジャンプの頂点の高さ (踏切・着地のどちらか高い方から) と、水平 1px あたりの時間。 */
  jumpApex: number;
  jumpMsPerPx: number;
  jumpMinMs: number;
  /** カード裏へ沈む・顔を出す時間と、顔を出すときに見せる高さ (耳と目)。 */
  sinkMs: number;
  peekVisible: number;
  /** 周囲を見るときに向きを変える間隔 (最小・最大)。 */
  lookTurnMs: [number, number];
}

export const DEFAULT_ANIMATION: AnimationParams = {
  walkFrameMs: 170,
  sleepFrameMs: 500,
  wakeFrameMs: 260,
  blinkEveryMs: [3_500, 6_500],
  blinkMs: 160,
  fadeMs: 240,
  runFrameMs: 85,
  hopHeight: 6,
  hopMs: 260,
  jumpApex: 14,
  jumpMsPerPx: 6,
  jumpMinMs: 360,
  sinkMs: 420,
  peekVisible: 11,
  lookTurnMs: [900, 1_800],
};

export interface TerrainParams {
  /** キャラクターの上・左右に空ける余白 (CSS px)。文字や操作部品にぎりぎりまで寄せない。 */
  clearanceTop: number;
  clearanceSide: number;
  /** 足場の角 (角丸) を避ける最小の内側余白 (CSS px)。 */
  cornerInset: number;
  /** 隣り合う足場を 1 本につなぐ最大の隙間 (CSS px)。同じ高さのタイル列を歩けるようにする。 */
  joinGap: number;
  /** 同じ高さの段とみなす上辺の差 (CSS px)。ホバーで 2px 浮いたタイルも同じ列のまま歩ける。 */
  rowTolerance: number;
  /** 足場として使う最小の幅 (可視部分 + 余白)。 */
  minSegmentWidth: number;
  /** ジャンプできる水平の隙間・上る高さ・下りる高さの上限 (CSS px)。 */
  jumpMaxGap: number;
  jumpMaxRise: number;
  jumpMaxDrop: number;
}

export const DEFAULT_TERRAIN: TerrainParams = {
  clearanceTop: 3,
  clearanceSide: 4,
  cornerInset: 12,
  joinGap: 12,
  rowTolerance: 3,
  minSegmentWidth: SPRITE.width + 8,
  jumpMaxGap: 110,
  jumpMaxRise: 48,
  jumpMaxDrop: 90,
};

export interface TimingParams {
  /** 画面の表示後、登場するまでの待ち時間 (入場アニメーションが落ち着いてから計測する)。 */
  enterDelayMs: [number, number];
  /** DOM の変化・リサイズのあと、計測し直すまでの待ち時間。 */
  remeasureDebounceMs: number;
  /** スクロールが止まったと判断するまでの時間。 */
  scrollIdleMs: number;
  /** 眠っているときに操作があったら目覚める確率 (気まぐれ)。 */
  wakeOnActivityChance: number;
}

/** 触れ合い (タップ・クリック・カーソル・スクロール) の判定と反応の調整値。 */
export interface InteractionParams {
  /** 短いタップとみなす押下の長さ・指の移動の上限。 */
  tapMaxMs: number;
  tapMaxMove: number;
  /** 触れた判定を表示枠より広げる量 (CSS px)。 */
  touchSlop: number;
  /** 背後 (しっぽ側の外) とみなす幅。 */
  behindWidth: number;
  /** 近くのタップに近づく範囲と確率。 */
  approachRange: number;
  approachChance: number;
  /** この時間内にこの回数触られたら逃げる。 */
  fleeWindowMs: number;
  fleeTouches: number;
  /** 反応のあと、次の反応まで空ける時間 (反応しっぱなしにしない)。 */
  reactionCooldownMs: number;
  /** PC のカーソル: 近いとみなす距離、静止とみなす時間、近づく・のぞく確率、判定の間隔。 */
  cursorNear: number;
  cursorStillMs: number;
  cursorApproachChance: number;
  cursorPeekChance: number;
  cursorCheckMs: number;
  /** 速いカーソル・速いスクロールとみなす速さ (CSS px / 秒)。 */
  fastCursor: number;
  fastScroll: number;
}

export const DEFAULT_INTERACTION: InteractionParams = {
  tapMaxMs: 350,
  tapMaxMove: 8,
  touchSlop: 6,
  behindWidth: 16,
  approachRange: 160,
  approachChance: 0.5,
  fleeWindowMs: 5_000,
  fleeTouches: 3,
  reactionCooldownMs: 900,
  cursorNear: 140,
  cursorStillMs: 1_500,
  cursorApproachChance: 0.25,
  cursorPeekChance: 0.12,
  cursorCheckMs: 700,
  fastCursor: 1_800,
  fastScroll: 2_500,
};

export const DEFAULT_TIMING: TimingParams = {
  enterDelayMs: [1_200, 2_600],
  remeasureDebounceMs: 200,
  scrollIdleMs: 260,
  wakeOnActivityChance: 0.5,
};
