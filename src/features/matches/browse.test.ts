import { describe, expect, it } from 'vitest';
import { MatchesApi } from './api';
import type { AnalyticsOperation, AnalyticsTransport } from '../analytics/api/readApi';
import { RequestGovernor } from './governor';
import { appendPage, isStandaloneRow, mayHaveMore, parseLeaguePage, parseOnlinePage, parseTournamentPage } from './browse';
import { browseLeagueRows, browseOnlineRows, browseReply, browseTournamentRows } from '../../test/n01/browse';

/**
 * 観戦の「n01オンライン・n01トーナメント・n01リーグ」: 取得条件 (公式の初期表示と同じ対象・順)、
 * 応答の読み取り、単独の試合の分類、ページを重ねたときの順序と重複。
 */

function apiOf(reply: (operation: string, params: Record<string, string>) => unknown) {
  const calls: { operation: AnalyticsOperation; params: Record<string, string> }[] = [];
  const transport: AnalyticsTransport = {
    request: async (operation, params) => {
      calls.push({ operation, params });
      return reply(operation, params);
    },
  };
  return { api: new MatchesApi({ transport, governor: new RequestGovernor(100_000), pollPerMinute: 100_000 }), calls };
}

describe('取得条件', () => {
  it('n01トーナメント: 更新の新しい順・リーグ配下を除く・準備中〜終了、30 件ずつ。検索語は前後の空白を除いて足す', async () => {
    const { api, calls } = apiOf((operation, params) => browseReply(operation, params));
    await api.browseTournaments();
    await api.browseTournaments({ keyword: '  Weekly  ', skip: 30 });
    expect(calls[0]).toEqual({
      operation: 'tournament/list',
      params: { sort: 'updateTime', order: 'desc', count: '30', league__ne: '1', status__in: '10,20,25,30,40', fields: 'tdid,title,status,lgid,t_date,updateTime' },
    });
    expect(calls[1].params).toMatchObject({ keyword: 'Weekly', skip: '30', sort: 'updateTime', league__ne: '1' });
  });

  it('n01リーグ: 更新の新しい順に 30 件ずつ', async () => {
    const { api, calls } = apiOf((operation, params) => browseReply(operation, params));
    await api.browseLeagues();
    expect(calls[0]).toEqual({ operation: 'league/list', params: { sort: 'updateTime', order: 'desc', count: '30', fields: 'lgid,title,updateTime' } });
  });

  it('n01オンライン: 進行中のうち tdid・relayMode の無い試合 (__exists=0。false は n01 で効かない)、開始の新しい順', async () => {
    const { api, calls } = apiOf((operation, params) => browseReply(operation, params));
    await api.browseOnline({ skip: 100 });
    expect(calls[0].operation).toBe('match/list');
    expect(calls[0].params).toMatchObject({ live: '1', endMatch: '0', tdid__exists: '0', relayMode__exists: '0', sort: 'startTime', order: 'desc', count: '100', skip: '100' });
    // 応答の行を確かめるため、識別子と relayMode を返させる。
    expect(calls[0].params.fields.split(',')).toEqual(expect.arrayContaining(['tdid', 'tmid', 'schid', 'relayMode']));
  });

  it('n01 のエラー (result < 0) は取得失敗として伝わる (0 件にしない)', async () => {
    const { api } = apiOf((operation, params) => browseReply(operation, params, { fail: { tournament: true, league: true, online: true } }));
    await expect(api.browseTournaments()).rejects.toMatchObject({ kind: 'schema' });
    await expect(api.browseLeagues()).rejects.toMatchObject({ kind: 'schema' });
    await expect(api.browseOnline()).rejects.toMatchObject({ kind: 'schema' });
  });
});

describe('応答の読み取り', () => {
  it('トーナメント: n01 の並びのまま。開催日時 0 は未登録、lgid のある大会も残す、名前は元の title', () => {
    const raw = browseTournamentRows(12);
    const page = parseTournamentPage({ result: 0, list: [...raw, { title: 'no id' }, 'x'] });
    expect(page.items.map((item) => item.tdid)).toEqual(raw.map((row) => row.tdid));
    expect(page.rows).toBe(14);
    expect(page.unreadable).toBe(2);
    expect(page.items[0]).toMatchObject({ title: 'Sample Open メンズシングルス', leagueId: 'lg_Jdo0_0001', status: 30 });
    expect(page.items[2].date).toBeNull();
    expect(page.items[1].date).toBe(raw[1].t_date);
    expect(page.items[3].leagueId).toBe('lg_Brw0_0003');
    // 同じ名前でも ID が違えば別の行。
    expect(page.items.filter((item) => item.title === 'Weekly Cup').map((item) => item.tdid)).toHaveLength(2);
  });

  it('リーグ: 団体単位の lgid と名前、更新時刻', () => {
    const page = parseLeaguePage({ result: 0, list: browseLeagueRows(6) });
    expect(page.items.map((item) => item.title)).toEqual(['ATDO', 'Žemberovce 2026', '新潟DOリーグ', '東京ダーツオーガニゼイション【TDO / Tokyo Darts Organization】', 'ONLINE BATTLE', 'ЗАДХ, ОНЧ ДАРТС клуб, Анхдугаар ДАРТС ЛИГ I тэмцээн']);
  });

  it('オンライン: 大会・リーグ・カード・中継の識別子がある行は掲載しない', () => {
    const page = parseOnlinePage({ result: 0, list: browseOnlineRows() });
    expect(page.items.map((row) => row.mid)).toEqual(['Onl0Demo_1799999990000', 'Onl1Demo_1799999900000', 'Onl2Demo_1799999600000', 'Onl3Demo_1799999500000']);
    expect(page.excluded).toBe(2);
    expect(page.rows).toBe(6);
    expect(page.items[1].matchType).toBe('cricket');
  });

  it('単独の試合の判定: 空の識別子は無いのと同じ、relayMode は値にかかわらず中継', () => {
    expect(isStandaloneRow({ mid: 'a', schid: '', tmid: null })).toBe(true);
    expect(isStandaloneRow({ mid: 'a', relayMode: 0 })).toBe(false);
    // セット戦 (scid だけ) は単独の試合。中継は relayMode で除く。
    expect(isStandaloneRow({ mid: 'a', scid: 'scid_x' })).toBe(true);
    expect(isStandaloneRow({ mid: 'a', scid: 'scid_x', relayMode: 1 })).toBe(false);
    expect(isStandaloneRow({ mid: 'a', tmid: 't_x_1_t_0_a_b' })).toBe(false);
    expect(isStandaloneRow({ mid: 'a', lgid: 'lg_x_1' })).toBe(false);
    expect(isStandaloneRow({ mid: 'a', tdid: 't_x_1' })).toBe(false);
    expect(isStandaloneRow(null)).toBe(false);
  });
});

describe('ページの結合', () => {
  it('n01 の並びを保ち、ページの間に動いた行 (同じ ID) は最初の位置に残す', () => {
    const rows = browseTournamentRows();
    const first = parseTournamentPage(browseReply('tournament/list', { sort: 'updateTime', order: 'desc', count: '30', league__ne: '1' })).items;
    const second = parseTournamentPage(browseReply('tournament/list', { sort: 'updateTime', order: 'desc', count: '30', league__ne: '1', skip: '30' })).items;
    expect(second[0].tdid).toBe(first[29].tdid);
    const merged = appendPage(first, second, (item) => item.tdid);
    expect(merged.duplicates).toBe(1);
    expect(merged.items.map((item) => item.tdid)).toEqual(rows.map((row) => row.tdid));
  });

  it('次ページの有無は 1 ページを満たしたかで判断する (全体の件数は n01 から取れない)', () => {
    expect(mayHaveMore(30, 30)).toBe(true);
    expect(mayHaveMore(16, 30)).toBe(false);
    expect(mayHaveMore(0, 30)).toBe(false);
  });
});
