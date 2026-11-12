/**
 * Short names for a closed selector. A league's seasons (or a tournament's events) often share a
 * long opening — 「JDO2026 ATDO OPEN メンズシングルス」 / 「… レディースシングルス」 — and a narrow selector
 * then cuts off exactly the part that tells them apart. When every title starts with the same
 * whole words, those words are dropped from the short name; the full title stays in the list of
 * options. Titles that are already short (a season name such as 「2026 ATDO 3rd」) are left as
 * they are, so the year and the season number are never removed.
 */
export const SHORT_TITLE_FROM = 17;

export function shortTitles(titles: readonly string[]): Map<string, string> {
  const out = new Map(titles.map((title) => [title, title]));
  const unique = [...new Set(titles)];
  if (unique.length < 2 || !unique.some((title) => title.length >= SHORT_TITLE_FROM)) return out;
  const words = unique.map((title) => title.trim().split(/\s+/u));
  let shared = 0;
  while (words.every((list) => list.length > shared + 1 && list[shared] === words[0][shared])) shared += 1;
  if (shared === 0) return out;
  for (const title of unique) out.set(title, title.trim().split(/\s+/u).slice(shared).join(' '));
  return out;
}
