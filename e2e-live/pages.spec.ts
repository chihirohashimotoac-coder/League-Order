import { expect, test, type Page, type Response } from '@playwright/test';

/**
 * The published site, in a real browser, against the real n01 API (no mocks, no routes).
 *
 *  1. create the ATDO team (kalavinka when it is in the season, else the first team listed),
 *  2. open データ分析 → PLAYER, then TEAM, and generate one order,
 *  3. prove from the browser's own network log that stats_list, player_stats_list, standings
 *     and the whole-league roster were each requested for the season and succeeded (HTTP 200,
 *     readable by this origin, i.e. a CORS header the browser accepted), and that the page
 *     raised no error.
 *
 * It only reads: the browser makes GETs, and the team it creates lives in this throwaway
 * browser profile.
 */

interface Seen {
  path: string;
  status: number;
  allowOrigin: string | null;
}

const N01_HOST = 'push.n01darts.com';

function watch(page: Page): { seen: Seen[]; problems: string[] } {
  const seen: Seen[] = [];
  const problems: string[] = [];
  page.on('response', async (response: Response) => {
    const url = new URL(response.url());
    if (url.hostname !== N01_HOST) return;
    const headers = await response.allHeaders();
    seen.push({
      path: `${url.pathname.replace('/api/v1/', '')}?${url.searchParams.toString()}`,
      status: response.status(),
      allowOrigin: headers['access-control-allow-origin'] ?? null,
    });
  });
  page.on('pageerror', (error) => problems.push(`pageerror: ${error.message}`));
  page.on('console', (message) => {
    if (message.type() === 'error') problems.push(`console.error: ${message.text()}`);
  });
  page.on('requestfailed', (request) => problems.push(`requestfailed: ${request.url()} ${request.failure()?.errorText ?? ''}`));
  return { seen, problems };
}

async function createAtdoTeam(page: Page): Promise<string> {
  await page.getByRole('button', { name: 'n01から作成' }).click();
  const wizard = page.getByRole('dialog', { name: 'n01から作成' });
  await wizard.getByRole('button', { name: 'ATDO', exact: true }).click();
  // The season's teams, grouped by division.
  const teams = wizard.locator('.team-group .list-row');
  await expect(teams.first()).toBeVisible({ timeout: 60_000 });
  const preferred = teams.filter({ hasText: 'kalavinka' });
  const team = (await preferred.count()) > 0 ? preferred.first() : teams.first();
  const name = ((await team.locator('.title').innerText()) || 'team').trim();
  await team.click();
  // A team registered in several running seasons asks which one; take the first.
  const create = wizard.getByRole('button', { name: 'このチームを作成' });
  await expect
    .poll(async () => {
      if (await create.isEnabled().catch(() => false)) return 'ready';
      const season = wizard.locator('.choice-list .list-row').first();
      if (await season.isVisible().catch(() => false)) await season.click();
      return 'waiting';
    })
    .toBe('ready');
  await create.click();
  await expect(page.getByRole('heading', { level: 1 }).first()).toBeVisible();
  return name;
}

test('published site: ATDO team → PLAYER / TEAM analytics → one order, against the real n01', async ({ page }, info) => {
  const { seen, problems } = watch(page);
  await page.goto('/');
  await expect(page.getByRole('button', { name: 'n01から作成' })).toBeVisible();

  const team = await createAtdoTeam(page);
  info.annotations.push({ type: 'team', description: team });

  await page.getByRole('button', { name: /データ分析/ }).click();
  await expect(page.getByTestId('analytics-page')).toBeVisible();
  await expect(page.getByTestId('metric-3DA')).toBeVisible({ timeout: 90_000 });
  await expect(page.getByTestId('analytics-updated')).toContainText('最終取得');
  await page.screenshot({ path: `smoke-results/player-analytics-${info.project.name}.png`, fullPage: true });

  await page.getByRole('button', { name: 'チーム', exact: true }).click();
  await expect(page.getByTestId('official-table')).toBeVisible({ timeout: 90_000 });
  await expect(page.getByTestId('team-basis')).toBeVisible();
  await page.screenshot({ path: `smoke-results/team-analytics-${info.project.name}.png`, fullPage: true });

  // One existing feature, as a visitor would use it: generate an order.
  await page.getByRole('button', { name: '戻る' }).click();
  await page.getByRole('button', { name: '新しいオーダーを作る' }).click();
  await expect(page.getByRole('heading', { name: 'オーダー設定' })).toBeVisible();
  await page.getByRole('button', { name: 'オーダーを生成' }).click();
  await expect(page.getByRole('heading', { name: 'オーダー結果' })).toBeVisible({ timeout: 90_000 });

  // The browser's own record of what it asked n01.
  const tdid = /tdid=([^&]+)/.exec(seen.find((r) => r.path.startsWith('tournament/standings'))?.path ?? '')?.[1];
  expect(tdid, 'standings was requested for a season').toBeTruthy();
  const wanted = [
    `tournament/stats?kind=stats_list&tdid=${tdid}`,
    `tournament/stats?kind=player_stats_list&tdid=${tdid}`,
    `tournament/standings?tdid=${tdid}`,
    `team/player/list?tdid=${tdid}`,
  ];
  const report = seen.map((r) => `${r.status} ACAO=${r.allowOrigin ?? '(none)'} ${r.path}`);
  process.stdout.write(`[${info.project.name}] team=${team} season=${tdid}\n  ${report.join('\n  ')}\n`);
  for (const path of wanted) {
    const hit = seen.find((r) => r.path === path);
    expect(hit, `requested: ${path}`).toBeTruthy();
    expect(hit!.status, path).toBe(200);
    expect(['*', 'https://chihirohashimotoac-coder.github.io'], `${path} is readable cross-origin`).toContain(hit!.allowOrigin);
  }
  expect(seen.filter((r) => r.status !== 200).map((r) => `${r.status} ${r.path}`)).toEqual([]);
  expect(problems).toEqual([]);
});
