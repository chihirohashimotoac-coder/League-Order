/**
 * 観戦画面からハリマルへ、ライブの状態を渡すフック (観戦画面に 1 行で足す)。
 *
 * - 味方: いま選んでいる登録チームの n01 の紐付けが、このシーズン (大会) の n01 チーム ID (`tpid`) をそのまま
 *   指しているときだけ (リーグ ID・大会 ID・チーム ID の一致)。チーム名での推測はしない。それ以外は中立 (null)。
 * - `source` が null の画面 (2 カード表示の右側など、主たる観戦対象でないもの) は何も流さない。
 * - 試合のページを開いて、その下に隠して保持されている観戦ビュー (WatchShown が false) も流さない
 *   (見えていない対戦に反応しない)。見えるようになったら、その時点の状態を基準にし直す。
 * - ポーラーが再試行・取得上限・非表示で止まったら、次の状態を基準にし直す (その間の出来事にまとめて反応しない)。
 * - 既存のポーラー・通信・画面の状態には触れない。
 */
import { useContext, useEffect, useMemo } from 'react';
import type { LiveState, SeasonDocument } from '../matches/parse';
import type { LiveStatus } from '../matches/livePoller';
import { useAppStore } from '../../state/appStore';
import { WatchShownContext } from '../matches/ui/useScreenWake';
import { claimLive, holdLive, publishLive, rebaseLive } from './liveFeed';

export function allyTeamIdIn(season: Pick<SeasonDocument, 'tournamentId' | 'leagueId' | 'teams'> | null, binding: { leagueId: string; lastTournamentId: string; lastTeamId: string } | null | undefined): string | null {
  if (!season || !binding) return null;
  if (!binding.leagueId || binding.leagueId !== season.leagueId) return null;
  if (!binding.lastTournamentId || binding.lastTournamentId !== season.tournamentId) return null;
  return binding.lastTeamId && season.teams.has(binding.lastTeamId) ? binding.lastTeamId : null;
}

/**
 * シーズンの情報がない画面 (試合の詳細): 状態の大会 ID (`tdid`) が紐付けの大会 ID と一致するときだけ、紐付けのチーム ID。
 * チーム ID が実際に状態の側に一致するかは判定 (allySide) が確かめる。
 */
export function allyTeamIdByTournament(tdid: string | null, binding: { lastTournamentId: string; lastTeamId: string } | null | undefined): string | null {
  if (!tdid || !binding?.lastTournamentId || binding.lastTournamentId !== tdid) return null;
  return binding.lastTeamId || null;
}

/**
 * アプリのストア。ストアの外で描画された画面 (画面単体のテストなど) では null = 登録チームの紐付けなし (中立)。
 * useAppStore はストアの外で例外を投げるので、ここで受け止める (フックは毎回同じ順で呼ばれる)。
 */
function useOptionalStore(): ReturnType<typeof useAppStore> | null {
  try {
    return useAppStore();
  } catch {
    return null;
  }
}

export function useHarimaruLive(requested: string | null, state: LiveState | null, season: SeasonDocument | null, status?: LiveStatus): void {
  const store = useOptionalStore();
  const shown = useContext(WatchShownContext);
  const source = shown ? requested : null;
  const binding = store?.activeTeam?.n01 ?? null;
  const allyId = useMemo(() => allyTeamIdIn(season, binding), [season, binding]);
  useEffect(() => (source ? claimLive(source) : undefined), [source]);
  const interrupted = status !== undefined && (status.kind === 'retrying' || status.kind === 'budget' || status.kind === 'paused-hidden');
  useEffect(() => {
    if (source && interrupted) rebaseLive(source);
  }, [source, interrupted]);
  useEffect(() => {
    if (!source || !state) return;
    // シーズンの分かる画面: 別の大会の状態 (tdid が違う) は中立。分からない画面 (試合の詳細): 大会 ID とチーム ID の一致だけ。
    const ally = season ? (state.tdid && state.tdid !== season.tournamentId ? null : allyId) : allyTeamIdByTournament(state.tdid, binding);
    publishLive(source, state, ally);
  }, [source, state, allyId, season, binding]);
}

/** 観戦画面が過去の Leg を表示している間 (active)、ハリマルへ状態を流さない (LiveSheet から 1 行で呼ぶ)。 */
export function useHarimaruHold(active: boolean): void {
  useEffect(() => (active ? holdLive() : undefined), [active]);
}
