import { useState } from 'react';
import type { SavedOrder } from '../domain/types';
import { sortedGames } from '../domain/games/format';
import { renderOrderText } from '../domain/orders/renderText';
import { copyText } from '../utils/shareImage';
import { useAppStore } from '../state/appStore';
import { Card, ConfirmDialog, EmptyState, Sheet, useToast } from '../components/ui';

/** HISTORY screen (spec §26): review, reopen or delete a saved order. */
export function HistoryPage({ onOpen }: { onOpen: (order: SavedOrder) => void }): React.JSX.Element {
  const store = useAppStore();
  const toast = useToast();
  const [preview, setPreview] = useState<SavedOrder | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<SavedOrder | null>(null);

  if (store.teamOrders.length === 0) {
    return (
      <Card>
        <EmptyState>
          保存されたオーダーがありません。
          <br />
          オーダー結果画面の「履歴に保存」で記録できます。
        </EmptyState>
      </Card>
    );
  }

  return (
    <>
      <Card flush>
        <ul className="list">
          {store.teamOrders.map((order) => (
            <li key={order.id}>
              <button type="button" className="list-row" onClick={() => setPreview(order)}>
                <span className="grow">
                  <span className="title">{order.title}</span>
                  <span className="meta">
                    {new Date(order.createdAt).toLocaleString('ja-JP')} ・ 総合{' '}
                    {order.solution.score.display} ・ 最大差 {order.solution.metrics.appearanceSpread}
                  </span>
                </span>
                <span className="chevron" aria-hidden="true">
                  ›
                </span>
              </button>
            </li>
          ))}
        </ul>
      </Card>

      {preview ? (
        <Sheet
          title={preview.title}
          onClose={() => setPreview(null)}
          footer={
            <>
              <button type="button" className="btn danger" onClick={() => setConfirmDelete(preview)}>
                削除
              </button>
              <button
                type="button"
                className="btn primary grow"
                onClick={() => {
                  onOpen(preview);
                  setPreview(null);
                }}
              >
                このオーダーを開いて編集
              </button>
            </>
          }
        >
          <HistoryDetail order={preview} />
          <button
            type="button"
            className="btn small"
            style={{ marginTop: 10 }}
            onClick={async () => {
              const text = renderOrderText(preview.input.games, preview.input.players, preview.solution, {
                title: preview.title,
              });
              const ok = await copyText(text);
              toast.show(ok ? 'コピーしました' : 'コピーできませんでした', ok ? 'ok' : 'error');
            }}
          >
            テキストをコピー
          </button>
        </Sheet>
      ) : null}

      {confirmDelete ? (
        <ConfirmDialog
          title="オーダーを削除"
          message={`${confirmDelete.title} を履歴から削除します。`}
          confirmLabel="削除する"
          destructive
          onCancel={() => setConfirmDelete(null)}
          onConfirm={() => {
            store.deleteOrder(confirmDelete.id);
            toast.show('削除しました', 'ok');
            setConfirmDelete(null);
            setPreview(null);
          }}
        />
      ) : null}
    </>
  );
}

function HistoryDetail({ order }: { order: SavedOrder }): React.JSX.Element {
  const nameById = new Map(order.input.players.map((player) => [player.id, player.name]));
  const games = sortedGames(order.input.games);

  return (
    <>
      <div className="table-scroll">
        <table className="data">
          <thead>
            <tr>
              <th>#</th>
              <th>Format</th>
              <th>Player</th>
            </tr>
          </thead>
          <tbody>
            {games.map((game) => {
              const assignment = order.solution.assignments.find((entry) => entry.gameId === game.id);
              return (
                <tr key={game.id}>
                  <td className="num">{game.order}</td>
                  <td>{game.name}</td>
                  <td>
                    {assignment?.playerIds.map((id) => nameById.get(id) ?? id).join(' / ') ?? '-'}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <div className="metrics" style={{ marginTop: 12 }}>
        <div className="metric">
          <span className="k">総合</span>
          <span className="v">{order.solution.score.display}</span>
        </div>
        <div className="metric">
          <span className="k">最大差</span>
          <span className="v">{order.solution.metrics.appearanceSpread}</span>
        </div>
        <div className="metric">
          <span className="k">平均R</span>
          <span className="v">{order.solution.metrics.averageRating ?? '-'}</span>
        </div>
      </div>
    </>
  );
}
