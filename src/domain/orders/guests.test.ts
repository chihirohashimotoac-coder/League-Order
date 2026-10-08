import { describe, expect, it } from 'vitest';
import type { AppSettings, Player, Team } from '../types';
import { createMatchInfo } from '../types';
import { DEFAULT_OPTIMIZER_SETTINGS, DEFAULT_WEIGHTS } from './presets';
import { createParticipantConfig, syncParticipants } from './participants';
import { createVersion, orderFingerprint } from './lifecycle';
import { planSeasonCommit, planSeasonWithdrawal } from './seasonLedger';
import { newGuest, newMember, isGuest } from '../players/newPlayer';
import { buildNextMatchOrder, eligiblePlayers, previousAvailability } from '../n01/nextMatch';
import { generateOrder } from '../../optimizer/generateOrder';
import { createUndoable, undoableReducer } from '../../state/orderSession';
import { buildShareLayout, shareableFromVersion } from '../../share/layout';
import { format, player, sampleFormatGames, TEAM_ID } from '../../test/factories';

/**
 * F06: 今回限りの助っ人.
 *
 * A guest is a person for one order: in that order's players and participants with an id of
 * their own, generated under the same Hard and Soft conditions as everyone, kept through
 * every edit, save, version and share — and in none of the team roster, the next order or
 * the season totals.
 */

const TEAM: Team = { id: TEAM_ID, name: 'Us', createdAt: 0 };
const SETTINGS: AppSettings = {
  activeTeamId: TEAM_ID,
  optimizer: DEFAULT_OPTIMIZER_SETTINGS,
  lastPreset: 'BALANCED',
  customWeights: DEFAULT_WEIGHTS,
};
const roster = (): Player[] => [
  player({ id: 'p1', name: 'Aoki', rating: 14, ppr: 72 }),
  player({ id: 'p2', name: 'Baba', rating: 12, ppr: 66 }),
  player({ id: 'p3', name: 'Chiba', rating: 9, ppr: 55 }),
];

function guest(name = '助っ人 太郎', fields: { rating?: number | null; ppr?: number | null } = {}): Player {
  return newGuest(TEAM_ID, `gst_${name}`, { name, rating: fields.rating ?? null, ppr: fields.ppr ?? null, skills: {} }, 1_000);
}

function order(guests: readonly Player[] = [], attending = ['p1', 'p2', 'p3', ...guests.map((entry) => entry.id)]) {
  return buildNextMatchOrder({
    team: TEAM,
    players: roster(),
    guests,
    format: format(sampleFormatGames()),
    pairs: [],
    settings: SETTINGS,
    intel: null,
    attending: new Set(attending),
  });
}

describe('creating a guest', () => {
  it('is a guest with an id of its own, a trimmed name, and no evaluation data it was not given', () => {
    const made = newGuest(TEAM_ID, 'gst_1', { name: '  助っ人 太郎 ', rating: null, ppr: null, skills: {} }, 5);
    expect(isGuest(made)).toBe(true);
    expect(made).toMatchObject({ id: 'gst_1', teamId: TEAM_ID, name: '助っ人 太郎', rating: null, ppr: null, seasonAppearances: 0, archived: false });
    expect(made.n01).toBeUndefined();
    expect(isGuest(player({ id: 'p9', name: 'Regular' }))).toBe(false);
  });

  it('never takes n01’s shared 助っ人 string as its identity', () => {
    const made = newGuest(TEAM_ID, 'gst_2', { name: '助っ人', rating: null, ppr: null, skills: {} }, 5);
    expect(made.id).toBe('gst_2');
    expect(made.n01).toBeUndefined();
  });
});

describe('participants', () => {
  it('syncParticipants keeps a guest row (and what was set on it) when the roster is re-synced', () => {
    const helper = guest();
    const rows = [createParticipantConfig('p1'), { ...createParticipantConfig(helper.id), maxAppearances: 2 }];
    const synced = syncParticipants(rows, roster(), [helper]);
    expect(synced.map((row) => row.playerId)).toEqual(['p1', 'p2', 'p3', helper.id]);
    expect(synced.find((row) => row.playerId === helper.id)).toMatchObject({ include: true, maxAppearances: 2 });
  });

  it('without the guest, a stale guest row is dropped like any row of a person who is gone', () => {
    const helper = guest();
    const synced = syncParticipants([createParticipantConfig(helper.id)], roster());
    expect(synced.map((row) => row.playerId)).toEqual(['p1', 'p2', 'p3']);
  });
});

describe('the next-match order with a guest', () => {
  it('carries the guest in players and participants, and in no roster', () => {
    const helper = guest();
    const built = order([helper]);
    expect(built.input.players.map((entry) => entry.id)).toEqual(['p1', 'p2', 'p3', helper.id]);
    expect(built.input.players.find((entry) => entry.id === helper.id)).toMatchObject({ guest: true, name: '助っ人 太郎' });
    expect(built.input.participants.find((row) => row.playerId === helper.id)).toMatchObject({ include: true });
    expect(eligiblePlayers(roster()).some((entry) => entry.id === helper.id)).toBe(false);
  });

  it('generates with the guest under the same conditions, and rates a guest with no data as Unknown (not 0)', () => {
    const helper = guest();
    const built = order([helper]);
    expect(built.input.strengthBasis!.players[helper.id]).toMatchObject({ origin: 'unknown', ppr: null, confidence: 'LOW' });
    const result = generateOrder(built.input, { singleCandidate: true, timeLimitMs: 2000 });
    expect(result.ok).toBe(true);
    const solution = result.candidates[0];
    const tally = solution.tallies.find((entry) => entry.playerId === helper.id)!;
    expect(tally.count).toBeGreaterThan(0);
    expect(tally.ratingImputed).toBe(true);
    expect(tally.pprImputed).toBe(true);
    expect(tally.effectiveRating).not.toBe(0);
  });

  it('honours Hard conditions set on the guest like any participant', () => {
    const helper = guest('Sub', { rating: 10, ppr: 60 });
    const built = order([helper]);
    const withLimit = {
      ...built.input,
      participants: built.input.participants.map((row) => (row.playerId === helper.id ? { ...row, maxAppearances: 1 } : row)),
    };
    const result = generateOrder(withLimit, { singleCandidate: true, timeLimitMs: 2000 });
    expect(result.ok).toBe(true);
    expect(result.candidates[0].tallies.find((entry) => entry.playerId === helper.id)!.count).toBeLessThanOrEqual(1);
  });

  it('a guest is a participant by the same attendance as anybody else', () => {
    const helper = guest();
    const here = order([helper], ['p1', 'p2', helper.id]);
    expect(here.input.participants.find((row) => row.playerId === helper.id)!.include).toBe(true);
    // Unticked on the attendance list: still a person of this order, but not fielded.
    const out = order([helper], ['p1', 'p2']);
    expect(out.input.players.some((entry) => entry.id === helper.id)).toBe(true);
    expect(out.input.participants.find((row) => row.playerId === helper.id)!.include).toBe(false);
  });

  it('the next order does not inherit the guest, nor their attendance', () => {
    const helper = guest();
    const first = order([helper]);
    const next = buildNextMatchOrder({
      team: TEAM,
      players: roster(),
      format: format(sampleFormatGames()),
      pairs: [],
      settings: SETTINGS,
      intel: null,
      attending: new Set(['p1', 'p2', 'p3']),
      previous: first.input.participants,
    });
    expect(next.input.players.some((entry) => entry.id === helper.id)).toBe(false);
    expect(next.input.participants.some((row) => row.playerId === helper.id)).toBe(false);
    const availability = previousAvailability(roster(), first.input.participants, null);
    expect([...availability.keys()]).toEqual(['p1', 'p2', 'p3']);
  });
});

describe('keeping the guest through edits, undo, locks, versions and sharing', () => {
  function generated() {
    const helper = guest('助っ人 太郎', { rating: 8, ppr: 50 });
    const built = order([helper]);
    const result = generateOrder(built.input, { singleCandidate: true, timeLimitMs: 2000 });
    if (!result.ok) throw new Error('should generate');
    const session = undoableReducer(createUndoable(built.input), { type: 'generated', candidates: result.candidates });
    return { helper, built, session };
  }

  it('a manual edit re-evaluates with the guest in the order, and undo restores the line-up', () => {
    const { helper, session } = generated();
    const games0 = session.present.current!.assignments[0];
    const edited = undoableReducer(session, { type: 'assignPlayer', gameId: games0.gameId, slotIndex: 0, playerId: helper.id });
    expect(edited.present.current!.assignments[0].playerIds[0]).toBe(helper.id);
    expect(edited.present.input.players.some((entry) => entry.id === helper.id && entry.guest)).toBe(true);
    expect(edited.present.current!.tallies.some((tally) => tally.playerId === helper.id && tally.count > 0)).toBe(true);
    const undone = undoableReducer(edited, { type: 'undo' });
    expect(undone.present.current!.assignments).toEqual(session.present.current!.assignments);
    const redone = undoableReducer(undone, { type: 'redo' });
    expect(redone.present.current!.assignments[0].playerIds[0]).toBe(helper.id);
  });

  it('a locked guest stays where they are through a re-generation', () => {
    const { helper, session } = generated();
    const first = session.present.current!.assignments.find((assignment) => assignment.playerIds.includes(helper.id))!;
    const slotIndex = first.playerIds.indexOf(helper.id);
    const locked = undoableReducer(session, { type: 'toggleLock', gameId: first.gameId, slotIndex });
    const again = generateOrder(locked.present.input, { singleCandidate: true, timeLimitMs: 2000 });
    expect(again.ok).toBe(true);
    expect(again.candidates[0].assignments.find((assignment) => assignment.gameId === first.gameId)!.playerIds[slotIndex]).toBe(helper.id);
  });

  it('a saved version keeps the guest’s record and name whatever happens to the roster afterwards', () => {
    const { helper, built, session } = generated();
    const match = createMatchInfo('Us');
    const version = createVersion(built.input, session.present.current!, match, [], 10);
    expect(version.players.find((entry) => entry.id === helper.id)).toMatchObject({ guest: true, name: '助っ人 太郎', rating: 8 });
    expect(version.fingerprint).toBe(orderFingerprint(version.games, version.assignments, match));
    // The shared sheet names the guest from the version, not from the roster.
    const layout = buildShareLayout(version.games, version.players, shareableFromVersion(version), version.match, 'detail');
    const text = JSON.stringify(layout);
    expect(text).toContain('助っ人 太郎');
  });
});

describe('the season ledger', () => {
  function committed() {
    const helper = guest('助っ人 太郎', { rating: 8, ppr: 50 });
    const built = order([helper]);
    const result = generateOrder(built.input, { singleCandidate: true, timeLimitMs: 2000 });
    if (!result.ok) throw new Error('should generate');
    const version = createVersion(built.input, result.candidates[0], createMatchInfo('Us'), [], 10);
    return { helper, version };
  }

  it('counts only the roster: the guest is neither added to a player nor recorded in the ledger', () => {
    const { helper, version } = committed();
    expect(version.appearances.some((record) => record.playerId === helper.id)).toBe(true);
    const plan = planSeasonCommit('ord_1', TEAM_ID, version, null, roster(), 20);
    expect(plan.updatedPlayers.map((entry) => entry.id).sort()).toEqual(['p1', 'p2', 'p3']);
    expect(plan.updatedPlayers.some((entry) => entry.id === helper.id)).toBe(false);
    expect(plan.commit!.appearances.some((record) => record.playerId === helper.id)).toBe(false);
  });

  it('re-committing the same version, a revised one, and a withdrawal leave no ghost and no double count', () => {
    const { helper, version } = committed();
    const first = planSeasonCommit('ord_1', TEAM_ID, version, null, roster(), 20);
    const afterFirst = roster().map((entry) => first.updatedPlayers.find((updated) => updated.id === entry.id) ?? entry);
    const again = planSeasonCommit('ord_1', TEAM_ID, version, first.commit, afterFirst, 30);
    expect(again.noop).toBe(true);
    expect(again.updatedPlayers).toEqual([]);

    // v2: the guest plays one game fewer in the revision.
    const revised = {
      ...version,
      version: 2,
      appearances: version.appearances.map((record) =>
        record.playerId === helper.id ? { ...record, count: Math.max(0, record.count - 1) } : record,
      ),
    };
    const second = planSeasonCommit('ord_1', TEAM_ID, revised, first.commit, afterFirst, 40);
    expect(second.updatedPlayers).toEqual([]);
    expect(second.commit!.appearances.some((record) => record.playerId === helper.id)).toBe(false);

    const withdrawn = planSeasonWithdrawal(first.commit!, afterFirst);
    const restored = afterFirst.map((entry) => withdrawn.updatedPlayers.find((updated) => updated.id === entry.id) ?? entry);
    expect(restored.map((entry) => entry.seasonAppearances)).toEqual(roster().map((entry) => entry.seasonAppearances));
  });
});

describe('a member added for next time is not a guest', () => {
  it('is an ordinary roster player, with the PPR policy the captain chose', () => {
    const withPpr = newMember(TEAM_ID, 'pl_new1', { name: '新人 一郎', rating: 7, ppr: 48, skills: {} }, 5);
    const without = newMember(TEAM_ID, 'pl_new2', { name: '新人 二郎', rating: null, ppr: null, skills: {} }, 5);
    expect(isGuest(withPpr)).toBe(false);
    expect(withPpr).toMatchObject({ pprSource: 'manual', ppr: 48 });
    expect(without.pprSource).toBeUndefined();
    expect(eligiblePlayers([withPpr, without]).map((entry) => entry.id)).toEqual(['pl_new1', 'pl_new2']);
  });
});
