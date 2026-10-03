/**
 * Postgres unique-index conflict (SQLSTATE 23505), however the driver in use
 * chose to surface it. drizzle wraps the driver's error in its own (the
 * original lands on `cause`), so the code is looked for along the whole
 * `cause` chain rather than only on the error that was thrown.
 */
export function isUniqueViolation(error: unknown): boolean {
  let current: unknown = error;
  // Bounded so a cyclic `cause` chain cannot spin forever.
  for (let depth = 0; depth < 8; depth++) {
    if (typeof current !== "object" || current === null) return false;
    if ((current as { code?: unknown }).code === "23505") return true;
    current = (current as { cause?: unknown }).cause;
  }
  return false;
}
