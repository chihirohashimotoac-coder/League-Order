import { expect, test, type Page } from '@playwright/test';
import { serveNight } from './liveNight';
import { serveBrowse } from './browseWorld';
import type { BrowseControl } from './browseWorld';
import { serveNowCompetition } from './setMatchWorld';
import { expectNoAxeViolations } from './axe';
import { BROWSE_ATDO, BROWSE_JDO_EVENT, ONLINE_MID, browseLeagueRows, browseTournamentRows } from '../src/test/n01/browse';

/**
 * 観戦の「n01オンライン → n01トーナメント → n01リーグ」(公式メニューと同じ順) を、通信なしの n01 で。
 * 取得条件と n01 の並び、検索・空・エラー・ページング、大会・リーグ・試合を開いて戻ったときの復元、
 * 狭い画面の表示、キーボード操作、axe (WCAG 2.1 AA) を確かめる。
 */

test.use({ serviceWorkers: 'block' });

const noSidewaysScroll = async (page: Page): Promise<void> => {
  expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(1);
};

async function start(page: Page, control: BrowseControl = { log: [] }): Promise<BrowseControl> {
  await serveNight(page);
  await serveNowCompetition(page);
  await serveBrowse(page, control);
  await page.goto('/#/watch');
  return control;
}

const entries = (page: Page) => page.getByRole('group', { name: 'n01 の一覧から探す' });
const keys = (page: Page) => page.getByTestId('browse-list').locator('[data-browse-key]').evaluateAll((rows) => rows.map((row) => row.getAttribute('data-browse-key')));

test('観戦の初期画面: 3 つの一覧が公式メニューと同じ順に並び、既存のリーグ・団体・検索も使える', async ({ page }) => {
  await start(page);
  const buttons = entries(page).getByRole('button');
  await expect(buttons).toHaveText(['n01オンライン', 'n01トーナメント', 'n01リーグ']);
  await expect(page.getByText('いま n01 で進行中', { exact: true })).toHaveCount(0);
  await expect(page.getByRole('group', { name: 'よく使われるリーグ' }).getByRole('button')).toHaveText(['ATDO', 'TDO', 'TDA']);
  await expect(page.getByRole('button', { name: 'JDO の大会・リーグを探す' })).toBeVisible();
  await expect(page.getByRole('textbox', { name: 'リーグ・大会を検索' })).toBeVisible();
  // 見るものを変更 (シート) にも同じ 3 つ。
  await page.getByRole('group', { name: 'よく使われるリーグ' }).getByRole('button', { name: 'ATDO' }).click();
  await page.getByRole('button', { name: /見るものを変更/ }).click();
  await expect(page.getByRole('dialog').getByRole('group', { name: 'n01 の一覧から探す' }).getByRole('button')).toHaveText(['n01オンライン', 'n01トーナメント', 'n01リーグ']);
  await page.getByRole('button', { name: '閉じる' }).click();
  // リーグの観戦画面の下にも、同じ順で。
  await expect(page.getByRole('navigation', { name: 'n01 の一覧から探す' }).getByRole('button')).toHaveText(['n01オンライン', 'n01トーナメント', 'n01リーグ']);
});

test('n01トーナメント: 公式の初期表示と同じ条件で n01 の並びのまま、続きは重複なしで後ろに足す', async ({ page }) => {
  const control = await start(page);
  await entries(page).getByRole('button', { name: 'n01トーナメント' }).click();
  await expect(page.getByRole('heading', { name: 'n01トーナメント' })).toBeVisible();
  await expect(page.getByTestId('browse-tournament')).toHaveCount(30);
  const fixture = browseTournamentRows().map((row) => row.tdid);
  expect(await keys(page)).toEqual(fixture.slice(0, 30));
  const first = control.log.find((entry) => entry.startsWith('tournament/list'))!;
  const params = new URLSearchParams(first.split('?')[1]);
  expect(Object.fromEntries(params)).toMatchObject({ sort: 'updateTime', order: 'desc', count: '30', league__ne: '1', status__in: '10,20,25,30,40' });
  expect(params.has('skip')).toBe(false);
  // 読み込んだ件数と、続きの有無 (全体の件数は n01 から取れない)。
  await expect(page.getByTestId('browse-count')).toHaveText('読み込み済み 30 件 ・ 続きあり');
  await expect(page.getByTestId('browse-meta')).toContainText('アクティブ順');
  // 状態は文字で、開催日時の未登録も区別して。lgid を持つ大会・同じ名前の別の大会も並ぶ。
  const rows = page.getByTestId('browse-tournament');
  await expect(rows.nth(0)).toContainText('開催中');
  await expect(rows.nth(2)).toContainText('受付中');
  await expect(rows.nth(2)).toContainText('開催日時 未登録');
  await expect(rows.nth(4)).toContainText('準備中');
  await expect(rows.nth(6)).toContainText('終了');
  await expect(rows.nth(7)).toContainText('表作成中');
  await expect(rows.filter({ hasText: 'Weekly Cup' })).toHaveCount(2);
  await expect(rows.nth(3)).toContainText('Хантайшир самбар');

  await page.getByTestId('browse-more').click();
  await expect(rows).toHaveCount(45);
  expect(await keys(page)).toEqual(fixture);
  const second = new URLSearchParams(control.log.filter((entry) => entry.startsWith('tournament/list'))[1].split('?')[1]);
  expect(second.get('skip')).toBe('30');
  await expect(page.getByTestId('browse-count')).toHaveText('読み込み済み 45 件');
  await expect(page.getByText('n01 の一覧の最後まで読み込みました。')).toBeVisible();
  await noSidewaysScroll(page);
});

test('n01トーナメント: 名称で検索 (0 件は検索結果 0 件として)、大会を開いて戻ると検索語・位置・フォーカスが戻る', async ({ page }) => {
  const control = await start(page);
  await entries(page).getByRole('button', { name: 'n01トーナメント' }).click();
  const search = page.getByRole('searchbox', { name: '大会名で検索' });
  await search.fill('zzz-none');
  await search.press('Enter');
  await expect(page.getByTestId('browse-empty')).toHaveText('「zzz-none」に一致する大会は見つかりませんでした。');
  await search.fill('Weekly');
  await page.getByRole('button', { name: '検索', exact: true }).click();
  await expect(page.getByTestId('browse-tournament')).toHaveCount(2);
  expect(control.log.some((entry) => entry.includes('keyword=Weekly') && entry.includes('sort=updateTime'))).toBe(true);
  await page.getByRole('button', { name: 'クリア' }).click();
  await expect(page.getByTestId('browse-tournament')).toHaveCount(30);

  await search.fill('Sample');
  await search.press('Enter');
  const row = page.getByTestId('browse-tournament').filter({ hasText: 'Sample Open' });
  await expect(row).toHaveCount(1);
  // キーボードで開く。
  await row.focus();
  await page.keyboard.press('Enter');
  await expect(page.getByTestId('tournament-hub')).toBeVisible();
  expect(page.url()).toContain(`k=${BROWSE_JDO_EVENT}`);
  await expect(page.getByTestId('browse-view')).toHaveCount(0);
  await page.getByTestId('back-to-browse').click();
  await expect(page.getByTestId('browse-view')).toBeVisible();
  await expect(search).toHaveValue('Sample');
  await expect(page.getByTestId('browse-tournament')).toHaveCount(1);
  await expect(row).toBeFocused();
  await expect(row).toHaveAttribute('aria-current', 'true');
});

test('n01トーナメント: 一覧の途中から開いて、ブラウザの戻るでスクロール位置とフォーカスが戻る', async ({ page }) => {
  await start(page);
  await page.setViewportSize({ width: 390, height: 700 });
  await entries(page).getByRole('button', { name: 'n01トーナメント' }).click();
  await page.getByTestId('browse-more').click();
  await expect(page.getByTestId('browse-tournament')).toHaveCount(45);
  // 下のほうの行 (41 件目) を開く。
  const row = page.getByTestId('browse-tournament').nth(40);
  await row.scrollIntoViewIfNeeded();
  const before = await page.evaluate(() => window.scrollY);
  expect(before).toBeGreaterThan(300);
  await row.click();
  await expect(page.getByTestId('tournament-hub')).toBeVisible();
  await page.goBack();
  await expect(page.getByTestId('browse-view')).toBeVisible();
  await expect(page.getByTestId('browse-tournament')).toHaveCount(45);
  await expect.poll(() => page.evaluate(() => window.scrollY)).toBe(before);
  await expect(row).toBeFocused();
  await expect(row).toHaveAttribute('aria-current', 'true');
});

test('n01リーグ: 公式と同じ団体単位で並び、選んだリーグのシーズン観戦を開く。戻ると一覧', async ({ page }) => {
  const control = await start(page);
  await entries(page).getByRole('button', { name: 'n01リーグ' }).click();
  await expect(page.getByTestId('browse-league')).toHaveCount(30);
  expect(await keys(page)).toEqual(browseLeagueRows().slice(0, 30).map((row) => row.lgid));
  const params = new URLSearchParams(control.log.find((entry) => entry.startsWith('league/list'))!.split('?')[1]);
  expect(Object.fromEntries(params)).toMatchObject({ sort: 'updateTime', order: 'desc', count: '30' });
  // 選んでいないカテゴリは読まない。
  expect(control.log.some((entry) => entry.startsWith('tournament/list'))).toBe(false);
  expect(control.log.some((entry) => entry.includes('tdid__exists'))).toBe(false);
  await expect(page.getByTestId('browse-league').nth(3)).toContainText('東京ダーツオーガニゼイション【TDO / Tokyo Darts Organization】');
  await page.getByTestId('browse-more').click();
  await expect(page.getByTestId('browse-league')).toHaveCount(35);
  expect(await keys(page)).toEqual(browseLeagueRows().map((row) => row.lgid));

  await page.getByTestId('browse-league').first().click();
  expect(page.url()).toContain(`l=${BROWSE_ATDO}`);
  await expect(page.getByTestId('live-board')).toBeVisible();
  await expect(page.getByLabel('シーズン')).toBeVisible();
  // 「日程・結果」で対戦カードを開いた (履歴が 1 つ増えた) 状態からでも、一覧へ戻る。
  await page.getByRole('tab', { name: '日程・結果' }).click();
  await page.getByTestId('match-card').first().click();
  await expect.poll(() => page.url()).toContain('c=');
  await page.getByTestId('back-to-browse').click();
  await expect(page.getByTestId('browse-league')).toHaveCount(35);
  await expect(page.getByTestId('browse-league').first()).toBeFocused();
});

test('n01オンライン: 公式ロビーへのリンクと、大会・リーグ・中継を除いた公開試合。試合を開いて戻ると一覧', async ({ page }) => {
  const control = await start(page);
  await entries(page).getByRole('button', { name: 'n01オンライン' }).click();
  const lobby = page.getByTestId('official-lobby');
  await expect(lobby).toHaveAttribute('href', 'https://n01darts.com/n01/online/');
  await expect(lobby).toHaveAttribute('target', '_blank');
  await expect(page.getByRole('heading', { name: '観戦できる公開試合' })).toBeVisible();
  const rows = page.getByTestId('browse-online');
  await expect(rows).toHaveCount(4);
  expect(await keys(page)).toEqual([ONLINE_MID, 'Onl1Demo_1799999900000', 'Onl2Demo_1799999600000', 'Onl3Demo_1799999500000']);
  await expect(page.getByTestId('browse-notes')).toContainText('2 行は掲載していません');
  const params = new URLSearchParams(control.log.find((entry) => entry.includes('tdid__exists'))!.split('?')[1]);
  expect(Object.fromEntries(params)).toMatchObject({ live: '1', endMatch: '0', tdid__exists: '0', relayMode__exists: '0', sort: 'startTime', order: 'desc' });
  expect(params.get('fields')).toContain('relayMode');
  // 読み込んだ範囲の絞り込み (0 件は「読み込んだ範囲にない」)。
  const filter = page.getByRole('searchbox', { name: '選手名で絞り込み (読み込んだ範囲)' });
  await filter.fill('Чернышов');
  await expect(rows).toHaveCount(1);
  await filter.fill('nobody');
  await expect(page.getByTestId('browse-empty')).toContainText('読み込んだ範囲にありません');
  await filter.fill('');

  await rows.first().click();
  await expect(page.getByTestId('set-page')).toBeVisible();
  expect(page.url()).toContain('b=online');
  expect(page.url()).toContain(`m=${ONLINE_MID}`);
  await expect(page.getByTestId('browse-view')).toBeHidden();
  await page.getByTestId('set-page-back').click();
  await expect(page.getByTestId('browse-view')).toBeVisible();
  await expect(rows.first()).toBeFocused();
});

test('取得失敗は 0 件と区別し、同じ画面で再試行できる。カテゴリはキーボードで切り替えられる', async ({ page }) => {
  const control = await start(page, { log: [], fail: { tournament: true } });
  await entries(page).getByRole('button', { name: 'n01トーナメント' }).click();
  await expect(page.getByTestId('browse-error')).toContainText('一覧を取得できませんでした');
  await expect(page.getByTestId('browse-empty')).toHaveCount(0);
  control.fail = {};
  await page.getByTestId('browse-error').getByRole('button', { name: '再試行' }).click();
  await expect(page.getByTestId('browse-tournament')).toHaveCount(30);

  const tabs = page.getByRole('tablist', { name: 'n01 の一覧' });
  await expect(tabs.getByRole('tab')).toHaveText(['n01オンライン', 'n01トーナメント', 'n01リーグ']);
  await tabs.getByRole('tab', { name: 'n01トーナメント' }).focus();
  await page.keyboard.press('ArrowRight');
  await expect(tabs.getByRole('tab', { name: 'n01リーグ' })).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByTestId('browse-league')).toHaveCount(30);
  expect(page.url()).toContain('b=league');
  await page.keyboard.press('ArrowLeft');
  // 切り替えて戻ると、さっきの一覧のまま (読み直さない)。
  await expect(page.getByTestId('browse-tournament')).toHaveCount(30);
  expect(control.log.filter((entry) => entry.startsWith('tournament/list')).length).toBe(2);
  await page.getByTestId('browse-back').click();
  await expect(page.getByTestId('browse-view')).toHaveCount(0);
});

test('以前の一覧 (#/watch?n=1): 共有済みのリンクで開き、新しい一覧へも行ける', async ({ page }) => {
  await start(page);
  await page.goto('/#/watch?n=1');
  await expect(page.getByTestId('now-view')).toBeVisible();
  await expect(page.getByRole('heading', { name: /以前の一覧/ })).toBeVisible();
  await expect(page.getByRole('navigation', { name: 'n01 の一覧から探す' }).getByRole('button')).toHaveText(['n01オンライン', 'n01トーナメント', 'n01リーグ']);
  await page.getByRole('navigation', { name: 'n01 の一覧から探す' }).getByRole('button', { name: 'n01オンライン' }).click();
  await expect(page.getByTestId('browse-view')).toBeVisible();
  await page.goBack();
  await expect(page.getByTestId('now-view')).toBeVisible();
});

for (const width of [360, 390]) {
  test(`${width}px: 名前・状態・検索・更新情報が読め、横にはみ出さない`, async ({ page }) => {
    await start(page);
    await page.setViewportSize({ width, height: 780 });
    for (const name of ['n01トーナメント', 'n01リーグ', 'n01オンライン'] as const) {
      await page.goto('/#/watch');
      await entries(page).getByRole('button', { name }).click();
      await expect(page.getByTestId('browse-list').locator('[data-browse-key]').first()).toBeVisible();
      await expect(page.getByTestId('browse-search')).toBeVisible();
      await expect(page.getByTestId('browse-meta')).toBeVisible();
      await noSidewaysScroll(page);
      // 長い名前は省略せずに折り返す。
      const title = page.getByTestId('browse-list').locator('.n01-row-title').first();
      expect(await title.evaluate((element) => element.scrollWidth <= element.clientWidth + 1)).toBe(true);
    }
    const long = page.getByTestId('browse-list');
    await page.goto('/#/watch');
    await entries(page).getByRole('button', { name: 'n01トーナメント' }).click();
    const row = long.locator('[data-browse-key]').nth(4);
    await expect(row).toContainText('長い名前の表示確認');
    const box = (await row.boundingBox())!;
    expect(box.x + box.width).toBeLessThanOrEqual(width + 1);
  });
}

test('axe: 3 つの一覧と以前の一覧に WCAG 2.1 AA の違反がない', async ({ page }, testInfo) => {
  await start(page);
  for (const name of ['n01オンライン', 'n01トーナメント', 'n01リーグ'] as const) {
    await page.goto('/#/watch');
    await entries(page).getByRole('button', { name }).click();
    await expect(page.getByTestId('browse-list').locator('[data-browse-key]').first()).toBeVisible();
    await expectNoAxeViolations(page, testInfo);
  }
  await page.goto('/#/watch?n=1');
  await expect(page.getByTestId('now-view')).toBeVisible();
  await expectNoAxeViolations(page, testInfo);
});
