import type { OrderInput, SavedOrder, TeamId } from '../types';

/**
 * Which team an order belongs to, checked right before anything is written.
 *
 * An order is one team's: its input was built from that team's roster, its record is
 * listed in that team's history and its finalized versions feed that team's season totals.
 * A write is refused — never repaired — when the pieces disagree, so one team's line-up
 * can never land in another team's history, roster or season ledger. Reading is never
 * blocked: a record that already disagrees can still be opened and viewed.
 */
export type OwnershipIssue =
  | { reason: 'noActiveTeam'; message: string }
  | { reason: 'inputTeam'; message: string }
  | { reason: 'recordTeam'; message: string }
  | { reason: 'recordInputTeam'; message: string }
  | { reason: 'playerTeam'; message: string };

export function orderOwnershipIssue(args: {
  activeTeamId: TeamId | null;
  input: Pick<OrderInput, 'teamId' | 'players'>;
  record: (Pick<SavedOrder, 'teamId'> & { input: Pick<OrderInput, 'teamId'> }) | null;
}): OwnershipIssue | null {
  const { activeTeamId, input, record } = args;
  if (!activeTeamId) {
    return { reason: 'noActiveTeam', message: 'チームが選択されていないため保存できません。' };
  }
  if (input.teamId !== activeTeamId) {
    return {
      reason: 'inputTeam',
      message: 'このオーダーは別のチームの条件で作られたため、現在のチームには保存できません。チームを確認して作り直してください。',
    };
  }
  if (record && record.teamId !== input.teamId) {
    return {
      reason: 'recordTeam',
      message: '保存済みのオーダーと現在のオーダーのチームが一致しないため、上書きしません。新規オーダーとして作り直してください。',
    };
  }
  if (record && record.input.teamId !== record.teamId) {
    return {
      reason: 'recordInputTeam',
      message: '保存済みのオーダーのチーム情報が一致しないため、上書きしません (閲覧はできます)。新規オーダーとして作り直してください。',
    };
  }
  // A guest carries the team it helped; an empty team id is only found in hand-edited data.
  const foreign = input.players.find((player) => player.teamId !== '' && player.teamId !== input.teamId);
  if (foreign) {
    return {
      reason: 'playerTeam',
      message: `別のチームのメンバー (${foreign.name}) が含まれているため保存できません。`,
    };
  }
  return null;
}
