import type { CSSProperties } from 'react';

/**
 * Motion and infographic primitives.
 *
 * Every effect here is CSS keyframes on elements whose final state is the normal,
 * un-animated layout: the text content and the numbers in the DOM are always the final
 * values (copy, search, screen readers and tests read the real text), and
 * `prefers-reduced-motion` collapses every animation to its end state in one rule.
 * Nothing here computes anything — the values come in already calculated.
 */

/** Longest stagger, so long strings never keep the last letters hidden for long. */
const MAX_STAGGER = 24;

/**
 * Kinetic typography: each character rises into place one after another.
 *
 * The animated letters are decoration (`aria-hidden`); the same text sits beside them,
 * visually hidden, as the accessible name.
 *
 * Words made only of ASCII are kept unbreakable (a team name like "KALAVINKA" never
 * breaks mid-word because its letters became separate boxes); Japanese keeps breaking
 * between any two characters as it normally does.
 */
export function KineticText({
  text,
  className,
  delay = 0,
  step = 26,
  variant = 'rise',
}: {
  text: string;
  className?: string;
  /** Milliseconds before the first character. */
  delay?: number;
  /** Milliseconds between characters. */
  step?: number;
  variant?: 'rise' | 'drop' | 'track';
}): React.JSX.Element {
  let index = 0;
  const parts = text.split(/(\s+)/);
  const style = { '--k-delay': `${delay}ms`, '--k-step': `${step}ms` } as CSSProperties;
  return (
    <span className={['kinetic', `k-${variant}`, className ?? ''].filter(Boolean).join(' ')} style={style}>
      {/* What assistive technology reads (and what is copied): the text in one piece.
          Letters in separate boxes would otherwise be named "k a l a v i n k a". */}
      <span className="visually-hidden">{text}</span>
      <span className="k-visual" aria-hidden="true">
        {parts.map((part, partIndex) => {
          if (part === '') return null;
          if (/^\s+$/.test(part)) return part;
          // eslint-disable-next-line no-control-regex
          const ascii = /^[\x00-\x7F]+$/.test(part);
          return (
            <span key={partIndex} className={ascii ? 'k-word nowrap' : 'k-word'}>
              {Array.from(part).map((char, charIndex) => {
                const i = Math.min(index, MAX_STAGGER);
                index += 1;
                return (
                  <span key={charIndex} className="k-char" style={{ '--i': i } as CSSProperties}>
                    {char}
                  </span>
                );
              })}
            </span>
          );
        })}
      </span>
    </span>
  );
}

/**
 * A number whose digits roll up into place, odometer style; a changed value rolls in
 * again. As with {@link KineticText}, the value is read and copied in one piece.
 */
export function RollingNumber({ value, className }: { value: number | string; className?: string }): React.JSX.Element {
  const text = String(value);
  return (
    <span className={className ? `roll-num ${className}` : 'roll-num'}>
      <span className="visually-hidden">{text}</span>
      <span className="k-visual" aria-hidden="true">
        {Array.from(text).map((char, index) => (
          // Keyed by the whole value: a new value remounts the digits and rolls again.
          <span key={`${text}:${index}`} className="roll-digit">
            <span style={{ '--i': index } as CSSProperties}>{char}</span>
          </span>
        ))}
      </span>
    </span>
  );
}

/**
 * Ring gauge (0–1) drawn with one SVG stroke; the arc sweeps from empty to its value.
 * The label beside it carries the meaning, the ring is decoration with a text equivalent.
 */
export function RingGauge({
  value,
  label,
  display,
  size = 92,
  tone = 'accent',
}: {
  value: number;
  label: string;
  /** Centre text, e.g. `60%`. */
  display: string;
  size?: number;
  tone?: 'accent' | 'success' | 'season';
}): React.JSX.Element {
  const clamped = Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : 0;
  const radius = 40;
  const circumference = 2 * Math.PI * radius;
  const style = {
    '--ring-c': circumference.toFixed(2),
    '--ring-offset': (circumference * (1 - clamped)).toFixed(2),
  } as CSSProperties;
  return (
    <figure className={`ring-gauge tone-${tone}`} style={{ width: size }}>
      <svg viewBox="0 0 100 100" width={size} height={size} role="img" aria-label={`${label} ${display}`}>
        <circle className="ring-track" cx="50" cy="50" r={radius} />
        <circle className="ring-value" cx="50" cy="50" r={radius} style={style} transform="rotate(-90 50 50)" />
      </svg>
      <span className="ring-center" aria-hidden="true">
        {display}
      </span>
      <figcaption>{label}</figcaption>
    </figure>
  );
}

export interface BarDatum {
  key: string;
  label: string;
  /** 0–1 share of the longest bar. */
  ratio: number;
  /** The value as text, shown at the end of the bar. */
  display: string;
  muted?: boolean;
}

/**
 * Horizontal bar chart as a plain list: every bar has its label and value in text, so the
 * chart reads the same with or without the graphics. Bars grow in one after another.
 */
export function BarChart({ data, label }: { data: readonly BarDatum[]; label: string }): React.JSX.Element {
  return (
    <ul className="bar-chart" aria-label={label}>
      {data.map((datum, index) => (
        <li key={datum.key} style={{ '--i': Math.min(index, MAX_STAGGER) } as CSSProperties}>
          <span className="bc-label">{datum.label}</span>
          <span className="bc-track" aria-hidden="true">
            <span
              className={datum.muted ? 'bc-fill muted' : 'bc-fill'}
              style={{ width: `${Math.round(Math.max(0, Math.min(1, datum.ratio)) * 100)}%` }}
            />
          </span>
          <span className="bc-value num">{datum.display}</span>
        </li>
      ))}
    </ul>
  );
}

/**
 * A segmented proportion bar (e.g. finalized / draft): segments widen in turn, and a
 * legend under it carries every number in text.
 */
export function StackedBar({
  segments,
  label,
}: {
  segments: readonly { key: string; label: string; value: number; tone: 'success' | 'draft' | 'accent' | 'season' }[];
  label: string;
}): React.JSX.Element {
  const total = segments.reduce((sum, segment) => sum + Math.max(0, segment.value), 0);
  return (
    <div className="stacked">
      <div className="stacked-bar" aria-hidden="true">
        {segments.map((segment, index) =>
          segment.value > 0 ? (
            <span
              key={segment.key}
              className={`seg tone-${segment.tone}`}
              style={{ flexGrow: segment.value, '--i': index } as CSSProperties}
            />
          ) : null,
        )}
      </div>
      <ul className="stacked-legend" aria-label={label}>
        {segments.map((segment) => (
          <li key={segment.key}>
            <span className={`dot tone-${segment.tone}`} aria-hidden="true" />
            {segment.label}
            <strong className="num">{segment.value}</strong>
            {total > 0 ? <span className="muted">({Math.round((segment.value / total) * 100)}%)</span> : null}
          </li>
        ))}
      </ul>
    </div>
  );
}
