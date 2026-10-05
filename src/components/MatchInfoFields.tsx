import type { MatchInfo } from '../domain/types';
import { Field } from './ui';

/**
 * Match context inputs (要件 §3).
 *
 * Shared by ORDER SETUP and the SHARE screen: the opponent is often only known once the
 * team arrives at the venue, so it has to be editable from the share step too.
 */
export function MatchInfoFields({
  value,
  onChange,
  showTeamName = true,
}: {
  value: MatchInfo;
  onChange: (next: MatchInfo) => void;
  showTeamName?: boolean;
}): React.JSX.Element {
  return (
    <>
      <Field label="リーグ名 (任意)" hint="入力すると共有画像の見出しになります。">
        <input
          type="text"
          value={value.leagueName}
          onChange={(event) => onChange({ ...value, leagueName: event.target.value })}
          placeholder="例: 秋季リーグ Div.2"
        />
      </Field>

      {showTeamName ? (
        <Field label="自チーム名">
          <input
            type="text"
            value={value.teamName}
            onChange={(event) => onChange({ ...value, teamName: event.target.value })}
            placeholder="例: kalavinka"
          />
        </Field>
      ) : null}

      <Field label="対戦相手 (任意)">
        <input
          type="text"
          value={value.opponentName}
          onChange={(event) => onChange({ ...value, opponentName: event.target.value })}
          placeholder="例: Team B"
        />
      </Field>

      <Field label="試合日 (任意)">
        <input
          type="date"
          value={value.matchDate}
          onChange={(event) => onChange({ ...value, matchDate: event.target.value })}
        />
      </Field>
    </>
  );
}
