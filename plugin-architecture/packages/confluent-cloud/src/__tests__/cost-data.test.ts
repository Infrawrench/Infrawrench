import { describe, expect, it } from "vitest";
import { CostSetupError } from "@infrawrench/plugin-base";
import {
  costWindows,
  fetchConfluentCostData,
  netAmount,
  normalizeCosts,
  productLabel,
} from "../cost-data.js";
import { makeHttp } from "./helpers.js";

describe("costWindows", () => {
  it("walks an inclusive range in end-exclusive windows of at most 28 days", () => {
    const w = costWindows({ fromDate: "2026-01-01", toDate: "2026-03-01" });
    expect(w[0]).toEqual({ start: "2026-01-01", end: "2026-01-29" });
    expect(w.at(-1)!.end).toBe("2026-03-02");
    for (const x of w) {
      expect(Date.parse(x.end) - Date.parse(x.start)).toBeLessThanOrEqual(28 * 86_400_000);
    }
  });

  it("returns one single-day window for a one-day range", () => {
    expect(costWindows({ fromDate: "2026-05-05", toDate: "2026-05-05" })).toEqual([
      { start: "2026-05-05", end: "2026-05-06" },
    ]);
  });
});

describe("netAmount", () => {
  it("prefers amount, then original minus discount, then quantity times price", () => {
    expect(netAmount({ amount: 79, original_amount: 99.95, discount_amount: 20.95 })).toBe(79);
    expect(netAmount({ original_amount: 100, discount_amount: 25 })).toBe(75);
    expect(netAmount({ quantity: 10, price: 1.5 })).toBe(15);
    expect(netAmount({})).toBeNull();
  });
});

describe("normalizeCosts", () => {
  it("files rows by product, joins region from inventory, and tags environment and line type", () => {
    const rows = normalizeCosts(
      [
        {
          start_date: "2026-09-01",
          product: "KAFKA",
          line_type: "KAFKA_NUM_CKUS",
          network_access_type: "PRIVATE_LINK",
          quantity: 24,
          unit: "CKU-hour",
          amount: 48,
          resource: { id: "lkc-1", environment: { id: "env-1" } },
        },
        {
          start_date: "2026-09-01",
          product: "KAFKA",
          line_type: "PROMO_CREDIT",
          amount: -10,
        },
        {
          start_date: "2026-09-01",
          product: "SUPPORT_CLOUD_BUSINESS",
          line_type: "SUPPORT",
          amount: 33,
        },
        {
          // Legacy shape: environment at the top level, no amount.
          start_date: "2026-09-02",
          product: "CONNECT",
          line_type: "CONNECT_NUM_TASKS",
          original_amount: 5,
          discount_amount: 1,
          environment: { id: "env-1" },
          resource: { id: "lcc-1", environment: "env-1" },
        },
      ],
      {
        locations: new Map([
          ["lkc-1", { region: "us-east-1", cloud: "aws" }],
          ["lcc-1", { region: "us-east-1", cloud: "aws" }],
        ]),
        environments: new Map([["env-1", "prod"]]),
      },
    );
    expect(rows).toContainEqual({
      date: "2026-09-01",
      service: "Kafka",
      region: "us-east-1",
      resourceId: "lkc-1",
      tags: { environment: "prod", lineType: "CKUs", network: "Private link", cloud: "AWS" },
      currency: "USD",
      amount: 48,
      usageAmount: 24,
      usageUnit: "CKU-hour",
    });
    expect(rows.find((r) => r.service === "Credits")).toMatchObject({
      amount: -10,
      chargeType: "credit",
    });
    expect(rows.find((r) => r.service === "Support")).toMatchObject({ chargeType: "support" });
    expect(rows.find((r) => r.service === "Connect")).toMatchObject({
      amount: 4,
      tags: { environment: "prod", lineType: "Connector tasks", cloud: "AWS" },
    });
  });

  it("sums rows that share every key", () => {
    const line = {
      start_date: "2026-09-01",
      product: "KAFKA",
      line_type: "KAFKA_STORAGE",
      amount: 1.25,
      quantity: 10,
      unit: "GB-hour",
      resource: { id: "lkc-1" },
    };
    const rows = normalizeCosts([line, line]);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ amount: 2.5, usageAmount: 20 });
  });

  it("labels Schema Registry separately from the rest of Stream Governance", () => {
    expect(productLabel("STREAM_GOVERNANCE", "SCHEMA_REGISTRY")).toBe("Schema Registry");
    expect(productLabel("STREAM_GOVERNANCE", "GOVERNANCE_BASE")).toBe("Stream Governance");
    expect(productLabel("SOMETHING_NEW")).toBe("Something New");
  });
});

describe("fetchConfluentCostData", () => {
  it("follows metadata.next and turns a 403 into a setup error naming the roles", async () => {
    let page = 0;
    const { http, calls } = makeHttp((url) => {
      if (url.searchParams.get("page_token") === "p2") {
        return { body: { data: [{ start_date: "2026-09-01", product: "FLINK", amount: 2 }] } };
      }
      page++;
      return {
        body: {
          data: [{ start_date: "2026-09-01", product: "KSQL", amount: 1 }],
          metadata: { next: "https://api.confluent.cloud/billing/v1/costs?page_token=p2" },
        },
      };
    });
    const ctx = { apiKey: "k", apiSecret: "s", http };
    const rows = await fetchConfluentCostData(ctx, {
      fromDate: "2026-09-01",
      toDate: "2026-09-01",
    });
    expect(page).toBe(1);
    expect(rows.map((r) => r.service).sort()).toEqual(["Flink", "ksqlDB"]);
    expect(calls[0]!.url.searchParams.get("start_date")).toBe("2026-09-01");
    expect(calls[0]!.url.searchParams.get("end_date")).toBe("2026-09-02");

    const denied = makeHttp(() => ({ status: 403, body: { errors: [] } }));
    await expect(
      fetchConfluentCostData(
        { apiKey: "k", apiSecret: "s", http: denied.http },
        { fromDate: "2026-09-01", toDate: "2026-09-01" },
      ),
    ).rejects.toBeInstanceOf(CostSetupError);
  });
});
