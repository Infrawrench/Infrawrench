import { describe, expect, it } from "vitest";

import { FORECAST_COLOR, OTHER_SERIES_COLOR, SCENARIO_COLOR, SERIES_COLORS } from "../chart-colors";

/**
 * The rule these guard is "an overlay's colour is a decision, not a slot".
 * Asserting the literals alone would be tautological, so what is checked here
 * is the relationship between the overlays and the categorical rotation — the
 * thing that broke when the scenario line was written as `colors[3]`.
 */
describe("cost chart colours", () => {
  it("gives the scenario projection the amber the caption beside it uses", () => {
    // `--color-warning` in the dark theme, which is what `text-warning` — the
    // class on the "Projection includes scenario …" caption — resolves to.
    expect(SCENARIO_COLOR).toBe("#fbbf24");
  });

  it("does not draw the scenario projection in the palette's red", () => {
    // On a spend chart red is the over-budget colour; a projection makes no
    // such claim. This is the defect: slot three is "#f87171".
    expect(SCENARIO_COLOR).not.toBe(SERIES_COLORS[3]);
    expect(SCENARIO_COLOR).not.toBe("#f87171");
  });

  it("keeps the two overlays tellable apart from each other and from Other", () => {
    const overlays = [FORECAST_COLOR, SCENARIO_COLOR, OTHER_SERIES_COLOR];
    expect(new Set(overlays).size).toBe(overlays.length);
  });

  it("never hands a categorical hue to Other", () => {
    expect(SERIES_COLORS).not.toContain(OTHER_SERIES_COLOR);
  });

  it("keeps the rotation long enough that a top-five breakdown never repeats", () => {
    // Top-N defaults to five plus "Other"; a rotation shorter than that would
    // give two different series the same hue on a default chart.
    expect(SERIES_COLORS.length).toBeGreaterThanOrEqual(5);
    expect(new Set(SERIES_COLORS).size).toBe(SERIES_COLORS.length);
  });

  it("states every colour as a six-digit hex, which both chart libraries take", () => {
    for (const color of [...SERIES_COLORS, OTHER_SERIES_COLOR, FORECAST_COLOR, SCENARIO_COLOR]) {
      expect(color).toMatch(/^#[0-9a-f]{6}$/);
    }
  });
});
