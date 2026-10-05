import { useMemo, useState } from 'react';
import type { PairAffinity, PairSetting, PlayerId } from '../domain/types';
import { PAIR_AFFINITIES, PAIR_AFFINITY_LABELS } from '../domain/types';
import { canonicalPair, pairKey } from '../domain/games/pairKey';
import { createId } from '../utils/id';
import { useAppStore } from '../state/appStore';
import { Card, EmptyState, Field, Stepper, useToast } from '../components/ui';

const AFFINITY_TONE: Record<PairAffinity, string> = {
  VERY_GOOD: 'ok',
  GOOD: 'ok',
  NEUTRAL: '',
  DISCOURAGED: 'warn',
  FORBIDDEN: 'danger',
};

/**
 * PAIRS screen (spec §12).
 *
 * "禁止" is a hard constraint; the other four levels are soft score contributions.
 * The past-together counter feeds the "new pair" preset.
 */
export function PairsPage(): React.JSX.Element {
  const store = useAppStore();
  const toast = useToast();
  const [left, setLeft] = useState<PlayerId | ''>('');
  const [right, setRight] = useState<PlayerId | ''>('');
  const [onlySet, setOnlySet] = useState(true);

  const players = store.teamPlayers;
  const nameById = useMemo(() => new Map(players.map((player) => [player.id, player.name])), [players]);
  const byKey = useMemo(
    () => new Map(store.teamPairs.map((pair) => [pairKey(pair.a, pair.b), pair])),
    [store.teamPairs],
  );

  const allCombinations = useMemo(() => {
    const result: { a: PlayerId; b: PlayerId }[] = [];
    for (let i = 0; i < players.length; i += 1) {
      for (let j = i + 1; j < players.length; j += 1) {
        result.push({ a: players[i].id, b: players[j].id });
      }
    }
    return result;
  }, [players]);

  const visible = useMemo(() => {
    const base = onlySet
      ? allCombinations.filter((combination) => byKey.has(pairKey(combination.a, combination.b)))
      : allCombinations;
    if (left && right) {
      return base.filter(
        (combination) =>
          (combination.a === left && combination.b === right) ||
          (combination.a === right && combination.b === left),
      );
    }
    if (left) return base.filter((combination) => combination.a === left || combination.b === left);
    return base;
  }, [allCombinations, byKey, onlySet, left, right]);

  const update = (a: PlayerId, b: PlayerId, change: Partial<PairSetting>): void => {
    if (!store.activeTeamId) return;
    const key = pairKey(a, b);
    const existing = byKey.get(key);
    const base: PairSetting =
      existing ??
      {
        id: createId('pr'),
        ...canonicalPair(store.activeTeamId, a, b),
        affinity: 'NEUTRAL',
        pastTogetherCount: 0,
      };
    const next: PairSetting = { ...base, ...change };
    // A neutral pair with no history carries no information, so drop the row entirely
    // instead of accumulating empty records.
    if (next.affinity === 'NEUTRAL' && next.pastTogetherCount === 0) {
      if (existing) store.deletePair(existing.id);
      return;
    }
    store.savePair(next);
  };

  if (players.length < 2) {
    return (
      <Card>
        <EmptyState>ペア相性を設定するには 2 名以上のメンバー登録が必要です。</EmptyState>
      </Card>
    );
  }

  return (
    <>
      <Card title="絞り込み">
        <div className="row" style={{ gap: 8 }}>
          <Field label="選手 A">
            <select value={left} onChange={(event) => setLeft(event.target.value)}>
              <option value="">すべて</option>
              {players.map((player) => (
                <option key={player.id} value={player.id}>
                  {player.name}
                </option>
              ))}
            </select>
          </Field>
          <Field label="選手 B">
            <select value={right} onChange={(event) => setRight(event.target.value)} disabled={!left}>
              <option value="">すべて</option>
              {players
                .filter((player) => player.id !== left)
                .map((player) => (
                  <option key={player.id} value={player.id}>
                    {player.name}
                  </option>
                ))}
            </select>
          </Field>
        </div>
        <label className="row" style={{ gap: 10, minHeight: 44 }}>
          <input
            type="checkbox"
            checked={onlySet}
            onChange={(event) => setOnlySet(event.target.checked)}
            style={{ width: 22, height: 22, minHeight: 22 }}
          />
          <span className="small-text">設定済みのペアだけ表示 ({store.teamPairs.length} 件)</span>
        </label>
      </Card>

      {visible.length === 0 ? (
        <Card>
          <EmptyState>
            表示するペアがありません。
            <br />
            「設定済みのペアだけ表示」を外すと全組み合わせが出ます。
          </EmptyState>
        </Card>
      ) : null}

      {visible.map((combination) => {
        const key = pairKey(combination.a, combination.b);
        const pair = byKey.get(key);
        const affinity = pair?.affinity ?? 'NEUTRAL';
        return (
          <Card key={key}>
            <div className="row between" style={{ marginBottom: 8 }}>
              <strong style={{ fontSize: 15 }}>
                {nameById.get(combination.a)} / {nameById.get(combination.b)}
              </strong>
              <span className={`badge ${AFFINITY_TONE[affinity]}`}>{PAIR_AFFINITY_LABELS[affinity]}</span>
            </div>
            <div className="row wrap" style={{ gap: 6, marginBottom: 10 }}>
              {PAIR_AFFINITIES.map((candidate) => (
                <button
                  type="button"
                  key={candidate}
                  className={`chip${affinity === candidate ? (candidate === 'FORBIDDEN' ? ' danger-on' : ' on') : ''}`}
                  aria-pressed={affinity === candidate}
                  onClick={() => {
                    update(combination.a, combination.b, { affinity: candidate });
                    if (candidate === 'FORBIDDEN') {
                      toast.show('禁止ペアは Hard 制約です。同じゲームには絶対に配置されません。', 'ok');
                    }
                  }}
                >
                  {PAIR_AFFINITY_LABELS[candidate]}
                </button>
              ))}
            </div>
            <div className="row between">
              <span className="tiny dim">過去に組んだ回数 (新ペア試行プリセットで使用)</span>
              <Stepper
                label="過去に組んだ回数"
                value={pair?.pastTogetherCount ?? 0}
                min={0}
                max={200}
                onChange={(next) => update(combination.a, combination.b, { pastTogetherCount: next })}
              />
            </div>
          </Card>
        );
      })}

      <p className="tiny dim" style={{ padding: '0 4px 8px' }}>
        「禁止」のみ Hard 制約 (絶対に同じゲームへ配置しません)。他の 4 段階はスコアへの加点・減点です。
      </p>
    </>
  );
}
