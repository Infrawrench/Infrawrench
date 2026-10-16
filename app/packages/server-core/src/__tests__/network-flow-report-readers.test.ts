/**
 * The SQL saved network flow reports send, against a real Drizzle dialect over
 * a fake driver: filters reach the statement with the right either-end / peer
 * semantics, groupings key the way the assembly expects, and sampling is
 * summed per plugin rather than guessed.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import { fakeClickHouse } from "./helpers/fake-clickhouse";

const ch = fakeClickHouse();

vi.mock("../clickhouse/client", () => ({
  isClickHouseConfigured: () => true,
  getClickHouseDb: () => ch.db,
  getClickHouseClient: () => ch.client,
}));

const readers = await import("../clickhouse/network-flow-report-readers");

const ORG = "org-1";
const range = { from: "2026-09-01", to: "2026-09-30" };

beforeEach(() => {
  ch.reset();
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
    const q = ch.lastQuery();
    expect(q).toMatch(/ final /i);
    expect(q).toContain("'org-1'");
    expect(q).toMatch(
      /`src_network` in \('vpc-1'\) or `network_flow_daily`\.`dst_network` in \('vpc-1'\)/i,
    );
    expect(q).toMatch(/`src_region` in \('us-east-1'\) or .*`dst_region` in \('us-east-1'\)/i);
    expect(q).toMatch(/`src_zone` in \('use1-az1'\) or .*`dst_zone` in \('use1-az1'\)/i);
    expect(q).toMatch(/`src_ref` in \('i-src'\)/i);
    expect(q).toMatch(/`dst_ref` in \('internet'\)/i);
    // The peer is the destination of egress and the source of ingress.
    expect(q).toMatch(
      /if\(`network_flow_daily`\.`direction` = 'egress', `network_flow_daily`\.`dst_service`, `network_flow_daily`\.`src_service`\) in \('s3'\)/i,
    );
    expect(q).toMatch(
      /`dst_resource_type_id`, `network_flow_daily`\.`src_resource_type_id`\) in \('ec2-instance'\)/i,
    );
    expect(q).toMatch(/`scope` in \('cross_zone'\)/i);
    expect(q).toMatch(/`direction` in \('egress'\)/i);
    expect(q).toMatch(/`plugin_id` not in \('kubernetes'\)/i);
    expect(q).toContain("toMonday(");
    // No sampled plugin: the sampled figures are a constant, not a scan.
    expect(q).toContain("toFloat64(0)");
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
    const q = ch.lastQuery();
    expect(q).toMatch(
      /sumIf\(`network_flow_daily`\.`bytes`, `network_flow_daily`\.`plugin_id` in \('gcp'\)\)/i,
    );
    expect(q).toContain("concat(");
    expect(q).toContain("toStartOfMonth(");
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
    expect(ch.queries).toHaveLength(0);
  });

  it("counts every group before the limit and ranks by the report's metric", async () => {
    await readers.readNetworkFlowReportGroups(ORG, {
      range,
      split: "service",
      filters: {},
      sampledPluginIds: [],
      orderByBytes: true,
      limit: 25,
    });
    const q = ch.lastQuery();
    expect(q).toContain("count() OVER ()");
    expect(q).toMatch(/order by `total_bytes` desc, `total_cost` desc/i);
    expect(q).toMatch(/limit 25/i);
  });

  it("leaves the stored-cap remainder out of top talkers", async () => {
    await readers.readNetworkFlowReportTalkers(ORG, {
      range,
      filters: {},
      sampledPluginIds: ["gcp"],
      orderByBytes: false,
      limit: 10,
    });
    const q = ch.lastQuery();
    expect(q).toContain("!= 'truncated'");
    expect(q).toMatch(/order by `estimated_cost` desc, `bytes` desc/i);
    expect(q).toMatch(/max\(`network_flow_daily`\.`plugin_id` in \('gcp'\)\)/i);
  });

  it("reads picker values from both ends", async () => {
    await readers.readNetworkFlowReportDimensionValues(ORG, range);
    const all = ch.queries.join("\n");
    expect(all).toContain("groupUniqArray(500)");
    expect(all).toMatch(/array join/i);
  });
});
