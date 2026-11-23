import { capacityDeclarations, resolveCapacityLimit } from "@infrawrench/plugin-base";
import { describe, expect, it } from "vitest";
import { DISK_MAX_NODE_SERIES, RAM_RSS_MAX_NODE_SERIES, usageSeries } from "../client.js";
import { mapCluster } from "../mappers.js";
import { ClusterResourceType } from "../resource-types.js";

const GIB = 1024 ** 3;

describe("cluster capacity", () => {
  it("keeps the fullest node's disk and RSS from the per-node timeseries", () => {
    const series = usageSeries({
      disk: [{ timestamp: "2026-11-23T10:00:00Z", value: 30 * GIB }],
      nodes: [
        {
          nodeId: "n0",
          disk: [
            { timestamp: "2026-11-23T10:00:00Z", value: 12 * GIB },
            { timestamp: "2026-11-23T10:05:00Z", value: 13 * GIB },
          ],
          ramRss: [{ timestamp: "2026-11-23T10:00:00Z", value: 3 * GIB }],
        },
        {
          nodeId: "n1",
          disk: [
            { timestamp: "2026-11-23T10:00:00Z", value: 18 * GIB },
            { timestamp: "2026-11-23T10:05:00Z", value: 11 * GIB },
          ],
          ramRss: [{ timestamp: "2026-11-23T10:00:00Z", value: 5 * GIB }],
        },
      ],
    });
    expect(series.find((s) => s.label === DISK_MAX_NODE_SERIES)?.points).toEqual([
      { timestamp: Date.parse("2026-11-23T10:00:00Z"), value: 18 * GIB },
      { timestamp: Date.parse("2026-11-23T10:05:00Z"), value: 13 * GIB },
    ]);
    expect(series.find((s) => s.label === RAM_RSS_MAX_NODE_SERIES)?.points[0]?.value).toBe(5 * GIB);
  });

  it("declares both series against the per-node disk and RAM the cluster reports", () => {
    const cluster = mapCluster(
      {
        id: "c1",
        name: "prod",
        accountId: "a1",
        cloudProviderId: "aws",
        cloudProviderRegionId: "us-east-1",
        configuration: { numberOfNodes: 2, packageId: "pkg" },
        state: {
          phase: "CLUSTER_PHASE_HEALTHY",
          resources: { cpu: { available: 1.6 }, ram: { available: 6.4 }, disk: { available: 42 } },
        },
      } as Parameters<typeof mapCluster>[0],
      "acct",
    );
    const decls = capacityDeclarations(ClusterResourceType);
    expect(decls.map((d) => d.valueKey)).toEqual([DISK_MAX_NODE_SERIES, RAM_RSS_MAX_NODE_SERIES]);
    expect(resolveCapacityLimit(decls[0]!.declaration.limit, cluster.fields)?.limit).toBe(42 * GIB);
    expect(resolveCapacityLimit(decls[1]!.declaration.limit, cluster.fields)?.limit).toBe(
      6.4 * GIB,
    );
  });
});
