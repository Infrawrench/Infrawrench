/**
 * The SQL saved network flow reports send, against a real Drizzle dialect over
 * a fake driver: filters reach the statement with the right either-end / peer
 * semantics, groupings key the way the assembly expects, and sampling is
 * summed per plugin rather than guessed.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import { fakePostgres } from "./helpers/fake-postgres";

const pg = fakePostgres();

vi.mock("../analytics/client", () => ({ getAnalyticsDb: () => pg.db }));

const readers = await import("../analytics/network-flow-report-readers");

const ORG = "org-1";
const range = { from: "2026-09-01", to: "2026-09-30" };

/** The statement with each `$n` replaced by its quoted parameter, for matching. */
function inlined(q: { sql: string; params: unknown[] }): string {
  return q.sql.replace(/\$(\d+)/g, (_, n: string) => `'${String(q.params[Number(n) - 1])}'`);
}

const last = () => inlined(pg.lastQuery());

/** A column reference as Drizzle renders it. */
const col = (name: string) => `"network_flow_daily"."${name}"`;
const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

beforeEach(() => {
  pg.reset();
});

describe("network flow report readers", () => {
  it("applies every filter with either-end and peer semantics", async () => {
    await readers.readNetworkFlowReportCells(ORG, {
      range,
      bucket: "weekly",
      split: "none",
      filters: {
        accountIds: ["acct-1"],
        networks: ["vpc-1"],
        regions: ["us-east-1"],
        zones: ["use1-az1"],
        sourceRefs: ["i-src"],
        destinationRefs: ["internet"],
        peerServices: ["s3"],
        peerResourceTypes: ["ec2-instance"],
        scopes: ["cross_zone"],
        directions: ["egress"],
        excludePluginIds: ["kubernetes"],
      },
      sampledPluginIds: [],
      groupKeys: null,
    });
    const q = last();
    expect(q).toContain(`${col("organization_id")} = 'org-1'`);
    expect(q).toContain(
      `(${col("src_network")} in ('vpc-1') or ${col("dst_network")} in ('vpc-1'))`,
    );
    expect(q).toContain(
      `(${col("src_region")} in ('us-east-1') or ${col("dst_region")} in ('us-east-1'))`,
    );
    expect(q).toContain(
      `(${col("src_zone")} in ('use1-az1') or ${col("dst_zone")} in ('use1-az1'))`,
    );
    expect(q).toContain(`${col("src_ref")} in ('i-src')`);
    expect(q).toContain(`${col("dst_ref")} in ('internet')`);
    // The peer is the destination of egress and the source of ingress.
    expect(q).toContain(
      `(CASE WHEN ${col("direction")} = 'egress' THEN ${col("dst_service")} ELSE ${col("src_service")} END) in ('s3')`,
    );
    expect(q).toContain(
      `THEN ${col("dst_resource_type_id")} ELSE ${col("src_resource_type_id")} END) in ('ec2-instance')`,
    );
    expect(q).toContain(`${col("scope")} in ('cross_zone')`);
    expect(q).toContain(`${col("direction")} in ('egress')`);
    expect(q).toContain(`${col("plugin_id")} not in ('kubernetes')`);
    // Weeks start on Monday.
    expect(q).toContain(`date_trunc('week', ${col("day")}::timestamp)`);
    // No sampled plugin: the sampled figures are a constant, not a scan.
    expect(q).toContain(`0::float8 as "sampled_bytes"`);
  });

  it("sums sampled bytes per plugin and keys pairs on both refs", async () => {
    await readers.readNetworkFlowReportCells(ORG, {
      range,
      bucket: "monthly",
      split: "pair",
      filters: {},
      sampledPluginIds: ["gcp"],
      groupKeys: ["a\u001fb"],
    });
    const q = last();
    // The select list names its single table's columns unqualified.
    expect(q).toContain(
      `coalesce(sum("bytes") FILTER (WHERE ${col("plugin_id")} in ('gcp')), 0)::float8 as "sampled_bytes"`,
    );
    const pairKey = `concat(${col("src_ref")}, chr(31), ${col("dst_ref")})`;
    // The chart's keys restrict the scan through the same expression it groups by.
    expect(q).toContain(`${pairKey} in ('a\u001fb')`);
    expect(q).toContain(`date_trunc('month', ${col("day")}::timestamp)`);
    expect(q).toMatch(/group by bucket, group_key/i);
  });

  it("reads nothing for an empty chart key list", async () => {
    const rows = await readers.readNetworkFlowReportCells(ORG, {
      range,
      bucket: "daily",
      split: "source",
      filters: {},
      sampledPluginIds: [],
      groupKeys: [],
    });
    expect(rows).toEqual([]);
    expect(pg.queries).toHaveLength(0);
  });

  it("counts every group before the limit and ranks by the report's metric", async () => {
    pg.setRows([
      {
        group_key: "s3",
        label_a: "",
        label_b: "",
        currency: "USD",
        total_bytes: 10,
        total_cost: 1,
        sampled_bytes: 0,
        sampled_cost: 0,
        unattributed_bytes: 0,
        truncated_bytes: 0,
        pair_count: "2",
        group_count: "7",
      },
    ]);
    const out = await readers.readNetworkFlowReportGroups(ORG, {
      range,
      split: "service",
      filters: {},
      sampledPluginIds: [],
      orderByBytes: true,
      limit: 25,
    });
    const q = last();
    expect(q).toContain("count(*) OVER ()");
    expect(q).toMatch(/order by "total_bytes" desc, "total_cost" desc, group_key asc/i);
    expect(q).toMatch(/limit '25'/i);
    // bigint counts arrive as strings and leave as numbers.
    expect(out.count).toBe(7);
    expect(out.rows[0]).toMatchObject({ group_key: "s3", pair_count: 2, bytes: 10 });
  });

  it("leaves the stored-cap remainder out of top talkers", async () => {
    await readers.readNetworkFlowReportTalkers(ORG, {
      range,
      filters: {},
      sampledPluginIds: ["gcp"],
      orderByBytes: false,
      limit: 10,
    });
    const q = last();
    expect(q).toContain(`${col("attribution")} != 'truncated'`);
    expect(q).toMatch(/order by "estimated_cost" desc, "bytes" desc/i);
    expect(q).toContain(`max(CASE WHEN ${col("plugin_id")} in ('gcp') THEN 1 ELSE 0 END)`);
  });

  it("reads picker values from both ends", async () => {
    await readers.readNetworkFlowReportDimensionValues(ORG, range);
    const all = pg.queries.map(inlined).join("\n");
    expect(all).toContain(
      `(array_agg(DISTINCT ${col("src_network")}))[1:500] || (array_agg(DISTINCT ${col("dst_network")}))[1:500]`,
    );
    // Each row is read once per end, the side recorded as a bit.
    expect(all).toMatch(
      new RegExp(
        `cross join lateral \\(VALUES\\s+\\(${escape(col("src_ref"))}, .*, 1\\),\\s+\\(${escape(col("dst_ref"))}, .*, 2\\)`,
        "i",
      ),
    );
    expect(all).toContain("bit_or(endpoint.side)");
  });

  it("decodes picker rows, preferring a label and folding the sides", async () => {
    pg.queueRows([
      {
        networks: ["vpc-2", "", "vpc-1"],
        regions: null,
        zones: ["a"],
        services: ["s3"],
        resource_types: ["ec2-instance"],
        scopes: ["cross_zone"],
      },
    ]);
    pg.queueRows([
      { ref: "i-a", label: "", resource_type_id: "ec2-instance", sides: 3, bytes: 10 },
      { ref: "", label: "", resource_type_id: "", sides: 1, bytes: 5 },
    ]);
    const out = await readers.readNetworkFlowReportDimensionValues(ORG, range);
    expect(out.networks).toEqual(["vpc-1", "vpc-2"]);
    expect(out.regions).toEqual([]);
    expect(out.endpoints).toEqual([
      { ref: "i-a", label: "i-a", resource_type_id: "ec2-instance", side: "both" },
    ]);
  });
});
