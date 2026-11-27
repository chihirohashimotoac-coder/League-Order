import { N01Error } from '../integrations/n01/client';
import type { N01Request } from '../integrations/n01/endpoints';
import { allFixtureDatasets, fixtureResponse } from '../test/n01/transport';
import { LAST_PHASE, setMatchReply } from '../test/n01/setMatch';
import { BROWSE_JDO_EVENT, browseReply } from '../test/n01/browse';

/**
 * Review-preview only (never in the production build): an n01 made of the repository's
 * synthetic fixture leagues (ATDO / TDO / TDA shapes, made-up people), so the preview —
 * which runs where n01 cannot be reached — can show every screen. One card of each league
 * is played "live" by a simulator that advances with the clock.
 *
 * The preview labels itself as demo data on every screen it is used.
 */

declare const __PREVIEW_COMMIT__: string;

const datasets = allFixtureDatasets();
const START = Date.now();

/** The demo season (ATDO's shape) that has a card live and cards before their first game. */
const DEMO_TDID = 't_ABvC_5234';
/**
 * The demo's cards before their first game (by the fixture's card id), each showing one state of
 * the planned orders: all confirmed; changing every minute (a player swapped, then taken back); a
 * card that starts 90 s after the page opens; not confirmed; reads failing every other 45 s; one
 * team confirmed. The first three play seven games, the last three the B division's five.
 */
type PreStage = 'fixed' | 'changing' | 'starts' | 'unfixed' | 'flaky' | 'oneSide';
const PRE_START: Record<string, PreStage> = {
  t_ABvC_5234_r5_2: 'fixed',
  t_ABvC_5234_r6_1: 'changing',
  t_ABvC_5234_r6_2: 'starts',
  t_ABvC_5234_r5_4: 'unfixed',
  t_ABvC_5234_r5_5: 'flaky',
  t_ABvC_5234_r6_4: 'oneSide',
};
const PRE_TITLE: Record<PreStage, string> = {
  fixed: '全ゲーム確定',
  changing: 'オーダー変更',
  starts: '90秒後に開始',
  unfixed: 'オーダー未確定',
  flaky: '通信失敗',
  oneSide: '片側のみ確定',
};
/** The card that starts: its first game begins this long after the page opened. */
const STARTS_AFTER_MS = 90_000;

/** Today's date in JST as a fixture title (the app shows today's cards on the live tab). */
function todayTitle(): string {
  const d = new Date(Date.now() + 9 * 3_600_000);
  return `デモ節 ${d.getUTCMonth() + 1}月${d.getUTCDate()}日`;
}

/** A failed read (HTTP 503), as n01 answers when it is down. */
const UNAVAILABLE = Symbol('unavailable');

function raw(operation: string, params: Record<string, string>): unknown | undefined {
  return fixtureResponse({ operation: operation as N01Request['operation'], params }, datasets);
}

/*
 * The fixture leagues predate the published API shapes in three places; the demo rewrites them
 * to what n01 actually returns: 4-letter card ids, `tmid` = <tdid>_lg_<div>_<lsid>_<a>_<b>, and
 * `lg_result[<div>_<lsid>][tpid][vsTpid] = { r }`, plus ATDO's point rule (2 per win + games).
 */
const short = (tdid: string, lsid: string): string => lsid.replace(`${tdid}_`, '').replace(/[^A-Za-z0-9]/gu, '');

function divisionOfCard(tdid: string): Map<string, number> {
  const schedule = raw('league/schedule/get', { tdid }) as { schedule?: { lsid: string }[][] } | undefined;
  const map = new Map<string, number>();
  schedule?.schedule?.forEach((cards, division) => cards.forEach((card) => map.set(card.lsid, division)));
  return map;
}

function normalise(operation: string, params: Record<string, string>, body: unknown): unknown {
  if (!body || typeof body !== 'object') return body;
  const tdid = params.tdid;
  if (operation === 'league/schedule/get' && tdid) {
    const b = structuredClone(body) as { schedule?: { lsid: string; t?: string }[][] };
    b.schedule?.forEach((cards) =>
      cards.forEach((card) => {
        // The demo's cards before their first game are played today (their fixture says so).
        if (tdid === DEMO_TDID && PRE_START[card.lsid]) card.t = todayTitle();
        card.lsid = short(tdid, card.lsid);
      }),
    );
    return b;
  }
  if (operation === 'tournament/get' && tdid) {
    const b = structuredClone(body) as DocLike & { tournament: { lg_result?: Record<string, unknown>; lg_setting?: Record<string, unknown> } };
    const schedule = raw('league/schedule/get', { tdid }) as { schedule?: { p: string[]; lsid: string }[][] } | undefined;
    const sides = new Map<string, string[]>();
    schedule?.schedule?.forEach((cards) => cards.forEach((card) => sides.set(card.lsid, card.p)));
    const results: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(b.tournament.lg_result ?? {})) {
      const games = (value as { games?: { win_tpid: string }[] }).games;
      const lsid = key.slice(key.indexOf('_') + 1);
      const teams = sides.get(lsid);
      if (!games || !teams || !teams[0] || !teams[1]) continue;
      const won = (tpid: string): number => games.filter((game) => game.win_tpid === tpid).length;
      results[`${key.slice(0, key.indexOf('_'))}_${short(tdid, lsid)}`] = {
        [teams[0]]: { [teams[1]]: { r: won(teams[0]) } },
        [teams[1]]: { [teams[0]]: { r: won(teams[1]) } },
      };
    }
    b.tournament.lg_result = results as typeof b.tournament.lg_result;
    b.tournament.lg_setting = { ...(b.tournament.lg_setting ?? {}), point_w: 2, point_d: 1, point_l: 0, include_set: 1 };
    // Names for the games, as n01 leagues give them (the fixture has none): ガロン, ダブルス1 …
    const setting = b.tournament.lg_setting as { schedule?: SlotLike[]; game_setting?: { schedule?: SlotLike[] }[] };
    nameSlots(setting.schedule);
    for (const division of setting.game_setting ?? []) nameSlots(division.schedule);
    return b;
  }
  if (operation === 'match/list' && tdid) {
    const divisions = divisionOfCard(tdid);
    const b = structuredClone(body) as { list?: Record<string, unknown>[] };
    for (const row of b.list ?? []) {
      const tmid = String(row.tmid ?? '');
      const rest = tmid.slice(`${tdid}_lg_`.length);
      const parts = rest.split('_');
      const teams = parts.slice(-2);
      const lsid = parts.slice(0, -2).join('_');
      if (divisions.has(lsid)) row.tmid = `${tdid}_lg_${divisions.get(lsid)}_${short(tdid, lsid)}_${teams[0]}_${teams[1]}`;
    }
    return b;
  }
  return body;
}

interface SlotLike {
  schid: string;
  subTitle?: string;
  num_part: number;
}

/** 「ガロン」「ダブルス1」「シングルス1」「トリオス」 by the number of players, in schedule order. */
function nameSlots(slots: SlotLike[] | undefined): void {
  const count = new Map<number, number>();
  for (const slot of slots ?? []) {
    if (slot.subTitle) continue;
    const n = (count.get(slot.num_part) ?? 0) + 1;
    count.set(slot.num_part, n);
    slot.subTitle = slot.num_part >= 4 ? 'ガロン' : slot.num_part === 3 ? (n > 1 ? `トリオス${n}` : 'トリオス') : `${slot.num_part === 2 ? 'ダブルス' : 'シングルス'}${n}`;
  }
}

function find(operation: string, params: Record<string, string>): unknown | undefined {
  return normalise(operation, params, raw(operation, params));
}

/** Every league game row of a season, gathered from the per-team pages of the fixtures. */
function seasonRows(tdid: string): Record<string, unknown>[] {
  const rows = new Map<string, Record<string, unknown>>();
  for (const dataset of datasets) {
    for (const [key, value] of dataset.entries()) {
      if (!key.startsWith('match/list') || !key.includes(tdid)) continue;
      const list = (normalise('match/list', { tdid }, value) as { list?: Record<string, unknown>[] }).list ?? [];
      for (const row of list) rows.set(String(row.mid), row);
    }
  }
  return [...rows.values()].sort((a, b) => Number(a.startTime) - Number(b.startTime));
}

interface DocLike {
  tournament: {
    tdid: string;
    lg_title?: string[];
    lg_table?: string[][];
    lg_result?: Record<string, Record<string, Record<string, { r: number }>>>;
    lg_setting?: { point_w?: number; point_d?: number; point_l?: number; include_set?: number };
    entry_list?: { tpid: string; name: string }[];
  };
}

function standings(tdid: string): unknown {
  const doc = find('tournament/get', { tdid }) as DocLike | undefined;
  if (!doc) return undefined;
  const t = doc.tournament;
  const rule = t.lg_setting ?? {};
  const names = new Map((t.entry_list ?? []).map((entry) => [entry.tpid, entry.name]));
  return {
    result: 0,
    tdid,
    groups: (t.lg_table ?? []).map((teams, index) => {
      const rows = teams.filter((id) => id && id !== 'empty').map((tpid) => {
        let w = 0, d = 0, l = 0, games = 0;
        for (const [key, card] of Object.entries(t.lg_result ?? {})) {
          if (!key.startsWith(`${index}_`) || !card[tpid]) continue;
          const [vs, mine] = Object.entries(card[tpid])[0];
          const theirs = card[vs]?.[tpid]?.r ?? 0;
          games += mine.r;
          if (mine.r > theirs) w += 1;
          else if (mine.r < theirs) l += 1;
          else d += 1;
        }
        const pts = w * (rule.point_w ?? 2) + d * (rule.point_d ?? 0) + l * (rule.point_l ?? 0) + (rule.include_set ? games : 0);
        return { tpid, name: names.get(tpid) ?? tpid, p: w + d + l, w, d, l, pts };
      });
      rows.sort((a, b) => b.pts - a.pts);
      return { kind: 'lg', index, title: t.lg_title?.[index] ?? `Division ${index + 1}`, players: rows.map((row, i) => ({ ...row, rank: row.p > 0 ? i + 1 : 0 })) };
    }),
  };
}

/** A plausible leg-by-leg record from a game row's totals (demo only). */
function gameDetail(mid: string): unknown {
  const row = [...datasets.flatMap((dataset) => [...dataset.values()])]
    .flatMap((value) => ((value as { list?: Record<string, unknown>[] }).list ?? []))
    .find((entry) => entry.mid === mid);
  if (!row) return undefined;
  const sides = row.statsData as { winLegs: number; allScore: number; allDarts: number }[];
  const legs: unknown[] = [];
  const wins = [sides[0].winLegs, sides[1].winLegs];
  const total = wins[0] + wins[1];
  for (let leg = 0; leg < total; leg += 1) {
    const winner = leg < wins[1] ? 1 : 0;
    const playerData = [0, 1].map((side) => {
      const avg = Math.max(30, Math.round((sides[side].allScore / Math.max(1, sides[side].allDarts)) * 3));
      const visits = [{ score: 0, left: 501 }];
      let left = 501;
      for (let v = 0; v < 12 && left > 0; v += 1) {
        const score = Math.min(avg, left);
        if (side === winner && left - score <= 0) {
          visits.push({ score: -3, left: 0 });
          left = 0;
        } else if (side !== winner && left - score <= 40) {
          visits.push({ score: 0, left });
          break;
        } else {
          left -= score;
          visits.push({ score, left });
        }
      }
      if (side === winner && left > 0) visits.push({ score: -3, left: 0 });
      return visits;
    });
    legs.push({ first: leg % 2, endFlag: 1, winner, playerData });
  }
  return { result: 0, match: { mid, match_type: row.match_type, startScore: 501, endMatch: 1, legData: legs } };
}

// ---------------------------------------------------------------------------
// The live simulator: one scheduled card of the ATDO fixture season, singles 501.
// ---------------------------------------------------------------------------

interface LiveCard {
  tdid: string;
  tmid: string;
  sides: [{ tpid: string; name: string }, { tpid: string; name: string }];
  slots: { schid: string; label: string; numPart: number }[];
}

function liveCard(): LiveCard | null {
  const schedule = find('league/schedule/get', { tdid: 't_ABvC_5234' }) as { schedule?: { p: string[]; lsid: string }[][] } | undefined;
  const doc = find('tournament/get', { tdid: 't_ABvC_5234' }) as (DocLike & { tournament: { lg_setting?: { schedule?: { schid: string; subTitle?: string; num_part: number }[] } } }) | undefined;
  if (!schedule?.schedule || !doc) return null;
  const names = new Map((doc.tournament.entry_list ?? []).map((entry) => [entry.tpid, entry.name]));
  const slots = (doc.tournament.lg_setting?.schedule ?? []).map((slot, index) => ({ schid: slot.schid, label: slot.subTitle ?? `Game ${index + 1}`, numPart: slot.num_part }));
  if (slots.length < 5) return null;
  for (const [division, cards] of schedule.schedule.entries()) {
    for (const card of cards) {
      if (!card.p[0] || !card.p[1] || card.p[1] === 'empty' || doc.tournament.lg_result?.[`${division}_${card.lsid}`]) continue;
      return {
        tdid: 't_ABvC_5234',
        tmid: `t_ABvC_5234_lg_${division}_${card.lsid}_${card.p[0]}_${card.p[1]}`,
        sides: [
          { tpid: card.p[0], name: names.get(card.p[0]) ?? card.p[0] },
          { tpid: card.p[1], name: names.get(card.p[1]) ?? card.p[1] },
        ],
        slots,
      };
    }
  }
  return null;
}

const LIVE = liveCard();

interface PreCard {
  stage: PreStage;
  /** n01's form: the team ids in code-unit order. */
  tmid: string;
  teams: [{ tpid: string; name: string }, { tpid: string; name: string }];
  slots: SlotLike[];
}

let preCache: PreCard[] | null = null;
function preCards(): PreCard[] {
  if (preCache) return preCache;
  const schedule = raw('league/schedule/get', { tdid: DEMO_TDID }) as { schedule?: { p: string[]; lsid: string }[][] } | undefined;
  const doc = find('tournament/get', { tdid: DEMO_TDID }) as (DocLike & { tournament: { lg_setting?: { schedule?: SlotLike[]; game_setting?: { round: number; schedule?: SlotLike[] }[] } } }) | undefined;
  const names = new Map((doc?.tournament.entry_list ?? []).map((entry) => [entry.tpid, entry.name]));
  const cards: PreCard[] = [];
  schedule?.schedule?.forEach((list, division) => {
    for (const card of list) {
      const stage = PRE_START[card.lsid];
      if (!stage || !card.p[0] || !card.p[1]) continue;
      const slots = doc?.tournament.lg_setting?.game_setting?.find((entry) => entry.round === division)?.schedule ?? doc?.tournament.lg_setting?.schedule ?? [];
      const ids = [...card.p].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
      cards.push({
        stage,
        tmid: `${DEMO_TDID}_lg_${division}_${short(DEMO_TDID, card.lsid)}_${ids[0]}_${ids[1]}`,
        teams: [
          { tpid: card.p[0], name: names.get(card.p[0]) ?? card.p[0] },
          { tpid: card.p[1], name: names.get(card.p[1]) ?? card.p[1] },
        ],
        slots,
      });
    }
  });
  preCache = cards;
  return cards;
}

const GIVEN = ['一郎', '次郎', '三郎', '四郎', '五郎'];
/** The members of a planned game: made-up names, `changed` swaps the second singles player for a helper. */
function plannedMembers(card: PreCard, side: 0 | 1, slotIndex: number, changed: boolean): { oid: string; opid: string; oname: string }[] {
  const slot = card.slots[slotIndex];
  const team = card.teams[side];
  if (changed && side === 0 && slot.subTitle === 'シングルス2') return [{ oid: `${team.tpid}h`, opid: '', oname: `${team.name}・助っ人（助っ人）` }];
  return Array.from({ length: slot.num_part }, (_, k) => {
    const n = (slotIndex + k) % GIVEN.length;
    return { oid: `${team.tpid}${n}`, opid: `D-${team.tpid}-${n}`, oname: `${team.name}・${GIVEN[n]}` };
  });
}

/** `team/order/list` of a card before its first game, as its stage says now. */
function preOrders(card: PreCard, now: number): unknown {
  if (card.stage === 'flaky' && Math.floor((now - START) / 45_000) % 2 === 1) return UNAVAILABLE;
  const minute = Math.floor((now - START) / 60_000) % 3;
  const changed = card.stage === 'changing' && minute >= 1;
  const fixOf = (side: 0 | 1): number => (card.stage === 'unfixed' ? 0 : card.stage === 'oneSide' ? (side === 0 ? 1 : 0) : card.stage === 'changing' && minute === 2 && side === 1 ? 0 : 1);
  return {
    result: 0,
    list: card.slots.flatMap((slot, index) => ([0, 1] as const).map((side) => ({ tmid: card.tmid, tpid: card.teams[side].tpid, schid: slot.schid, fix: fixOf(side), order: plannedMembers(card, side, index, changed) }))),
  };
}

const startedCard = (now: number): PreCard | null => (now - START >= STARTS_AFTER_MS ? (preCards().find((card) => card.stage === 'starts') ?? null) : null);

/** The started card's first game, in progress (a still picture: its first visits). */
function startedLive(card: PreCard): Record<string, unknown> {
  const updateTime = START + STARTS_AFTER_MS + 20_000;
  const slot = card.slots[0];
  const start = slot.subTitle === 'ガロン' ? 1001 : 501;
  const throws = [
    { p: 0, r: 1, score: 100, left: start - 100, darts: 3 },
    { p: 1, r: 1, score: 85, left: start - 85, darts: 3 },
    { p: 0, r: 2, score: 60, left: start - 160, darts: 3 },
  ];
  return {
    result: 0,
    changed: 1,
    mid: `${card.tmid}_demo0`,
    tdid: DEMO_TDID,
    tmid: card.tmid,
    schid: slot.schid,
    title: `デモ ${slot.subTitle ?? ''}`,
    match_type: '01',
    updateTime,
    end_match: 0,
    end_schedule: 0,
    format: { limit_leg: 1, limit_set: card.slots.length, schedule: 1, start_score: start },
    show_sets: 1,
    sets: [0, 0],
    legs: [0, 0],
    current_leg: 0,
    leg_count: 1,
    players: ([0, 1] as const).map((side) => ({ name: card.teams[side].name, tpid: card.teams[side].tpid, order: plannedMembers(card, side, 0, false).map((m) => ({ oid: m.oid, name: m.oname })) })),
    stats: [{ avg: 80, score: 160, darts: 6 }, { avg: 85, score: 85, darts: 3 }],
    leg: { leg: 0, first: 0, end: 0, winner: null, time: updateTime, start: [start, start], left: [start - 160, start - 85], thrower: 1, round: 2, throws },
  };
}

function startedRow(card: PreCard): Record<string, unknown> {
  const state = startedLive(card);
  return {
    mid: state.mid,
    tdid: DEMO_TDID,
    tmid: card.tmid,
    schid: state.schid,
    match_type: '01',
    title: state.title,
    startTime: Math.floor((START + STARTS_AFTER_MS) / 1000),
    updateTime: state.updateTime,
    endMatch: 0,
    statsData: ([0, 1] as const).map((side) => ({ name: card.teams[side].name, tpid: card.teams[side].tpid, order: plannedMembers(card, side, 0, false), winLegs: 0, allScore: side === 0 ? 160 : 85, allDarts: side === 0 ? 6 : 3 })),
  };
}
const VISITS = [60, 45, 100, 81, 26, 140, 41, 57, 85, 60, 100, 45, 60, 21, 40, 32, 60, 100, 36, 16];
const STEP_MS = 4000;
/** The demo card: three games already played (winners A, B, A), the fourth live, three to come. */
const DONE_WINNERS: (0 | 1)[] = [0, 1, 0];
const LIVE_SLOT = 3;
const member = (side: number, slot: number, k: number): string => `デモ${side === 0 ? 'A' : 'B'}${slot + 1}-${k + 1}`;
const members = (side: number, slot: number): { oid: string; oname: string; name: string }[] =>
  Array.from({ length: LIVE?.slots[slot]?.numPart ?? 1 }, (_, k) => ({ oid: `d${side}${slot}${k}`, oname: member(side, slot, k), name: member(side, slot, k) }));

/** Visits of a plausible leg: the winner checks out, the loser stops short. */
function legVisits(winner: 0 | 1, avg: [number, number]): Record<string, unknown>[] {
  const left: [number, number] = [501, 501];
  const throws: Record<string, unknown>[] = [];
  for (let r = 1; r <= 15; r += 1) {
    for (const side of [0, 1] as const) {
      const score = Math.min(avg[side] + ((r * 7 + side * 13) % 21) - 10, left[side]);
      if (side === winner && left[side] - score <= 0) {
        throws.push({ p: side, r, score: left[side], left: 0, darts: 2, finish: 1 });
        return throws;
      }
      if (side !== winner && left[side] - score <= 30) {
        throws.push({ p: side, r, score: 0, left: left[side], darts: 3 });
        continue;
      }
      left[side] -= score;
      throws.push({ p: side, r, score, left: left[side], darts: 3 });
    }
  }
  return throws;
}

function doneLegs(slot: number): Record<string, unknown>[] {
  const winner = DONE_WINNERS[slot];
  const order: (0 | 1)[] = winner === 0 ? [0, 1, 0] : [1, 0, 1];
  return order.map((w, leg) => {
    const throws = legVisits(w, [62 + slot * 2, 58 + slot]);
    const darts = [0, 1].map((side) => throws.filter((t) => t.p === side).reduce((sum, t) => sum + Number(t.darts), 0));
    return { leg, first: leg % 2, end: 1, winner: w, time: START - (LIVE_SLOT - slot) * 900_000, start: [501, 501], darts, throws };
  });
}

function doneRow(slot: number): Record<string, unknown> {
  const legs = doneLegs(slot);
  const side = (index: number): Record<string, unknown> => {
    const throws = legs.flatMap((leg) => (leg.throws as Record<string, unknown>[]).filter((t) => t.p === index));
    return {
      name: LIVE!.sides[index].name,
      tpid: LIVE!.sides[index].tpid,
      order: members(index, slot),
      winLegs: legs.filter((leg) => leg.winner === index).length,
      allScore: throws.reduce((sum, t) => sum + Number(t.score), 0),
      allDarts: throws.reduce((sum, t) => sum + Number(t.darts), 0),
    };
  };
  return {
    mid: `${LIVE!.tmid}_demo${slot}`,
    tdid: LIVE!.tdid,
    tmid: LIVE!.tmid,
    schid: LIVE!.slots[slot].schid,
    match_type: '01',
    title: `デモ ${LIVE!.slots[slot].label}`,
    startTime: Math.floor(START / 1000) - (LIVE_SLOT - slot) * 900,
    updateTime: START - (LIVE_SLOT - slot - 1) * 900_000,
    endMatch: 1,
    statsData: [side(0), side(1)],
  };
}

/** The live game, `steps` visits in (it starts over after the finish). */
function liveState(now: number): Record<string, unknown> | null {
  if (!LIVE) return null;
  const steps = Math.floor((now - START) / STEP_MS) % (VISITS.length + 4);
  const left: [number, number] = [501, 501];
  const throws: Record<string, unknown>[] = [];
  let finished: 0 | 1 | null = null;
  const names = [member(0, LIVE_SLOT, 0), member(1, LIVE_SLOT, 0)];
  for (let i = 0; i < Math.min(steps, VISITS.length); i += 1) {
    const side = (i % 2) as 0 | 1;
    const score = Math.min(VISITS[i], left[side]);
    const finish = left[side] - score === 0;
    left[side] -= score;
    throws.push({ p: side, r: Math.floor(i / 2) + 1, score, left: left[side], darts: 3, ...(finish ? { finish: 1 } : {}) });
    if (finish) {
      finished = side;
      break;
    }
  }
  const updateTime = START + Math.min(steps, throws.length) * STEP_MS;
  const thrower = throws.length % 2;
  const won = [DONE_WINNERS.filter((w) => w === 0).length, DONE_WINNERS.filter((w) => w === 1).length];
  return {
    result: 0,
    changed: 1,
    mid: `${LIVE.tmid}_demo${LIVE_SLOT}`,
    tdid: LIVE.tdid,
    tmid: LIVE.tmid,
    schid: LIVE.slots[LIVE_SLOT].schid,
    title: `デモ ${LIVE.slots[LIVE_SLOT].label}`,
    match_type: '01',
    updateTime,
    end_match: 0,
    end_schedule: 0,
    format: { limit_leg: 2, limit_set: LIVE.slots.length, schedule: 1, start_score: 501 },
    show_sets: 1,
    sets: won,
    legs: finished === null ? [0, 0] : finished === 0 ? [1, 0] : [0, 1],
    current_leg: 0,
    leg_count: 1,
    players: [0, 1].map((side) => ({ name: LIVE!.sides[side].name, tpid: LIVE!.sides[side].tpid, order: [{ oid: `d${side}${LIVE_SLOT}0`, name: names[side] }] })),
    stats: [0, 1].map((side) => {
      const mine = throws.filter((entry) => entry.p === side) as { score: number }[];
      const score = mine.reduce((sum, entry) => sum + entry.score, 0);
      return { avg: mine.length ? Math.round((score / mine.length) * 100) / 100 : 0, score, darts: mine.length * 3 };
    }),
    leg: {
      leg: 0,
      first: 0,
      end: finished === null ? 0 : 1,
      winner: finished,
      time: updateTime,
      start: [501, 501],
      left,
      thrower: finished === null ? thrower : null,
      round: Math.floor(throws.length / 2) + 1,
      throws,
    },
  };
}

function liveRow(now: number): Record<string, unknown> | null {
  const state = liveState(now);
  if (!state || !LIVE) return null;
  return {
    mid: state.mid,
    tdid: LIVE.tdid,
    tmid: LIVE.tmid,
    schid: LIVE.slots[LIVE_SLOT].schid,
    match_type: '01',
    title: state.title,
    startTime: Math.floor(START / 1000),
    updateTime: state.updateTime,
    endMatch: 0,
    statsData: [0, 1].map((side) => ({ name: LIVE!.sides[side].name, tpid: LIVE!.sides[side].tpid, order: members(side, LIVE_SLOT), winLegs: 0, allScore: 0, allDarts: 0 })),
  };
}

/** `match/throws` for a fixture game, from its per-round record. */
function fixtureThrows(mid: string): unknown {
  const detail = gameDetail(mid) as { match: { match_type: string; legData: { first: number; winner: number; playerData: { score: number; left: number }[][] }[] } } | undefined;
  if (!detail) return undefined;
  const leg_data = detail.match.legData.map((leg, index) => {
    const throws: Record<string, unknown>[] = [];
    const rounds = Math.max(leg.playerData[0].length, leg.playerData[1].length);
    for (let r = 1; r < rounds; r += 1) {
      for (const side of [leg.first, 1 - leg.first]) {
        const visit = leg.playerData[side][r];
        if (!visit) continue;
        const before = leg.playerData[side][r - 1].left;
        if (visit.score < 0) throws.push({ p: side, r, score: before, left: 0, darts: -visit.score, finish: 1 });
        else throws.push({ p: side, r, score: visit.score, left: visit.left, darts: 3 });
      }
    }
    return { leg: index, first: leg.first, end: 1, winner: leg.winner, start: [501, 501], throws };
  });
  return { result: 0, changed: 1, mid, match_type: detail.match.match_type, end_match: 1, updateTime: START, leg_data };
}

function todayRows(): Record<string, unknown>[] {
  const started = startedCard(Date.now());
  return [...(LIVE ? [...DONE_WINNERS.map((_, slot) => doneRow(slot)), liveRow(Date.now())!] : []), ...(started ? [startedRow(started)] : [])];
}

/**
 * The made-up set-format match (src/test/n01/setMatch.ts) of 「いま n01 で進行中 → 個別の試合」: a
 * phase every SET_PHASE_MS — a set in play, then over and the next awaited — so a reviewer sees
 * the page move to the next set by itself and can open the earlier ones. After the match ends
 * it stays ended for a while, then starts again.
 */
const SET_PHASE_MS = 25_000;
function setPhase(now: number): number {
  return Math.min(LAST_PHASE, Math.floor((now - START) / SET_PHASE_MS) % (LAST_PHASE + 3));
}

/**
 * 観戦の n01オンライン・n01トーナメント・n01リーグの一覧 (src/test/n01/browse.ts の架空の一覧)。
 * 先頭の大会は、このデモで開ける大会 (ATDO のデモシーズン) に差し替える。
 */
function browseDemo(operation: string, params: Record<string, string>): unknown | undefined {
  const body = browseReply(operation, params) as { list?: Record<string, unknown>[] } | undefined;
  if (body?.list && operation === 'tournament/list') {
    return { ...body, list: body.list.map((row) => (row.tdid === BROWSE_JDO_EVENT ? { ...row, tdid: 't_ABvC_5234', title: 'デモ: ATDO シーズン (大会の画面で表示)', lgid: undefined } : row)) };
  }
  return body;
}

function respond(operation: string, params: Record<string, string>): unknown | undefined {
  const browse = browseDemo(operation, params);
  if (browse !== undefined) return browse;
  const set = setMatchReply(operation, params, setPhase(Date.now()));
  if (set !== undefined) {
    // The live list holds the demo card too.
    if (operation === 'match/list' && params.live === '1' && !params.tdid && !params.mid && !params.scid) {
      return { result: 0, list: [...((set as { list: unknown[] }).list ?? []), ...todayRows().filter((row) => row.endMatch === 0)] };
    }
    return set;
  }
  // Everything in progress on n01 / one game by id: the demo card's games.
  if (operation === 'match/list' && !params.tdid && params.live === '1' && !params.mid) return { result: 0, list: todayRows().filter((row) => row.endMatch === 0) };
  if (operation === 'match/list' && params.mid && !params.tdid) {
    const row = todayRows().find((entry) => entry.mid === params.mid);
    return { result: 0, list: row ? [row] : [] };
  }
  if (operation === 'tournament/list') return { result: 0, list: [] };
  if (operation === 'match/list' && params.tdid && !params.tmid__regex) {
    const skip = Number(params.skip ?? 0);
    const rows = params.live === '1' ? todayRows().filter((row) => row.endMatch === 0 && row.tdid === params.tdid) : [...seasonRows(params.tdid), ...todayRows().filter((row) => row.tdid === params.tdid)];
    return { result: 0, list: rows.slice(skip, skip + Number(params.count ?? 100)) };
  }
  if (operation === 'match/list' && params.tmid__regex === '_lg_' && params.tdid) {
    const today = LIVE && LIVE.tdid === params.tdid ? todayRows() : [];
    if (params.startTime__gte) return { result: 0, list: today };
    if (params.live === '1') return { result: 0, list: today.filter((row) => row.endMatch === 0) };
    const skip = Number(params.skip ?? 0);
    return { result: 0, list: [...seasonRows(params.tdid), ...today].slice(skip, skip + Number(params.count ?? 100)) };
  }
  if (operation === 'tournament/standings') return standings(params.tdid);
  if (operation === 'match/get') return gameDetail(params.mid);
  if (operation === 'match/throws') {
    if (LIVE && params.mid.startsWith(`${LIVE.tmid}_demo`)) {
      const slot = Number(params.mid.slice(`${LIVE.tmid}_demo`.length));
      if (slot === LIVE_SLOT) {
        const state = liveState(Date.now())!;
        return { result: 0, changed: 1, mid: params.mid, match_type: '01', end_match: 0, updateTime: state.updateTime, leg_data: [state.leg] };
      }
      return { result: 0, changed: 1, mid: params.mid, match_type: '01', end_match: 1, updateTime: START, leg_data: doneLegs(slot) };
    }
    return fixtureThrows(params.mid);
  }
  if (operation === 'team/order/list') {
    const pre = preCards().find((card) => card.tmid === params.tmid);
    if (pre) return preOrders(pre, Date.now());
    if (!LIVE || params.tmid !== LIVE.tmid) return { result: 0, list: [] };
    return {
      result: 0,
      list: LIVE.slots.flatMap((slot, index) => [0, 1].map((side) => ({ tmid: LIVE!.tmid, tpid: LIVE!.sides[side].tpid, schid: slot.schid, fix: 1, order: members(side, index) }))),
    };
  }
  if (operation === 'match/live' && params.tmid && preCards().some((card) => card.tmid === params.tmid)) {
    // Nothing to follow before the first game (n01: "match not found"); the started card's game after.
    const started = startedCard(Date.now());
    if (!started || started.tmid !== params.tmid) return undefined;
    const state = startedLive(started);
    if (params.since && Number(params.since) >= Number(state.updateTime)) return { result: 0, changed: 0, mid: state.mid, updateTime: state.updateTime };
    return state;
  }
  if (operation === 'match/throws' && params.mid.endsWith('_demo0') && preCards().some((card) => params.mid === `${card.tmid}_demo0`)) {
    const started = startedCard(Date.now());
    if (!started) return undefined;
    const state = startedLive(started);
    return { result: 0, changed: 1, mid: params.mid, match_type: '01', end_match: 0, updateTime: state.updateTime, leg_data: [state.leg] };
  }
  if (operation === 'match/live') {
    const state = liveState(Date.now());
    if (!state) return undefined;
    if (params.since && Number(params.since) >= Number(state.updateTime)) return { result: 0, changed: 0, mid: state.mid, updateTime: state.updateTime };
    return state;
  }
  return find(operation, params);
}

async function answer(operation: string, params: Record<string, string>): Promise<unknown> {
  // A little latency, so loading states are visible as they are on a phone.
  await new Promise((resolve) => setTimeout(resolve, 120));
  const body = respond(operation, params);
  if (body === undefined) throw new N01Error('notFound', 'n01 にデータが見つかりませんでした。', operation, 404);
  if (body === UNAVAILABLE) return UNAVAILABLE;
  return structuredClone(body);
}

/**
 * Answers the app's n01 GETs from the demo data. Only URLs under the n01 read API are taken;
 * anything else goes to the real `fetch` untouched.
 */
export function installDemoN01(base: string): void {
  const real = globalThis.fetch.bind(globalThis);
  globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if (!url.startsWith(`${base}/`)) return real(input, init);
    const parsed = new URL(url);
    const operation = parsed.pathname.slice(new URL(base).pathname.length + 1);
    const params = Object.fromEntries(parsed.searchParams.entries());
    try {
      const body = await answer(operation, params);
      if (body === UNAVAILABLE) return new Response(JSON.stringify({ result: -1, error: 'unavailable (demo)' }), { status: 503, headers: { 'content-type': 'application/json' } });
      return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
    } catch {
      return new Response(JSON.stringify({ result: -1, error: 'not found' }), { status: 404, headers: { 'content-type': 'application/json' } });
    }
  };
  const banner = document.createElement('div');
  banner.setAttribute('role', 'note');
  banner.textContent = `レビュー用プレビュー (commit ${__PREVIEW_COMMIT__}): n01 には接続せず、架空の模擬データを表示しています (ライブは自動で進む模擬試合。ATDO の本日の開始前カード: ${Object.values(PRE_TITLE).join('・')})。`;
  banner.style.cssText = 'position:sticky;top:0;z-index:50;padding:6px 16px;font-size:12px;background:#172026;color:#fff;text-align:center';
  document.body.prepend(banner);
}
