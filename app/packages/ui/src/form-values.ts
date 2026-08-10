/**
 * Shared guards for turning what a user typed into what gets stored.
 *
 * Small, but not arbitrary: every one of these encodes a case where the
 * obvious coercion writes a *setting the user never chose*. They live in one
 * module so "cleared" and "half-typed" mean the same thing on every form,
 * rather than each section deciding for itself and one of them deciding
 * differently.
 */

/**
 * A number typed into an `<input type="number">`, or `null` when there is
 * nothing the user has actually chosen yet.
 *
 * `Number("")` is `0` and `Number("-")` is `NaN`, so coercing the raw value
 * writes a setting nobody picked: clearing a retention field to retype it
 * would silently store "restate 0 days", and a half-typed value would store
 * `NaN` and travel into the request body. Both cases mean "keep what is there
 * and wait for the rest of the keystrokes".
 */
export function parseNumericInputValue(raw: string): number | null {
  if (raw.trim() === "") return null;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : null;
}
