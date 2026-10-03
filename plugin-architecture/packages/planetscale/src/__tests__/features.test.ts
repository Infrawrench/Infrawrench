import { describe, it, expect, vi, afterEach } from "vitest";
import { PlanetScaleClient } from "../client.js";
import { planetscaleTerraformExport } from "../terraform.js";
import type { ResourceInstance } from "@infrawrench/plugin-base";

const ACCOUNT = "acct1";
const DB = "/v1/organizations/myorg/databases";

function client() {
  return new PlanetScaleClient({
    serviceTokenId: "tid",
    serviceTokenSecret: "tsecret",
    organizationName: "myorg",
  });
}

function response(json: unknown, status = 200): Response {
  return {
    ok: status < 400,
    status,
    json: async () => json,
    text: async () => JSON.stringify(json),
  } as unknown as Response;
}

/** Route by `"METHOD /path"` (query ignored); unrouted calls answer 404. */
function routeFetch(routes: Record<string, unknown>) {
  return vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const url = new URL(String(input));
    const key = `${(init?.method ?? "GET").toUpperCase()} ${url.pathname}`;
    if (key in routes) return response(routes[key]);
    return response({ message: `unrouted ${key}` }, 404);
  });
}

function calls(mock: ReturnType<typeof routeFetch>): string[] {
  return mock.mock.calls.map(([input, init]) => {
    const url = new URL(String(input));
    return `${(init?.method ?? "GET").toUpperCase()} ${url.pathname}`;
  });
}

function bodyOf(mock: ReturnType<typeof routeFetch>, method: string): unknown {
  const call = mock.mock.calls.find(([, init]) => init?.method === method);
  return call ? JSON.parse(String(call[1]!.body)) : undefined;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("database settings", () => {
  it("lists engine and settings", async () => {
    routeFetch({
      [`GET ${DB}`]: {
        data: [
          {
            name: "pg",
            kind: "postgresql",
            region: { slug: "us-east" },
            state: "ready",
            default_branch: "main",
            deletion_protected: true,
            require_approval_for_deploy: true,
          },
        ],
      },
    });
    const [db] = await client().listResources("ps-database", ACCOUNT);
    expect(db!.fields).toMatchObject({
      kind: "postgresql",
      defaultBranch: "main",
      deletionProtected: true,
      requireApprovalForDeploy: true,
      allowDataBranching: false,
    });
  });

  it("patches only changed settings, mapping foreign keys to its write name", async () => {
    const mock = routeFetch({
      [`GET ${DB}/app`]: {
        name: "app",
        kind: "mysql",
        region: { slug: "us-east" },
        state: "ready",
        default_branch: "main",
        deletion_protected: false,
        foreign_keys_enabled: false,
        insights_raw_queries: true,
      },
      [`PATCH ${DB}/app`]: { name: "app", region: { slug: "us-east" }, state: "ready" },
    });
    await client().updateResource("ps-database", "acct1:ps-database:app", ACCOUNT, {
      deletionProtected: "true",
      foreignKeysEnabled: "true",
      insightsRawQueries: "true",
      defaultBranch: "main",
      migrationFramework: "",
    });
    expect(bodyOf(mock, "PATCH")).toEqual({
      deletion_protected: true,
      allow_foreign_key_constraints: true,
    });
  });

  it("creates a Postgres database with its cluster size", async () => {
    const mock = routeFetch({
      [`POST ${DB}`]: {
        name: "pg",
        kind: "postgresql",
        region: { slug: "us-east" },
        state: "pending",
      },
    });
    const created = await client().createResource("ps-database", ACCOUNT, {
      name: "pg",
      kind: "postgresql",
      region: "us-east",
      clusterSizeMysql: "PS_10",
      clusterSizePostgres: "PS_5_AWS_X86",
    });
    expect(bodyOf(mock, "POST")).toEqual({
      name: "pg",
      region: "us-east",
      cluster_size: "PS_5_AWS_X86",
      kind: "postgresql",
    });
    expect(created.fields["kind"]).toBe("postgresql");
  });
});

describe("branch actions and settings", () => {
  it("dispatches promote, demote and safe migrations", async () => {
    const path = `${DB}/app/branches/dev`;
    const mock = routeFetch({
      [`POST ${path}/promote`]: {},
      [`POST ${path}/demote`]: {},
      [`POST ${path}/safe-migrations`]: {},
      [`DELETE ${path}/safe-migrations`]: {},
    });
    const c = client();
    for (const action of [
      "promote",
      "demote",
      "enable-safe-migrations",
      "disable-safe-migrations",
    ]) {
      await c.invokeAction("ps-branch", "acct1:ps-branch:app/dev", action, ACCOUNT);
    }
    expect(calls(mock)).toEqual([
      `POST ${path}/promote`,
      `POST ${path}/demote`,
      `POST ${path}/safe-migrations`,
      `DELETE ${path}/safe-migrations`,
    ]);
  });

  it("toggles branch deletion protection", async () => {
    const mock = routeFetch({
      [`PATCH ${DB}/app/branches/main`]: { name: "main", deletion_protected: true, ready: true },
    });
    const res = await client().updateResource("ps-branch", "acct1:ps-branch:app/main", ACCOUNT, {
      deletionProtected: "true",
    });
    expect(bodyOf(mock, "PATCH")).toEqual({ deletion_protected: true });
    expect(res.fields["deletionProtected"]).toBe(true);
  });

  it("shows engine-appropriate actions on the detail page", () => {
    const base = {
      id: "acct1:ps-branch:app/main",
      pluginId: "planetscale",
      resourceTypeId: "ps-branch",
      accountId: ACCOUNT,
      displayName: "main",
      resolvedOutputs: {},
      secretStates: [],
      createdAt: "",
      updatedAt: "",
    } satisfies Omit<ResourceInstance, "fields">;
    const vitess = client().renderDetail({
      ...base,
      fields: { kind: "mysql", production: true, safeMigrations: false, ready: true },
    });
    const ids = (d: typeof vitess) =>
      (d.headerActions ?? []).map((a) =>
        "action" in a && "actionId" in a.action ? a.action.actionId : "",
      );
    expect(ids(vitess)).toEqual(["", "demote", "enable-safe-migrations"]);
    expect(vitess.metricsCapability).toBeTruthy();
    expect(vitess.logs).toEqual({ defaultTailLines: 50 });

    const pg = client().renderDetail({
      ...base,
      fields: { kind: "postgresql", production: false, ready: true },
    });
    expect(ids(pg)).toEqual(["", "promote"]);
  });
});

describe("deploy request actions", () => {
  it("maps each action to its route", async () => {
    const path = `${DB}/app/deploy-requests/7`;
    const mock = routeFetch({
      [`POST ${path}/deploy`]: {},
      [`POST ${path}/apply-deploy`]: {},
      [`POST ${path}/cancel`]: {},
      [`POST ${path}/skip-revert`]: {},
      [`POST ${path}/revert`]: {},
      [`PATCH ${path}`]: {},
    });
    const c = client();
    for (const action of ["deploy", "apply", "cancel", "skip-revert", "revert", "close"]) {
      await c.invokeAction("ps-deploy-request", "acct1:ps-deploy-request:app/7", action, ACCOUNT);
    }
    expect(calls(mock)).toEqual([
      `POST ${path}/deploy`,
      `POST ${path}/apply-deploy`,
      `POST ${path}/cancel`,
      `POST ${path}/skip-revert`,
      `POST ${path}/revert`,
      `PATCH ${path}`,
    ]);
    expect(bodyOf(mock, "PATCH")).toEqual({ state: "closed" });
  });

  it("offers Deploy only once the request is ready", () => {
    const render = (deploymentState: string) =>
      client()
        .renderDetail({
          id: "x",
          pluginId: "planetscale",
          resourceTypeId: "ps-deploy-request",
          accountId: ACCOUNT,
          displayName: "#7",
          fields: { state: "open", deploymentState, number: 7 },
          resolvedOutputs: {},
          secretStates: [],
          createdAt: "",
          updatedAt: "",
        })
        .headerActions!.map((a) => a.label);
    expect(render("ready")).toEqual(["Refresh", "Deploy", "Close"]);
    expect(render("in_progress")).toEqual(["Refresh", "Cancel Deploy"]);
    expect(render("complete_pending_revert")).toEqual([
      "Refresh",
      "Skip Revert Period",
      "Revert",
      "Close",
    ]);
  });

  it("rejects unknown actions", async () => {
    await expect(
      client().invokeAction("ps-deploy-request", "acct1:ps-deploy-request:app/7", "nope", ACCOUNT),
    ).rejects.toThrow(/unknown action/);
  });
});

describe("Postgres roles", () => {
  it("lists roles only on Postgres branches", async () => {
    const mock = routeFetch({
      [`GET ${DB}`]: {
        data: [
          { name: "pg", kind: "postgresql", region: { slug: "us-east" } },
          { name: "my", kind: "mysql", region: { slug: "us-east" } },
        ],
      },
      [`GET ${DB}/pg/branches`]: { data: [{ name: "main", ready: true }] },
      [`GET ${DB}/my/branches`]: { data: [{ name: "main", ready: true }] },
      [`GET ${DB}/pg/branches/main/roles`]: {
        data: [
          {
            id: "r1",
            name: "app",
            username: "pscale_api_r1",
            access_host_url: "aws.connect.psdb.cloud",
            inherited_roles: ["pg_read_all_data", "postgres"],
            query_safety_settings: { require_where_on_delete: "on" },
          },
        ],
      },
    });
    const roles = await client().listResources("ps-role", ACCOUNT);
    expect(roles).toHaveLength(1);
    expect(roles[0]).toMatchObject({
      id: "acct1:ps-role:pg/main/r1",
      parentResourceId: "acct1:ps-branch:pg/main",
      fields: {
        inheritedRoles: "pg_read_all_data, postgres",
        superuser: true,
        requireWhereOnDelete: "on",
      },
    });
    expect(calls(mock)).not.toContain(`GET ${DB}/my/branches/main/roles`);
  });

  it("creates a role and captures its one-time connection string", async () => {
    const mock = routeFetch({
      [`POST ${DB}/pg/branches/main/roles`]: {
        id: "r2",
        name: "reporting",
        username: "pscale_api_r2",
        password: "pw",
        access_host_url: "aws.connect.psdb.cloud",
        inherited_roles: ["pg_read_all_data"],
      },
    });
    const role = await client().createResource(
      "ps-role",
      ACCOUNT,
      {
        name: "reporting",
        inheritedRoles: JSON.stringify(["pg_read_all_data"]),
        ttl: "3600",
        requireWhereOnDelete: "warn",
      },
      "acct1:ps-branch:pg/main",
    );
    expect(bodyOf(mock, "POST")).toEqual({
      name: "reporting",
      ttl: 3600,
      inherited_roles: ["pg_read_all_data"],
      require_where_on_delete: "warn",
    });
    expect(role.resolvedOutputs["connectionString"]).toBe(
      "postgresql://pscale_api_r2:pw@aws.connect.psdb.cloud:5432/postgres?sslmode=require",
    );
  });

  it("resets, renews and deletes roles", async () => {
    const path = `${DB}/pg/branches/main/roles/r1`;
    const mock = routeFetch({
      [`POST ${path}/reset`]: {},
      [`POST ${path}/renew`]: {},
      [`DELETE ${path}`]: {},
    });
    const c = client();
    await c.invokeAction("ps-role", "acct1:ps-role:pg/main/r1", "reset-password", ACCOUNT);
    await c.invokeAction("ps-role", "acct1:ps-role:pg/main/r1", "renew", ACCOUNT);
    await c.deleteResource("ps-role", "acct1:ps-role:pg/main/r1", ACCOUNT);
    expect(calls(mock)).toEqual([`POST ${path}/reset`, `POST ${path}/renew`, `DELETE ${path}`]);
  });
});

describe("backups", () => {
  it("creates an on-demand backup with retention", async () => {
    const mock = routeFetch({
      [`POST ${DB}/app/branches/main/backups`]: {
        id: "b1",
        name: "pre-migration",
        state: "pending",
      },
    });
    const res = await client().createResource("ps-backup", ACCOUNT, {
      branchRef: "app/main",
      name: "pre-migration",
      retentionValue: "2",
      retentionUnit: "week",
    });
    expect(bodyOf(mock, "POST")).toEqual({
      name: "pre-migration",
      retention_value: 2,
      retention_unit: "week",
    });
    expect(res.id).toBe("acct1:ps-backup:app/main/b1");
  });

  it("protects and deletes a backup", async () => {
    const path = `${DB}/app/branches/main/backups/b1`;
    const mock = routeFetch({
      [`PATCH ${path}`]: { id: "b1", name: "x", protected: true },
      [`DELETE ${path}`]: {},
    });
    const c = client();
    const res = await c.updateResource("ps-backup", "acct1:ps-backup:app/main/b1", ACCOUNT, {
      protected: "true",
    });
    expect(res.fields["protected"]).toBe(true);
    await c.deleteResource("ps-backup", "acct1:ps-backup:app/main/b1", ACCOUNT);
    expect(calls(mock)).toEqual([`PATCH ${path}`, `DELETE ${path}`]);
  });
});

describe("webhooks", () => {
  it("lists, creates, updates, tests and deletes", async () => {
    const mock = routeFetch({
      [`GET ${DB}`]: { data: [{ name: "app", region: { slug: "us-east" } }] },
      [`GET ${DB}/app/webhooks`]: {
        data: [
          {
            id: "w1",
            url: "https://hooks.example.com",
            enabled: true,
            events: ["branch.ready"],
            last_sent_success: false,
          },
        ],
      },
      [`POST ${DB}/app/webhooks`]: {
        id: "w2",
        url: "https://new.example.com",
        events: ["backup.failed"],
      },
      [`PATCH ${DB}/app/webhooks/w1`]: {
        id: "w1",
        url: "https://hooks.example.com",
        enabled: false,
      },
      [`POST ${DB}/app/webhooks/w1/test`]: {},
      [`DELETE ${DB}/app/webhooks/w1`]: {},
    });
    const c = client();
    const [hook] = await c.listResources("ps-webhook", ACCOUNT);
    expect(hook).toMatchObject({
      id: "acct1:ps-webhook:app/w1",
      fields: { events: "branch.ready", lastSentSuccess: false },
    });

    await c.createResource(
      "ps-webhook",
      ACCOUNT,
      {
        url: "https://new.example.com",
        events: JSON.stringify(["backup.failed"]),
        authorizationHeader: "Bearer x",
      },
      "acct1:ps-database:app",
    );
    expect(bodyOf(mock, "POST")).toEqual({
      url: "https://new.example.com",
      enabled: true,
      events: ["backup.failed"],
      authorization_header: "Bearer x",
    });

    await c.updateResource("ps-webhook", "acct1:ps-webhook:app/w1", ACCOUNT, {
      url: "https://hooks.example.com",
      events: "branch.ready, deploy_request.opened",
      enabled: "false",
      authorizationHeader: "",
    });
    expect(bodyOf(mock, "PATCH")).toEqual({
      url: "https://hooks.example.com",
      events: ["branch.ready", "deploy_request.opened"],
      enabled: false,
    });

    await c.invokeAction("ps-webhook", "acct1:ps-webhook:app/w1", "test", ACCOUNT);
    await c.deleteResource("ps-webhook", "acct1:ps-webhook:app/w1", ACCOUNT);
    expect(calls(mock).slice(-2)).toEqual([
      `POST ${DB}/app/webhooks/w1/test`,
      `DELETE ${DB}/app/webhooks/w1`,
    ]);
  });
});

describe("branch metrics", () => {
  it("asks for the curated metric set and labels each series", async () => {
    const mock = routeFetch({
      [`GET ${DB}/app/branches/main/metrics`]: {
        type: "MetricSeries",
        series: [
          { metric: "queries", label: "queries", labels: {}, points: [[1_790_000_000, 12]] },
          {
            metric: "planetscale_pods_cpu_util_percentages",
            label: "cpu",
            labels: { role: "primary" },
            points: [[1_790_000_000, 40]],
          },
          { metric: "rows_read", label: "rows", labels: {}, points: [] },
        ],
      },
    });
    const series = await client().fetchMetricSeries(
      "ps-branch",
      "acct1:ps-branch:app/main",
      ACCOUNT,
      {
        startMs: 1_789_990_000_000,
        endMs: 1_790_000_000_000,
      },
    );
    expect(series).toEqual([
      { label: "Queries", points: [{ timestamp: 1_790_000_000_000, value: 12 }] },
      {
        label: "CPU (primary)",
        unit: "%",
        points: [{ timestamp: 1_790_000_000_000, value: 40 }],
      },
    ]);
    const url = new URL(String(mock.mock.calls[0]![0]));
    expect(url.searchParams.get("metrics")).toContain("latency_p99");
    expect(url.searchParams.get("from")).toBe(new Date(1_789_990_000_000).toISOString());
  });

  it("charts the byte, disk and WAL series with byte units", async () => {
    const mock = routeFetch({
      [`GET ${DB}/app/branches/main/metrics`]: {
        series: [
          { metric: "egress_bytes", labels: {}, points: [[1_790_000_000, 2048]] },
          { metric: "planetscale_wal_size_bytes", labels: {}, points: [[1_790_000_000, 1]] },
          {
            metric: "planetscale_edge_bytes_sent_rate",
            labels: {},
            points: [[1_790_000_000, 5]],
          },
        ],
      },
    });
    const series = await client().fetchMetricSeries(
      "ps-branch",
      "acct1:ps-branch:app/main",
      ACCOUNT,
    );
    expect(series.map((s) => [s.label, s.unit])).toEqual([
      ["Egress", "bytes"],
      ["WAL Size", "bytes"],
      ["Edge Sent", "bytes/s"],
    ]);
    const asked = new URL(String(mock.mock.calls[0]![0])).searchParams.get("metrics") ?? "";
    for (const name of [
      "latency_p95",
      "planetscale_volume_usage_percentages",
      "planetscale_pods_iops_total",
    ]) {
      expect(asked.split(",")).toContain(name);
    }
  });

  it("returns nothing when the token can't read metrics", async () => {
    routeFetch({});
    expect(
      await client().fetchMetricSeries("ps-branch", "acct1:ps-branch:app/main", ACCOUNT),
    ).toEqual([]);
  });
});

describe("branch logs (Insights)", () => {
  it("renders query errors newest last and offers both feeds", async () => {
    const mock = routeFetch({
      [`GET ${DB}/app/branches/main/insights/errors`]: {
        type: "list",
        data: [
          {
            started_at: "2026-10-03T10:00:00Z",
            error_count: 3,
            time_per_query: 1.25,
            error_message: "Duplicate entry\n'1' for key 'PRIMARY'",
          },
          { started_at: "2026-10-03T09:00:00Z", error_count: 1, error_message: "deadlock" },
        ],
      },
    });
    const result = await client().getLogs("ps-branch", "acct1:ps-branch:app/main", ACCOUNT, {
      tailLines: 20,
    });
    expect(result.containers).toEqual(["query-errors", "anomalies"]);
    expect(result.activeContainer).toBe("query-errors");
    expect(result.text).toBe(
      "2026-10-03T09:00:00Z  ERROR  x1  deadlock\n" +
        "2026-10-03T10:00:00Z  ERROR  x3, avg 1.3 ms  Duplicate entry '1' for key 'PRIMARY'\n",
    );
    const url = new URL(String(mock.mock.calls[0]![0]));
    expect(url.searchParams.get("per_page")).toBe("20");
    expect(url.searchParams.get("sort")).toBe("lastRun");
    expect(url.searchParams.get("period")).toBe("1d");
  });

  it("renders anomalies with the most correlated query", async () => {
    routeFetch({
      [`GET ${DB}/app/branches/main/insights/anomalies`]: {
        data: [
          {
            period_start: "2026-10-03T08:00:00Z",
            period_end: "2026-10-03T08:30:00Z",
            active: false,
            minutes_in_violation: 12,
            correlations: [
              { r: 0.4, normalized_sql: "select 1" },
              { r: 0.91, normalized_sql: "select *\n from orders" },
            ],
          },
        ],
      },
    });
    const result = await client().getLogs("ps-branch", "acct1:ps-branch:app/main", ACCOUNT, {
      container: "anomalies",
    });
    expect(result.activeContainer).toBe("anomalies");
    expect(result.text).toBe(
      "2026-10-03T08:00:00Z  ANOMALY resolved  2026-10-03T08:00:00Z to 2026-10-03T08:30:00Z, 12 min over baseline" +
        "  likely cause (r=0.91): select * from orders\n",
    );
  });

  it("says so when there is nothing to show", async () => {
    routeFetch({ [`GET ${DB}/app/branches/main/insights/errors`]: { data: [] } });
    const result = await client().getLogs("ps-branch", "acct1:ps-branch:app/main", ACCOUNT, {});
    expect(result.text).toBe("No query errors on this branch in the last day.\n");
  });
});

describe("terraform export", () => {
  const resource = (typeId: string, externalId: string, fields: Record<string, unknown>) =>
    ({
      id: `acct1:${typeId}:${externalId}`,
      pluginId: "planetscale",
      resourceTypeId: typeId,
      accountId: ACCOUNT,
      displayName: String(fields["name"] ?? externalId),
      externalId,
      fields,
      resolvedOutputs: {},
      secretStates: [],
      createdAt: "",
      updatedAt: "",
    }) as ResourceInstance;

  it("maps Postgres branches with a JSON import id", () => {
    const out = planetscaleTerraformExport.mapResource(
      resource("ps-branch", "pg/dev", {
        id: "br_1",
        name: "dev",
        databaseName: "pg",
        organization: "myorg",
        kind: "postgresql",
        parentBranch: "main",
        deletionProtected: true,
      }),
    );
    expect(out?.resource.type).toBe("planetscale_postgres_branch");
    expect(out?.resource.attributes["deletion_protected"]).toEqual({ kind: "bool", value: true });
    expect(JSON.parse(out!.resource.importId!)).toEqual({
      database: "pg",
      id: "br_1",
      organization: "myorg",
    });
  });

  it("maps roles to planetscale_postgres_branch_role", () => {
    const out = planetscaleTerraformExport.mapResource(
      resource("ps-role", "pg/main/r1", {
        name: "app",
        databaseName: "pg",
        branchName: "main",
        organization: "myorg",
        inheritedRoles: "pg_read_all_data",
      }),
    );
    expect(out?.resource.type).toBe("planetscale_postgres_branch_role");
    expect(JSON.parse(out!.resource.importId!)).toEqual({
      branch: "main",
      database: "pg",
      id: "r1",
      organization: "myorg",
    });
  });
});
