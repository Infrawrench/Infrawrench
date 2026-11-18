import { createMetricValueFormatter } from "@infrawrench/client-core";
import { afterEach, describe, expect, it } from "vitest";

import { barChart, lineChart, metricSeriesFormat } from "../cli/charts";
import { c, setColorEnabled } from "../cli/output";

// The CLI's hand-rolled charts: pure string builders, tested without a
// terminal. Colour is switched on where the bug only shows with escapes.

const ESC = String.fromCharCode(27);
const plain = (s: string) => s.replace(new RegExp(`${ESC}\\[[0-9;]*m`, "g"), "");

afterEach(() => setColorEnabled(false));

describe("barChart", () => {
  it("starts every bar in the same column when a label is coloured (#1353)", () => {
    setColorEnabled(true);
    const rows = barChart([
      { label: "Amazon Web Services", value: 300 },
      { label: "Google Cloud", value: 120 },
      { label: c.dim("other"), value: 40 },
    ]);
    // Before the fix the dimmed label counted its escape codes as width, so
    // its bar began further left than the others.
    const barStart = rows.map((row) => plain(row).search(/[█░]/));
    expect(new Set(barStart).size).toBe(1);
    expect(barStart[0]).toBe("Amazon Web Services".length + 1);
  });

  it("pads plain labels as before", () => {
    setColorEnabled(false);
    expect(barChart([{ label: "a", value: 1 }], 4)).toEqual(["a ████ 1.0"]);
  });
});

describe("metricSeriesFormat", () => {
  it("scales a byte series once, from its largest value (#1354)", () => {
    const values = [1_073_741_824, 2_303_368_539];
    const format = metricSeriesFormat(createMetricValueFormatter, "bytes", values);
    expect(format(2_303_368_539)).toBe("2.15 GiB");
    expect(format(1_073_741_824)).toBe("1.00 GiB");
    expect(format(0)).toBe("0.00 GiB");
  });

  it("scales a byte rate the same way", () => {
    const format = metricSeriesFormat(createMetricValueFormatter, "bytes/s", [5 * 1024 ** 2]);
    expect(format(5 * 1024 ** 2)).toBe("5.00 MiB/s");
  });

  it("leaves other units to formatNumber", () => {
    const format = metricSeriesFormat(createMetricValueFormatter, "%", [10, 55]);
    expect(format(55)).toBe("55.0 %");
    expect(metricSeriesFormat(createMetricValueFormatter, undefined, [3])(3)).toBe("3.0");
  });
});

describe("lineChart", () => {
  it("labels its axis with the given formatter", () => {
    const values = [1_073_741_824, 2_147_483_648];
    const format = metricSeriesFormat(createMetricValueFormatter, "bytes", values);
    const rows = lineChart(values, { width: 10, height: 3, format });
    expect(rows[0]).toMatch(/^2\.00 GiB ┤/);
    expect(rows[2]).toMatch(/^0\.00 GiB ┤/);
    // Every row's plot starts in the same column.
    expect(new Set(rows.slice(0, 3).map((r) => r.indexOf("┤"))).size).toBe(1);
    expect(rows[3]!.indexOf("└")).toBe(rows[0]!.indexOf("┤"));
  });
});
