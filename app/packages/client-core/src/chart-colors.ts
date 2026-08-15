/**
 * The colours a cost chart draws with, shared by every surface that draws one:
 * recharts on web and desktop, `react-native-svg` on mobile.
 *
 * {@link SERIES_COLORS} is a *categorical rotation* — a series' hue is its rank
 * in the response and nothing more, so no slot in it carries a meaning. The
 * overlay lines are therefore named constants rather than indexes into it. An
 * overlay written as `SERIES_COLORS[3]` has two faults that only show up on a
 * screen: it collides with whichever series happens to hold that slot, and it
 * silently changes colour if the rotation is ever reordered. That is exactly
 * how the scenario projection came to be drawn in the same red the palette
 * gives series four, while the caption naming the scenario beside it was amber.
 *
 * Written out here rather than derived from the rotation (`SERIES_COLORS[2]`)
 * for the same reason: an overlay's colour is a decision about that overlay.
 *
 * No React, no chart library — unit-test target.
 */

/**
 * The categorical rotation, assigned to data series in rank order (the API
 * returns groups ranked, with "Other" last).
 */
export const SERIES_COLORS: readonly string[] = [
  "#60a5fa",
  "#34d399",
  "#fbbf24",
  "#f87171",
  "#a78bfa",
  "#fb923c",
];

/**
 * "Other" — the bucket every group outside the top N falls into. Always
 * neutral grey, never a categorical hue: it is not one thing, so it must not
 * look like one.
 */
export const OTHER_SERIES_COLOR = "#6b7280";

/**
 * The trend forecast. It is an extrapolation of the plotted measure rather
 * than a claim about something else, so it deliberately reads as the same
 * colour family as the first series and is told apart by its dash pattern.
 */
export const FORECAST_COLOR = "#60a5fa";

/**
 * An applied scenario's projection.
 *
 * Amber, and specifically the amber that `--color-warning` resolves to, because
 * the caption naming the model under the card's title is drawn in
 * `text-warning`: a chart that disagrees with its own legend about which line
 * is the assumption is worse than a chart with no legend. It must also not be
 * the red the palette holds at slot four — on a spend chart red reads as "over
 * budget", which a projection is not making a claim about.
 */
export const SCENARIO_COLOR = "#fbbf24";
