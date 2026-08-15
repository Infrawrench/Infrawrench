import { describe, expect, it } from "vitest";
import { TAIL_LINE_PRESETS, tailLineOptions } from "../log-tail-options";

describe("tailLineOptions", () => {
  it("returns the presets unchanged when no default is given", () => {
    expect(tailLineOptions(undefined)).toEqual([...TAIL_LINE_PRESETS]);
    expect(tailLineOptions(null)).toEqual([...TAIL_LINE_PRESETS]);
  });

  it("returns the presets unchanged when the default is already one of them", () => {
    expect(tailLineOptions(500)).toEqual([...TAIL_LINE_PRESETS]);
  });

  it("splices a default outside the presets into place, sorted", () => {
    // The DigitalOcean managed-database case from issue #113.
    expect(tailLineOptions(200)).toEqual([100, 200, 500, 1000, 5000]);
  });

  it("sorts a default smaller than every preset to the front", () => {
    expect(tailLineOptions(10)).toEqual([10, 100, 500, 1000, 5000]);
  });

  it("sorts a default larger than every preset to the back", () => {
    expect(tailLineOptions(10000)).toEqual([100, 500, 1000, 5000, 10000]);
  });

  it("ignores non-positive or non-finite defaults", () => {
    expect(tailLineOptions(0)).toEqual([...TAIL_LINE_PRESETS]);
    expect(tailLineOptions(-5)).toEqual([...TAIL_LINE_PRESETS]);
    expect(tailLineOptions(Number.NaN)).toEqual([...TAIL_LINE_PRESETS]);
  });
});
