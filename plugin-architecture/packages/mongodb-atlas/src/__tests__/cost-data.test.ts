import { beforeEach, describe, expect, it } from "vitest";
import { CostSetupError } from "@infrawrench/plugin-base";
import { resetAuthCaches } from "../api.js";
import type { Invoice } from "../cost-data.js";
import {
  daysCovered,
  fetchAtlasCostData,
  instanceRates,
  invoiceToRows,
  skuService,
  summarizeInvoice,
} from "../cost-data.js";
import { ctxWith, makeHttp, reply } from "./helpers.js";

beforeEach(() => resetAuthCaches());

const range = { fromDate: "2026-09-01", toDate: "2026-10-31" };

const pending: Invoice = {
  id: "inv-oct",
  statusName: "PENDING",
  startDate: "2026-10-01T00:00:00Z",
  endDate: "2026-11-01T00:00:00Z",
  lineItems: [
    {
      sku: "ATLAS_AWS_INSTANCE_M30",
      groupId: "g1",
      groupName: "Prod",
      clusterName: "main",
      startDate: "2026-10-02T00:00:00Z",
      endDate: "2026-10-03T00:00:00Z",
      quantity: 72,
      unit: "server hours",
      unitPriceDollars: 0.54,
      totalPriceCents: 3888,
      cloudProvider: "AWS",
      tags: { team: "core" },
    },
    {
      sku: "ATLAS_AWS_DATA_TRANSFER_DIFFERENT_REGION",
      groupId: "g1",
      groupName: "Prod",
      clusterName: "main",
      startDate: "2026-10-02T00:00:00Z",
      endDate: "2026-10-03T00:00:00Z",
      quantity: 10,
      unit: "GB",
      totalPriceCents: 200,
      discountCents: 50,
    },
    {
      sku: "ATLAS_SUPPORT",
      startDate: "2026-10-01T00:00:00Z",
      endDate: "2026-10-05T00:00:00Z",
      totalPriceCents: 400,
    },
    {
      sku: "CREDIT",
      startDate: "2026-10-02T00:00:00Z",
      endDate: "2026-10-03T00:00:00Z",
      totalPriceCents: -1000,
    },
  ],
};

describe("skuService", () => {
  it("files SKUs under the Atlas billing categories", () => {
    expect(skuService("ATLAS_AWS_INSTANCE_M30")).toBe("Clusters");
    expect(skuService("ATLAS_GCP_INSTANCE_R40_NVME")).toBe("Clusters");
    expect(skuService("ATLAS_AWS_STORAGE_PROVISIONED")).toBe("Storage");
    expect(skuService("ATLAS_AWS_BACKUP_SNAPSHOT_STORAGE")).toBe("Backup");
    expect(skuService("ATLAS_AWS_DATA_TRANSFER_INTERNET")).toBe("Data Transfer");
    expect(skuService("ATLAS_AWS_SERVERLESS_RPU")).toBe("Serverless Instances");
    expect(skuService("ATLAS_BI_CONNECTOR")).toBe("BI Connector");
    expect(skuService("ATLAS_DATA_LAKE_AWS_DATA_RETURNED_SAME_REGION")).toBe(
      "Atlas Data Federation",
    );
    expect(skuService("REALM_APP_REQUESTS")).toBe("App Services");
    expect(skuService("ATLAS_ADVANCED_SECURITY")).toBe("Premium Features");
    expect(skuService("CREDIT")).toBe("Credits");
    expect(skuService("SOMETHING_NEW")).toBe("Atlas");
  });
});

describe("daysCovered", () => {
  it("treats a midnight end as exclusive", () => {
    expect(daysCovered("2026-10-02T00:00:00Z", "2026-10-03T00:00:00Z")).toEqual(["2026-10-02"]);
    expect(daysCovered("2026-10-01T00:00:00Z", "2026-10-04T00:00:00Z")).toEqual([
      "2026-10-01",
      "2026-10-02",
      "2026-10-03",
    ]);
    expect(daysCovered("2026-10-02T05:00:00Z", undefined)).toEqual(["2026-10-02"]);
    expect(daysCovered(undefined, undefined)).toEqual([]);
  });
});

describe("invoiceToRows", () => {
  const rows = invoiceToRows(pending, range);

  it("writes net daily rows with SKU, project and cluster attribution", () => {
    const compute = rows.find((r) => r.tags?.["sku"] === "ATLAS_AWS_INSTANCE_M30")!;
    expect(compute).toMatchObject({
      date: "2026-10-02",
      service: "Clusters",
      resourceId: "g1/main",
      currency: "USD",
      amount: 38.88,
      usageAmount: 72,
      usageUnit: "server hours",
    });
    expect(compute.tags).toMatchObject({
      project: "Prod",
      projectId: "g1",
      cluster: "main",
      cloudProvider: "AWS",
      "tag:team": "core",
    });
    const transfer = rows.find((r) => r.service === "Data Transfer")!;
    expect(transfer.amount).toBe(1.5);
  });

  it("spreads multi-day items and flags support and credits", () => {
    const support = rows.filter((r) => r.chargeType === "support");
    expect(support.map((r) => r.date)).toEqual([
      "2026-10-01",
      "2026-10-02",
      "2026-10-03",
      "2026-10-04",
    ]);
    expect(support.reduce((s, r) => s + r.amount, 0)).toBeCloseTo(4);
    const credit = rows.find((r) => r.chargeType === "credit")!;
    expect(credit.amount).toBe(-10);
    expect(credit.service).toBe("Credits");
  });

  it("sums to the invoice total", () => {
    const total = rows.reduce((s, r) => s + r.amount, 0);
    expect(total).toBeCloseTo(38.88 + 1.5 + 4 - 10);
  });

  it("clips to the range", () => {
    const narrow = invoiceToRows(pending, { fromDate: "2026-10-03", toDate: "2026-10-03" });
    expect(narrow.map((r) => r.chargeType)).toEqual(["support"]);
  });

  it("dates sales tax on a closed invoice to its last day", () => {
    const closed: Invoice = {
      statusName: "CLOSED",
      startDate: "2026-09-01T00:00:00Z",
      endDate: "2026-10-01T00:00:00Z",
      salesTaxCents: 725,
      lineItems: [],
    };
    expect(invoiceToRows(closed, range)).toEqual([
      {
        date: "2026-09-30",
        service: "Tax",
        tags: {},
        currency: "USD",
        amount: 7.25,
        chargeType: "tax",
      },
    ]);
    expect(invoiceToRows({ ...closed, statusName: "PENDING" }, range)).toEqual([]);
  });
});

describe("fetchAtlasCostData", () => {
  it("reads the pending invoice and the closed invoices that overlap", async () => {
    const closed: Invoice = {
      id: "inv-sep",
      statusName: "CLOSED",
      startDate: "2026-09-01T00:00:00Z",
      endDate: "2026-10-01T00:00:00Z",
      lineItems: [
        {
          sku: "ATLAS_AWS_STORAGE_PROVISIONED",
          groupId: "g1",
          clusterName: "main",
          startDate: "2026-09-15T00:00:00Z",
          endDate: "2026-09-16T00:00:00Z",
          totalPriceCents: 100,
        },
      ],
    };
    const { http, calls } = makeHttp((call) => {
      if (call.path.endsWith("/invoices/pending")) return { results: [pending] };
      if (call.path.includes("/invoices?")) {
        return {
          results: [
            { id: "inv-oct", startDate: pending.startDate, endDate: pending.endDate },
            { id: "inv-sep", startDate: closed.startDate, endDate: closed.endDate },
            { id: "inv-aug", startDate: "2026-08-01T00:00:00Z", endDate: "2026-09-01T00:00:00Z" },
          ],
        };
      }
      if (call.path.endsWith("/invoices/inv-sep")) return closed;
      throw new Error(`unexpected ${call.path}`);
    });
    const rows = await fetchAtlasCostData(ctxWith(http), "org1", range);
    expect(rows.some((r) => r.date === "2026-09-15" && r.service === "Storage")).toBe(true);
    expect(rows.some((r) => r.service === "Clusters")).toBe(true);
    // Pending is not re-fetched by id; August does not overlap.
    expect(calls.map((c) => c.path.split("?")[0])).toEqual([
      "/api/atlas/v2/orgs/org1/invoices/pending",
      "/api/atlas/v2/orgs/org1/invoices",
      "/api/atlas/v2/orgs/org1/invoices/inv-sep",
    ]);
  });

  it("turns a permission error into a setup error naming the billing role", async () => {
    const { http } = makeHttp(() => reply({ status: 403, body: {} }));
    const err = (await fetchAtlasCostData(ctxWith(http), "org1", range).catch(
      (e: unknown) => e,
    )) as CostSetupError;
    expect(err).toBeInstanceOf(CostSetupError);
    expect(err.message).toMatch(/Billing Viewer/);
  });
});

describe("summaries and rates", () => {
  it("summarizes the pending invoice by service, project and cluster", () => {
    const s = summarizeInvoice(pending);
    expect(s.month).toBe("2026-10");
    expect(s.totalCents).toBe(3888 + 150 + 400 - 1000);
    expect(s.byService[0]).toEqual({ service: "Clusters", cents: 3888 });
    expect(s.byCluster).toEqual([{ cluster: "main", project: "Prod", cents: 4038 }]);
  });

  it("extracts hourly instance rates by region and tier", () => {
    const rates = instanceRates([pending], (g, c) =>
      g === "g1" && c === "main" ? "US_EAST_1" : undefined,
    );
    expect([...rates]).toEqual([["US_EAST_1|M30", 0.54]]);
  });
});
