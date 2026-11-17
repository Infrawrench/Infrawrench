/**
 * The flow writer's upsert, against a real Drizzle dialect over a recording
 * driver: a re-collected day replaces rows on the table's key, a batch never
 * carries one key twice (Postgres refuses to touch a row twice in one
 * statement), and a large day is split under the bind parameter cap.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import { fakePostgres } from "./helpers/fake-postgres";

const pg = fakePostgres();

vi.mock("../analytics/client", () => ({ getAnalyticsDb: () => pg.db }));

const { insertNetworkFlowRows, toNetworkFlowRows } =
  await import("../analytics/network-flow-writers");

type Row = Parameters<typeof insertNetworkFlowRows>[0][number];

function row(over: Partial<Row> = {}): Row {
  return {
    organization_id: "org-1",
    account_id: "acct-1",
    plugin_id: "aws",
    day: "2026-09-01",
    scope: "cross_zone",
    direction: "egress",
    attribution: "resolved",
    pair_hash: "1",
    src_ref: "i-a",
    src_label: "",
    src_zone: "",
    src_region: "",
    src_service: "",
    src_resource_type_id: "",
    dst_ref: "i-b",
    dst_label: "",
    dst_zone: "",
    dst_region: "",
    dst_service: "",
    dst_resource_type_id: "",
    bytes: 1,
    packets: 1,
    currency: "USD",
    rate_per_gb: 0.01,
    estimated_cost: 0,
    method: "",
    src_network: "",
    dst_network: "",
    ...over,
  };
}

beforeEach(() => {
  pg.reset();
});

describe("insertNetworkFlowRows", () => {
  it("writes nothing for no rows", async () => {
    await insertNetworkFlowRows([]);
    expect(pg.queries).toHaveLength(0);
  });

  it("upserts on the key, replacing every other column and keeping the newer write", async () => {
    await insertNetworkFlowRows([row()]);
    const { sql } = pg.lastQuery();
    expect(sql).toContain(
      'on conflict ("organization_id","account_id","day","scope","direction","attribution","pair_hash") do update set',
    );
    expect(sql).toContain('"bytes" = excluded."bytes"');
    expect(sql).toContain('"src_network" = excluded."src_network"');
    expect(sql).toContain('"ingested_at" = excluded."ingested_at"');
    // A key column is never rewritten.
    expect(sql).not.toContain('"pair_hash" = excluded');
    expect(sql).toContain('where "network_flow_daily"."ingested_at" <= excluded.ingested_at');
  });

  it("keeps the last of two rows with one key, as a second write would have", async () => {
    await insertNetworkFlowRows([
      row({ bytes: 3 }),
      row({ pair_hash: "2", bytes: 5 }),
      row({ bytes: 9 }),
    ]);
    expect(pg.queries).toHaveLength(1);
    const { params } = pg.lastQuery();
    // Two rows of 28 columns each; the surviving duplicate is the later one.
    expect(params).toHaveLength(56);
    expect(params).toEqual(expect.arrayContaining([9, 5]));
    expect(params).not.toContain(3);
  });

  it("splits a large day under the parameter cap", async () => {
    const rows = Array.from({ length: 2500 }, (_, i) => row({ pair_hash: String(i) }));
    await insertNetworkFlowRows(rows);
    expect(pg.queries).toHaveLength(3);
    for (const q of pg.queries) expect(q.params.length).toBeLessThan(65_535);
  });

  it("floors fractional byte and packet counts for the bigint columns", () => {
    const [mapped] = toNetworkFlowRows({ organizationId: "o", accountId: "a", pluginId: "p" }, [
      { bytes: 10.7, packets: 2.2 } as never,
    ]);
    expect(mapped).toMatchObject({ bytes: 10, packets: 2 });
  });
});
