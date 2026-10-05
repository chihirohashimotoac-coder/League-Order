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

/** Shared presentational building blocks. Mobile-first: every control is ≥44px tall. */

export function Card({
  title,
  children,
  flush = false,
  action,
}: {
  title?: string;
  children: ReactNode;
  flush?: boolean;
  action?: ReactNode;
}): React.JSX.Element {
  return (
    <section className={flush ? 'card flush' : 'card'}>
      {title ? (
        <div className="row between" style={flush ? { padding: '12px 14px 0' } : undefined}>
          <h2 className="card-title" style={{ marginBottom: flush ? 8 : undefined }}>
            {title}
          </h2>
          {action}
        </div>
      ) : null}
      {children}
    </section>
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
      <button type="button" onClick={() => onChange(Math.max(min, value - 1))} aria-label={`${label}を1減らす`}>
        −
      </button>
      <span className="value">{format ? format(value) : value}</span>
      <button type="button" onClick={() => onChange(Math.min(max, value + 1))} aria-label={`${label}を1増やす`}>
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

export function Sheet({
  title,
  onClose,
  children,
  footer,
}: {
  title: string;
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
}): React.JSX.Element {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    ref.current?.focus();
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div
      className="sheet-backdrop"
      role="presentation"
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div className="sheet" role="dialog" aria-modal="true" aria-label={title} tabIndex={-1} ref={ref}>
        <div className="sheet-head">
          <h2>{title}</h2>
          <button type="button" className="btn icon ghost" onClick={onClose} aria-label="閉じる">
            ✕
          </button>
        </div>
        {children}
        {footer ? <div className="row" style={{ marginTop: 12 }}>{footer}</div> : null}
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
            className={destructive ? 'btn danger grow' : 'btn primary grow'}
            onClick={onConfirm}
          >
            {confirmLabel}
          </button>
        </>
      }
    >
      <p className="small-text muted" style={{ margin: 0 }}>
        {message}
      </p>
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
            {toast.message}
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

export function EmptyState({ children }: { children: ReactNode }): React.JSX.Element {
  return <div className="empty-state">{children}</div>;
}

export function Metric({
  label,
  value,
  tone,
}: {
  label: string;
  value: ReactNode;
  tone?: 'ok' | 'warn' | 'danger';
}): React.JSX.Element {
  const color =
    tone === 'ok' ? 'var(--ok)' : tone === 'warn' ? 'var(--warn)' : tone === 'danger' ? 'var(--danger)' : undefined;
  return (
    <div className="metric">
      <span className="k">{label}</span>
      <span className="v" style={color ? { color } : undefined}>
        {value}
      </span>
    </div>
  );
}

export function Bar({ value }: { value: number }): React.JSX.Element {
  const percent = Math.max(0, Math.min(100, Math.round(value * 100)));
  return (
    <div className="bar" role="img" aria-label={`${percent}%`}>
      <span style={{ width: `${percent}%` }} />
    </div>
  );
}
