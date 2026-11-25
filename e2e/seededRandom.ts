import type { Page } from '@playwright/test';

/**
 * ページの `Math.random` を、決まった種から同じ列を返す乱数に置き換える (テスト専用)。
 *
 * ハリマルの気まぐれな動作の抽選 (controller.ts の既定の乱数は `Math.random`) を、実行ごとに同じにするために使う。
 * 本番のコードの抽選は変えない (ページに読み込む前に、テストのブラウザーの中だけで差し替える)。
 * 乱数は mulberry32 (32 ビットの状態の小さな擬似乱数)。
 */
export async function seedRandom(page: Page, seed: number): Promise<void> {
  await page.addInitScript((initial: number) => {
    let state = initial >>> 0;
    Math.random = () => {
      state = (state + 0x6d2b79f5) >>> 0;
      let t = state;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }, seed);
}
