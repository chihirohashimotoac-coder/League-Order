/**
 * Short names for a closed selector. A league's seasons (or a tournament's events) often share a
 * long opening — 「JDO2026 ATDO OPEN メンズシングルス」 / 「… レディースシングルス」 — and a narrow selector
 * then cuts off exactly the part that tells them apart. Whole words that every title has are
 * dropped from the short name; the full title stays in the list of
 * options. Titles that are already short (a season name such as 「2026 ATDO 3rd」) are left as
 * they are, so the year and the season number are never removed.
 */
export const SHORT_TITLE_FROM = 17;

export function shortTitles(titles: readonly string[]): Map<string, string> {
  const out = new Map(titles.map((title) => [title, title]));
  const unique = [...new Set(titles)];
  if (unique.length < 2 || !unique.some((title) => title.length >= SHORT_TITLE_FROM)) return out;
  const words = unique.map((title) => title.trim().split(/\s+/u));
  // Words every title has (wherever they stand) say nothing about which one this is.
  const shared = new Set(words[0].filter((word) => words.every((list) => list.includes(word))));
  if (shared.size === 0) return out;
  unique.forEach((title, index) => {
    const rest = words[index].filter((word) => !shared.has(word));
    if (rest.length > 0) out.set(title, rest.join(' '));
  });
  return out;
}
