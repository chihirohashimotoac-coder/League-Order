import { useEffect, useMemo, useState } from 'react';
import type {
  GameSlotDef,
  MatchInfo,
  OrderLifecycleState,
  OrderSolution,
  OrderVersion,
  Player,
} from '../domain/types';
import { diffVersionWithCurrent, latestVersion } from '../domain/orders/lifecycle';
import {
  buildPlayerSchedules,
  buildShareLayout,
  canShareFiles,
  canUseWebShare,
  copyText,
  downloadText,
  renderAllPlayersText,
  renderPlayerText,
  renderShareImages,
  renderShareText,
  saveImages,
  shareImages,
  shareText,
  type RenderedShareImage,
  type ShareImageVariant,
  type ShareTextFormat,
  type ShareVersionInfo,
} from '../share';
import { MatchInfoFields } from './MatchInfoFields';
import { Sheet, useToast } from './ui';

/**
 * SHARE screen (要件 §1–§7).
 *
 * Three tabs — image, text and per-player — over one shared layout model, so every form
 * says the same thing. The three primary actions (standard share / save image / copy
 * text) sit in a fixed row at the bottom of the sheet, within thumb reach.
 *
 * It reads a finished `OrderSolution` and never calls the optimizer.
 */
type ShareTab = 'image' | 'text' | 'player';

const IMAGE_VARIANTS: { key: ShareImageVariant; label: string; hint: string }[] = [
  { key: 'compact', label: 'コンパクト', hint: 'チームLINE向け。オーダーだけを大きな文字で。' },
  { key: 'detail', label: '詳細', hint: '保存・キャプテン確認用。出場回数と Rating を併記。' },
];

const BASE_TEXT_FORMATS: { key: ShareTextFormat; label: string; hint: string }[] = [
  { key: 'line', label: 'LINE', hint: 'LINE のトークへそのまま貼れる形式。' },
  { key: 'simple', label: 'シンプル', hint: '装飾なし。1 ゲーム 1 行。' },
  { key: 'detail', label: '詳細', hint: '出場回数と Rating を含むキャプテン控え。' },
];

/** Only offered once a re-finalization exists to describe (追加要件 §10). */
const UPDATE_TEXT_FORMATS: { key: ShareTextFormat; label: string; hint: string }[] = [
  { key: 'updateDiff', label: '変更点のみ', hint: '前の版からの変更だけを伝えます。' },
  {
    key: 'updateFull',
    label: '変更点＋全文',
    hint: '変更点に続けて最新オーダーの全文も載せます。',
  },
];

export function ShareSheet({
  games,
  players,
  solution,
  match,
  onMatchChange,
  lifecycle,
  versions,
  onClose,
}: {
  games: GameSlotDef[];
  players: Player[];
  solution: OrderSolution;
  match: MatchInfo;
  onMatchChange: (next: MatchInfo) => void;
  /** Lifecycle of the order being shared; drives the version badge and draft warning. */
  lifecycle: OrderLifecycleState;
  versions: OrderVersion[];
  onClose: () => void;
}): React.JSX.Element {
  const toast = useToast();
  const [tab, setTab] = useState<ShareTab>('image');
  const [variant, setVariant] = useState<ShareImageVariant>('compact');
  const [textFormat, setTextFormat] = useState<ShareTextFormat>('line');
  const [editMatch, setEditMatch] = useState(false);
  const [selectedPlayer, setSelectedPlayer] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // Capability detection happens once: on a desktop browser without the Web Share API
  // the standard-share button is hidden entirely rather than failing on tap (要件 §1).
  const [capabilities] = useState(() => ({
    webShare: canUseWebShare(),
    files: canShareFiles(),
  }));

  const latest = useMemo(() => latestVersion(versions), [versions]);

  /**
   * What the shared copy is labelled as.
   *
   * While the order is UPDATED the badge stays on the version the team actually has
   * (v1), because sharing now would hand them content that no longer matches any
   * confirmed version — the warning below says exactly that.
   */
  const versionInfo = useMemo<ShareVersionInfo>(
    () => ({
      version: latest?.version ?? 0,
      isUpdate: (latest?.version ?? 0) > 1,
      draft: lifecycle !== 'FINALIZED',
    }),
    [latest, lifecycle],
  );

  const previous = versions.length >= 2 ? versions[versions.length - 2] : null;
  const updateDiff = useMemo(() => {
    if (!previous || !latest) return null;
    return diffVersionWithCurrent(previous, {
      games: latest.games,
      assignments: latest.assignments,
      players: latest.players,
    });
  }, [previous, latest]);

  const textFormats = useMemo(
    () => (updateDiff ? [...BASE_TEXT_FORMATS, ...UPDATE_TEXT_FORMATS] : BASE_TEXT_FORMATS),
    [updateDiff],
  );

  const layout = useMemo(
    () => buildShareLayout(games, players, solution, match, variant, versionInfo),
    [games, players, solution, match, variant, versionInfo],
  );

  const images: RenderedShareImage[] = useMemo(() => {
    try {
      return renderShareImages(layout);
    } catch {
      // A canvas failure must not take the share screen down; text sharing still works.
      return [];
    }
  }, [layout]);

  const text = useMemo(
    () =>
      renderShareText(games, players, solution, match, textFormat, {
        version: versionInfo,
        diff: updateDiff ?? undefined,
      }),
    [games, players, solution, match, textFormat, versionInfo, updateDiff],
  );

  const schedules = useMemo(
    () => buildPlayerSchedules(games, players, solution),
    [games, players, solution],
  );

  useEffect(() => {
    if (selectedPlayer === null && schedules.length > 0) setSelectedPlayer(schedules[0].playerId);
  }, [schedules, selectedPlayer]);

  const activeSchedule = schedules.find((entry) => entry.playerId === selectedPlayer) ?? null;

  const playerText = useMemo(() => {
    if (tab !== 'player') return '';
    return activeSchedule ? renderPlayerText(activeSchedule, match, versionInfo) : '';
  }, [tab, activeSchedule, match, versionInfo]);

  const allPlayersText = useMemo(
    () => renderAllPlayersText(games, players, solution, match, versionInfo),
    [games, players, solution, match, versionInfo],
  );

  const shareableText = tab === 'player' ? playerText || allPlayersText : text;
  const title = [match.teamName, match.opponentName].filter(Boolean).join(' vs ') || 'ORDER';
  const fileBase = `darts-order${match.matchDate ? `-${match.matchDate}` : ''}`;

  const run = async (action: () => Promise<{ ok: boolean; message: string }> | { ok: boolean; message: string }) => {
    setBusy(true);
    try {
      const outcome = await action();
      if (outcome.message) toast.show(outcome.message, outcome.ok ? 'ok' : 'error');
    } finally {
      setBusy(false);
    }
  };

  const handleStandardShare = (): void => {
    void run(async () => {
      if (tab === 'image' && images.length > 0) {
        return shareImages(images.map((image) => image.dataUrl), fileBase, title, shareableText);
      }
      return shareText(shareableText, title);
    });
  };

  const handleSaveImage = (): void => {
    void run(() => saveImages(images.map((image) => image.dataUrl), fileBase));
  };

  const handleCopyText = (): void => {
    void run(async () => {
      const ok = await copyText(shareableText);
      return { ok, message: ok ? 'テキストをコピーしました' : 'コピーできませんでした' };
    });
  };

  return (
    <Sheet title="共有" onClose={onClose}>
      {lifecycle !== 'FINALIZED' ? (
        <div className="notice warn" data-testid="share-draft-warning">
          <span aria-hidden="true">△</span>
          <span className="small-text">
            <strong>
              {lifecycle === 'DRAFT'
                ? 'このオーダーはまだ確定されていません'
                : `確定版 v${latest?.version ?? 1} から変更されています`}
            </strong>
            <br />
            {lifecycle === 'DRAFT'
              ? 'プレビューと共有は可能ですが、確定するとバージョンが付き、メンバーがどれを最新版か判断できます。'
              : 'このまま共有するとメンバーが見る版がどれか分からなくなります。先に再確定することをおすすめします。'}
          </span>
        </div>
      ) : null}

      <div className="share-tabs" role="tablist" aria-label="共有形式">
        {(
          [
            ['image', '画像'],
            ['text', 'テキスト'],
            ['player', 'プレイヤー別'],
          ] as [ShareTab, string][]
        ).map(([key, label]) => (
          <button
            type="button"
            key={key}
            role="tab"
            className="share-tab"
            aria-selected={tab === key}
            onClick={() => setTab(key)}
          >
            {label}
          </button>
        ))}
      </div>

      <details className="match-edit" open={editMatch} onToggle={(event) => setEditMatch(event.currentTarget.open)}>
        <summary>
          <span className="grow">
            試合情報
            <span className="dim tiny" style={{ marginLeft: 8 }}>
              {[match.leagueName, [match.teamName, match.opponentName].filter(Boolean).join(' vs '), match.matchDate]
                .filter(Boolean)
                .join(' ・ ') || '未入力'}
            </span>
          </span>
          <span aria-hidden="true">✎</span>
        </summary>
        <div style={{ paddingTop: 10 }}>
          <MatchInfoFields value={match} onChange={onMatchChange} />
        </div>
      </details>

      {tab === 'image' ? (
        <>
          <Segmented
            label="画像の種類"
            options={IMAGE_VARIANTS}
            value={variant}
            onChange={setVariant}
          />
          {images.length === 0 ? (
            <p className="notice warn small-text">
              この環境では画像を生成できませんでした。「テキスト」タブをご利用ください。
            </p>
          ) : (
            <>
              {images.length > 1 ? (
                <p className="tiny dim" style={{ marginTop: 0 }}>
                  ゲーム数が多いため {images.length} 枚に分割しました (文字は縮小していません)。
                </p>
              ) : null}
              <div className="share-previews">
                {images.map((image) => (
                  <figure key={image.page}>
                    <img
                      className="share-preview"
                      src={image.dataUrl}
                      alt={`オーダー画像 ${image.page} / ${image.pageCount}`}
                    />
                    {images.length > 1 ? (
                      <figcaption className="tiny dim">
                        {image.page} / {image.pageCount}
                      </figcaption>
                    ) : null}
                  </figure>
                ))}
              </div>
              <p className="tiny dim">
                PNG {images[0].width} × {images[0].height}px
              </p>
            </>
          )}
        </>
      ) : null}

      {tab === 'text' ? (
        <>
          <Segmented label="テキスト形式" options={textFormats} value={textFormat} onChange={setTextFormat} />
          <label className="field">
            <span className="visually-hidden">共有テキスト</span>
            <textarea
              readOnly
              value={text}
              rows={14}
              aria-label="共有テキスト"
              style={{ fontFamily: 'ui-monospace, monospace', fontSize: 13 }}
            />
          </label>
          <button
            type="button"
            className="btn small"
            onClick={() => {
              downloadText(text, `${fileBase}.txt`, 'text/plain');
              toast.show('テキストを保存しました', 'ok');
            }}
          >
            テキストをファイル保存
          </button>
        </>
      ) : null}

      {tab === 'player' ? (
        <>
          <p className="tiny dim" style={{ marginTop: 0 }}>
            各メンバーが自分の出場ゲームだけを確認できます。
          </p>
          <div className="player-chips" role="group" aria-label="プレイヤーの選択">
            {schedules.map((schedule) => (
              <button
                type="button"
                key={schedule.playerId}
                className="chip"
                aria-pressed={schedule.playerId === selectedPlayer}
                onClick={() => setSelectedPlayer(schedule.playerId)}
              >
                {schedule.name}
                <span className="badge">{schedule.entries.length}</span>
              </button>
            ))}
          </div>

          {activeSchedule ? (
            <div className="player-schedule">
              <h3>{activeSchedule.name}</h3>
              {activeSchedule.entries.length === 0 ? (
                <p className="muted small-text">出場なし</p>
              ) : (
                <ul>
                  {activeSchedule.entries.map((entry, index) => (
                    <li key={index}>
                      <span className="badge accent">{entry.no}</span>
                      <span className="grow">
                        <strong>{entry.gameName}</strong>
                        {entry.partners.length > 0 ? (
                          <span className="dim tiny" style={{ display: 'block' }}>
                            Partner: {entry.partners.join(' / ')}
                          </span>
                        ) : null}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          ) : null}

          <button
            type="button"
            className="btn small"
            onClick={() =>
              void run(async () => {
                const ok = await copyText(allPlayersText);
                return { ok, message: ok ? '全員分をコピーしました' : 'コピーできませんでした' };
              })
            }
          >
            全員分をコピー
          </button>
        </>
      ) : null}

      <div className="share-actions">
        {capabilities.webShare ? (
          <button type="button" className="btn primary grow" disabled={busy} onClick={handleStandardShare}>
            {tab === 'image' && capabilities.files ? '標準共有 (画像)' : '標準共有'}
          </button>
        ) : null}
        <button
          type="button"
          className={capabilities.webShare ? 'btn grow' : 'btn primary grow'}
          disabled={busy || (tab === 'image' && images.length === 0)}
          onClick={tab === 'image' ? handleSaveImage : handleCopyText}
        >
          {tab === 'image' ? '画像を保存' : 'テキストをコピー'}
        </button>
        {tab === 'image' ? (
          <button type="button" className="btn grow" disabled={busy} onClick={handleCopyText}>
            テキストをコピー
          </button>
        ) : null}
      </div>

      {!capabilities.webShare ? (
        <p className="tiny dim" style={{ margin: '8px 0 0' }}>
          この環境は端末標準の共有メニューに対応していないため、画像の保存とテキストのコピーで共有してください。
        </p>
      ) : null}
    </Sheet>
  );
}

function Segmented<T extends string>({
  label,
  options,
  value,
  onChange,
}: {
  label: string;
  options: readonly { key: T; label: string; hint: string }[];
  value: T;
  onChange: (next: T) => void;
}): React.JSX.Element {
  const active = options.find((option) => option.key === value);
  return (
    <div className="field">
      <span>{label}</span>
      <div className="row wrap" style={{ gap: 6 }}>
        {options.map((option) => (
          <button
            type="button"
            key={option.key}
            className="chip"
            aria-pressed={value === option.key}
            onClick={() => onChange(option.key)}
          >
            {option.label}
          </button>
        ))}
      </div>
      {active ? <span className="hint">{active.hint}</span> : null}
    </div>
  );
}
