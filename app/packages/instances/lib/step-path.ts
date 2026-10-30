/**
 * SVG paths for a step series (a price holds until it changes), shared by the
 * page's charts and the OG image.
 *
 * `null` means "not offered from then on". When a price comes back after a
 * gap, the two sides are joined by a dashed connector that holds the last
 * price across the gap and steps to the new one, so a series AWS drops for a
 * month at a time (p4d.24xlarge's $0 months) reads as one line rather than
 * scattered fragments. A gap that never ends (retired) just stops the line.
 */
export interface StepPaths {
  /** Where the series had a price. */
  solid: string;
  /** Across gaps that a later price closes. */
  dashed: string;
  /** Where the price became something it was not before, ignoring gaps. */
  dots: { at: number; value: number }[];
  /** Whether there are no gaps, so an area under `solid` is one shape. */
  contiguous: boolean;
}

export function stepPaths(
  points: readonly (readonly [number, number | null])[],
  end: number,
  x: (t: number) => number,
  y: (v: number) => number,
): StepPaths {
  const p = (t: number, v: number) => `${x(t).toFixed(1)},${y(v).toFixed(1)}`;
  let solid = "";
  let dashed = "";
  const dots: StepPaths["dots"] = [];
  let last: number | undefined;
  let open = false;
  let gapFrom = 0;
  let contiguous = true;

  points.forEach(([at, v], i) => {
    const next = points[i + 1]?.[0] ?? end;
    if (v === null) {
      if (open) gapFrom = at;
      open = false;
      return;
    }
    if (open) {
      solid += `L${p(at, v)}H${x(next).toFixed(1)}`;
    } else {
      if (last !== undefined) {
        dashed += `M${p(gapFrom, last)}H${x(at).toFixed(1)}V${y(v).toFixed(1)}`;
        contiguous = false;
      }
      solid += `M${p(at, v)}H${x(next).toFixed(1)}`;
    }
    if (v !== last) dots.push({ at, value: v });
    last = v;
    open = true;
  });

  return { solid, dashed, dots, contiguous };
}
