/**
 * The commitment report scan against a real Postgres: the statement
 * `commitment-report-sql.test.ts` pins by its text has to parse, read the
 * right columns and add up to the numbers the metric definitions expect
 * (`client-core/src/commitment-reports.ts`).
 *
 * Same rules as analytics.test.ts: skipped unless DATABASE_URL is set
 * (`pnpm test:analytics`), migrations already applied, scratch databases only,
 * rows written under a random per-run org and deleted afterwards. Every import
 * is dynamic: `db/client` throws on first use without DATABASE_URL.
 */
import { randomUUID } from "node:crypto";
import {
  buildCommitmentReport,
  commitmentReportBucketOf,
  COMMITMENT_REPORT_ON_DEMAND_KEY,
  COMMITMENT_REPORT_UNATTRIBUTED_KEY,
} from "@infrawrench/client-core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { CostDailyRow } from "../../analytics/cost-writers";

const configured = !!process.env["DATABASE_URL"];

const orgId = `test-org-${randomUUID()}`;
const accountId = `test-acct-${randomUUID()}`;
const day = new Date(Date.now() - 10 * 86_400_000).toISOString().slice(0, 10);
const range = { from: day, to: day };

describe.skipIf(!configured)("commitment report scan against a real server", () => {
  let db: typeof import("../../db/client").db;
  let schema: typeof import("../../analytics/schema");
  let readers: typeof import("../../analytics/commitment-readers");

  beforeAll(async () => {
    ({ db } = await import("../../db/client"));
    schema = await import("../../analytics/schema");
    readers = await import("../../analytics/commitment-readers");
    const writers = await import("../../analytics/cost-writers");

    const row = (resourceId: string, over: Partial<CostDailyRow>): CostDailyRow => {
      const chargeType = over.charge_type ?? "usage";
      const commitmentId = over.commitment_id ?? "";
      return {
        organization_id: orgId,
        account_id: accountId,
        plugin_id: "aws",
        day,
        service: "AmazonEC2",
        region: "us-east-1",
        resource_id: resourceId,
        tags: {},
        tags_hash: writers.hashTags({}, { chargeType, commitmentId }),
        currency: "USD",
        amount: 0,
        usage_amount: 0,
        usage_unit: "",
        charge_type: chargeType,
        amortized_amount: 0,
        amortized_reported: 1,
        commitment_id: commitmentId,
        list_amount: 0,
        list_reported: 0,
        blended_amount: 0,
        blended_reported: 0,
        on_demand_amount: 0,
        on_demand_reported: 0,
        ...over,
      };
    };

    await writers.insertCostRows([
      // On demand, in a cell a commitment also covered: eligible.
      row("i-ondemand", { amount: 100, amortized_amount: 100 }),
      // On demand where nothing was ever covered: not eligible.
      row("bucket", { service: "AmazonS3", amount: 50, amortized_amount: 50 }),
      // Covered by sp-1, cash zero, with an on-demand equivalent.
      row("i-covered", {
        charge_type: "commitment_covered_usage",
        commitment_id: "sp-1",
        amortized_amount: 80,
        on_demand_amount: 120,
        on_demand_reported: 1,
      }),
      // Covered, provider could not say by what, no on-demand equivalent.
      row("db-covered", {
        service: "AmazonRDS",
        region: "eu-west-1",
        charge_type: "commitment_covered_usage",
        amortized_amount: 30,
      }),
      // sp-1's unused fee on the amortized basis.
      row("sp-1-fee", {
        service: "ComputeSavingsPlans",
        charge_type: "commitment_fee",
        commitment_id: "sp-1",
        amount: 20,
        amortized_amount: 20,
      }),
      // A purchase with no amortized figure: cash, not waste. Never counted.
      row("ri-2-fee", {
        service: "AmazonEC2",
        charge_type: "commitment_fee",
        commitment_id: "ri-2",
        amount: 1000,
        amortized_reported: 0,
      }),
      // Neither consumption nor a fee.
      row("tax", { charge_type: "tax", amount: 7, amortized_amount: 7 }),
    ]);
  });

  afterAll(async () => {
    if (!configured) return;
    const { eq } = await import("drizzle-orm");
    await db.delete(schema.costDaily).where(eq(schema.costDaily.organization_id, orgId));
    await db.$client.end();
  });

  const query = (over: Partial<Parameters<typeof readers.getCommitmentReportCells>[1]> = {}) =>
    readers.getCommitmentReportCells(orgId, {
      ...range,
      bucket: "monthly",
      split: "none",
      accountIds: [accountId],
      commitmentIds: null,
      ...over,
    });

  it("sums the seven amortized inputs", async () => {
    expect(await query()).toEqual([
      {
        bucket: commitmentReportBucketOf(day, "monthly"),
        group_key: "",
        currency: "USD",
        covered: 110,
        covered_all: 110,
        unused: 20,
        uncovered: 150,
        uncovered_eligible: 100,
        covered_on_demand: 120,
        covered_measured: 80,
      },
    ]);
  });

  it("narrows the commitment side to selected holdings and never the uncovered side", async () => {
    const [cell] = await query({ commitmentIds: ["sp-1"] });
    expect(cell).toMatchObject({ covered: 80, covered_all: 110, unused: 20, uncovered: 150 });
    const [none] = await query({ commitmentIds: [] });
    expect(none).toMatchObject({ covered: 0, covered_all: 110, unused: 0, uncovered: 150 });
  });

  it("keys a commitment split by holding, unattributed and on demand", async () => {
    const cells = await query({ split: "commitment", bucket: "weekly" });
    const byKey = new Map(cells.map((c) => [c.group_key, c]));
    expect([...byKey.keys()].sort()).toEqual(
      [COMMITMENT_REPORT_ON_DEMAND_KEY, COMMITMENT_REPORT_UNATTRIBUTED_KEY, "sp-1"].sort(),
    );
    expect(byKey.get("sp-1")).toMatchObject({ covered: 80, unused: 20, uncovered: 0 });
    expect(byKey.get(COMMITMENT_REPORT_UNATTRIBUTED_KEY)).toMatchObject({ covered: 30 });
    expect(byKey.get(COMMITMENT_REPORT_ON_DEMAND_KEY)).toMatchObject({
      uncovered: 150,
      uncovered_eligible: 100,
    });
    expect(cells[0]!.bucket).toBe(commitmentReportBucketOf(day, "weekly"));
  });

  it("filters by service on both halves of the scan, and splits by it", async () => {
    const [ec2] = await query({ services: ["AmazonEC2"] });
    expect(ec2).toMatchObject({ covered: 80, unused: 0, uncovered: 100, uncovered_eligible: 100 });
    const byService = await query({ split: "service", bucket: "quarterly" });
    expect(byService.map((c) => c.group_key).sort()).toEqual(
      ["AmazonEC2", "AmazonRDS", "AmazonS3", "ComputeSavingsPlans"].sort(),
    );
  });

  it("feeds the metric definitions the numbers they were written for", async () => {
    const cells = (await query()).map((r) => ({
      bucket: r.bucket,
      groupKey: r.group_key,
      currency: r.currency,
      covered: r.covered,
      coveredAll: r.covered_all,
      unused: r.unused,
      uncovered: r.uncovered,
      uncoveredEligible: r.uncovered_eligible,
      coveredOnDemand: r.covered_on_demand,
      coveredMeasured: r.covered_measured,
    }));
    const result = buildCommitmentReport(cells, {
      ...range,
      granularity: "monthly",
      groupBy: "none",
    });
    const m = result.overall[0]!.total.metrics;
    expect(m.coverage).toBeCloseTo(110 / 260, 12);
    expect(m.eligibleCoverage).toBeCloseTo(110 / 210, 12);
    expect(m.utilization).toBeCloseTo(110 / 130, 12);
    expect(m.netSavings).toBeCloseTo(120 - 80 - 20, 12);
    expect(result.notices).toContain("partial_savings_measurement");
  });

  it("lists the services and regions with consumption", async () => {
    expect(await readers.getCommitmentReportDimensionValues(orgId, day, day, [accountId])).toEqual({
      services: ["AmazonEC2", "AmazonRDS", "AmazonS3"],
      regions: ["eu-west-1", "us-east-1"],
    });
  });
});
