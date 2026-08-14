/**
 * Integration tests for the cost and network-flow SQL against a real
 * ClickHouse. The unit suites (billing-rules-sql, cost-reconcile,
 * cost-export-run, …) run this SQL through the fake driver and assert on its
 * text; here the same production modules execute against a real server, which
 * is the only place a query that renders fine but doesn't parse — or parses
 * but reads the wrong column — can fail.
 *
 * Same rules as clickhouse.test.ts: skipped unless CLICKHOUSE_METRICS_* is
 * set, scratch servers only, rows written under a random per-run org and
 * deleted best-effort afterwards.
 */
import { randomUUID } from "node:crypto";
import { compileBillingRules, type BillingRule } from "@infrawrench/client-core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { getClickHouseClient, isClickHouseConfigured } from "../../clickhouse/client";
import {
  getCommitmentCoverageCells,
  getAccountDataDays,
  getCommitmentDeliveredTotals,
  getUncoveredDailySpend,
} from "../../clickhouse/commitment-readers";
import {
  getCostCoverage,
  getCostDimensionValues,
  getCostTagKeys,
  getResourceCostTotals,
  getShowbackSpend,
  getUntaggedSpend,
  queryCosts,
  type CostSeriesGroup,
} from "../../clickhouse/cost-readers";
import { reconcileCollectedChunk } from "../../clickhouse/cost-reconcile";
import { hashTags, insertCostRows, type CostDailyRow } from "../../clickhouse/cost-writers";
import { migrateMetrics } from "../../clickhouse/migrate";
import {
  readNetworkFlowDaily,
  readNetworkFlowScopeTotals,
  readTopNetworkFlows,
} from "../../clickhouse/network-flow-readers";
import {
  insertNetworkFlowRows,
  type NetworkFlowClickHouseRow,
} from "../../clickhouse/network-flow-writers";
import { streamCostExportRows } from "../../cost-exports/rows";

const orgId = `test-org-${randomUUID()}`;
const accountId = `test-acct-${randomUUID()}`;
const meta = { organizationId: orgId, accountId, pluginId: "aws" };

const day1 = "2026-08-01";
const day2 = "2026-08-02";
const range = { from: day1, to: day2 };

function costRow(over: Partial<CostDailyRow>): CostDailyRow {
  return {
    organization_id: orgId,
    account_id: accountId,
    plugin_id: "aws",
    day: day1,
    service: "AmazonEC2",
    region: "us-east-1",
    resource_id: "i-aaa",
    tags: { env: "prod" },
    tags_hash: hashTags({ env: "prod" }),
    currency: "USD",
    amount: 0,
    usage_amount: 0,
    usage_unit: "",
    charge_type: "usage",
    amortized_amount: 0,
    amortized_reported: 0,
    commitment_id: "",
    ...over,
  };
}

// Plain usage on two days, plus one commitment-covered row sharing day1 —
// enough to give the coverage, showback and billing-rule SQL something to say.
const usageProd = costRow({ amount: 10, amortized_amount: 10 });
const usageDev = costRow({
  day: day2,
  resource_id: "i-bbb",
  tags: { env: "dev" },
  tags_hash: hashTags({ env: "dev" }),
  amount: 5,
  amortized_amount: 5,
});
const coveredProd = costRow({
  amount: 20,
  amortized_amount: 20,
  charge_type: "commitment_covered_usage",
  commitment_id: "cm-1",
  tags_hash: hashTags(
    { env: "prod" },
    { chargeType: "commitment_covered_usage", commitmentId: "cm-1" },
  ),
});

const flowRow: NetworkFlowClickHouseRow = {
  organization_id: orgId,
  account_id: accountId,
  plugin_id: "aws",
  day: day1,
  scope: "inter_region",
  direction: "egress",
  attribution: "exact",
  pair_hash: "12345",
  src_ref: "res-a",
  src_label: "vm-a",
  src_zone: "",
  src_region: "us-east-1",
  src_service: "ec2",
  src_resource_type_id: "aws-ec2",
  dst_ref: "res-b",
  dst_label: "bucket-b",
  dst_zone: "",
  dst_region: "eu-west-1",
  dst_service: "s3",
  dst_resource_type_id: "aws-s3",
  bytes: 1_073_741_824,
  packets: 1000,
  currency: "USD",
  rate_per_gb: 0.02,
  estimated_cost: 0.02,
};

function markup(percent: number, match: BillingRule["match"] = {}): BillingRule {
  return {
    id: `rule-${randomUUID()}`,
    name: "markup",
    description: null,
    enabled: true,
    priority: 0,
    match,
    adjustment: { kind: "percentage", percent },
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
}

function sumPoints(groups: CostSeriesGroup[], key: "points" | "rawPoints"): number {
  return groups.flatMap((g) => g[key] ?? []).reduce((total, p) => total + p.amount, 0);
}

async function waitFor<T>(read: () => Promise<T>, ready: (value: T) => boolean): Promise<T> {
  const deadline = Date.now() + 15_000;
  for (;;) {
    const value = await read();
    if (ready(value) || Date.now() > deadline) return value;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
}

describe.skipIf(!isClickHouseConfigured())("cost and flow SQL against a real server", () => {
  beforeAll(async () => {
    await migrateMetrics();
    // Both insert paths throw on failure (unlike the metric writers).
    await insertCostRows([usageProd, usageDev, coveredProd]);
    await insertNetworkFlowRows([flowRow]);
    await getClickHouseClient().command({ query: "SYSTEM FLUSH ASYNC INSERT QUEUE" });
    await waitFor(
      () => getResourceCostTotals(orgId, day1, day2),
      (totals) => new Set(totals.map((t) => t.resourceId)).size >= 2,
    );
    await waitFor(
      () => readNetworkFlowScopeTotals(orgId, range),
      (totals) => totals.length >= 1,
    );
  });

  afterAll(async () => {
    if (!isClickHouseConfigured()) return;
    const ch = getClickHouseClient();
    for (const table of ["cost_daily", "network_flow_daily"]) {
      try {
        await ch.command({
          query: `DELETE FROM ${table} WHERE organization_id = {org:String}`,
          query_params: { org: orgId },
        });
      } catch {
        // Best effort — the tables' TTLs expire test rows regardless.
      }
    }
    await ch.close();
  });

  const baseQuery = {
    from: day1,
    to: day2,
    binning: "daily" as const,
    groupBy: "account" as const,
    filters: [],
  };

  it("answers a cost query", async () => {
    const groups = await queryCosts(orgId, {
      ...baseQuery,
      chargeTypes: ["usage"],
    });
    expect(groups).toHaveLength(1);
    expect(groups[0]!.key).toBe(accountId);
    expect(groups[0]!.currency).toBe("USD");
    expect(sumPoints(groups, "points")).toBeCloseTo(15);
  });

  it("applies compiled billing rules in the query", async () => {
    const groups = await queryCosts(orgId, {
      ...baseQuery,
      chargeTypes: ["usage"],
      adjustments: compileBillingRules([markup(10)]),
    });
    expect(sumPoints(groups, "points")).toBeCloseTo(16.5);
    expect(sumPoints(groups, "rawPoints")).toBeCloseTo(15);
  });

  it("reads resource totals, dimension values and tag keys", async () => {
    const totals = await getResourceCostTotals(orgId, day1, day2);
    const dev = totals.find((t) => t.resourceId === "i-bbb");
    expect(dev).toMatchObject({ accountId, currency: "USD" });
    expect(dev!.amount).toBeCloseTo(5);

    expect(await getCostDimensionValues(orgId, "service")).toContain("AmazonEC2");
    expect(await getCostTagKeys(orgId)).toContain("env");

    const coverage = await getCostCoverage(orgId);
    expect(coverage.size).toBeGreaterThanOrEqual(1);
  });

  it("computes untagged spend for a missing tag key", async () => {
    const untagged = await getUntaggedSpend(orgId, ["team"], day1, day2);
    expect(untagged.totals).toHaveLength(1);
    expect(untagged.totals[0]!.untagged).toBeGreaterThan(0);
    expect(untagged.byKey.some((k) => k.key === "team")).toBe(true);
  });

  it("allocates showback spend to a matching cost centre", async () => {
    const spend = await getShowbackSpend(
      orgId,
      [{ costCentreId: "cc-1", match: { tagKey: "env", tagValue: "prod" } }],
      day1,
      day2,
    );
    const cc = spend.find((s) => s.costCentreId === "cc-1");
    expect(cc).toBeDefined();
    expect(cc!.amount).toBeGreaterThan(0);
  });

  it("classifies commitment coverage", async () => {
    const cells = await getCommitmentCoverageCells(orgId, day1, day2, [accountId]);
    const covered = cells.reduce((t, c) => t + c.covered_amount, 0);
    const uncovered = cells.reduce((t, c) => t + c.uncovered_amount, 0);
    expect(covered).toBeCloseTo(20);
    expect(uncovered).toBeCloseTo(15);

    const dataDays = await getAccountDataDays(orgId, day1, day2, [accountId]);
    expect(dataDays.get(accountId)).toContain(day1);

    const uncoveredDaily = await getUncoveredDailySpend(orgId, day1, day2, [accountId]);
    const dev = uncoveredDaily.find((r) => r.day === day2);
    expect(dev?.amount).toBeCloseTo(5);

    // No commitment fee rows are seeded — asserting the query itself runs.
    expect(Array.isArray(await getCommitmentDeliveredTotals(orgId, day1, day2, [accountId]))).toBe(
      true,
    );
  });

  it("tombstones superseded rows in reconcile", async () => {
    // A re-collection of day1 that no longer reports the covered row: the
    // stored covered row must come back zeroed, identity intact.
    const tombstones = await reconcileCollectedChunk(meta, { fromDate: day1, toDate: day1 }, [
      usageProd,
    ]);
    expect(tombstones.every((t) => t.amount === 0 && t.amortized_amount === 0)).toBe(true);
    const zeroedCovered = tombstones.find((t) => t.tags_hash === coveredProd.tags_hash);
    expect(zeroedCovered).toMatchObject({
      day: day1,
      resource_id: "i-aaa",
      charge_type: "commitment_covered_usage",
      commitment_id: "cm-1",
    });
  });

  it("streams cost export rows", async () => {
    const rows = [];
    for await (const row of streamCostExportRows({
      organizationId: orgId,
      from: day1,
      to: day2,
      dimensions: ["account", "service"],
      tagKeys: ["env"],
      filters: [],
    })) {
      rows.push(row);
    }
    expect(rows.length).toBeGreaterThan(0);
    const prod = rows.find((r) => r["tag_env"] === "prod");
    expect(prod).toMatchObject({ account: accountId, service: "AmazonEC2" });
    expect(Number(prod!["amount"])).toBeGreaterThan(0);
  });

  it("reads network flow totals, top pairs and daily points", async () => {
    const totals = await readNetworkFlowScopeTotals(orgId, range);
    expect(totals).toHaveLength(1);
    expect(totals[0]).toMatchObject({ scope: "inter_region", direction: "egress" });
    expect(totals[0]!.bytes).toBe(1_073_741_824);
    expect(totals[0]!.estimated_cost).toBeCloseTo(0.02);

    const pairs = await readTopNetworkFlows(orgId, range);
    expect(pairs).toHaveLength(1);
    expect(pairs[0]).toMatchObject({ src_ref: "res-a", dst_ref: "res-b" });

    const daily = await readNetworkFlowDaily(orgId, range);
    expect(daily.some((p) => p.day === day1 && p.bytes === 1_073_741_824)).toBe(true);
  });
});
