import { useId } from 'react';
import type { GameAssignment, GameSlotDef, LeagueRules, ParticipantConfig, Player } from '../domain/types';
import { RULE_PLAY_KINDS, STRUCTURAL_KINDS } from '../domain/types';
import { playKindsOf, structuralKindsOf } from '../domain/games/format';
import {
  describeLeagueRules,
  hasLeagueRules,
  isDoublesPairGame,
  leagueRuleIssues,
  leagueRuleViolations,
  parseCapText,
  ruleKindLabel,
  tallyLeagueRules,
  type RuleCapKey,
  type RuleCapText,
} from '../domain/orders/leagueRules';
import { Icon } from './icons';

/**
 * League rules on screen (リーグ規則・必須条件): the editor in the format sheet, the summary on
 * SETUP and the check on the result screen. Every number comes from
 * `domain/orders/leagueRules.ts`, the same functions the optimizer and the validator use.
 * The rules are always labelled as hard conditions, apart from the policy weights.
 */

const COUNTING_NOTE =
  '1 ゲームへの配置を 1 回と数えます (投順やレッグ数では増えません)。人数区分と競技区分は別々に数え、Doubles 01 への 1 回の配置は Doubles 1 回・01 1 回です。01 と Cricket を併記したゲーム (メドレー) は 01 と Cricket に 1 回ずつ数え、総出場は 1 回のままです。';

interface RuleRow {
  key: RuleCapKey;
  label: string;
  unit: string;
}

function RuleInput({
  row,
  text,
  onChange,
}: {
  row: RuleRow;
  text: RuleCapText;
  onChange: (key: RuleCapKey, value: string) => void;
}): React.JSX.Element {
  const id = useId();
  const value = text[row.key] ?? '';
  const parsed = parseCapText(value);
  return (
    <div className="rule-row">
      <label className="rule-label" htmlFor={id}>
        {row.label}
      </label>
      <span className="rule-input">
        <input
          id={id}
          type="text"
          inputMode="numeric"
          autoComplete="off"
          value={value}
          placeholder="上限なし"
          aria-invalid={!parsed.ok}
          aria-describedby={parsed.ok ? undefined : `${id}-error`}
          onChange={(event) => onChange(row.key, event.target.value)}
          data-testid={`rule-${row.key}`}
        />
        <span className="rule-unit">{row.unit}</span>
      </span>
      {!parsed.ok ? (
        <p className="field-error" id={`${id}-error`} role="alert">
          {parsed.message}
        </p>
      ) : null}
    </div>
  );
}

/**
 * The rule inputs of one format. Only the categories the format plays are offered (plus any
 * rule already written for one it no longer plays, so nothing is hidden). Blank = no rule,
 * 0 = zero games — the two are never the same.
 */
export function LeagueRulesEditor({
  games,
  text,
  onChange,
}: {
  games: readonly GameSlotDef[];
  text: RuleCapText;
  onChange: (next: RuleCapText) => void;
}): React.JSX.Element {
  const has = (key: RuleCapKey): boolean => (text[key] ?? '') !== '';
  const structures = STRUCTURAL_KINDS.filter(
    (kind) => games.some((game) => structuralKindsOf(game).includes(kind)) || has(`structure:${kind}`),
  );
  const plays = RULE_PLAY_KINDS.filter(
    (kind) => games.some((game) => playKindsOf(game).includes(kind)) || has(`play:${kind}`),
  );
  const doubles = games.some(isDoublesPairGame) || has('pair');
  const set = (key: RuleCapKey, value: string): void => onChange({ ...text, [key]: value });
  const written = Object.values(text).filter((value) => (value ?? '').trim() !== '').length;

  return (
    <details className="disclosure league-rules" data-testid="league-rules-editor" open={written > 0 || undefined}>
      <summary>
        <Icon name="scale" />
        <span className="grow" style={{ minWidth: 0 }}>
          <span className="summary-title">リーグ規則 (必須条件)</span>
          <span className="summary-note">{written > 0 ? `${written} 件の上限を設定中` : '未設定 (任意)'}</span>
        </span>
        <Icon name="chevronDown" className="chev" />
      </summary>
      <div className="disclosure-body">
        <p className="tiny muted rule-intro">
          大会が定める上限を、生成・手動編集・確定で必ず守る条件として設定します。公平性などの方針 (評価の重み) とは別です。
          空欄は「上限なし」、0 は「0 回 (出場させない)」です。このフォーマットで作ったオーダーにだけ適用されます。
        </p>

        {structures.length > 0 ? (
          <fieldset className="rule-group">
            <legend>選手ごとの出場上限 ・ 人数区分</legend>
            {structures.map((kind) => (
              <RuleInput key={kind} row={{ key: `structure:${kind}`, label: ruleKindLabel(kind), unit: '回まで / 1人' }} text={text} onChange={set} />
            ))}
          </fieldset>
        ) : null}

        {plays.length > 0 ? (
          <fieldset className="rule-group">
            <legend>選手ごとの出場上限 ・ 競技区分</legend>
            {plays.map((kind) => (
              <RuleInput key={kind} row={{ key: `play:${kind}`, label: ruleKindLabel(kind), unit: '回まで / 1人' }} text={text} onChange={set} />
            ))}
          </fieldset>
        ) : null}
        <p className="tiny muted rule-note" data-testid="rule-counting-note">
          {COUNTING_NOTE}
        </p>

        {doubles ? (
          <fieldset className="rule-group">
            <legend>ダブルスの同一ペア</legend>
            <RuleInput row={{ key: 'pair', label: '同じ 2 人の組', unit: '回まで' }} text={text} onChange={set} />
            <p className="tiny muted rule-note">
              ダブルスのゲームだけを数えます。投順が逆 (A / B と B / A) でも同じペアです。トリオスやチーム戦で同席した 2 人は数えません。
              ペア設定の「禁止」とは別の条件です。
            </p>
          </fieldset>
        ) : null}

        <fieldset className="rule-group">
          <legend>助っ人の人数</legend>
          <RuleInput row={{ key: 'helpers', label: '助っ人', unit: '名まで' }} text={text} onChange={set} />
          <p className="tiny muted rule-note">
            オーダーに実際に配置した助っ人の人数です。同じ人を複数ゲームに出しても 1 名、参加者にいても出場しなければ 0 名です。
            正規登録か助っ人かは、オーダー設定で選手ごとに選びます (「今回だけの助っ人」として追加したかどうかとは別です)。
          </p>
        </fieldset>
      </div>
    </details>
  );
}

/** The written rules as a short list, labelled as hard conditions (SETUP, the format list). */
export function LeagueRulesSummary({ rules }: { rules: LeagueRules | null | undefined }): React.JSX.Element | null {
  if (!hasLeagueRules(rules)) return null;
  const issues = leagueRuleIssues(rules);
  return (
    <div className="rules-summary" data-testid="league-rules-summary">
      <Icon name="scale" size={18} />
      <span className="grow">
        <span className="basis-title">リーグ規則 (必須条件)</span>
        <span className="basis-note">{describeLeagueRules(rules).join(' ・ ')}</span>
        {issues.length > 0 ? (
          <span className="field-error" role="alert">
            {issues[0]} フォーマットで修正してください。
          </span>
        ) : null}
      </span>
    </div>
  );
}

interface CheckRow {
  label: string;
  detail: string;
  ok: boolean;
}

/**
 * The result screen's check of the order on screen against its rule snapshot: each rule, how
 * close the order comes to it, and whether it holds. A live view of the same validator that
 * gates finalization, so what is shown here is what finalization will say.
 */
export function LeagueRulesPanel({
  rules,
  games,
  assignments,
  participants,
  players,
}: {
  rules: LeagueRules | null | undefined;
  games: readonly GameSlotDef[];
  assignments: readonly GameAssignment[];
  participants: readonly ParticipantConfig[];
  players: readonly Player[];
}): React.JSX.Element | null {
  if (!hasLeagueRules(rules)) return null;
  const nameOf = (id: string): string => players.find((player) => player.id === id)?.name ?? id;
  const violations = leagueRuleViolations(rules, games, assignments, participants, nameOf);
  const rows: CheckRow[] = [];
  const invalid = leagueRuleIssues(rules).length > 0;

  if (!invalid) {
    const tally = tallyLeagueRules(rules, games, assignments, participants);
    for (const { limit, counts } of tally.limits) {
      const top = [...counts.entries()].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))[0];
      const most = top?.[1] ?? 0;
      const over = [...counts.entries()].filter(([, count]) => count > limit.cap).map(([id]) => nameOf(id));
      rows.push({
        label: `${limit.label}: 1人 ${limit.cap} 回まで`,
        detail: over.length > 0 ? `超過: ${over.join('、')}` : `最多 ${most} 回${top ? ` (${nameOf(top[0])})` : ''}`,
        ok: over.length === 0,
      });
    }
    if (rules.maxSameDoublesPair !== undefined) {
      const pairs = [...tally.pairs.values()].sort((a, b) => b.count - a.count || (a.key < b.key ? -1 : 1));
      const top = pairs[0];
      const over = pairs.filter((pair) => pair.count > rules.maxSameDoublesPair!);
      rows.push({
        label: `ダブルス同一ペア: ${rules.maxSameDoublesPair} 回まで`,
        detail:
          over.length > 0
            ? `超過: ${over.map((pair) => `${nameOf(pair.a)} / ${nameOf(pair.b)} ${pair.count} 回`).join('、')}`
            : top
              ? `最多 ${top.count} 回 (${nameOf(top.a)} / ${nameOf(top.b)})`
              : 'ダブルスの配置なし',
        ok: over.length === 0,
      });
    }
    if (rules.maxHelpers !== undefined) {
      const ok = tally.helpers.length <= rules.maxHelpers && tally.unstated.length === 0;
      rows.push({
        label: `助っ人: ${rules.maxHelpers} 名まで`,
        detail:
          tally.unstated.length > 0
            ? `資格未設定: ${tally.unstated.map(nameOf).join('、')}`
            : `配置 ${tally.helpers.length} 名${tally.helpers.length > 0 ? ` (${tally.helpers.map(nameOf).join('、')})` : ''}`,
        ok,
      });
    }
  }

  return (
    <section className="card rules-panel" aria-labelledby="rules-panel-title" data-testid="league-rules-panel">
      <div className="rules-panel-head">
        <span className="kicker">LEAGUE RULES</span>
        <h3 id="rules-panel-title">リーグ規則 (必須条件)</h3>
        {violations.length === 0 ? (
          <span className="badge ok" data-testid="rules-status">
            <Icon name="checkCircle" size={14} />
            すべて満たしています
          </span>
        ) : (
          <span className="badge danger" data-testid="rules-status">
            <Icon name="alert" size={14} />
            違反 {violations.length} 件
          </span>
        )}
      </div>
      {invalid ? (
        <p className="field-error" role="alert">
          {violations[0]?.message}
        </p>
      ) : (
        <ul className="rules-check">
          {rows.map((row) => (
            <li key={row.label} className={row.ok ? 'is-ok' : 'is-over'}>
              <Icon name={row.ok ? 'check' : 'alert'} size={16} strokeWidth={row.ok ? 2.8 : 2} />
              <span className="grow">
                <span className="rule-name">{row.label}</span>
                <span className="rule-detail">{row.detail}</span>
              </span>
              <span className={row.ok ? 'rule-verdict ok' : 'rule-verdict over'}>{row.ok ? 'OK' : '違反'}</span>
            </li>
          ))}
        </ul>
      )}
      <p className="tiny muted" style={{ marginBottom: 0 }}>
        生成時に保存した規則で確認しています (フォーマットを後で変えても、このオーダーには反映しません)。
        {rules.maxHelpers !== undefined ? ' 大会資格はオーダー設定で入力した内容による確認で、大会側の登録確認ではありません。' : ''}
      </p>
    </section>
  );
}

