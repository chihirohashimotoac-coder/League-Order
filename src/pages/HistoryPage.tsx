import { useState } from 'react';
import type {
  GameAssignment,
  GameSlotDef,
  OrderVersion,
  SavedOrder,
  SeasonCommitStatus,
} from '../domain/types';
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
import { SEASON_COMMITTED_DELETE_MESSAGE, useAppStore } from '../state/appStore';
import { VersionDiff } from '../components/VersionDiff';
import { Card, ConfirmDialog, EmptyState, Sheet, StatusBadge, useToast } from '../components/ui';
import { Icon } from '../components/icons';

/**
 * HISTORY screen (spec §26, 追加要件 §15).
 *
 * Shows each saved order's latest version, when it was finalized and whether the season
 * totals reflect it — and lets any past version be opened exactly as it was shared.
 */
export function HistoryPage({
  onOpen,
  onNewOrder,
}: {
  onOpen: (order: SavedOrder) => void;
  onNewOrder: () => void;
}): React.JSX.Element {
  const store = useAppStore();
  const toast = useToast();
  const [preview, setPreview] = useState<SavedOrder | null>(null);
  const [versionView, setVersionView] = useState<{ order: SavedOrder; version: OrderVersion } | null>(
    null,
  );
  const [confirmDelete, setConfirmDelete] = useState<SavedOrder | null>(null);
  const [confirmWithdraw, setConfirmWithdraw] = useState<SavedOrder | null>(null);

  if (store.teamOrders.length === 0) {
    return (
      <Card>
        <EmptyState
          kicker="NO ORDERS"
          title="保存されたオーダーがありません。"
          icon="history"
          action={
            <button type="button" className="btn primary" onClick={onNewOrder}>
              オーダーを作る
            </button>
          }
        >
          オーダーを確定するか「下書きを保存」すると、ここに記録されます。
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
                <button type="button" className="list-row history-row" onClick={() => setPreview(order)}>
                  <span className="grow">
                    <span className="title">{order.title}</span>
                    <span className="meta">
                      {latest
                        ? `確定 ${new Date(latest.finalizedAt).toLocaleString('ja-JP')}`
                        : `保存 ${new Date(order.updatedAt).toLocaleString('ja-JP')}`}
                      {order.match?.opponentName ? ` ・ vs ${order.match.opponentName}` : ''}
                    </span>
                    <span className="badges">
                      {latest ? (
                        <StatusBadge tone="finalized" icon="checkCircle">
                          v{latest.version} 確定
                        </StatusBadge>
                      ) : (
                        <StatusBadge tone="draft" icon="edit">
                          未確定
                        </StatusBadge>
                      )}
                      <SeasonStatusBadge status={season} />
                    </span>
                  </span>
                  <Icon name="chevronRight" size={18} className="chevron" />
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
            seasonStatus={statusOf(preview)}
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

      {/*
        Deleting an order that is still counted in the season totals is refused, not
        warned about: the appearances would otherwise stay in the standings with the
        ledger entry that recorded them gone, which is unrecoverable. Withdrawing is
        offered here as its own step with its own confirmation, so the data only ever
        changes when the captain asks for it (追加要件 §10, §11).
      */}
      {confirmDelete ? (
        store.seasonCommitFor(confirmDelete.id) ? (
          <Sheet
            title="削除できません"
            onClose={() => setConfirmDelete(null)}
            footer={
              <>
                {/* Not "閉じる": the sheet's own ✕ already carries that name, and two
                    buttons with the same accessible name in one dialog is ambiguous to
                    a screen reader. */}
                <button type="button" className="btn grow" onClick={() => setConfirmDelete(null)}>
                  キャンセル
                </button>
                <button
                  type="button"
                  className="btn danger grow"
                  onClick={() => {
                    setConfirmWithdraw(confirmDelete);
                    setConfirmDelete(null);
                  }}
                >
                  シーズン反映を取り消す
                </button>
              </>
            }
          >
            <p className="small-text" style={{ marginTop: 0 }} data-testid="delete-blocked">
              {SEASON_COMMITTED_DELETE_MESSAGE}
            </p>
            <p className="tiny dim" style={{ marginBottom: 0 }}>
              取り消すと、このオーダーがシーズン累計へ加えた分だけが差し戻されます。内容を確認したうえで、改めて削除してください。
            </p>
          </Sheet>
        ) : (
          <ConfirmDialog
            title="オーダーを削除"
            message={`${confirmDelete.title} を履歴から削除します。この操作は取り消せません。`}
            confirmLabel="削除する"
            destructive
            onCancel={() => setConfirmDelete(null)}
            onConfirm={() => {
              const result = store.deleteOrder(confirmDelete.id);
              toast.show(result.message, result.ok ? 'ok' : 'error');
              setConfirmDelete(null);
              if (result.ok) setPreview(null);
            }}
          />
        )
      ) : null}

      {confirmWithdraw ? (
        <ConfirmDialog
          title="シーズン反映を取り消す"
          message={`${confirmWithdraw.title} がシーズン累計へ加えた分をすべて差し戻します。反映前の数値に戻ります。オーダー自体はまだ削除されません。`}
          confirmLabel="取り消す"
          destructive
          onCancel={() => setConfirmWithdraw(null)}
          onConfirm={() => {
            const result = store.withdrawSeason(confirmWithdraw.id);
            toast.show(result.message, result.ok ? 'ok' : 'error');
            setConfirmWithdraw(null);
          }}
        />
      ) : null}
    </>
  );
}

function HistoryDetail({
  order,
  seasonStatus,
  seasonLabel,
  onOpenVersion,
}: {
  order: SavedOrder;
  seasonStatus: SeasonCommitStatus;
  seasonLabel: string;
  onOpenVersion: (version: OrderVersion) => void;
}): React.JSX.Element {
  const nameById = new Map(order.input.players.map((player) => [player.id, player.name]));
  const games = sortedGames(order.input.games);
  const latest = latestVersion(order.versions);

  return (
    <>
      <div className="row wrap" style={{ gap: 6, marginBottom: 12 }}>
        {latest ? (
          <StatusBadge tone="finalized" icon="checkCircle">
            最新 v{latest.version}
          </StatusBadge>
        ) : (
          <StatusBadge tone="draft" icon="edit">
            未確定
          </StatusBadge>
        )}
        <SeasonStatusBadge status={seasonStatus} label={seasonLabel} />
        <span className="badge">{order.versions.length} 版</span>
      </div>

      <MiniOrder games={games} assignments={order.solution.assignments} nameById={nameById} />

      {order.versions.length > 0 ? (
        <>
          <h3 className="sub-head">確定履歴</h3>
          <ul className="version-list">
            {[...order.versions].reverse().map((version) => (
              <li key={version.version}>
                <button type="button" onClick={() => onOpenVersion(version)}>
                  <span className="badge">v{version.version}</span>
                  <span className="grow">
                    <span className="title">{new Date(version.finalizedAt).toLocaleString('ja-JP')}</span>
                    <span className="meta">
                      {version.label} ・ {version.games.length} ゲーム
                    </span>
                  </span>
                  <Icon name="chevronRight" size={18} className="dim" />
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
      <p className="tiny muted" style={{ marginTop: 0 }}>
        {new Date(version.finalizedAt).toLocaleString('ja-JP')} に確定 ・ {version.label}
        <br />
        確定時点の内容です。その後のメンバー名やフォーマットの変更は反映されません。
      </p>

      <MiniOrder games={sortedGames(version.games)} assignments={version.assignments} nameById={nameById} />

      {diff ? (
        <>
          <h3 className="sub-head">v{version.version - 1} からの変更</h3>
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

/** Read-only line-up, one row per game. */
function MiniOrder({
  games,
  assignments,
  nameById,
}: {
  games: readonly GameSlotDef[];
  assignments: readonly GameAssignment[];
  nameById: Map<string, string>;
}): React.JSX.Element {
  return (
    <ol className="mini-order">
      {games.map((game) => {
        const assignment = assignments.find((entry) => entry.gameId === game.id);
        return (
          <li key={game.id}>
            <span className="no">{String(game.order).padStart(2, '0')}</span>
            <span className="body">
              <span className="g">{game.name}</span>
              <span className="p">
                {assignment?.playerIds.map((id) => nameById.get(id) ?? id).join(' / ') ?? '-'}
              </span>
            </span>
          </li>
        );
      })}
    </ol>
  );
}

function SeasonStatusBadge({
  status,
  label = SEASON_STATUS_LABELS[status],
}: {
  status: SeasonCommitStatus;
  label?: string;
}): React.JSX.Element {
  if (status === 'current') {
    return (
      <StatusBadge tone="season" icon="season">
        {label}
      </StatusBadge>
    );
  }
  if (status === 'outdated') {
    return (
      <StatusBadge tone="updated" icon="alert">
        {label}
      </StatusBadge>
    );
  }
  return (
    <StatusBadge tone="neutral" icon="season">
      {label}
    </StatusBadge>
  );
}
