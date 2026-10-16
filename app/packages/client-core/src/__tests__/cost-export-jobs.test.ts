import { describe, expect, it } from "vitest";
import {
  costExportJobContentType,
  costExportJobFilename,
  costExportJobProgress,
  formatExportBytes,
  isCostExportJobActive,
} from "../cost-export-jobs";

describe("costExportJobProgress", () => {
  it("measures the share of days already written, never reaching 1 early", () => {
    expect(costExportJobProgress("2026-01-01", "2026-01-01", "2026-01-10")).toBe(0);
    expect(costExportJobProgress("2026-01-06", "2026-01-01", "2026-01-10")).toBeCloseTo(0.5);
    expect(costExportJobProgress("2026-01-10", "2026-01-01", "2026-01-10")).toBeCloseTo(0.9);
    // The last day may still have rows to come; done is the status, not the bar.
    expect(costExportJobProgress("2026-02-01", "2026-01-01", "2026-01-10")).toBe(0.99);
  });

  it("is zero for an empty or inverted range", () => {
    expect(costExportJobProgress("", "2026-01-01", "2026-01-10")).toBe(0);
    expect(costExportJobProgress("2026-01-05", "2026-01-10", "2026-01-01")).toBe(0);
  });
});

describe("file naming", () => {
  it("names native and FOCUS files after the report and range", () => {
    expect(
      costExportJobFilename({
        format: "csv",
        from: "2026-01-01",
        to: "2026-03-31",
        name: "Prod / EU",
      }),
    ).toBe("costs-prod-eu-2026-01-01-to-2026-03-31.csv");
    expect(costExportJobFilename({ format: "ndjson", from: "a", to: "b" })).toBe(
      "costs-a-to-b.ndjson",
    );
    expect(costExportJobFilename({ format: "focus", from: "a", to: "b", name: "X" })).toBe(
      "focus-x-a-to-b.csv",
    );
  });

  it("types the content", () => {
    expect(costExportJobContentType("ndjson")).toBe("application/x-ndjson");
    expect(costExportJobContentType("focus")).toMatch(/text\/csv/);
  });
});

describe("helpers", () => {
  it("knows which statuses are worth polling", () => {
    expect(isCostExportJobActive("queued")).toBe(true);
    expect(isCostExportJobActive("running")).toBe(true);
    expect(isCostExportJobActive("succeeded")).toBe(false);
    expect(isCostExportJobActive("expired")).toBe(false);
  });

  it("formats byte counts", () => {
    expect(formatExportBytes(512)).toBe("512 B");
    expect(formatExportBytes(1536)).toBe("1.5 KB");
    expect(formatExportBytes(25 * 1024 * 1024)).toBe("25 MB");
  });
});
