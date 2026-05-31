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
};

const createApiClient = vi.fn(() => api);

vi.mock("@neondatabase/api-client", () => ({
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  createApiClient: (...args: any[]) => createApiClient(...(args as [])),
  ConsumptionHistoryGranularity: { Hourly: "hourly" },
  EndpointType: { ReadWrite: "read_write", ReadOnly: "read_only" },
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
  it("builds three series for project from consumption history", async () => {
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
                    synthetic_storage_size_bytes: 100,
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
    expect(series.map((s) => s.label)).toEqual(["Active Time", "Storage", "Data Written"]);
    expect(series[0]!.points[0]!.value).toBe(10);
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

  it("resolves projectId from non-project resource", async () => {
    api.listProjects.mockResolvedValue(
      wrap({ projects: [{ id: "p1", name: "P", pg_version: 16 }] }),
    );
    api.listProjectBranches.mockResolvedValue(
      wrap({ branches: [{ id: "b1", name: "main", project_id: "p1" }] }),
    );
    api.getConsumptionHistoryPerProject.mockResolvedValue(wrap({ projects: [] }));
    const client = makeClient();
    const series = await client.fetchMetricSeries(
      "neon-branch",
      "acct1:neon-branch:p1/b1",
      ACCOUNT,
    );
    expect(series).toEqual([]);
    expect(api.getConsumptionHistoryPerProject).toHaveBeenCalledWith(
      expect.objectContaining({ project_ids: ["p1"] }),
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
    const cfg = await client.getCreateConfig("neon-project");
    expect(cfg.fields.map((f) => f.key)).toEqual(["name", "region", "pgVersion"]);
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
    const cfg = await client.getCreateConfig("neon-branch", "acct1:neon-project:p1");
    expect(cfg.fields.map((f) => f.key)).toEqual(["name"]);
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
    expect(cfg.fields.map((f) => f.key)).toEqual(["projectBranch", "type"]);
  });

  it("endpoint config skips branch errors", async () => {
    api.listProjects.mockResolvedValue(wrap({ projects: [{ id: "p1", name: "P" }] }));
    api.listProjectBranches.mockRejectedValue(new Error("x"));
    const client = makeClient();
    const cfg = await client.getCreateConfig("neon-endpoint");
    expect(cfg.fields.map((f) => f.key)).toEqual(["projectBranch", "type"]);
  });

  it("endpoint config with parent only has type", async () => {
    const client = makeClient();
    const cfg = await client.getCreateConfig("neon-endpoint", "acct1:neon-branch:p1/b1");
    expect(cfg.fields.map((f) => f.key)).toEqual(["type"]);
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
    expect(api.deleteProjectBranch).toHaveBeenCalledWith("p1", "b1");
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
