import { describe, it, expect, vi, beforeEach } from "vitest";

// --- Mock the Neon SDK ----------------------------------------------------
const api = {
  listProjects: vi.fn(),
  listProjectBranches: vi.fn(),
  listProjectEndpoints: vi.fn(),
  listProjectBranchDatabases: vi.fn(),
  listProjectBranchRoles: vi.fn(),
  getConnectionUri: vi.fn(),
  getProjectBranchRolePassword: vi.fn(),
  getConsumptionHistoryPerProject: vi.fn(),
  getConsumptionHistoryPerProjectV2: vi.fn(),
  getConsumptionHistoryPerBranchV2: vi.fn(),
  getProject: vi.fn(),
  getProjectBranch: vi.fn(),
  getActiveRegions: vi.fn(),
  updateProject: vi.fn(),
  updateProjectBranch: vi.fn(),
  updateProjectEndpoint: vi.fn(),
  updateProjectBranchDatabase: vi.fn(),
  restoreProjectBranch: vi.fn(),
  setDefaultProjectBranch: vi.fn(),
  restartProjectEndpoint: vi.fn(),
  createProject: vi.fn(),
  createProjectBranch: vi.fn(),
  createProjectBranchDatabase: vi.fn(),
  createProjectBranchRole: vi.fn(),
  createProjectEndpoint: vi.fn(),
  deleteProject: vi.fn(),
  deleteProjectBranch: vi.fn(),
  deleteProjectBranchDatabase: vi.fn(),
  deleteProjectEndpoint: vi.fn(),
  deleteProjectBranchRole: vi.fn(),
  resetProjectBranchRolePassword: vi.fn(),
  getProjectBranchDataApi: vi.fn(),
  createProjectBranchDataApi: vi.fn(),
  deleteProjectBranchDataApi: vi.fn(),
};

type CreateApiClientArgs = Parameters<
  (typeof import("@neondatabase/api-client"))["createApiClient"]
>;

const createApiClient = vi.fn((..._args: CreateApiClientArgs) => api);

vi.mock("@neondatabase/api-client", () => ({
  createApiClient: (...args: CreateApiClientArgs) => createApiClient(...args),
  ConsumptionHistoryGranularity: { Hourly: "hourly", Daily: "daily", Monthly: "monthly" },
  EndpointType: { ReadWrite: "read_write", ReadOnly: "read_only" },
  BucketAccessLevel: { Private: "private", PublicRead: "public_read" },
  CredentialScope: {
    StorageRead: "storage:read",
    StorageWrite: "storage:write",
    AiGatewayInvoke: "ai_gateway:invoke",
    FunctionsInvoke: "functions:invoke",
  },
  NeonAuthOauthProviderId: {
    Google: "google",
    Github: "github",
    Microsoft: "microsoft",
    Vercel: "vercel",
  },
  NeonAuthSupportedAuthProvider: { Mock: "mock", Stack: "stack", BetterAuth: "better_auth" },
}));

import { NeonClient } from "../client.js";

const ACCOUNT = "acct1";

function makeClient() {
  return new NeonClient({ apiKey: "neon_test" });
}

// resp.data helpers
const wrap = (data: unknown) => ({ data });

beforeEach(() => {
  vi.clearAllMocks();
});

describe("constructor", () => {
  it("throws without apiKey", () => {
    expect(() => new NeonClient({})).toThrow(/missing apiKey/);
  });

  it("creates api client with apiKey", () => {
    makeClient();
    expect(createApiClient).toHaveBeenCalledWith({ apiKey: "neon_test" });
  });
});

describe("listResources - projects", () => {
  it("paginates and maps projects", async () => {
    api.listProjects
      .mockResolvedValueOnce(
        wrap({
          projects: [
            {
              id: "p1",
              name: "Proj 1",
              region_id: "aws-us-east-2",
              pg_version: 17,
              created_at: "2024-01-01",
              updated_at: "2024-01-02",
            },
          ],
          pagination: { cursor: "c1" },
        }),
      )
      .mockResolvedValueOnce(wrap({ projects: [], pagination: undefined }));

    const client = makeClient();
    const res = await client.listResources("neon-project", ACCOUNT);

    expect(res).toHaveLength(1);
    expect(res[0]!).toMatchObject({
      id: "acct1:neon-project:p1",
      pluginId: "neon",
      resourceTypeId: "neon-project",
      displayName: "Proj 1",
      externalId: "p1",
      fields: { name: "Proj 1", region: "aws-us-east-2", pgVersion: "17" },
    });
    // second call passes the cursor
    expect(api.listProjects).toHaveBeenNthCalledWith(1, {});
    expect(api.listProjects).toHaveBeenNthCalledWith(2, { cursor: "c1" });
  });

  it("stops paginating when no cursor", async () => {
    api.listProjects.mockResolvedValue(
      wrap({ projects: [{ id: "p1", name: "P", region_id: "r", pg_version: 16 }] }),
    );
    const client = makeClient();
    const res = await client.listResources("neon-project", ACCOUNT);
    expect(res).toHaveLength(1);
    expect(api.listProjects).toHaveBeenCalledTimes(1);
  });

  it("throws on unknown type", async () => {
    const client = makeClient();
    await expect(client.listResources("nope", ACCOUNT)).rejects.toThrow(/unknown resource type/);
  });
});

describe("listResources - branches/endpoints/databases/roles", () => {
  beforeEach(() => {
    api.listProjects.mockResolvedValue(
      wrap({ projects: [{ id: "p1", name: "P", pg_version: 16 }] }),
    );
  });

  it("maps branches", async () => {
    api.listProjectBranches.mockResolvedValue(
      wrap({
        branches: [
          {
            id: "b1",
            name: "main",
            project_id: "p1",
            default: true,
            current_state: "ready",
            created_at: "c",
            updated_at: "u",
          },
        ],
      }),
    );
    const client = makeClient();
    const res = await client.listResources("neon-branch", ACCOUNT);
    expect(res[0]!).toMatchObject({
      id: "acct1:neon-branch:p1/b1",
      resourceTypeId: "neon-branch",
      fields: { primary: true, currentState: "ready" },
      parentResourceId: "acct1:neon-project:p1",
    });
  });

  it("skips branches that throw", async () => {
    api.listProjectBranches.mockRejectedValue(new Error("nope"));
    const client = makeClient();
    const res = await client.listResources("neon-branch", ACCOUNT);
    expect(res).toEqual([]);
  });

  it("maps endpoints", async () => {
    api.listProjectEndpoints.mockResolvedValue(
      wrap({
        endpoints: [
          {
            id: "ep1",
            host: "ep1.neon.tech",
            project_id: "p1",
            branch_id: "b1",
            current_state: "active",
            type: "read_write",
            autoscaling_limit_min_cu: 0.25,
            autoscaling_limit_max_cu: 2,
            suspend_timeout_seconds: 300,
            created_at: "c",
            updated_at: "u",
          },
        ],
      }),
    );
    const client = makeClient();
    const res = await client.listResources("neon-endpoint", ACCOUNT);
    expect(res[0]!).toMatchObject({
      id: "acct1:neon-endpoint:p1/ep1",
      displayName: "ep1.neon.tech",
      fields: { host: "ep1.neon.tech", autoscalingMinCu: "0.25", autoscalingMaxCu: "2" },
    });
  });

  it("skips endpoints that throw", async () => {
    api.listProjectEndpoints.mockRejectedValue(new Error("x"));
    const client = makeClient();
    expect(await client.listResources("neon-endpoint", ACCOUNT)).toEqual([]);
  });

  it("maps databases", async () => {
    api.listProjectBranches.mockResolvedValue(wrap({ branches: [{ id: "b1", name: "main" }] }));
    api.listProjectBranchDatabases.mockResolvedValue(
      wrap({
        databases: [
          {
            id: 5,
            name: "neondb",
            branch_id: "b1",
            owner_name: "neondb_owner",
            created_at: "c",
            updated_at: "u",
          },
        ],
      }),
    );
    const client = makeClient();
    const res = await client.listResources("neon-database", ACCOUNT);
    expect(res[0]!).toMatchObject({
      id: "acct1:neon-database:p1/b1/neondb",
      externalId: "5",
      fields: { name: "neondb", ownerName: "neondb_owner" },
    });
  });

  it("skips databases when branch list throws and when db list throws", async () => {
    api.listProjectBranches.mockResolvedValue(wrap({ branches: [{ id: "b1", name: "main" }] }));
    api.listProjectBranchDatabases.mockRejectedValue(new Error("x"));
    const client = makeClient();
    expect(await client.listResources("neon-database", ACCOUNT)).toEqual([]);

    api.listProjectBranches.mockRejectedValue(new Error("y"));
    expect(await client.listResources("neon-database", ACCOUNT)).toEqual([]);
  });

  it("maps roles", async () => {
    api.listProjectBranches.mockResolvedValue(wrap({ branches: [{ id: "b1", name: "main" }] }));
    api.listProjectBranchRoles.mockResolvedValue(
      wrap({
        roles: [{ name: "alice", protected: true, created_at: "c", updated_at: "u" }],
      }),
    );
    const client = makeClient();
    const res = await client.listResources("neon-role", ACCOUNT);
    expect(res[0]!).toMatchObject({
      id: "acct1:neon-role:p1/b1/alice",
      externalId: "alice",
      fields: { name: "alice", protected: true },
    });
  });

  it("defaults role.protected to false and skips errors", async () => {
    api.listProjectBranches.mockResolvedValue(wrap({ branches: [{ id: "b1", name: "main" }] }));
    api.listProjectBranchRoles.mockResolvedValue(wrap({ roles: [{ name: "bob" }] }));
    const client = makeClient();
    const res = await client.listResources("neon-role", ACCOUNT);
    expect(res[0]!.fields.protected).toBe(false);

    api.listProjectBranchRoles.mockRejectedValue(new Error("x"));
    expect(await client.listResources("neon-role", ACCOUNT)).toEqual([]);
  });

  it("maps enabled Data APIs and skips disabled databases", async () => {
    api.listProjectBranches.mockResolvedValue(wrap({ branches: [{ id: "b1", name: "main" }] }));
    api.listProjectBranchDatabases.mockResolvedValue(
      wrap({
        databases: [
          { id: 1, name: "neondb", branch_id: "b1", owner_name: "owner" },
          { id: 2, name: "disabled", branch_id: "b1", owner_name: "owner" },
        ],
      }),
    );
    api.getProjectBranchDataApi
      .mockResolvedValueOnce(
        wrap({
          url: "https://api.neon.tech/rest/v1",
          status: "enabled",
          settings: { db_anon_role: "anonymous", db_schemas: ["public"] },
          available_schemas: ["public", "auth"],
        }),
      )
      .mockRejectedValueOnce(new Error("not enabled"));

    const client = makeClient();
    const res = await client.listResources("neon-data-api", ACCOUNT);

    expect(res).toHaveLength(1);
    expect(res[0]!).toMatchObject({
      id: "acct1:neon-data-api:p1/b1/neondb",
      resourceTypeId: "neon-data-api",
      displayName: "neondb",
      fields: {
        url: "https://api.neon.tech/rest/v1",
        status: "enabled",
        database: "neondb",
        schemas: "public, auth",
        anonymousRole: "anonymous",
      },
      parentResourceId: "acct1:neon-database:p1/b1/neondb",
    });
    expect(api.getProjectBranchDataApi).toHaveBeenNthCalledWith(1, "p1", "b1", "neondb");
    expect(api.getProjectBranchDataApi).toHaveBeenNthCalledWith(2, "p1", "b1", "disabled");
  });
});

describe("getResource", () => {
  it("returns found resource", async () => {
    api.listProjects.mockResolvedValue(
      wrap({ projects: [{ id: "p1", name: "P", pg_version: 16 }] }),
    );
    const client = makeClient();
    const res = await client.getResource("neon-project", "acct1:neon-project:p1", ACCOUNT);
    expect(res.externalId).toBe("p1");
  });

  it("throws when not found", async () => {
    api.listProjects.mockResolvedValue(wrap({ projects: [] }));
    const client = makeClient();
    await expect(
      client.getResource("neon-project", "acct1:neon-project:missing", ACCOUNT),
    ).rejects.toThrow(/not found/);
  });
});

describe("resolveOutput", () => {
  function projectListed() {
    api.listProjects.mockResolvedValue(
      wrap({
        projects: [{ id: "p1", name: "P", region_id: "aws-us-east-2", pg_version: 17 }],
      }),
    );
  }

  it("resolves project simple fields", async () => {
    projectListed();
    const client = makeClient();
    const id = "acct1:neon-project:p1";
    expect(await client.resolveOutput("neon-project", id, "projectId", ACCOUNT)).toBe("p1");
    expect(await client.resolveOutput("neon-project", id, "region", ACCOUNT)).toBe("aws-us-east-2");
    expect(await client.resolveOutput("neon-project", id, "pgVersion", ACCOUNT)).toBe("17");
  });

  it("resolves project connection string", async () => {
    projectListed();
    api.listProjectBranches.mockResolvedValue(
      wrap({ branches: [{ id: "b1", name: "main", default: true }] }),
    );
    api.listProjectBranchDatabases.mockResolvedValue(
      wrap({ databases: [{ name: "neondb", owner_name: "owner" }] }),
    );
    api.getConnectionUri.mockResolvedValue(wrap({ uri: "postgres://conn" }));
    const client = makeClient();
    const uri = await client.resolveOutput(
      "neon-project",
      "acct1:neon-project:p1",
      "connectionString",
      ACCOUNT,
    );
    expect(uri).toBe("postgres://conn");
    expect(api.getConnectionUri).toHaveBeenCalledWith({
      projectId: "p1",
      branch_id: "b1",
      database_name: "neondb",
      role_name: "owner",
    });
  });

  it("project connection string throws when no branch/no db", async () => {
    projectListed();
    api.listProjectBranches.mockResolvedValue(wrap({ branches: [] }));
    const client = makeClient();
    await expect(
      client.resolveOutput("neon-project", "acct1:neon-project:p1", "connectionString", ACCOUNT),
    ).rejects.toThrow(/no branches found/);

    api.listProjectBranches.mockResolvedValue(wrap({ branches: [{ id: "b1", default: true }] }));
    api.listProjectBranchDatabases.mockResolvedValue(wrap({ databases: [] }));
    await expect(
      client.resolveOutput("neon-project", "acct1:neon-project:p1", "connectionString", ACCOUNT),
    ).rejects.toThrow(/no databases found/);
  });

  it("resolves branch outputs and connection string", async () => {
    api.listProjects.mockResolvedValue(
      wrap({ projects: [{ id: "p1", name: "P", pg_version: 16 }] }),
    );
    api.listProjectBranches.mockResolvedValue(
      wrap({ branches: [{ id: "b1", name: "main", project_id: "p1" }] }),
    );
    const client = makeClient();
    const id = "acct1:neon-branch:p1/b1";
    expect(await client.resolveOutput("neon-branch", id, "branchId", ACCOUNT)).toBe("b1");
    expect(await client.resolveOutput("neon-branch", id, "projectId", ACCOUNT)).toBe("p1");

    api.listProjectBranchDatabases.mockResolvedValue(
      wrap({ databases: [{ name: "db", owner_name: "o" }] }),
    );
    api.getConnectionUri.mockResolvedValue(wrap({ uri: "u://branch" }));
    expect(await client.resolveOutput("neon-branch", id, "connectionString", ACCOUNT)).toBe(
      "u://branch",
    );
  });

  it("branch connection string throws when no db", async () => {
    api.listProjects.mockResolvedValue(
      wrap({ projects: [{ id: "p1", name: "P", pg_version: 16 }] }),
    );
    api.listProjectBranches.mockResolvedValue(
      wrap({ branches: [{ id: "b1", name: "main", project_id: "p1" }] }),
    );
    api.listProjectBranchDatabases.mockResolvedValue(wrap({ databases: [] }));
    const client = makeClient();
    await expect(
      client.resolveOutput("neon-branch", "acct1:neon-branch:p1/b1", "connectionString", ACCOUNT),
    ).rejects.toThrow(/no databases found on this branch/);
  });

  it("resolves endpoint host and id", async () => {
    api.listProjects.mockResolvedValue(
      wrap({ projects: [{ id: "p1", name: "P", pg_version: 16 }] }),
    );
    api.listProjectEndpoints.mockResolvedValue(
      wrap({
        endpoints: [
          {
            id: "ep1",
            host: "h.neon",
            project_id: "p1",
            branch_id: "b1",
            autoscaling_limit_min_cu: 1,
            autoscaling_limit_max_cu: 1,
            suspend_timeout_seconds: 0,
          },
        ],
      }),
    );
    const client = makeClient();
    const id = "acct1:neon-endpoint:p1/ep1";
    expect(await client.resolveOutput("neon-endpoint", id, "host", ACCOUNT)).toBe("h.neon");
    expect(await client.resolveOutput("neon-endpoint", id, "endpointId", ACCOUNT)).toBe("ep1");
  });

  it("resolves database outputs and connection string", async () => {
    api.listProjects.mockResolvedValue(
      wrap({ projects: [{ id: "p1", name: "P", pg_version: 16 }] }),
    );
    api.listProjectBranches.mockResolvedValue(wrap({ branches: [{ id: "b1", name: "main" }] }));
    api.listProjectBranchDatabases.mockResolvedValue(
      wrap({ databases: [{ id: 1, name: "neondb", branch_id: "b1", owner_name: "owner" }] }),
    );
    api.getConnectionUri.mockResolvedValue(wrap({ uri: "u://db" }));
    const client = makeClient();
    const id = "acct1:neon-database:p1/b1/neondb";
    expect(await client.resolveOutput("neon-database", id, "database", ACCOUNT)).toBe("neondb");
    expect(await client.resolveOutput("neon-database", id, "host", ACCOUNT)).toBe("");
    expect(await client.resolveOutput("neon-database", id, "connectionString", ACCOUNT)).toBe(
      "u://db",
    );
  });

  it("resolves role password", async () => {
    api.listProjects.mockResolvedValue(
      wrap({ projects: [{ id: "p1", name: "P", pg_version: 16 }] }),
    );
    api.listProjectBranches.mockResolvedValue(wrap({ branches: [{ id: "b1", name: "main" }] }));
    api.listProjectBranchRoles.mockResolvedValue(wrap({ roles: [{ name: "alice" }] }));
    api.getProjectBranchRolePassword.mockResolvedValue(wrap({ password: "secret" }));
    const client = makeClient();
    const pw = await client.resolveOutput(
      "neon-role",
      "acct1:neon-role:p1/b1/alice",
      "password",
      ACCOUNT,
    );
    expect(pw).toBe("secret");
    expect(api.getProjectBranchRolePassword).toHaveBeenCalledWith("p1", "b1", "alice");
  });

  it("resolves Data API URL", async () => {
    projectListed();
    api.listProjectBranches.mockResolvedValue(wrap({ branches: [{ id: "b1", name: "main" }] }));
    api.listProjectBranchDatabases.mockResolvedValue(
      wrap({ databases: [{ id: 1, name: "neondb", branch_id: "b1", owner_name: "owner" }] }),
    );
    api.getProjectBranchDataApi.mockResolvedValue(
      wrap({ url: "https://api.neon.tech/rest/v1", status: "enabled" }),
    );

    const client = makeClient();
    const url = await client.resolveOutput(
      "neon-data-api",
      "acct1:neon-data-api:p1/b1/neondb",
      "url",
      ACCOUNT,
    );

    expect(url).toBe("https://api.neon.tech/rest/v1");
  });

  it("throws for unresolvable output", async () => {
    const client = makeClient();
    await expect(
      client.resolveOutput("neon-role", "acct1:neon-role:p1/b1/alice", "weird", ACCOUNT),
    ).rejects.toThrow(/cannot resolve output/);
  });
});

describe("fetchDashboardStats", () => {
  it("returns project stats with region flag", async () => {
    api.listProjects.mockResolvedValue(
      wrap({ projects: [{ id: "p1", name: "P", region_id: "aws-us-east-2", pg_version: 17 }] }),
    );
    const client = makeClient();
    const stats = await client.fetchDashboardStats(
      "neon-project",
      "acct1:neon-project:p1",
      ACCOUNT,
    );
    expect(stats[0]!.value).toContain("aws-us-east-2");
    expect(stats[1]).toMatchObject({ label: "PG Version", value: "17" });
  });

  it("returns project stats fallback when region unknown", async () => {
    api.listProjects.mockResolvedValue(
      wrap({ projects: [{ id: "p1", name: "P", region_id: "mars-1", pg_version: 17 }] }),
    );
    const client = makeClient();
    const stats = await client.fetchDashboardStats(
      "neon-project",
      "acct1:neon-project:p1",
      ACCOUNT,
    );
    expect(stats[0]!.value).toBe("mars-1");
  });

  it("returns endpoint stats with variants", async () => {
    api.listProjects.mockResolvedValue(
      wrap({ projects: [{ id: "p1", name: "P", pg_version: 16 }] }),
    );
    api.listProjectEndpoints.mockResolvedValue(
      wrap({
        endpoints: [
          {
            id: "ep1",
            host: "h",
            project_id: "p1",
            branch_id: "b1",
            current_state: "active",
            type: "read_write",
            autoscaling_limit_min_cu: 1,
            autoscaling_limit_max_cu: 2,
            suspend_timeout_seconds: 0,
          },
        ],
      }),
    );
    const client = makeClient();
    const stats = await client.fetchDashboardStats(
      "neon-endpoint",
      "acct1:neon-endpoint:p1/ep1",
      ACCOUNT,
    );
    expect(stats[0]).toMatchObject({ label: "State", value: "active", variant: "status-healthy" });
    expect(stats[2]!.value).toBe("1–2 CU");
  });

  it("returns branch stats with primary entry", async () => {
    api.listProjects.mockResolvedValue(
      wrap({ projects: [{ id: "p1", name: "P", pg_version: 16 }] }),
    );
    api.listProjectBranches.mockResolvedValue(
      wrap({
        branches: [
          { id: "b1", name: "main", project_id: "p1", default: true, current_state: "ready" },
        ],
      }),
    );
    const client = makeClient();
    const stats = await client.fetchDashboardStats(
      "neon-branch",
      "acct1:neon-branch:p1/b1",
      ACCOUNT,
    );
    expect(stats[0]).toMatchObject({ value: "ready", variant: "status-healthy" });
    expect(stats[1]).toMatchObject({ label: "Primary", value: "Yes" });
  });

  it("returns empty for unsupported type", async () => {
    api.listProjects.mockResolvedValue(
      wrap({ projects: [{ id: "p1", name: "P", pg_version: 16 }] }),
    );
    api.listProjectBranches.mockResolvedValue(wrap({ branches: [{ id: "b1", name: "main" }] }));
    api.listProjectBranchRoles.mockResolvedValue(wrap({ roles: [{ name: "alice" }] }));
    const client = makeClient();
    const stats = await client.fetchDashboardStats(
      "neon-role",
      "acct1:neon-role:p1/b1/alice",
      ACCOUNT,
    );
    expect(stats).toEqual([]);
  });
});

describe("fetchMetricSeries", () => {
  it("charts v2 usage for a project", async () => {
    api.getProject.mockResolvedValue(wrap({ project: { id: "p1", org_id: "org-1" } }));
    api.getConsumptionHistoryPerProjectV2.mockResolvedValue(
      wrap({
        projects: [
          {
            project_id: "p1",
            periods: [
              {
                consumption: [
                  {
                    timeframe_start: "2026-10-01T00:00:00Z",
                    metrics: [
                      { metric_name: "compute_unit_seconds", value: 7200 },
                      { metric_name: "public_network_transfer_bytes", value: 10 },
                      { metric_name: "root_branch_bytes_month", value: 0 },
                    ],
                  },
                ],
              },
            ],
          },
        ],
      }),
    );
    const client = makeClient();
    const now = Date.now();
    const series = await client.fetchMetricSeries(
      "neon-project",
      "acct1:neon-project:p1",
      ACCOUNT,
      {
        startMs: now - 3_600_000,
        endMs: now,
      },
    );
    expect(series.map((s) => s.label)).toEqual(["Compute", "Public Egress"]);
    expect(series[0]).toMatchObject({ unit: "CU-h", points: [{ value: 2 }] });
    expect(api.getConsumptionHistoryPerProjectV2).toHaveBeenCalledWith(
      expect.objectContaining({ org_id: "org-1", project_ids: ["p1"], granularity: "hourly" }),
    );
    expect(api.getConsumptionHistoryPerProject).not.toHaveBeenCalled();
  });

  it("falls back to legacy consumption without v2 data", async () => {
    api.getProject.mockResolvedValue(wrap({ project: { id: "p1", org_id: "org-1" } }));
    api.getConsumptionHistoryPerProjectV2.mockRejectedValue(new Error("legacy plan"));
    api.getConsumptionHistoryPerProject.mockResolvedValue(
      wrap({
        projects: [
          {
            project_id: "p1",
            periods: [
              {
                consumption: [
                  {
                    timeframe_start: "2024-01-01T00:00:00Z",
                    active_time_seconds: 10,
                    compute_time_seconds: 4,
                    written_data_bytes: 5,
                  },
                ],
              },
            ],
          },
        ],
      }),
    );
    const client = makeClient();
    const series = await client.fetchMetricSeries(
      "neon-project",
      "acct1:neon-project:p1",
      ACCOUNT,
      { startMs: 0, endMs: 1000 },
    );
    expect(series.map((s) => s.label)).toEqual(["Active Time", "Compute Time", "Data Written"]);
    expect(series[0]!.points[0]!.value).toBe(10);
    expect(api.getConsumptionHistoryPerProject).toHaveBeenCalledWith(
      expect.objectContaining({ granularity: "daily" }),
    );
  });

  it("returns empty when projectId missing", async () => {
    const client = makeClient();
    const series = await client.fetchMetricSeries("neon-project", "acct1:neon-project:", ACCOUNT);
    expect(series).toEqual([]);
  });

  it("returns empty when no periods", async () => {
    api.getConsumptionHistoryPerProject.mockResolvedValue(
      wrap({ projects: [{ project_id: "p1", periods: [] }] }),
    );
    const client = makeClient();
    expect(
      await client.fetchMetricSeries("neon-project", "acct1:neon-project:p1", ACCOUNT),
    ).toEqual([]);
  });

  it("returns empty when no timeframes", async () => {
    api.getConsumptionHistoryPerProject.mockResolvedValue(
      wrap({ projects: [{ project_id: "p1", periods: [{ consumption: [] }] }] }),
    );
    const client = makeClient();
    expect(
      await client.fetchMetricSeries("neon-project", "acct1:neon-project:p1", ACCOUNT),
    ).toEqual([]);
  });

  it("returns empty on api error", async () => {
    api.getConsumptionHistoryPerProject.mockRejectedValue(new Error("boom"));
    const client = makeClient();
    expect(
      await client.fetchMetricSeries("neon-project", "acct1:neon-project:p1", ACCOUNT),
    ).toEqual([]);
  });

  it("charts a branch from per-branch history", async () => {
    api.listProjects.mockResolvedValue(
      wrap({ projects: [{ id: "p1", name: "P", pg_version: 16 }] }),
    );
    api.listProjectBranches.mockResolvedValue(
      wrap({ branches: [{ id: "b1", name: "main", project_id: "p1" }] }),
    );
    api.getProject.mockResolvedValue(wrap({ project: { id: "p1", org_id: "org-1" } }));
    api.getConsumptionHistoryPerBranchV2.mockResolvedValue(
      wrap({
        branches: [
          {
            project_id: "p1",
            branch_id: "b1",
            periods: [
              {
                consumption: [
                  {
                    timeframe_start: "2026-10-01T00:00:00Z",
                    metrics: [{ metric_name: "child_branch_bytes_month", value: 2 ** 31 }],
                  },
                ],
              },
            ],
          },
        ],
      }),
    );
    const client = makeClient();
    const series = await client.fetchMetricSeries(
      "neon-branch",
      "acct1:neon-branch:p1/b1",
      ACCOUNT,
    );
    expect(series).toEqual([
      {
        label: "Child Branch Storage",
        unit: "GB-month",
        points: [{ timestamp: Date.parse("2026-10-01T00:00:00Z"), value: 2 }],
      },
    ]);
    expect(api.getConsumptionHistoryPerBranchV2).toHaveBeenCalledWith(
      expect.objectContaining({ org_id: "org-1", project_ids: ["p1"], branch_ids: ["b1"] }),
    );
  });
});

describe("renderDetail", () => {
  const base = {
    pluginId: "neon",
    accountId: ACCOUNT,
    resolvedOutputs: {},
    secretStates: [],
  };

  it("renders project detail with known region", () => {
    const client = makeClient();
    const d = client.renderDetail({
      ...base,
      id: "x",
      resourceTypeId: "neon-project",
      displayName: "P",
      externalId: "p1",
      fields: { region: "aws-us-east-2", pgVersion: "17", createdAt: "c" },
    } as never);
    expect(d.title).toBe("P");
    expect(d.subtitle).toContain("Ohio");
    expect(d.headerActions?.[1]!.action).toMatchObject({ type: "open-url" });
  });

  it("renders project detail with unknown region", () => {
    const client = makeClient();
    const d = client.renderDetail({
      ...base,
      id: "x",
      resourceTypeId: "neon-project",
      displayName: "P",
      externalId: "p1",
      fields: { region: "mars" },
    } as never);
    expect(d.subtitle).toContain("mars");
  });

  it("renders branch detail (primary)", () => {
    const client = makeClient();
    const d = client.renderDetail({
      ...base,
      id: "x",
      resourceTypeId: "neon-branch",
      displayName: "main",
      externalId: "b1",
      fields: { primary: true, currentState: "ready", projectId: "p1" },
    } as never);
    expect(d.subtitle).toContain("primary");
  });

  it("renders endpoint detail", () => {
    const client = makeClient();
    const d = client.renderDetail({
      ...base,
      id: "x",
      resourceTypeId: "neon-endpoint",
      displayName: "h",
      externalId: "ep1",
      fields: {
        host: "h",
        currentState: "active",
        type: "read_write",
        autoscalingMinCu: "1",
        autoscalingMaxCu: "2",
        suspendTimeout: "300",
      },
    } as never);
    expect(d.sections).toHaveLength(2);
  });

  it("renders endpoint detail with missing suspend timeout", () => {
    const client = makeClient();
    const d = client.renderDetail({
      ...base,
      id: "x",
      resourceTypeId: "neon-endpoint",
      displayName: "h",
      externalId: "ep1",
      fields: { host: "h", currentState: "active" },
    } as never);
    const autoscale = d.sections[1]! as never as {
      children: { items: { value: string }[] }[];
    };
    expect(autoscale.children[0]!.items[2]!.value).toBe("—");
  });

  it("renders database detail with secret placeholder", () => {
    const client = makeClient();
    const d = client.renderDetail({
      ...base,
      id: "x",
      resourceTypeId: "neon-database",
      displayName: "db",
      secretStates: [{ fieldKey: "connectionString", resolution: { kind: "missing" } }],
      fields: { name: "db", ownerName: "owner", projectId: "p1", branchId: "b1" },
    } as never);
    expect(d.subtitle).toContain("owner");
  });

  it("renders database detail with resolved output", () => {
    const client = makeClient();
    const d = client.renderDetail({
      ...base,
      id: "x",
      resourceTypeId: "neon-database",
      displayName: "db",
      resolvedOutputs: { connectionString: "postgres://x" },
      fields: { name: "db", ownerName: "owner" },
    } as never);
    expect(d.title).toBe("db");
  });

  it("renders database detail unavailable", () => {
    const client = makeClient();
    const d = client.renderDetail({
      ...base,
      id: "x",
      resourceTypeId: "neon-database",
      displayName: "db",
      fields: { name: "db" },
    } as never);
    expect(d.title).toBe("db");
  });

  it("renders role detail (protected)", () => {
    const client = makeClient();
    const d = client.renderDetail({
      ...base,
      id: "x",
      resourceTypeId: "neon-role",
      displayName: "alice",
      fields: { name: "alice", protected: true },
    } as never);
    expect(d.subtitle).toContain("protected");
  });

  it("renders Data API detail", () => {
    const client = makeClient();
    const d = client.renderDetail({
      ...base,
      id: "x",
      resourceTypeId: "neon-data-api",
      displayName: "neondb",
      fields: {
        url: "https://api.neon.tech/rest/v1",
        status: "enabled",
        database: "neondb",
        projectId: "p1",
        branchId: "b1",
        schemas: "public",
        anonymousRole: "anonymous",
      },
    } as never);
    expect(d.subtitle).toContain("enabled");
    expect(d.sections).toHaveLength(1);
  });

  it("renders generic detail for unknown type", () => {
    const client = makeClient();
    const d = client.renderDetail({
      ...base,
      id: "x",
      resourceTypeId: "neon-other",
      displayName: "o",
      fields: { a: 1 },
    } as never);
    expect(d.subtitle).toBe("neon-other");
  });
});

describe("renderSidebarItem", () => {
  it("maps state to status dot", () => {
    const client = makeClient();
    const item = client.renderSidebarItem({
      id: "x",
      displayName: "main",
      fields: { currentState: "ready" },
    } as never);
    expect(item.status).toMatchObject({ kind: "status-dot", status: "healthy" });
  });

  it("uses info when no state", () => {
    const client = makeClient();
    const item = client.renderSidebarItem({
      id: "x",
      displayName: "main",
      fields: {},
    } as never);
    expect(item.status).toMatchObject({ status: "info" });
  });
});

describe("getCreateConfig", () => {
  it("project config has region picker", async () => {
    const client = makeClient();
    api.getActiveRegions.mockResolvedValue(
      wrap({ regions: [{ region_id: "aws-us-east-1", name: "AWS US East (N. Virginia)" }] }),
    );
    const cfg = await client.getCreateConfig("neon-project");
    expect(cfg.fields.map((f) => f.key)).toEqual([
      "name",
      "region",
      "pgVersion",
      "historyRetentionSeconds",
    ]);
    const region = cfg.fields.find((f) => f.key === "region")!;
    expect(region.regions?.map((r) => r.id)).toEqual(["aws-us-east-1"]);
    expect(region.defaultValue).toBe("aws-us-east-1");
    expect(cfg.fields.find((f) => f.key === "pgVersion")?.defaultValue).toBe("18");
  });

  it("project config falls back to the static region table", async () => {
    api.getActiveRegions.mockRejectedValue(new Error("x"));
    const client = makeClient();
    const cfg = await client.getCreateConfig("neon-project");
    const region = cfg.fields.find((f) => f.key === "region")!;
    expect(region.defaultValue).toBe("aws-us-east-2");
  });

  it("branch config lists projects when no parent", async () => {
    api.listProjects.mockResolvedValue(
      wrap({
        projects: [
          { id: "p1", name: "P" },
          { id: "p2", name: "Q" },
        ],
      }),
    );
    const client = makeClient();
    const cfg = await client.getCreateConfig("neon-branch");
    expect(cfg.fields[0]!.key).toBe("projectId");
    expect(cfg.fields[0]).toMatchObject({ defaultValue: "p1" });
  });

  it("branch config omits project picker with parent", async () => {
    const client = makeClient();
    api.listProjectBranches.mockResolvedValue(
      wrap({ branches: [{ id: "b1", name: "main", default: true }] }),
    );
    const cfg = await client.getCreateConfig("neon-branch", "acct1:neon-project:p1");
    expect(cfg.fields.map((f) => f.key)).toEqual([
      "name",
      "parentId",
      "initSource",
      "parentTimestamp",
      "expiresAt",
      "protected",
    ]);
    expect(cfg.fields.find((f) => f.key === "parentId")?.options).toEqual([
      { id: "", label: "Default branch" },
      { id: "b1", label: "main (default)" },
    ]);
    expect(api.listProjectBranches).toHaveBeenCalledWith({ projectId: "p1" });
  });

  it("database config with parent branch lists roles", async () => {
    api.listProjectBranchRoles.mockResolvedValue(wrap({ roles: [{ name: "alice" }] }));
    const client = makeClient();
    const cfg = await client.getCreateConfig("neon-database", "acct1:neon-branch:p1/b1");
    const owner = cfg.fields.find((f) => f.key === "ownerName");
    expect(owner).toMatchObject({ defaultValue: "alice" });
    expect(api.listProjectBranchRoles).toHaveBeenCalledWith("p1", "b1");
  });

  it("database config falls back to neondb_owner when role list throws", async () => {
    api.listProjectBranchRoles.mockRejectedValue(new Error("x"));
    const client = makeClient();
    const cfg = await client.getCreateConfig("neon-database", "acct1:neon-branch:p1/b1");
    const owner = cfg.fields.find((f) => f.key === "ownerName");
    expect(owner).toMatchObject({ defaultValue: "neondb_owner" });
  });

  it("database config without parent lists projects+branches", async () => {
    api.listProjects.mockResolvedValue(wrap({ projects: [{ id: "p1", name: "P" }] }));
    api.listProjectBranches.mockResolvedValue(
      wrap({ branches: [{ id: "b1", name: "main", default: true }] }),
    );
    api.listProjectBranchRoles.mockResolvedValue(wrap({ roles: [{ name: "alice" }] }));
    const client = makeClient();
    const cfg = await client.getCreateConfig("neon-database");
    expect(cfg.fields.map((f) => f.key)).toEqual(["projectId", "branchId", "name", "ownerName"]);
  });

  it("role config without parent enumerates branches", async () => {
    api.listProjects.mockResolvedValue(wrap({ projects: [{ id: "p1", name: "P" }] }));
    api.listProjectBranches.mockResolvedValue(wrap({ branches: [{ id: "b1", name: "main" }] }));
    const client = makeClient();
    const cfg = await client.getCreateConfig("neon-role");
    expect(cfg.fields[0]!.key).toBe("projectBranch");
    expect((cfg.fields[0]! as never as { options: unknown[] }).options).toHaveLength(1);
  });

  it("role config skips projects whose branches throw", async () => {
    api.listProjects.mockResolvedValue(wrap({ projects: [{ id: "p1", name: "P" }] }));
    api.listProjectBranches.mockRejectedValue(new Error("x"));
    const client = makeClient();
    const cfg = await client.getCreateConfig("neon-role");
    expect((cfg.fields[0]! as never as { options: unknown[] }).options).toHaveLength(0);
  });

  it("role config with parent only has name", async () => {
    const client = makeClient();
    const cfg = await client.getCreateConfig("neon-role", "acct1:neon-branch:p1/b1");
    expect(cfg.fields.map((f) => f.key)).toEqual(["name"]);
  });

  it("endpoint config without parent enumerates branches", async () => {
    api.listProjects.mockResolvedValue(wrap({ projects: [{ id: "p1", name: "P" }] }));
    api.listProjectBranches.mockResolvedValue(wrap({ branches: [{ id: "b1", name: "main" }] }));
    const client = makeClient();
    const cfg = await client.getCreateConfig("neon-endpoint");
    expect(cfg.fields.map((f) => f.key)).toEqual([
      "projectBranch",
      "type",
      "autoscalingMinCu",
      "autoscalingMaxCu",
      "suspendTimeout",
    ]);
  });

  it("endpoint config skips branch errors", async () => {
    api.listProjects.mockResolvedValue(wrap({ projects: [{ id: "p1", name: "P" }] }));
    api.listProjectBranches.mockRejectedValue(new Error("x"));
    const client = makeClient();
    const cfg = await client.getCreateConfig("neon-endpoint");
    expect(cfg.fields.map((f) => f.key)).toEqual([
      "projectBranch",
      "type",
      "autoscalingMinCu",
      "autoscalingMaxCu",
      "suspendTimeout",
    ]);
  });

  it("endpoint config with parent only has type", async () => {
    const client = makeClient();
    const cfg = await client.getCreateConfig("neon-endpoint", "acct1:neon-branch:p1/b1");
    expect(cfg.fields.map((f) => f.key)).toEqual([
      "type",
      "autoscalingMinCu",
      "autoscalingMaxCu",
      "suspendTimeout",
    ]);
  });

  it("Data API config with parent exposes API settings", async () => {
    const client = makeClient();
    const cfg = await client.getCreateConfig("neon-data-api", "acct1:neon-database:p1/b1/neondb");
    expect(cfg.fields.map((f) => f.key)).toEqual([
      "authProvider",
      "providerName",
      "jwksUrl",
      "jwtAudience",
      "anonymousRole",
      "schemas",
      "corsAllowedOrigins",
    ]);
  });

  it("Data API config without parent lists databases", async () => {
    api.listProjects.mockResolvedValue(wrap({ projects: [{ id: "p1", name: "P" }] }));
    api.listProjectBranches.mockResolvedValue(wrap({ branches: [{ id: "b1", name: "main" }] }));
    api.listProjectBranchDatabases.mockResolvedValue(
      wrap({ databases: [{ id: 1, name: "neondb", branch_id: "b1", owner_name: "owner" }] }),
    );

    const client = makeClient();
    const cfg = await client.getCreateConfig("neon-data-api");
    expect(cfg.fields[0]).toMatchObject({
      key: "databaseRef",
      defaultValue: "p1/b1/neondb",
    });
  });

  it("throws for unknown type", async () => {
    const client = makeClient();
    await expect(client.getCreateConfig("nope")).rejects.toThrow(/no create config/);
  });
});

describe("createResource", () => {
  it("creates project", async () => {
    api.createProject.mockResolvedValue(
      wrap({
        project: {
          id: "p1",
          name: "P",
          region_id: "r",
          pg_version: 17,
          created_at: "c",
          updated_at: "u",
        },
      }),
    );
    const client = makeClient();
    const res = await client.createResource("neon-project", ACCOUNT, {
      name: "P",
      region: "r",
      pgVersion: "17",
    });
    expect(res.id).toBe("acct1:neon-project:p1");
    expect(api.createProject).toHaveBeenCalledWith({
      project: { name: "P", region_id: "r", pg_version: 17 },
    });
  });

  it("creates branch using fields.projectId", async () => {
    api.createProjectBranch.mockResolvedValue(
      wrap({
        branch: {
          id: "b1",
          name: "feat",
          project_id: "p1",
          default: false,
          current_state: "init",
          created_at: "c",
          updated_at: "u",
        },
      }),
    );
    const client = makeClient();
    const res = await client.createResource("neon-branch", ACCOUNT, {
      projectId: "p1",
      name: "feat",
    });
    expect(res.id).toBe("acct1:neon-branch:p1/b1");
    expect(api.createProjectBranch).toHaveBeenCalledWith(
      "p1",
      expect.objectContaining({ branch: { name: "feat" } }),
    );
  });

  it("creates branch using parent resource id", async () => {
    api.createProjectBranch.mockResolvedValue(
      wrap({ branch: { id: "b1", name: "feat", project_id: "p1" } }),
    );
    const client = makeClient();
    const res = await client.createResource(
      "neon-branch",
      ACCOUNT,
      { name: "feat" },
      "acct1:neon-project:p1",
    );
    expect(res.fields.projectId).toBe("p1");
  });

  it("branch create throws without projectId", async () => {
    const client = makeClient();
    await expect(client.createResource("neon-branch", ACCOUNT, { name: "x" })).rejects.toThrow(
      /projectId is required/,
    );
  });

  it("creates database", async () => {
    api.createProjectBranchDatabase.mockResolvedValue(
      wrap({
        database: {
          id: 9,
          name: "mydb",
          branch_id: "b1",
          owner_name: "owner",
          created_at: "c",
          updated_at: "u",
        },
      }),
    );
    const client = makeClient();
    const res = await client.createResource(
      "neon-database",
      ACCOUNT,
      { name: "mydb", ownerName: "owner" },
      "acct1:neon-branch:p1/b1",
    );
    expect(res.id).toBe("acct1:neon-database:p1/b1/mydb");
    expect(api.createProjectBranchDatabase).toHaveBeenCalledWith("p1", "b1", {
      database: { name: "mydb", owner_name: "owner" },
    });
  });

  it("database create throws without project/branch", async () => {
    const client = makeClient();
    await expect(client.createResource("neon-database", ACCOUNT, { name: "x" })).rejects.toThrow(
      /projectId and branchId are required/,
    );
  });

  it("creates role", async () => {
    api.createProjectBranchRole.mockResolvedValue(
      wrap({ role: { name: "alice", protected: false, created_at: "c", updated_at: "u" } }),
    );
    const client = makeClient();
    const res = await client.createResource(
      "neon-role",
      ACCOUNT,
      { name: "alice" },
      "acct1:neon-branch:p1/b1",
    );
    expect(res.id).toBe("acct1:neon-role:p1/b1/alice");
  });

  it("role create throws without project/branch", async () => {
    const client = makeClient();
    await expect(client.createResource("neon-role", ACCOUNT, { name: "x" })).rejects.toThrow(
      /projectBranch is required/,
    );
  });

  it("creates endpoint (read_only)", async () => {
    api.createProjectEndpoint.mockResolvedValue(
      wrap({
        endpoint: {
          id: "ep1",
          host: "h",
          project_id: "p1",
          branch_id: "b1",
          current_state: "init",
          type: "read_only",
          autoscaling_limit_min_cu: 1,
          autoscaling_limit_max_cu: 2,
          suspend_timeout_seconds: 300,
          created_at: "c",
          updated_at: "u",
        },
      }),
    );
    const client = makeClient();
    const res = await client.createResource(
      "neon-endpoint",
      ACCOUNT,
      { type: "read_only" },
      "acct1:neon-branch:p1/b1",
    );
    expect(res.id).toBe("acct1:neon-endpoint:p1/ep1");
    expect(api.createProjectEndpoint).toHaveBeenCalledWith(
      "p1",
      expect.objectContaining({ endpoint: { branch_id: "b1", type: "read_only" } }),
    );
  });

  it("endpoint create throws without project/branch", async () => {
    const client = makeClient();
    await expect(client.createResource("neon-endpoint", ACCOUNT, {})).rejects.toThrow(
      /projectBranch is required/,
    );
  });

  it("creates Data API using parent database", async () => {
    api.createProjectBranchDataApi.mockResolvedValue(
      wrap({ url: "https://api.neon.tech/rest/v1" }),
    );
    const client = makeClient();
    const res = await client.createResource(
      "neon-data-api",
      ACCOUNT,
      {
        authProvider: "external",
        providerName: "Auth0",
        jwksUrl: "https://auth.example/.well-known/jwks.json",
        jwtAudience: "api",
        anonymousRole: "anonymous",
        schemas: "public,api",
        corsAllowedOrigins: "https://app.example",
      },
      "acct1:neon-database:p1/b1/neondb",
    );

    expect(res).toMatchObject({
      id: "acct1:neon-data-api:p1/b1/neondb",
      fields: { url: "https://api.neon.tech/rest/v1", status: "created" },
    });
    expect(api.createProjectBranchDataApi).toHaveBeenCalledWith("p1", "b1", "neondb", {
      auth_provider: "external",
      provider_name: "Auth0",
      jwks_url: "https://auth.example/.well-known/jwks.json",
      jwt_audience: "api",
      settings: {
        db_anon_role: "anonymous",
        db_schemas: ["public", "api"],
        server_cors_allowed_origins: "https://app.example",
      },
    });
  });

  it("creates Data API from selected database and throws when database is missing", async () => {
    api.createProjectBranchDataApi.mockResolvedValue(
      wrap({ url: "https://api.neon.tech/rest/v1" }),
    );
    const client = makeClient();
    await client.createResource("neon-data-api", ACCOUNT, { databaseRef: "p1/b1/neondb" });
    expect(api.createProjectBranchDataApi).toHaveBeenCalledWith("p1", "b1", "neondb", {});

    await expect(client.createResource("neon-data-api", ACCOUNT, {})).rejects.toThrow(
      /project, branch, and database are required/,
    );
  });

  it("throws for unsupported type", async () => {
    const client = makeClient();
    await expect(client.createResource("nope", ACCOUNT, {})).rejects.toThrow(
      /createResource not supported/,
    );
  });
});

describe("deleteResource", () => {
  it("deletes project", async () => {
    const client = makeClient();
    await client.deleteResource("neon-project", "acct1:neon-project:p1", ACCOUNT);
    expect(api.deleteProject).toHaveBeenCalledWith("p1");
  });

  it("deletes branch", async () => {
    const client = makeClient();
    await client.deleteResource("neon-branch", "acct1:neon-branch:p1/b1", ACCOUNT);
    expect(api.deleteProjectBranch).toHaveBeenCalledWith({ projectId: "p1", branchId: "b1" });
  });

  it("branch delete throws on bad id", async () => {
    const client = makeClient();
    await expect(
      client.deleteResource("neon-branch", "acct1:neon-branch:p1", ACCOUNT),
    ).rejects.toThrow(/cannot parse branch ID/);
  });

  it("deletes database", async () => {
    const client = makeClient();
    await client.deleteResource("neon-database", "acct1:neon-database:p1/b1/db", ACCOUNT);
    expect(api.deleteProjectBranchDatabase).toHaveBeenCalledWith("p1", "b1", "db");
  });

  it("database delete throws on bad id", async () => {
    const client = makeClient();
    await expect(
      client.deleteResource("neon-database", "acct1:neon-database:p1/b1", ACCOUNT),
    ).rejects.toThrow(/cannot parse database ID/);
  });

  it("deletes endpoint", async () => {
    const client = makeClient();
    await client.deleteResource("neon-endpoint", "acct1:neon-endpoint:p1/ep1", ACCOUNT);
    expect(api.deleteProjectEndpoint).toHaveBeenCalledWith("p1", "ep1");
  });

  it("endpoint delete throws on bad id", async () => {
    const client = makeClient();
    await expect(
      client.deleteResource("neon-endpoint", "acct1:neon-endpoint:p1", ACCOUNT),
    ).rejects.toThrow(/cannot parse endpoint ID/);
  });

  it("deletes role", async () => {
    const client = makeClient();
    await client.deleteResource("neon-role", "acct1:neon-role:p1/b1/alice", ACCOUNT);
    expect(api.deleteProjectBranchRole).toHaveBeenCalledWith("p1", "b1", "alice");
  });

  it("deletes Data API", async () => {
    const client = makeClient();
    await client.deleteResource("neon-data-api", "acct1:neon-data-api:p1/b1/neondb", ACCOUNT);
    expect(api.deleteProjectBranchDataApi).toHaveBeenCalledWith("p1", "b1", "neondb");
  });

  it("Data API delete throws on bad id", async () => {
    const client = makeClient();
    await expect(
      client.deleteResource("neon-data-api", "acct1:neon-data-api:p1/b1", ACCOUNT),
    ).rejects.toThrow(/cannot parse Data API ID/);
  });

  it("role delete throws on bad id", async () => {
    const client = makeClient();
    await expect(
      client.deleteResource("neon-role", "acct1:neon-role:p1/b1", ACCOUNT),
    ).rejects.toThrow(/cannot parse role ID/);
  });

  it("throws for unsupported type", async () => {
    const client = makeClient();
    await expect(client.deleteResource("nope", "x", ACCOUNT)).rejects.toThrow(
      /deleteResource not supported/,
    );
  });
});

describe("rerollOutput", () => {
  it("rejects unsupported output key", async () => {
    const client = makeClient();
    await expect(client.rerollOutput("neon-role", "x", "weird", ACCOUNT)).rejects.toThrow(
      /cannot reroll output/,
    );
  });

  it("rerolls role password", async () => {
    api.listProjects.mockResolvedValue(
      wrap({ projects: [{ id: "p1", name: "P", pg_version: 16 }] }),
    );
    api.listProjectBranches.mockResolvedValue(wrap({ branches: [{ id: "b1", name: "main" }] }));
    api.listProjectBranchRoles.mockResolvedValue(wrap({ roles: [{ name: "alice" }] }));
    const client = makeClient();
    await client.rerollOutput("neon-role", "acct1:neon-role:p1/b1/alice", "password", ACCOUNT);
    expect(api.resetProjectBranchRolePassword).toHaveBeenCalledWith("p1", "b1", "alice");
  });

  it("rerolls database owner", async () => {
    api.listProjects.mockResolvedValue(
      wrap({ projects: [{ id: "p1", name: "P", pg_version: 16 }] }),
    );
    api.listProjectBranches.mockResolvedValue(wrap({ branches: [{ id: "b1", name: "main" }] }));
    api.listProjectBranchDatabases.mockResolvedValue(
      wrap({ databases: [{ id: 1, name: "db", branch_id: "b1", owner_name: "owner" }] }),
    );
    const client = makeClient();
    await client.rerollOutput(
      "neon-database",
      "acct1:neon-database:p1/b1/db",
      "connectionString",
      ACCOUNT,
    );
    expect(api.resetProjectBranchRolePassword).toHaveBeenCalledWith("p1", "b1", "owner");
  });

  it("rerolls branch first db owner", async () => {
    api.listProjects.mockResolvedValue(
      wrap({ projects: [{ id: "p1", name: "P", pg_version: 16 }] }),
    );
    api.listProjectBranches.mockResolvedValue(
      wrap({ branches: [{ id: "b1", name: "main", project_id: "p1" }] }),
    );
    api.listProjectBranchDatabases.mockResolvedValue(
      wrap({ databases: [{ name: "db", owner_name: "owner" }] }),
    );
    const client = makeClient();
    await client.rerollOutput(
      "neon-branch",
      "acct1:neon-branch:p1/b1",
      "connectionString",
      ACCOUNT,
    );
    expect(api.resetProjectBranchRolePassword).toHaveBeenCalledWith("p1", "b1", "owner");
  });

  it("branch reroll throws with no db", async () => {
    api.listProjects.mockResolvedValue(
      wrap({ projects: [{ id: "p1", name: "P", pg_version: 16 }] }),
    );
    api.listProjectBranches.mockResolvedValue(
      wrap({ branches: [{ id: "b1", name: "main", project_id: "p1" }] }),
    );
    api.listProjectBranchDatabases.mockResolvedValue(wrap({ databases: [] }));
    const client = makeClient();
    await expect(
      client.rerollOutput("neon-branch", "acct1:neon-branch:p1/b1", "connectionString", ACCOUNT),
    ).rejects.toThrow(/no databases on branch/);
  });

  it("rerolls project primary branch db owner", async () => {
    api.listProjects.mockResolvedValue(
      wrap({ projects: [{ id: "p1", name: "P", pg_version: 16 }] }),
    );
    api.listProjectBranches.mockResolvedValue(
      wrap({ branches: [{ id: "b1", name: "main", default: true }] }),
    );
    api.listProjectBranchDatabases.mockResolvedValue(
      wrap({ databases: [{ name: "db", owner_name: "owner" }] }),
    );
    const client = makeClient();
    await client.rerollOutput("neon-project", "acct1:neon-project:p1", "connectionString", ACCOUNT);
    expect(api.resetProjectBranchRolePassword).toHaveBeenCalledWith("p1", "b1", "owner");
  });

  it("project reroll throws with no branches", async () => {
    api.listProjects.mockResolvedValue(
      wrap({ projects: [{ id: "p1", name: "P", pg_version: 16 }] }),
    );
    api.listProjectBranches.mockResolvedValue(wrap({ branches: [] }));
    const client = makeClient();
    await expect(
      client.rerollOutput("neon-project", "acct1:neon-project:p1", "connectionString", ACCOUNT),
    ).rejects.toThrow(/no branches to reroll/);
  });

  it("project reroll throws with no db on primary", async () => {
    api.listProjects.mockResolvedValue(
      wrap({ projects: [{ id: "p1", name: "P", pg_version: 16 }] }),
    );
    api.listProjectBranches.mockResolvedValue(
      wrap({ branches: [{ id: "b1", name: "main", default: true }] }),
    );
    api.listProjectBranchDatabases.mockResolvedValue(wrap({ databases: [] }));
    const client = makeClient();
    await expect(
      client.rerollOutput("neon-project", "acct1:neon-project:p1", "connectionString", ACCOUNT),
    ).rejects.toThrow(/no databases on primary branch/);
  });

  it("throws for unsupported type", async () => {
    const client = makeClient();
    await expect(
      client.rerollOutput("neon-endpoint", "x", "connectionString", ACCOUNT),
    ).rejects.toThrow(/rerollOutput not supported/);
  });
});

describe("updates and branch actions", () => {
  it("updates a project's name and restore window", async () => {
    api.updateProject.mockResolvedValue(
      wrap({
        project: {
          id: "p1",
          name: "Renamed",
          region_id: "aws-us-east-2",
          pg_version: 18,
          history_retention_seconds: 604800,
        },
      }),
    );
    const res = await makeClient().updateResource(
      "neon-project",
      "acct1:neon-project:p1",
      ACCOUNT,
      {
        name: "Renamed",
        historyRetentionSeconds: "604800",
      },
    );
    expect(api.updateProject).toHaveBeenCalledWith("p1", {
      project: { name: "Renamed", history_retention_seconds: 604800 },
    });
    expect(res.fields).toMatchObject({ name: "Renamed", historyRetentionSeconds: 604800 });
  });

  it("updates branch protection and clears its expiry", async () => {
    api.updateProjectBranch.mockResolvedValue(
      wrap({ branch: { id: "b1", name: "dev", project_id: "p1", protected: true } }),
    );
    await makeClient().updateResource("neon-branch", "acct1:neon-branch:p1/b1", ACCOUNT, {
      name: "dev",
      protected: "true",
      expiresAt: "",
    });
    expect(api.updateProjectBranch).toHaveBeenCalledWith("p1", "b1", {
      branch: { name: "dev", protected: true, expires_at: null },
    });
  });

  it("updates endpoint autoscaling and scale-to-zero", async () => {
    api.updateProjectEndpoint.mockResolvedValue(
      wrap({
        endpoint: {
          id: "ep1",
          host: "h",
          project_id: "p1",
          branch_id: "b1",
          autoscaling_limit_min_cu: 0.5,
          autoscaling_limit_max_cu: 4,
          suspend_timeout_seconds: -1,
        },
      }),
    );
    const res = await makeClient().updateResource(
      "neon-endpoint",
      "acct1:neon-endpoint:p1/ep1",
      ACCOUNT,
      { autoscalingMinCu: "0.5", autoscalingMaxCu: "4", suspendTimeout: "-1", name: "" },
    );
    expect(api.updateProjectEndpoint).toHaveBeenCalledWith("p1", "ep1", {
      endpoint: {
        autoscaling_limit_min_cu: 0.5,
        autoscaling_limit_max_cu: 4,
        suspend_timeout_seconds: -1,
      },
    });
    expect(res.fields).toMatchObject({ autoscalingMaxCu: "4", suspendTimeout: "-1" });
  });

  it("rejects an inverted autoscaling range", async () => {
    await expect(
      makeClient().updateResource("neon-endpoint", "acct1:neon-endpoint:p1/ep1", ACCOUNT, {
        autoscalingMinCu: "4",
        autoscalingMaxCu: "1",
      }),
    ).rejects.toThrow(/max compute/);
  });

  it("changes a database owner", async () => {
    api.updateProjectBranchDatabase.mockResolvedValue(
      wrap({ database: { id: 1, name: "app", branch_id: "b1", owner_name: "alice" } }),
    );
    await makeClient().updateResource("neon-database", "acct1:neon-database:p1/b1/app", ACCOUNT, {
      ownerName: "alice",
    });
    expect(api.updateProjectBranchDatabase).toHaveBeenCalledWith("p1", "b1", "app", {
      database: { owner_name: "alice" },
    });
  });

  it("restarts endpoints, sets the default branch and resets from parent", async () => {
    api.getProjectBranch.mockResolvedValue(wrap({ branch: { id: "b2", parent_id: "b1" } }));
    const client = makeClient();
    await client.invokeAction("neon-endpoint", "acct1:neon-endpoint:p1/ep1", "restart", ACCOUNT);
    await client.invokeAction("neon-branch", "acct1:neon-branch:p1/b2", "set-default", ACCOUNT);
    await client.invokeAction(
      "neon-branch",
      "acct1:neon-branch:p1/b2",
      "reset-from-parent",
      ACCOUNT,
    );
    expect(api.restartProjectEndpoint).toHaveBeenCalledWith("p1", "ep1");
    expect(api.setDefaultProjectBranch).toHaveBeenCalledWith("p1", "b2");
    expect(api.restoreProjectBranch).toHaveBeenCalledWith("p1", "b2", { source_branch_id: "b1" });
  });

  it("restores a branch to a point in time, keeping its current state", async () => {
    await makeClient().executeNoSqlCommand(
      "neon-branch",
      "acct1:neon-branch:p1/b2",
      ACCOUNT,
      "restore",
      [JSON.stringify({ timestamp: "2026-10-01T12:00:00Z", preserveUnderName: "before" })],
    );
    expect(api.restoreProjectBranch).toHaveBeenCalledWith("p1", "b2", {
      source_branch_id: "b2",
      source_timestamp: "2026-10-01T12:00:00Z",
      preserve_under_name: "before",
    });
  });

  it("creates a schema-only, expiring branch from a chosen parent", async () => {
    api.createProjectBranch.mockResolvedValue(
      wrap({ branch: { id: "b3", name: "ci", project_id: "p1", parent_id: "b1" } }),
    );
    const res = await makeClient().createResource(
      "neon-branch",
      ACCOUNT,
      {
        name: "ci",
        parentId: "b1",
        initSource: "schema-only",
        parentTimestamp: "2026-10-01T00:00:00Z",
        expiresAt: "2026-10-10T00:00:00Z",
        protected: "false",
      },
      "acct1:neon-project:p1",
    );
    expect(api.createProjectBranch).toHaveBeenCalledWith("p1", {
      branch: {
        name: "ci",
        parent_id: "b1",
        init_source: "schema-only",
        expires_at: "2026-10-10T00:00:00Z",
      },
      endpoints: [{ type: "read_write" }],
    });
    expect(res.fields).toMatchObject({ parentId: "b1" });
  });

  it("offers branch actions that fit the branch", () => {
    const render = (fields: Record<string, string | number | boolean>) =>
      (
        makeClient().renderDetail({
          id: "acct1:neon-branch:p1/b2",
          pluginId: "neon",
          resourceTypeId: "neon-branch",
          accountId: ACCOUNT,
          displayName: "dev",
          externalId: "b2",
          fields,
          resolvedOutputs: {},
          secretStates: [],
          createdAt: "",
          updatedAt: "",
        }).headerActions ?? []
      ).map((a) => a.label);
    expect(render({ primary: false, parentId: "b1", protected: false })).toEqual([
      "Refresh",
      "Restore to Point in Time",
      "Set as Default",
      "Reset from Parent",
    ]);
    expect(render({ primary: true })).toEqual(["Refresh", "Restore to Point in Time"]);
  });
});
