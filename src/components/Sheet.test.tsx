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
