import { describe, expect, it } from 'vitest';
import { parseGameDetail, parseSlotEvidence } from './api/parse';
import { reconstructGame } from './reconstruct';
import { classifyGames } from './roleGames';
import { RAW_2024_2ND, RAW_2026_3RD } from './realData.roles.fixtures';
import { ATDO_2026_3RD_DOUBLES, HIGH_IN_ATDO_2024_2ND, HIGH_IN_ATDO_2026_3RD, HIGH_IN_TDO_2026_3RD, HIGH_IN_TDO_PAIRS, HIGH_IN_TDO_TEST_TOURNAMENT, LEAGUE_ATDO, LEAGUE_TDO, RAW_TDO_2026_3RD, STARTED_AT_ATDO_2026_3RD, STARTED_AT_TDO_2026_3RD, TDO_2026_3RD_DOUBLES, TDO_TEST_TOURNAMENT } from './realData.startRate.fixtures';
import { startTallyOf } from './startRate';
import { DOUBLE_IN_RULES, gameStartRule, highInEvidence } from './startRule';
import type { HighInRecord } from './api/parse';

/**
 * 個人スタート率 against the **measured** n01 records (read 2026-11-15; see the fixtures file).
 * Expected attempts were counted by hand from the visits printed in the comments, not by the code.
 * The last block uses intentional data on top of the real slots (marked so).
 */

const atdo = parseGameDetail(ATDO_2026_3RD_DOUBLES);
const tdo = parseGameDetail(TDO_2026_3RD_DOUBLES);

describe('measured: the two doubles examples', () => {
  it('both games rebuild exactly to n01\'s game totals (the rows are what we think they are)', () => {
    expect(reconstructGame(atdo)).toMatchObject({ ok: true });
    expect(reconstructGame(tdo)).toMatchObject({ ok: true });
  });

  it('ATDO 2026 3rd A ダブルス1 (pHd61gnc): msco 2/2, 8Ch8 never threw unstarted, 49ib 1/4, uByO 1/3', () => {
    // Leg 1 (first 0): 68wv [msco, 8Ch8] 41 → msco starts. GpiQ [49ib, uByO] 0 0 0 0 50 → 49ib ✗, uByO ✗, 49ib ✗, uByO ✗, 49ib ✓.
    // Leg 2 (first 1): 68wv 50 → msco starts. GpiQ 0 41 → 49ib ✗, uByO ✓.
    const tally = startTallyOf(atdo)!;
    expect(tally.perPlayer).toEqual({
      msco: { attempts: 2, successes: 2 },
      '8Ch8': { attempts: 0, successes: 0 },
      '49ib': { attempts: 4, successes: 1 },
      uByO: { attempts: 3, successes: 1 },
    });
    expect(tally.sides.map((s) => s.legs)).toEqual([2, 2]);
  });

  it('TDO 2026/3rd ダブルス1 (zKJTVRK7): l3ds 1/3, 9vpt 2/2, ijhg 2/3, 3nya 1/1', () => {
    // Leg 1: YKeJ [l3ds, 9vpt] 0 105 → l3ds ✗, 9vpt ✓.  fSrN [ijhg, 3nya] 80 → ijhg ✓.
    // Leg 2: YKeJ 0 80 → l3ds ✗, 9vpt ✓.                  fSrN 14 → ijhg ✓.
    // Leg 3: YKeJ 96 → l3ds ✓.                            fSrN 0 52 → ijhg ✗, 3nya ✓.
    const tally = startTallyOf(tdo)!;
    expect(tally.perPlayer).toEqual({
      l3ds: { attempts: 3, successes: 1 },
      '9vpt': { attempts: 2, successes: 2 },
      ijhg: { attempts: 3, successes: 2 },
      '3nya': { attempts: 1, successes: 1 },
    });
  });

  it('n01\'s own high-in record of that leg names the same starter and points (9vpt, 105, same leg time)', () => {
    const tally = startTallyOf(tdo)!;
    const record = HIGH_IN_TDO_PAIRS.find((r) => r.time === tdo.legs[0].time)!;
    expect(record).toMatchObject({ oid: '9vpt', highIn: 105, schid: '5ywh' });
    expect(tally.hits).toContainEqual({ time: record.time, oid: record.oid, score: record.highIn });
    // Under the other reading (the 0 row as a scorer's dummy) the 105 would be l3ds's: n01 says otherwise.
    expect(tally.hits.find((h) => h.time === record.time && h.oid === 'l3ds')).toBeUndefined();
  });
});

describe('measured: which slots are double-in', () => {
  const slotsAtdo = parseSlotEvidence(RAW_2026_3RD);
  const slotsTdo = parseSlotEvidence(RAW_TDO_2026_3RD);
  const slots2024 = parseSlotEvidence(RAW_2024_2ND);
  const classify = (slots: ReturnType<typeof parseSlotEvidence>, detail: typeof atdo) =>
    classifyGames({ slots }, [{ gameId: detail.gameId, matchId: detail.matchId, schid: detail.schid, matchType: detail.matchType, finished: true, startTime: null, sides: detail.sides }])[0];
  const atdoSeason = { leagueId: LEAGUE_ATDO, slots: slotsAtdo, startedAt: STARTED_AT_ATDO_2026_3RD };
  const tdoSeason = { leagueId: LEAGUE_TDO, slots: slotsTdo, startedAt: STARTED_AT_TDO_2026_3RD };

  it('the high-in records sit in doubles slots only, all at most 160 (a cross-check, not the basis)', () => {
    for (const [slots, records] of [[slotsAtdo, HIGH_IN_ATDO_2026_3RD], [slotsTdo, HIGH_IN_TDO_2026_3RD], [slots2024, HIGH_IN_ATDO_2024_2ND]] as const) {
      const evidence = highInEvidence(records);
      for (const [schid, slot] of evidence.bySlot) {
        expect(slots.find((s) => s.schid === schid)?.numPart).toBe(2);
        expect(slot.impossible).toBe(0);
      }
      expect(Math.max(...records.map((r) => r.highIn!))).toBeLessThanOrEqual(160);
    }
    expect([...highInEvidence(HIGH_IN_ATDO_2026_3RD).bySlot.keys()].sort()).toEqual(['0qf2', '2gbr', '8kxb', 'rdsi']);
    expect([...highInEvidence(HIGH_IN_TDO_2026_3RD).bySlot.keys()].sort()).toEqual(['5ywh', 'kwgs']);
  });

  it('the two example games are double-in by the organiser\'s rule, with the season\'s records agreeing', () => {
    const a = gameStartRule(atdoSeason, classify(slotsAtdo, atdo), highInEvidence(HIGH_IN_ATDO_2026_3RD));
    expect(a).toMatchObject({ rule: 'double-in', basis: expect.stringContaining('13件') });
    expect(gameStartRule(tdoSeason, classify(slotsTdo, tdo), highInEvidence(HIGH_IN_TDO_2026_3RD)).rule).toBe('double-in');
    expect(DOUBLE_IN_RULES.map((l) => l.leagueId)).toEqual(expect.arrayContaining([LEAGUE_ATDO, LEAGUE_TDO, 'lg_Ev9v_7379']));
  });

  it('a covered slot stays double-in without any high-in record (season start) or when they could not be read', () => {
    expect(gameStartRule(tdoSeason, classify(slotsTdo, tdo), highInEvidence([]))).toMatchObject({ rule: 'double-in', basis: expect.stringContaining('まだありません') });
    expect(gameStartRule(tdoSeason, classify(slotsTdo, tdo), null)).toMatchObject({ rule: 'double-in', basis: expect.stringContaining('取得できず') });
  });

  it('the TDO test tournament (in the date range, same slot ids): its 180-point records put those slots out', () => {
    const test = { leagueId: LEAGUE_TDO, slots: slotsTdo, startedAt: TDO_TEST_TOURNAMENT.startedAt };
    expect(gameStartRule(test, classify(slotsTdo, tdo), highInEvidence(HIGH_IN_TDO_TEST_TOURNAMENT))).toMatchObject({ rule: 'unknown', reason: expect.stringContaining('ダブルインでは出ない点数') });
  });
});

describe('the in-rule verdict never widens (intentional data on the measured slots)', () => {
  const slots = parseSlotEvidence(RAW_TDO_2026_3RD);
  const season = { leagueId: LEAGUE_TDO, slots, startedAt: STARTED_AT_TDO_2026_3RD };
  const evidence = highInEvidence(HIGH_IN_TDO_2026_3RD);
  const doubles = classifyGames({ slots }, [{ gameId: tdo.gameId, matchId: tdo.matchId, schid: tdo.schid, matchType: '01', finished: true, startTime: null, sides: tdo.sides }])[0];

  it('a league nobody declared: unknown, whatever its records say', () => {
    expect(gameStartRule({ ...season, leagueId: 'lg_other' }, doubles, evidence)).toMatchObject({ rule: 'unknown', reason: expect.stringContaining('リーグ') });
    expect(gameStartRule({ ...season, leagueId: null }, doubles, evidence).rule).toBe('unknown');
  });

  it('a season before the checked range, or one whose start date is unknown: unknown (no reach into history)', () => {
    const rule = DOUBLE_IN_RULES.find((r) => r.leagueId === LEAGUE_TDO)!;
    expect(gameStartRule({ ...season, startedAt: rule.fromStartedAt - 1 }, doubles, evidence)).toMatchObject({ rule: 'unknown', reason: expect.stringContaining('より前') });
    expect(gameStartRule({ ...season, startedAt: rule.fromStartedAt }, doubles, evidence).rule).toBe('double-in');
    expect(gameStartRule({ ...season, startedAt: null }, doubles, evidence)).toMatchObject({ rule: 'unknown', reason: expect.stringContaining('開始日') });
    expect(gameStartRule({ leagueId: LEAGUE_TDO, slots }, doubles, evidence).rule).toBe('unknown');
  });

  it('only a contradiction in the same slot puts it out: 180 in another slot, or a record in a singles slot, does not', () => {
    const sameSlot: HighInRecord[] = [...HIGH_IN_TDO_2026_3RD, { schid: '5ywh', oid: null, highIn: 180, time: null }];
    expect(gameStartRule(season, doubles, highInEvidence(sameSlot)).rule).toBe('unknown');
    const otherSlot: HighInRecord[] = [...HIGH_IN_TDO_2026_3RD, { schid: 'kwgs', oid: null, highIn: 180, time: null }, { schid: 'rqq9', oid: null, highIn: 120, time: null }];
    expect(gameStartRule(season, doubles, highInEvidence(otherSlot)).rule).toBe('double-in');
    // 170 (D-BULL T20 T20) is still a double-in start.
    expect(gameStartRule(season, doubles, highInEvidence([...HIGH_IN_TDO_2026_3RD, { schid: '5ywh', oid: null, highIn: 170, time: null }])).rule).toBe('double-in');
  });

  it('a singles game, a Cricket slot, or a slot whose settings differ is never double-in', () => {
    expect(gameStartRule(season, { ...doubles, role: 'singles' }, evidence).rule).toBe('unknown');
    expect(gameStartRule(season, { ...doubles, family: { family: 'cricket', basis: 'explicit' } }, evidence).rule).toBe('unknown');
    const changed = slots.map((s) => (s.schid === '5ywh' ? { ...s, numPart: 1 } : s));
    expect(gameStartRule({ ...season, slots: changed }, doubles, evidence).rule).toBe('unknown');
  });
});
