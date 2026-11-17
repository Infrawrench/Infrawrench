/**
 * The commitment report scan, pinned by the SQL it sends, against a real
 * Drizzle dialect over a fake driver. The properties a report's numbers rest
 * on are all in the statement, so this is where they are checked:
 *
 * - money is amortized, never cash;
 * - a commitment fee counts as unused only where its amortized amount was
 *   reported (a cash fallback would book a purchase as waste);
 * - a commitment filter narrows the commitment side and never uncovered usage;
 * - the on-demand equivalent is summed only from rows that reported one.
 *
 * `db/analytics-commitment-report.test.ts` runs the same statement against a
 * real server.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import { fakePostgres } from "./helpers/fake-postgres";

const pg = fakePostgres();

vi.mock("../analytics/client", () => ({ getAnalyticsDb: () => pg.db }));

const { getCommitmentReportCells, getCommitmentReportDimensionValues } =
  await import("../analytics/commitment-readers");

/** The statement with each `$n` replaced by its quoted parameter, for matching. */
function inlined(q: { sql: string; params: unknown[] }): string {
  return q.sql.replace(/\$(\d+)/g, (_, n: string) => `'${String(q.params[Number(n) - 1])}'`);
}

const last = () => inlined(pg.lastQuery());
const col = (name: string) => `"cost_daily"."${name}"`;

/** The `FILTER (WHERE ...)` of the aggregate aliased `alias`. */
function filterOf(q: string, alias: string): string {
  const end = q.indexOf(`"${alias}"`);
  const start = q.lastIndexOf("coalesce(sum(", end);
  return q.slice(start, end);
}

const base = {
  from: "2026-07-01",
  to: "2026-09-30",
  bucket: "monthly" as const,
  split: "none" as const,
  accountIds: ["acc-1"],
  commitmentIds: null,
};

beforeEach(() => {
  pg.reset();
});

describe("getCommitmentReportCells", () => {
  it("reads nothing without accounts", async () => {
    expect(await getCommitmentReportCells("org-1", { ...base, accountIds: [] })).toEqual([]);
    expect(pg.queries).toHaveLength(0);
  });

  it("buckets with the requested size and scopes to the org, window and accounts", async () => {
    await getCommitmentReportCells("org-1", base);
    const q = last();
    expect(q).toContain(`date_trunc('month', ${col("day")}::timestamp)`);
    expect(q).toContain(`${col("organization_id")} = 'org-1'`);
    expect(q).toContain(`${col("account_id")} in ('acc-1')`);
    expect(q).toMatch(/group by bucket, group_key, "cost_daily"."currency"/i);
    await getCommitmentReportCells("org-1", { ...base, bucket: "quarterly" });
    expect(last()).toContain("date_trunc('quarter'");
    await getCommitmentReportCells("org-1", { ...base, bucket: "weekly" });
    expect(last()).toContain("date_trunc('week'");
  });

  it("sums amortized money", async () => {
    await getCommitmentReportCells("org-1", base);
    const covered = filterOf(last(), "covered");
    expect(covered).toContain(`${col("amortized_reported")} != 0`);
    expect(covered).toContain(`${col("amortized_amount")}`);
  });

  it("only counts a fee as unused where an amortized amount was reported", async () => {
    await getCommitmentReportCells("org-1", base);
    expect(filterOf(last(), "unused")).toContain(
      `${col("charge_type")} = 'commitment_fee' AND ${col("amortized_reported")} = 1`,
    );
  });

  it("restricts the commitment side to the selected ids, not the uncovered side", async () => {
    await getCommitmentReportCells("org-1", { ...base, commitmentIds: ["sp-1"] });
    const q = last();
    expect(filterOf(q, "covered")).toContain(`${col("commitment_id")} in ('sp-1')`);
    expect(filterOf(q, "unused")).toContain(`${col("commitment_id")} in ('sp-1')`);
    expect(filterOf(q, "covered_all")).not.toContain("'sp-1'");
    expect(filterOf(q, "uncovered")).not.toContain("'sp-1'");
  });

  it("selects nothing on the commitment side when a filter matched no holding", async () => {
    await getCommitmentReportCells("org-1", { ...base, commitmentIds: [] });
    expect(filterOf(last(), "covered")).toContain("AND false");
  });

  it("keys a commitment split by id, unattributed and on demand", async () => {
    await getCommitmentReportCells("org-1", { ...base, split: "commitment" });
    const q = last();
    expect(q).toContain("'__on_demand__'");
    expect(q).toContain("'__unattributed__'");
  });

  it("sums the on-demand equivalent only from rows that reported one", async () => {
    await getCommitmentReportCells("org-1", base);
    const q = last();
    expect(filterOf(q, "covered_on_demand")).toContain(`${col("on_demand_reported")} = 1`);
    expect(filterOf(q, "covered_measured")).toContain(`${col("on_demand_reported")} = 1`);
  });

  it("applies service and region filters to both the scan and its eligible cells", async () => {
    await getCommitmentReportCells("org-1", {
      ...base,
      services: ["AmazonEC2"],
      regions: ["us-east-1"],
    });
    const q = last();
    expect(q.match(/"cost_daily"."service" in \('AmazonEC2'\)/g)).toHaveLength(2);
    expect(q.match(/"cost_daily"."region" in \('us-east-1'\)/g)).toHaveLength(2);
  });

  it("maps rows to numbers", async () => {
    pg.setRows([
      {
        bucket: "2026-07-01",
        group_key: "",
        currency: "USD",
        covered: "10",
        covered_all: "10",
        unused: "2",
        uncovered: "5",
        uncovered_eligible: "1",
        covered_on_demand: "14",
        covered_measured: "10",
      },
    ]);
    expect(await getCommitmentReportCells("org-1", base)).toEqual([
      {
        bucket: "2026-07-01",
        group_key: "",
        currency: "USD",
        covered: 10,
        covered_all: 10,
        unused: 2,
        uncovered: 5,
        uncovered_eligible: 1,
        covered_on_demand: 14,
        covered_measured: 10,
      },
    ]);
  });
});

describe("getCommitmentReportDimensionValues", () => {
  it("lists distinct services and regions, sorted, blanks dropped", async () => {
    pg.setRows([
      { service: "AmazonRDS", region: "us-east-1" },
      { service: "AmazonEC2", region: "" },
      { service: "AmazonEC2", region: "eu-west-1" },
    ]);
    expect(
      await getCommitmentReportDimensionValues("org-1", "2026-07-01", "2026-07-31", ["acc-1"]),
    ).toEqual({ services: ["AmazonEC2", "AmazonRDS"], regions: ["eu-west-1", "us-east-1"] });
  });
});
