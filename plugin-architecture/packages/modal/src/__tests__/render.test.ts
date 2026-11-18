import { describe, expect, it } from "vitest";
import type { ResourceInstance } from "@infrawrench/plugin-base";
import type { BillingSummary } from "../api.js";
import { SUMMARY_KEY, formatUsd, renderModalDetail } from "../render.js";

describe("formatUsd", () => {
  // `$${n.toLocaleString()}` put the sign after the symbol (#1356).
  it("puts a negative amount's sign before the dollar sign", () => {
    expect(formatUsd(-100)).toBe("-$100.00");
    expect(formatUsd(1234.5)).toBe("$1,234.50");
    expect(formatUsd(0)).toBe("$0.00");
  });
});

describe("workspace billing tables", () => {
  it("prints a credit as -$ in the adjustments table", () => {
    const summary: BillingSummary = {
      metered: 150,
      billed: 50,
      breakdown: { gpu_a100: 150 },
      adjustments: { free_credits: -100 },
    };
    const resource: ResourceInstance = {
      id: "r1",
      pluginId: "modal",
      resourceTypeId: "workspace",
      accountId: "a1",
      displayName: "acme",
      fields: { name: "acme" },
      resolvedOutputs: { [SUMMARY_KEY]: JSON.stringify(summary) },
      secretStates: [],
      createdAt: "2026-11-01T00:00:00Z",
      updatedAt: "2026-11-01T00:00:00Z",
    };
    const text = JSON.stringify(renderModalDetail(resource));
    expect(text).toContain('"amount":"-$100.00"');
    expect(text).not.toContain("$-");
  });
});
