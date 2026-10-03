import { afterEach, describe, expect, it, vi } from "vitest";
import { normalizeResourceCreateResult } from "@infrawrench/plugin-base";
import { DatabricksClient } from "../client.js";
import { plugin } from "../plugin.js";

const ACCOUNT = "acct1";
const HOST = "https://dbc-test.cloud.databricks.com";

interface Call {
  method: string;
  path: string;
  body: unknown;
}
let calls: Call[] = [];

function route(routes: Array<[string, string, unknown]>) {
  vi.spyOn(globalThis, "fetch").mockImplementation((async (url: string, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    const path = String(url).replace(HOST, "");
    calls.push({ method, path, body: init?.body ? JSON.parse(String(init.body)) : undefined });
    for (const [m, p, body] of routes) {
      if (m === method && p === path) {
        const text = JSON.stringify(body);
        return { ok: true, status: 200, text: async () => text } as Response;
      }
    }
    throw new Error(`unrouted: ${method} ${path}`);
  }) as typeof fetch);
}

function client() {
  return new DatabricksClient(
    { host: "dbc-test.cloud.databricks.com", token: "dapi123" },
    plugin.resourceTypes,
  );
}

afterEach(() => {
  calls = [];
  vi.restoreAllMocks();
});

describe("lifecycle declarations", () => {
  it("declares start/stop pairs the client handles", () => {
    for (const id of ["databricks-cluster", "databricks-sql-warehouse", "databricks-app"]) {
      const type = plugin.resourceTypes.find((t) => t.id === id)!;
      expect(type.lifecycle).toBeDefined();
    }
  });
});

describe("invokeAction", () => {
  it.each([
    ["databricks-cluster", "c1", "start", "/api/2.1/clusters/start", { cluster_id: "c1" }],
    ["databricks-cluster", "c1", "restart", "/api/2.1/clusters/restart", { cluster_id: "c1" }],
    ["databricks-cluster", "c1", "terminate", "/api/2.1/clusters/delete", { cluster_id: "c1" }],
    ["databricks-sql-warehouse", "w1", "start", "/api/2.0/sql/warehouses/w1/start", undefined],
    ["databricks-sql-warehouse", "w1", "stop", "/api/2.0/sql/warehouses/w1/stop", undefined],
    ["databricks-job", "42", "run-now", "/api/2.2/jobs/run-now", { job_id: 42 }],
    ["databricks-job", "42", "cancel-all-runs", "/api/2.2/jobs/runs/cancel-all", { job_id: 42 }],
    [
      "databricks-pipeline",
      "p1",
      "start-update",
      "/api/2.0/pipelines/p1/updates",
      { cause: "API_CALL" },
    ],
    [
      "databricks-pipeline",
      "p1",
      "full-refresh",
      "/api/2.0/pipelines/p1/updates",
      { full_refresh: true, cause: "API_CALL" },
    ],
    ["databricks-pipeline", "p1", "stop", "/api/2.0/pipelines/p1/stop", undefined],
    ["databricks-app", "my-app", "start", "/api/2.0/apps/my-app/start", undefined],
    ["databricks-app", "my-app", "stop", "/api/2.0/apps/my-app/stop", undefined],
  ])("%s %s %s", async (typeId, id, actionId, path, body) => {
    route([["POST", path, {}]]);
    await client().invokeAction(typeId, `${ACCOUNT}:${typeId}:${id}`, actionId, ACCOUNT);
    expect(calls).toEqual([{ method: "POST", path, body }]);
  });

  it("rejects unknown actions", async () => {
    await expect(
      client().invokeAction("databricks-table", "acct1:databricks-table:a.b.c", "start", ACCOUNT),
    ).rejects.toThrow(/not supported/);
  });
});

describe("detail actions", () => {
  it("offers Start on a terminated cluster and Terminate on a running one", async () => {
    route([
      [
        "GET",
        "/api/2.1/clusters/list?page_size=100",
        {
          clusters: [
            { cluster_id: "c1", cluster_name: "a", state: "TERMINATED" },
            {
              cluster_id: "c2",
              cluster_name: "b",
              state: "RUNNING",
              autoscale: { min_workers: 2, max_workers: 6 },
            },
          ],
        },
      ],
    ]);
    const c = client();
    const [stopped, running] = await c.listResources("databricks-cluster", ACCOUNT);
    expect(c.renderDetail(stopped!).headerActions!.map((a) => a.label)).toContain("Start");
    expect(c.renderDetail(running!).headerActions!.map((a) => a.label)).toEqual(
      expect.arrayContaining(["Restart", "Terminate"]),
    );
    expect(running!.fields).toMatchObject({ minWorkers: 2, maxWorkers: 6 });
  });

  it("shows recent job runs from enrichDetail", async () => {
    route([
      [
        "GET",
        "/api/2.2/jobs/runs/list?job_id=42&limit=10",
        {
          runs: [
            {
              run_id: 7,
              start_time: 1_700_000_000_000,
              run_duration: 125_000,
              trigger: "PERIODIC",
              status: { state: "TERMINATED", termination_details: { code: "SUCCESS" } },
            },
          ],
        },
      ],
    ]);
    const c = client();
    const job = {
      id: "acct1:databricks-job:42",
      pluginId: "databricks",
      resourceTypeId: "databricks-job",
      accountId: ACCOUNT,
      displayName: "nightly",
      fields: { jobId: 42, name: "nightly" },
      resolvedOutputs: {},
      secretStates: [],
      externalId: "42",
      createdAt: "",
      updatedAt: "",
    };
    const detail = c.renderDetail(await c.enrichDetail(job));
    const text = JSON.stringify(detail);
    expect(text).toContain("Recent runs (1)");
    expect(text).toContain("SUCCESS");
    expect(text).toContain("2m 5s");
    expect(detail.headerActions!.map((a) => a.label)).toContain("Run now");
  });
});

describe("updateResource", () => {
  it("resizes a fixed cluster", async () => {
    route([
      ["POST", "/api/2.1/clusters/resize", {}],
      [
        "GET",
        "/api/2.1/clusters/list?page_size=100",
        { clusters: [{ cluster_id: "c1", num_workers: 5 }] },
      ],
    ]);
    const updated = await client().updateResource(
      "databricks-cluster",
      "acct1:databricks-cluster:c1",
      ACCOUNT,
      { numWorkers: "5" },
    );
    expect(calls[0]).toEqual({
      method: "POST",
      path: "/api/2.1/clusters/resize",
      body: { cluster_id: "c1", num_workers: 5 },
    });
    expect(updated.fields["numWorkers"]).toBe(5);
  });

  it("switches a cluster to autoscaling with the current bound filled in", async () => {
    route([
      [
        "GET",
        "/api/2.1/clusters/list?page_size=100",
        { clusters: [{ cluster_id: "c1", autoscale: { min_workers: 1, max_workers: 4 } }] },
      ],
      ["POST", "/api/2.1/clusters/resize", {}],
    ]);
    await client().updateResource("databricks-cluster", "acct1:databricks-cluster:c1", ACCOUNT, {
      maxWorkers: "8",
    });
    expect(calls.find((c) => c.method === "POST")!.body).toEqual({
      cluster_id: "c1",
      autoscale: { min_workers: 1, max_workers: 8 },
    });
  });

  it("edits a warehouse on top of its current definition", async () => {
    route([
      [
        "GET",
        "/api/2.0/sql/warehouses/w1",
        {
          id: "w1",
          name: "WH",
          cluster_size: "Small",
          min_num_clusters: 1,
          max_num_clusters: 2,
          auto_stop_mins: 30,
          enable_photon: true,
          tags: { custom_tags: [{ key: "team", value: "data" }] },
        },
      ],
      ["POST", "/api/2.0/sql/warehouses/w1/edit", {}],
      [
        "GET",
        "/api/2.0/sql/warehouses",
        { warehouses: [{ id: "w1", name: "WH", cluster_size: "Large" }] },
      ],
    ]);
    await client().updateResource(
      "databricks-sql-warehouse",
      "acct1:databricks-sql-warehouse:w1",
      ACCOUNT,
      { clusterSize: "Large", autoStopMinutes: "10" },
    );
    const edit = calls.find((c) => c.path.endsWith("/edit"))!;
    expect(edit.body).toEqual({
      name: "WH",
      cluster_size: "Large",
      min_num_clusters: 1,
      max_num_clusters: 2,
      auto_stop_mins: 10,
      enable_photon: true,
      tags: { custom_tags: [{ key: "team", value: "data" }] },
    });
  });

  it("rejects an unknown warehouse size", async () => {
    route([["GET", "/api/2.0/sql/warehouses/w1", { id: "w1" }]]);
    await expect(
      client().updateResource(
        "databricks-sql-warehouse",
        "acct1:databricks-sql-warehouse:w1",
        ACCOUNT,
        {
          clusterSize: "Huge",
        },
      ),
    ).rejects.toThrow(/Unknown warehouse size/);
  });
});

describe("SQL warehouse create", () => {
  it("creates serverless as a PRO warehouse with serverless compute", async () => {
    route([["POST", "/api/2.0/sql/warehouses", { id: "w9" }]]);
    await client().createResource("databricks-sql-warehouse", ACCOUNT, {
      name: "sls",
      clusterSize: "X-Small",
      warehouseType: "SERVERLESS",
    });
    expect(calls[0]!.body).toMatchObject({
      warehouse_type: "PRO",
      enable_serverless_compute: true,
    });
  });
});

describe("Lakebase", () => {
  const PROJECT = {
    name: "projects/orders",
    project_id: "orders",
    create_time: "2026-09-01T00:00:00Z",
    status: {
      display_name: "Orders",
      pg_version: 17,
      owner: "me@example.com",
      history_retention_duration: "604800s",
      default_branch: "projects/orders/branches/production",
      synthetic_storage_size_bytes: 1024,
      default_endpoint_settings: {
        autoscaling_limit_min_cu: 0.5,
        autoscaling_limit_max_cu: 4,
        suspend_timeout_duration: "300s",
      },
    },
  };

  it("lists projects and their branches", async () => {
    route([
      ["GET", "/api/2.0/postgres/projects?page_size=100", { projects: [PROJECT] }],
      [
        "GET",
        "/api/2.0/postgres/projects/orders/branches?page_size=100",
        {
          branches: [
            {
              name: "projects/orders/branches/production",
              branch_id: "production",
              create_time: "2026-09-01T00:00:00Z",
              status: {
                current_state: "READY",
                default: true,
                is_protected: true,
                logical_size_bytes: 2048,
              },
            },
          ],
        },
      ],
    ]);
    const c = client();
    const [project] = await c.listResources("databricks-lakebase-project", ACCOUNT);
    expect(project!.fields).toMatchObject({
      projectId: "orders",
      displayName: "Orders",
      pgVersion: 17,
      minCu: 0.5,
      maxCu: 4,
      suspendTimeoutSeconds: 300,
      historyRetentionHours: 168,
      defaultBranch: "production",
    });
    const [branch] = await c.listResources("databricks-lakebase-branch", ACCOUNT);
    expect(branch!.parentResourceId).toBe("acct1:databricks-lakebase-project:orders");
    expect(branch!.fields).toMatchObject({ state: "READY", isDefault: true, isProtected: true });
  });

  it("creates a project with endpoint defaults", async () => {
    route([["POST", "/api/2.0/postgres/projects?project_id=orders", { name: "operations/1" }]]);
    const created = normalizeResourceCreateResult(
      await client().createResource("databricks-lakebase-project", ACCOUNT, {
        displayName: "Orders",
        projectId: "orders",
        pgVersion: "18",
        minCu: "1",
        maxCu: "8",
        suspendTimeoutSeconds: "0",
      }),
    ).resource;
    expect(calls[0]!.body).toEqual({
      spec: {
        display_name: "Orders",
        pg_version: 18,
        default_endpoint_settings: {
          autoscaling_limit_min_cu: 1,
          autoscaling_limit_max_cu: 8,
          no_suspension: true,
        },
      },
    });
    expect(created.id).toBe("acct1:databricks-lakebase-project:orders");
  });

  it("rejects an invalid project id", async () => {
    await expect(
      client().createResource("databricks-lakebase-project", ACCOUNT, { projectId: "Bad_Id" }),
    ).rejects.toThrow(/lowercase/);
  });

  it("patches with an update mask", async () => {
    route([
      ["GET", "/api/2.0/postgres/projects?page_size=100", { projects: [PROJECT] }],
      [
        "PATCH",
        "/api/2.0/postgres/projects/orders?update_mask=spec.display_name,spec.default_endpoint_settings",
        {},
      ],
    ]);
    await client().updateResource(
      "databricks-lakebase-project",
      "acct1:databricks-lakebase-project:orders",
      ACCOUNT,
      { displayName: "Orders v2", maxCu: "6" },
    );
    const patch = calls.find((c) => c.method === "PATCH")!;
    expect(patch.body).toEqual({
      name: "projects/orders",
      spec: {
        display_name: "Orders v2",
        default_endpoint_settings: {
          autoscaling_limit_min_cu: 0.5,
          autoscaling_limit_max_cu: 6,
          suspend_timeout_duration: "300s",
        },
      },
    });
  });

  it("refuses to delete the default branch", async () => {
    route([
      ["GET", "/api/2.0/postgres/projects?page_size=100", { projects: [PROJECT] }],
      [
        "GET",
        "/api/2.0/postgres/projects/orders/branches?page_size=100",
        {
          branches: [
            {
              name: "projects/orders/branches/production",
              branch_id: "production",
              status: { default: true },
            },
          ],
        },
      ],
    ]);
    await expect(
      client().deleteResource(
        "databricks-lakebase-branch",
        "acct1:databricks-lakebase-branch:orders/production",
        ACCOUNT,
      ),
    ).rejects.toThrow(/default branch/);
  });
});
