import { describe, expect, it } from 'vitest';
import { parseOrders } from './parse';
import type { CardOrder } from './parse';
import { isFixtureToday, leagueCardTmid, planCard } from './plannedOrders';

const TD = 't_ABvC_5234';
// Card order (fixture): iTGA first, 7v1X second; n01's tmid lists them in code-unit order.
const TEAMS: [string, string] = ['iTGA', '7v1X'];
const TMID = leagueCardTmid(TD, 2, '5ua6', TEAMS);
const SLOTS = ['kwcg', '8kxb', 'rdsi', 'fepq', 'cvzb', '6wav', 'gsbe'];

function row(tpid: string, schid: string, fix: unknown, names: string[], tmid: string = TMID): Record<string, unknown> {
  return { tmid, tpid, schid, fix, order: names.map((name, i) => ({ oid: name ? `${tpid}${i}` : '', opid: name ? `02-${i}` : '', oname: name })) };
}
const rows = (list: Record<string, unknown>[]): CardOrder[] => parseOrders({ result: 0, list });
const plan = (list: Record<string, unknown>[], slots = SLOTS) => planCard(rows(list), { tmid: TMID, teamIds: TEAMS, schids: slots });

describe('leagueCardTmid', () => {
  it('puts the two team ids in code-unit order, whatever the fixture order (as n01 does)', () => {
    expect(TMID).toBe('t_ABvC_5234_lg_2_5ua6_7v1X_iTGA');
    expect(leagueCardTmid(TD, 0, 'ggr7', ['WpZb', 'k18b'])).toBe('t_ABvC_5234_lg_0_ggr7_WpZb_k18b');
    expect(leagueCardTmid(TD, 1, 'w9qc', ['X6iU', 'RcXE'])).toBe('t_ABvC_5234_lg_1_w9qc_RcXE_X6iU');
  });
});

describe('planCard', () => {
  it('all seven games confirmed on both sides: every name, in n01 order, on the right team (card order, not row order)', () => {
    const list = SLOTS.flatMap((schid, i) => [row('7v1X', schid, 1, i === 0 ? ['清水 治彦', '神田 海帆', '浅野 英樹', '曳汐 弘志'] : [`X${i}`]), row('iTGA', schid, 1, i === 0 ? ['清水 玲於奈', '持田 響', '佐々木 渉', '平林　大河（助っ人）'] : [`T${i}`])]);
    const planned = plan(list);
    expect([...planned.games.values()].map((game) => game.state)).toEqual(Array(7).fill('published'));
    const gallon = planned.games.get('kwcg')!;
    // Side 0 is the card's first team (iTGA), although n01 listed 7v1X first.
    expect(gallon.sides[0].members!.map((m) => m.name)).toEqual(['清水 玲於奈', '持田 響', '佐々木 渉', '平林　大河（助っ人）']);
    expect(gallon.sides[1].members!.map((m) => m.name)).toEqual(['清水 治彦', '神田 海帆', '浅野 英樹', '曳汐 弘志']);
    // A helper without a player id (opid "") keeps its place and its name.
    expect(gallon.sides[0].members![3]).toEqual({ oid: 'iTGA3', opid: '02-3', name: '平林　大河（助っ人）' });
    expect(planned.ignored).toBe(0);
  });

  it('one side confirmed: no names on either side (the other team must not see it first)', () => {
    const planned = plan([row('iTGA', 'fepq', 1, ['持田 響']), row('7v1X', 'fepq', 0, ['清水 治彦'])]);
    const game = planned.games.get('fepq')!;
    expect(game.state).toBe('oneSide');
    expect(game.sides.map((side) => side.state)).toEqual(['fixed', 'unfixed']);
    expect(game.sides.map((side) => side.members)).toEqual([null, null]);
    // Confirmed on one side, nothing on the other.
    expect(plan([row('iTGA', 'fepq', 1, ['持田 響'])]).games.get('fepq')!.state).toBe('oneSide');
  });

  it('both unconfirmed: n01 may send names (AKDO, 2026-11-27) — they are not shown', () => {
    const game = plan([row('iTGA', 'cvzb', 0, ['持田 響']), row('7v1X', 'cvzb', 0, ['神田 海帆'])]).games.get('cvzb')!;
    expect(game.state).toBe('unfixed');
    expect(game.sides.every((side) => side.members === null)).toBe(true);
    // ATDO's unconfirmed rows: places without names.
    expect(plan([row('iTGA', 'cvzb', 0, ['', ''])]).games.get('cvzb')!.state).toBe('unfixed');
  });

  it('a fix other than 0 / 1 (seen: 2) is not taken as confirmed', () => {
    const game = plan([row('iTGA', 'gsbe', 2, ['佐々木 渉']), row('7v1X', 'gsbe', 2, ['曳汐 弘志'])]).games.get('gsbe')!;
    expect(game.state).toBe('unknown');
    expect(game.sides.every((side) => side.members === null)).toBe(true);
    expect(plan([row('iTGA', 'gsbe', 1, ['佐々木 渉']), row('7v1X', 'gsbe', '1', ['曳汐 弘志'])]).games.get('gsbe')!.state).toBe('oneSide');
  });

  it('no order: "none" for every game (never called 未提出)', () => {
    expect([...plan([]).games.values()].every((game) => game.state === 'none')).toBe(true);
  });

  it('rows of another card, a team not in the card or a game not in its schedule are left out', () => {
    const planned = plan([
      row('iTGA', 'kwcg', 1, ['他カード'], 't_ABvC_5234_lg_2_93py_7v1X_iTGA'),
      row('pzDR', 'kwcg', 1, ['他チーム']),
      row('iTGA', 'zzzz', 1, ['他ゲーム']),
      row('iTGA', 'kwcg', 1, ['持田 響']),
      row('7v1X', 'kwcg', 1, ['神田 海帆']),
    ]);
    expect(planned.ignored).toBe(3);
    expect(planned.games.get('kwcg')!.sides.map((side) => side.members!.map((m) => m.name))).toEqual([['持田 響'], ['神田 海帆']]);
    expect(planned.games.has('zzzz')).toBe(false);
  });

  it('the same team and game twice: the game is not shown (which row is right is unknown)', () => {
    const game = plan([row('iTGA', 'kwcg', 1, ['A']), row('iTGA', 'kwcg', 1, ['B']), row('7v1X', 'kwcg', 1, ['C'])]).games.get('kwcg')!;
    expect(game.state).toBe('invalid');
    expect(game.sides.every((side) => side.members === null)).toBe(true);
  });

  it('same names on both teams and long names are kept as they are, matched by team id only', () => {
    const long = 'とても長い選手名の例ですとても長い選手名の例です';
    const game = plan([row('iTGA', 'fepq', 1, ['佐藤 太郎']), row('7v1X', 'fepq', 1, ['佐藤 太郎']), row('iTGA', 'cvzb', 1, [long]), row('7v1X', 'cvzb', 1, ['X'])]);
    expect(game.games.get('fepq')!.sides.map((side) => side.members![0].name)).toEqual(['佐藤 太郎', '佐藤 太郎']);
    expect(game.games.get('cvzb')!.sides[0].members![0].name).toBe(long);
  });

  it('a schedule of another length (3 games) has exactly its own games', () => {
    expect([...plan([row('iTGA', 'a', 1, ['A']), row('7v1X', 'a', 1, ['B'])], ['a', 'b', 'c']).games.keys()]).toEqual(['a', 'b', 'c']);
  });

  it('a confirmed order taken back (fix 1 → 0): the next read shows no names', () => {
    const before = plan([row('iTGA', 'fepq', 1, ['持田 響']), row('7v1X', 'fepq', 1, ['神田 海帆'])]).games.get('fepq')!;
    const after = plan([row('iTGA', 'fepq', 0, ['持田 響']), row('7v1X', 'fepq', 1, ['神田 海帆'])]).games.get('fepq')!;
    expect(before.state).toBe('published');
    expect(after.state).toBe('oneSide');
    expect(after.sides[1].members).toBeNull();
  });

  it('a player changed: the new name replaces the old one', () => {
    const a = plan([row('iTGA', 'fepq', 1, ['持田 響']), row('7v1X', 'fepq', 1, ['神田 海帆'])]).games.get('fepq')!;
    const b = plan([row('iTGA', 'fepq', 1, ['佐々木 渉']), row('7v1X', 'fepq', 1, ['神田 海帆'])]).games.get('fepq')!;
    expect(a.sides[0].members![0].name).toBe('持田 響');
    expect(b.sides[0].members![0].name).toBe('佐々木 渉');
  });
});

describe('parseOrders (malformed replies)', () => {
  it('a list that is not an array is a schema error, not an empty order', () => {
    expect(() => parseOrders({ result: 0, list: 'x' })).toThrow();
    expect(() => parseOrders({ result: -1, error: 'x' })).toThrow();
    expect(() => parseOrders('x')).toThrow();
  });
  it('rows without a team or game id are dropped; an order that is not an array is no places', () => {
    expect(parseOrders({ result: 0, list: [{ tmid: TMID, schid: 'a', fix: 1 }, { tmid: TMID, tpid: 'iTGA', schid: 'a', fix: 1, order: 'x' }, 'junk'] })).toEqual([
      { tmid: TMID, teamId: 'iTGA', schid: 'a', fixed: true, fix: 1, members: [], entries: [] },
    ]);
  });
});

describe('isFixtureToday (JST)', () => {
  // 2026-11-27 09:00 JST = 2026-11-27T00:00Z; 2026-11-26T15:30Z is 2026-11-27 00:30 JST.
  it('compares the title date with the JST date', () => {
    expect(isFixtureToday('第9戦 11月27日 金曜日', Date.UTC(2026, 10, 27, 0))).toBe(true);
    expect(isFixtureToday('第9戦 11月27日 金曜日', Date.UTC(2026, 10, 26, 15, 30))).toBe(true);
    expect(isFixtureToday('第9戦 11月27日 金曜日', Date.UTC(2026, 10, 26, 14, 30))).toBe(false);
    expect(isFixtureToday('最終戦 12月4日 金曜日', Date.UTC(2026, 10, 27, 0))).toBe(false);
    expect(isFixtureToday('2026-11-27', Date.UTC(2026, 10, 27, 0))).toBe(true);
    expect(isFixtureToday('2025-11-27', Date.UTC(2026, 10, 27, 0))).toBe(false);
    expect(isFixtureToday('第3節', Date.UTC(2026, 10, 27, 0))).toBe(false);
  });
});
