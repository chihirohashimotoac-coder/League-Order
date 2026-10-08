import { describe, expect, it } from 'vitest';
import type { Player } from '../types';
import { newMember } from '../players/newPlayer';
import { planRosterSync, type RosterSourcePlayer } from './roster';
import { effectivePpr } from './effectivePpr';
import { TEAM_ID } from '../../test/factories';

/**
 * F07: a member added for next time, before n01 knows them.
 *
 * They are an ordinary roster player of the team from the moment they are added. When n01
 * later lists them, the two are joined only when that is safe — a stable id, or an exact
 * normalised name that is unique on both sides. Anything less is put to the captain with
 * the candidates; nothing is merged by guesswork, nothing is created twice, and a joined
 * player keeps their local id, their numbers, their aptitudes and their season totals.
 */

const CURRENT = 't_cur';
let counter = 0;
const newId = (): string => `pl_created${++counter}`;

function member(id: string, name: string, extra: Partial<Player> = {}): Player {
  return { ...newMember(TEAM_ID, id, { name, rating: 9, ppr: 52, skills: { SINGLES: 4 } }, 100), seasonAppearances: 3, ...extra };
}

function source(oid: string, name: string, opid: string | null = null, ppr: number | null = 60): RosterSourcePlayer {
  return {
    opid,
    oid,
    teamId: 'T1',
    name,
    stats: ppr === null ? null : { ppr, score: 1000, darts: 50, legs: 2, tournamentId: CURRENT, syncedAt: 1 },
  };
}

const sync = (local: Player[], roster: RosterSourcePlayer[], extra: { explicit?: ReadonlyMap<string, string | null>; deferAmbiguous?: boolean } = {}) =>
  planRosterSync({ teamId: TEAM_ID, localPlayers: local, source: roster, tournamentId: CURRENT, now: 5_000, newId, ...extra });

describe('joining a member with the n01 roster', () => {
  it('joins a unique exact name to the same local player and keeps everything the captain entered', () => {
    const local = member('pl_1', '田中 太郎');
    const result = sync([local], [source('o1', '田中 太郎', 'op_tanaka')]);
    expect(result.added).toEqual([]);
    const linked = result.upserts.find((entry) => entry.id === 'pl_1')!;
    expect(linked).toMatchObject({ id: 'pl_1', rating: 9, ppr: 52, seasonAppearances: 3, skills: { SINGLES: 4 }, pprSource: 'manual' });
    expect(linked.n01).toMatchObject({ opid: 'op_tanaka', currentOid: 'o1', rosterActive: true });
    // The typed PPR stays the one in use until the captain chooses n01's.
    expect(effectivePpr(linked)).toEqual({ value: 52, origin: 'manual' });
  });

  it('a member with no typed PPR takes n01’s once linked', () => {
    const local = member('pl_1', '田中 太郎', { ppr: null, pprSource: undefined });
    const linked = sync([local], [source('o1', '田中 太郎')]).upserts.find((entry) => entry.id === 'pl_1')!;
    expect(effectivePpr(linked)).toEqual({ value: 60, origin: 'n01' });
  });

  it('is idempotent: once linked, the next sync matches by id and changes nothing', () => {
    const first = sync([member('pl_1', '田中 太郎')], [source('o1', '田中 太郎', 'op_tanaka')]);
    const linked = first.upserts.find((entry) => entry.id === 'pl_1')!;
    const again = sync([linked], [source('o1', '田中 太郎', 'op_tanaka')]);
    expect(again.added).toEqual([]);
    expect(again.upserts.filter((entry) => entry.id !== 'pl_1')).toEqual([]);
  });

  it('a member n01 does not list is left alone: not deactivated, not deleted', () => {
    const waiting = member('pl_wait', '待機 次郎');
    const result = sync([waiting], [source('o9', '別の人', 'op_other')]);
    expect(result.deactivated).toEqual([]);
    expect(result.upserts.some((entry) => entry.id === 'pl_wait')).toBe(false);
  });
});

describe('when the match is not certain', () => {
  it('asks about a name that is on n01 twice, adding nobody and merging nobody', () => {
    const local = member('pl_1', '田中 太郎');
    const result = sync([local], [source('o1', '田中 太郎', 'op_a'), source('o2', '田中 太郎', 'op_b')], { deferAmbiguous: true });
    expect(result.added).toEqual([]);
    expect(result.upserts.filter((entry) => entry.n01)).toEqual([]);
    expect(result.pending.map((entry) => entry.source.oid).sort()).toEqual(['o1', 'o2']);
    expect(result.pending[0].candidates.map((candidate) => candidate.playerId)).toEqual(['pl_1']);
  });

  it('asks when two members share the name', () => {
    const result = sync([member('pl_1', '田中 太郎'), member('pl_2', '田中 太郎')], [source('o1', '田中 太郎')], { deferAmbiguous: true });
    expect(result.added).toEqual([]);
    expect(result.pending).toHaveLength(1);
    expect(result.pending[0].candidates.map((candidate) => candidate.playerId).sort()).toEqual(['pl_1', 'pl_2']);
  });

  it('does not take a different spelling for the same person, but offers the member as a candidate', () => {
    const result = sync([member('pl_1', '田中 太郎')], [source('o1', '田中太郎', 'op_t')], { deferAmbiguous: true });
    expect(result.added).toEqual([]);
    expect(result.upserts).toEqual([]);
    expect(result.pending).toHaveLength(1);
    expect(result.pending[0].candidates[0]).toMatchObject({ playerId: 'pl_1', likely: true });
  });

  it('a newcomer who resembles nobody on the roster is simply added', () => {
    const result = sync([], [source('o1', '新規 一郎', 'op_new')], { deferAmbiguous: true });
    expect(result.pending).toEqual([]);
    expect(result.added.map((entry) => entry.name)).toEqual(['新規 一郎']);
  });

  it('archived members are not offered, and a member already linked is not a candidate', () => {
    const archived = member('pl_old', '引退 三郎', { archived: true });
    const linkedElsewhere: Player = { ...member('pl_2', '連携 四郎'), n01: { opid: 'op_x', currentOid: 'ox', currentTpid: 'T1', sourceName: '連携 四郎', rosterActive: true, lastSeenTournamentId: CURRENT, lastSeenAt: 1, stats: null } };
    const result = sync([archived, linkedElsewhere], [source('o1', '新規 一郎', 'op_new')], { deferAmbiguous: true });
    expect(result.pending).toEqual([]);
    expect(result.added.map((entry) => entry.name)).toEqual(['新規 一郎']);
  });

  it('without deferral the wizard’s older behaviour stands: the unmatched player is added', () => {
    const result = sync([member('pl_1', '田中 太郎')], [source('o1', '田中太郎', 'op_t')]);
    expect(result.added.map((entry) => entry.name)).toEqual(['田中太郎']);
    expect(result.pending).toEqual([]);
  });
});

describe('the captain’s answer', () => {
  it('links the chosen member: same local id, same numbers and totals, no second record', () => {
    const local = member('pl_1', '田中 太郎');
    const result = sync([local], [source('o1', '田中太郎', 'op_t')], { explicit: new Map([['o1', 'pl_1']]), deferAmbiguous: true });
    expect(result.added).toEqual([]);
    expect(result.pending).toEqual([]);
    const linked = result.upserts.find((entry) => entry.id === 'pl_1')!;
    expect(linked).toMatchObject({ name: '田中太郎', rating: 9, seasonAppearances: 3, skills: { SINGLES: 4 } });
    expect(linked.n01).toMatchObject({ opid: 'op_t', currentOid: 'o1' });
    expect(result.upserts).toHaveLength(1);
  });

  it('"a different person" adds a new player and leaves the member alone', () => {
    const local = member('pl_1', '田中 太郎');
    const result = sync([local], [source('o1', '田中太郎', 'op_t')], { explicit: new Map([['o1', null]]), deferAmbiguous: true });
    expect(result.added.map((entry) => entry.name)).toEqual(['田中太郎']);
    expect(result.upserts.some((entry) => entry.id === 'pl_1')).toBe(false);
    expect(result.pending).toEqual([]);
  });

  it('answering one of two leaves the other still pending, with only the member not yet taken as a candidate', () => {
    const result = sync([member('pl_1', '田中 太郎'), member('pl_2', '佐藤 次郎')], [source('o1', '田中太郎'), source('o2', '佐藤次郎')], {
      explicit: new Map([['o1', 'pl_1']]),
      deferAmbiguous: true,
    });
    expect(result.upserts.find((entry) => entry.id === 'pl_1')!.n01!.currentOid).toBe('o1');
    expect(result.added).toEqual([]);
    expect(result.pending.map((entry) => entry.source.oid)).toEqual(['o2']);
    expect(result.pending[0].candidates.map((candidate) => candidate.playerId)).toEqual(['pl_2']);
  });
});
