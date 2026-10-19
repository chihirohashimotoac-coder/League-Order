import { describe, expect, it } from 'vitest';
import { orderOwnershipIssue } from './ownership';
import type { Player } from '../types';

const person = (id: string, teamId: string): Player => ({
  id,
  teamId,
  name: id,
  rating: null,
  ppr: null,
  skills: {},
  seasonAppearances: 0,
  seasonAppearancesByKind: {},
  archived: false,
  createdAt: 0,
});

describe('orderOwnershipIssue', () => {
  const input = { teamId: 'A', players: [person('a1', 'A'), person('a2', 'A')] };

  it('accepts a new order of the active team', () => {
    expect(orderOwnershipIssue({ activeTeamId: 'A', input, record: null })).toBeNull();
  });

  it('accepts a revision of the same team’s record', () => {
    expect(orderOwnershipIssue({ activeTeamId: 'A', input, record: { teamId: 'A', input } })).toBeNull();
  });

  it('refuses without an active team', () => {
    expect(orderOwnershipIssue({ activeTeamId: null, input, record: null })?.reason).toBe('noActiveTeam');
  });

  it('refuses an order generated for another team (the race: active B, input A)', () => {
    expect(orderOwnershipIssue({ activeTeamId: 'B', input, record: null })?.reason).toBe('inputTeam');
  });

  it('refuses to write one team’s input into another team’s record', () => {
    expect(orderOwnershipIssue({ activeTeamId: 'A', input, record: { teamId: 'B', input: { ...input, teamId: 'B' } } })?.reason).toBe(
      'recordTeam',
    );
  });

  it('refuses to update a record that already disagrees with itself', () => {
    const mixed = { teamId: 'B', input };
    expect(orderOwnershipIssue({ activeTeamId: 'B', input: { ...input, teamId: 'B', players: [] }, record: mixed })?.reason).toBe(
      'recordInputTeam',
    );
  });

  it('refuses another team’s member in the line-up, but accepts the team’s own guest', () => {
    const guest = { ...person('g1', 'A'), guest: true } as Player;
    expect(orderOwnershipIssue({ activeTeamId: 'A', input: { teamId: 'A', players: [...input.players, guest] }, record: null })).toBeNull();
    expect(
      orderOwnershipIssue({ activeTeamId: 'A', input: { teamId: 'A', players: [...input.players, person('b1', 'B')] }, record: null })?.reason,
    ).toBe('playerTeam');
  });
});
