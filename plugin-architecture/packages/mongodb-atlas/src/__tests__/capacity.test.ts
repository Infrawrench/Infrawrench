import { capacityDeclarations, resolveCapacityLimit } from "@infrawrench/plugin-base";
import { beforeEach, describe, expect, it } from "vitest";
import { resetAuthCaches } from "../api.js";
import { CONNECTIONS_MAX_NODE_SERIES, DISK_PERCENT_SERIES, clusterSeries } from "../metrics.js";
import { ClusterResourceType } from "../resource-types.js";
import { ctxWith, makeHttp, reply } from "./helpers.js";

beforeEach(() => resetAuthCaches());

const T0 = "2026-11-23T10:00:00Z";

function measurements(connections: number, diskPct: number) {
  return {
    measurements: [
      { name: "CONNECTIONS", units: "SCALAR", dataPoints: [{ timestamp: T0, value: connections }] },
      {
        name: "STORAGE_SPACE_PERCENT_USED",
        units: "PERCENT",
        dataPoints: [{ timestamp: T0, value: diskPct }],
      },
    ],
  };
}

describe("cluster capacity", () => {
  it("emits the busiest node's connections and disk percent", async () => {
    const { http } = makeHttp((call) => {
      if (call.path.startsWith("/api/atlas/v2/groups/g1/processes?")) {
        return {
          results: [
            {
              id: "p1:27017",
              userAlias: "main-shard-00-00.ab1cd.mongodb.net",
              typeName: "REPLICA_PRIMARY",
            },
            {
              id: "p2:27017",
              userAlias: "main-shard-00-01.ab1cd.mongodb.net",
              typeName: "REPLICA_SECONDARY",
            },
          ],
          totalCount: 2,
        };
      }
      if (call.path.includes("/processes/p1%3A27017/measurements")) return measurements(400, 61.5);
      if (call.path.includes("/processes/p2%3A27017/measurements")) return measurements(120, 63.2);
      return reply({ status: 404, body: {} });
    });
    const series = await clusterSeries(
      ctxWith(http),
      "g1",
      "mongodb+srv://main.ab1cd.mongodb.net",
      { startMs: Date.parse(T0) - 3_600_000, endMs: Date.parse(T0) },
    );
    const byLabel = new Map(series.map((s) => [s.label, s]));
    expect(byLabel.get("Connections")?.points[0]?.value).toBe(520);
    expect(byLabel.get(CONNECTIONS_MAX_NODE_SERIES)?.points[0]?.value).toBe(400);
    expect(byLabel.get(DISK_PERCENT_SERIES)?.points[0]?.value).toBe(63.2);
    expect(byLabel.get(DISK_PERCENT_SERIES)?.unit).toBe("%");
  });

  it("falls back to the full set when Atlas rejects the storage measurement", async () => {
    const asked: string[] = [];
    const { http } = makeHttp((call) => {
      if (call.path.startsWith("/api/atlas/v2/groups/g1/processes?")) {
        return {
          results: [{ id: "p1", userAlias: "main-shard-00-00.ab1cd.mongodb.net" }],
          totalCount: 1,
        };
      }
      asked.push(call.path);
      if (call.path.includes("STORAGE_SPACE_PERCENT_USED")) {
        return reply({ status: 400, body: { errorCode: "INVALID_METRIC_NAME" } });
      }
      return measurements(10, 0);
    });
    const series = await clusterSeries(
      ctxWith(http),
      "g1",
      "mongodb+srv://main.ab1cd.mongodb.net",
      { startMs: Date.parse(T0) - 3_600_000, endMs: Date.parse(T0) },
    );
    expect(asked).toHaveLength(2);
    expect(series.some((s) => s.label === CONNECTIONS_MAX_NODE_SERIES)).toBe(true);
  });

  it("declares the series by their exact labels and resolves the tier's connection limit", () => {
    const decls = capacityDeclarations(ClusterResourceType);
    const keys = decls.map((d) => d.valueKey);
    expect(keys).toEqual([DISK_PERCENT_SERIES, CONNECTIONS_MAX_NODE_SERIES]);
    const conn = decls.find((d) => d.valueKey === CONNECTIONS_MAX_NODE_SERIES)!;
    expect(resolveCapacityLimit(conn.declaration.limit, { instanceSize: "M30" })?.limit).toBe(3000);
    expect(resolveCapacityLimit(conn.declaration.limit, { instanceSize: "M80" })).toBeNull();
    const disk = decls.find((d) => d.valueKey === DISK_PERCENT_SERIES)!;
    expect(resolveCapacityLimit(disk.declaration.limit, {})?.limit).toBe(100);
  });
});

describe("organization and project counts", () => {
  it("measures projects and clusters against Atlas's documented per-container limits", async () => {
    const { OrganizationResourceType, ProjectResourceType } = await import("../resource-types.js");
    const { mapProject } = await import("../mappers.js");
    const [org] = capacityDeclarations(OrganizationResourceType);
    expect(org?.valueKey).toBe("projectCount");
    expect(resolveCapacityLimit(org!.declaration.limit, {})?.limit).toBe(250);
    const [proj] = capacityDeclarations(ProjectResourceType);
    expect(proj?.valueKey).toBe("clusterCount");
    expect(resolveCapacityLimit(proj!.declaration.limit, {})?.limit).toBe(25);
    const mapped = mapProject("acct", {
      id: "g1",
      name: "prod",
      orgId: "org1",
      clusterCount: 4,
      created: "2024-01-01T00:00:00Z",
    } as never);
    expect(mapped.fields["clusterCount"]).toBe(4);
  });
});
