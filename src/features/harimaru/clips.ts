/**
 * 動作と素材 (スプライトのコマ) の対応表。
 *
 * - 素材 v0.2 (待機・歩行・睡眠の 12 コマ) と、追加素材 v0.9 (14 動作・68 コマ、sprite.ts の CLIPS) で描く。
 * - `available: false` の動作は選ばない (代わりの見た目で埋めない)。v0.9 の動作は、さらにその画像を読み込めた
 *   ときだけ選ぶ (読み込めなければ選ばない。駆け足・喜ぶは v0.2 のコマで代わりに描く)。
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
  run: { label: '急に駆け出す', available: true, how: 'v0.9 の走りコマ 1〜4 (読み込めないときは歩行コマを速く再生)' },
  hop: { label: 'その場で跳ねる', available: true, how: '待機コマ 1 のまま上下に移動 (CSS)。上に空きがあるときだけ' },
  sleep: { label: '眠る・目覚める', available: true, how: '睡眠コマ 1〜4 (目覚めは逆順)' },
  groom: { label: '毛づくろい', available: true, how: 'v0.9 の毛づくろいコマ 1〜5 (前足で鼻先をぬぐう)' },
  stretch: { label: '伸び', available: true, how: 'v0.9 の伸びコマ 1〜5 (眠り・休みのあとに選ばれやすい)' },

  jump: { label: 'カード間をジャンプ', available: true, how: '踏切・空中は歩行コマ 2、着地は待機コマ 1。放物線の移動 (CSS)。経路が安全なときだけ' },
  hide: { label: 'カード裏に隠れる', available: true, how: '待機コマ 1 をカード上辺の線で切り取りながら沈める (CSS マスク)' },
  peek: { label: 'カード裏から顔を出す', available: true, how: '同じマスクで耳と目だけを出す (待機コマ 1・3)' },
  slip: { label: '縁で足を滑らせる', available: true, how: 'v0.9 の滑るコマ 1〜5。基準点を縁の線の掴む点に合わせて下へずらす (カード上辺の直線部分で、下の文字・操作部品に重ならないときだけ)' },
  hang: { label: '前足でしがみつき、後ろ足をバタバタ', available: true, how: 'v0.9 のしがみつきコマ 1〜4 をループ。前足を縁の線に固定し、体はカードの前に出す (切り取らない)' },
  climb: { label: 'よじ登る', available: true, how: 'v0.9 のよじ登りコマ 1〜6。コマごとの基準点で引き上げ、最後は待機コマ 1 で立つ' },
  sleepyFall: { label: '寝ぼけて落ちそうになる', available: true, how: 'v0.9 の寝ぼけるコマ 1〜4 (眠りの途中でぐらつき、目を開けて伏せる)' },
  tumble: { label: '着地失敗・高速スクロールで転ぶ → 復帰', available: true, how: 'v0.9 の転ぶコマ 1〜7。横のずれに合わせて前へ転がり、待機コマ 1 で起き上がる' },

  happy: { label: 'タップ・顔に触れて喜ぶ', available: true, how: 'v0.9 の喜ぶコマ 1〜4 と小さく 2 回跳ねる (CSS)。読み込めないときは待機コマ 1 で跳ねるだけ' },
  turn: { label: '背中・しっぽに触れて振り向く', available: true, how: '左右の向きの切り替え' },
  surprise: { label: '背後から触れて驚く', available: true, how: 'v0.9 の驚くコマ 1〜5 と小さく跳び上がる (CSS)。そのあと触れた方へ振り向く' },
  flee: { label: '何度も触られて逃げる', available: true, how: '駆け足で離れ、カード裏に隠れて別の場所へ' },
  approach: { label: 'カーソル・タップに近づく', available: true, how: '歩行で近くまで行き、そちらを向く' },
  lookUp: { label: '静止したカーソルを見上げる', available: true, how: 'v0.9 の見上げるコマ 1〜5 (頭の上で止まったカーソル)' },
  tilt: { label: '首をかしげる', available: true, how: 'v0.9 の首をかしげるコマ 1〜5 (近くで止まったカーソル、近くの余白へのタップ)' },
  play: { label: '速く動くカーソルにじゃれる', available: true, how: 'v0.9 のじゃれるコマ 1〜5 (近くを速く動くカーソルの方を向いて)' },
  cursorHang: { label: 'PC でカーソルにぶら下がる', available: true, how: 'v0.9 のぶら下がりコマ 1〜4 をループ。左右反転して前足の基準点をカーソルの先端に合わせる。カーソルが動いたら放して足場へ戻る' },
};

export function isAvailable(id: MotionId, motions: Record<MotionId, MotionSpec> = MOTIONS): boolean {
  return motions[id]?.available === true;
}
