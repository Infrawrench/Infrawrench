import { hostClient } from "@infrawrench/plugin-base/effect";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { UnreadListPart } from "@infrawrench/plugin-base";

const api = {
  listProjects: vi.fn(),
  listProjectBranches: vi.fn(),
  listProjectEndpoints: vi.fn(),
  listProjectBranchDatabases: vi.fn(),
  listProjectBranchRoles: vi.fn(),
  getProjectBranchDataApi: vi.fn(),
  listSnapshots: vi.fn(),
  getProjectBranchStorage: vi.fn(),
  listProjectBranchBuckets: vi.fn(),
  listProjectBranchBucketObjects: vi.fn(),
  listCredentials: vi.fn(),
  listProjectBranchFunctions: vi.fn(),
  getProjectBranchAiGateway: vi.fn(),
  getNeonAuth: vi.fn(),
  getNeonAuthPluginConfigs: vi.fn(),
  listBranchNeonAuthOauthProviders: vi.fn(),
  listBranchNeonAuthTrustedDomains: vi.fn(),
  getCurrentUserOrganizations: vi.fn(),
  getOrganization: vi.fn(),
  getConsumptionHistoryPerProjectV2: vi.fn(),
};

vi.mock("@neondatabase/api-client", () => ({
  createApiClient: () => api,
  ConsumptionHistoryGranularity: { Hourly: "hourly", Daily: "daily", Monthly: "monthly" },
  EndpointType: { ReadWrite: "read_write", ReadOnly: "read_only" },
  BucketAccessLevel: { Private: "private", PublicRead: "public_read" },
  CredentialScope: {
    StorageRead: "storage:read",
    StorageWrite: "storage:write",
    AiGatewayInvoke: "ai_gateway:invoke",
    FunctionsInvoke: "functions:invoke",
  },
  NeonAuthOauthProviderId: { Google: "google", Github: "github" },
  NeonAuthSupportedAuthProvider: { Mock: "mock", Stack: "stack", BetterAuth: "better_auth" },
}));

import { NeonClient } from "../client.js";

const ACCOUNT = "acct1";
const wrap = (data: unknown) => ({ data });
const httpError = (status: number) =>
  Object.assign(new Error(`Request failed with status code ${status}`), { response: { status } });
const project = (id: string) => ({
  id,
  name: id,
  region_id: "aws-us-east-2",
  pg_version: 17,
  created_at: "2026-01-01",
  updated_at: "2026-01-01",
});
const branch = (id: string) => ({
  id,
  name: id,
  current_state: "ready",
  created_at: "2026-01-01",
  updated_at: "2026-01-01",
});
const projects = (...ids: string[]) => wrap({ projects: ids.map(project) });

function makeClient() {
  return hostClient(new NeonClient({ apiKey: "neon_test" }));
}

const UNREAD_HOOK = Symbol.for("infrawrench.unreadListPart");
let unread: UnreadListPart[];

beforeEach(() => {
  vi.clearAllMocks();
  for (const fn of Object.values(api)) fn.mockReset();
  unread = [];
  Reflect.set(globalThis, UNREAD_HOOK, (part: UnreadListPart) => unread.push(part));
});

afterEach(() => {
  Reflect.deleteProperty(globalThis, UNREAD_HOOK);
});

describe("listing projects", () => {
  it("asks for Neon's largest page and reads past the old cap of 50 pages", async () => {
    let served = 0;
    api.listProjects.mockImplementation(async () => {
      served++;
      if (served > 60) return wrap({ projects: [], pagination: { cursor: `c${served}` } });
      return wrap({ projects: [project(`p${served}`)], pagination: { cursor: `c${served}` } });
    });
    const rows = await makeClient().listResources("neon-project", ACCOUNT);
    expect(rows).toHaveLength(60);
    expect(api.listProjects).toHaveBeenNthCalledWith(1, { limit: 400 });
    expect(api.listProjects).toHaveBeenNthCalledWith(2, { limit: 400, cursor: "c1" });
  });

  it("throws at the page cap instead of returning part of the list", async () => {
    api.listProjects.mockImplementation(async () =>
      wrap({ projects: [project("p")], pagination: { cursor: "again" } }),
    );
    await expect(makeClient().listResources("neon-project", ACCOUNT)).rejects.toThrow(
      "has more than Infrawrench reads",
    );
    expect(api.listProjects).toHaveBeenCalledTimes(250);
  });

  it("refuses a page whose key was renamed, on the first page and on a later one", async () => {
    api.listProjects.mockResolvedValueOnce(wrap({ items: [] }));
    await expect(makeClient().listResources("neon-project", ACCOUNT)).rejects.toThrow(
      "is not a list",
    );
    api.listProjects
      .mockResolvedValueOnce(wrap({ projects: [project("p1")], pagination: { cursor: "c1" } }))
      .mockResolvedValueOnce(wrap({ items: [] }));
    await expect(makeClient().listResources("neon-project", ACCOUNT)).rejects.toThrow(
      "is not a list",
    );
  });

  it("reads a null list as empty", async () => {
    api.listProjects.mockResolvedValueOnce(wrap({ projects: null }));
    await expect(makeClient().listResources("neon-project", ACCOUNT)).resolves.toEqual([]);
  });

  it("fails on projects Neon could not fetch in time, rather than reading them as gone", async () => {
    api.listProjects.mockResolvedValueOnce(
      wrap({ projects: [project("p1")], unavailable_project_ids: ["p2", "p3"] }),
    );
    await expect(makeClient().listResources("neon-project", ACCOUNT)).rejects.toThrow(
      /could not read 2 projects/,
    );
  });

  it("keeps the type's rows quietly when the key may not list projects", async () => {
    api.listProjects.mockRejectedValue(httpError(403));
    await expect(makeClient().listResources("neon-project", ACCOUNT)).resolves.toEqual([]);
    expect(unread).toEqual([{ idPrefixes: [""] }]);
  });

  it("shows the refusal where the host keeps no track", async () => {
    Reflect.deleteProperty(globalThis, UNREAD_HOOK);
    api.listProjects.mockRejectedValue(httpError(403));
    await expect(makeClient().listResources("neon-project", ACCOUNT)).rejects.toMatchObject({
      response: { status: 403 },
    });
  });

  it.each([401, 429, 500])("fails the type on a %i", async (status) => {
    api.listProjects.mockRejectedValue(httpError(status));
    await expect(makeClient().listResources("neon-project", ACCOUNT)).rejects.toMatchObject({
      response: { status },
    });
    expect(unread).toEqual([]);
  });
});

describe("children of projects", () => {
  const read = {
    "neon-branch": () => api.listProjectBranches,
    "neon-endpoint": () => api.listProjectEndpoints,
  };

  it.each(Object.keys(read) as Array<keyof typeof read>)(
    "%s fails when one project's read fails, so its children are not pruned",
    async (type) => {
      api.listProjects.mockResolvedValue(projects("p1", "p2"));
      const fn = read[type]();
      fn.mockImplementation(async (arg: string | { projectId: string }) => {
        const id = typeof arg === "string" ? arg : arg.projectId;
        if (id === "p2") throw httpError(500);
        return wrap({ branches: [], endpoints: [] });
      });
      await expect(makeClient().listResources(type, ACCOUNT)).rejects.toMatchObject({
        response: { status: 500 },
      });
    },
  );

  it("reads a project that 404s as gone and names nothing", async () => {
    api.listProjects.mockResolvedValue(projects("p1", "p2"));
    api.listProjectBranches.mockImplementation(async ({ projectId }: { projectId: string }) => {
      if (projectId === "p2") throw httpError(404);
      return wrap({ branches: [branch("br-1")] });
    });
    const rows = await makeClient().listResources("neon-branch", ACCOUNT);
    expect(rows.map((r) => r.id)).toEqual(["acct1:neon-branch:p1/br-1"]);
    expect(unread).toEqual([]);
  });

  it("names a project the key may not read, so its children stay", async () => {
    api.listProjects.mockResolvedValue(projects("p1", "p2"));
    api.listProjectBranches.mockImplementation(async ({ projectId }: { projectId: string }) => {
      if (projectId === "p2") throw httpError(403);
      return wrap({ branches: [branch("br-1")] });
    });
    const rows = await makeClient().listResources("neon-branch", ACCOUNT);
    expect(rows.map((r) => r.id)).toEqual(["acct1:neon-branch:p1/br-1"]);
    expect(unread).toEqual([{ parentResourceIds: ["acct1:neon-project:p2"] }]);
  });

  it("shows a project the key may not read where the host keeps no track", async () => {
    Reflect.deleteProperty(globalThis, UNREAD_HOOK);
    api.listProjects.mockResolvedValue(projects("p1", "p2"));
    api.listProjectBranches.mockImplementation(async ({ projectId }: { projectId: string }) => {
      if (projectId === "p2") throw httpError(403);
      return wrap({ branches: [branch("br-1")] });
    });
    await expect(makeClient().listResources("neon-branch", ACCOUNT)).rejects.toMatchObject({
      response: { status: 403 },
    });
    api.listProjectBranchDatabases.mockResolvedValue(wrap({ databases: [] }));
    await expect(makeClient().listResources("neon-database", ACCOUNT)).rejects.toMatchObject({
      response: { status: 403 },
    });
  });

  it("keeps every row of the type, without an error, when every project refuses", async () => {
    api.listProjects.mockResolvedValue(projects("p1", "p2"));
    api.listProjectEndpoints.mockRejectedValue(httpError(403));
    await expect(makeClient().listResources("neon-endpoint", ACCOUNT)).resolves.toEqual([]);
    expect(unread).toContainEqual({ idPrefixes: [""] });
  });

  it("follows a project's branch pages", async () => {
    api.listProjects.mockResolvedValue(projects("p1"));
    api.listProjectBranches
      .mockResolvedValueOnce(wrap({ branches: [branch("br-1")], pagination: { next: "n1" } }))
      .mockResolvedValueOnce(wrap({ branches: [branch("br-2")], pagination: {} }));
    const rows = await makeClient().listResources("neon-branch", ACCOUNT);
    expect(rows.map((r) => r.externalId)).toEqual(["br-1", "br-2"]);
    expect(api.listProjectBranches).toHaveBeenNthCalledWith(1, {
      projectId: "p1",
      limit: 10000,
    });
    expect(api.listProjectBranches).toHaveBeenNthCalledWith(2, {
      projectId: "p1",
      limit: 10000,
      cursor: "n1",
    });
  });

  it("throws when a project's branches never end", async () => {
    api.listProjects.mockResolvedValue(projects("p1"));
    api.listProjectBranches.mockImplementation(async () =>
      wrap({ branches: [branch("br-1")], pagination: { next: "again" } }),
    );
    await expect(makeClient().listResources("neon-branch", ACCOUNT)).rejects.toThrow(
      "has more than Infrawrench reads",
    );
    expect(api.listProjectBranches).toHaveBeenCalledTimes(100);
  });
});

describe("children of branches", () => {
  beforeEach(() => {
    api.listProjects.mockResolvedValue(projects("p1"));
    api.listProjectBranches.mockResolvedValue(wrap({ branches: [branch("br-1"), branch("br-2")] }));
  });

  it("databases fail when one branch's read fails", async () => {
    api.listProjectBranchDatabases.mockImplementation(async (_p: string, b: string) => {
      if (b === "br-2") throw httpError(503);
      return wrap({ databases: [] });
    });
    await expect(makeClient().listResources("neon-database", ACCOUNT)).rejects.toMatchObject({
      response: { status: 503 },
    });
  });

  it("databases fail when a project's branch read fails", async () => {
    api.listProjectBranches.mockRejectedValue(httpError(500));
    await expect(makeClient().listResources("neon-database", ACCOUNT)).rejects.toMatchObject({
      response: { status: 500 },
    });
  });

  it("roles name a branch the key may not read", async () => {
    api.listProjectBranchRoles.mockImplementation(async (_p: string, b: string) => {
      if (b === "br-2") throw httpError(403);
      return wrap({ roles: [] });
    });
    await expect(makeClient().listResources("neon-role", ACCOUNT)).resolves.toEqual([]);
    expect(unread).toEqual([{ parentResourceIds: ["acct1:neon-branch:p1/br-2"] }]);
  });

  describe("Data API", () => {
    beforeEach(() => {
      api.listProjectBranches.mockResolvedValue(wrap({ branches: [branch("br-1")] }));
      api.listProjectBranchDatabases.mockResolvedValue(
        wrap({
          databases: [
            {
              id: 1,
              name: "neondb",
              branch_id: "br-1",
              owner_name: "o",
              created_at: "2026-01-01",
              updated_at: "2026-01-01",
            },
          ],
        }),
      );
    });

    it.each([400, 404, 412])("reads a %i as not enabled", async (status) => {
      api.getProjectBranchDataApi.mockRejectedValue(httpError(status));
      await expect(makeClient().listResources("neon-data-api", ACCOUNT)).resolves.toEqual([]);
    });

    it.each([401, 423, 429, 500])("fails the type on a %i", async (status) => {
      api.getProjectBranchDataApi.mockRejectedValue(httpError(status));
      await expect(makeClient().listResources("neon-data-api", ACCOUNT)).rejects.toMatchObject({
        response: { status },
      });
    });

    it("fails on a failure with no status at all", async () => {
      api.getProjectBranchDataApi.mockRejectedValue(new Error("socket hang up"));
      await expect(makeClient().listResources("neon-data-api", ACCOUNT)).rejects.toThrow(
        "socket hang up",
      );
    });

    it("names the database when the key may not read its Data API", async () => {
      api.getProjectBranchDataApi.mockRejectedValue(httpError(403));
      await expect(makeClient().listResources("neon-data-api", ACCOUNT)).resolves.toEqual([]);
      expect(unread).toContainEqual({
        parentResourceIds: ["acct1:neon-database:p1/br-1/neondb"],
      });
    });
  });
});

describe("branch-scoped services", () => {
  beforeEach(() => {
    api.listProjects.mockResolvedValue(projects("p1", "p2"));
    api.listProjectBranches.mockResolvedValue(wrap({ branches: [branch("br-1")] }));
  });

  const types = [
    "neon-bucket",
    "neon-credential",
    "neon-function",
    "neon-ai-gateway",
    "neon-auth",
    "neon-auth-oauth-provider",
    "neon-auth-domain",
  ];

  it.each(types)("%s fails when a project's branches cannot be read", async (type) => {
    api.listProjectBranches.mockImplementation(async ({ projectId }: { projectId: string }) => {
      if (projectId === "p2") throw httpError(500);
      return wrap({ branches: [] });
    });
    await expect(makeClient().listResources(type, ACCOUNT)).rejects.toMatchObject({
      response: { status: 500 },
    });
  });

  it.each(types)("%s names a project whose branches the key may not read", async (type) => {
    api.listProjectBranches.mockImplementation(async ({ projectId }: { projectId: string }) => {
      if (projectId === "p2") throw httpError(403);
      return wrap({ branches: [] });
    });
    await expect(makeClient().listResources(type, ACCOUNT)).resolves.toEqual([]);
    expect(unread).toEqual([{ parentResourceIds: ["acct1:neon-project:p2"] }]);
  });

  const reads: Array<[string, () => (typeof api)["listCredentials"]]> = [
    ["neon-bucket", () => api.getProjectBranchStorage],
    ["neon-credential", () => api.listCredentials],
    ["neon-function", () => api.listProjectBranchFunctions],
    ["neon-ai-gateway", () => api.getProjectBranchAiGateway],
    ["neon-auth", () => api.getNeonAuth],
    ["neon-auth-oauth-provider", () => api.listBranchNeonAuthOauthProviders],
    ["neon-auth-domain", () => api.listBranchNeonAuthTrustedDomains],
  ];

  it.each(reads)("%s reads a 404 as not enabled and names nothing", async (type, fn) => {
    fn().mockRejectedValue(httpError(404));
    await expect(makeClient().listResources(type, ACCOUNT)).resolves.toEqual([]);
    expect(unread).toEqual([]);
  });

  it.each(reads)("%s keeps its rows when the key may not read the service", async (type, fn) => {
    fn().mockRejectedValue(httpError(403));
    await expect(makeClient().listResources(type, ACCOUNT)).resolves.toEqual([]);
    expect(unread).toContainEqual({ idPrefixes: [""] });
    expect(unread).toContainEqual({ parentResourceIds: ["acct1:neon-branch:p1/br-1"] });
  });

  it.each(reads)("%s fails on a 500", async (type, fn) => {
    fn().mockRejectedValue(httpError(500));
    await expect(makeClient().listResources(type, ACCOUNT)).rejects.toMatchObject({
      response: { status: 500 },
    });
  });

  it("follows a branch's function pages", async () => {
    api.listProjects.mockResolvedValue(projects("p1"));
    const fn = (slug: string) => ({
      id: slug,
      slug,
      name: slug,
      invocation_url: `https://${slug}.example.test`,
      created_at: "2026-01-01",
    });
    api.listProjectBranchFunctions
      .mockResolvedValueOnce(wrap({ functions: [fn("a")], pagination: { next: "n1" } }))
      .mockResolvedValueOnce(wrap({ functions: [fn("b")] }));
    const rows = await makeClient().listResources("neon-function", ACCOUNT);
    expect(rows.map((r) => r.fields["slug"])).toEqual(["a", "b"]);
    expect(api.listProjectBranchFunctions).toHaveBeenNthCalledWith(1, {
      projectId: "p1",
      branchId: "br-1",
      limit: 1000,
    });
    expect(api.listProjectBranchFunctions).toHaveBeenNthCalledWith(2, {
      projectId: "p1",
      branchId: "br-1",
      limit: 1000,
      cursor: "n1",
    });
  });

  it("refuses a function page whose key was renamed, or whose row lost a field", async () => {
    api.listProjectBranchFunctions.mockResolvedValue(wrap({ items: [] }));
    await expect(makeClient().listResources("neon-function", ACCOUNT)).rejects.toThrow(
      "is not a list",
    );
    api.listProjectBranchFunctions.mockResolvedValue(wrap({ functions: [{ id: "only" }] }));
    await expect(makeClient().listResources("neon-function", ACCOUNT)).rejects.toThrow(
      "is not a list",
    );
  });

  it("reads a credential list of null as empty", async () => {
    api.listCredentials.mockResolvedValue(wrap({ credentials: null }));
    await expect(makeClient().listResources("neon-credential", ACCOUNT)).resolves.toEqual([]);
  });
});

describe("snapshots", () => {
  beforeEach(() => {
    api.listProjects.mockResolvedValue(projects("p1", "p2"));
  });

  it("refuses a page whose key was renamed, or whose row lost a field", async () => {
    api.listSnapshots.mockResolvedValue(wrap({ items: [] }));
    await expect(makeClient().listResources("neon-snapshot", ACCOUNT)).rejects.toThrow(
      "is not a list",
    );
    api.listSnapshots.mockResolvedValue(wrap({ snapshots: [{ id: "only" }] }));
    await expect(makeClient().listResources("neon-snapshot", ACCOUNT)).rejects.toThrow(
      "is not a list",
    );
  });

  it("keeps a refused project's snapshots by id, since one may have no source branch", async () => {
    api.listSnapshots.mockImplementation(async (projectId: string) => {
      if (projectId === "p2") throw httpError(403);
      return wrap({ snapshots: [] });
    });
    await expect(makeClient().listResources("neon-snapshot", ACCOUNT)).resolves.toEqual([]);
    expect(unread).toEqual([{ idPrefixes: ["acct1:neon-snapshot:p2/"] }]);
  });
});

describe("bucket objects", () => {
  beforeEach(() => {
    api.listProjects.mockResolvedValue(projects("p1"));
    api.listProjectBranches.mockResolvedValue(wrap({ branches: [branch("br-1")] }));
    api.getProjectBranchStorage.mockResolvedValue(
      wrap({ s3_endpoint: "https://s3.example.test", region: "r" }),
    );
    api.listProjectBranchBuckets.mockResolvedValue(
      wrap({ buckets: [{ name: "b", access_level: "private", created_at: "2026-01-01" }] }),
    );
  });

  it("throws at the page cap instead of showing part of a folder as all of it", async () => {
    api.listProjectBranchBucketObjects.mockImplementation(async () =>
      wrap({ folders: [], objects: [], next_cursor: "again" }),
    );
    await expect(makeClient().listStorageObjects!("b", "")).rejects.toThrow(
      "has more than Infrawrench reads",
    );
    expect(api.listProjectBranchBucketObjects).toHaveBeenCalledTimes(1000);
  });
});

describe("the primary branch for a credential reroll", () => {
  it("is found on a later page, rather than taking the first branch of the first", async () => {
    api.listProjects.mockResolvedValue(projects("p1"));
    api.listProjectBranches
      .mockResolvedValueOnce(wrap({ branches: [branch("br-dev")], pagination: { next: "n1" } }))
      .mockResolvedValueOnce(wrap({ branches: [{ ...branch("br-main"), default: true }] }));
    api.listProjectBranchDatabases.mockResolvedValue(wrap({ databases: [] }));
    await expect(
      makeClient().rerollOutput!(
        "neon-project",
        "acct1:neon-project:p1",
        "connectionString",
        ACCOUNT,
      ),
    ).rejects.toThrow();
    expect(api.listProjectBranchDatabases).toHaveBeenCalledWith("p1", "br-main");
  });
});

describe("the budget of one poll", () => {
  const CHILD_TYPES = [
    "neon-branch",
    "neon-endpoint",
    "neon-database",
    "neon-role",
    "neon-data-api",
    "neon-snapshot",
    "neon-bucket",
    "neon-credential",
    "neon-function",
    "neon-ai-gateway",
    "neon-auth",
    "neon-auth-oauth-provider",
    "neon-auth-domain",
  ];
  const ALL_TYPES = ["neon-project", ...CHILD_TYPES];
  const totalRequests = () => Object.values(api).reduce((sum, fn) => sum + fn.mock.calls.length, 0);
  const ids = (count: number) => Array.from({ length: count }, (_, i) => `p${i}`);
  const named = () => new Set(unread.flatMap((part) => part.parentResourceIds ?? []));
  const database = (branchId: string) => ({
    id: 1,
    name: "db",
    branch_id: branchId,
    owner_name: "o",
    created_at: "2026-01-01",
    updated_at: "2026-01-01",
  });

  /** An account of `count` projects with two branches each, where every read answers. */
  function account(count: number) {
    api.listProjects.mockResolvedValue(projects(...ids(count)));
    api.listProjectBranches.mockImplementation(async ({ projectId }: { projectId: string }) =>
      wrap({ branches: [branch(`${projectId}-a`), branch(`${projectId}-b`)] }),
    );
    api.listProjectEndpoints.mockResolvedValue(wrap({ endpoints: [] }));
    api.listProjectBranchDatabases.mockImplementation(async (_p: string, b: string) =>
      wrap({ databases: [database(b)] }),
    );
    api.listProjectBranchRoles.mockResolvedValue(wrap({ roles: [] }));
    api.getProjectBranchDataApi.mockRejectedValue(httpError(404));
    api.listSnapshots.mockResolvedValue(wrap({ snapshots: [] }));
    api.getProjectBranchStorage.mockResolvedValue(
      wrap({ s3_endpoint: "https://s3.example.test", region: "r" }),
    );
    api.listProjectBranchBuckets.mockResolvedValue(wrap({ buckets: [] }));
    api.listCredentials.mockResolvedValue(wrap({ credentials: [] }));
    api.listProjectBranchFunctions.mockResolvedValue(wrap({ functions: [] }));
    api.getProjectBranchAiGateway.mockResolvedValue(wrap({ enabled: false }));
    api.getNeonAuth.mockRejectedValue(httpError(404));
    api.listBranchNeonAuthOauthProviders.mockResolvedValue(wrap({ providers: [] }));
    api.listBranchNeonAuthTrustedDomains.mockResolvedValue(wrap({ domains: [] }));
  }

  /** Every type at once on one client, as a sync does. */
  function poll() {
    const client = makeClient();
    return Promise.all(ALL_TYPES.map((type) => client.listResources(type, ACCOUNT)));
  }

  afterEach(() => {
    vi.useRealTimers();
  });

  it("reads what the budget allows past 1,000 projects and names the rest, with no error", async () => {
    account(1500);
    const rows = await makeClient().listResources("neon-endpoint", ACCOUNT);
    expect(rows).toEqual([]);
    const read = api.listProjectEndpoints.mock.calls.map(([id]) => `acct1:neon-project:${id}`);
    expect(read.length).toBeGreaterThan(900);
    expect(read.length).toBeLessThanOrEqual(1000);
    expect(named().size).toBe(1500 - read.length);
    for (const id of read) expect(named().has(id)).toBe(false);
  });

  it("reads every project where the host keeps no track of the rest", async () => {
    Reflect.deleteProperty(globalThis, UNREAD_HOOK);
    account(1500);
    await expect(makeClient().listResources("neon-endpoint", ACCOUNT)).resolves.toEqual([]);
    const read = new Set(api.listProjectEndpoints.mock.calls.map(([id]) => String(id)));
    expect(read.size).toBe(1500);
  });

  it("keeps a whole poll inside 1,000 requests, and every type gets some of them", async () => {
    account(600);
    await poll();
    expect(totalRequests()).toBeLessThanOrEqual(1000);
    expect(totalRequests()).toBeGreaterThan(900);
    expect(api.listProjects).toHaveBeenCalledTimes(1);
    for (const fn of [
      api.listProjectEndpoints,
      api.listSnapshots,
      api.listProjectBranchDatabases,
      api.listProjectBranchRoles,
      api.getProjectBranchDataApi,
      api.getProjectBranchStorage,
      api.listCredentials,
      api.listProjectBranchFunctions,
      api.getProjectBranchAiGateway,
      api.getNeonAuth,
      api.listBranchNeonAuthOauthProviders,
      api.listBranchNeonAuthTrustedDomains,
    ]) {
      expect(fn.mock.calls.length).toBeGreaterThan(10);
    }
  });

  it("shares the project and branch reads between the types of a poll", async () => {
    account(3);
    await poll();
    expect(api.listProjects).toHaveBeenCalledTimes(1);
    expect(api.listProjectBranches).toHaveBeenCalledTimes(3);
    expect(api.listProjectBranchDatabases).toHaveBeenCalledTimes(6);
    expect(unread).toEqual([]);
  });

  it("reads a small account whole, in a stable order, whatever the clock says", async () => {
    vi.useFakeTimers({ toFake: ["Date"], now: new Date("2026-11-07T10:17:00Z") });
    account(5);
    const rows = await makeClient().listResources("neon-branch", ACCOUNT);
    expect(rows.map((row) => row.externalId)).toEqual(
      ids(5).flatMap((id) => [`${id}-a`, `${id}-b`]),
    );
    expect(unread).toEqual([]);
  });

  it("holds at most two requests in flight across every type", async () => {
    account(4);
    let inFlight = 0;
    let peak = 0;
    for (const fn of [api.listProjectEndpoints, api.listProjectBranchRoles, api.listCredentials]) {
      fn.mockImplementation(async () => {
        inFlight++;
        peak = Math.max(peak, inFlight);
        await new Promise((resolve) => setTimeout(resolve, 1));
        inFlight--;
        return wrap({ endpoints: [], roles: [], credentials: [] });
      });
    }
    await poll();
    expect(peak).toBeGreaterThan(0);
    expect(peak).toBeLessThanOrEqual(2);
  });

  it("reaches every project and branch over later polls", async () => {
    vi.useFakeTimers({ toFake: ["Date"], now: new Date("2026-11-07T00:00:00Z") });
    account(400);
    const endpoints = new Set<string>();
    const roles = new Set<string>();
    for (let round = 0; round < 100; round++) {
      vi.clearAllMocks();
      await poll();
      for (const [id] of api.listProjectEndpoints.mock.calls) endpoints.add(String(id));
      for (const [, b] of api.listProjectBranchRoles.mock.calls) roles.add(String(b));
      vi.setSystemTime(Date.now() + 5 * 60_000);
    }
    expect(endpoints.size).toBe(400);
    expect(roles.size).toBe(800);
  }, 30_000);

  it("stops starting reads past the poll's time budget, and names what is left", async () => {
    vi.useFakeTimers({ toFake: ["Date"], now: new Date("2026-11-07T00:00:00Z") });
    account(500);
    api.listProjectEndpoints.mockImplementation(async () => {
      vi.setSystemTime(Date.now() + 2_000);
      return wrap({ endpoints: [] });
    });
    await expect(makeClient().listResources("neon-endpoint", ACCOUNT)).resolves.toEqual([]);
    const read = api.listProjectEndpoints.mock.calls.length;
    expect(read).toBeLessThan(250);
    expect(named().size).toBe(500 - read);
  });

  it("gives a long-lived client a fresh budget once the poll's lease has passed", async () => {
    vi.useFakeTimers({ toFake: ["Date"], now: new Date("2026-11-07T00:00:00Z") });
    account(1500);
    const client = makeClient();
    await client.listResources("neon-endpoint", ACCOUNT);
    const first = api.listProjectEndpoints.mock.calls.length;
    vi.setSystemTime(Date.now() + 6 * 60_000);
    await client.listResources("neon-endpoint", ACCOUNT);
    expect(api.listProjectEndpoints.mock.calls.length).toBeGreaterThan(first + 900);
  });

  it("names a refused project for every type sharing the read, not only the first", async () => {
    account(2);
    api.listProjectBranches.mockImplementation(async ({ projectId }: { projectId: string }) => {
      if (projectId === "p1") throw httpError(403);
      return wrap({ branches: [branch("br-1")] });
    });
    const client = makeClient();
    await Promise.all(
      ["neon-role", "neon-credential", "neon-database", "neon-data-api"].map((type) =>
        client.listResources(type, ACCOUNT),
      ),
    );
    expect(
      unread.filter((part) => part.parentResourceIds?.[0] === "acct1:neon-project:p1"),
    ).toHaveLength(4);
  });

  it("fails every type sharing a read that throttled, and keeps their rows", async () => {
    account(2);
    api.listProjectBranches.mockRejectedValue(httpError(429));
    const client = makeClient();
    const results = await Promise.allSettled(
      ["neon-role", "neon-credential"].map((type) => client.listResources(type, ACCOUNT)),
    );
    expect(results.map((r) => r.status)).toEqual(["rejected", "rejected"]);
  });

  it("finds one resource outside the poll's reach by reading only its project", async () => {
    account(1500);
    api.listProjectEndpoints.mockImplementation(async (projectId: string) =>
      wrap({
        endpoints: [
          {
            id: "ep",
            host: "h",
            project_id: projectId,
            branch_id: `${projectId}-a`,
            current_state: "idle",
            type: "read_write",
            created_at: "2026-01-01",
            updated_at: "2026-01-01",
          },
        ],
      }),
    );
    const id = "acct1:neon-endpoint:p1499/ep";
    const found = await makeClient().getResource("neon-endpoint", id, ACCOUNT);
    expect(found.id).toBe(id);
    expect(api.listProjectEndpoints).toHaveBeenCalledTimes(1);
    expect(api.listProjects).not.toHaveBeenCalled();
  });
});
