import { hostClient } from "@infrawrench/plugin-base/effect";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DatabricksClient } from "../client.js";
import { plugin } from "../plugin.js";

const ACCOUNT = "acct1";
const UNREAD_HOOK = Symbol.for("infrawrench.unreadListPart");
const unread = vi.fn();

const ok = (body: unknown) => ({ status: 200, body: JSON.stringify(body) });
const fail = (status: number, body: string) => ({ status, body });
const denied = fail(
  403,
  JSON.stringify({ error_code: "PERMISSION_DENIED", message: "User does not have USE CATALOG" }),
);
const gone = fail(
  404,
  JSON.stringify({ error_code: "RESOURCE_DOES_NOT_EXIST", message: "It does not exist" }),
);

/**
 * The answers one read can get that are not "here it is or it is gone": each has to
 * fail the type, so the rows a sync would otherwise prune stay.
 */
const FAILURES: Array<[string, { status: number; body: string }]> = [
  ["a 500", fail(500, "boom")],
  ["a throttle", fail(429, JSON.stringify({ error_code: "REQUEST_LIMIT_EXCEEDED" }))],
  ["a rejected credential", fail(401, JSON.stringify({ error_code: "UNAUTHENTICATED" }))],
  ["a 403 for a bad token", fail(403, '{"error_code":"403","message":"Invalid access token."}')],
  ["a 403 from an IP allowlist", fail(403, "Source IP address is blocked")],
  ["a 404 that is not Databricks answering", fail(404, "<html>Not Found</html>")],
];

type Answer = { status: number; body: string };

/** Answers by path and query, and refuses anything it was not told about. */
function serve(routes: Record<string, Answer>) {
  vi.stubGlobal("fetch", async (input: string) => {
    const url = new URL(input);
    expect(url.host).toBe("dbc-test.cloud.databricks.com");
    const answer = routes[`${url.pathname}${url.search}`];
    if (!answer) throw new Error(`Unexpected request: ${url.pathname}${url.search}`);
    return new Response(answer.body, { status: answer.status });
  });
}

const client = () =>
  hostClient(
    new DatabricksClient(
      { host: "dbc-test.cloud.databricks.com", token: "dapi123" },
      plugin.resourceTypes,
    ),
  );

const list = (typeId: string) => client().listResources(typeId, ACCOUNT);
const externalIds = (rows: Array<{ externalId?: string }>) => rows.map((r) => r.externalId);

beforeEach(() => {
  unread.mockClear();
  Reflect.set(globalThis, UNREAD_HOOK, unread);
});

afterEach(() => {
  Reflect.deleteProperty(globalThis, UNREAD_HOOK);
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const CATALOGS = "/api/2.1/unity-catalog/catalogs?max_results=0";
const schemasOf = (catalog: string) =>
  `/api/2.1/unity-catalog/schemas?catalog_name=${catalog}&max_results=0`;
const tablesOf = (catalog: string, schema: string) =>
  `/api/2.1/unity-catalog/tables?catalog_name=${catalog}&schema_name=${schema}&max_results=0`;
const volumesOf = (catalog: string, schema: string) =>
  `/api/2.1/unity-catalog/volumes?catalog_name=${catalog}&schema_name=${schema}&max_results=0`;
const functionsOf = (catalog: string, schema: string) =>
  `/api/2.1/unity-catalog/functions?catalog_name=${catalog}&schema_name=${schema}&max_results=0`;

const twoCatalogs = ok({ catalogs: [{ name: "a" }, { name: "b" }] });

/**
 * Every fan-out in `listResources`: the routes that read one parent's children
 * fine, the read that goes wrong, the row that survives it, and the parent to name.
 */
const FAN_OUTS: Array<{
  name: string;
  typeId: string;
  routes: Record<string, Answer>;
  read: string;
  kept: string;
  parent: string;
}> = [
  {
    name: "schemas of a catalog",
    typeId: "databricks-schema",
    routes: { [CATALOGS]: twoCatalogs, [schemasOf("a")]: ok({ schemas: [{ name: "s" }] }) },
    read: schemasOf("b"),
    kept: "a.s",
    parent: `${ACCOUNT}:databricks-catalog:b`,
  },
  {
    name: "tables, a catalog's schemas",
    typeId: "databricks-table",
    routes: {
      [CATALOGS]: twoCatalogs,
      [schemasOf("a")]: ok({ schemas: [{ name: "s" }] }),
      [tablesOf("a", "s")]: ok({ tables: [{ name: "t" }] }),
    },
    read: schemasOf("b"),
    kept: "a.s.t",
    parent: `${ACCOUNT}:databricks-catalog:b`,
  },
  {
    name: "tables of a schema",
    typeId: "databricks-table",
    routes: {
      [CATALOGS]: ok({ catalogs: [{ name: "a" }] }),
      [schemasOf("a")]: ok({ schemas: [{ name: "s" }, { name: "x" }] }),
      [tablesOf("a", "s")]: ok({ tables: [{ name: "t" }] }),
    },
    read: tablesOf("a", "x"),
    kept: "a.s.t",
    parent: `${ACCOUNT}:databricks-schema:a.x`,
  },
  {
    name: "volumes, a catalog's schemas",
    typeId: "databricks-volume",
    routes: {
      [CATALOGS]: twoCatalogs,
      [schemasOf("a")]: ok({ schemas: [{ name: "s" }] }),
      [volumesOf("a", "s")]: ok({ volumes: [{ name: "v" }] }),
    },
    read: schemasOf("b"),
    kept: "a.s.v",
    parent: `${ACCOUNT}:databricks-catalog:b`,
  },
  {
    name: "volumes of a schema",
    typeId: "databricks-volume",
    routes: {
      [CATALOGS]: ok({ catalogs: [{ name: "a" }] }),
      [schemasOf("a")]: ok({ schemas: [{ name: "s" }, { name: "x" }] }),
      [volumesOf("a", "s")]: ok({ volumes: [{ name: "v" }] }),
    },
    read: volumesOf("a", "x"),
    kept: "a.s.v",
    parent: `${ACCOUNT}:databricks-schema:a.x`,
  },
  {
    name: "functions of a schema",
    typeId: "databricks-function",
    routes: {
      [CATALOGS]: ok({ catalogs: [{ name: "a" }] }),
      [schemasOf("a")]: ok({ schemas: [{ name: "s" }, { name: "x" }] }),
      [functionsOf("a", "s")]: ok({ functions: [{ name: "f" }] }),
    },
    read: functionsOf("a", "x"),
    kept: "a.s.f",
    parent: `${ACCOUNT}:databricks-schema:a.x`,
  },
  {
    name: "vector indexes of an endpoint",
    typeId: "databricks-vector-search-index",
    routes: {
      "/api/2.0/vector-search/endpoints": ok({ endpoints: [{ name: "e1" }, { name: "e2" }] }),
      "/api/2.0/vector-search/indexes?endpoint_name=e1": ok({ vector_indexes: [{ name: "i" }] }),
    },
    read: "/api/2.0/vector-search/indexes?endpoint_name=e2",
    kept: "i",
    parent: `${ACCOUNT}:databricks-vector-search-endpoint:e2`,
  },
  {
    name: "Lakebase branches of a project",
    typeId: "databricks-lakebase-branch",
    routes: {
      "/api/2.0/postgres/projects?page_size=100": ok({
        projects: [{ name: "projects/p1" }, { name: "projects/p2" }],
      }),
      "/api/2.0/postgres/projects/p1/branches?page_size=100": ok({
        branches: [{ name: "projects/p1/branches/main" }],
      }),
    },
    read: "/api/2.0/postgres/projects/p2/branches?page_size=100",
    kept: "p1/main",
    parent: `${ACCOUNT}:databricks-lakebase-project:p2`,
  },
  {
    name: "versions of a model",
    typeId: "databricks-model-version",
    routes: {
      "/api/2.1/unity-catalog/models?max_results=0": ok({
        registered_models: [{ full_name: "a.s.m1" }, { full_name: "a.s.m2" }],
      }),
      "/api/2.1/unity-catalog/models/a.s.m1/versions?max_results=100": ok({
        model_versions: [{ version: 1 }],
      }),
    },
    read: "/api/2.1/unity-catalog/models/a.s.m2/versions?max_results=100",
    kept: "a.s.m1@1",
    parent: `${ACCOUNT}:databricks-registered-model:a.s.m2`,
  },
];

describe.each(FAN_OUTS)("$name", ({ typeId, routes, read, kept, parent }) => {
  it.each(FAILURES)("%s fails the type", async (_name, answer) => {
    serve({ ...routes, [read]: answer });
    await expect(list(typeId)).rejects.toThrow(`${answer.status}`);
    expect(unread).not.toHaveBeenCalled();
  });

  it("a principal refused one parent keeps that parent's rows and reads the rest", async () => {
    serve({ ...routes, [read]: denied });
    expect(externalIds(await list(typeId))).toEqual([kept]);
    expect(unread).toHaveBeenCalledExactlyOnceWith({ parentResourceIds: [parent] });
  });

  it("a parent gone since the list has no children, so its rows can go", async () => {
    serve({ ...routes, [read]: gone });
    expect(externalIds(await list(typeId))).toEqual([kept]);
    expect(unread).not.toHaveBeenCalled();
  });
});

describe("a credential refused a whole type", () => {
  it.each([
    ["databricks-catalog", CATALOGS],
    ["databricks-schema", CATALOGS],
    ["databricks-table", CATALOGS],
    ["databricks-model-version", "/api/2.1/unity-catalog/models?max_results=0"],
    ["databricks-cluster", "/api/2.1/clusters/list?page_size=100"],
  ])("%s keeps its rows without failing", async (typeId, route) => {
    serve({ [route]: denied });
    await expect(list(typeId)).resolves.toEqual([]);
    expect(unread).toHaveBeenCalledExactlyOnceWith({ idPrefixes: [""] });
  });

  it.each(FAILURES)("%s on the same read still fails the type", async (_name, answer) => {
    serve({ [CATALOGS]: answer });
    await expect(list("databricks-schema")).rejects.toThrow(`${answer.status}`);
    expect(unread).not.toHaveBeenCalled();
  });
});

describe("workspace objects", () => {
  const root = (path: string) => `/api/2.0/workspace/list?path=${encodeURIComponent(path)}`;
  const routes = {
    [root("/Workspace")]: ok({ objects: [{ path: "/Workspace/Shared", resource_id: "1" }] }),
    [root("/Users")]: ok({ objects: [{ path: "/Users/me", resource_id: "2" }] }),
    [root("/Repos")]: ok({}),
  };

  it("reads all three roots", async () => {
    serve(routes);
    expect(externalIds(await list("databricks-workspace-object"))).toEqual(["1", "2"]);
    expect(unread).not.toHaveBeenCalled();
  });

  it.each(FAILURES)("%s on a root fails the type", async (_name, answer) => {
    serve({ ...routes, [root("/Users")]: answer });
    await expect(list("databricks-workspace-object")).rejects.toThrow(`${answer.status}`);
    expect(unread).not.toHaveBeenCalled();
  });

  it("a root this workspace does not have is none, as the document says", async () => {
    serve({ ...routes, [root("/Repos")]: gone });
    expect(externalIds(await list("databricks-workspace-object"))).toEqual(["1", "2"]);
    expect(unread).not.toHaveBeenCalled();
  });

  it("a root refused to this principal keeps the type's rows", async () => {
    serve({ ...routes, [root("/Users")]: denied });
    expect(externalIds(await list("databricks-workspace-object"))).toEqual(["1"]);
    expect(unread).toHaveBeenCalledExactlyOnceWith({ idPrefixes: [""] });
  });
});

describe("the shared list loop", () => {
  const CLUSTERS = "/api/2.1/clusters/list?page_size=100";
  const page = (token: string) => `${CLUSTERS}&page_token=${token}`;

  it("stops at its cap and says so, after exactly that many requests", async () => {
    let requests = 0;
    vi.stubGlobal("fetch", async () => {
      requests++;
      return new Response(JSON.stringify({ clusters: [], next_page_token: `t${requests}` }));
    });
    await expect(list("databricks-cluster")).rejects.toThrow("has more than Infrawrench reads");
    expect(requests).toBe(1000);
  });

  it("a child list past the cap reaches the caller through the fan-out", async () => {
    let requests = 0;
    vi.stubGlobal("fetch", async (input: string) => {
      if (new URL(input).pathname.endsWith("/catalogs")) {
        return new Response(JSON.stringify({ catalogs: [{ name: "a" }] }));
      }
      requests++;
      return new Response(JSON.stringify({ schemas: [], next_page_token: `t${requests}` }));
    });
    await expect(list("databricks-schema")).rejects.toThrow("has more than Infrawrench reads");
    expect(unread).not.toHaveBeenCalled();
  });

  it("refuses a first page whose list is not a list", async () => {
    serve({ [CLUSTERS]: ok({ clusters: "maintenance" }) });
    await expect(list("databricks-cluster")).rejects.toThrow("is not a list");
  });

  it("refuses a later page whose list is not a list", async () => {
    serve({
      [CLUSTERS]: ok({ clusters: [{ cluster_id: "c1" }], next_page_token: "t" }),
      [page("t")]: ok({ clusters: { error: "maintenance" } }),
    });
    await expect(list("databricks-cluster")).rejects.toThrow("is not a list");
  });

  it("reads a left out key and a null as an empty list", async () => {
    serve({ [CLUSTERS]: ok({}) });
    await expect(list("databricks-cluster")).resolves.toEqual([]);
    serve({ [CLUSTERS]: ok({ clusters: null }) });
    await expect(list("databricks-cluster")).resolves.toEqual([]);
  });

  it("keeps reading past an empty page that gives a next token", async () => {
    serve({
      [CLUSTERS]: ok({ next_page_token: "t" }),
      [page("t")]: ok({ clusters: [{ cluster_id: "c1" }] }),
    });
    expect(externalIds(await list("databricks-cluster"))).toEqual(["c1"]);
  });
});

describe("a fan-out past what one poll can read", () => {
  const BUDGET = 1000;
  const MODELS = 1500;

  /** A list of registered models, and one version under each. */
  function serveModels(onRead?: () => void) {
    const stats = { reads: 0, peak: 0, active: 0, modelsRead: new Set<string>() };
    vi.stubGlobal("fetch", async (input: string) => {
      const { pathname } = new URL(input);
      stats.reads++;
      stats.active++;
      stats.peak = Math.max(stats.peak, stats.active);
      onRead?.();
      await Promise.resolve();
      stats.active--;
      if (pathname === "/api/2.1/unity-catalog/models") {
        const registered_models = Array.from({ length: MODELS }, (_, i) => ({
          full_name: `a.s.m${i}`,
        }));
        return new Response(JSON.stringify({ registered_models }));
      }
      const model = /models\/([^/]+)\/versions$/.exec(pathname)?.[1];
      if (!model) throw new Error(`Unexpected request: ${pathname}`);
      stats.modelsRead.add(model);
      return new Response(JSON.stringify({ model_versions: [{ version: 1 }] }));
    });
    return stats;
  }

  const namedInReport = (): string[] =>
    unread.mock.calls.flatMap(([part]) => part.parentResourceIds ?? []);

  it("stops at the budget and names every parent it did not read", async () => {
    vi.spyOn(Math, "random").mockReturnValue(0);
    const stats = serveModels();
    const rows = await list("databricks-model-version");
    expect(stats.reads).toBe(BUDGET);
    expect(rows).toHaveLength(BUDGET - 1);
    const named = namedInReport();
    expect(named).toHaveLength(MODELS - (BUDGET - 1));
    for (const id of named) {
      const model = id.slice(`${ACCOUNT}:databricks-registered-model:`.length);
      expect(stats.modelsRead.has(model)).toBe(false);
    }
  });

  it("starts somewhere else each poll, so every parent is read over time", async () => {
    const random = vi.spyOn(Math, "random").mockReturnValue(0);
    const first = serveModels();
    await list("databricks-model-version");
    expect(first.modelsRead.has("a.s.m0")).toBe(true);
    expect(first.modelsRead.has("a.s.m1400")).toBe(false);

    random.mockReturnValue(0.9);
    const second = serveModels();
    await list("databricks-model-version");
    expect(second.modelsRead.has("a.s.m1400")).toBe(true);
  });

  it("stops when the time is up, however few reads that took", async () => {
    let now = 1_000_000;
    vi.spyOn(Date, "now").mockImplementation(() => now);
    const stats = serveModels(() => {
      now += 1000;
    });
    const rows = await list("databricks-model-version");
    expect(stats.reads).toBeLessThan(250);
    expect(rows.length + namedInReport().length).toBe(MODELS);
  });

  it("still finds the one row someone asked for, past the budget", async () => {
    vi.spyOn(Math, "random").mockReturnValue(0);
    serveModels();
    const id = `${ACCOUNT}:databricks-model-version:a.s.m1499@1`;
    const row = await client().getResource("databricks-model-version", id, ACCOUNT);
    expect(row.id).toBe(id);
    expect(unread).not.toHaveBeenCalled();
  });

  it("a refusal on the one row asked for says so instead of not found", async () => {
    serve({ [CATALOGS]: denied });
    await expect(client().getResource("databricks-catalog", "x", ACCOUNT)).rejects.toThrow("403");
    expect(unread).not.toHaveBeenCalled();
  });

  it("reads Lakebase projects one at a time", async () => {
    const stats = { active: 0, peak: 0 };
    vi.stubGlobal("fetch", async (input: string) => {
      const { pathname } = new URL(input);
      stats.active++;
      stats.peak = Math.max(stats.peak, stats.active);
      await new Promise((resolve) => setTimeout(resolve, 0));
      stats.active--;
      if (pathname === "/api/2.0/postgres/projects") {
        return new Response(
          JSON.stringify({ projects: [{ name: "projects/p1" }, { name: "projects/p2" }] }),
        );
      }
      return new Response(JSON.stringify({ branches: [] }));
    });
    await list("databricks-lakebase-branch");
    expect(stats.peak).toBe(1);
  });

  it("names a catalog's and a schema's rows the same way for tables", async () => {
    vi.spyOn(Math, "random").mockReturnValue(0);
    vi.stubGlobal("fetch", async (input: string) => {
      const { pathname } = new URL(input);
      if (pathname.endsWith("/catalogs")) {
        return new Response(JSON.stringify({ catalogs: [{ name: "a" }] }));
      }
      if (pathname.endsWith("/schemas")) {
        const schemas = Array.from({ length: 1200 }, (_, i) => ({ name: `s${i}` }));
        return new Response(JSON.stringify({ schemas }));
      }
      if (pathname.endsWith("/tables")) {
        return new Response(JSON.stringify({ tables: [{ name: "t" }] }));
      }
      throw new Error(`Unexpected request: ${pathname}`);
    });
    const rows = await list("databricks-table");
    expect(rows).toHaveLength(BUDGET - 2);
    expect(namedInReport()).toHaveLength(1200 - (BUDGET - 2));
    expect(namedInReport()[0]).toBe(`${ACCOUNT}:databricks-schema:a.s998`);
  });
});
