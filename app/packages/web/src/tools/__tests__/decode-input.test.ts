import { describe, expect, it } from "vitest";
import { BudgetInput, CostCanvasSpec, CostQueryRequest } from "@infrawrench/api-contract/schemas";

import { decodeToolInput } from "../decode-input";

describe("decodeToolInput", () => {
  it("decodes as the route does: defaults filled, unknown keys dropped", () => {
    const decoded = decodeToolInput(BudgetInput, {
      name: "Platform",
      thresholds: [{ type: "actual", percent: 80 }],
      amountCents: 1000,
      mystery: true,
    });
    expect(decoded).toEqual({
      success: true,
      data: {
        name: "Platform",
        amountCents: 1000,
        currency: "USD",
        filters: [],
        thresholds: [{ type: "actual", percent: 80 }],
      },
    });
  });

  it("reports every problem as path: message, on one line", () => {
    const decoded = decodeToolInput(CostQueryRequest, {
      from: "yesterday",
      binning: "daily",
      groupBy: "none",
      topN: 99,
    });
    expect(decoded.success).toBe(false);
    if (!decoded.success) {
      expect(decoded.message).toBe(
        "from: expected YYYY-MM-DD; to: Missing key; topN: Expected a value between 1 and 15",
      );
    }
  });

  it("refuses unknown keys at any depth when strict", () => {
    const spec = { version: 1, blocks: [{ id: "t", kind: "text", text: "hi", sql: "SELECT 1" }] };
    expect(decodeToolInput(CostCanvasSpec, spec).success).toBe(true);
    const strict = decodeToolInput(CostCanvasSpec, spec, { strict: true, root: "(spec)" });
    expect(strict).toEqual({
      success: false,
      message: "blocks.0.sql: Expected no excess property",
    });
  });

  it("labels a problem with the whole value", () => {
    const decoded = decodeToolInput(CostCanvasSpec, "nope", { root: "(spec)" });
    expect(decoded.success).toBe(false);
    if (!decoded.success) expect(decoded.message).toMatch(/^\(spec\): /);
  });
});
