import type { ThrowLeg } from '../parse';

/**
 * 終了した Leg の選択欄 (ライブの過去 Leg・終了したゲーム/セットの Leg) に共通の文言。
 * 「Leg 番号 → 勝者名 → 記録済みなら本数」の順に読めるよう、名前と本数をここでそろえる。
 */

/** 名前の最初の語 (チップ用): 「青木 一郎 / 井上 次郎」 → 「青木」。長い名前は 6 文字 + 「…」。 */
export const shortName = (name: string): string => {
  const first = name.split('/')[0].trim().split(/\s+/u)[0] ?? name;
  return first.length > 7 ? `${first.slice(0, 6)}…` : first;
};

/** 勝った側が使った本数 (n01 の記録があればそれ、なければ投擲から数える)。数えられなければ `null`。 */
export function legDarts(entry: Pick<ThrowLeg, 'dartsTotal' | 'throws'>, winner: 0 | 1): number | null {
  const total = entry.dartsTotal?.[winner] ?? entry.throws.filter((t) => t.side === winner).reduce((sum, t) => sum + (t.kind === '01' ? t.darts : 3), 0);
  return total > 0 ? total : null;
}
