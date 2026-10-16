/**
 * The command palette's matcher: small, dependency-free, and shared by the
 * server (`GET /search` ranks with it) and every client (the palette filters
 * quick actions, recents and the desktop's local resources with it), so a
 * query ranks the same way wherever it is answered.
 *
 * A query is split on whitespace and **every token must match**, each against
 * the best field it can find: "prod db" finds "db-primary" in the "Production"
 * account. A token matches a field as a contiguous substring (scored by where
 * it lands: whole field, prefix, word start, anywhere) or, failing that, as an
 * in-order subsequence ("cstrpt" finds "cost report"), which scores lower and
 * pays for every gap. The primary field (the object's name) counts double, so
 * a name hit outranks the same hit in a subtitle.
 */

/** Separators that start a new word for scoring purposes. */
const WORD_BREAK = /[\s\-_./:·()[\]]/;

function isWordStart(text: string, index: number): boolean {
  if (index === 0) return true;
  const prev = text[index - 1] ?? "";
  if (WORD_BREAK.test(prev)) return true;
  // camelCase boundary: "costReport" has a word starting at "R".
  const ch = text[index] ?? "";
  return prev === prev.toLowerCase() && ch !== ch.toLowerCase();
}

/**
 * Score one token against one field, or null when it does not match at all.
 * Higher is better; scores are only meaningful relative to each other.
 */
export function fuzzyTokenScore(token: string, field: string): number | null {
  if (!token) return 0;
  if (!field) return null;
  const t = token.toLowerCase();
  const f = field.toLowerCase();

  if (f === t) return 1000;
  const at = f.indexOf(t);
  if (at === 0) return 800 - Math.min(f.length - t.length, 100);
  if (at > 0) {
    // Prefer a hit at a word start anywhere in the field ("report" in
    // "Monthly report") over one buried mid-word ("port" in "report").
    let wordHit = -1;
    for (let i = at; i !== -1; i = f.indexOf(t, i + 1)) {
      if (isWordStart(field, i)) {
        wordHit = i;
        break;
      }
    }
    if (wordHit >= 0) return 600 - Math.min(wordHit, 100);
    return 400 - Math.min(at, 100);
  }

  // In-order subsequence. Greedy from the left, rewarding characters that
  // land on word starts or directly after the previous match.
  let score = 200;
  let fi = 0;
  let prevMatch = -2;
  for (let ti = 0; ti < t.length; ti++) {
    const ch = t[ti];
    let found = -1;
    for (let j = fi; j < f.length; j++) {
      if (f[j] === ch) {
        found = j;
        break;
      }
    }
    if (found === -1) return null;
    if (found === prevMatch + 1) score += 6;
    else if (isWordStart(field, found)) score += 4;
    else score -= Math.min(found - fi, 8);
    prevMatch = found;
    fi = found + 1;
  }
  return Math.max(score, 1);
}

/**
 * Score a query against an object's fields. `primary` is its name; `secondary`
 * are the supporting labels (kind, account, folder, subtitle). Returns null
 * when any token matches no field; an empty query scores 0 (everything
 * matches, in its incoming order).
 */
export function fuzzyScore(
  query: string,
  primary: string,
  secondary: readonly (string | null | undefined)[] = [],
): number | null {
  const tokens = query.trim().split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return 0;
  let total = 0;
  for (const token of tokens) {
    let best: number | null = null;
    const onName = fuzzyTokenScore(token, primary);
    if (onName !== null) best = onName * 2;
    for (const field of secondary) {
      if (!field) continue;
      const s = fuzzyTokenScore(token, field);
      if (s !== null && (best === null || s > best)) best = s;
    }
    if (best === null) return null;
    total += best;
  }
  return total;
}

/**
 * Filter and rank a list by `fuzzyScore`, best first, keeping the incoming
 * order for ties (and for an empty query, which matches everything).
 */
export function fuzzyFilter<T>(
  items: readonly T[],
  query: string,
  fields: (item: T) => { primary: string; secondary?: readonly (string | null | undefined)[] },
): T[] {
  if (!query.trim()) return [...items];
  const scored: { item: T; score: number; index: number }[] = [];
  items.forEach((item, index) => {
    const f = fields(item);
    const score = fuzzyScore(query, f.primary, f.secondary ?? []);
    if (score !== null) scored.push({ item, score, index });
  });
  scored.sort((a, b) => b.score - a.score || a.index - b.index);
  return scored.map((s) => s.item);
}
