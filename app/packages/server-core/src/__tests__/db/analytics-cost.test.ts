/**
 * Integration tests for the cost, network-flow and AI attribution SQL against
 * a real Postgres. The unit suites (billing-rules-sql, cost-reconcile,
 * cost-export-run, …) run this SQL through the recording driver and assert on
 * its text; here the same production modules execute against a real server,
 * which is the only place a query that renders fine but doesn't parse (or
 * parses but reads the wrong column) can fail, and the only place the upsert's
 * conflict handling actually runs.
 *
 * Same rules as analytics.test.ts: skipped unless DATABASE_URL is set
 * (`pnpm test:analytics`), migrations already applied, scratch databases only,
 * rows written under random per-run orgs and deleted afterwards. Every import
 * is dynamic: `db/client` throws on first use without DATABASE_URL, and static
 * imports would run even for a skipped suite.
 */
import { randomUUID } from "node:crypto";
import { compileBillingRules, type BillingRule } from "@infrawrench/client-core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { CostSeriesGroup } from "../../analytics/cost-readers";
import type { CostDailyRow } from "../../analytics/cost-writers";

type FlowRow = Parameters<
  typeof import("../../analytics/network-flow-writers").insertNetworkFlowRows
>[0][number];

const configured = !!process.env["DATABASE_URL"];

const orgId = `test-org-${randomUUID()}`;
const accountId = `test-acct-${randomUUID()}`;
const meta = { organizationId: orgId, accountId, pluginId: "aws" };
/** The write-path tests' own org, so their rows never reach the readers' totals. */
const writeOrgId = `test-org-${randomUUID()}`;
/** The trial-merge test's two orgs. */
const trialOrgId = `test-org-${randomUUID()}`;
const targetOrgId = `test-org-${randomUUID()}`;
const ALL_ORGS = [orgId, writeOrgId, trialOrgId, targetOrgId];

// Relative to today: `network_flow_daily` is retained 90 days after its `day`
// (`db/analytics-schema.ts`), so a fixed date would eventually age out.
const daysAgo = (n: number) => new Date(Date.now() - n * 86_400_000).toISOString().slice(0, 10);
const day1 = daysAgo(8);
const day2 = daysAgo(7);
const range = { from: day1, to: day2 };

describe.skipIf(!configured)("cost and flow SQL against a real server", () => {
  let db: typeof import("../../db/client").db;
  let schema: typeof import("../../analytics/schema");
  let writers: typeof import("../../analytics/cost-writers");
  let readers: typeof import("../../analytics/cost-readers");
  let commitments: typeof import("../../analytics/commitment-readers");
  let reconcile: typeof import("../../analytics/cost-reconcile");
  let customStore: typeof import("../../analytics/custom-cost-store");
  let aiStore: typeof import("../../analytics/ai-attribution-store");
  let flowWriters: typeof import("../../analytics/network-flow-writers");
  let flowReaders: typeof import("../../analytics/network-flow-readers");
  let exportRows: typeof import("../../cost-exports/rows");

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
      tags_hash: writers.hashTags({ env: "prod" }),
      currency: "USD",
      amount: 0,
      usage_amount: 0,
      usage_unit: "",
      charge_type: "usage",
      amortized_amount: 0,
      amortized_reported: 0,
      commitment_id: "",
      list_amount: 0,
      list_reported: 0,
      blended_amount: 0,
      blended_reported: 0,
      on_demand_amount: 0,
      on_demand_reported: 0,
      ...over,
    };
  }

  // Plain usage on two days, plus one commitment-covered row sharing day1:
  // enough to give the coverage, showback and billing-rule SQL something to
  // say. Blended: the 20 of covered usage and the 10 on demand share one rate,
  // so the pool's 30 is re-split 12 / 18. usageDev carries no blended opinion.
  let usageProd: CostDailyRow;
  let usageDev: CostDailyRow;
  let coveredProd: CostDailyRow;

  const flowRow: FlowRow = {
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
    method: "",
    src_network: "vpc-a",
    dst_network: "",
  };

  /** Every stored `cost_daily` row of an org, keyed by resource id. */
  async function storedCost(organizationId: string) {
    const { eq } = await import("drizzle-orm");
    const rows = await db
      .select()
      .from(schema.costDaily)
      .where(eq(schema.costDaily.organization_id, organizationId));
    return rows;
  }

  beforeAll(async () => {
    ({ db } = await import("../../db/client"));
    schema = await import("../../analytics/schema");
    writers = await import("../../analytics/cost-writers");
    readers = await import("../../analytics/cost-readers");
    commitments = await import("../../analytics/commitment-readers");
    reconcile = await import("../../analytics/cost-reconcile");
    customStore = await import("../../analytics/custom-cost-store");
    aiStore = await import("../../analytics/ai-attribution-store");
    flowWriters = await import("../../analytics/network-flow-writers");
    flowReaders = await import("../../analytics/network-flow-readers");
    exportRows = await import("../../cost-exports/rows");

    usageProd = costRow({
      amount: 10,
      amortized_amount: 10,
      blended_amount: 12,
      blended_reported: 1,
    });
    usageDev = costRow({
      day: day2,
      resource_id: "i-bbb",
      tags: { env: "dev" },
      tags_hash: writers.hashTags({ env: "dev" }),
      amount: 5,
      amortized_amount: 5,
    });
    coveredProd = costRow({
      amount: 20,
      amortized_amount: 20,
      charge_type: "commitment_covered_usage",
      commitment_id: "cm-1",
      blended_amount: 18,
      blended_reported: 1,
      tags_hash: writers.hashTags(
        { env: "prod" },
        { chargeType: "commitment_covered_usage", commitmentId: "cm-1" },
      ),
    });

    // Both insert paths throw on failure (unlike the metric writers).
    await writers.insertCostRows([usageProd, usageDev, coveredProd]);
    await flowWriters.insertNetworkFlowRows([flowRow]);
  });

  afterAll(async () => {
    if (!configured) return;
    const { inArray } = await import("drizzle-orm");
    for (const table of [
      schema.metricPointsRaw,
      schema.metricPoints1m,
      schema.metricPoints1h,
      schema.costDaily,
      schema.networkFlowDaily,
      schema.aiRequestDaily,
      schema.aiCostAttributed,
    ]) {
      await db.delete(table).where(inArray(table.organization_id, ALL_ORGS));
    }
    await db.$client.end();
  });

  const baseQuery = {
    from: day1,
    to: day2,
    binning: "daily" as const,
    groupBy: "account" as const,
    filters: [],
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

  // ─── The write path ───────────────────────────────────────────────────────

  it("replaces a re-fetched row in place rather than adding to it", async () => {
    const first = costRow({ organization_id: writeOrgId, resource_id: "i-upsert", amount: 10 });
    await writers.insertCostRows([first]);
    await writers.insertCostRows([{ ...first, amount: 7, usage_amount: 3, usage_unit: "Hrs" }]);

    const stored = (await storedCost(writeOrgId)).filter((r) => r.resource_id === "i-upsert");
    expect(stored).toHaveLength(1);
    expect(stored[0]).toMatchObject({ amount: 7, usage_amount: 3, usage_unit: "Hrs" });
  });

  it("keeps the last of two rows with one key in a single write", async () => {
    // Postgres refuses one statement touching a key twice; the writer has to
    // collapse them first, keeping the later row as a re-fetch would.
    const row = costRow({ organization_id: writeOrgId, resource_id: "i-dup", amount: 1 });
    await writers.insertCostRows([row, { ...row, amount: 2 }]);

    const stored = (await storedCost(writeOrgId)).filter((r) => r.resource_id === "i-dup");
    expect(stored).toHaveLength(1);
    expect(stored[0]!.amount).toBe(2);
  });

  it("writes a chunk larger than one statement's parameter budget", async () => {
    const rows = Array.from({ length: 3_500 }, (_, i) =>
      costRow({ organization_id: writeOrgId, resource_id: `i-bulk-${i}`, amount: 1 }),
    );
    await writers.insertCostRows(rows);

    const stored = (await storedCost(writeOrgId)).filter((r) =>
      r.resource_id.startsWith("i-bulk-"),
    );
    expect(stored).toHaveLength(3_500);
  });

  it("round-trips the reported flags and the tags map", async () => {
    const [stored] = (await storedCost(orgId)).filter((r) => r.tags_hash === coveredProd.tags_hash);
    expect(stored).toMatchObject({
      day: day1,
      tags: { env: "prod" },
      charge_type: "commitment_covered_usage",
      commitment_id: "cm-1",
      blended_amount: 18,
      blended_reported: 1,
      amortized_reported: 0,
    });
  });

  // ─── The readers over what was written ────────────────────────────────────

  it("answers a cost query", async () => {
    const groups = await readers.queryCosts(orgId, {
      ...baseQuery,
      chargeTypes: ["usage"],
    });
    expect(groups).toHaveLength(1);
    expect(groups[0]!.key).toBe(accountId);
    expect(groups[0]!.currency).toBe("USD");
    expect(sumPoints(groups, "points")).toBeCloseTo(15);
  });

  it("sums the blended basis to the amortized total, falling back per row", async () => {
    const amortized = await readers.queryCosts(orgId, { ...baseQuery, costBasis: "amortized" });
    const blended = await readers.queryCosts(orgId, { ...baseQuery, costBasis: "blended" });
    // 12 + 18 blended on day1, plus usageDev's 5 read through the fallback.
    expect(sumPoints(blended, "points")).toBeCloseTo(35);
    expect(sumPoints(blended, "points")).toBeCloseTo(sumPoints(amortized, "points"));

    const usageOnly = await readers.queryCosts(orgId, {
      ...baseQuery,
      costBasis: "blended",
      chargeTypes: ["usage"],
    });
    expect(sumPoints(usageOnly, "points")).toBeCloseTo(17);
  });

  it("applies compiled billing rules in the query", async () => {
    const groups = await readers.queryCosts(orgId, {
      ...baseQuery,
      chargeTypes: ["usage"],
      adjustments: compileBillingRules([markup(10)]),
    });
    expect(sumPoints(groups, "points")).toBeCloseTo(16.5);
    expect(sumPoints(groups, "rawPoints")).toBeCloseTo(15);
  });

  it("reads resource totals, dimension values and tag keys", async () => {
    const totals = await readers.getResourceCostTotals(orgId, day1, day2);
    const dev = totals.find((t) => t.resourceId === "i-bbb");
    expect(dev).toMatchObject({ accountId, currency: "USD" });
    expect(dev!.amount).toBeCloseTo(5);

    expect(await readers.getCostDimensionValues(orgId, "service")).toContain("AmazonEC2");
    expect(await readers.getCostTagKeys(orgId)).toContain("env");

    const coverage = await readers.getCostCoverage(orgId);
    expect(coverage.size).toBeGreaterThanOrEqual(1);
  });

  it("computes untagged spend for a missing tag key", async () => {
    const untagged = await readers.getUntaggedSpend(orgId, ["team"], day1, day2);
    expect(untagged.totals).toHaveLength(1);
    expect(untagged.totals[0]!.untagged).toBeGreaterThan(0);
    expect(untagged.byKey.some((k) => k.key === "team")).toBe(true);
  });

  it("allocates showback spend to a matching cost centre", async () => {
    const spend = await readers.getShowbackSpend(
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
    const cells = await commitments.getCommitmentCoverageCells(orgId, day1, day2, [accountId]);
    const covered = cells.reduce((t, c) => t + c.covered_amount, 0);
    const uncovered = cells.reduce((t, c) => t + c.uncovered_amount, 0);
    expect(covered).toBeCloseTo(20);
    expect(uncovered).toBeCloseTo(15);

    const dataDays = await commitments.getAccountDataDays(orgId, day1, day2, [accountId]);
    expect(dataDays.get(accountId)).toContain(day1);

    const uncoveredDaily = await commitments.getUncoveredDailySpend(orgId, day1, day2, [accountId]);
    const dev = uncoveredDaily.find((r) => r.day === day2);
    expect(dev?.amount).toBeCloseTo(5);

    // No commitment fee rows are seeded: asserting the query itself runs.
    expect(
      Array.isArray(await commitments.getCommitmentDeliveredTotals(orgId, day1, day2, [accountId])),
    ).toBe(true);
  });

  it("streams cost export rows", async () => {
    const rows = [];
    for await (const row of exportRows.streamCostExportRows({
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
    const totals = await flowReaders.readNetworkFlowScopeTotals(orgId, range);
    expect(totals).toHaveLength(1);
    expect(totals[0]).toMatchObject({ scope: "inter_region", direction: "egress" });
    expect(totals[0]!.bytes).toBe(1_073_741_824);
    expect(totals[0]!.estimated_cost).toBeCloseTo(0.02);

    const pairs = await flowReaders.readTopNetworkFlows(orgId, range);
    expect(pairs).toHaveLength(1);
    expect(pairs[0]).toMatchObject({ src_ref: "res-a", dst_ref: "res-b" });

    const daily = await flowReaders.readNetworkFlowDaily(orgId, range);
    expect(daily.some((p) => p.day === day1 && p.bytes === 1_073_741_824)).toBe(true);
  });

  // ─── Reconciliation and tombstones ────────────────────────────────────────
  // Last among the `orgId` tests: the tombstone written here zeroes a row the
  // readers above count.

  it("tombstones superseded rows in reconcile, once", async () => {
    // A re-collection of day1 that no longer reports the covered row: the
    // stored covered row must come back zeroed, identity intact.
    const window = { fromDate: day1, toDate: day1 };
    const tombstones = await reconcile.reconcileCollectedChunk(meta, window, [usageProd]);
    expect(tombstones.every((t) => t.amount === 0 && t.amortized_amount === 0)).toBe(true);
    const zeroedCovered = tombstones.find((t) => t.tags_hash === coveredProd.tags_hash);
    expect(zeroedCovered).toMatchObject({
      day: day1,
      resource_id: "i-aaa",
      charge_type: "commitment_covered_usage",
      commitment_id: "cm-1",
    });

    // Written as the collector writes it: alongside the chunk, one upsert.
    await writers.insertCostRows([usageProd, ...tombstones]);
    const [stored] = (await storedCost(orgId)).filter((r) => r.tags_hash === coveredProd.tags_hash);
    expect(stored).toMatchObject({ amount: 0, amortized_amount: 0, blended_amount: 0 });

    // A zeroed key holds no money, so the next collection leaves it alone.
    expect(await reconcile.reconcileCollectedChunk(meta, window, [usageProd])).toEqual([]);
  });

  it("tombstones a custom source's rows outside the upload being kept", async () => {
    const pluginId = `custom:${randomUUID()}`;
    const custom = (resource: string, tags: Record<string, string>) =>
      costRow({
        organization_id: writeOrgId,
        plugin_id: pluginId,
        resource_id: resource,
        tags,
        tags_hash: writers.hashTags(tags),
        amount: 4,
      });
    await writers.insertCostRows([
      custom("kept", { "infrawrench:upload": "u1" }),
      custom("replaced", { "infrawrench:upload": "u2" }),
      // No upload tag at all: a replace must sweep these up too.
      custom("untagged", {}),
    ]);

    const result = await customStore.tombstoneCustomCostRows({
      organizationId: writeOrgId,
      pluginId,
      excludeUploadId: "u1",
    });
    expect(result.zeroed).toBe(2);
    expect(result.uploadIds).toEqual(["u2"]);

    const amounts = Object.fromEntries(
      (await storedCost(writeOrgId))
        .filter((r) => r.plugin_id === pluginId)
        .map((r) => [r.resource_id, r.amount]),
    );
    expect(amounts).toEqual({ kept: 4, replaced: 0, untagged: 0 });

    const holdings = await customStore.getCustomCostUploadHoldings(writeOrgId, pluginId, [
      "u1",
      "u2",
    ]);
    expect(holdings.get("u1")).toEqual({
      uploadId: "u1",
      rowCount: 1,
      fromDate: day1,
      toDate: day1,
      totals: { USD: 4 },
    });
    expect(holdings.get("u2")).toMatchObject({ rowCount: 0, fromDate: null, totals: {} });
  });

  // ─── AI attribution ───────────────────────────────────────────────────────

  it("reads the latest AI collection and the billed AI rows, and stores a split", async () => {
    const sourceId = `src-${randomUUID()}`;
    const aggregate = {
      provider: "openai",
      model: "gpt-4o",
      metadata: { team: "search" },
      requests: 10,
      inputTokens: 1000,
      outputTokens: 200,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      reasoningTokens: 0,
    };
    await aiStore.insertAiRequestAggregates(writeOrgId, sourceId, day1, "2026-01-01T00:00:00Z", [
      aggregate,
    ]);
    await aiStore.insertAiRequestAggregates(
      writeOrgId,
      sourceId,
      day1,
      "2026-01-02T00:00:00.123Z",
      [{ ...aggregate, requests: 12, reportedCost: 1.5, reportedCurrency: "USD" }],
    );
    const latest = await aiStore.readLatestAiAggregates(writeOrgId, day1, [sourceId]);
    expect(latest).toEqual([
      {
        sourceId,
        provider: "openai",
        model: "gpt-4o",
        metadata: { team: "search" },
        requests: 12,
        inputTokens: 1000,
        outputTokens: 200,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        reasoningTokens: 0,
        reportedCost: 1.5,
        reportedCurrency: "USD",
      },
    ]);

    const aiTags = { "ai:provider": "openai", "ai:model": "gpt-4o" };
    await writers.insertCostRows([
      costRow({
        organization_id: writeOrgId,
        plugin_id: "openai",
        service: "gpt-4o",
        resource_id: "",
        tags: aiTags,
        tags_hash: writers.hashTags(aiTags),
        amount: 3,
      }),
    ]);
    const billed = await aiStore.readBilledAiRows(writeOrgId, day1);
    expect(billed).toHaveLength(1);
    expect(billed[0]).toMatchObject({ plugin_id: "openai", day: day1, amount: 3, tags: aiTags });

    await aiStore.insertAttributedRows(writeOrgId, new Date().toISOString(), billed);
    const { eq } = await import("drizzle-orm");
    const split = await db
      .select()
      .from(schema.aiCostAttributed)
      .where(eq(schema.aiCostAttributed.organization_id, writeOrgId));
    expect(split).toHaveLength(1);
    expect(split[0]).toMatchObject({ amount: 3, tags: aiTags });
  });

  // ─── A trial's history merged into another org ────────────────────────────

  it("re-parents a trial's analytics rows, dropping readings the target already has", async () => {
    const { moveOrgAnalyticsData } = await import("../../trials/destroy");
    const metricWriters = await import("../../analytics/writers");
    const { eq } = await import("drizzle-orm");

    // One account connected to both orgs: the same point, polled by each.
    const ts = Date.now() - 60_000;
    const point = (organizationId: string, value: number) =>
      metricWriters.flattenMetricSeries(
        {
          organizationId,
          accountId,
          resourceId: "shared-res",
          pluginId: "aws",
          resourceTypeId: "aws-ec2",
        },
        [{ label: "cpu", unit: "%", points: [{ timestamp: ts, value }] }],
      );
    await metricWriters.insertMetricPoints(point(trialOrgId, 40));
    await metricWriters.insertMetricPoints(point(targetOrgId, 40));
    await writers.insertCostRows([costRow({ organization_id: trialOrgId, amount: 9 })]);

    await moveOrgAnalyticsData(trialOrgId, targetOrgId);

    for (const table of [schema.metricPointsRaw, schema.metricPoints1m, schema.costDaily]) {
      const left = await db.select().from(table).where(eq(table.organization_id, trialOrgId));
      expect(left).toHaveLength(0);
    }
    const raw = await db
      .select()
      .from(schema.metricPointsRaw)
      .where(eq(schema.metricPointsRaw.organization_id, targetOrgId));
    expect(raw).toHaveLength(1);
    const minute = await db
      .select()
      .from(schema.metricPoints1m)
      .where(eq(schema.metricPoints1m.organization_id, targetOrgId));
    expect(minute).toHaveLength(1);
    expect(minute[0]!.value_count).toBe(1);
    expect((await storedCost(targetOrgId)).map((r) => r.amount)).toEqual([9]);
  });
});
