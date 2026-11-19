import { act, cleanup, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { LiveState } from '../matches/parse';
import { HarimaruLayer } from './HarimaruLayer';
import { HarimaruController } from './controller';
import { activeLiveSource, claimLive, holdLive, publishLive, subscribeLive, type LiveFeedMessage } from './liveFeed';
import { resetHarimaruPreferenceForTests, saveHarimaruEnabled } from './preference';
import { allyTeamIdByTournament, allyTeamIdIn } from './useHarimaruLive';

const state = (over: Partial<LiveState> = {}): LiveState =>
  ({
    changed: true,
    mid: 'm1',
    scid: null,
    tdid: 'T',
    tmid: 'c1',
    schid: 's1',
    title: '',
    matchType: '01',
    updateTime: 1,
    gameEnded: false,
    cardEnded: false,
    isSchedule: true,
    sets: [0, 0],
    showSets: false,
    legs: [0, 0],
    limitLeg: 3,
    limitSet: null,
    drawMode: null,
    startScore: 501,
    currentLeg: 0,
    currentSet: null,
    legCount: null,
    sides: [
      { name: 'A', teamId: 'A', members: [], rate: null },
      { name: 'B', teamId: 'B', members: [], rate: null },
    ],
    leg: null,
    ...over,
  }) as LiveState;

describe('liveFeed (観戦画面 → ハリマル)', () => {
  it('聞き手がいなければ何もしない。流せるのは最後に権利を取った観戦画面だけ', () => {
    publishLive('x', state(), 'A');
    const heard: LiveFeedMessage[] = [];
    const stop = subscribeLive((m) => heard.push(m));
    const releaseA = claimLive('live-tab');
    const releaseB = claimLive('results');
    expect(activeLiveSource()).toBe('results');
    publishLive('live-tab', state(), 'A');
    expect(heard).toHaveLength(0);
    publishLive('results', state(), 'A');
    expect(heard.map((m) => m.kind)).toEqual(['state']);
    releaseB();
    expect(activeLiveSource()).toBe('live-tab');
    expect(heard.at(-1)).toEqual({ kind: 'release', source: 'results' });
    publishLive('live-tab', state(), 'A');
    expect(heard.filter((m) => m.kind === 'state')).toHaveLength(2);
    releaseA();
    stop();
    publishLive('live-tab', state(), 'A');
    expect(heard.filter((m) => m.kind === 'state')).toHaveLength(2);
    expect(activeLiveSource()).toBeNull();
  });

  it('過去の Leg の表示による停止 (hold) は観戦対象 (source) ごと: すべて解除したときだけ基準からやり直して再開し、ほかの source は止めない', () => {
    const heard: LiveFeedMessage[] = [];
    const stop = subscribeLive((m) => heard.push(m));
    const releaseLive = claimLive('watch-live');
    const unholdA = holdLive('watch-live');
    const unholdB = holdLive('watch-live');
    expect(heard).toEqual([
      { kind: 'hold', source: 'watch-live' },
      { kind: 'hold', source: 'watch-live' },
    ]);
    publishLive('watch-live', state(), 'A');
    expect(heard.filter((m) => m.kind === 'state')).toHaveLength(0);
    // 片方だけ解除 (2 回呼んでも 1 回分): まだ止めたまま、基準のやり直しもしない。
    unholdA();
    unholdA();
    expect(heard.filter((m) => m.kind === 'rebase')).toHaveLength(0);
    publishLive('watch-live', state(), 'A');
    expect(heard.filter((m) => m.kind === 'state')).toHaveLength(0);
    // 別の source の停止は、watch-live を止めない (いま流す権利がない source の解除で基準もやり直さない)。
    const unholdOther = holdLive('watch-results');
    unholdB();
    expect(heard.at(-1)).toEqual({ kind: 'rebase', source: 'watch-live' });
    publishLive('watch-live', state(), 'A');
    expect(heard.at(-1)?.kind).toBe('state');
    const rebases = heard.filter((m) => m.kind === 'rebase').length;
    unholdOther();
    unholdOther();
    expect(heard.filter((m) => m.kind === 'rebase')).toHaveLength(rebases);
    // 解除済みの source は、権利を取れば流せる (停止が残らない)。
    const releaseResults = claimLive('watch-results');
    publishLive('watch-results', state(), 'A');
    expect(heard.at(-1)).toMatchObject({ kind: 'state', source: 'watch-results' });
    releaseResults();
    releaseLive();
    stop();
  });

  it('味方の ID は、リーグ・大会 (シーズン)・チーム ID がすべて一致したときだけ (チーム名では推測しない)', () => {
    const season = { tournamentId: 'T', leagueId: 'L', teams: new Map([['A', '味方'], ['B', '相手']]) };
    const binding = { leagueId: 'L', lastTournamentId: 'T', lastTeamId: 'A' };
    expect(allyTeamIdIn(season, binding)).toBe('A');
    expect(allyTeamIdIn(season, { ...binding, leagueId: 'L2' })).toBeNull();
    // 別のシーズン (前のシーズンの紐付けのまま): 同じ名前のチームがいても推測しない。
    expect(allyTeamIdIn(season, { ...binding, lastTournamentId: 'T0' })).toBeNull();
    expect(allyTeamIdIn(season, { ...binding, lastTeamId: 'Z' })).toBeNull();
    expect(allyTeamIdIn(season, null)).toBeNull();
    expect(allyTeamIdIn(null, binding)).toBeNull();
  });

  it('シーズンの情報がない画面 (試合の詳細) では、大会 ID が紐付けと一致するときだけ紐付けのチーム ID', () => {
    const binding = { lastTournamentId: 'T', lastTeamId: 'A' };
    expect(allyTeamIdByTournament('T', binding)).toBe('A');
    expect(allyTeamIdByTournament('T2', binding)).toBeNull();
    expect(allyTeamIdByTournament(null, binding)).toBeNull();
    expect(allyTeamIdByTournament('T', null)).toBeNull();
  });
});

/** 画像の読み込みを手で成功させる (HarimaruLayer.test.tsx と同じ)。 */
class FakeImage {
  static instances: FakeImage[] = [];
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  src = '';
  constructor() {
    FakeImage.instances.push(this);
  }
}

describe('HarimaruLayer の購読', () => {
  beforeEach(() => {
    FakeImage.instances = [];
    vi.stubGlobal('Image', FakeImage);
    vi.stubGlobal('matchMedia', (query: string) => ({ matches: false, media: query, addEventListener: () => undefined, removeEventListener: () => undefined }));
    const main = document.createElement('main');
    main.className = 'app-main';
    document.body.append(main);
  });
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    window.localStorage.clear();
    resetHarimaruPreferenceForTests();
    document.body.innerHTML = '';
  });

  const reactionImages = () => FakeImage.instances.filter((image) => /\/pr3\/|(victory|cheer|panic|anxious|frustrated|surprise180)@/.test(image.src));

  it('味方の分かる状態が初めて届いたときに、画素密度に合うリアクションの画像 (6 種 × 本体・エフェクト) だけを読み込む', () => {
    const view = render(<HarimaruLayer page="watch" />);
    expect(document.body.querySelector('[data-testid="harimaru-effect"]')?.getAttribute('data-active')).toBe('false');
    act(() => FakeImage.instances[0].onload?.());
    const release = claimLive('watch-live');
    expect(reactionImages()).toHaveLength(0);
    // 中立 (味方なし) の状態では読み込まない。
    act(() => publishLive('watch-live', state(), null));
    expect(reactionImages()).toHaveLength(0);
    act(() => publishLive('watch-live', state(), 'A'));
    expect(reactionImages()).toHaveLength(12);
    expect(reactionImages().every((image) => /@1x/.test(image.src))).toBe(true);
    // もう一度届いても読み直さない。
    act(() => publishLive('watch-live', state({ updateTime: 2 }), 'A'));
    expect(reactionImages()).toHaveLength(12);
    // 画面を離れたら購読をやめる (流しても何も起きない)。
    view.unmount();
    act(() => publishLive('watch-live', state({ updateTime: 3 }), 'A'));
    release();
  });

  it('同じ対戦の次のゲーム (mid) へ進んだとき・過去の Leg の表示を始めたとき、演出中・待っている出来事を取り消す', () => {
    const cancel = vi.spyOn(HarimaruController.prototype, 'cancelLive');
    render(<HarimaruLayer page="watch" />);
    act(() => FakeImage.instances[0].onload?.());
    const release = claimLive('watch-live');
    act(() => publishLive('watch-live', state(), 'A'));
    act(() => publishLive('watch-live', state({ updateTime: 2 }), 'A'));
    expect(cancel).not.toHaveBeenCalled();
    act(() => publishLive('watch-live', state({ mid: 'm2', updateTime: 3 }), 'A'));
    expect(cancel).toHaveBeenCalledTimes(1);
    // ほかの観戦対象の画面が過去の Leg を表示しても取り消さない。反応している観戦対象の画面なら取り消す。
    let unhold = (): void => undefined;
    act(() => {
      unhold = holdLive('watch-results');
    });
    expect(cancel).toHaveBeenCalledTimes(1);
    act(() => unhold());
    act(() => {
      unhold = holdLive('watch-live');
    });
    expect(cancel).toHaveBeenCalledTimes(2);
    act(() => unhold());
    release();
    cancel.mockRestore();
  });

  it('表示 OFF ではレイヤーがなく、購読も画像の読み込みもしない', () => {
    saveHarimaruEnabled(false);
    render(<HarimaruLayer page="watch" />);
    const release = claimLive('watch-live');
    act(() => publishLive('watch-live', state(), 'A'));
    expect(FakeImage.instances).toHaveLength(0);
    release();
  });
});
