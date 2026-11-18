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
  /** 行動ごとの基本の重み (相対値)。idle は「何もしない・様子を見る」を含む。 */
  weights: { idle: number; walk: number; sleep: number };
  /** 直前と同じ行動の重みに掛ける係数 / 直前 2 回とも同じときの係数 (機械的な連続を防ぐ)。 */
  repeatPenalty: number;
  repeatTwicePenalty: number;
  /** 無操作がこの時間続くと、眠る重みを sleepWhenInactive に上げる。 */
  inactiveSleepAfterMs: number;
  sleepWhenInactive: number;
  /** 待機の長さ (最小・最大)。 */
  idleMs: [number, number];
  /** 眠りの長さ (最小・最大)。 */
  sleepMs: [number, number];
  /** 歩く距離 (最小・最大, CSS px)。最小距離を取れない足場では歩かない。 */
  walkDistance: [number, number];
  /** 歩く速さ (CSS px / 秒)。歩行 4 コマの 1 周期で進む距離と合わせ、足が滑って見えないようにする。 */
  walkSpeed: number;
}

export const DEFAULT_BEHAVIOR: BehaviorParams = {
  weights: { idle: 4, walk: 3, sleep: 0.35 },
  repeatPenalty: 0.4,
  repeatTwicePenalty: 0.12,
  inactiveSleepAfterMs: 45_000,
  sleepWhenInactive: 6,
  idleMs: [2_500, 7_000],
  sleepMs: [12_000, 40_000],
  walkDistance: [18, 150],
  walkSpeed: 20,
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
}

export const DEFAULT_ANIMATION: AnimationParams = {
  walkFrameMs: 170,
  sleepFrameMs: 500,
  wakeFrameMs: 260,
  blinkEveryMs: [3_500, 6_500],
  blinkMs: 160,
  fadeMs: 240,
};

export interface TerrainParams {
  /** キャラクターの上・左右に空ける余白 (CSS px)。文字や操作部品にぎりぎりまで寄せない。 */
  clearanceTop: number;
  clearanceSide: number;
  /** 足場の角 (角丸) を避ける最小の内側余白 (CSS px)。 */
  cornerInset: number;
  /** 隣り合う足場を 1 本につなぐ最大の隙間 (CSS px)。同じ高さのタイル列を歩けるようにする。 */
  joinGap: number;
  /** 足場として使う最小の幅 (可視部分 + 余白)。 */
  minSegmentWidth: number;
}

export const DEFAULT_TERRAIN: TerrainParams = {
  clearanceTop: 3,
  clearanceSide: 4,
  cornerInset: 12,
  joinGap: 12,
  minSegmentWidth: SPRITE.width + 8,
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

export const DEFAULT_TIMING: TimingParams = {
  enterDelayMs: [1_200, 2_600],
  remeasureDebounceMs: 200,
  scrollIdleMs: 260,
  wakeOnActivityChance: 0.5,
};
