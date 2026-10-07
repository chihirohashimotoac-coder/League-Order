import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import type { DartsDiscipline, OrderLifecycleState } from '../domain/types';
import { DARTS_DISCIPLINE_TAGS } from '../domain/types';
import { formatPpr } from '../domain/players/strength';
import { Icon, type IconName } from './icons';

/**
 * Shared presentational building blocks (Arena Scoreboard design system).
 *
 * Mobile-first: every control is at least `--tap-target` (44px) in both directions.
 * Colour is never the only carrier of meaning — status components always pair it with
 * an icon and a text label.
 */

export function Card({
  title,
  kicker,
  children,
  flush = false,
  action,
  className,
}: {
  title?: string;
  /** Small uppercase English accent shown before the title. */
  kicker?: string;
  children: ReactNode;
  flush?: boolean;
  action?: ReactNode;
  className?: string;
}): React.JSX.Element {
  const classes = ['card', flush ? 'flush' : '', className ?? ''].filter(Boolean).join(' ');
  return (
    <section className={classes}>
      {title ? (
        <div className="card-head">
          <h2 className="card-title">
            {kicker ? (
              <span className="kicker" aria-hidden="true">
                {kicker}
              </span>
            ) : null}
            {title}
          </h2>
          {action}
        </div>
      ) : null}
      {children}
    </section>
  );
}

/**
 * Section heading with an English scoreboard accent.
 *
 * The accent is `aria-hidden`, so the heading's accessible name is the Japanese title
 * alone — a screen reader does not read "ORDER オーダー".
 */
export function SectionHeader({
  title,
  kicker,
  index,
  action,
  id,
}: {
  title: string;
  kicker?: string;
  /** Step number for numbered flows (SETUP). */
  index?: number;
  action?: ReactNode;
  id?: string;
}): React.JSX.Element {
  return (
    <div className="section-head">
      <h2 className="section-title" id={id}>
        {index !== undefined ? (
          <span className="section-index" aria-hidden="true">
            {String(index).padStart(2, '0')}
          </span>
        ) : null}
        {kicker ? (
          <span className="kicker" aria-hidden="true">
            {kicker}
          </span>
        ) : null}
        <span className="section-name">{title}</span>
      </h2>
      {action}
    </div>
  );
}

export function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: ReactNode;
}): React.JSX.Element {
  return (
    <label className="field">
      <span>{label}</span>
      {children}
      {hint ? <span className="hint">{hint}</span> : null}
    </label>
  );
}

export function Stepper({
  value,
  min = 0,
  max = 99,
  onChange,
  format,
  label,
}: {
  value: number;
  min?: number;
  max?: number;
  onChange: (next: number) => void;
  format?: (value: number) => string;
  label: string;
}): React.JSX.Element {
  return (
    <span className="stepper" role="group" aria-label={label}>
      <button
        type="button"
        onClick={() => onChange(Math.max(min, value - 1))}
        disabled={value <= min}
        aria-label={`${label}を1減らす`}
      >
        −
      </button>
      <span className="value">{format ? format(value) : value}</span>
      <button
        type="button"
        onClick={() => onChange(Math.min(max, value + 1))}
        disabled={value >= max}
        aria-label={`${label}を1増やす`}
      >
        ＋
      </button>
    </span>
  );
}

export function Chip({
  active,
  onClick,
  children,
  tone = 'accent',
  title,
}: {
  active: boolean;
  onClick: () => void;
  children: ReactNode;
  tone?: 'accent' | 'danger';
  title?: string;
}): React.JSX.Element {
  return (
    <button
      type="button"
      className={`chip${active && tone === 'danger' ? ' danger-on' : ''}`}
      aria-pressed={active}
      onClick={onClick}
      title={title}
    >
      {children}
    </button>
  );
}

/** A pill-shaped single-choice switch. Uses `aria-pressed` buttons. */
export function Segmented<T extends string>({
  label,
  options,
  value,
  onChange,
  showHint = true,
}: {
  label: string;
  options: readonly { key: T; label: string; hint?: string }[];
  value: T;
  onChange: (next: T) => void;
  showHint?: boolean;
}): React.JSX.Element {
  const active = options.find((option) => option.key === value);
  return (
    <div className="field">
      <span>{label}</span>
      <div className="segmented" role="group" aria-label={label}>
        {options.map((option) => (
          <button
            type="button"
            key={option.key}
            aria-pressed={value === option.key}
            onClick={() => onChange(option.key)}
          >
            {option.label}
          </button>
        ))}
      </div>
      {showHint && active?.hint ? <span className="hint">{active.hint}</span> : null}
    </div>
  );
}

/**
 * Bottom sheet dialog: sticky header, scrolling body, sticky footer.
 *
 * `onClose` is read through a ref so the mount effect runs exactly once. Callers pass
 * inline arrows, and re-running the effect on every parent render used to call
 * `focus()` on the sheet again — stealing focus from whatever field inside it the
 * captain was typing into.
 */
export function Sheet({
  title,
  onClose,
  children,
  footer,
  className,
}: {
  title: string;
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
  className?: string;
}): React.JSX.Element {
  const ref = useRef<HTMLDivElement>(null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  // Where the current press started and ended. A `click` is dispatched on the nearest
  // common ancestor of the press and release targets, so a text selection dragged from an
  // input out onto the backdrop arrives as a click whose target *is* the backdrop. Only a
  // press that both started and ended on the backdrop itself is a request to dismiss.
  const pressStartedOnBackdrop = useRef(false);
  const pressEndedOnBackdrop = useRef(false);

  useEffect(() => {
    const opener = document.activeElement as HTMLElement | null;
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') closeRef.current();
    };
    document.addEventListener('keydown', onKey);
    ref.current?.focus();
    return () => {
      document.removeEventListener('keydown', onKey);
      // Hand focus back to the control that opened the sheet, if it is still there.
      if (opener && opener.isConnected) opener.focus({ preventScroll: true });
    };
  }, []);

  return (
    <div
      className="sheet-backdrop"
      role="presentation"
      // Nothing here calls preventDefault: native selection, copy / cut / paste and the
      // context menu inside the sheet behave exactly as they do anywhere else.
      onPointerDown={(event) => {
        pressStartedOnBackdrop.current = event.target === event.currentTarget;
        pressEndedOnBackdrop.current = false;
      }}
      onPointerUp={(event) => {
        pressEndedOnBackdrop.current = event.target === event.currentTarget;
      }}
      onPointerCancel={() => {
        pressStartedOnBackdrop.current = false;
        pressEndedOnBackdrop.current = false;
      }}
      onClick={(event) => {
        const dismiss =
          event.target === event.currentTarget &&
          pressStartedOnBackdrop.current &&
          pressEndedOnBackdrop.current;
        pressStartedOnBackdrop.current = false;
        pressEndedOnBackdrop.current = false;
        if (dismiss) onClose();
      }}
    >
      <div
        className={className ? `sheet ${className}` : 'sheet'}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        tabIndex={-1}
        ref={ref}
      >
        <div className="sheet-head">
          <span className="sheet-grabber" aria-hidden="true" />
          <h2>{title}</h2>
          <button type="button" className="btn icon ghost sheet-close" onClick={onClose} aria-label="閉じる">
            <Icon name="close" />
          </button>
        </div>
        <div className="sheet-body">{children}</div>
        {footer ? <div className="sheet-foot">{footer}</div> : null}
      </div>
    </div>
  );
}

export function ConfirmDialog({
  title,
  message,
  confirmLabel = '実行',
  destructive = false,
  onConfirm,
  onCancel,
}: {
  title: string;
  message: string;
  confirmLabel?: string;
  destructive?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}): React.JSX.Element {
  return (
    <Sheet
      title={title}
      onClose={onCancel}
      footer={
        <>
          <button type="button" className="btn grow" onClick={onCancel}>
            キャンセル
          </button>
          <button
            type="button"
            className={destructive ? 'btn danger-solid grow' : 'btn primary grow'}
            onClick={onConfirm}
          >
            {confirmLabel}
          </button>
        </>
      }
    >
      <p className="body-text">{message}</p>
    </Sheet>
  );
}

// ------------------------------------------------------------------- toasts

export interface Toast {
  id: number;
  message: string;
  tone: 'ok' | 'error' | 'plain';
}

interface ToastApi {
  show(message: string, tone?: Toast['tone']): void;
}

const ToastContext = createContext<ToastApi | null>(null);

/** Never let notifications bury the screen they are describing. */
const MAX_VISIBLE_TOASTS = 3;

const TOAST_ICONS: Record<Toast['tone'], IconName> = {
  ok: 'check',
  error: 'alert',
  plain: 'info',
};

export function ToastProvider({ children }: { children: ReactNode }): React.JSX.Element {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const nextId = useRef(1);

  const show = useCallback((message: string, tone: Toast['tone'] = 'plain') => {
    const id = nextId.current;
    nextId.current += 1;
    // Keep only the most recent few: a burst of actions must not cover the controls the
    // user is still working with.
    setToasts((current) => [...current, { id, message, tone }].slice(-MAX_VISIBLE_TOASTS));
    setTimeout(() => setToasts((current) => current.filter((toast) => toast.id !== id)), 3200);
  }, []);

  const api = useMemo(() => ({ show }), [show]);

  return (
    <ToastContext.Provider value={api}>
      {children}
      <div className="toast-stack" role="status" aria-live="polite">
        {toasts.map((toast) => (
          <div key={toast.id} className={`toast ${toast.tone}`}>
            <Icon name={TOAST_ICONS[toast.tone]} size={18} />
            <span>{toast.message}</span>
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}

export function useToast(): ToastApi {
  const api = useContext(ToastContext);
  // A missing provider must not crash a page; silently dropping a toast is acceptable.
  return api ?? { show: () => undefined };
}

// ------------------------------------------------------------- status & data

export function EmptyState({
  kicker,
  title,
  icon = 'target',
  children,
  action,
}: {
  kicker?: string;
  title?: string;
  icon?: IconName;
  children?: ReactNode;
  action?: ReactNode;
}): React.JSX.Element {
  return (
    <div className="empty-state">
      <span className="empty-icon" aria-hidden="true">
        <Icon name={icon} size={28} />
      </span>
      {kicker ? <span className="kicker">{kicker}</span> : null}
      {title ? <strong className="empty-title">{title}</strong> : null}
      {children ? <p className="empty-body">{children}</p> : null}
      {action ? <div className="empty-action">{action}</div> : null}
    </div>
  );
}

export function Metric({
  label,
  value,
  tone,
  unit,
}: {
  label: string;
  value: ReactNode;
  tone?: 'ok' | 'warn' | 'danger';
  unit?: string;
}): React.JSX.Element {
  return (
    <div className={tone ? `metric tone-${tone}` : 'metric'}>
      <span className="k">{label}</span>
      <span className="v">
        {value}
        {unit ? <small>{unit}</small> : null}
      </span>
    </div>
  );
}

export function Bar({ value, tone }: { value: number; tone?: 'muted' }): React.JSX.Element {
  const percent = Math.max(0, Math.min(100, Math.round(value * 100)));
  return (
    <div className={tone ? `bar ${tone}` : 'bar'} role="img" aria-label={`${percent}%`}>
      <span style={{ width: `${percent}%` }} />
    </div>
  );
}

/** Lifecycle presentation shared by the header, the banner, history and sharing. */
export const STATE_META: Record<
  OrderLifecycleState,
  { tone: 'draft' | 'finalized' | 'updated'; tag: string; icon: IconName }
> = {
  DRAFT: { tone: 'draft', tag: 'DRAFT', icon: 'edit' },
  FINALIZED: { tone: 'finalized', tag: 'FINALIZED', icon: 'checkCircle' },
  UPDATED: { tone: 'updated', tag: 'UPDATED', icon: 'alert' },
};

/** Icon + text status pill. Never colour alone. */
export function StatusBadge({
  tone,
  icon,
  children,
  title,
}: {
  tone: 'draft' | 'finalized' | 'updated' | 'danger' | 'lock' | 'season' | 'accent' | 'neutral';
  icon?: IconName;
  children: ReactNode;
  title?: string;
}): React.JSX.Element {
  return (
    <span className={`status status-${tone}`} title={title}>
      {icon ? <Icon name={icon} size={14} strokeWidth={2.4} /> : null}
      <span>{children}</span>
    </span>
  );
}

/** `Rt.14`, `Rt.12.5`, or `Rt. —` when unknown (never "0"). */
export function formatRating(rating: number | null | undefined): string {
  if (rating === null || rating === undefined || !Number.isFinite(rating)) return 'Rt. —';
  const text = Number.isInteger(rating) ? String(rating) : rating.toFixed(1);
  return `Rt.${text}`;
}

/**
 * One-line strength summary for a player: `Rt.14 · PPR 68.4`, only the value that is
 * known when the other is not, or `戦力データ未設定` when neither is — never "0".
 */
export function formatStrengthLine(player: { rating: number | null; ppr?: number | null }): string {
  const parts: string[] = [];
  if (player.rating !== null && Number.isFinite(player.rating)) parts.push(formatRating(player.rating));
  if (player.ppr !== null && player.ppr !== undefined && Number.isFinite(player.ppr)) {
    parts.push(formatPpr(player.ppr));
  }
  return parts.length > 0 ? parts.join(' · ') : '戦力データ未設定';
}

/** Discipline badge: `SOFT` / `STEEL` / `未設定`, with an icon so colour is never alone. */
export function DisciplineBadge({ discipline }: { discipline: DartsDiscipline }): React.JSX.Element {
  return (
    <span className={`discipline-badge d-${discipline.toLowerCase()}`}>
      <Icon name="target" size={12} strokeWidth={2.6} />
      {DARTS_DISCIPLINE_TAGS[discipline]}
    </span>
  );
}
