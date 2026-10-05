import { describe, it, expect, vi } from "vitest";

// The mapping is pure; only `loadFocusLookups` touches Postgres, and these
// tests build the lookups by hand.
vi.mock("../db/client", () => ({ db: {} }));
import {
  FOCUS_1_3_COLUMNS,
  FOCUS_1_4_COLUMNS,
  FOCUS_CUSTOM_COLUMNS,
  focusVersionOfSchema,
} from "@infrawrench/client-core";
import {
  FOCUS_SERVICE_CATEGORIES,
  isValidFocusClassification,
  resolveFocusService,
} from "@infrawrench/plugin-base";
import {
  buildFocusExportQuery,
  emptyFocusLookups,
  focusChargeCategory,
  focusChargeFrequency,
  focusNumber,
  focusOutputColumns,
  toFocusCsv,
  toFocusNdjson,
  toFocusRow,
  type FocusRow,
  type FocusSourceRow,
} from "../cost-exports/focus";
import { BUNDLED_PLUGINS } from "../plugin-loader";

const stamp = { exportedAt: "2026-10-04T04:00:00.000Z", collectionWatermark: "2026-10-02" };

function raw(overrides: Partial<FocusSourceRow> = {}): FocusSourceRow {
  return {
    day: "2026-09-30",
    account_id: "acc-1",
    plugin_id: "aws",
    service: "Amazon Elastic Compute Cloud - Compute",
    region: "eu-central-1",
    resource_id: "i-0abc",
    tags: { team: "platform" },
    currency: "USD",
    charge_type: "usage",
    commitment_id: "",
    billed: 12.5,
    effective: 12.5,
    usage_amount: 24,
    usage_unit: "Hrs",
    ...overrides,
  };
}

function lookups() {
  const l = emptyFocusLookups();
  const aws = BUNDLED_PLUGINS.find((p) => p.manifest.id === "aws")!;
  l.providers.set("aws", {
    name: "AWS",
    focus: aws.manifest.costs?.focus,
    estimated: false,
    resourceTypeNames: new Map([["ec2-instance", "EC2 Instance"]]),
  });
  l.accountNames.set("acc-1", "Production");
  l.resources.set("acc-1\u0000i-0abc", { name: "web-1", type: "EC2 Instance" });
  l.commitments.set("arn:aws:savingsplans::1:savingsplan/abc", {
    kind: "savings_plan",
    description: "Compute SP 1y",
  });
  return l;
}

async function collect(body: AsyncIterable<string>): Promise<string> {
  let out = "";
  for await (const piece of body) out += piece;
  return out;
}

async function* rows(...list: FocusRow[]): AsyncGenerator<FocusRow> {
  for (const r of list) yield r;
}

describe("FOCUS column layout", () => {
  it("writes every FOCUS column before the x_ custom columns, unmixed", () => {
    expect(focusOutputColumns("1.3")).toEqual([...FOCUS_1_3_COLUMNS, ...FOCUS_CUSTOM_COLUMNS]);
    expect(focusOutputColumns("1.4")).toEqual([...FOCUS_1_4_COLUMNS, ...FOCUS_CUSTOM_COLUMNS]);
    expect(FOCUS_CUSTOM_COLUMNS.every((c) => c.startsWith("x_"))).toBe(true);
    expect(FOCUS_1_3_COLUMNS.some((c) => c.startsWith("x_"))).toBe(false);
  });

  it("includes every Mandatory FOCUS 1.3 column", () => {
    const mandatory = [
      "BilledCost",
      "BillingAccountId",
      "BillingAccountName",
      "BillingCurrency",
      "BillingPeriodEnd",
      "BillingPeriodStart",
      "ChargeCategory",
      "ChargeClass",
      "ChargeDescription",
      "ChargePeriodEnd",
      "ChargePeriodStart",
      "ContractedCost",
      "EffectiveCost",
      "HostProviderName",
      "InvoiceIssuerName",
      "ListCost",
      "PricingQuantity",
      "PricingUnit",
      "ProviderName",
      "PublisherName",
      "ServiceCategory",
      "ServiceName",
      "ServiceProviderName",
    ];
    for (const column of mandatory) expect(FOCUS_1_3_COLUMNS).toContain(column);
  });

  it("drops only the columns FOCUS 1.4 removed, keeping the order", () => {
    expect(FOCUS_1_4_COLUMNS).toEqual(
      FOCUS_1_3_COLUMNS.filter((c) => c !== "ProviderName" && c !== "PublisherName"),
    );
    // 1.4 made no column Mandatory that 1.3 did not already require.
    expect(FOCUS_1_4_COLUMNS).toContain("ServiceProviderName");
    expect(FOCUS_1_4_COLUMNS).toContain("HostProviderName");
  });

  it("reads the FOCUS version out of a schema value", () => {
    expect(focusVersionOfSchema("focus-1.4")).toBe("1.4");
    expect(focusVersionOfSchema("focus-1.3")).toBe("1.3");
    expect(focusVersionOfSchema("native")).toBeNull();
    expect(focusVersionOfSchema("focus-9.9")).toBeNull();
  });
});

describe("charge mapping", () => {
  it("folds our charge types onto the five FOCUS categories", () => {
    expect(focusChargeCategory("usage")).toBe("Usage");
    expect(focusChargeCategory("commitment_covered_usage")).toBe("Usage");
    expect(focusChargeCategory("commitment_discount")).toBe("Usage");
    expect(focusChargeCategory("commitment_fee")).toBe("Purchase");
    expect(focusChargeCategory("support")).toBe("Purchase");
    expect(focusChargeCategory("tax")).toBe("Tax");
    expect(focusChargeCategory("credit")).toBe("Credit");
    expect(focusChargeCategory("refund")).toBe("Credit");
    expect(focusChargeCategory("adjustment")).toBe("Adjustment");
    expect(focusChargeCategory("other")).toBe("Adjustment");
  });

  it("never marks a Purchase as Usage-Based", () => {
    expect(focusChargeFrequency("commitment_fee")).toBe("Recurring");
    expect(focusChargeFrequency("usage")).toBe("Usage-Based");
    expect(focusChargeFrequency("tax")).toBe("One-Time");
  });
});

describe("toFocusRow", () => {
  it("maps an on-demand usage row", () => {
    const row = toFocusRow(raw(), lookups(), stamp, "1.3");
    expect(row).toMatchObject({
      BilledCost: 12.5,
      EffectiveCost: 12.5,
      ListCost: 12.5,
      ContractedCost: 12.5,
      BillingAccountId: "acc-1",
      BillingAccountName: "Production",
      BillingCurrency: "USD",
      BillingPeriodStart: "2026-09-01T00:00:00Z",
      BillingPeriodEnd: "2026-10-01T00:00:00Z",
      ChargePeriodStart: "2026-09-30T00:00:00Z",
      ChargePeriodEnd: "2026-10-01T00:00:00Z",
      ChargeCategory: "Usage",
      ChargeClass: null,
      ChargeFrequency: "Usage-Based",
      ServiceName: "Amazon Elastic Compute Cloud - Compute",
      ServiceCategory: "Compute",
      ServiceSubcategory: "Virtual Machines",
      ServiceProviderName: "AWS",
      HostProviderName: "AWS",
      InvoiceIssuerName: "AWS",
      ProviderName: "AWS",
      PublisherName: "AWS",
      RegionId: "eu-central-1",
      RegionName: "eu-central-1",
      ResourceId: "i-0abc",
      ResourceName: "web-1",
      Tags: '{"team":"platform"}',
      PricingQuantity: null,
      PricingUnit: null,
      CommitmentDiscountId: null,
      CommitmentDiscountStatus: null,
      x_InfrawrenchProviderId: "aws",
      x_InfrawrenchChargeType: "usage",
      x_UsageQuantity: 24,
      x_UsageUnit: "Hrs",
      x_ResourceType: "EC2 Instance",
      x_CostEstimated: false,
      x_ExportedAt: stamp.exportedAt,
      x_CollectionWatermark: "2026-10-02",
    });
  });

  it("writes commitment-covered usage as billed 0, effective amortized, status Used", () => {
    const row = toFocusRow(
      raw({
        charge_type: "commitment_covered_usage",
        commitment_id: "arn:aws:savingsplans::1:savingsplan/abc",
        billed: 0,
        effective: 8.25,
      }),
      lookups(),
      stamp,
      "1.3",
    );
    expect(row).toMatchObject({
      BilledCost: 0,
      EffectiveCost: 8.25,
      ChargeCategory: "Usage",
      CommitmentDiscountId: "arn:aws:savingsplans::1:savingsplan/abc",
      CommitmentDiscountCategory: "Spend",
      CommitmentDiscountType: "Savings Plan",
      CommitmentDiscountName: "Compute SP 1y",
      CommitmentDiscountStatus: "Used",
      ResourceId: "i-0abc",
    });
  });

  it("uses the commitment id as the resource of a purchase row, with a null status", () => {
    const row = toFocusRow(
      raw({
        charge_type: "commitment_fee",
        commitment_id: "ri-123",
        resource_id: "",
        billed: 100,
        effective: 0,
      }),
      lookups(),
      stamp,
      "1.3",
    );
    expect(row).toMatchObject({
      ChargeCategory: "Purchase",
      ChargeFrequency: "Recurring",
      BilledCost: 100,
      EffectiveCost: 0,
      ListCost: 100,
      ResourceId: "ri-123",
      CommitmentDiscountCategory: "Usage",
      CommitmentDiscountType: "Reservation",
      CommitmentDiscountStatus: null,
    });
  });

  it("forces EffectiveCost to BilledCost on a credit", () => {
    const row = toFocusRow(
      raw({ charge_type: "credit", billed: -5, effective: 0 }),
      lookups(),
      stamp,
      "1.3",
    );
    expect(row.EffectiveCost).toBe(-5);
    expect(row.ListCost).toBe(-5);
  });

  it("writes nulls rather than empty strings for absent values", () => {
    const row = toFocusRow(
      raw({ region: "", resource_id: "", tags: {}, usage_amount: 0, usage_unit: "" }),
      lookups(),
      stamp,
      "1.3",
    );
    expect(row.RegionId).toBeNull();
    expect(row.RegionName).toBeNull();
    expect(row.ResourceId).toBeNull();
    expect(row.ResourceName).toBeNull();
    expect(row.Tags).toBeNull();
    expect(row.x_UsageQuantity).toBeNull();
    expect(row.x_UsageUnit).toBeNull();
  });

  it("names an API-pushed row's provider after its source", () => {
    const row = toFocusRow(
      raw({
        plugin_id: "external",
        account_id: "external:snowflake-invoices",
        service: "Warehouse credits",
        tags: { "infrawrench:source": "snowflake-invoices" },
      }),
      lookups(),
      stamp,
      "1.3",
    );
    expect(row.ServiceProviderName).toBe("snowflake-invoices");
    expect(row.BillingAccountName).toBe("snowflake-invoices");
  });

  it("keeps a tax row's amortized effective cost in 1.3", () => {
    const row = toFocusRow(
      raw({ charge_type: "tax", billed: 10, effective: 8 }),
      lookups(),
      stamp,
      "1.3",
    );
    expect(row.EffectiveCost).toBe(8);
  });

  it("forces EffectiveCost to BilledCost on a tax row in 1.4", () => {
    const row = toFocusRow(
      raw({ charge_type: "tax", billed: 10, effective: 8 }),
      lookups(),
      stamp,
      "1.4",
    );
    expect(row.ChargeCategory).toBe("Tax");
    expect(row.EffectiveCost).toBe(10);
    expect(row.ListCost).toBe(10);
  });

  it("maps usage the same way in 1.3 and 1.4", () => {
    const v13 = toFocusRow(raw(), lookups(), stamp, "1.3");
    const v14 = toFocusRow(raw(), lookups(), stamp, "1.4");
    expect(v14).toEqual(v13);
  });

  it("rolls the billing period over a year boundary", () => {
    const row = toFocusRow(raw({ day: "2026-12-31" }), lookups(), stamp, "1.3");
    expect(row.BillingPeriodStart).toBe("2026-12-01T00:00:00Z");
    expect(row.BillingPeriodEnd).toBe("2027-01-01T00:00:00Z");
    expect(row.ChargePeriodEnd).toBe("2027-01-01T00:00:00Z");
  });
});

describe("focusNumber", () => {
  it("writes E notation without a plus sign", () => {
    expect(focusNumber(1e-7)).toBe("1E-7");
    expect(focusNumber(1e21)).toBe("1E21");
    expect(focusNumber("2.5")).toBe(2.5);
    expect(focusNumber(Number.NaN)).toBe(0);
  });
});

describe("serialisation", () => {
  it("writes CSV nulls as empty fields and quotes the Tags JSON", async () => {
    const row = toFocusRow(raw(), lookups(), stamp, "1.3");
    const csv = await collect(toFocusCsv(rows(row), "1.3"));
    const [header, line] = csv.trimEnd().split("\n");
    expect(header).toBe(focusOutputColumns("1.3").join(","));
    expect(line).toContain('"{""team"":""platform""}"');
    expect(line).toContain(",,"); // ChargeClass null
  });

  it("writes NDJSON nulls as JSON null", async () => {
    const row = toFocusRow(raw(), lookups(), stamp, "1.3");
    const out = JSON.parse((await collect(toFocusNdjson(rows(row), "1.3"))).trim()) as FocusRow;
    expect(out.ChargeClass).toBeNull();
    expect(Object.keys(out)).toEqual([...focusOutputColumns("1.3")]);
  });

  it("leaves ProviderName and PublisherName out of a 1.4 file", async () => {
    const row = toFocusRow(raw(), lookups(), stamp, "1.4");
    const csv = await collect(toFocusCsv(rows(row), "1.4"));
    const header = csv.split("\n")[0]!.split(",");
    expect(header).not.toContain("ProviderName");
    expect(header).not.toContain("PublisherName");
    expect(header).toContain("ServiceProviderName");
    const out = JSON.parse((await collect(toFocusNdjson(rows(row), "1.4"))).trim()) as FocusRow;
    expect(Object.keys(out)).toEqual([...focusOutputColumns("1.4")]);
    expect(out).not.toHaveProperty("ProviderName");
  });
});

describe("buildFocusExportQuery", () => {
  it("keeps the full row grain and orders deterministically", () => {
    const sql = buildFocusExportQuery({
      organizationId: "org-1",
      from: "2026-09-01",
      to: "2026-09-30",
      filters: [{ dimension: "provider", op: "in", values: ["aws"] }],
      chargeTypes: ["usage"],
    });
    expect(sql).toContain("group by");
    expect(sql).toContain("`cost_daily`.`charge_type` asc");
    expect(sql).toContain("`cost_daily`.`tags_hash`, ");
    expect(sql).toContain("order by");
    expect(sql).toMatch(/final/i);
  });
});

describe("plugin FOCUS declarations", () => {
  it("only use FOCUS category/subcategory pairs (identical in 1.3 and 1.4)", () => {
    for (const plugin of BUNDLED_PLUGINS) {
      const focus = plugin.manifest.costs?.focus;
      if (!focus) continue;
      for (const rule of focus.services ?? []) {
        expect(isValidFocusClassification(rule), `${plugin.manifest.id}: ${rule.match}`).toBe(true);
      }
      if (focus.default) expect(isValidFocusClassification(focus.default)).toBe(true);
    }
  });

  it("always resolves to an allowed category", () => {
    for (const service of ["", "Mystery line", "Managed PostgreSQL", "Egress bandwidth"]) {
      const c = resolveFocusService(service, undefined);
      expect(FOCUS_SERVICE_CATEGORIES).toContain(c.category);
      expect(isValidFocusClassification(c)).toBe(true);
    }
  });

  it("classifies the specific rule before the general one", () => {
    const aws = BUNDLED_PLUGINS.find((p) => p.manifest.id === "aws")!.manifest.costs?.focus;
    expect(resolveFocusService("Amazon Elastic Container Registry (ECR)", aws).category).toBe(
      "Developer Tools",
    );
    expect(resolveFocusService("Amazon Simple Storage Service", aws).subcategory).toBe(
      "Object Storage",
    );
  });
});
