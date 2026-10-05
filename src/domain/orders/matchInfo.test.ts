import { describe, expect, it } from 'vitest';
import { autoValuesOf, syncMatchWithTeam } from './matchInfo';
import { createMatchInfo, type MatchInfo } from '../types';

const team = (name: string, leagueName?: string) => ({ name, leagueName });

describe('syncMatchWithTeam', () => {
  it('adopts the team name and league when nothing has been entered yet', () => {
    const result = syncMatchWithTeam(createMatchInfo(), autoValuesOf(null), team('kalavinka', '秋季リーグ'));
    expect(result.teamName).toBe('kalavinka');
    expect(result.leagueName).toBe('秋季リーグ');
  });

  it('follows a rename of the team', () => {
    const first = syncMatchWithTeam(createMatchInfo(), autoValuesOf(null), team('マイチーム'));
    const auto = autoValuesOf(team('マイチーム'));
    const renamed = syncMatchWithTeam(first, auto, team('kalavinka'));
    expect(renamed.teamName).toBe('kalavinka');
  });

  it('follows a switch to a different team', () => {
    const current: MatchInfo = { ...createMatchInfo('チームA', 'リーグ1'), opponentName: 'Team B' };
    const result = syncMatchWithTeam(current, autoValuesOf(team('チームA', 'リーグ1')), team('チームB', 'リーグ2'));
    expect(result.teamName).toBe('チームB');
    expect(result.leagueName).toBe('リーグ2');
    // Fields that belong to the match, not the team, are untouched.
    expect(result.opponentName).toBe('Team B');
  });

  it('never overwrites a name the captain typed', () => {
    const current = { ...createMatchInfo('カスタム名', 'カスタムリーグ') };
    const result = syncMatchWithTeam(current, autoValuesOf(team('マイチーム', '元リーグ')), team('新チーム', '新リーグ'));
    expect(result.teamName).toBe('カスタム名');
    expect(result.leagueName).toBe('カスタムリーグ');
  });

  it('treats a cleared field as untouched and refills it', () => {
    const current = { ...createMatchInfo('', '') };
    const result = syncMatchWithTeam(current, autoValuesOf(team('マイチーム')), team('マイチーム', 'リーグ'));
    expect(result.teamName).toBe('マイチーム');
    expect(result.leagueName).toBe('リーグ');
  });

  it('handles a team with no league and no active team at all', () => {
    expect(syncMatchWithTeam(createMatchInfo(), autoValuesOf(null), team('A')).leagueName).toBe('');
    expect(syncMatchWithTeam(createMatchInfo('A'), autoValuesOf(team('A')), null).teamName).toBe('');
  });

  it('is idempotent when nothing changed', () => {
    const auto = autoValuesOf(team('マイチーム', 'リーグ'));
    const current = createMatchInfo('マイチーム', 'リーグ');
    expect(syncMatchWithTeam(current, auto, team('マイチーム', 'リーグ'))).toEqual(current);
  });
});
