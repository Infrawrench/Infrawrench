import { beforeEach, describe, expect, it, vi } from "vitest";

import { fakePostgres } from "./helpers/fake-postgres";

/**
 * The query-monitor target picker and the resource validation behind it.
 *
 * `listQueryMonitorTargets` runs against the real bundled plugins on purpose:
 * the picker's whole promise is that the databases-that-are-resources people
 * actually monitor (a ClickHouse service, a D1 or Turso database, a BigQuery
 * dataset) qualify, and a stub registry would keep passing after a plugin
 * quietly lost the declaration that makes them qualify.
 */
const pg = fakePostgres();
vi.mock("../db/client", () => ({ db: pg.db }));

const { createQueryMonitor, isSqlTargetType, listQueryMonitorTargets, QueryMonitorInputError } =
  await import("../query-monitors/store");
const { BUNDLED_PLUGINS } = await import("../plugin-loader");

beforeEach(() => {
  pg.reset();
});

function typeOf(pluginId: string, typeId: string) {
  const plugin = BUNDLED_PLUGINS.find((p) => p.manifest.id === pluginId);
  const typeDef = plugin?.resourceTypes.find((t) => t.id === typeId);
  if (!typeDef) throw new Error(`no such type ${pluginId}/${typeId}`);
  return typeDef;
}

describe("isSqlTargetType", () => {
  it("accepts the shipped per-resource databases", () => {
    expect(isSqlTargetType(typeOf("clickhouse", "ch-service"))).toBe(true);
    expect(isSqlTargetType(typeOf("cloudflare", "d1-database"))).toBe(true);
    expect(isSqlTargetType(typeOf("turso", "turso-database"))).toBe(true);
    expect(isSqlTargetType(typeOf("databricks", "databricks-sql-warehouse"))).toBe(true);
    // REST-queried, no connection string to resolve — `supportsRestQuery`.
    expect(isSqlTargetType(typeOf("gcp", "bigquery-dataset"))).toBe(true);
    expect(isSqlTargetType(typeOf("gcp", "spanner-database"))).toBe(true);
  });

  it("rejects a type with neither declaration", () => {
    expect(isSqlTargetType(typeOf("gcp", "gce-instance"))).toBe(false);
  });
});

describe("listQueryMonitorTargets", () => {
  it("offers account-level drivers, per-resource databases, and omits the rest", async () => {
    // Accounts, in the projection order (id, name, pluginId).
    pg.queueRows([
      { id: "acc-ch", name: "CH Cloud", pluginId: "clickhouse" },
      { id: "acc-gcp", name: "GCP", pluginId: "gcp" },
      { id: "acc-hz", name: "Hetzner", pluginId: "hetzner" },
      { id: "acc-pg", name: "Prod PG", pluginId: "postgres" },
    ]);
    // Resources, in the projection order (id, name, accountId, resourceTypeId).
    pg.queueRows([
      {
        id: "acc-ch:service:s1",
        name: "analytics",
        accountId: "acc-ch",
        resourceTypeId: "ch-service",
      },
      {
        id: "acc-gcp:bigquery-dataset:events",
        name: "events",
        accountId: "acc-gcp",
        resourceTypeId: "bigquery-dataset",
      },
      {
        id: "acc-gcp:gce-instance:vm1",
        name: "vm1",
        accountId: "acc-gcp",
        resourceTypeId: "gce-instance",
      },
      { id: "acc-hz:server:h1", name: "worker", accountId: "acc-hz", resourceTypeId: "server" },
    ]);

    const targets = await listQueryMonitorTargets("org-1");

    // Hetzner has neither an account driver nor a SQL-capable resource, so it
    // is not offered at all — a monitor pointed at it could only ever fail.
    expect(targets.map((t) => t.id)).toEqual(["acc-ch", "acc-gcp", "acc-pg"]);

    const clickhouse = targets.find((t) => t.id === "acc-ch")!;
    expect(clickhouse.accountSql).toBe(false);
    expect(clickhouse.resources).toEqual([
      {
        id: "acc-ch:service:s1",
        name: "analytics",
        resourceTypeId: "ch-service",
        typeName: typeOf("clickhouse", "ch-service").displayName,
      },
    ]);

    // Only the queryable GCP resource survives the filter, not the VM.
    const gcp = targets.find((t) => t.id === "acc-gcp")!;
    expect(gcp.resources.map((r) => r.id)).toEqual(["acc-gcp:bigquery-dataset:events"]);

    const postgresAccount = targets.find((t) => t.id === "acc-pg")!;
    expect(postgresAccount.accountSql).toBe(true);
    expect(postgresAccount.resources).toEqual([]);
  });
});

describe("createQueryMonitor resource validation", () => {
  const baseInput = {
    name: "Dead letters",
    accountId: "acc-1",
    sql: "SELECT count(*) FROM dead_letters",
    mode: "scalar" as const,
    operator: "gt" as const,
    threshold: 100,
    intervalMinutes: 15,
  };

  it("404s a resource the org has not synced", async () => {
    pg.queueRows([]); // the resource lookup
    await expect(
      createQueryMonitor("org-1", { ...baseInput, resourceId: "acc-1:service:gone" }, null),
    ).rejects.toMatchObject({ message: "No such resource.", status: 404 });
  });

  it("rejects a resource that belongs to a different account", async () => {
    // Resource lookup projection order: accountId, resourceTypeId.
    pg.queueRows([{ accountId: "acc-2", resourceTypeId: "ch-service" }]);
    const attempt = createQueryMonitor(
      "org-1",
      { ...baseInput, resourceId: "acc-2:service:s1" },
      null,
    );
    await expect(attempt).rejects.toBeInstanceOf(QueryMonitorInputError);
    await expect(attempt).rejects.toMatchObject({
      message: "That resource belongs to a different account.",
    });
  });

  it("fills resourceTypeId from the synced row, so callers may omit it", async () => {
    const now = new Date("2026-08-25T00:00:00.000Z");
    pg.queueRows([{ accountId: "acc-1", resourceTypeId: "ch-service" }]); // resource lookup
    pg.queueRows([]); // per-org count
    pg.queueRows([{ id: "acc-1" }]); // the account ownership check
    pg.queueRows([]); // the insert
    pg.queueRows([
      // getQueryMonitor, in selectMonitors projection order.
      {
        id: "9b8c1a2d-0000-0000-0000-000000000000",
        name: "Dead letters",
        description: null,
        accountId: "acc-1",
        accountName: "CH Cloud",
        resourceId: "acc-1:service:s1",
        resourceTypeId: "ch-service",
        resourceName: "analytics",
        sql: baseInput.sql,
        mode: "scalar",
        operator: "gt",
        threshold: 100,
        intervalMinutes: 15,
        consecutiveBreaches: 1,
        enabled: true,
        state: "unknown",
        lastValue: null,
        lastRunAt: null,
        lastError: null,
        breachStreak: 0,
        lastAlertedAt: null,
        createdByUserId: null,
        createdAt: now,
        updatedAt: now,
      },
    ]);

    const created = await createQueryMonitor(
      "org-1",
      { ...baseInput, resourceId: "acc-1:service:s1" },
      null,
    );
    expect(created.resourceTypeId).toBe("ch-service");

    // The stored type is the row's, not the caller's: the insert carries it.
    const insert = pg.queries.find((q) => q.sql.startsWith("insert"));
    expect(insert).toBeDefined();
    expect(insert!.params).toContain("ch-service");
    expect(insert!.params).toContain("acc-1:service:s1");
  });
});
