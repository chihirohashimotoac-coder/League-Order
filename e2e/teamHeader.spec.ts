import { expect, test, type Locator, type Page } from '@playwright/test';
import { clickGenerate } from './ruleQuestions';
import { tab } from './nav';
import { pinFixtureClock, serveN01 } from './n01Server';

/**
 * ヘッダーの「チーム切替 / 管理」。
 *
 * - どの画面からでも、HOME の「切替 / 管理」と同じチーム管理シートを開ける。
 * - スマホ (320px〜) から PC まで、タイトル・戻る・状態バッジ・メニューと重ならず、
 *   はみ出さず、タイトルを縮めない。長いチーム名でも崩れない。
 * - 未保存のオーダーがあるときの切替は、ヘッダーからでも同じ確認を通る。
 *
 * モバイル (Pixel 5) と PC (Desktop Chrome) の両プロジェクトで動く。
 */

const LONG_NAME = 'とても長い名前のダーツチームの正式名称ですよ ABCDEFGHIJKLMNOPQRSTUVWXYZ 0123456789';

const headerTeam = (page: Page): Locator => page.getByTestId('header-team-switch');
const sheet = (page: Page): Locator => page.getByRole('dialog', { name: 'チーム', exact: true });

async function openApp(page: Page): Promise<void> {
  await page.goto('/');
  await page.getByRole('button', { name: 'サンプルで試す' }).click();
  await expect(page.getByRole('heading', { name: 'サンプルチーム', level: 1 })).toBeVisible();
}

async function generate(page: Page): Promise<void> {
  await page.getByRole('button', { name: '新しいオーダーを作る' }).click();
  await expect(page.getByRole('heading', { name: 'オーダー設定' })).toBeVisible();
  await clickGenerate(page);
  await expect(page.getByRole('heading', { name: 'オーダー結果' })).toBeVisible();
}

/** ヘッダーから開いたシートで、使用中のチームの名前を直す。 */
async function renameActiveTeam(page: Page, name: string): Promise<void> {
  await headerTeam(page).click();
  await page.getByRole('button', { name: '編集' }).first().click();
  await page.getByLabel('チーム名').fill(name);
  await page.getByRole('button', { name: '保存', exact: true }).click();
  await page.keyboard.press('Escape');
  await expect(sheet(page)).toHaveCount(0);
}

async function addTeam(page: Page, name: string): Promise<void> {
  await headerTeam(page).click();
  await page.getByRole('button', { name: 'チームを追加' }).click();
  await page.getByLabel('チーム名').fill(name);
  await page.getByRole('button', { name: '保存', exact: true }).click();
  await page.keyboard.press('Escape');
  await expect(sheet(page)).toHaveCount(0);
}

const noSidewaysScroll = async (page: Page): Promise<void> => {
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(1);
};

interface Box {
  name: string;
  x: number;
  y: number;
  width: number;
  height: number;
}

/** ヘッダーの操作部品と文字ブロックの位置。表示されているものだけ。 */
async function headerBoxes(page: Page): Promise<Box[]> {
  return page.evaluate(() => {
    const header = document.querySelector('.app-header');
    if (!header) return [];
    const parts: [string, Element | null][] = [
      ['back-or-brand', header.querySelector('.header-back, .brand-mark')],
      ['titles', header.querySelector('.header-titles')],
      ['badge', header.querySelector('.status, .demo-badge')],
      ['team', header.querySelector('.header-team')],
      ['menu', header.querySelector('.header-menu')],
    ];
    return parts.flatMap(([name, element]) => {
      if (!element) return [];
      const rect = element.getBoundingClientRect();
      return rect.width > 0 ? [{ name, x: rect.x, y: rect.y, width: rect.width, height: rect.height }] : [];
    });
  });
}

function overlaps(a: Box, b: Box): boolean {
  return a.x < b.x + b.width - 0.5 && b.x < a.x + a.width - 0.5 && a.y < b.y + b.height - 0.5 && b.y < a.y + a.height - 0.5;
}

/** ヘッダー内の部品が重ならず、画面の横幅に収まり、ボタンの文字が切れていない。 */
async function expectHeaderIntact(page: Page): Promise<void> {
  const viewport = page.viewportSize()!;
  const boxes = await headerBoxes(page);
  expect(boxes.map((box) => box.name)).toContain('team');
  for (const box of boxes) {
    expect(box.x, `${box.name} の左端`).toBeGreaterThanOrEqual(-0.5);
    expect(box.x + box.width, `${box.name} の右端`).toBeLessThanOrEqual(viewport.width + 0.5);
  }
  for (let i = 0; i < boxes.length; i += 1) {
    for (let j = i + 1; j < boxes.length; j += 1) {
      expect(overlaps(boxes[i], boxes[j]), `${boxes[i].name} と ${boxes[j].name} が重なっている`).toBe(false);
    }
  }
  // ボタンはタップしやすい大きさで、ラベルは省略されない。
  const team = boxes.find((box) => box.name === 'team')!;
  expect(team.height).toBeGreaterThanOrEqual(44);
  expect(team.width).toBeGreaterThanOrEqual(44);
  // ヘッダーは 1 行のまま: ボタンを足しても見える画面は狭くならない (戻る・メニューと同じ高さ)。
  const headerHeight = await page.evaluate(() => document.querySelector('.app-header')!.getBoundingClientRect().height);
  expect(headerHeight).toBeLessThanOrEqual(64);
  const labelClipped = await page.evaluate(() => {
    // 表示されている方のラベル (スマホは短い、PC は長い)。
    const label = [...document.querySelectorAll<HTMLElement>('.header-team > span')].find((span) => span.offsetWidth > 0);
    return label ? label.scrollWidth > label.clientWidth + 1 : true;
  });
  expect(labelClipped).toBe(false);
  await noSidewaysScroll(page);
}

/** 固定のタイトルが省略されていない (「オーダー結果」などの短い見出しだけに使う)。 */
async function expectTitleNotTruncated(page: Page): Promise<void> {
  const truncated = await page.evaluate(() => {
    const title = document.querySelector<HTMLElement>('.app-header h1');
    return title ? title.scrollWidth > title.clientWidth + 1 : true;
  });
  expect(truncated).toBe(false);
}

test.describe('ヘッダーのチーム切替 / 管理', () => {
  test('どの画面でも見え、HOME のボタンと同じシートを開き、Escape で閉じて元のボタンに戻る', async ({ page }) => {
    await openApp(page);

    // 文字で役割が分かる (スマホは「チーム切替」、PC は「チーム切替 / 管理」)。
    await expect(headerTeam(page)).toContainText(/チーム切替/);
    await expect(headerTeam(page).locator('span:visible')).toHaveText(page.viewportSize()!.width >= 600 ? 'チーム切替 / 管理' : 'チーム切替');
    await expect(headerTeam(page)).toHaveAccessibleName('チーム切替 / 管理');

    // HOME の既存ボタン。
    await page.getByRole('button', { name: '切替 / 管理', exact: true }).click();
    await expect(sheet(page)).toBeVisible();
    const homeRows = await sheet(page).locator('li').allInnerTexts();
    await page.keyboard.press('Escape');
    await expect(sheet(page)).toHaveCount(0);
    await expect(page.getByRole('button', { name: '切替 / 管理', exact: true })).toBeFocused();

    // ホーム以外の画面すべて。
    for (const name of ['観戦', '分析', 'オーダー', 'その他', 'メンバー', '履歴']) {
      await tab(page, name).click();
      await expect(headerTeam(page)).toBeVisible();
    }
    await headerTeam(page).click();
    await expect(sheet(page)).toBeVisible();
    expect(await sheet(page).locator('li').allInnerTexts()).toEqual(homeRows);
    await expect(sheet(page).getByRole('button', { name: 'チームを追加' })).toBeVisible();
    await expect(sheet(page).getByRole('button', { name: 'n01から新規作成' })).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(sheet(page)).toHaveCount(0);
    await expect(headerTeam(page)).toBeFocused();
  });

  test('スクロールしてもヘッダーから開ける', async ({ page }) => {
    await openApp(page);
    await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
    await expect.poll(() => page.evaluate(() => window.scrollY)).toBeGreaterThan(100);
    const box = await headerTeam(page).boundingBox();
    expect(box!.y).toBeGreaterThanOrEqual(0);
    await headerTeam(page).click();
    await expect(sheet(page)).toBeVisible();
  });

  test('ヘッダーから切替・追加・編集ができ、使用中のチーム表示が切替の前後で正しい', async ({ page }) => {
    await openApp(page);
    await addTeam(page, 'Bチーム');
    await tab(page, 'メンバー').click();
    await expect(page.getByText('青木').first()).toBeVisible();

    await headerTeam(page).click();
    const rows = sheet(page).locator('.list-row.grow');
    await expect(rows.filter({ hasText: 'サンプルチーム' })).toContainText('使用中');
    await expect(rows.filter({ hasText: 'Bチーム' })).not.toContainText('使用中');
    await rows.filter({ hasText: 'Bチーム' }).click();
    await expect(sheet(page)).toHaveCount(0);
    // 切替後: ヘッダーのボタンの名前、メンバー画面 (別チームの選手が出ない)、一覧の使用中。
    await expect(page.locator('.app-header')).toContainText('Bチーム');
    await expect(page.getByText('青木')).toHaveCount(0);
    await headerTeam(page).click();
    await expect(rows.filter({ hasText: 'Bチーム' })).toContainText('使用中');
    await expect(rows.filter({ hasText: 'サンプルチーム' })).not.toContainText('使用中');
  });

  test('未保存のオーダーがあるとき、ヘッダーからの切替も確認を通り、キャンセルで作業が残る', async ({ page }) => {
    await openApp(page);
    await addTeam(page, 'Bチーム');
    await tab(page, 'ホーム').click();
    await generate(page); // 保存していない下書き

    // ホーム以外の画面 (結果画面) のまま、ヘッダーから切り替える。
    await headerTeam(page).click();
    await sheet(page).locator('.list-row.grow').filter({ hasText: 'Bチーム' }).click();
    const dialog = page.getByRole('dialog', { name: 'チームを切り替える' });
    await expect(dialog).toContainText('保存されていない変更');
    await dialog.getByRole('button', { name: 'キャンセル' }).click();
    await expect(dialog).toHaveCount(0);
    // キャンセルしてもチームも作業中のオーダーも変わらない。
    await page.keyboard.press('Escape');
    await expect(sheet(page)).toHaveCount(0);
    await expect(page.locator('.app-header')).toContainText('サンプルチーム');
    await expect(page.getByRole('heading', { name: 'オーダー結果' })).toBeVisible();
    await tab(page, 'ホーム').click();
    await expect(page.getByRole('button', { name: '作業中のオーダーを開く' })).toBeVisible();

    // 承認すると切り替わり、作業中のオーダーは別チームに持ち越されない。
    await headerTeam(page).click();
    await sheet(page).locator('.list-row.grow').filter({ hasText: 'Bチーム' }).click();
    await page.getByRole('button', { name: '破棄して切り替える' }).click();
    await expect(page.getByRole('heading', { name: 'Bチーム', level: 1 })).toBeVisible();
    await expect(page.getByRole('button', { name: '作業中のオーダーを開く' })).toHaveCount(0);
  });

  test('チームが 1 件だけでも使え、最後の 1 件は削除できない', async ({ page }) => {
    await openApp(page);
    await headerTeam(page).click();
    await expect(sheet(page).locator('li')).toHaveCount(1);
    await expect(sheet(page).locator('.list-row.grow')).toContainText('使用中');
    await page.getByRole('button', { name: '編集' }).click();
    await expect(page.getByRole('button', { name: '削除', exact: true })).toHaveCount(0);
  });
});

test.describe('ヘッダーの表示 (狭いスマホから PC まで)', () => {
  const sizes = [
    { width: 320, height: 640 },
    { width: 360, height: 740 },
    { width: 390, height: 844 },
    { width: 599, height: 800 },
    { width: 600, height: 800 },
    { width: 768, height: 1024 },
    { width: 1280, height: 800 },
    { width: 1920, height: 1080 },
  ];

  test('ホーム・結果・その他の画面で、重ならず・はみ出さず・タイトルを縮めない', async ({ page }) => {
    await openApp(page);
    await generate(page);
    for (const size of sizes) {
      await page.setViewportSize(size);
      // 結果画面: 戻る・タイトル・状態バッジ (DRAFT)・チーム・メニューがすべて並ぶ最も混んだ画面。
      await expect(page.getByRole('heading', { name: 'オーダー結果' })).toBeVisible();
      await expectHeaderIntact(page);
      await expectTitleNotTruncated(page);
      await tab(page, 'その他').click();
      await expectHeaderIntact(page);
      await expectTitleNotTruncated(page);
      await tab(page, 'ホーム').click();
      await expectHeaderIntact(page);
      await page.getByRole('button', { name: '作業中のオーダーを開く' }).click();
    }
  });

  test('長いチーム名でも崩れず、シートの一覧もはみ出さない', async ({ page }) => {
    await openApp(page);
    await renameActiveTeam(page, LONG_NAME);
    await addTeam(page, 'B');
    for (const size of sizes) {
      await page.setViewportSize(size);
      await tab(page, 'ホーム').click();
      await expectHeaderIntact(page);
      await tab(page, '分析').click();
      await expectHeaderIntact(page);
      await headerTeam(page).click();
      await expect(sheet(page)).toBeVisible();
      const sheetBox = await sheet(page).boundingBox();
      for (const row of await sheet(page).locator('.list-row').all()) {
        const box = await row.boundingBox();
        expect(box!.x + box!.width).toBeLessThanOrEqual(sheetBox!.x + sheetBox!.width + 1);
      }
      await noSidewaysScroll(page);
      await page.keyboard.press('Escape');
      await expect(sheet(page)).toHaveCount(0);
      // ハンバーガーメニューにも同じ名前が出る。
      await page.getByRole('button', { name: 'メニューを開く' }).click();
      await expect(page.getByRole('dialog', { name: 'メニュー' })).toBeVisible();
      await noSidewaysScroll(page);
      await page.keyboard.press('Escape');
      await expect(page.getByRole('dialog', { name: 'メニュー' })).toHaveCount(0);
    }
  });
});

test.describe('チームが未登録のとき', () => {
  test.use({ serviceWorkers: 'block' });

  test('観戦だけの画面にはチーム切替を出さず、既存の「チームを登録」を残す', async ({ page }) => {
    await pinFixtureClock(page);
    await serveN01(page);
    await page.goto('/');
    await page.getByRole('group', { name: 'よく使われるリーグ' }).getByRole('button', { name: 'ATDO' }).click();
    await expect(page.getByTestId('watch-page')).toBeVisible();
    await expect(headerTeam(page)).toHaveCount(0);
    await expect(page.locator('.app-header').getByRole('button', { name: 'チームを登録' })).toBeVisible();
    await tab(page, 'ホーム').click();
    await expect(headerTeam(page)).toHaveCount(0);
    await noSidewaysScroll(page);
  });

  test('最初の画面 (チームもリーグもない) にヘッダーはなく、切替の入口も出ない', async ({ page }) => {
    await page.goto('/');
    await expect(page.getByRole('button', { name: 'サンプルで試す' })).toBeVisible();
    await expect(headerTeam(page)).toHaveCount(0);
  });
});
