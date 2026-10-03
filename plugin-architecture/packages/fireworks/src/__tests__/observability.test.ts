import { describe, expect, it } from "vitest";
import { histogramQuantile, parsePromText, sumSamples } from "../observability.js";

describe("parsePromText", () => {
  it("parses labelled and bare samples and skips comments and non-finite values", () => {
    const samples = parsePromText(
      [
        "# HELP x help",
        'a{deployment_id="d1",path="/v1/x,y"} 1.5 1700000000000',
        "b 2",
        'c{le="+Inf"} NaN',
        'd{msg="say \\"hi\\""} 3',
      ].join("\n"),
    );
    expect(samples).toEqual([
      { name: "a", labels: { deployment_id: "d1", path: "/v1/x,y" }, value: 1.5 },
      { name: "b", labels: {}, value: 2 },
      { name: "d", labels: { msg: 'say "hi"' }, value: 3 },
    ]);
    expect(sumSamples(samples, "a")).toBe(1.5);
    expect(sumSamples(samples, "missing")).toBeUndefined();
  });
});

describe("histogramQuantile", () => {
  const buckets = (counts: Array<[string, number]>) =>
    counts.map(([le, value]) => ({ name: "h", labels: { le }, value }));

  it("interpolates inside the bucket that holds the rank, summing series per bound", () => {
    const samples = [
      ...buckets([
        ["10", 1],
        ["20", 2],
        ["+Inf", 2],
      ]),
      ...buckets([
        ["10", 1],
        ["20", 4],
        ["+Inf", 4],
      ]),
    ];
    // 6 observations; p50 rank 3 is the first of four in the 10-20 bucket.
    expect(histogramQuantile(samples, "h", 0.5)).toBeCloseTo(12.5);
  });

  it("reports the highest finite bound when the rank lands in +Inf, and nothing when empty", () => {
    expect(
      histogramQuantile(
        buckets([
          ["10", 1],
          ["+Inf", 10],
        ]),
        "h",
        0.99,
      ),
    ).toBe(10);
    expect(
      histogramQuantile(
        buckets([
          ["10", 0],
          ["+Inf", 0],
        ]),
        "h",
        0.5,
      ),
    ).toBeUndefined();
  });
});
