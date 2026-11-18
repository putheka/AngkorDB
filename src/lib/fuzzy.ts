/** Where the query's characters were found in the text, and how good a match that is. */
export interface FuzzyMatch {
  score: number;
  /** Positions in the text of each query character, ascending. */
  indices: number[];
}

const SEPARATORS = new Set(["_", "-", ".", " ", "/"]);

/** Starting a word (`user_orders` → `o`, `userOrders` → `O`) counts for more than the middle of one. */
function boundaryBonus(text: string, index: number): number {
  if (index === 0) return 12;
  const prev = text.charAt(index - 1);
  const current = text.charAt(index);
  if (SEPARATORS.has(prev)) return 10;
  const isLower = (c: string) => c === c.toLowerCase() && c !== c.toUpperCase();
  const isUpper = (c: string) => c === c.toUpperCase() && c !== c.toLowerCase();
  return isLower(prev) && isUpper(current) ? 6 : 0;
}

/**
 * Subsequence match, case-insensitive: `usord` matches `user_orders`. `null` when the query's
 * characters don't all appear in order. Higher scores are better: exact and prefix matches first,
 * then matches that are tight and start on word boundaries.
 */
export function fuzzyMatch(query: string, text: string): FuzzyMatch | null {
  if (query.length === 0) return { score: 0, indices: [] };
  const q = query.toLowerCase();
  const lowered = text.toLowerCase();
  // A few characters change length when lowercased; positions would no longer line up.
  const t = lowered.length === text.length ? lowered : text;
  if (q.length > t.length) return null;

  // Forward: find the earliest place where every character has appeared in order...
  let found = 0;
  let end = -1;
  for (let i = 0; i < t.length && found < q.length; i++) {
    if (t.charAt(i) === q.charAt(found)) {
      found++;
      if (found === q.length) end = i;
    }
  }
  if (found < q.length) return null;

  // ...then walk back from there to take the tightest window that ends at it.
  const reversed: number[] = [];
  let want = q.length - 1;
  for (let i = end; i >= 0 && want >= 0; i--) {
    if (t.charAt(i) === q.charAt(want)) {
      reversed.push(i);
      want--;
    }
  }
  const indices = reversed.reverse();

  let score = 0;
  indices.forEach((index, n) => {
    score += 10 + boundaryBonus(text, index);
    const previous = indices[n - 1];
    if (previous !== undefined && index === previous + 1) score += 8;
  });
  const first = indices[0] ?? 0;
  const last = indices[indices.length - 1] ?? 0;
  score -= (last - first + 1 - q.length) * 1.5; // gaps inside the match
  score -= first * 0.5; // starting late
  score -= text.length * 0.05; // shorter names first
  if (t === q) score += 40;
  else if (t.startsWith(q)) score += 20;

  return { score, indices };
}
