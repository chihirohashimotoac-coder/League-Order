/**
 * 動作と素材 (スプライトのコマ) の対応表。
 *
 * - 素材 v0.2 にあるのは待機・歩行・睡眠の 3 行 (12 コマ) だけ。ここに載っている動作だけを描く。
 * - 専用の素材が必要な動作は `needs` に必要な素材を書き、`available: false` にしておく。行動の抽選・
 *   操作への反応はこの表を見て、素材のない動作を選ばない (代わりの見た目で埋めない)。
 *   素材が届いたら、コマを sprite.ts に足して `available: true` にするだけで有効になる。
 * - 「CSS で表現」は、コマを変形させずに位置・向き・マスクだけを動かすもの (体格・顔・針は崩さない)。
 */

export type MotionId =
  // 日常
  | 'idle' | 'rest' | 'look' | 'walk' | 'run' | 'hop' | 'sleep' | 'groom' | 'stretch'
  // UI アスレチック
  | 'jump' | 'hide' | 'peek' | 'slip' | 'hang' | 'climb' | 'sleepyFall' | 'tumble'
  // 触れ合い
  | 'happy' | 'turn' | 'surprise' | 'flee' | 'approach' | 'lookUp' | 'tilt' | 'play' | 'cursorHang';

export interface MotionSpec {
  label: string;
  /** いまの素材で描けるか。 */
  available: boolean;
  /** 描き方 (既存素材 / CSS) 、または必要な素材。 */
  how: string;
}

export const MOTIONS: Record<MotionId, MotionSpec> = {
  idle: { label: '立ち止まる・待機', available: true, how: '待機コマ 1 (ときどき瞬きのコマ 2)' },
  rest: { label: '何もせず休む (伏せる)', available: true, how: '睡眠コマ 1 (目を開けて伏せる) と瞬きのコマ 2' },
  look: { label: '周囲を見る', available: true, how: '待機コマ 3 (少し正面を向く) と左右の向きの切り替え' },
  walk: { label: 'とことこ歩く', available: true, how: '歩行コマ 1〜4' },
  run: { label: '急に駆け出す', available: true, how: '歩行コマ 1〜4 を速く再生 (専用の走りコマがあればより自然)' },
  hop: { label: 'その場で跳ねる', available: true, how: '待機コマ 1 のまま上下に移動 (CSS)。上に空きがあるときだけ' },
  sleep: { label: '眠る・目覚める', available: true, how: '睡眠コマ 1〜4 (目覚めは逆順)' },
  groom: { label: '毛づくろい', available: false, how: '素材待ち: 前足をなめる・顔を洗うコマ 4〜6' },
  stretch: { label: '伸び', available: false, how: '素材待ち: 前足を伸ばして背を反らすコマ 3〜4' },

  jump: { label: 'カード間をジャンプ', available: true, how: '踏切・空中は歩行コマ 2、着地は待機コマ 1。放物線の移動 (CSS)。経路が安全なときだけ' },
  hide: { label: 'カード裏に隠れる', available: true, how: '待機コマ 1 をカード上辺の線で切り取りながら沈める (CSS マスク)' },
  peek: { label: 'カード裏から顔を出す', available: true, how: '同じマスクで耳と目だけを出す (待機コマ 1・3)' },
  slip: { label: '縁で足を滑らせる', available: false, how: '素材待ち: 片足が縁から外れて体が傾くコマ 2〜3' },
  hang: { label: '前足でしがみつき、後ろ足をバタバタ', available: false, how: '素材待ち: 前足 2 本で縁をつかみ、後ろ足を振るコマ 4' },
  climb: { label: 'よじ登る', available: false, how: '素材待ち: 縁に体を引き上げるコマ 4〜6' },
  sleepyFall: { label: '寝ぼけて落ちそうになる', available: false, how: '素材待ち: 丸まったまま縁でぐらつき、はっと起きるコマ 3〜4' },
  tumble: { label: '着地失敗・高速スクロールで転ぶ → 復帰', available: false, how: '素材待ち: 転がるコマ 4〜6、起き上がるコマ 3〜4' },
  // ※ available: false の動作は、発生条件 (いつ起きるか) だけ実装済み。素材と一緒に描画の処理を足す。

  happy: { label: 'タップ・顔に触れて喜ぶ', available: true, how: '待機コマ 1 で小さく 2 回跳ねる (CSS)。うれしい表情のコマがあればより自然' },
  turn: { label: '背中・しっぽに触れて振り向く', available: true, how: '左右の向きの切り替え' },
  surprise: { label: '背後から触れて驚く', available: false, how: '素材待ち: 目を見開いて針が逆立つコマ 2〜3。素材が届くまでは、背後から触れても「振り向く」反応にする' },
  flee: { label: '何度も触られて逃げる', available: true, how: '駆け足で離れ、カード裏に隠れて別の場所へ' },
  approach: { label: 'カーソル・タップに近づく', available: true, how: '歩行で近くまで行き、そちらを向く' },
  lookUp: { label: '静止したカーソルを見上げる', available: false, how: '素材待ち: 顔を上げて上を見るコマ 2' },
  tilt: { label: '首をかしげる', available: false, how: '素材待ち: 頭だけを傾けるコマ 2〜3 (体ごとの回転は顔・体格が崩れるため使わない)' },
  play: { label: '速く動くカーソルにじゃれる', available: false, how: '素材待ち: 前足で空中をたたくコマ 3〜4' },
  cursorHang: { label: 'PC でカーソルにぶら下がる', available: false, how: '素材待ち: 前足でつかまってぶら下がるコマ 2〜4 (つかむ点の位置指定つき)' },
};

export function isAvailable(id: MotionId, motions: Record<MotionId, MotionSpec> = MOTIONS): boolean {
  return motions[id]?.available === true;
}
