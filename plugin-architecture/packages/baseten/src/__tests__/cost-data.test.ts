import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CostSetupError } from "@infrawrench/plugin-base";
import { BasetenApi } from "../api.js";
import { chunkRange, fetchBasetenCostData, summaryToRows } from "../cost-data.js";
import { installFetch, route, state } from "./helpers.js";

const api = () => new BasetenApi("k", "", undefined);

const summary = {
  dedicated_usage: {
    subtotal: 12,
    credits_used: 0,
    total: 12,
    minutes: 120,
    breakdown: [
      {
        billable_resource: {
          id: "dep-1",
          kind: "MODEL_DEPLOYMENT",
          name: "v3",
          model_id: "m-1",
          model_name: "llama",
          instance_type: "1x H100",
          environment_name: "production",
          team_name: "Core",
          is_deleted: false,
        },
        subtotal: "12",
        minutes: 120,
        inference_requests: 10,
        daily: [
          { date: "2026-09-01", subtotal: "5.5", minutes: 50, inference_requests: 4 },
          { date: "2026-09-02", subtotal: 6.5, minutes: 70, inference_requests: 6 },
          { date: "2026-08-31", subtotal: 1, minutes: 5, inference_requests: 0 },
        ],
      },
      {
        billable_resource: {
          id: "cl-1",
          kind: "CHAINLET",
          name: "Retriever",
          chain_metadata: { chain_id: "ch-1", chain_name: "rag", chain_deployment_id: "cd-1" },
          is_deleted: false,
        },
        subtotal: 2,
        daily: [{ date: "2026-09-01", subtotal: 2, minutes: 10 }],
      },
    ],
  },
  training_usage: {
    subtotal: 30,
    credits_used: 0,
    total: 30,
    minutes: 60,
    breakdown: [
      {
        billable_resource: { id: "j1", kind: "TRAINING_JOB", name: "sft-run", is_deleted: false },
        subtotal: 30,
        daily: [{ date: "2026-09-02", subtotal: 30, minutes: 60 }],
      },
    ],
  },
  model_apis_usage: {
    subtotal: 1,
    credits_used: 0,
    total: 1,
    breakdown: [
      {
        model_name: "deepseek-v3",
        model_family: "deepseek",
        subtotal: 1,
        input_tokens: 1000,
        output_tokens: 500,
        cached_input_tokens: 0,
        daily: [{ date: "2026-09-01", subtotal: 1, input_tokens: 1000, output_tokens: 500 }],
      },
    ],
  },
};

beforeEach(() => installFetch());
afterEach(() => vi.unstubAllGlobals());

describe("summaryToRows", () => {
  it("emits daily rows per product, keyed to inventory ids, within the range", () => {
    const { rows, missingDaily } = summaryToRows(summary, "2026-09-01", "2026-09-02");
    expect(missingDaily).toBe(false);
    expect(rows).toHaveLength(5);
    expect(rows).toContainEqual({
      date: "2026-09-01",
      service: "Dedicated Inference",
      resourceId: "m-1/dep-1",
      tags: {
        model: "llama",
        deployment: "v3",
        environment: "production",
        instance_type: "1x H100",
        team: "Core",
      },
      currency: "USD",
      amount: 5.5,
      usageAmount: 50,
      usageUnit: "minutes",
    });
    expect(rows.find((r) => r.service === "Chains")!.resourceId).toBe("ch-1");
    expect(rows.find((r) => r.service === "Training")).toMatchObject({
      resourceId: "j1",
      amount: 30,
    });
    expect(rows.find((r) => r.service === "Model APIs")).toMatchObject({
      resourceId: "deepseek-v3",
      usageAmount: 1500,
      usageUnit: "tokens",
    });
    expect(rows.some((r) => r.date === "2026-08-31")).toBe(false);
  });

  it("detects an item with spend and no daily breakdown", () => {
    const { missingDaily } = summaryToRows(
      {
        model_apis_usage: {
          subtotal: 1,
          credits_used: 0,
          total: 1,
          breakdown: [{ model_name: "x", subtotal: 1 }],
        },
      },
      "2026-09-01",
      "2026-09-02",
    );
    expect(missingDaily).toBe(true);
  });
});

describe("fetchBasetenCostData", () => {
  it("chunks to at most 30 days and clamps to the earliest queryable date", async () => {
    route("GET", "/v1/billing/usage_summary", {});
    await fetchBasetenCostData(api(), { fromDate: "2025-12-01", toDate: "2026-03-05" });
    const windows = state.calls.map((c) => [c.query.get("start_date"), c.query.get("end_date")]);
    expect(windows[0]).toEqual(["2026-01-01T00:00:00Z", "2026-01-31T00:00:00Z"]);
    expect(windows.at(-1)![1]).toBe("2026-03-06T00:00:00Z");
    expect(chunkRange("2026-01-01", "2026-03-05")).toHaveLength(3);
  });

  it("falls back to per-day requests when daily breakdowns are missing", async () => {
    route("GET", "/v1/billing/usage_summary", () => ({
      model_apis_usage: {
        subtotal: 2,
        credits_used: 0,
        total: 2,
        breakdown: [{ model_name: "x", subtotal: 2, input_tokens: 10, output_tokens: 5 }],
      },
    }));
    const rows = await fetchBasetenCostData(api(), {
      fromDate: "2026-09-01",
      toDate: "2026-09-02",
    });
    expect(state.calls).toHaveLength(3);
    expect(rows.map((r) => r.date)).toEqual(["2026-09-01", "2026-09-02"]);
  });

  it("turns a refusal into a setup error", async () => {
    route("GET", "/v1/billing/usage_summary", () => new Response("{}", { status: 403 }));
    await expect(
      fetchBasetenCostData(api(), { fromDate: "2026-09-01", toDate: "2026-09-02" }),
    ).rejects.toBeInstanceOf(CostSetupError);
  });
});
