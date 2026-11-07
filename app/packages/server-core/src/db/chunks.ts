/**
 * Most ids one statement should bind. postgres.js refuses a statement past 65,534
 * parameters, so anything that reads as one parameter per row is split well short of it,
 * leaving room for the rest of the statement.
 */
export const IDS_PER_STATEMENT = 10_000;

/** `rows` in order, split into arrays of at most `size`. */
export function chunksOf<T>(rows: readonly T[], size: number = IDS_PER_STATEMENT): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < rows.length; i += size) out.push(rows.slice(i, i + size));
  return out;
}
