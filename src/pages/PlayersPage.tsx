import { useMemo, useState } from 'react';
import type { Player } from '../domain/types';
import { createId } from '../utils/id';
import { useAppStore } from '../state/appStore';
import {
  Card,
  ConfirmDialog,
  EmptyState,
  Field,
  formatStrengthLine,
  useToast,
} from '../components/ui';
import { EFFECTIVE_PPR_ORIGIN_LABELS, effectivePpr, withEffectivePpr } from '../domain/n01/effectivePpr';
import { Icon } from '../components/icons';
import { PlayerEditor } from '../components/PlayerEditor';

/**
 * PLAYERS screen (spec §3, §26).
 *
 * Rating and PPR are optional everywhere: an empty box stores `null`, which the
 * optimizer treats as Unknown — never as 0.
 */
export function PlayersPage(): React.JSX.Element {
  const store = useAppStore();
  const toast = useToast();
  const [editing, setEditing] = useState<Player | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<Player | null>(null);
  const [query, setQuery] = useState('');

  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return store.teamPlayers;
    return store.teamPlayers.filter((player) => player.name.toLowerCase().includes(needle));
  }, [store.teamPlayers, query]);

  const startNew = (): void => {
    if (!store.activeTeamId) {
      toast.show('先にチームを作成してください', 'error');
      return;
    }
    setEditing({
      id: createId('pl'),
      teamId: store.activeTeamId,
      name: '',
      rating: null,
      ppr: null,
      skills: {},
      seasonAppearances: 0,
      seasonAppearancesByKind: {},
      archived: false,
      createdAt: Date.now(),
    });
  };

  return (
    <>
      <Card>
        <Field label="検索">
          <input
            type="search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="名前で絞り込み"
          />
        </Field>
        <p className="tiny muted" style={{ margin: 0 }}>
          {store.teamPlayers.length} 名登録 ・ Rating 未入力{' '}
          {store.teamPlayers.filter((player) => player.rating === null).length} 名 ・ PPR 未入力{' '}
          {store.teamPlayers.filter((player) => effectivePpr(player).value === null).length} 名
        </p>
      </Card>

      <Card flush>
        {filtered.length === 0 ? (
          <EmptyState kicker="NO PLAYERS" title="メンバーがまだいません" icon="users">
            下の「メンバーを追加」から登録してください。
          </EmptyState>
        ) : (
          <ul className="list">
            {filtered.map((player) => (
              <li key={player.id}>
                <button type="button" className="list-row" onClick={() => setEditing(player)}>
                  <span className="lead" aria-hidden="true">
                    {Array.from(player.name || '?')[0]}
                  </span>
                  <span className="grow">
                    <span className="title">
                      {player.name || '(名称未設定)'}
                      {player.n01 && !player.n01.rosterActive ? <span className="n01-tag muted-tag">登録外</span> : null}
                    </span>
                    <span
                      className={
                        player.rating === null && effectivePpr(player).value === null
                          ? 'strength-line unknown'
                          : 'strength-line'
                      }
                    >
                      {formatStrengthLine(withEffectivePpr(player))}
                      {player.n01 ? (
                        <span className="ppr-origin"> ・ PPR {EFFECTIVE_PPR_ORIGIN_LABELS[effectivePpr(player).origin]}</span>
                      ) : null}
                    </span>
                    <span className="meta">
                      シーズン {player.seasonAppearances} 回
                      {Object.keys(player.skills).length > 0 ? ' ・ 適性設定あり' : ''}
                      {player.archived ? ' ・ 休止中' : ''}
                    </span>
                  </span>
                  <Icon name="chevronRight" size={18} className="chevron" />
                </button>
              </li>
            ))}
          </ul>
        )}
      </Card>

      <div className="action-bar">
        <button type="button" className="btn primary" onClick={startNew}>
          <Icon name="plus" size={20} strokeWidth={2.6} />
          メンバーを追加
        </button>
      </div>

      {editing ? (
        <PlayerEditor
          player={editing}
          onClose={() => setEditing(null)}
          onSave={(player) => {
            if (!player.name.trim()) {
              toast.show('名前を入力してください', 'error');
              return;
            }
            store.savePlayer(player);
            setEditing(null);
            toast.show(`${player.name} を保存しました`, 'ok');
          }}
          onDelete={() => {
            setConfirmDelete(editing);
            setEditing(null);
          }}
          isNew={!store.teamPlayers.some((candidate) => candidate.id === editing.id)}
        />
      ) : null}

      {confirmDelete ? (
        <ConfirmDialog
          title="メンバーを削除"
          message={`${confirmDelete.name} を削除します。このメンバーのペア相性設定も削除されます。過去のオーダー履歴は残ります。`}
          confirmLabel="削除する"
          destructive
          onCancel={() => setConfirmDelete(null)}
          onConfirm={() => {
            store.deletePlayer(confirmDelete.id);
            toast.show(`${confirmDelete.name} を削除しました`, 'ok');
            setConfirmDelete(null);
          }}
        />
      ) : null}
    </>
  );
}
