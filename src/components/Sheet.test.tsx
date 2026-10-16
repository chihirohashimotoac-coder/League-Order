import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { Sheet } from './ui';

afterEach(cleanup);

/**
 * A click lands on the common ancestor of the press and the release, so a text selection
 * dragged out of an input arrives at the backdrop as a click whose target is the backdrop.
 * Only a press that starts *and* ends on the backdrop may close the sheet.
 */
function renderSheet() {
  const onClose = vi.fn();
  const view = render(
    <Sheet title="テスト" onClose={onClose}>
      <input aria-label="名前" defaultValue="ちひろ" />
      <textarea aria-label="メモ" defaultValue="長いメモ" />
    </Sheet>,
  );
  const backdrop = view.container.ownerDocument.querySelector('.sheet-backdrop') as HTMLElement;
  return { onClose, backdrop };
}

describe('Sheet dismissal', () => {
  it('stays open when a selection drag starts in an input and ends on the backdrop', () => {
    const { onClose, backdrop } = renderSheet();
    const input = screen.getByLabelText('名前');
    fireEvent.pointerDown(input);
    fireEvent.pointerUp(backdrop);
    fireEvent.click(backdrop);
    expect(onClose).not.toHaveBeenCalled();
  });

  it('stays open for the same drag out of a textarea', () => {
    const { onClose, backdrop } = renderSheet();
    fireEvent.pointerDown(screen.getByLabelText('メモ'));
    fireEvent.pointerUp(backdrop);
    fireEvent.click(backdrop);
    expect(onClose).not.toHaveBeenCalled();
  });

  it('stays open when a press starts on the backdrop and ends inside the sheet', () => {
    const { onClose, backdrop } = renderSheet();
    fireEvent.pointerDown(backdrop);
    fireEvent.pointerUp(screen.getByLabelText('名前'));
    fireEvent.click(backdrop);
    expect(onClose).not.toHaveBeenCalled();
  });

  it('stays open after a cancelled touch (e.g. the OS took over for a selection handle)', () => {
    const { onClose, backdrop } = renderSheet();
    fireEvent.pointerDown(backdrop);
    fireEvent.pointerCancel(backdrop);
    fireEvent.click(backdrop);
    expect(onClose).not.toHaveBeenCalled();
  });

  it('closes on a genuine backdrop tap', () => {
    const { onClose, backdrop } = renderSheet();
    fireEvent.pointerDown(backdrop);
    fireEvent.pointerUp(backdrop);
    fireEvent.click(backdrop);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('closes on Escape and on the close button', () => {
    const { onClose } = renderSheet();
    fireEvent.keyDown(document, { key: 'Escape' });
    fireEvent.click(screen.getByRole('button', { name: '閉じる' }));
    expect(onClose).toHaveBeenCalledTimes(2);
  });

  it('does not cancel copy, cut, paste or the context menu inside the sheet', () => {
    renderSheet();
    const input = screen.getByLabelText('名前');
    for (const fire of [fireEvent.copy, fireEvent.cut, fireEvent.paste, fireEvent.contextMenu]) {
      // fireEvent returns false when a handler called preventDefault().
      expect(fire(input)).toBe(true);
    }
  });
});

describe('Sheet focus', () => {
  function renderWithPage() {
    const view = render(
      <>
        <button type="button">背後のボタン</button>
        <Sheet title="メニュー" onClose={() => undefined} variant="drawer">
          <button type="button">最初</button>
          <button type="button">最後</button>
        </Sheet>
      </>,
    );
    return { behind: screen.getByRole('button', { name: '背後のボタン' }), view };
  }

  it('wraps Shift+Tab out of the sheet to its last control, never the page behind', () => {
    const { behind } = renderWithPage();
    fireEvent.keyDown(document, { key: 'Tab', shiftKey: true });
    behind.focus();
    expect(document.activeElement).toBe(screen.getByRole('button', { name: '最後' }));
  });

  it('wraps Tab out of the sheet to its first control', () => {
    const { behind } = renderWithPage();
    fireEvent.keyDown(document, { key: 'Tab' });
    behind.focus();
    // The header's close button is the first control of every sheet.
    expect(document.activeElement).toBe(screen.getByRole('button', { name: '閉じる' }));
  });

  it('Tab on the last control goes to the first, Shift+Tab on the first to the last', () => {
    renderWithPage();
    const last = screen.getByRole('button', { name: '最後' });
    const close = screen.getByRole('button', { name: '閉じる' });
    last.focus();
    fireEvent.keyDown(last, { key: 'Tab' });
    expect(document.activeElement).toBe(close);
    fireEvent.keyDown(close, { key: 'Tab', shiftKey: true });
    expect(document.activeElement).toBe(last);
  });

  it('lets focus go anywhere again once the sheet is closed', () => {
    const { behind, view } = renderWithPage();
    view.unmount();
    render(<button type="button">背後のボタン</button>);
    const again = screen.getByRole('button', { name: '背後のボタン' });
    again.focus();
    expect(document.activeElement).toBe(again);
    expect(behind.isConnected).toBe(false);
  });
});
