import { describe, it, expect } from "vitest";
import {
  COST_REPORT_LIMITS,
  DASHBOARD_WIDGET_KINDS,
  duplicateCostReportName,
  normalizeCostReportName,
} from "../index";

describe("normalizeCostReportName", () => {
  it("trims", () => {
    expect(normalizeCostReportName("  Monthly spend  ")).toBe("Monthly spend");
  });

  it("rejects blank names", () => {
    expect(normalizeCostReportName("")).toBeNull();
    expect(normalizeCostReportName("   ")).toBeNull();
  });

  it("rejects names past the stored column's limit", () => {
    expect(normalizeCostReportName("a".repeat(COST_REPORT_LIMITS.maxNameLength))).not.toBeNull();
    expect(normalizeCostReportName("a".repeat(COST_REPORT_LIMITS.maxNameLength + 1))).toBeNull();
  });
});

describe("duplicateCostReportName", () => {
  it("prefixes with 'Copy of'", () => {
    expect(duplicateCostReportName("Spend by service", [])).toBe("Copy of Spend by service");
  });

  it("numbers a second copy rather than colliding", () => {
    expect(duplicateCostReportName("Spend", ["Spend", "Copy of Spend"])).toBe("Copy of Spend (2)");
    expect(duplicateCostReportName("Spend", ["Copy of Spend", "Copy of Spend (2)"])).toBe(
      "Copy of Spend (3)",
    );
  });

  it("compares case- and whitespace-insensitively", () => {
    expect(duplicateCostReportName("Spend", ["  copy of spend "])).toBe("Copy of Spend (2)");
  });

  it("never exceeds the stored column, even when suffixing", () => {
    const long = "x".repeat(COST_REPORT_LIMITS.maxNameLength);
    const first = duplicateCostReportName(long, []);
    expect(first.length).toBeLessThanOrEqual(COST_REPORT_LIMITS.maxNameLength);
    const second = duplicateCostReportName(long, [first]);
    expect(second.length).toBeLessThanOrEqual(COST_REPORT_LIMITS.maxNameLength);
    expect(second).not.toBe(first);
  });
});

describe("DASHBOARD_WIDGET_KINDS", () => {
  it("keeps the ad-hoc cost_graph kind alongside the new cost_report one", () => {
    // Both exist on purpose: a one-off card must not require naming and filing
    // a report first. Losing either is a silent regression for stored widgets.
    expect(DASHBOARD_WIDGET_KINDS).toContain("cost_graph");
    expect(DASHBOARD_WIDGET_KINDS).toContain("cost_report");
  });
});
