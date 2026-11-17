import { useEffect, useRef, useState } from 'react';
import type { KeyboardEvent, ReactNode } from 'react';
import type { MatchesApi } from '../api';
import type { LiveState } from '../parse';
import { LivePoller } from '../livePoller';
import type { LiveStatus } from '../livePoller';
import { Icon } from '../../../components/icons';
import { CopyLink } from './CopyLink';

/**
 * The parts every 観戦 view of one match is made of — a league card (ATDO / TDO / TDA), a
 * tournament match, a set-format match from 「いま n01 で進行中」 — so that the same thing looks
 * and works the same wherever it is opened:
 *
 *   ‹ back                                   [link]     MatchBar
 *   Team A            2 - 1            Team B          MatchHead (+ one line of context)
 *   [Team 1-0][D1 1-2][D2 2-0][S1 LIVE][S2 —]          UnitChips (games of a card / sets)
 *   ● LIVE S1 ・ Leg 3 ・ 1-1          ライブに戻る       LiveReturn (an earlier unit is shown)
 *   ダブルス1  終了                                     UnitHead (the unit shown)
 *   players (avg)        1 - 2        players (avg)
 *   …the live scoreboard, or the legs and figures of the unit…
 *
 * The unit chips wrap instead of scrolling sideways (eleven sets fit a phone), take the arrow
 * keys (one tab stop, Home / End), and are the same on a phone and on a PC.
 */

export interface MatchUnit {
  key: string;
  /** 「ダブルス1」 */
  label: string;
  /** 「D1」 — what fits the chip. */
  short: string;
  /** Legs won in this unit, left / right as the head shows the sides; `null` before it is played. */
  legs: [number | null, number | null] | null;
  /** Left (0) / right (1) won it, -1 drawn, `null` not decided. */
  winner: 0 | 1 | -1 | null;
  live: boolean;
  /** It has a record to open (played, or being played). */
  playable: boolean;
}

/** 「ダブルス1」 → 「D1」 (the kinds n01 events name their games and sets by). */
export function shortUnit(label: string): string {
  return label
    .replace(/シングルス\s*/u, 'S')
    .replace(/ダブルス\s*/u, 'D')
    .replace(/トリオス\s*/u, 'T')
    .replace(/ガロン/u, 'G')
    .replace(/チーム/u, 'Team')
    .replace(/クリケット/u, 'C')
    .replace(/^第(\d+)セット$/u, 'Set $1');
}

/** Arrow keys move along the chips and open the one reached (like a tab list, automatic activation). */
function onChipsKeyDown(event: KeyboardEvent<HTMLElement>): void {
  if (!['ArrowRight', 'ArrowLeft', 'ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
  const chips = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>('button.game-tab:not([disabled])'));
  const current = chips.indexOf(document.activeElement as HTMLButtonElement);
  if (current < 0 || chips.length === 0) return;
  event.preventDefault();
  const last = chips.length - 1;
  const next = event.key === 'Home' ? 0 : event.key === 'End' ? last : event.key === 'ArrowRight' || event.key === 'ArrowDown' ? Math.min(last, current + 1) : Math.max(0, current - 1);
  chips[next].focus();
  chips[next].click();
}

export function UnitChips({
  units,
  selected,
  onPick,
  names,
  label,
  testId = 'game-tabs',
  itemTestId = 'game-tab',
}: {
  units: readonly MatchUnit[];
  selected: string | null;
  onPick: (key: string) => void;
  /** The two sides, for the words read out with each chip. */
  names: [string, string];
  label: string;
  testId?: string;
  itemTestId?: string;
}): React.JSX.Element {
  const stop = units.find((unit) => unit.key === selected && unit.playable) ?? units.find((unit) => unit.playable) ?? null;
  return (
    <ol className="game-tabs" aria-label={label} onKeyDown={onChipsKeyDown} data-testid={testId}>
      {units.map((unit) => {
        const legs = unit.legs && unit.legs[0] !== null && unit.legs[1] !== null ? unit.legs : null;
        const said = unit.live ? '進行中' : unit.winner === 0 ? `${names[0]} 勝ち` : unit.winner === 1 ? `${names[1]} 勝ち` : unit.winner === -1 ? '引き分け' : unit.playable ? '未決着' : '未実施';
        return (
          <li key={unit.key}>
            <button
              type="button"
              className={`game-tab${unit.winner === 0 ? ' a' : unit.winner === 1 ? ' b' : ''}${unit.live ? ' is-live' : ''}${!unit.playable ? ' todo' : ''}`}
              aria-pressed={selected === unit.key}
              tabIndex={stop?.key === unit.key ? 0 : -1}
              disabled={!unit.playable}
              onClick={() => onPick(unit.key)}
              title={unit.label}
              data-testid={itemTestId}
              data-key={unit.key}
            >
              <span className="n" aria-hidden="true">
                {unit.short}
              </span>
              <span className="r" aria-hidden="true">
                {unit.live ? (
                  <span className="live-tag">LIVE</span>
                ) : legs ? (
                  <>
                    <b className={unit.winner === 0 ? 'win' : undefined}>{legs[0]}</b>-<b className={unit.winner === 1 ? 'win' : undefined}>{legs[1]}</b>
                  </>
                ) : (
                  '—'
                )}
              </span>
              <span className="sr-only">
                {unit.label} {said}
                {legs && !unit.live ? ` ${legs[0]} 対 ${legs[1]}` : ''}
              </span>
            </button>
          </li>
        );
      })}
    </ol>
  );
}

/** Shown while an earlier unit is open and another is being played: one tap back to it. */
export function LiveReturn({ text, onReturn, label = 'ライブに戻る' }: { text: string; onReturn: () => void; label?: string }): React.JSX.Element {
  return (
    <button type="button" className="live-return" onClick={onReturn} data-testid="back-to-live">
      <span className="live-tag">LIVE</span>
      <span className="grow">{text}</span>
      <span className="go">{label}</span>
    </button>
  );
}

/** The unit shown: its name and state, then who played it and its legs. */
export function UnitHead({
  label,
  kind,
  state,
  sides,
  legs,
  winner,
  testId,
  legsTestId = 'unit-legs',
  hidden = false,
  showResult = false,
}: {
  label: string;
  /** A note after the name (「Doubles 501」). */
  kind?: string;
  state: 'live' | 'finished' | 'waiting';
  sides: [ReactNode, ReactNode];
  legs: [number | null, number | null] | null;
  winner: 0 | 1 | -1 | null;
  testId?: string;
  legsTestId?: string;
  /** Said by the live scoreboard itself while the unit is played: kept for screen readers only. */
  hidden?: boolean;
  /**
   * An ended unit looked back at (opt-in, the set page's history): the winner is also said in
   * words next to the name and its leg count is the boldest number; a draw says so between the
   * two. Without a recorded result nothing is emphasised.
   */
  showResult?: boolean;
}): React.JSX.Element {
  if (showResult && state !== 'live') {
    const said = (side: 0 | 1): React.ReactNode => (winner === side ? <span className="won-tag">勝ち</span> : null);
    return (
      <header className={`unit-head is-result${hidden ? ' visually-hidden' : ''}`}>
        <h3 className="game-block-head" data-testid={testId}>
          {label}
          {kind ? <span className="muted small-text">{kind}</span> : null}
          <span className="tag state-official">{state === 'waiting' ? '終了 ・ 次を待っています' : '終了'}</span>
        </h3>
        <p className="unit-duel">
          <span className={winner === 0 ? 'won' : ''}>
            {said(0)}
            {sides[0]}
          </span>
          <strong data-testid={legsTestId}>
            <span className={winner === 0 ? 'win' : undefined}>{legs ? (legs[0] ?? '—') : '—'}</span>
            {' - '}
            <span className={winner === 1 ? 'win' : undefined}>{legs ? (legs[1] ?? '—') : '—'}</span>
          </strong>
          <span className={winner === 1 ? 'won' : ''}>
            {said(1)}
            {sides[1]}
          </span>
        </p>
        {winner === -1 ? <p className="unit-draw small-text">引き分け</p> : null}
      </header>
    );
  }
  return (
    <header className={`unit-head${hidden ? ' visually-hidden' : ''}`}>
      <h3 className="game-block-head" data-testid={testId}>
        {label}
        {kind ? <span className="muted small-text">{kind}</span> : null}
        <span className={`tag state-${state === 'live' ? 'live' : 'official'}`}>{state === 'live' ? '進行中' : state === 'waiting' ? '終了 ・ 次を待っています' : '終了'}</span>
      </h3>
      <p className="unit-duel">
        <span className={winner === 0 ? 'won' : ''}>{sides[0]}</span>
        <strong data-testid={legsTestId}>{legs ? `${legs[0] ?? '—'} - ${legs[1] ?? '—'}` : '— - —'}</strong>
        <span className={winner === 1 ? 'won' : ''}>{sides[1]}</span>
      </p>
    </header>
  );
}

/** The match: both sides and the score of the whole match, with one line of context under it. */
export function MatchHead({ sides, score, scoreLabel, scoreTestId, note }: { sides: [ReactNode, ReactNode]; score: string; scoreLabel?: string; scoreTestId?: string; note?: ReactNode }): React.JSX.Element {
  return (
    <>
      <header className="focus-head">
        <span>{sides[0]}</span>
        <strong aria-label={scoreLabel} data-testid={scoreTestId}>
          {score}
        </strong>
        <span>{sides[1]}</span>
      </header>
      {note ? <p className="muted small-text center match-note">{note}</p> : null}
    </>
  );
}

/** Back to where the match was opened from, and its link. */
export function MatchBar({ backLabel, onBack, link, backTestId }: { backLabel: string; onBack: () => void; link?: string; backTestId?: string }): React.JSX.Element {
  return (
    <div className="match-center-bar">
      <button type="button" className="btn ghost small match-back" onClick={onBack} data-testid={backTestId}>
        <Icon name="chevronLeft" size={16} /> {backLabel}
      </button>
      {link ? <CopyLink url={link} label="リンクをコピー" /> : null}
    </div>
  );
}

/**
 * A league card followed as it is played (`match/live` by `tmid`, the live poller: 1.5 s, paused
 * while the page is hidden, stopped at the end of the card). `tmid` `null` = nothing to follow.
 * `accept`: which replies are of the card as it is now (others are dropped before they are shown,
 * used as `since` or taken as the end); every reply when absent.
 */
export function useCardLive(api: MatchesApi, tmid: string | null, accept?: (state: LiveState) => boolean): { live: LiveState | null; status: LiveStatus } {
  const [live, setLive] = useState<LiveState | null>(null);
  const [status, setStatus] = useState<LiveStatus>({ kind: 'idle' });
  // The latest judgement of which replies are the card's current ones (it follows the list), read
  // by the poller on each reply without starting it again.
  const acceptRef = useRef(accept);
  useEffect(() => {
    acceptRef.current = accept;
  });
  useEffect(() => {
    setLive(null);
    if (!tmid) return;
    const poller = new LivePoller(api, { tmid }, { maxRequests: 20_000, onState: setLive, onStatus: setStatus, accept: (state) => acceptRef.current?.(state) ?? true });
    const onVisibility = (): void => poller.setHidden(document.visibilityState === 'hidden');
    document.addEventListener('visibilitychange', onVisibility);
    poller.setHidden(document.visibilityState === 'hidden');
    poller.start();
    return () => {
      document.removeEventListener('visibilitychange', onVisibility);
      poller.stop();
    };
  }, [api, tmid]);
  return { live, status };
}
