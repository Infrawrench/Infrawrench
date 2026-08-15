/**
 * Tail-line quick-pick options for the Logs view/screen (web, desktop, and
 * mobile all render a control built from these).
 *
 * The control's options used to be the fixed presets alone, with the initial
 * state seeded from `capability.defaultTailLines`. When a plugin's default
 * wasn't one of the presets (DigitalOcean managed databases request 200,
 * which isn't in `[100, 500, 1000, 5000]`), the control displayed the first
 * preset while state — and the actual fetch — held the real default: a
 * control showing a value that isn't selected.
 *
 * The fix is to splice the capability default into the option list rather
 * than clamp state to the nearest preset. Clamping would silently override a
 * plugin's deliberate choice; showing it as an extra option keeps the
 * displayed selection and the requested value in sync without changing what
 * gets requested.
 */
export const TAIL_LINE_PRESETS: readonly number[] = [100, 500, 1000, 5000];

/**
 * Build the full set of tail-line options for a given capability default:
 * the fixed presets plus the default itself (if it isn't already one of
 * them), sorted ascending and de-duplicated.
 */
export function tailLineOptions(defaultTailLines: number | undefined | null): number[] {
  const options = new Set(TAIL_LINE_PRESETS);
  if (defaultTailLines != null && Number.isFinite(defaultTailLines) && defaultTailLines > 0) {
    options.add(defaultTailLines);
  }
  return [...options].sort((a, b) => a - b);
}
