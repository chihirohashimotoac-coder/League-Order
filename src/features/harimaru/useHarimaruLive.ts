/**
 * 観戦画面からハリマルへ、ライブの状態を渡すフック (観戦画面に 1 行で足す)。
 *
 * - 味方: いま選んでいる登録チームの n01 の紐付けが、このシーズン (大会) の n01 チーム ID (`tpid`) をそのまま
 *   指しているときだけ (リーグ ID・大会 ID・チーム ID の一致)。チーム名での推測はしない。それ以外は中立 (null)。
 * - `source` が null の画面 (2 カード表示の右側など、主たる観戦対象でないもの) は何も流さない。
 * - 既存のポーラー・通信・画面の状態には触れない。
 */
import { useEffect, useMemo } from 'react';
import type { LiveState, SeasonDocument } from '../matches/parse';
import { useAppStore } from '../../state/appStore';
import { claimLive, publishLive } from './liveFeed';

export function allyTeamIdIn(season: Pick<SeasonDocument, 'tournamentId' | 'leagueId' | 'teams'> | null, binding: { leagueId: string; lastTournamentId: string; lastTeamId: string } | null | undefined): string | null {
  if (!season || !binding) return null;
  if (!binding.leagueId || binding.leagueId !== season.leagueId) return null;
  if (!binding.lastTournamentId || binding.lastTournamentId !== season.tournamentId) return null;
  return binding.lastTeamId && season.teams.has(binding.lastTeamId) ? binding.lastTeamId : null;
}

export function useHarimaruLive(source: string | null, state: LiveState | null, season: SeasonDocument | null): void {
  const store = useAppStore();
  const binding = store.activeTeam?.n01 ?? null;
  const allyId = useMemo(() => allyTeamIdIn(season, binding), [season, binding]);
  useEffect(() => (source ? claimLive(source) : undefined), [source]);
  useEffect(() => {
    // 別の大会の状態 (tdid が違う) は、味方を判定できないので中立で流す。
    if (source && state) publishLive(source, state, state.tdid && season && state.tdid !== season.tournamentId ? null : allyId);
  }, [source, state, allyId, season]);
}
