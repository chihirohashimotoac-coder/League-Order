import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { MatchesApi } from '../api';
import type { AnalyticsTransport } from '../../analytics/api/readApi';
import { RequestGovernor } from '../governor';
import type { MatchesApiFactory } from '../environment';
import { SET_SCID, setMatchReply, setMid } from '../../../test/n01/setMatch';
import type { SetMatchOptions } from '../../../test/n01/setMatch';
import { SETS_REFRESH_MS, SetMatchPage } from './SetMatchPage';

/**
 * 「いま n01 で進行中」 → a set-format match on its own page (2026-11-16, Light League: the page
 * stayed on ダブルス1 after ダブルス2 began, and the earlier sets could not be opened).
 */

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

function world(options: SetMatchOptions & { phase: number }) {
  const calls: string[] = [];
  const transport: AnalyticsTransport = {
    request: async (operation, params) => {
      calls.push(`${operation}?${new URLSearchParams(params).toString()}`);
      const reply = setMatchReply(operation, params, options.phase, options);
      if (reply === undefined) return { result: -1, error: 'not found' };
      return reply;
    },
  };
  const factory: MatchesApiFactory = (opts) => new MatchesApi({ transport, governor: new RequestGovernor(100_000), pollPerMinute: 100_000, ...opts });
  return { factory, calls, options };
}

const flush = async (ms = 0): Promise<void> => {
  await act(async () => {
    if (ms) await vi.advanceTimersByTimeAsync(ms);
    for (let i = 0; i < 20; i += 1) await Promise.resolve();
  });
};

function open(w: ReturnType<typeof world>, mid: string, onShown = vi.fn()) {
  const view = render(<SetMatchPage mid={mid} factory={w.factory} onBack={() => undefined} onShown={onShown} />);
  return { ...view, onShown };
}

const items = () => screen.getAllByTestId('set-item');
const labels = () => items().map((item) => item.querySelector('.set-item-name')?.textContent);

describe('SetMatchPage', () => {
  it('follows the match across sets without reopening, and stops at the end of the match', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] });
    const w = world({ phase: 2 }); // ダブルス1 in play
    const { onShown } = open(w, setMid(1));
    await flush(10);
    await flush(10);
    expect(screen.getByTestId('set-page-title').textContent).toBe('【デモリーグ】R3 Alpha Darts vs Bravo Arrows');
    expect(labels()).toEqual(['シングルス1', 'LIVEダブルス1']);
    expect(screen.getByTestId('shown-set').textContent).toContain('ダブルス1');
    expect(screen.getByTestId('set-legs').textContent).toBe('1 - 1');
    expect(screen.getByTestId('sets-won').textContent).toContain('1 - 0');

    w.options.phase = 3; // ダブルス1 over: the next set is awaited, not the end
    await flush(1600);
    expect(screen.getByTestId('set-wait')).toBeTruthy();
    expect(screen.getByTestId('set-legs').textContent).toBe('1 - 2');
    expect(screen.getByTestId('set-page-status').textContent).not.toContain('終了');

    w.options.phase = 4; // ダブルス2 began: shown at once, its own players and legs
    await flush(1600);
    expect(screen.getByTestId('shown-set').textContent).toContain('ダブルス2');
    expect(screen.getByTestId('set-legs').textContent).toBe('1 - 1');
    expect(screen.getByTestId('set-score').textContent).toContain('Alpha 選手3-1');
    expect(screen.getByTestId('set-score').textContent).not.toContain('Alpha 選手2-1');
    expect(onShown).toHaveBeenLastCalledWith(setMid(2));
    expect(labels()).toContain('LIVEダブルス2');

    w.options.phase = 7; // the match is over
    await flush(1600);
    await flush(1600);
    await flush(1600);
    expect(screen.getByTestId('set-page-status').textContent).toContain('終了');
    const before = w.calls.filter((call) => call.startsWith('match/live')).length;
    await flush(10_000);
    expect(w.calls.filter((call) => call.startsWith('match/live')).length).toBe(before);
    expect(labels()).toEqual(['シングルス1', 'ダブルス1', 'ダブルス2', 'シングルス2']);
    expect(screen.getByTestId('sets-won').textContent).toContain('2 - 2');
  });

  it('opens an earlier set while the live set keeps updating, and one tap returns to it', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] });
    const w = world({ phase: 4 });
    open(w, setMid(2));
    await flush(10);
    fireEvent.click(items()[0]);
    await flush(10);
    expect(screen.getByTestId('shown-set').textContent).toContain('シングルス1');
    expect(screen.getByTestId('set-legs').textContent).toBe('2 - 0');
    expect(screen.getByTestId('set-score').textContent).toContain('Alpha 選手1-1');
    expect(items()[0].getAttribute('aria-checked')).toBe('true');

    w.options.phase = 6; // シングルス2 began meanwhile: the choice is kept, the list moves on
    await flush(1600);
    await flush(10);
    expect(screen.getByTestId('shown-set').textContent).toContain('シングルス1');
    expect(labels()).toContain('LIVEシングルス2');

    fireEvent.click(screen.getByTestId('back-to-live'));
    await flush(10);
    expect(screen.getByTestId('shown-set').textContent).toContain('シングルス2');
    expect(screen.queryByTestId('back-to-live')).toBeNull();
  });

  it('a link to a set that is over opens that set, even with the match further on', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] });
    const w = world({ phase: 4 });
    const { onShown } = open(w, setMid(0));
    await flush(10);
    await flush(1600);
    expect(screen.getByTestId('shown-set').textContent).toContain('シングルス1');
    expect(onShown).not.toHaveBeenCalled();
    expect(screen.getByTestId('back-to-live')).toBeTruthy();
  });

  it('the latest score updates while the list of sets lags or fails, and says so in the list', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] });
    const w = world({ phase: 2, listFails: true });
    open(w, setMid(1));
    await flush(10);
    expect(screen.getByTestId('sets-error').textContent).toContain('最新のスコアは更新を続けています');
    expect(screen.getByTestId('set-legs').textContent).toBe('1 - 1');
    w.options.phase = 4;
    await flush(1600);
    expect(screen.getByTestId('shown-set').textContent).toContain('ダブルス2');
    // Back: the list comes back on its next read.
    w.options.listFails = false;
    await flush(SETS_REFRESH_MS);
    expect(screen.queryByTestId('sets-error')).toBeNull();
    expect(labels()).toEqual(['シングルス1', 'ダブルス1', 'LIVEダブルス2']);
  });

  it('the sets are chosen with the arrow keys', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] });
    const w = world({ phase: 4 });
    open(w, setMid(2));
    await flush(10);
    const group = screen.getByRole('radiogroup', { name: 'セットを選ぶ' });
    const live = within(group).getByRole('radio', { checked: true });
    expect(live.getAttribute('tabindex')).toBe('0');
    live.focus();
    fireEvent.keyDown(group, { key: 'Home' });
    await flush(10);
    expect(screen.getByTestId('shown-set').textContent).toContain('シングルス1');
  });

  it('a game without scid is followed by its mid, without a list of sets', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] });
    const w = world({ phase: 2 });
    const plain = { ...w };
    const transport: AnalyticsTransport = {
      request: async (operation, params) => {
        plain.calls.push(`${operation}?${new URLSearchParams(params).toString()}`);
        const reply = setMatchReply(operation, params, 2) as { list?: Record<string, unknown>[]; scid?: string } | undefined;
        if (reply === undefined) return { result: -1, error: 'not found' };
        // The same game, sent without scid.
        if (reply.list) return { ...reply, list: reply.list.map((row) => ({ ...row, scid: undefined })) };
        return { ...reply, scid: undefined };
      },
    };
    const factory: MatchesApiFactory = (opts) => new MatchesApi({ transport, governor: new RequestGovernor(100_000), pollPerMinute: 100_000, ...opts });
    render(<SetMatchPage mid={setMid(1)} factory={factory} onBack={() => undefined} onShown={() => undefined} />);
    await flush(10);
    await flush(1600);
    expect(screen.queryByTestId('set-list')).toBeNull();
    expect(plain.calls.some((call) => call.startsWith('match/live') && call.includes(`mid=${setMid(1)}`))).toBe(true);
    expect(plain.calls.some((call) => call.includes(`scid=${SET_SCID}`))).toBe(false);
  });

  it('a linked set the lagging list leaves out keeps its own name, players and legs', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] });
    const transport: AnalyticsTransport = {
      request: async (operation, params) => {
        const reply = setMatchReply(operation, params, 4) as { list?: { mid: string }[] } | undefined;
        if (reply === undefined) return { result: -1, error: 'not found' };
        // The list by scid does not hold シングルス1 (yet).
        if (params.scid && reply.list) return { ...reply, list: reply.list.filter((row) => row.mid !== setMid(0)) };
        return reply;
      },
    };
    const factory: MatchesApiFactory = (opts) => new MatchesApi({ transport, governor: new RequestGovernor(100_000), pollPerMinute: 100_000, ...opts });
    render(<SetMatchPage mid={setMid(0)} factory={factory} onBack={() => undefined} onShown={() => undefined} />);
    await flush(10);
    await flush(1600);
    expect(screen.getByTestId('shown-set').textContent).toContain('シングルス1');
    expect(screen.getByTestId('shown-set').textContent).not.toContain('ダブルス2');
    expect(screen.getByTestId('set-legs').textContent).toBe('2 - 0');
    expect(screen.getByTestId('set-score').textContent).toContain('Alpha 選手1-1');
    expect(screen.getByTestId('set-score').textContent).not.toContain('Alpha 選手3-1');
  });

  it('the address and the set shown stay together through the browser’s back and forward', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] });
    const w = world({ phase: 4 });
    const onShown = vi.fn();
    const props = { factory: w.factory, onBack: () => undefined, onShown };
    const view = render(<SetMatchPage mid={setMid(2)} {...props} />);
    await flush(10);
    await flush(10);
    fireEvent.click(items()[0]); // A = シングルス1, written to the address
    await flush(10);
    expect(onShown).toHaveBeenLastCalledWith(setMid(0));
    view.rerender(<SetMatchPage mid={setMid(0)} {...props} />);
    await flush(10);
    view.rerender(<SetMatchPage mid={setMid(1)} {...props} />); // B from the browser
    await flush(10);
    expect(screen.getByTestId('shown-set').textContent).toContain('ダブルス1');
    view.rerender(<SetMatchPage mid={setMid(0)} {...props} />); // back to A
    await flush(10);
    expect(screen.getByTestId('shown-set').textContent).toContain('シングルス1');
  });
});
