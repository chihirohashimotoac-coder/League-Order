import { describe, expect, it } from 'vitest';
import { matchSetsView, orderSets, setNameAtEnd, sharedTitle } from './matchSets';
import { lastPlayedLeg } from './ui/GameView';
import { mergeSources } from './ui/SetMatchPage';
import { parseThrows } from './parse';
import { setThrows } from '../../test/n01/setMatch';
import { parseGameRows, parseLive } from './parse';
import type { LiveState } from './parse';
import { LivePoller } from './livePoller';
import type { LiveStatus } from './livePoller';
import { SET_SCID, setLive, setMid, setRow } from '../../test/n01/setMatch';

const rows = (phase: number, sets: number[]) => parseGameRows({ result: 0, list: sets.map((set) => setRow(set, phase)) }).games;
const live = (set: number, phase: number): LiveState => parseLive(setLive(set, phase)) as LiveState;

describe('sets of one match (scid)', () => {
  it('orders by n01’s set position, not by the list’s order', () => {
    const list = rows(5, [2, 0, 1]);
    expect(orderSets(list).map((row) => row.mid)).toEqual([setMid(0), setMid(1), setMid(2)]);
  });

  it('names each set by the part of the title that differs', () => {
    expect(sharedTitle(['A vs B ダブルス1', 'A vs B ダブルス2'])).toBe('A vs B ');
    expect(sharedTitle(['only one'])).toBe('');
    // The first set alone: a set's name only where the title shows one, else 「第Nセット」.
    expect(matchSetsView(rows(0, [0]), null).sets[0].label).toBe('シングルス1');
    const plain = parseGameRows({ result: 0, list: [{ ...setRow(0, 0), title: 'Alpha vs Bravo' }] }).games;
    expect(matchSetsView(plain, null).sets[0].label).toBe('第1セット');
    const view = matchSetsView(rows(3, [0, 1]), null);
    expect(view.sets.map((set) => set.label)).toEqual(['シングルス1', 'ダブルス1']);
    expect(view.matchTitle).toBe('【デモリーグ】R3 Alpha Darts vs Bravo Arrows');
  });

  it('a team name ending in a number stays in the match’s name; a real set name is taken off', () => {
    const titled = (title: string) => matchSetsView(parseGameRows({ result: 0, list: [{ ...setRow(0, 0), title }] }).games, null);
    const team2 = titled('Test League Team A vs Team2');
    expect(team2.sets[0].label).toBe('第1セット');
    expect(team2.matchTitle).toBe('Test League Team A vs Team2');
    const both = titled('Test League Team A vs Team2 ダブルス1');
    expect(both.sets[0].label).toBe('ダブルス1');
    expect(both.matchTitle).toBe('Test League Team A vs Team2');
    expect(setNameAtEnd('A vs B シングルス 2')).toBe('シングルス 2');
    expect(setNameAtEnd('A vs B Set3')).toBe('Set3');
    expect(setNameAtEnd('A vs B2')).toBe('');
    expect(setNameAtEnd('ダブルス1')).toBe('');
    expect(setNameAtEnd('Darts Club 2026')).toBe('');
  });

  it('keeps each set’s legs and result apart from the sets won so far', () => {
    const view = matchSetsView(rows(3, [0, 1]), null);
    expect(view.sets[0]).toMatchObject({ legs: [2, 0], winner: 0, finished: true });
    expect(view.sets[1]).toMatchObject({ legs: [1, 2], winner: 1, finished: true });
    // 通算: one set each — not the legs of either set.
    expect(view.setsWon).toEqual([1, 1]);
  });

  it('shows the live set from the live state, even before the list holds it', () => {
    const view = matchSetsView(rows(2, [0]), live(1, 2));
    expect(view.sets.map((set) => set.mid)).toEqual([setMid(0), setMid(1)]);
    expect(view.sets[1]).toMatchObject({ live: true, fromLive: true, label: 'ダブルス1', finished: false, legs: [1, 1] });
    expect(view.sets[1].names[0]).toBe('Alpha 選手2-1 / Alpha 選手2-2');
    // The listed set keeps its own players.
    expect(view.sets[0].names[0]).toBe('Alpha 選手1-1');
  });

  it('the live state wins over a lagging row of the same set', () => {
    const stale = rows(2, [0, 1]);
    const view = matchSetsView(stale, live(1, 3));
    expect(view.sets[1]).toMatchObject({ finished: true, legs: [1, 2], winner: 1 });
  });
});

/** A manual clock + timer queue (as in matches.test.ts), following a `scid`. */
function harness(reply: (since: number | null) => unknown) {
  let now = 1_800_000_000_000;
  const timers: { at: number; fn: () => void; id: number }[] = [];
  let id = 0;
  const calls: { target: unknown; since: number | null }[] = [];
  const states: LiveState[] = [];
  const statuses: LiveStatus[] = [];
  const poller = new LivePoller(
    { live: async (target, since) => (calls.push({ target, since }), parseLive(reply(since))) },
    { scid: SET_SCID },
    {
      intervalMs: 1500,
      now: () => now,
      setTimer: (fn, ms) => {
        id += 1;
        timers.push({ at: now + ms, fn, id });
        return id;
      },
      clearTimer: (handle) => {
        const index = timers.findIndex((timer) => timer.id === handle);
        if (index >= 0) timers.splice(index, 1);
      },
      onState: (state) => states.push(state),
      onStatus: (status) => statuses.push(status),
    },
  );
  const step = async (): Promise<number | null> => {
    timers.sort((a, b) => a.at - b.at);
    const next = timers.shift();
    if (!next) return null;
    const wait = next.at - now;
    now = Math.max(now, next.at);
    next.fn();
    for (let i = 0; i < 3; i += 1) await new Promise((resolve) => setTimeout(resolve, 0));
    return wait;
  };
  return { poller, step, calls, states, statuses, timers };
}

describe('LIVE MATCH: following a set-format match by scid', () => {
  it('keeps going after a set ends, follows the next set, and stops only at end_schedule', async () => {
    let phase = 0;
    const h = harness(() => setLive(Math.min(3, Math.floor(phase / 2)), phase));
    h.poller.start();
    await h.step();
    expect(h.calls[0]).toEqual({ target: { scid: SET_SCID }, since: null });
    phase = 1; // シングルス1 over, ダブルス1 not started
    await h.step();
    expect(h.states.at(-1)).toMatchObject({ mid: setMid(0), gameEnded: true, cardEnded: false });
    expect(h.timers).toHaveLength(1); // end_match alone does not stop it
    phase = 2; // ダブルス1 on
    await h.step();
    expect(h.states.at(-1)).toMatchObject({ mid: setMid(1), gameEnded: false });
    phase = 7; // the match is over
    await h.step();
    expect(h.states.at(-1)).toMatchObject({ mid: setMid(3), cardEnded: true });
    expect(h.statuses.at(-1)).toEqual({ kind: 'finished' });
    expect(h.timers).toHaveLength(0);
  });

  it('a since read naming a new set without its detail is read again at once, without since', async () => {
    let phase = 1;
    const h = harness((since) => {
      const set = Math.floor(phase / 2);
      const body = setLive(set, phase);
      if (since !== null && phase === 2) return { result: 0, changed: 0, mid: body.mid, updateTime: body.updateTime };
      return body;
    });
    h.poller.start();
    await h.step();
    phase = 2;
    await h.step(); // changed 0, mid of ダブルス1
    const wait = await h.step();
    expect(wait).toBe(0);
    expect(h.calls.at(-1)?.since).toBeNull();
    expect(h.states.at(-1)).toMatchObject({ mid: setMid(1) });
  });

  it('a late reply about an earlier set never replaces the later one', async () => {
    let n = 0;
    const h = harness(() => {
      n += 1;
      return n === 2 ? setLive(0, 1) : setLive(1, 2);
    });
    h.poller.start();
    await h.step();
    await h.step();
    expect(h.states.map((state) => state.mid)).toEqual([setMid(1)]);
  });

  it('a set match whose sets n01 does not show (show_sets 0) still ends only at end_schedule', async () => {
    const body = { ...setLive(0, 1), show_sets: 0 };
    const h = harness(() => body);
    h.poller.start();
    await h.step();
    await h.step();
    expect(h.states.at(-1)).toMatchObject({ gameEnded: true, cardEnded: false, showSets: false });
    expect(h.statuses.at(-1)).toMatchObject({ kind: 'polling' });
    expect(h.timers).toHaveLength(1);
  });
});

describe('the leg a finished set opens on', () => {
  it('is the last leg played, not a leg n01 holds that never began (2026-11-16 ダブルス1)', () => {
    const body = setThrows(1, 3, true); // ダブルス1 over after 3 legs, a 4th held with no throw
    const reply = parseThrows(body);
    expect(reply.legs.map((leg) => leg.throws.length > 0)).toEqual([true, true, true, false]);
    expect(lastPlayedLeg(reply.legs)).toBe(2);
    // A leg seen ended counts even without a throw recorded.
    const ended = reply.legs.map((leg, index) => (index === 3 ? { ...leg, ended: true } : leg));
    expect(lastPlayedLeg(ended)).toBe(3);
    expect(lastPlayedLeg([])).toBeNull();
  });
});

describe('the two lists of sets (archive, live)', () => {
  it('merges by mid, the archive first; null only while neither was read; [] is a read', () => {
    const a = rows(5, [0, 1]);
    const b = rows(4, [1, 2]);
    expect(mergeSources(a, b)!.map((row) => [row.mid, row.finished])).toEqual([
      [setMid(0), true],
      [setMid(1), true],
      [setMid(2), false],
    ]);
    expect(mergeSources(null, null)).toBeNull();
    expect(mergeSources([], null)).toEqual([]);
    expect(mergeSources(null, b)!.length).toBe(2);
  });
});
