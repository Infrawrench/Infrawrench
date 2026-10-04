import { describe, expect, it } from "vitest";
import { CostSetupError, CreditAccessError } from "@infrawrench/plugin-base";
import {
  aggregateRows,
  completeDays,
  fetchElasticCostData,
  fetchElasticCreditBalance,
  lineItemCategory,
  regionFromSku,
  rowsForDay,
} from "../cost-data.js";
import { ctxWith, makeHttp } from "./helpers.js";

const NOW = Date.parse("2026-10-04T12:00:00Z");

const capacity = {
  name: "Cloud Standard, GCP europe-west1 (Belgium), gcp.es.ml.n2.68x32x45, 8GB, 1AZ",
  type: "capacity",
  kind: "elasticsearch",
  sku: "gcp.es.ml.n2.68x32x45_gcp-europe-west1_8192_1",
  unit: "hour",
  total_ecu: 8.4672,
  quantity: { value: 24, formatted_value: "24 hours" },
  rate: { value: 0.3528, formatted_value: "0.3528 per hour" },
};

describe("helpers", () => {
  it("labels known line-item types and humanizes the rest", () => {
    expect(lineItemCategory("capacity")).toBe("Capacity");
    expect(lineItemCategory("storage_bytes")).toBe("Snapshot Storage");
    expect(lineItemCategory("search_vcu")).toBe("Search Vcu");
    expect(lineItemCategory(undefined)).toBe("Other");
  });

  it("reads the region from a capacity SKU", () => {
    expect(regionFromSku(capacity.sku)).toBe("gcp-europe-west1");
    expect(regionFromSku("aws.es.datahot.c6gd_aws-us-east-1_4096_2")).toBe("aws-us-east-1");
    expect(regionFromSku("data_out")).toBeUndefined();
  });

  it("only yields days that have ended", () => {
    const days = completeDays({ fromDate: "2026-10-02", toDate: "2026-10-04" }, NOW);
    expect(days.map(([from]) => new Date(from).toISOString().slice(0, 10))).toEqual([
      "2026-10-02",
      "2026-10-03",
    ]);
  });

  it("aggregates rows sharing every dimension and drops mixed-unit quantities", () => {
    const rows = aggregateRows([
      {
        date: "d",
        service: "Capacity",
        currency: "USD",
        amount: 1,
        usageAmount: 2,
        usageUnit: "hour",
      },
      {
        date: "d",
        service: "Capacity",
        currency: "USD",
        amount: 2,
        usageAmount: 3,
        usageUnit: "hour",
      },
      { date: "d", service: "Other", currency: "USD", amount: 1, usageAmount: 1, usageUnit: "GB" },
      {
        date: "d",
        service: "Other",
        currency: "USD",
        amount: 1,
        usageAmount: 1,
        usageUnit: "hour",
      },
    ]);
    expect(rows).toEqual([
      {
        date: "d",
        service: "Capacity",
        currency: "USD",
        amount: 3,
        usageAmount: 5,
        usageUnit: "hour",
      },
      { date: "d", service: "Other", currency: "USD", amount: 2 },
    ]);
  });
});

describe("rowsForDay", () => {
  it("emits one row per line-item category per instance, in USD at 1 ECU = $1", () => {
    const rows = rowsForDay("2026-10-03", "org1", {
      instances: [
        {
          id: "dep1",
          name: "search-prod",
          type: "deployment",
          product_line_items: [
            capacity,
            {
              type: "data_out",
              sku: "gcp.data.out",
              unit: "GB",
              total_ecu: 0.5,
              quantity: { value: 2 },
            },
            { type: "data_in", total_ecu: 0 },
          ],
        },
        {
          id: "proj1",
          name: "logs",
          type: "observability",
          product_line_items: [
            { type: "ingest", unit: "GB", total_ecu: 1.25, quantity: { value: 5 } },
          ],
        },
      ],
    });
    expect(rows).toEqual([
      {
        date: "2026-10-03",
        service: "Capacity",
        region: "gcp-europe-west1",
        resourceId: "dep1",
        tags: {
          organization: "org1",
          instance_type: "Hosted deployment",
          instance: "search-prod",
          component: "elasticsearch",
        },
        currency: "USD",
        amount: 8.4672,
        usageAmount: 24,
        usageUnit: "hour",
      },
      {
        date: "2026-10-03",
        service: "Data Transfer Out",
        resourceId: "dep1",
        tags: { organization: "org1", instance_type: "Hosted deployment", instance: "search-prod" },
        currency: "USD",
        amount: 0.5,
        usageAmount: 2,
        usageUnit: "GB",
      },
      {
        date: "2026-10-03",
        service: "Ingest",
        resourceId: "proj1",
        tags: { organization: "org1", instance_type: "Observability project", instance: "logs" },
        currency: "USD",
        amount: 1.25,
        usageAmount: 5,
        usageUnit: "GB",
      },
    ]);
  });
});

describe("fetchElasticCostData", () => {
  it("discovers the organization and requests each complete day on the billing host", async () => {
    const { http, calls } = makeHttp((url) => {
      if (url.pathname === "/api/v1/organizations") {
        return { body: { organizations: [{ id: "org1", name: "Acme" }] } };
      }
      if (url.pathname === "/api/v2/billing/organizations/org1/costs/instances") {
        return {
          body: {
            total_ecu: 8.4672,
            instances: [
              { id: "dep1", name: "a", type: "deployment", product_line_items: [capacity] },
            ],
          },
        };
      }
      return { status: 404, body: {} };
    });
    const rows = await fetchElasticCostData(
      ctxWith(http),
      { fromDate: "2026-10-02", toDate: "2026-10-04" },
      NOW,
    );
    expect(rows.map((r) => r.date)).toEqual(["2026-10-02", "2026-10-03"]);
    const billing = calls.filter((c) => c.url.pathname.includes("/costs/instances"));
    expect(billing).toHaveLength(2);
    expect(billing[0]!.url.host).toBe("billing.elastic-cloud.com");
    expect(billing[0]!.headers["Authorization"]).toBe("ApiKey test-key");
    expect(billing[0]!.url.searchParams.get("from")).toBe("2026-10-02T00:00:00.000Z");
    expect(billing[0]!.url.searchParams.get("to")).toBe("2026-10-03T00:00:00.000Z");
    expect(calls[0]!.url.host).toBe("api.elastic-cloud.com");
  });

  it("turns a 403 on billing into a setup error naming the role", async () => {
    const { http } = makeHttp((url) =>
      url.pathname === "/api/v1/organizations"
        ? { body: { organizations: [{ id: "org1" }] } }
        : { status: 403, body: { errors: [] } },
    );
    await expect(
      fetchElasticCostData(ctxWith(http), { fromDate: "2026-10-01", toDate: "2026-10-01" }, NOW),
    ).rejects.toBeInstanceOf(CostSetupError);
  });
});

describe("fetchElasticCreditBalance", () => {
  it("reports each active prepaid line item and skips expired ones", async () => {
    const { http } = makeHttp((url) => {
      if (url.pathname === "/api/v1/organizations") {
        return { body: { organizations: [{ id: "org1", name: "Acme" }] } };
      }
      return {
        body: {
          costs: { total: 10, dimensions: [] },
          trials: 0,
          hourly_rate: 1,
          balance: {
            available: 1000,
            remaining: 600,
            line_items: [
              {
                id: "li1",
                ecu_quantity: 1000,
                ecu_balance: 600,
                start: "2026-01-01T00:00:00Z",
                end: "2027-01-01T00:00:00Z",
              },
              {
                id: "li0",
                ecu_quantity: 500,
                ecu_balance: 5,
                start: "2025-01-01T00:00:00Z",
                end: "2026-01-01T00:00:00Z",
              },
            ],
          },
        },
      };
    });
    const pots = await fetchElasticCreditBalance(ctxWith(http), NOW);
    expect(pots).toEqual([
      {
        key: "org1:li1",
        label: "Prepaid ECUs (until 2027-01-01)",
        remaining: 600,
        currency: "USD",
        granted: 1000,
        expiresAt: "2027-01-01T00:00:00Z",
      },
    ]);
  });

  it("explains a 403 as a permission gap", async () => {
    const { http } = makeHttp((url) =>
      url.pathname === "/api/v1/organizations"
        ? { body: { organizations: [{ id: "org1" }] } }
        : { status: 403, body: {} },
    );
    await expect(fetchElasticCreditBalance(ctxWith(http), NOW)).rejects.toBeInstanceOf(
      CreditAccessError,
    );
  });
});
