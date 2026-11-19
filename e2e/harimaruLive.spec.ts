import { expect, test, type Page } from '@playwright/test';
import { N01_API_BASE_URL } from '../src/integrations/n01/endpoints';
import { serveN01 } from './n01Server';
import { tab } from './nav';

/**
 * ハリマル PR3: n01 観戦のリアクション (本番ビルド・架空の n01 サーバー。実際の n01 には接続しない)。
 *
 * 架空データ (テスト専用): ATDO の 2026 3rd に「n01から作成」で kalavinka (tpid GpiQ) を作って選び、
 * 2026-10-08 の kalavinka vs スピンコブラ (68wv) のカードが進行中という状態を、match/list と match/live だけ
 * 差し替えて流す。実際の n01 との違い: 投てき・勝数・終了の値をテストが直接決め、ほかの n01 の応答は
 * 既存の架空データ (src/test/n01) のまま。
 *
 * 確かめること: 新しい出来事だけに反応する (最初の状態・同じ応答の再取得には反応しない)、味方・相手の別、
 * 180 は左向き (文字を反転しない)、エフェクトは文字・操作部品に重ならない、試合の勝利、ハリマルの有無で
 * n01 への取得の回数が変わらない。
 */
test.use({ serviceWorkers: 'block' });

const TD = 't_ABvC_5234';
/** n01 の tmid は `<tdid>_lg_<部>_<lsid>_<tpid>_<tpid>` (lsid に `_` を含まない、parseLeagueTmid)。 */
const LSID = 'r5x1';
const TMID = `${TD}_lg_0_${LSID}_GpiQ_68wv`;
/** 2026-10-08 19:40 JST (カードの夜)。 */
const NIGHT = Date.parse('2026-10-08T10:40:00Z');

interface Visit {
  p: 0 | 1;
  r: number;
  score: number;
  finish?: 1;
}

interface LiveGame {
  mid: string;
  schid: string;
  visits: Visit[];
  legs: [number, number];
  sets: [number, number];
  gameEnded: boolean;
  cardEnded: boolean;
  rev: number;
}

function liveOf(game: LiveGame): unknown {
  const left: [number, number] = [501, 501];
  const throws = game.visits.map((visit) => {
    left[visit.p] -= visit.score;
    return { p: visit.p, r: visit.r, score: visit.score, left: left[visit.p], darts: 3, ...(visit.finish ? { finish: 1 } : {}) };
  });
  return {
    result: 0,
    changed: 1,
    mid: game.mid,
    scid: '',
    tdid: TD,
    tmid: TMID,
    schid: game.schid,
    ttype: 'lg',
    title: 'ATDO 2026 3rd A Division',
    match_type: '01',
    updateTime: NIGHT + 60_000 + game.rev * 1000,
    end_match: game.gameEnded ? 1 : 0,
    end_schedule: game.cardEnded ? 1 : 0,
    format: { limit_leg: 2, draw_mode: 0, schedule: 1, start_score: 501 },
    show_sets: 0,
    sets: game.sets,
    legs: game.legs,
    current_leg: 0,
    leg_count: 1,
    players: [
      { name: 'kalavinka', tpid: 'GpiQ', order: [{ oid: 'k1', name: '橋本 千尋' }] },
      { name: 'スピンコブラ', tpid: '68wv', order: [{ oid: 's1', name: '山本 剛' }] },
    ],
    stats: [{ avg: 60 }, { avg: 55 }],
    leg: { leg: 0, first: 0, end: 0, winner: null, start: [501, 501], left, thrower: game.visits.length % 2, round: Math.floor(game.visits.length / 2) + 1, throws },
  };
}

function todayRows(game: LiveGame): unknown {
  const side = (tpid: string, name: string, oid: string) => ({ tpid, order: [{ oid, oname: name }], winLegs: 0, allScore: 0, allDarts: 0, allMarks: 0 });
  return {
    result: 0,
    list: [
      {
        mid: game.mid,
        tdid: TD,
        tmid: TMID,
        schid: game.schid,
        match_type: '01',
        startTime: Math.floor(NIGHT / 1000) - 600,
        endMatch: game.cardEnded ? 1 : 0,
        statsData: [side('GpiQ', '橋本 千尋', 'k1'), side('68wv', '山本 剛', 's1')],
      },
    ],
  };
}

/** 架空の n01: 既存の架空データに、今夜のカードのゲームの一覧 (match/list) とライブだけを足す。 */
async function serveNight(page: Page, game: LiveGame): Promise<string[]> {
  const server = await serveN01(page);
  await page.route(`${N01_API_BASE_URL}/**`, async (route) => {
    // ライブ・投てきは架空データの一覧 (parseRequestUrl) にない操作なので、URL から直接読む。
    const url = new URL(route.request().url());
    const operation = url.pathname.replace(/^.*\/api\/v1\//u, '');
    const params = Object.fromEntries(url.searchParams);
    const request = { operation, params };
    const headers = { 'Access-Control-Allow-Origin': '*' };
    // 今夜の一覧 (startTime__gte) と、シーズンのゲームの一覧 (tmid__regex=_lg_): 今夜のカードのゲームだけ。
    if (request.operation === 'match/list' && ('startTime__gte' in request.params || request.params.tmid__regex === '_lg_')) {
      server.log.push('match/list?today');
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(todayRows(game)), headers });
    }
    if (request.operation === 'match/live') {
      server.log.push('match/live');
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(liveOf(game)), headers });
    }
    if (request.operation === 'match/throws') {
      const live = liveOf(game) as { leg: unknown; updateTime: number };
      const body = { result: 0, changed: 1, mid: game.mid, match_type: '01', end_match: game.gameEnded ? 1 : 0, current_leg: 0, updateTime: live.updateTime, leg_data: [live.leg] };
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body), headers });
    }
    if (request.operation === 'team/order/list') return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ result: 0, list: [] }), headers });
    return route.fallback();
  });
  return server.log;
}

async function createKalavinka(page: Page): Promise<void> {
  await page.getByRole('button', { name: 'n01から作成' }).click();
  const wizard = page.getByRole('dialog', { name: 'n01から作成' });
  await wizard.getByRole('button', { name: 'ATDO', exact: true }).click();
  await wizard.getByRole('button', { name: /kalavinka/ }).click();
  await wizard.getByRole('button', { name: 'このチームを作成' }).click();
  await expect(page.getByRole('heading', { name: 'kalavinka', level: 1 })).toBeVisible();
}

/** ハリマルの観戦リアクションの結果 (data-live) と、エフェクトのコマを、変わるたびに記録する。 */
async function watchLive(page: Page): Promise<() => Promise<{ live: string[]; effects: string[]; mirrored: string[]; overlaps: string[] }>> {
  await page.evaluate(() => {
    const w = window as unknown as { __hl: { live: string[]; effects: string[]; mirrored: string[]; overlaps: string[] }; __hlObserver?: MutationObserver };
    w.__hl = { live: [], effects: [], mirrored: [], overlaps: [] };
    w.__hlObserver?.disconnect();
    const sprite = document.querySelector<HTMLElement>('[data-testid="harimaru"]')!;
    const effect = document.querySelector<HTMLElement>('[data-testid="harimaru-effect"]')!;
    // エフェクトの描かれる範囲 (左向き、本体の左上から。src/features/harimaru/sprite.ts の effectBox)。
    const boxes: Record<string, [number, number, number, number]> = {
      victory: [-7, -12, 35, 9],
      cheer: [-6, 0, 3, 14],
      panic: [6, -11, 20, 0],
      anxious: [16, -6, 35, 12],
      frustrated: [-5, 13, 9, 20],
      surprise180: [-8, -14, 35, 16],
    };
    const check = (): void => {
      if (sprite.dataset.live && w.__hl.live[w.__hl.live.length - 1] !== sprite.dataset.live) w.__hl.live.push(sprite.dataset.live);
      if (effect.dataset.active !== 'true') return;
      const frame = effect.dataset.frame ?? '';
      if (w.__hl.effects[w.__hl.effects.length - 1] !== frame) w.__hl.effects.push(frame);
      const flipped = /scaleX\(-1\)/.test(effect.style.transform);
      if (flipped) w.__hl.mirrored.push(frame);
      const id = frame.split(':')[0];
      const r = effect.getBoundingClientRect();
      const [l, t, rr, b] = boxes[id] ?? [0, 0, 0, 0];
      // 本体の左上 = エフェクトの枠の左上 + (11, 18)。右向きは本体の中心で反転。
      const bx = r.left + 11;
      const by = r.top + 18;
      const area = flipped ? { left: bx + 30 - rr, right: bx + 30 - l, top: by + t, bottom: by + b } : { left: bx + l, right: bx + rr, top: by + t, bottom: by + b };
      const hit = (q: DOMRect | { left: number; right: number; top: number; bottom: number }): boolean => q.right > area.left + 0.5 && q.left < area.right - 0.5 && q.bottom > area.top + 0.5 && q.top < area.bottom - 0.5;
      for (const node of Array.from(document.querySelectorAll('.app *'))) {
        const rect = node.getBoundingClientRect();
        if (!hit(rect)) continue;
        if (node.matches('button, a, input, select, textarea, label, [role="button"], [tabindex="0"], .app-header, .tab-bar, .action-bar')) w.__hl.overlaps.push(`${frame} ${node.tagName}.${node.className}`);
        for (const child of Array.from(node.childNodes)) {
          if (child.nodeType !== 3 || !child.textContent?.trim()) continue;
          const range = document.createRange();
          range.selectNodeContents(child);
          if (Array.from(range.getClientRects()).some(hit)) w.__hl.overlaps.push(`${frame} TEXT:${child.textContent.trim().slice(0, 12)}`);
        }
      }
    };
    w.__hlObserver = new MutationObserver(check);
    w.__hlObserver.observe(sprite, { attributes: true, attributeFilter: ['data-live', 'style'] });
    w.__hlObserver.observe(effect, { attributes: true, attributeFilter: ['data-frame', 'data-active', 'style'] });
  });
  return () => page.evaluate(() => (window as unknown as { __hl: { live: string[]; effects: string[]; mirrored: string[]; overlaps: string[] } }).__hl);
}

/** ハリマルが立って見えるまで時計を進める (観戦の画面の上の方を見る)。 */
async function waitHarimaru(page: Page): Promise<void> {
  await page.evaluate(() => window.scrollTo(0, 0));
  for (let i = 0; i < 40; i += 1) {
    await page.clock.runFor(1_000);
    if ((await page.getByTestId('harimaru').getAttribute('data-visible')) === 'true') return;
  }
  throw new Error('ハリマルが観戦の画面に現れない');
}

/** 次の取得まで進めて、結果が出るまで待つ。 */
async function poll(page: Page, game: LiveGame): Promise<void> {
  game.rev += 1;
  await page.clock.runFor(1_700);
  await page.waitForTimeout(150);
  await page.clock.runFor(100);
}

async function openNight(page: Page, game: LiveGame): Promise<string[]> {
  await page.clock.install({ time: NIGHT });

  const log = await serveNight(page, game);
  await page.goto('/');
  await createKalavinka(page);
  await tab(page, '観戦').click();
  await expect(page.getByTestId('watch-page')).toBeVisible();
  // 時計を進めて、今夜の一覧とライブの最初の取得を待つ (取得は実時間で返る)。
  for (let i = 0; i < 30 && !(await page.getByTestId('live-scroll').isVisible()); i += 1) {
    await page.clock.runFor(1_000);
    await page.waitForTimeout(100);
  }
  await expect(page.getByTestId('live-scroll')).toBeVisible();
  // 画面の入場アニメーション (実時間) が終わるのを待つ。
  await page.waitForTimeout(1_500);
  return log;
}

test('味方・相手の新しい得点と試合の勝利に、1 回ずつ反応する。最初の状態・同じ応答には反応しない', async ({ page }) => {
  test.setTimeout(180_000);
  // 最初の状態: すでに味方の 180 と相手の 140 がある (過去の出来事)。
  const game: LiveGame = { mid: `${LSID}_c2`, schid: 'c2', visits: [{ p: 0, r: 1, score: 180 }, { p: 1, r: 1, score: 140 }], legs: [0, 0], sets: [2, 1], gameEnded: false, cardEnded: false, rev: 0 };
  await openNight(page, game);
  await waitHarimaru(page);
  const result = await watchLive(page);
  // 同じ応答の再取得 (何も変わらない) を何回か。
  for (let i = 0; i < 3; i += 1) await poll(page, game);
  expect((await result()).live).toEqual([]);

  // 味方 140 → cheer。
  game.visits.push({ p: 0, r: 2, score: 140 });
  await poll(page, game);
  await page.clock.runFor(1_500);
  // 相手 100 → anxious (得点のクールダウンのあと)。
  await page.clock.runFor(4_500);
  game.visits.push({ p: 1, r: 2, score: 100 });
  await poll(page, game);
  await page.clock.runFor(1_500);
  // 味方 180 → surprise180 (クールダウンを受けない。左向きで掲げる)。
  game.visits.push({ p: 0, r: 3, score: 180 });
  await poll(page, game);
  await page.clock.runFor(2_000);
  // 味方 26 → panic。
  await page.clock.runFor(4_500);
  game.visits.push({ p: 1, r: 3, score: 60 }, { p: 0, r: 4, score: 26 });
  await poll(page, game);
  await page.clock.runFor(1_500);
  // 対戦の終了: 味方がゲーム数 4-1 で勝利 → victory (1 回だけ)。
  game.sets = [4, 1];
  game.gameEnded = true;
  game.cardEnded = true;
  await poll(page, game);
  await page.clock.runFor(1_500);
  await poll(page, game);
  await page.clock.runFor(1_500);

  const seen = await result();
  const kinds = seen.live.map((entry) => entry.split(':')[0]);
  // 出来事ごとに 1 回ずつ、この順 (演出した、または余白がなく見送った)。過去の 180・140 には反応しない。
  expect(kinds).toEqual(['cheer', 'anxious', 'surprise180', 'panic', 'victory']);
  // 通常の得点は、ジャンプ・隠れている途中などなら捨てる (busy)。重要な出来事 (180・試合の勝利) は待ってでも演出する
  // (余白がない場合だけ見送る)。
  for (const entry of seen.live) expect(entry).toMatch(/^((cheer|anxious|panic)(:skipped:room|:dropped:busy)?|(surprise180|victory)(:skipped:room)?)$/);
  expect(seen.live.filter((entry) => !entry.includes('skipped')).length).toBeGreaterThan(0);
  // 180 の文字は反転しない。エフェクトは文字・操作部品に重ならない。
  expect(seen.mirrored.filter((frame) => frame.startsWith('surprise180'))).toEqual([]);
  expect(seen.overlaps).toEqual([]);
  // 終わったらエフェクトを残さない。
  await expect(page.getByTestId('harimaru-effect')).toHaveAttribute('data-active', 'false');
});

test('ハリマルの有無で、n01 への取得 (match/live) の間隔は変わらない (追加の取得をしない)', async ({ page, browser }, info) => {
  test.setTimeout(180_000);
  /** ページの時計で、match/live を取りに行った時刻を記録する (fetch を包むだけ。応答は変えない)。 */
  const gaps = async (target: Page, off: boolean): Promise<number[]> => {
    const game: LiveGame = { mid: `${LSID}_c2`, schid: 'c2', visits: [], legs: [0, 0], sets: [1, 1], gameEnded: false, cardEnded: false, rev: 0 };
    if (off) await target.addInitScript(() => window.localStorage.setItem('league-order:harimaru', 'off'));
    await target.addInitScript(() => {
      const w = window as unknown as { __liveAt: number[] };
      w.__liveAt = [];
      const original = window.fetch.bind(window);
      window.fetch = (input: RequestInfo | URL, init?: RequestInit) => {
        if (String(input instanceof Request ? input.url : input).includes('match/live')) w.__liveAt.push(Date.now());
        return original(input, init);
      };
    });
    await openNight(target, game);
    if (!off) await waitHarimaru(target);
    for (let i = 0; i < 8; i += 1) {
      // 味方・相手の得点で、ハリマルが反応しているあいだも数える。
      game.visits.push({ p: (i % 2) as 0 | 1, r: Math.floor(i / 2) + 1, score: i % 3 === 0 ? 180 : 140 });
      await poll(target, game);
    }
    const at = await target.evaluate(() => (window as unknown as { __liveAt: number[] }).__liveAt);
    return at.slice(1).map((t, i) => t - at[i]);
  };
  const on = await gaps(page, false);
  const context = await browser.newContext({ ...info.project.use, serviceWorkers: 'block' });
  const other = await context.newPage();
  const off = await gaps(other, true);
  await expect(other.getByTestId('harimaru-layer')).toHaveCount(0);
  await context.close();
  expect(on.length).toBeGreaterThan(6);
  expect(off.length).toBeGreaterThan(6);
  // どちらも、前の取得から 1.5 秒 (LIVE_INTERVAL_MS) より早い取得はない。
  expect(Math.min(...on)).toBeGreaterThanOrEqual(1_500);
  expect(Math.min(...off)).toBeGreaterThanOrEqual(1_500);
});
