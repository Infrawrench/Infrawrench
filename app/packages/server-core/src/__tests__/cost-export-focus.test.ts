import { describe, it, expect, vi } from "vitest";

// The mapping is pure; only `loadFocusLookups` touches Postgres, and these
// tests build the lookups by hand.
vi.mock("../db/client", () => ({ db: {} }));
import { FOCUS_1_3_COLUMNS, FOCUS_CUSTOM_COLUMNS } from "@infrawrench/client-core";
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
  FOCUS_OUTPUT_COLUMNS,
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
    expect(FOCUS_OUTPUT_COLUMNS).toEqual([...FOCUS_1_3_COLUMNS, ...FOCUS_CUSTOM_COLUMNS]);
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
    const row = toFocusRow(raw(), lookups(), stamp);
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
    );
    expect(row.EffectiveCost).toBe(-5);
    expect(row.ListCost).toBe(-5);
  });

  it("writes nulls rather than empty strings for absent values", () => {
    const row = toFocusRow(
      raw({ region: "", resource_id: "", tags: {}, usage_amount: 0, usage_unit: "" }),
      lookups(),
      stamp,
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
    );
    expect(row.ServiceProviderName).toBe("snowflake-invoices");
    expect(row.BillingAccountName).toBe("snowflake-invoices");
  });

  it("rolls the billing period over a year boundary", () => {
    const row = toFocusRow(raw({ day: "2026-12-31" }), lookups(), stamp);
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
    const row = toFocusRow(raw(), lookups(), stamp);
    const csv = await collect(toFocusCsv(rows(row)));
    const [header, line] = csv.trimEnd().split("\n");
    expect(header).toBe(FOCUS_OUTPUT_COLUMNS.join(","));
    expect(line).toContain('"{""team"":""platform""}"');
    expect(line).toContain(",,"); // ChargeClass null
  });

  it("writes NDJSON nulls as JSON null", async () => {
    const row = toFocusRow(raw(), lookups(), stamp);
    const out = JSON.parse((await collect(toFocusNdjson(rows(row)))).trim()) as FocusRow;
    expect(out.ChargeClass).toBeNull();
    expect(Object.keys(out)).toEqual([...FOCUS_OUTPUT_COLUMNS]);
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
  it("only use FOCUS 1.3 category/subcategory pairs", () => {
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
