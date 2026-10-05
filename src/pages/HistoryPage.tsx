import { useState } from 'react';
import type { OrderVersion, SavedOrder } from '../domain/types';
import { createMatchInfo } from '../domain/types';
import { sortedGames } from '../domain/games/format';
import { diffVersions, latestVersion } from '../domain/orders/lifecycle';
import { SEASON_STATUS_LABELS, seasonCommitStatus } from '../domain/orders/seasonLedger';
import {
  copyText,
  renderDetailText,
  shareableFromVersion,
  versionInfoOf,
} from '../share';
import { useAppStore } from '../state/appStore';
import { VersionDiff } from '../components/VersionDiff';
import { Card, ConfirmDialog, EmptyState, Sheet, useToast } from '../components/ui';

/**
 * HISTORY screen (spec §26, 追加要件 §15).
 *
 * Shows each saved order's latest version, when it was finalized and whether the season
 * totals reflect it — and lets any past version be opened exactly as it was shared.
 */
export function HistoryPage({ onOpen }: { onOpen: (order: SavedOrder) => void }): React.JSX.Element {
  const store = useAppStore();
  const toast = useToast();
  const [preview, setPreview] = useState<SavedOrder | null>(null);
  const [versionView, setVersionView] = useState<{ order: SavedOrder; version: OrderVersion } | null>(
    null,
  );
  const [confirmDelete, setConfirmDelete] = useState<SavedOrder | null>(null);

  if (store.teamOrders.length === 0) {
    return (
      <Card>
        <EmptyState>
          保存されたオーダーがありません。
          <br />
          オーダー結果画面の「オーダーを確定」または「下書きを保存」で記録できます。
        </EmptyState>
      </Card>
    );
  }

  const statusOf = (order: SavedOrder) =>
    seasonCommitStatus(
      store.seasonCommitFor(order.id),
      latestVersion(order.versions)?.version ?? null,
    );

  return (
    <>
      <Card flush>
        <ul className="list">
          {store.teamOrders.map((order) => {
            const latest = latestVersion(order.versions);
            const season = statusOf(order);
            return (
              <li key={order.id}>
                <button type="button" className="list-row" onClick={() => setPreview(order)}>
                  <span className="grow">
                    <span className="title">
                      {order.title}
                      {latest ? (
                        <span className="badge accent" style={{ marginLeft: 6 }}>
                          v{latest.version}
                        </span>
                      ) : (
                        <span className="badge warn" style={{ marginLeft: 6 }}>
                          未確定
                        </span>
                      )}
                    </span>
                    <span className="meta">
                      {latest
                        ? `確定 ${new Date(latest.finalizedAt).toLocaleString('ja-JP')}`
                        : `保存 ${new Date(order.updatedAt).toLocaleString('ja-JP')}`}
                      {' ・ '}
                      {SEASON_STATUS_LABELS[season]}
                    </span>
                  </span>
                  <span className="chevron" aria-hidden="true">
                    ›
                  </span>
                </button>
              </li>
            );
          })}
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
          <HistoryDetail
            order={preview}
            seasonLabel={SEASON_STATUS_LABELS[statusOf(preview)]}
            onOpenVersion={(version) => setVersionView({ order: preview, version })}
          />
          <button
            type="button"
            className="btn small"
            style={{ marginTop: 10 }}
            onClick={async () => {
              const text = renderDetailText(
                preview.input.games,
                preview.input.players,
                preview.solution,
                preview.match ?? createMatchInfo(preview.title),
              );
              const ok = await copyText(text);
              toast.show(ok ? 'コピーしました' : 'コピーできませんでした', ok ? 'ok' : 'error');
            }}
          >
            現在の内容をテキストでコピー
          </button>
        </Sheet>
      ) : null}

      {versionView ? (
        <VersionDetail
          order={versionView.order}
          version={versionView.version}
          onClose={() => setVersionView(null)}
        />
      ) : null}

      {confirmDelete ? (
        <ConfirmDialog
          title="オーダーを削除"
          message={`${confirmDelete.title} を履歴から削除します。${
            store.seasonCommitFor(confirmDelete.id)
              ? ' このオーダーはシーズン累計へ反映済みです。先に「反映を取り消す」を実行しないと、累計に反映分が残ります。'
              : ''
          }`}
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

function HistoryDetail({
  order,
  seasonLabel,
  onOpenVersion,
}: {
  order: SavedOrder;
  seasonLabel: string;
  onOpenVersion: (version: OrderVersion) => void;
}): React.JSX.Element {
  const nameById = new Map(order.input.players.map((player) => [player.id, player.name]));
  const games = sortedGames(order.input.games);
  const latest = latestVersion(order.versions);

  return (
    <>
      <div className="row wrap" style={{ gap: 6, marginBottom: 10 }}>
        <span className={latest ? 'badge accent' : 'badge warn'}>
          {latest ? `最新 v${latest.version}` : '未確定'}
        </span>
        <span className="badge">{seasonLabel}</span>
        <span className="badge">{order.versions.length} 版</span>
      </div>

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

      {order.versions.length > 0 ? (
        <>
          <h3 className="card-title" style={{ marginTop: 16 }}>
            確定履歴
          </h3>
          <ul className="version-list">
            {[...order.versions].reverse().map((version) => (
              <li key={version.version}>
                <button type="button" onClick={() => onOpenVersion(version)}>
                  <span className="badge accent">v{version.version}</span>
                  <span className="grow">
                    <span className="title" style={{ display: 'block', fontSize: 14 }}>
                      {new Date(version.finalizedAt).toLocaleString('ja-JP')}
                    </span>
                    <span className="meta">
                      {version.label} ・ {version.games.length} ゲーム
                    </span>
                  </span>
                  <span className="chevron" aria-hidden="true">
                    ›
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </>
      ) : null}
    </>
  );
}

/** A past version, rendered from its own frozen snapshot (追加要件 §5, §15). */
function VersionDetail({
  order,
  version,
  onClose,
}: {
  order: SavedOrder;
  version: OrderVersion;
  onClose: () => void;
}): React.JSX.Element {
  const toast = useToast();
  const previous = order.versions.find((entry) => entry.version === version.version - 1) ?? null;
  const diff = previous ? diffVersions(previous, version) : null;
  const nameById = new Map(version.players.map((player) => [player.id, player.name]));

  return (
    <Sheet title={`v${version.version} の内容`} onClose={onClose}>
      <p className="tiny dim" style={{ marginTop: 0 }}>
        {new Date(version.finalizedAt).toLocaleString('ja-JP')} に確定 ・ {version.label}
        <br />
        確定時点の内容です。その後のメンバー名やフォーマットの変更は反映されません。
      </p>

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
            {sortedGames(version.games).map((game) => {
              const assignment = version.assignments.find((entry) => entry.gameId === game.id);
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

      {diff ? (
        <>
          <h3 className="card-title" style={{ marginTop: 16 }}>
            v{version.version - 1} からの変更
          </h3>
          <VersionDiff
            diff={diff}
            beforeLabel={`v${version.version - 1}`}
            afterLabel={`v${version.version}`}
          />
        </>
      ) : null}

      <button
        type="button"
        className="btn small"
        style={{ marginTop: 12 }}
        onClick={async () => {
          const text = renderDetailText(
            version.games,
            version.players,
            shareableFromVersion(version),
            version.match,
            versionInfoOf(version),
          );
          const ok = await copyText(text);
          toast.show(ok ? `v${version.version} をコピーしました` : 'コピーできませんでした', ok ? 'ok' : 'error');
        }}
      >
        この版をテキストでコピー
      </button>
    </Sheet>
  );
}
