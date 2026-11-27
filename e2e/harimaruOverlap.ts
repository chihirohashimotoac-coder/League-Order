/**
 * ハリマルの見えている部分が重なってはいけないものの一覧 (page.evaluate に渡して、ページの中で実行する。自己完結)。
 *
 * - いつでも重ならない (hard): 入力欄・選択・編集できる要素・スライダーなど、固定ヘッダー・下部ナビ・操作バー、
 *   得点などの重要な表示 (class に score を含む要素・n01 の得点表)、キーボードのフォーカスの輪の出ている要素。
 * - 立っている・待っている・眠っている間 (登場・小ジャンプ・飛び降り・よじ登りの途中でないとき) は、文字にも重ならない。
 *   移動の途中は、文字の一部に短くかぶってよい (かぶる時間の上限は経路の安全判定の単体テストで確かめる)。
 * - ボタン・カード・枠などのデザインには、体が重なってよい (クリック・タップは下の要素に届く)。
 *
 * 文字にかぶっている (移動中で許した) ものは `pass:` を付けて返す (呼び出し側で長くかぶり続けないことを確かめる)。
 */
export function harimaruOverlaps(): string[] {
  const el = document.querySelector<HTMLElement>('[data-testid="harimaru"]');
  if (!el) return ['no sprite'];
  const r = el.getBoundingClientRect();
  // カードの裏に沈んで切り取られている部分 (clip-path の下側) は描かれていないので数えない。
  const clip = /inset\(0(?:px)? 0(?:px)? ([\d.]+)px/.exec(el.style.clipPath || '');
  const clipped = clip ? parseFloat(clip[1]) : 0;
  const box = { left: r.left + 2.5, right: r.right - 2.5, top: r.top + 0.5, bottom: r.bottom - 0.5 - clipped };
  // 固定ヘッダー・下部ナビの裏 (画面の端から入る途中) の部分は描かれていないので数えない。
  box.top = Math.max(box.top, document.querySelector('.app-header')?.getBoundingClientRect().bottom ?? -Infinity);
  box.bottom = Math.min(box.bottom, document.querySelector('.tab-bar')?.getBoundingClientRect().top ?? Infinity);
  // 画面の左右の外の部分も描かれない。
  box.left = Math.max(box.left, 0);
  box.right = Math.min(box.right, document.documentElement.clientWidth);
  if (box.bottom <= box.top || box.right <= box.left) return [];
  const hit = (q: { left: number; right: number; top: number; bottom: number }): boolean =>
    q.right > box.left && q.left < box.right && q.bottom > box.top && q.top < box.bottom;
  const hard =
    'input:not([type="button"]):not([type="submit"]):not([type="reset"]), select, textarea, [contenteditable=""], [contenteditable="true"], ' +
    '[role="textbox"], [role="combobox"], [role="slider"], [role="spinbutton"], .app-header, .tab-bar, .action-bar, [class*="score"], .n01-sheet, .scoreboard';
  const passing = ['enter', 'hopJump', 'drop', 'wallClimb'].includes(el.dataset.action ?? '');
  const found: string[] = [];
  for (const node of Array.from(document.querySelectorAll('.app *'))) {
    const rect = node.getBoundingClientRect();
    if (node === document.activeElement && node.matches(':focus-visible')) {
      const ring = { left: rect.left - 4, right: rect.right + 4, top: rect.top - 4, bottom: rect.bottom + 4 };
      if (hit(ring)) found.push(`FOCUS:${node.tagName}.${node.className}`);
    }
    if (!hit(rect)) continue;
    if (node.matches(hard)) found.push(`${node.tagName}.${node.className}`);
    for (const child of Array.from(node.childNodes)) {
      if (child.nodeType !== 3 || !child.textContent?.trim()) continue;
      const range = document.createRange();
      range.selectNodeContents(child);
      if (Array.from(range.getClientRects()).some(hit)) found.push(`${passing ? 'pass:' : ''}TEXT:${child.textContent.trim().slice(0, 16)}`);
    }
  }
  return found;
}

/** 重なってはいけないもの (移動中に許した文字のかぶり `pass:` を除く)。 */
export const blocking = (found: readonly string[]): string[] => found.filter((f) => !f.startsWith('pass:'));
