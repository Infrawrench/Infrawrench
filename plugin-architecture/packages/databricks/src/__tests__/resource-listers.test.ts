import { describe, it, expect, vi } from "vitest";
import type { ListerContext } from "../resource-listers.js";
import {
  listClusters,
  listSqlWarehouses,
  listServingEndpoints,
  listJobs,
  listPipelines,
  listCatalogs,
  listSchemas,
  listTables,
} from "../resource-listers.js";

function makeCtx(apiImpl: (method: string, path: string) => unknown): ListerContext {
  return {
    api: vi.fn(async (method: string, path: string) => apiImpl(method, path)) as never,
    id: (accountId, typeId, externalId) => `${accountId}:${typeId}:${externalId}`,
    now: () => "2024-01-01T00:00:00.000Z",
    host: "https://dbc-test.cloud.databricks.com",
  };
}

const ACCOUNT = "acct1";

describe("listClusters", () => {
  it("maps fixed-workers cluster with start_time", async () => {
    const ctx = makeCtx(() => ({
      clusters: [
        {
          cluster_id: "c1",
          cluster_name: "My Cluster",
          state: "RUNNING",
          spark_version: "15.4",
          node_type_id: "i3.xlarge",
          num_workers: 4,
          autotermination_minutes: 60,
          cluster_source: "UI",
          creator_user_name: "me",
          spark_context_id: "ctx9",
          start_time: 1700000000000,
        },
      ],
    }));
    const res = await listClusters(ctx, ACCOUNT);
    expect(res[0]).toMatchObject({
      id: "acct1:databricks-cluster:c1",
      displayName: "My Cluster",
      fields: { numWorkers: 4, driverNodeTypeId: "i3.xlarge", state: "RUNNING" },
      resolvedOutputs: { clusterId: "c1", sparkContextId: "ctx9" },
    });
    expect(res[0].resolvedOutputs.jdbcUrl).toContain("dbc-test.cloud.databricks.com");
    expect(res[0].createdAt).toBe(new Date(1700000000000).toISOString());
  });

  it("maps autoscale cluster, uses display fallbacks and ctx.now", async () => {
    const ctx = makeCtx(() => ({
      clusters: [{ cluster_id: "c2", autoscale: { max_workers: 8 } }],
    }));
    const res = await listClusters(ctx, ACCOUNT);
    expect(res[0].displayName).toBe("c2");
    expect(res[0].fields.numWorkers).toBe(8);
    expect(res[0].createdAt).toBe("2024-01-01T00:00:00.000Z");
  });

  it("handles missing clusters array", async () => {
    const ctx = makeCtx(() => ({}));
    expect(await listClusters(ctx, ACCOUNT)).toEqual([]);
  });
});

describe("listSqlWarehouses", () => {
  it("maps warehouses", async () => {
    const ctx = makeCtx(() => ({
      warehouses: [
        {
          id: "w1",
          name: "WH",
          state: "RUNNING",
          cluster_size: "Small",
          min_num_clusters: 1,
          max_num_clusters: 3,
          auto_stop_mins: 10,
          warehouse_type: "PRO",
          enable_photon: true,
          num_active_sessions: 2,
          creator_name: "me",
        },
      ],
    }));
    const res = await listSqlWarehouses(ctx, ACCOUNT);
    expect(res[0]).toMatchObject({
      id: "acct1:databricks-sql-warehouse:w1",
      fields: { warehouseId: "w1", enablePhoton: true, numRunningQueries: 2 },
    });
    expect(res[0].resolvedOutputs.jdbcUrl).toContain("httpPath=/sql/1.0/warehouses/w1");
    expect(res[0].resolvedOutputs.odbcUrl).toContain("Simba Spark");
  });

  it("uses fallbacks and empty array", async () => {
    const ctx = makeCtx(() => ({ warehouses: [{}] }));
    const res = await listSqlWarehouses(ctx, ACCOUNT);
    expect(res[0].fields.state).toBe("STOPPED");
    expect(res[0].fields.warehouseType).toBe("PRO");
    const ctx2 = makeCtx(() => ({}));
    expect(await listSqlWarehouses(ctx2, ACCOUNT)).toEqual([]);
  });
});

describe("listServingEndpoints", () => {
  it("maps READY endpoint with timestamps", async () => {
    const ctx = makeCtx(() => ({
      endpoints: [
        {
          name: "ep",
          state: { ready: "READY" },
          task: "chat",
          creator: "me",
          creation_timestamp: 1700000000000,
          last_updated_timestamp: 1700000001000,
        },
      ],
    }));
    const res = await listServingEndpoints(ctx, ACCOUNT);
    expect(res[0]).toMatchObject({ fields: { state: "READY", task: "chat" } });
    expect(res[0].createdAt).toBe(new Date(1700000000000).toISOString());
  });

  it("maps NOT_READY and UNKNOWN states without timestamps", async () => {
    const ctx = makeCtx(() => ({
      endpoints: [
        { name: "a", state: { ready: "NOT_READY" } },
        { name: "b", state: {} },
      ],
    }));
    const res = await listServingEndpoints(ctx, ACCOUNT);
    expect(res[0].fields.state).toBe("NOT_READY");
    expect(res[1].fields.state).toBe("UNKNOWN");
    expect(res[0].createdAt).toBe("2024-01-01T00:00:00.000Z");
  });

  it("handles empty", async () => {
    const ctx = makeCtx(() => ({}));
    expect(await listServingEndpoints(ctx, ACCOUNT)).toEqual([]);
  });
});

describe("listJobs", () => {
  it("maps job with schedule, tasks, and last run", async () => {
    const ctx = makeCtx(() => ({
      jobs: [
        {
          job_id: 42,
          creator_user_name: "me",
          created_time: 1700000000000,
          settings: {
            name: "Nightly",
            format: "MULTI_TASK",
            max_concurrent_runs: 2,
            schedule: { quartz_cron_expression: "0 0 12 * * ?" },
            tasks: [{}, {}],
          },
          last_run: { state: { life_cycle_state: "TERMINATED", result_state: "SUCCESS" } },
        },
      ],
    }));
    const res = await listJobs(ctx, ACCOUNT);
    expect(res[0]).toMatchObject({
      id: "acct1:databricks-job:42",
      displayName: "Nightly",
      fields: {
        jobId: 42,
        schedule: "0 0 12 * * ?",
        taskCount: 2,
        lastRunState: "TERMINATED",
        lastRunResult: "SUCCESS",
      },
    });
    expect(res[0].resolvedOutputs.jobUrl).toContain("/jobs/42");
  });

  it("uses fallbacks when settings/last_run absent", async () => {
    const ctx = makeCtx(() => ({ jobs: [{ job_id: 7 }] }));
    const res = await listJobs(ctx, ACCOUNT);
    expect(res[0].displayName).toBe("Job 7");
    expect(res[0].fields.lastRunState).toBe("");
    expect(res[0].fields.taskCount).toBe(0);
    expect(res[0].createdAt).toBe("2024-01-01T00:00:00.000Z");
  });

  it("handles empty", async () => {
    const ctx = makeCtx(() => ({}));
    expect(await listJobs(ctx, ACCOUNT)).toEqual([]);
  });
});

describe("listPipelines", () => {
  it("maps pipeline with spec and latest_updates", async () => {
    const ctx = makeCtx(() => ({
      statuses: [
        {
          pipeline_id: "p1",
          name: "My Pipeline",
          state: "RUNNING",
          creator_user_name: "me",
          spec: {
            target: "tgt",
            catalog: "cat",
            channel: "PREVIEW",
            continuous: true,
            photon: true,
          },
          latest_updates: [{ state: "COMPLETED" }],
        },
      ],
    }));
    const res = await listPipelines(ctx, ACCOUNT);
    expect(res[0]).toMatchObject({
      id: "acct1:databricks-pipeline:p1",
      fields: { target: "tgt", catalog: "cat", channel: "PREVIEW", continuous: true, photon: true },
    });
    expect(res[0].fields.lastUpdateState).toBe("COMPLETED");
  });

  it("falls back when spec/updates missing", async () => {
    const ctx = makeCtx(() => ({ statuses: [{ pipeline_id: "p2" }] }));
    const res = await listPipelines(ctx, ACCOUNT);
    expect(res[0].displayName).toBe("p2");
    expect(res[0].fields.channel).toBe("CURRENT");
    expect(res[0].fields.lastUpdateState).toBe("");
  });

  it("handles empty", async () => {
    const ctx = makeCtx(() => ({}));
    expect(await listPipelines(ctx, ACCOUNT)).toEqual([]);
  });
});

describe("listCatalogs", () => {
  it("maps catalogs with created_at", async () => {
    const ctx = makeCtx(() => ({
      catalogs: [
        {
          name: "main",
          owner: "me",
          comment: "c",
          catalog_type: "MANAGED_CATALOG",
          metastore_id: "ms1",
          created_at: 1700000000000,
        },
      ],
    }));
    const res = await listCatalogs(ctx, ACCOUNT);
    expect(res[0]).toMatchObject({
      id: "acct1:databricks-catalog:main",
      fields: { name: "main", owner: "me" },
      resolvedOutputs: { catalogName: "main", metastoreId: "ms1" },
    });
    expect(res[0].createdAt).toBe(new Date(1700000000000).toISOString());
  });

  it("falls back and handles empty", async () => {
    const ctx = makeCtx(() => ({ catalogs: [{}] }));
    const res = await listCatalogs(ctx, ACCOUNT);
    expect(res[0].fields.catalogType).toBe("MANAGED_CATALOG");
    expect(res[0].createdAt).toBe("2024-01-01T00:00:00.000Z");
    const ctx2 = makeCtx(() => ({}));
    expect(await listCatalogs(ctx2, ACCOUNT)).toEqual([]);
  });
});

describe("listSchemas", () => {
  it("maps schemas and builds correct URL", async () => {
    const apiSpy = vi.fn(async () => ({
      schemas: [{ name: "sales", owner: "me", comment: "c", created_at: 1700000000000 }],
    }));
    const ctx: ListerContext = {
      api: apiSpy as never,
      id: (a, t, e) => `${a}:${t}:${e}`,
      now: () => "now",
      host: "https://h",
    };
    const res = await listSchemas(ctx, ACCOUNT, "main");
    expect(apiSpy).toHaveBeenCalledWith("GET", "/api/2.1/unity-catalog/schemas?catalog_name=main");
    expect(res[0]).toMatchObject({
      id: "acct1:databricks-schema:main.sales",
      parentResourceId: "acct1:databricks-catalog:main",
      externalId: "main.sales",
      fields: { catalogName: "main", name: "sales" },
    });
  });

  it("handles empty", async () => {
    const ctx = makeCtx(() => ({}));
    expect(await listSchemas(ctx, ACCOUNT, "main")).toEqual([]);
  });
});

describe("listTables", () => {
  it("maps tables and builds correct URL", async () => {
    const apiSpy = vi.fn(async () => ({
      tables: [
        {
          name: "t",
          table_type: "MANAGED",
          data_source_format: "DELTA",
          owner: "me",
          storage_location: "s3://x",
          columns: [{}, {}, {}],
          created_at: 1700000000000,
        },
      ],
    }));
    const ctx: ListerContext = {
      api: apiSpy as never,
      id: (a, t, e) => `${a}:${t}:${e}`,
      now: () => "now",
      host: "https://h",
    };
    const res = await listTables(ctx, ACCOUNT, "main", "sales");
    expect(apiSpy).toHaveBeenCalledWith(
      "GET",
      "/api/2.1/unity-catalog/tables?catalog_name=main&schema_name=sales&max_results=1000",
    );
    expect(res[0]).toMatchObject({
      id: "acct1:databricks-table:main.sales.t",
      parentResourceId: "acct1:databricks-schema:main.sales",
      fields: { columnCount: 3, dataSourceFormat: "DELTA", storageLocation: "s3://x" },
    });
  });

  it("falls back when columns absent and handles empty", async () => {
    const ctx = makeCtx(() => ({ tables: [{ name: "t" }] }));
    const res = await listTables(ctx, ACCOUNT, "main", "sales");
    expect(res[0].fields.columnCount).toBe(0);
    const ctx2 = makeCtx(() => ({}));
    expect(await listTables(ctx2, ACCOUNT, "main", "sales")).toEqual([]);
  });
});
