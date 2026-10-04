import { describe, expect, it } from "vitest";
import {
  adjustmentRows,
  cycleStartsIn,
  fetchModalCostData,
  objectKind,
  reportToRows,
} from "../cost-data.js";
import { ProtoWriter } from "../proto.js";
import { ctxWith, makeHttp, ts, withMap } from "./helpers.js";

const DAY = Date.parse("2026-09-03T00:00:00Z");

function reportItem(opts: {
  objectId: string;
  description: string;
  env: string;
  day: number;
  cost: string;
  byResource: Record<string, string>;
  tags?: Record<string, string>;
}): ProtoWriter {
  const w = new ProtoWriter()
    .string(1, opts.objectId)
    .string(2, opts.description)
    .string(3, opts.env)
    .message(4, ts(opts.day))
    .string(5, opts.cost);
  withMap(w, 6, opts.tags ?? {});
  withMap(w, 8, opts.byResource);
  return w;
}

describe("reportToRows", () => {
  it("writes one row per resource type with the object, environment and tags", () => {
    const rows = reportToRows([
      {
        objectId: "ap-123",
        description: "trainer",
        environment: "main",
        intervalStartMs: DAY,
        cost: 12.5,
        costByResource: { "GPU (H100)": 10, CPU: 2, Memory: 0.5 },
        tags: { team: "ml" },
      },
    ]);
    expect(rows).toHaveLength(3);
    expect(rows.find((r) => r.service === "GPU (H100)")).toEqual({
      date: "2026-09-03",
      service: "GPU (H100)",
      resourceId: "ap-123",
      tags: { team: "ml", environment: "main", object: "trainer", objectType: "App" },
      currency: "USD",
      amount: 10,
    });
  });

  it("keeps the part of the cost the breakdown does not explain", () => {
    const rows = reportToRows([
      {
        objectId: "sb-9",
        description: "",
        environment: "dev",
        intervalStartMs: DAY,
        cost: 3,
        costByResource: { CPU: 1 },
        tags: {},
      },
    ]);
    expect(rows.map((r) => [r.service, r.amount])).toEqual([
      ["CPU", 1],
      ["Other", 2],
    ]);
    expect(rows[0]?.tags?.["object"]).toBe("sb-9");
    expect(rows[0]?.tags?.["objectType"]).toBe("Sandbox");
  });

  it("does not let a user tag overwrite the environment", () => {
    const [row] = reportToRows([
      {
        objectId: "ap-1",
        description: "x",
        environment: "prod",
        intervalStartMs: DAY,
        cost: 1,
        costByResource: { CPU: 1 },
        tags: { environment: "spoofed" },
      },
    ]);
    expect(row?.tags?.["environment"]).toBe("prod");
  });
});

describe("adjustmentRows", () => {
  it("uses adjustments as given when they sum to billed minus metered", () => {
    const rows = adjustmentRows(
      { metered: 500, billed: 370, breakdown: {}, adjustments: { credits: -100, plan: -30 } },
      "2026-09-01",
    );
    expect(rows).toEqual([
      expect.objectContaining({ service: "Credits", amount: -100, chargeType: "credit" }),
      expect.objectContaining({ service: "Plan", amount: -30, chargeType: "adjustment" }),
    ]);
    expect(rows.reduce((s, r) => s + r.amount, 0)).toBe(-130);
  });

  it("flips adjustments reported as positive discounts", () => {
    const rows = adjustmentRows(
      { metered: 500, billed: 400, breakdown: {}, adjustments: { credits: 100 } },
      "2026-09-01",
    );
    expect(rows).toEqual([expect.objectContaining({ amount: -100, chargeType: "credit" })]);
  });

  it("falls back to one row carrying the difference when the keys do not add up", () => {
    const rows = adjustmentRows(
      { metered: 500, billed: 420, breakdown: {}, adjustments: { mystery: 5 } },
      "2026-09-01",
    );
    expect(rows).toEqual([
      expect.objectContaining({ service: "Adjustments", amount: -80, chargeType: "credit" }),
    ]);
  });

  it("writes nothing when nothing was adjusted", () => {
    expect(
      adjustmentRows({ metered: 10, billed: 10, breakdown: {}, adjustments: {} }, "2026-09-01"),
    ).toEqual([]);
  });
});

describe("cycleStartsIn", () => {
  it("lists every first of the month inside the range, never in the future", () => {
    expect(
      cycleStartsIn({ fromDate: "2026-07-15", toDate: "2026-10-04" }, Date.parse("2026-10-04")),
    ).toEqual(["2026-08-01", "2026-09-01", "2026-10-01"]);
    expect(cycleStartsIn({ fromDate: "2026-09-01", toDate: "2026-09-30" })).toEqual(["2026-09-01"]);
    expect(
      cycleStartsIn({ fromDate: "2026-12-01", toDate: "2027-01-31" }, Date.parse("2027-02-01")),
    ).toEqual(["2026-12-01", "2027-01-01"]);
  });
});

describe("objectKind", () => {
  it("names objects by their id prefix", () => {
    expect(objectKind("ap-abc")).toBe("App");
    expect(objectKind("vo-abc")).toBe("Volume");
    expect(objectKind("zz-abc")).toBe("Other");
  });
});

describe("fetchModalCostData", () => {
  it("requests the inclusive range with all tags and adds the cycle's adjustments", async () => {
    const { http, calls } = makeHttp((method) => {
      if (method === "WorkspaceBillingReport") {
        return [
          reportItem({
            objectId: "ap-1",
            description: "api",
            env: "main",
            day: DAY,
            cost: "4.000000",
            byResource: { CPU: "3.000000", Memory: "1.000000" },
          }),
        ];
      }
      if (method === "WorkspaceBillingSummary") {
        return withMap(new ProtoWriter().string(3, "40.00").string(4, "30.00"), 6, {
          credits: "-10.00",
        });
      }
      throw new Error(`unexpected ${method}`);
    });
    const rows = await fetchModalCostData(ctxWith(http), {
      fromDate: "2026-09-01",
      toDate: "2026-09-03",
    });
    const report = calls.find((c) => c.method === "WorkspaceBillingReport")!.request;
    expect(report.timestampMs(1)).toBe(Date.parse("2026-09-01T00:00:00Z"));
    expect(report.timestampMs(2)).toBe(Date.parse("2026-09-04T00:00:00Z"));
    expect(report.string(3)).toBe("d");
    expect(report.strings(4)).toEqual(["*"]);
    expect(rows.map((r) => [r.date, r.service, r.amount, r.chargeType])).toEqual([
      ["2026-09-03", "CPU", 3, undefined],
      ["2026-09-03", "Memory", 1, undefined],
      ["2026-09-01", "Credits", -10, "credit"],
    ]);
  });

  it("explains a plan refusal as a setup problem", async () => {
    const { http } = makeHttp(() => ({ grpcStatus: 7, message: "not available on your plan" }));
    await expect(
      fetchModalCostData(ctxWith(http), { fromDate: "2026-09-01", toDate: "2026-09-03" }),
    ).rejects.toMatchObject({ name: "CostSetupError" });
  });

  it("still fails on a rejected token", async () => {
    const { http } = makeHttp(() => ({ grpcStatus: 16, message: "Token not found" }));
    await expect(
      fetchModalCostData(ctxWith(http), { fromDate: "2026-09-01", toDate: "2026-09-03" }),
    ).rejects.toMatchObject({ name: "ModalApiError", code: 16 });
  });
});
