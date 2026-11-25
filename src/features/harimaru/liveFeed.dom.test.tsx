import { act, cleanup, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { LiveState, LiveThrow } from '../matches/parse';
import { HarimaruLayer } from './HarimaruLayer';
import { HarimaruController } from './controller';
import { activeLiveSource, claimLive, forgetLiveStates, holdLive, publishLive, rebaseLive, subscribeLive, type LiveFeedMessage } from './liveFeed';
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


/** 進行中の Leg (index) の投てき付きの状態 (味方 = A = side 0)。 */
const legState = (throws: Array<[0 | 1, number, number]>, over: Partial<LiveState> = {}, index = 1): LiveState =>
  state({
    currentLeg: index,
    legs: [1, 0],
    updateTime: 10 + throws.length,
    leg: {
      index,
      first: 0,
      ended: false,
      winner: null,
      thrower: (throws.length % 2) as 0 | 1,
      round: Math.floor(throws.length / 2) + 1,
      member: null,
      left: [501, 501],
      start: [501, 501],
      numbers: null,
      marks: null,
      points: null,
      throws: throws.map(([side, round, score]): LiveThrow => ({ kind: '01', side, round, score, left: 501 - score, darts: 3, finish: false }) as LiveThrow),
      bull: false,
      dartsTotal: null,
    },
    ...over,
  });

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
    // 停止中に受け取った最新の状態を、基準として渡す (次の新しい出来事を基準として捨てない)。
    expect(heard.at(-1)).toEqual({ kind: 'rebase', source: 'watch-live', base: { state: state(), allyId: 'A' } });
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

  it('停止をすべて解除したら、停止中に受け取った同じ観戦対象の最新の状態を基準として渡す。信頼できない記録は渡さない', () => {
    const heard: LiveFeedMessage[] = [];
    const stop = subscribeLive((m) => heard.push(m));
    const releaseLive = claimLive('watch-live');
    publishLive('watch-live', state({ updateTime: 1 }), 'A');
    // 停止中に受け取った状態は流さないが、解除の基準として最新のものを渡す。
    let unhold = holdLive('watch-live');
    publishLive('watch-live', state({ updateTime: 2 }), 'A');
    publishLive('watch-live', state({ updateTime: 3 }), 'A');
    unhold();
    expect(heard.at(-1)).toEqual({ kind: 'rebase', source: 'watch-live', base: { state: state({ updateTime: 3 }), allyId: 'A' } });
    // 停止中に受け取っていなくても、権利を持っている間に受け取った最新の状態 (停止の前のもの) を渡す。
    unhold = holdLive('watch-live');
    unhold();
    expect(heard.at(-1)).toMatchObject({ kind: 'rebase', base: { state: { updateTime: 3 } } });
    // 基準のやり直し (通信の失敗など) のあとは、それまでの記録を渡さない (次の状態を基準にし直す)。
    unhold = holdLive('watch-live');
    rebaseLive('watch-live');
    unhold();
    expect(heard.at(-1)).toEqual({ kind: 'rebase', source: 'watch-live' });
    // 権利のない間に届いた状態は記録しない (それまでの記録も捨てる)。
    publishLive('watch-live', state({ updateTime: 4 }), 'A');
    const releaseMatch = claimLive('watch-match');
    publishLive('watch-live', state({ updateTime: 5 }), 'A');
    releaseMatch();
    unhold = holdLive('watch-live');
    unhold();
    expect(heard.at(-1)).toEqual({ kind: 'rebase', source: 'watch-live' });
    // 権利が移って戻ってきた (その間に状態が届かなくても): 移る前の記録は渡さない。
    publishLive('watch-live', state({ updateTime: 5.5 }), 'A');
    unhold = holdLive('watch-live');
    const releaseOther = claimLive('watch-match');
    releaseOther();
    unhold();
    expect(heard.at(-1)).toEqual({ kind: 'rebase', source: 'watch-live' });
    // 権利を手放したら記録を捨てる (取り直した画面に前の状態を渡さない)。
    publishLive('watch-live', state({ updateTime: 6 }), 'A');
    releaseLive();
    const again = claimLive('watch-live');
    unhold = holdLive('watch-live');
    unhold();
    expect(heard.at(-1)).toEqual({ kind: 'rebase', source: 'watch-live' });
    // タブの表示の切り替えより前の記録は渡さない。切り替えのあとに受け取った状態は渡す。
    publishLive('watch-live', state({ updateTime: 7 }), 'A');
    unhold = holdLive('watch-live');
    forgetLiveStates();
    unhold();
    expect(heard.at(-1)).toEqual({ kind: 'rebase', source: 'watch-live' });
    unhold = holdLive('watch-live');
    forgetLiveStates();
    publishLive('watch-live', state({ updateTime: 8 }), 'A');
    unhold();
    expect(heard.at(-1)).toMatchObject({ kind: 'rebase', base: { state: { updateTime: 8 } } });
    // 聞き手がいない間 (表示 OFF) に届いた状態も記録する (OFF の前の古い状態を基準にしない)。
    stop();
    unhold = holdLive('watch-live');
    publishLive('watch-live', state({ updateTime: 9 }), 'A');
    const heard2: LiveFeedMessage[] = [];
    const stop2 = subscribeLive((m) => heard2.push(m));
    unhold();
    expect(heard2.at(-1)).toMatchObject({ kind: 'rebase', base: { state: { updateTime: 9 } } });
    again();
    stop2();
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

  it('過去の Leg から戻った直後: 表示中の 60 には反応せず、`changed: 0` が続いたあとの新しい 180 に 1 回だけ反応する', () => {
    const react = vi.spyOn(HarimaruController.prototype, 'reactLive');
    render(<HarimaruLayer page="watch" />);
    act(() => FakeImage.instances[0].onload?.());
    const release = claimLive('watch-live');
    // 進行中の Leg 2 (index 1): 最初の状態は基準。
    const first = legState([[0, 1, 100], [1, 1, 100]]);
    act(() => publishLive('watch-live', first, 'A'));
    // 終了済みの Leg 1 を開く。閲覧中に味方が 60 (流さない)。
    let unhold = (): void => undefined;
    act(() => {
      unhold = holdLive('watch-live');
    });
    const during = legState([[0, 1, 100], [1, 1, 100], [0, 2, 60]]);
    act(() => publishLive('watch-live', during, 'A'));
    // Leg 2 に戻る。`changed: 0` (状態は変わらない = 流れない) が続いたあと、相手 60・味方 180 の新しいラウンド。
    act(() => unhold());
    expect(react).not.toHaveBeenCalled();
    const next = legState([[0, 1, 100], [1, 1, 100], [0, 2, 60], [1, 2, 60], [0, 3, 180]]);
    act(() => publishLive('watch-live', next, 'A'));
    expect(react.mock.calls.map(([reaction]) => reaction)).toEqual(['surprise180']);
    // 同じ応答を再取得しても追加しない。
    act(() => publishLive('watch-live', { ...next }, 'A'));
    expect(react).toHaveBeenCalledTimes(1);
    release();
    react.mockRestore();
  });

  it('過去の Leg から戻ったとき、信頼できる状態がなければ従来どおり次の状態を基準にする (複数の停止・非表示・アンマウント)', () => {
    const react = vi.spyOn(HarimaruController.prototype, 'reactLive');
    const view = render(<HarimaruLayer page="watch" />);
    act(() => FakeImage.instances[0].onload?.());
    const release = claimLive('watch-live');
    act(() => publishLive('watch-live', legState([[0, 1, 100], [1, 1, 100]]), 'A'));
    // 2 つの停止: 片方を解除しても止めたまま (表示中の 180 にも反応しない)。
    let unholdA = (): void => undefined;
    let unholdB = (): void => undefined;
    act(() => {
      unholdA = holdLive('watch-live');
      unholdB = holdLive('watch-live');
    });
    act(() => publishLive('watch-live', legState([[0, 1, 100], [1, 1, 100], [0, 2, 180]]), 'A'));
    act(() => unholdA());
    act(() => publishLive('watch-live', legState([[0, 1, 100], [1, 1, 100], [0, 2, 180], [1, 2, 60]]), 'A'));
    // 表示中にタブが非表示になった: 解除で渡される状態は使わず、次の状態を基準にする。
    act(() => {
      document.dispatchEvent(new Event('visibilitychange'));
    });
    act(() => unholdB());
    act(() => publishLive('watch-live', legState([[0, 1, 100], [1, 1, 100], [0, 2, 180], [1, 2, 60], [0, 3, 180]]), 'A'));
    expect(react).not.toHaveBeenCalled();
    // 以後は新しい出来事に反応する。
    act(() => publishLive('watch-live', legState([[0, 1, 100], [1, 1, 100], [0, 2, 180], [1, 2, 60], [0, 3, 180], [1, 3, 140]]), 'A'));
    expect(react.mock.calls.map(([reaction]) => reaction)).toEqual(['anxious']);
    // 停止中にアンマウントした: 解除しても古い状態・出来事は混ざらない。作り直したレイヤーは最初の状態を基準にする。
    let unhold = (): void => undefined;
    act(() => {
      unhold = holdLive('watch-live');
    });
    act(() => publishLive('watch-live', legState([[0, 1, 100], [1, 1, 100], [0, 2, 180], [1, 2, 60], [0, 3, 180], [1, 3, 140], [0, 4, 180]]), 'A'));
    view.unmount();
    act(() => unhold());
    render(<HarimaruLayer page="watch" />);
    const atlas = FakeImage.instances.filter((image) => /atlas/.test(image.src)).at(-1);
    act(() => atlas?.onload?.());
    act(() => publishLive('watch-live', legState([[0, 1, 100], [1, 1, 100], [0, 2, 180], [1, 2, 60], [0, 3, 180], [1, 3, 140], [0, 4, 180], [1, 4, 26]]), 'A'));
    expect(react).toHaveBeenCalledTimes(1);
    act(() => publishLive('watch-live', legState([[0, 1, 100], [1, 1, 100], [0, 2, 180], [1, 2, 60], [0, 3, 180], [1, 3, 140], [0, 4, 180], [1, 4, 26], [0, 5, 140]]), 'A'));
    expect(react.mock.calls.map(([reaction]) => reaction)).toEqual(['anxious', 'cheer']);
    release();
    react.mockRestore();
  });

  it('表示 OFF の間・タブの表示の切り替えのあとに受け取った状態を基準にする: その間の 180 には反応せず、戻ったあとの新しい 180 に 1 回', () => {
    const react = vi.spyOn(HarimaruController.prototype, 'reactLive');
    const view = render(<HarimaruLayer page="watch" />);
    act(() => FakeImage.instances[0].onload?.());
    const release = claimLive('watch-live');
    act(() => publishLive('watch-live', legState([[0, 1, 100], [1, 1, 100]]), 'A'));
    // 過去の Leg を開いたまま表示 OFF (レイヤーがなくなる)。その間に味方 180。
    let unhold = (): void => undefined;
    act(() => {
      unhold = holdLive('watch-live');
    });
    view.unmount();
    act(() => publishLive('watch-live', legState([[0, 1, 100], [1, 1, 100], [0, 2, 180]]), 'A'));
    // 表示 ON に戻し、タブの非表示・再表示のあと (閲覧中のまま) 相手 60 が届き、Leg 2 に戻る。
    render(<HarimaruLayer page="watch" />);
    act(() => FakeImage.instances.filter((image) => /atlas/.test(image.src)).at(-1)?.onload?.());
    act(() => {
      document.dispatchEvent(new Event('visibilitychange'));
    });
    act(() => publishLive('watch-live', legState([[0, 1, 100], [1, 1, 100], [0, 2, 180], [1, 2, 60]]), 'A'));
    act(() => unhold());
    expect(react).not.toHaveBeenCalled();
    // `changed: 0` (流れない) のあとの新しい味方 180 には反応する。表示 OFF の間の 180 には反応しない。
    act(() => publishLive('watch-live', legState([[0, 1, 100], [1, 1, 100], [0, 2, 180], [1, 2, 60], [0, 3, 180]]), 'A'));
    expect(react.mock.calls.map(([reaction]) => reaction)).toEqual(['surprise180']);
    release();
    react.mockRestore();
  });

  it('別の観戦対象 (右カードの過去の Leg・別の試合の詳細) の停止の解除では、反応している観戦対象の判定を変えない', () => {
    const react = vi.spyOn(HarimaruController.prototype, 'reactLive');
    render(<HarimaruLayer page="watch" />);
    act(() => FakeImage.instances[0].onload?.());
    const release = claimLive('watch-live');
    act(() => publishLive('watch-live', legState([[0, 1, 100], [1, 1, 100]]), 'A'));
    let unhold = (): void => undefined;
    act(() => {
      unhold = holdLive('watch-results');
    });
    act(() => publishLive('watch-live', legState([[0, 1, 100], [1, 1, 100], [0, 2, 180]]), 'A'));
    act(() => unhold());
    expect(react.mock.calls.map(([reaction]) => reaction)).toEqual(['surprise180']);
    // 別の試合の詳細を開いて (権利が移る)、その画面で過去の Leg を見て戻る: 詳細の状態を基準にし、元の観戦対象は止めない。
    const releaseMatch = claimLive('watch-match');
    const other = (throws: Array<[0 | 1, number, number]>) => legState(throws, { mid: 'm9', tmid: 'c9' });
    act(() => publishLive('watch-match', other([[0, 1, 60]]), 'A'));
    act(() => {
      unhold = holdLive('watch-match');
    });
    act(() => publishLive('watch-match', other([[0, 1, 60], [1, 1, 180]]), 'A'));
    act(() => unhold());
    act(() => publishLive('watch-match', other([[0, 1, 60], [1, 1, 180], [0, 2, 180]]), 'A'));
    expect(react.mock.calls.map(([reaction]) => reaction)).toEqual(['surprise180', 'surprise180']);
    releaseMatch();
    release();
    react.mockRestore();
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
