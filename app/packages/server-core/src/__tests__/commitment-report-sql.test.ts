/**
 * The commitment report scan, pinned by the SQL it emits. The properties a
 * report's numbers rest on are all in the statement, so this is where they
 * are checked:
 *
 * - money is amortized, never cash;
 * - a commitment fee counts as unused only where its amortized amount was
 *   reported (a cash fallback would book a purchase as waste);
 * - a commitment filter narrows the commitment side and never uncovered usage;
 * - the on-demand equivalent is summed only from rows that reported one.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import { fakeClickHouse } from "./helpers/fake-clickhouse";

const ch = fakeClickHouse();
const captured = ch.queries;

vi.mock("../clickhouse/client", () => ({
  isClickHouseConfigured: () => true,
  getClickHouseDb: () => ch.db,
  getClickHouseClient: () => ch.client,
}));

const { getCommitmentReportCells } = await import("../clickhouse/commitment-readers");

const base = {
  from: "2026-07-01",
  to: "2026-09-30",
  bucket: "monthly" as const,
  split: "none" as const,
  accountIds: ["acc-1"],
  commitmentIds: null,
};

beforeEach(() => {
  captured.length = 0;
  ch.setRows?.([]);
});

describe("getCommitmentReportCells", () => {
  it("reads nothing without accounts", async () => {
    expect(await getCommitmentReportCells("org-1", { ...base, accountIds: [] })).toEqual([]);
    expect(captured).toHaveLength(0);
  });

  it("buckets with the requested size and sums amortized money", async () => {
    await getCommitmentReportCells("org-1", base);
    const q = captured.join("\n");
    expect(q).toContain("toStartOfMonth");
    expect(q).toContain("amortized_reported");
    expect(q).toMatch(/ final /i);
  });

  it("only counts a fee as unused where an amortized amount was reported", async () => {
    await getCommitmentReportCells("org-1", base);
    const q = captured.join("\n");
    expect(q).toMatch(/commitment_fee'?\)? AND `cost_daily`\.`amortized_reported` = 1/);
  });

  it("restricts the commitment side to the selected ids, not the uncovered side", async () => {
    await getCommitmentReportCells("org-1", { ...base, commitmentIds: ["sp-1"] });
    const q = captured.join("\n");
    expect(q).toContain("'sp-1'");
    // The uncovered sum carries no commitment restriction.
    const uncovered = /sumIf\(([^)]|\)(?! as))*\) as `uncovered`/.exec(q)?.[0] ?? "";
    expect(uncovered).not.toContain("'sp-1'");
  });

  it("selects nothing on the commitment side when a filter matched no holding", async () => {
    await getCommitmentReportCells("org-1", { ...base, commitmentIds: [] });
    expect(captured.join("\n")).toMatch(/AND 0\)/);
  });

  it("keys a commitment split by id, unattributed and on demand", async () => {
    await getCommitmentReportCells("org-1", { ...base, split: "commitment" });
    const q = captured.join("\n");
    expect(q).toContain("'__on_demand__'");
    expect(q).toContain("'__unattributed__'");
  });

  it("sums the on-demand equivalent only from rows that reported one", async () => {
    await getCommitmentReportCells("org-1", base);
    expect(captured.join("\n")).toContain("on_demand_reported` = 1");
  });
});
