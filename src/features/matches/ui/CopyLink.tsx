import { useState } from 'react';
import { Icon } from '../../../components/icons';

/**
 * Copies the address of what is shown (a card, a game). Where the clipboard is not available the
 * address is shown in a field to copy by hand — the link is never lost to a silent failure.
 */
export function CopyLink({ url, label = 'この対戦のリンクをコピー' }: { url: string; label?: string }): React.JSX.Element {
  const [state, setState] = useState<'idle' | 'copied' | 'manual'>('idle');
  const copy = async (): Promise<void> => {
    try {
      await navigator.clipboard.writeText(url);
      setState('copied');
    } catch {
      setState('manual');
    }
  };
  return (
    <span className="copy-link">
      <button type="button" className="btn small" onClick={() => void copy()} data-testid="copy-link">
        <Icon name="copy" size={16} /> {label}
      </button>
      <span className="small-text" role="status" aria-live="polite">
        {state === 'copied' ? 'コピーしました' : ''}
      </span>
      {state === 'manual' ? (
        <input className="copy-link-url" readOnly value={url} aria-label="対戦のリンク (選択してコピー)" onFocus={(event) => event.currentTarget.select()} />
      ) : null}
    </span>
  );
}
