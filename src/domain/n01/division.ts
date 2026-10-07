/**
 * How a division is named on screen. n01 titles are often a bare letter ("A"), shown
 * as "A Division"; a title that already says what it is ("Division 2" — the fallback
 * when n01 gives no `lg_title` — or "1部") is shown as it is.
 */
export function divisionLabel(title: string): string {
  return /division|ディビジョン|部$/iu.test(title) ? title : `${title} Division`;
}
