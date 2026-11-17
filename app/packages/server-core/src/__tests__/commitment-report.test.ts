/**
 * Running a commitment report: which accounts and commitments reach the scan,
 * how the scan's keys are labelled and regrouped, and which notices a result
 * carries. The scan itself is `commitment-report-sql.test.ts`; the arithmetic
 * is client-core's.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  COMMITMENT_REPORT_ON_DEMAND_KEY,
  COMMITMENT_REPORT_UNKNOWN_KIND_KEY,
  DEFAULT_COMMITMENT_REPORT_CONFIG,
  type CommitmentReportConfig,
} from "@infrawrench/client-core";

import { fakePostgres } from "./helpers/fake-postgres";

const pg = fakePostgres();
vi.mock("../db/client", () => ({ db: pg.db }));

const manifests = [
  {
    id: "aws",
    displayName: "AWS",
    costs: { chargeTypes: true },
    commitments: { kinds: ["reservation", "savings_plan"], unusedFeeBookedMonthly: true },
  },
  { id: "azure", displayName: "Azure", costs: { chargeTypes: true }, commitments: { kinds: [] } },
  { id: "gcp", displayName: "Google Cloud", costs: {}, commitments: { kinds: ["committed_use"] } },
  { id: "hetzner", displayName: "Hetzner", costs: { chargeTypes: true } },
];
vi.mock("../plugin-loader", () => ({
  loadPlugins: async () => manifests.map((manifest) => ({ plugin: { manifest } })),
}));

const visible = vi.fn<() => Set<string> | null>(() => null);
vi.mock("../cost/visibility-context", () => ({ strictlyVisibleAccountIds: () => visible() }));

const cells = vi.fn();
vi.mock("../analytics/commitment-readers", () => ({
  getCommitmentReportCells: (...args: unknown[]) => cells(...args),
  getCommitmentReportDimensionValues: async () => ({ services: ["AmazonEC2"], regions: [] }),
}));

const { getCommitmentReportOptions, runCommitmentReportConfig } =
  await import("../commitments/report");

const ACCOUNTS = [
  { id: "aws-1", displayName: "Production", pluginId: "aws" },
  { id: "az-1", displayName: "Azure EA", pluginId: "azure" },
  { id: "gcp-1", displayName: "Data", pluginId: "gcp" },
  { id: "htz-1", displayName: "Boxes", pluginId: "hetzner" },
];
const HOLDINGS = [
  {
    accountId: "az-1",
    pluginId: "azure",
    commitmentId: "ri-1",
    kind: "reservation",
    description: "D4s v5, 3 years",
    state: "active",
  },
  {
    accountId: "az-1",
    pluginId: "azure",
    commitmentId: "sp-1",
    kind: "savings_plan",
    description: "Compute savings plan",
    state: "active",
  },
];

const today = new Date("2026-10-15T12:00:00Z");
const run = (over: Partial<CommitmentReportConfig>) =>
  runCommitmentReportConfig("org-1", { ...DEFAULT_COMMITMENT_REPORT_CONFIG, ...over }, today);

const totals = {
  covered: 0,
  covered_all: 0,
  unused: 0,
  uncovered: 0,
  uncovered_eligible: 0,
  covered_on_demand: 0,
  covered_measured: 0,
};

beforeEach(() => {
  pg.reset();
  visible.mockReturnValue(null);
  cells.mockReset();
  cells.mockResolvedValue([]);
  // Every run reads the accounts, then the holdings.
  pg.queueRows(ACCOUNTS);
  pg.queueRows(HOLDINGS);
});

describe("runCommitmentReportConfig", () => {
  it("scans only measured, commitment-capable accounts and names the rest", async () => {
    const result = await run({});
    expect(cells.mock.calls[0]![1]).toMatchObject({
      accountIds: ["aws-1", "az-1"],
      commitmentIds: null,
      bucket: "weekly",
      split: "none",
    });
    expect(result.providers).toEqual([
      { pluginId: "aws", displayName: "AWS", status: "measured", accountCount: 1 },
      { pluginId: "azure", displayName: "Azure", status: "measured", accountCount: 1 },
      { pluginId: "gcp", displayName: "Google Cloud", status: "inventory_only", accountCount: 1 },
    ]);
  });

  it("keeps to the accounts a scoped caller may see in full", async () => {
    visible.mockReturnValue(new Set(["az-1"]));
    await run({});
    expect(cells.mock.calls[0]![1]).toMatchObject({ accountIds: ["az-1"] });
  });

  it("ends a window reaching past today on today", async () => {
    const result = await run({
      dateRange: { kind: "absolute", from: "2026-10-01", to: "2026-12-31" },
    });
    expect(result.to).toBe("2026-10-15");
    expect(cells.mock.calls[0]![1]).toMatchObject({ from: "2026-10-01", to: "2026-10-15" });
  });

  it("turns a commitment filter into the holdings it selects", async () => {
    await run({ filters: { commitmentTypes: ["savings_plan"] } });
    expect(cells.mock.calls[0]![1]).toMatchObject({ commitmentIds: ["sp-1"] });
  });

  it("selects nothing when a commitment filter matches no holding", async () => {
    await run({ filters: { commitmentIds: ["gone"] } });
    expect(cells.mock.calls[0]![1]).toMatchObject({ commitmentIds: [] });
  });

  it("regroups a commitment split by kind, keeping the sentinels", async () => {
    cells.mockResolvedValue([
      { ...totals, bucket: "2026-10-12", group_key: "ri-1", currency: "USD", covered: 5 },
      { ...totals, bucket: "2026-10-12", group_key: "old", currency: "USD", unused: 1 },
      {
        ...totals,
        bucket: "2026-10-12",
        group_key: COMMITMENT_REPORT_ON_DEMAND_KEY,
        currency: "USD",
        uncovered: 5,
      },
    ]);
    const result = await run({ groupBy: "commitment_type" });
    expect(cells.mock.calls[0]![1]).toMatchObject({ split: "commitment" });
    expect(result.series.map((s) => s.groupKey).sort()).toEqual(
      [COMMITMENT_REPORT_ON_DEMAND_KEY, COMMITMENT_REPORT_UNKNOWN_KIND_KEY, "reservation"].sort(),
    );
  });

  it("labels holdings by their description", async () => {
    cells.mockResolvedValue([
      { ...totals, bucket: "2026-10-12", group_key: "ri-1", currency: "USD", covered: 5 },
    ]);
    const result = await run({ groupBy: "commitment" });
    expect(result.series[0]!.label).toBe("D4s v5, 3 years");
  });

  it("warns about lumped unused fees from the manifest flag, at daily and weekly only", async () => {
    expect((await run({ granularity: "weekly" })).notices).toContain("unused_lumped_monthly");
    pg.queueRows(ACCOUNTS);
    pg.queueRows(HOLDINGS);
    expect((await run({ granularity: "monthly" })).notices).not.toContain("unused_lumped_monthly");
    pg.queueRows(ACCOUNTS);
    pg.queueRows(HOLDINGS);
    expect((await run({ filters: { providers: ["azure"] } })).notices).not.toContain(
      "unused_lumped_monthly",
    );
  });

  it("says when nothing in scope can be measured", async () => {
    const result = await run({ filters: { providers: ["gcp"] } });
    expect(result.notices).toContain("no_measurable_accounts");
    expect(cells.mock.calls[0]![1]).toMatchObject({ accountIds: [] });
  });
});

describe("getCommitmentReportOptions", () => {
  it("lists what a run can filter by, scoped like a run", async () => {
    const options = await getCommitmentReportOptions("org-1", today);
    expect(options.accounts.map((a) => a.id)).toEqual(["az-1", "gcp-1", "aws-1"]);
    expect(options.providers.map((p) => p.pluginId)).toEqual(["aws", "azure", "gcp"]);
    expect(options.services).toEqual(["AmazonEC2"]);
    expect(options.commitments.map((c) => c.commitmentId)).toEqual(["sp-1", "ri-1"]);
  });
});
