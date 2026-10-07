/**
 * Name normalisation for identity matching (docs/N01_MASTER_DESIGN.md §3.3).
 *
 * Exact matching after a fixed, documented normalisation — and nothing looser. Width
 * variants (ＡＢＣ / ABC, full-width spaces), surrounding and repeated whitespace, and
 * Latin case are folded because n01 and a hand-typed roster routinely differ in exactly
 * those ways. Anything beyond that (edit distance, kana/kanji folding, dropped
 * punctuation) would be a guess, and a wrong guess silently merges two people.
 */
export function normalizeName(name: string): string {
  return name.normalize('NFKC').trim().replace(/\s+/gu, ' ').toLowerCase();
}

/** True when two names are the same after {@link normalizeName}. */
export function sameName(a: string, b: string): boolean {
  return normalizeName(a) === normalizeName(b);
}
