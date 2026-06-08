import { describe, it, expect, vi, beforeEach, afterEach, type Mock } from "vitest";
import { DatabricksClient } from "../client.js";
import { plugin } from "../plugin.js";

const ACCOUNT = "acct1";
const resourceTypes = plugin.resourceTypes;

function makeClient(extraCreds: Record<string, string> = {}, services?: unknown) {
  return new DatabricksClient(
    { host: "dbc-test.cloud.databricks.com", token: "dapi123", ...extraCreds },
    resourceTypes,
    services as never,
  );
}

interface FetchExpectation {
  ok?: boolean;
  status?: number;
  body?: unknown;
  text?: string;
  reject?: Error;
}

let fetchMock: Mock;

function bodyText(r: FetchExpectation): string {
  if (r.text !== undefined) return r.text;
  if (r.body === undefined) return "";
  return typeof r.body === "string" ? r.body : JSON.stringify(r.body);
}

function mockFetch(...responses: FetchExpectation[]) {
  let i = 0;
  fetchMock.mockImplementation(async () => {
    const r = responses[Math.min(i, responses.length - 1)]!;
    i++;
    if (r.reject) throw r.reject;
    const status = r.status ?? (r.ok === false ? 500 : 200);
    return {
      ok: r.ok ?? status < 400,
      status,
      statusText: "Status",
      text: async () => bodyText(r),
    } as unknown as Response;
  });
}

beforeEach(() => {
  fetchMock = vi.fn();
  vi.spyOn(globalThis, "fetch").mockImplementation(fetchMock as never);
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("constructor", () => {
  it("throws without token", () => {
    expect(() => new DatabricksClient({ host: "h" }, [])).toThrow(/missing personal access token/);
  });
  it("normalizes host with https and strips trailing slash", async () => {
    mockFetch({ body: { clusters: [] } });
    const client = makeClient();
    await client.listResources("databricks-cluster", ACCOUNT);
    expect(fetchMock.mock.calls[0]![0]).toBe(
      "https://dbc-test.cloud.databricks.com/api/2.1/clusters/list?page_size=100",
    );
  });
  it("keeps explicit http:// host", async () => {
    mockFetch({ body: { clusters: [] } });
    const client = makeClient({ host: "http://local/" });
    await client.listResources("databricks-cluster", ACCOUNT);
    expect(fetchMock.mock.calls[0]![0]).toBe("http://local/api/2.1/clusters/list?page_size=100");
  });
});

describe("api error + empty handling", () => {
  it("throws on non-ok with body text", async () => {
    mockFetch({ ok: false, status: 403, text: "forbidden" });
    const client = makeClient();
    await expect(client.listResources("databricks-cluster", ACCOUNT)).rejects.toThrow(
      /failed: 403 forbidden/,
    );
  });

  it("returns {} for empty 200 body", async () => {
    mockFetch({ body: "" });
    const client = makeClient();
    const res = await client.listResources("databricks-cluster", ACCOUNT);
    expect(res).toEqual([]);
  });
});

describe("listResources routing", () => {
  it("lists schemas across catalogs and skips failing catalogs", async () => {
    // 1: catalogs, 2: schemas for cat1 ok, 3: schemas for cat2 throws
    fetchMock.mockImplementation(async (url: string) => {
      if (url.includes("/catalogs"))
        return jsonResp({ catalogs: [{ name: "cat1" }, { name: "cat2" }] });
      if (url.includes("catalog_name=cat1")) return jsonResp({ schemas: [{ name: "s1" }] });
      // cat2 fails
      return { ok: false, status: 500, text: async () => "boom" } as unknown as Response;
    });
    const client = makeClient();
    const res = await client.listResources("databricks-schema", ACCOUNT);
    expect(res).toHaveLength(1);
    expect(res[0]!.fields.catalogName).toBe("cat1");
  });

  it("lists tables across catalogs/schemas with skips", async () => {
    fetchMock.mockImplementation(async (url: string) => {
      if (url.includes("/catalogs"))
        return jsonResp({ catalogs: [{ name: "cat1" }, { name: "catX" }] });
      if (url.includes("/schemas") && url.includes("cat1"))
        return jsonResp({ schemas: [{ name: "s1" }, { name: "s2" }] });
      if (url.includes("/schemas") && url.includes("catX"))
        return { ok: false, status: 500, text: async () => "x" } as unknown as Response;
      if (url.includes("/tables") && url.includes("schema_name=s1"))
        return jsonResp({ tables: [{ name: "t1" }] });
      // s2 tables fail
      return { ok: false, status: 500, text: async () => "x" } as unknown as Response;
    });
    const client = makeClient();
    const res = await client.listResources("databricks-table", ACCOUNT);
    expect(res).toHaveLength(1);
    expect(res[0]!.fields.name).toBe("t1");
  });

  it("throws unknown type", async () => {
    const client = makeClient();
    await expect(client.listResources("nope", ACCOUNT)).rejects.toThrow(/unknown resource type/);
  });
});

function jsonResp(body: unknown): Response {
  return {
    ok: true,
    status: 200,
    text: async () => JSON.stringify(body),
  } as unknown as Response;
}

describe("getResource / resolveOutput", () => {
  it("getResource throws not found", async () => {
    mockFetch({ body: { clusters: [] } });
    const client = makeClient();
    await expect(
      client.getResource("databricks-cluster", "acct1:databricks-cluster:x", ACCOUNT),
    ).rejects.toThrow(/not found/);
  });

  it("resolveOutput returns resolved value", async () => {
    mockFetch({
      body: { clusters: [{ cluster_id: "c1", cluster_name: "n", spark_context_id: "sc" }] },
    });
    const client = makeClient();
    const v = await client.resolveOutput(
      "databricks-cluster",
      "acct1:databricks-cluster:c1",
      "sparkContextId",
      ACCOUNT,
    );
    expect(v).toBe("sc");
  });

  it("resolveOutput throws for unknown output", async () => {
    mockFetch({ body: { clusters: [{ cluster_id: "c1" }] } });
    const client = makeClient();
    await expect(
      client.resolveOutput("databricks-cluster", "acct1:databricks-cluster:c1", "nope", ACCOUNT),
    ).rejects.toThrow(/cannot resolve output/);
  });
});

describe("fetchDashboardStats", () => {
  it("sql-warehouse running/stopped/other variants", async () => {
    const client = makeClient();
    for (const [state, variant] of [
      ["RUNNING", "status-healthy"],
      ["STOPPED", "status-error"],
      ["STARTING", "status-degraded"],
    ] as const) {
      mockFetch({ body: { warehouses: [{ id: "w1", state }] } });
      const stats = await client.fetchDashboardStats(
        "databricks-sql-warehouse",
        "acct1:databricks-sql-warehouse:w1",
        ACCOUNT,
      );
      expect(stats[0]).toMatchObject({ value: state, variant });
    }
  });

  it("job and pipeline stats", async () => {
    const client = makeClient();
    mockFetch({ body: { jobs: [{ job_id: 1, settings: { name: "J" } }] } });
    const jobStats = await client.fetchDashboardStats(
      "databricks-job",
      "acct1:databricks-job:1",
      ACCOUNT,
    );
    expect(jobStats[0]!.label).toBe("State");
    mockFetch({ body: { statuses: [{ pipeline_id: "p1", state: "IDLE" }] } });
    const pipeStats = await client.fetchDashboardStats(
      "databricks-pipeline",
      "acct1:databricks-pipeline:p1",
      ACCOUNT,
    );
    expect(pipeStats[0]!.value).toBe("IDLE");
  });

  it("cluster stats variants", async () => {
    const client = makeClient();
    mockFetch({
      body: {
        clusters: [{ cluster_id: "c1", state: "TERMINATED", node_type_id: "i3", num_workers: 2 }],
      },
    });
    const stats = await client.fetchDashboardStats(
      "databricks-cluster",
      "acct1:databricks-cluster:c1",
      ACCOUNT,
    );
    expect(stats[0]).toMatchObject({ value: "TERMINATED", variant: "status-error" });
    expect(stats[2]!.value).toBe("2");
  });

  it("catalog stats with type and schema count", async () => {
    const client = makeClient();
    mockFetch({
      body: { catalogs: [{ name: "main", owner: "me", catalog_type: "MANAGED_CATALOG" }] },
    });
    const stats = await client.fetchDashboardStats(
      "databricks-catalog",
      "acct1:databricks-catalog:main",
      ACCOUNT,
    );
    expect(stats.find((s) => s.label === "Type")).toBeTruthy();
    expect(stats.find((s) => s.label === "Schemas")).toBeTruthy();
  });

  it("schema stats", async () => {
    fetchMock.mockImplementation(async (url: string) => {
      if (url.includes("/catalogs")) return jsonResp({ catalogs: [{ name: "main" }] });
      return jsonResp({ schemas: [{ name: "s1", owner: "me" }] });
    });
    const client = makeClient();
    const stats = await client.fetchDashboardStats(
      "databricks-schema",
      "acct1:databricks-schema:main.s1",
      ACCOUNT,
    );
    expect(stats[0]).toMatchObject({ label: "Catalog", value: "main" });
    expect(stats.find((s) => s.label === "Owner")).toBeTruthy();
    expect(stats.find((s) => s.label === "Tables")).toBeTruthy();
  });

  it("table stats with format and columns", async () => {
    fetchMock.mockImplementation(async (url: string) => {
      if (url.includes("/catalogs")) return jsonResp({ catalogs: [{ name: "main" }] });
      if (url.includes("/schemas")) return jsonResp({ schemas: [{ name: "s1" }] });
      return jsonResp({
        tables: [{ name: "t1", table_type: "MANAGED", data_source_format: "DELTA", columns: [{}] }],
      });
    });
    const client = makeClient();
    const stats = await client.fetchDashboardStats(
      "databricks-table",
      "acct1:databricks-table:main.s1.t1",
      ACCOUNT,
    );
    expect(stats[0]).toMatchObject({ label: "Type", value: "MANAGED" });
    expect(stats.find((s) => s.label === "Format")).toBeTruthy();
    expect(stats.find((s) => s.label === "Columns")).toBeTruthy();
  });

  it("returns empty for serving-endpoint (default)", async () => {
    mockFetch({ body: { endpoints: [{ name: "ep", state: { ready: "READY" } }] } });
    const client = makeClient();
    const stats = await client.fetchDashboardStats(
      "databricks-serving-endpoint",
      "acct1:databricks-serving-endpoint:ep",
      ACCOUNT,
    );
    expect(stats).toEqual([]);
  });
});

describe("renderDetail / renderSidebarItem", () => {
  const base = { pluginId: "databricks", accountId: ACCOUNT, secretStates: [] };

  it("renders cluster detail with state + outputs section", () => {
    const client = makeClient();
    const d = client.renderDetail({
      ...base,
      id: "x",
      resourceTypeId: "databricks-cluster",
      displayName: "C",
      fields: { state: "RUNNING", clusterId: "c1" },
      resolvedOutputs: { clusterId: "c1", jdbcUrl: "jdbc:..." },
    } as never);
    expect(d.subtitle).toContain("Cluster");
    expect(d.status).toMatchObject({ status: "healthy", label: "RUNNING" });
    expect(d.sections.length).toBe(2);
  });

  it("renders detail with no state -> info, no outputs section", () => {
    const client = makeClient();
    const d = client.renderDetail({
      ...base,
      id: "x",
      resourceTypeId: "databricks-table",
      displayName: "T",
      fields: { name: "t" },
      resolvedOutputs: {},
    } as never);
    expect(d.status).toMatchObject({ status: "info" });
    expect(d.sections.length).toBe(1);
  });

  it("uses lastRunState when state absent", () => {
    const client = makeClient();
    const d = client.renderDetail({
      ...base,
      id: "x",
      resourceTypeId: "databricks-job",
      displayName: "J",
      fields: { lastRunState: "FAILED" },
      resolvedOutputs: {},
    } as never);
    expect(d.status).toMatchObject({ status: "error", label: "FAILED" });
  });

  it("renders serving endpoint chat panel (ready)", () => {
    const client = makeClient();
    const d = client.renderDetail({
      ...base,
      id: "x",
      resourceTypeId: "databricks-serving-endpoint",
      displayName: "EP",
      fields: { state: "READY" },
      resolvedOutputs: {},
    } as never);
    expect(d.chatPanel).toBeTruthy();
    expect(d.chatPanel).not.toHaveProperty("disabledReason");
  });

  it("renders serving endpoint chat panel (not ready -> disabledReason)", () => {
    const client = makeClient();
    const d = client.renderDetail({
      ...base,
      id: "x",
      resourceTypeId: "databricks-serving-endpoint",
      displayName: "EP",
      fields: { state: "NOT_READY" },
      resolvedOutputs: {},
    } as never);
    expect(d.chatPanel?.disabledReason).toBeTruthy();
  });

  it("renders unknown type label fallback", () => {
    const client = makeClient();
    const d = client.renderDetail({
      ...base,
      id: "x",
      resourceTypeId: "weird",
      displayName: "W",
      fields: {},
      resolvedOutputs: {},
    } as never);
    expect(d.subtitle).toContain("weird");
  });

  it("renderSidebarItem maps state and falls back to info", () => {
    const client = makeClient();
    expect(
      client.renderSidebarItem({
        id: "x",
        displayName: "C",
        resourceTypeId: "databricks-cluster",
        fields: { state: "RUNNING" },
      } as never).status,
    ).toMatchObject({ status: "healthy" });
    expect(
      client.renderSidebarItem({
        id: "x",
        displayName: "C",
        resourceTypeId: "databricks-cluster",
        fields: { lastRunState: "FAILED" },
      } as never).status,
    ).toMatchObject({ status: "error" });
    expect(
      client.renderSidebarItem({
        id: "x",
        displayName: "C",
        resourceTypeId: "databricks-cluster",
        fields: {},
      } as never).status,
    ).toMatchObject({ status: "info" });
  });
});

describe("streamChatMessage", () => {
  async function collect(gen: AsyncGenerator<unknown>) {
    const events: unknown[] = [];
    for await (const e of gen) events.push(e);
    return events;
  }

  function sseStream(chunks: string[]): ReadableStream<Uint8Array> {
    const enc = new TextEncoder();
    let i = 0;
    return new ReadableStream({
      pull(controller) {
        if (i < chunks.length) {
          controller.enqueue(enc.encode(chunks[i++]));
        } else {
          controller.close();
        }
      },
    });
  }

  it("errors for unsupported type", async () => {
    const client = makeClient();
    const events = await collect(client.streamChatMessage("databricks-cluster", "x", ACCOUNT, []));
    expect(events[0]).toMatchObject({ kind: "error" });
  });

  it("errors when name cannot be determined", async () => {
    const client = makeClient();
    const events = await collect(
      client.streamChatMessage(
        "databricks-serving-endpoint",
        "acct1:databricks-serving-endpoint:",
        ACCOUNT,
        [],
      ),
    );
    expect(events[0]).toMatchObject({ kind: "error", message: expect.stringContaining("name") });
  });

  it("errors when fetch rejects", async () => {
    fetchMock.mockRejectedValue(new Error("network down"));
    const client = makeClient();
    const events = await collect(
      client.streamChatMessage(
        "databricks-serving-endpoint",
        "acct1:databricks-serving-endpoint:ep",
        ACCOUNT,
        [{ role: "user", content: "hi" }],
      ),
    );
    expect(events[0]).toMatchObject({ kind: "error", message: "network down" });
  });

  it("errors on non-ok response", async () => {
    fetchMock.mockResolvedValue({
      ok: false,
      status: 500,
      statusText: "ISE",
      body: null,
      text: async () => "boom",
    } as unknown as Response);
    const client = makeClient();
    const events = await collect(
      client.streamChatMessage(
        "databricks-serving-endpoint",
        "acct1:databricks-serving-endpoint:ep",
        ACCOUNT,
        [],
      ),
    );
    expect(events[0]).toMatchObject({ kind: "error", message: expect.stringContaining("500") });
  });

  it("parses SSE deltas, usage, and emits done", async () => {
    const stream = sseStream([
      'data: {"choices":[{"delta":{"content":"Hello"}}]}\n\n',
      'data: {"choices":[{"delta":{"content":" world"}}]}\n\n',
      "data: not-json\n\n",
      'data: {"usage":{"prompt_tokens":5,"completion_tokens":2,"total_tokens":7}}\n\n',
      "data: [DONE]\n\n",
    ]);
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      body: stream,
      text: async () => "",
    } as unknown as Response);
    const client = makeClient();
    const events = await collect(
      client.streamChatMessage(
        "databricks-serving-endpoint",
        "acct1:databricks-serving-endpoint:ep",
        ACCOUNT,
        [{ role: "user", content: "hi" }],
      ),
    );
    const deltas = events.filter((e: unknown) => (e as { kind: string }).kind === "delta");
    expect(deltas).toHaveLength(2);
    const done = events.find((e: unknown) => (e as { kind: string }).kind === "done") as {
      message: { content: string };
      usage: { inputTokens: number; outputTokens: number; totalTokens: number };
    };
    expect(done.message.content).toBe("Hello world");
    expect(done.usage).toEqual({ inputTokens: 5, outputTokens: 2, totalTokens: 7 });
    // verify request shape
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toContain("/serving-endpoints/ep/invocations");
    expect(JSON.parse(init.body)).toMatchObject({ stream: true });
  });

  it("errors when stream read throws", async () => {
    const reader = {
      read: vi.fn().mockRejectedValue(new Error("read fail")),
    };
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      body: { getReader: () => reader },
      text: async () => "",
    } as unknown as Response);
    const client = makeClient();
    const events = await collect(
      client.streamChatMessage(
        "databricks-serving-endpoint",
        "acct1:databricks-serving-endpoint:ep",
        ACCOUNT,
        [],
      ),
    );
    expect(events.some((e: unknown) => (e as { kind: string }).kind === "error")).toBe(true);
  });
});

describe("executeQuery / introspectResource", () => {
  function warehouseList() {
    return jsonResp({ warehouses: [{ id: "w1", name: "WH", state: "RUNNING" }] });
  }

  it("runs query that succeeds immediately", async () => {
    fetchMock.mockImplementation(async (url: string) => {
      if (url.includes("/warehouses")) return warehouseList();
      return jsonResp({
        status: { state: "SUCCEEDED" },
        manifest: { schema: { columns: [{ name: "a", type_name: "INT" }] } },
        result: { data_array: [[1], [2]] },
      });
    });
    const client = makeClient();
    const out = await client.executeQuery("acct1:databricks-sql-warehouse:w1", ACCOUNT, "SELECT 1");
    expect(out.rows).toEqual([{ a: 1 }, { a: 2 }]);
    const stmtCall = fetchMock.mock.calls.find((c) => c[0].includes("/sql/statements"));
    expect(JSON.parse(stmtCall![1].body)).toMatchObject({
      warehouse_id: "w1",
      statement: "SELECT 1",
    });
  });

  it("throws when initial status FAILED", async () => {
    fetchMock.mockImplementation(async (url: string) => {
      if (url.includes("/warehouses")) return warehouseList();
      return jsonResp({ status: { state: "FAILED", error: { message: "bad sql" } } });
    });
    const client = makeClient();
    await expect(
      client.executeQuery("acct1:databricks-sql-warehouse:w1", ACCOUNT, "SELECT"),
    ).rejects.toThrow(/bad sql/);
  });

  it("polls pending then succeeds", async () => {
    vi.useFakeTimers();
    let stmtCalls = 0;
    fetchMock.mockImplementation(async (url: string) => {
      if (url.includes("/warehouses")) return warehouseList();
      if (url.includes("/sql/statements/")) {
        return jsonResp({
          status: { state: "SUCCEEDED" },
          manifest: { schema: { columns: [{ name: "x", type_name: "INT" }] } },
          result: { data_array: [[9]] },
        });
      }
      stmtCalls++;
      return jsonResp({ statement_id: "stmt1", status: { state: "PENDING" } });
    });
    const client = makeClient();
    const promise = client.executeQuery("acct1:databricks-sql-warehouse:w1", ACCOUNT, "SELECT");
    await vi.advanceTimersByTimeAsync(1000);
    const out = await promise;
    expect(out.rows).toEqual([{ x: 9 }]);
    expect(stmtCalls).toBe(1);
  });

  it("throws when polling returns FAILED", async () => {
    vi.useFakeTimers();
    fetchMock.mockImplementation(async (url: string) => {
      if (url.includes("/warehouses")) return warehouseList();
      if (url.includes("/sql/statements/"))
        return jsonResp({ status: { state: "FAILED", error: { message: "poll fail" } } });
      return jsonResp({ statement_id: "stmt1", status: { state: "RUNNING" } });
    });
    const client = makeClient();
    const promise = client.executeQuery("acct1:databricks-sql-warehouse:w1", ACCOUNT, "SELECT");
    const assertion = expect(promise).rejects.toThrow(/poll fail/);
    await vi.advanceTimersByTimeAsync(1000);
    await assertion;
  });

  it("introspectResource builds table metadata", async () => {
    fetchMock.mockImplementation(async (url: string) => {
      if (url.includes("/warehouses")) return warehouseList();
      return jsonResp({
        status: { state: "SUCCEEDED" },
        manifest: {
          schema: {
            columns: [
              { name: "table_catalog" },
              { name: "table_schema" },
              { name: "table_name" },
              { name: "column_name" },
              { name: "data_type" },
            ],
          },
        },
        result: {
          data_array: [
            ["c", "s", "t1", "id", "INT"],
            ["c", "s", "t1", "name", "STRING"],
          ],
        },
      });
    });
    const client = makeClient();
    const meta = await client.introspectResource("acct1:databricks-sql-warehouse:w1", ACCOUNT);
    expect(meta).toEqual([
      {
        name: "c.s.t1",
        columns: [
          { name: "id", type: "INT" },
          { name: "name", type: "STRING" },
        ],
      },
    ]);
  });

  it("introspectResource returns [] on failure", async () => {
    fetchMock.mockImplementation(async (url: string) => {
      if (url.includes("/warehouses")) return warehouseList();
      return { ok: false, status: 500, text: async () => "x" } as unknown as Response;
    });
    const client = makeClient();
    expect(await client.introspectResource("acct1:databricks-sql-warehouse:w1", ACCOUNT)).toEqual(
      [],
    );
  });
});

describe("deleteResource", () => {
  function mockSingle(listKey: string, record: Record<string, unknown>) {
    fetchMock.mockImplementation(async (url: string) => {
      if (url.includes("/catalogs")) return jsonResp({ catalogs: [record] });
      if (url.includes("/schemas")) return jsonResp({ schemas: [record] });
      if (url.includes("/tables")) return jsonResp({ tables: [record] });
      return jsonResp({ [listKey]: [record] });
    });
  }

  it("deletes cluster", async () => {
    mockSingle("clusters", { cluster_id: "c1" });
    const client = makeClient();
    await client.deleteResource("databricks-cluster", "acct1:databricks-cluster:c1", ACCOUNT);
    const del = fetchMock.mock.calls.find((c) => c[0].includes("/permanent-delete"));
    expect(JSON.parse(del![1].body)).toEqual({ cluster_id: "c1" });
  });

  it("deletes sql warehouse", async () => {
    mockSingle("warehouses", { id: "w1" });
    const client = makeClient();
    await client.deleteResource(
      "databricks-sql-warehouse",
      "acct1:databricks-sql-warehouse:w1",
      ACCOUNT,
    );
    expect(
      fetchMock.mock.calls.some(
        (c) => c[0].includes("/sql/warehouses/w1") && c[1].method === "DELETE",
      ),
    ).toBe(true);
  });

  it("deletes job", async () => {
    mockSingle("jobs", { job_id: 5, settings: { name: "J" } });
    const client = makeClient();
    await client.deleteResource("databricks-job", "acct1:databricks-job:5", ACCOUNT);
    const del = fetchMock.mock.calls.find((c) => c[0].includes("/jobs/delete"));
    expect(JSON.parse(del![1].body)).toEqual({ job_id: 5 });
  });

  it("deletes pipeline", async () => {
    mockSingle("statuses", { pipeline_id: "p1" });
    const client = makeClient();
    await client.deleteResource("databricks-pipeline", "acct1:databricks-pipeline:p1", ACCOUNT);
    expect(fetchMock.mock.calls.some((c) => c[0].includes("/pipelines/p1"))).toBe(true);
  });

  it("deletes catalog", async () => {
    mockSingle("catalogs", { name: "main" });
    const client = makeClient();
    await client.deleteResource("databricks-catalog", "acct1:databricks-catalog:main", ACCOUNT);
    expect(fetchMock.mock.calls.some((c) => c[0].includes("/unity-catalog/catalogs/main"))).toBe(
      true,
    );
  });

  it("deletes schema", async () => {
    fetchMock.mockImplementation(async (url: string) => {
      if (url.includes("/catalogs")) return jsonResp({ catalogs: [{ name: "main" }] });
      if (url.includes("/schemas?")) return jsonResp({ schemas: [{ name: "s1" }] });
      return jsonResp({});
    });
    const client = makeClient();
    await client.deleteResource("databricks-schema", "acct1:databricks-schema:main.s1", ACCOUNT);
    expect(fetchMock.mock.calls.some((c) => c[0].includes("/unity-catalog/schemas/main.s1"))).toBe(
      true,
    );
  });

  it("deletes table", async () => {
    fetchMock.mockImplementation(async (url: string) => {
      if (url.includes("/catalogs")) return jsonResp({ catalogs: [{ name: "main" }] });
      if (url.includes("/schemas?")) return jsonResp({ schemas: [{ name: "s1" }] });
      if (url.includes("/tables?")) return jsonResp({ tables: [{ name: "t1" }] });
      return jsonResp({});
    });
    const client = makeClient();
    await client.deleteResource("databricks-table", "acct1:databricks-table:main.s1.t1", ACCOUNT);
    expect(
      fetchMock.mock.calls.some((c) => c[0].includes("/unity-catalog/tables/main.s1.t1")),
    ).toBe(true);
  });

  it("throws for unsupported type", async () => {
    mockFetch({ body: { clusters: [{ cluster_id: "c1" }] } });
    const client = makeClient();
    // serving-endpoint has no delete branch
    await expect(
      client.deleteResource(
        "databricks-serving-endpoint",
        "acct1:databricks-serving-endpoint:ep",
        ACCOUNT,
      ),
    ).rejects.toThrow();
  });
});

describe("getCreateConfig", () => {
  it("returns static configs", async () => {
    const client = makeClient();
    for (const t of [
      "databricks-cluster",
      "databricks-sql-warehouse",
      "databricks-job",
      "databricks-pipeline",
      "databricks-catalog",
    ]) {
      const cfg = await client.getCreateConfig(t);
      expect(cfg.fields.length).toBeGreaterThan(0);
    }
  });

  it("schema config without parent lists catalogs", async () => {
    mockFetch({ body: { catalogs: [{ name: "main" }] } });
    const client = makeClient();
    const cfg = await client.getCreateConfig("databricks-schema");
    expect(cfg.fields[0]!.key).toBe("catalogName");
    expect(cfg.fields[0]).toMatchObject({ defaultValue: "main" });
  });

  it("schema config with parent omits catalog picker", async () => {
    const client = makeClient();
    const cfg = await client.getCreateConfig("databricks-schema", "acct1:databricks-catalog:main");
    expect(cfg.fields.map((f) => f.key)).toEqual(["name", "comment"]);
  });

  it("table config without parent lists catalogs", async () => {
    mockFetch({ body: { catalogs: [{ name: "main" }] } });
    const client = makeClient();
    const cfg = await client.getCreateConfig("databricks-table");
    expect(cfg.fields.find((f) => f.key === "catalogName")).toBeTruthy();
    expect(cfg.fields.find((f) => f.key === "schemaName")).toBeTruthy();
  });

  it("table config with parent omits catalog/schema pickers", async () => {
    const client = makeClient();
    const cfg = await client.getCreateConfig("databricks-table", "acct1:databricks-schema:main.s1");
    expect(cfg.fields.find((f) => f.key === "catalogName")).toBeFalsy();
  });

  it("throws unknown type", async () => {
    const client = makeClient();
    await expect(client.getCreateConfig("nope")).rejects.toThrow(/no create config/);
  });
});

describe("createResource", () => {
  it("creates cluster", async () => {
    mockFetch({ body: { cluster_id: "c1" } });
    const client = makeClient();
    const res = await client.createResource("databricks-cluster", ACCOUNT, {
      clusterName: "C",
      numWorkers: "3",
    });
    expect(res.id).toBe("acct1:databricks-cluster:c1");
    expect(res.fields.state).toBe("PENDING");
    expect(JSON.parse(fetchMock.mock.calls[0]![1]!.body)).toMatchObject({
      cluster_name: "C",
      num_workers: 3,
    });
  });

  it("creates sql warehouse", async () => {
    mockFetch({ body: { id: "w1" } });
    const client = makeClient();
    const res = await client.createResource("databricks-sql-warehouse", ACCOUNT, {
      name: "WH",
      enablePhoton: "false",
    });
    expect(res.id).toBe("acct1:databricks-sql-warehouse:w1");
    expect(res.fields.enablePhoton).toBe(false);
    expect(res.resolvedOutputs.jdbcUrl).toContain("/sql/1.0/warehouses/w1");
  });

  it("creates job (notebook) with schedule", async () => {
    mockFetch({ body: { job_id: 9 } });
    const client = makeClient();
    const res = await client.createResource("databricks-job", ACCOUNT, {
      name: "J",
      taskType: "notebook",
      taskPath: "/nb",
      schedule: "0 0 12 * * ?",
    });
    expect(res.id).toBe("acct1:databricks-job:9");
    const body = JSON.parse(fetchMock.mock.calls[0]![1]!.body);
    expect(body.tasks[0]).toMatchObject({ notebook_task: { notebook_path: "/nb" } });
    expect(body.schedule.quartz_cron_expression).toBe("0 0 12 * * ?");
  });

  it("creates job (python) without schedule", async () => {
    mockFetch({ body: { job_id: 10 } });
    const client = makeClient();
    await client.createResource("databricks-job", ACCOUNT, {
      name: "J",
      taskType: "python",
      taskPath: "main.py",
    });
    const body = JSON.parse(fetchMock.mock.calls[0]![1]!.body);
    expect(body.tasks[0]).toMatchObject({ spark_python_task: { python_file: "main.py" } });
    expect(body.schedule).toBeUndefined();
  });

  it("creates job (jar)", async () => {
    mockFetch({ body: { job_id: 11 } });
    const client = makeClient();
    await client.createResource("databricks-job", ACCOUNT, {
      name: "J",
      taskType: "spark_jar",
      taskPath: "com.x.Main",
    });
    const body = JSON.parse(fetchMock.mock.calls[0]![1]!.body);
    expect(body.tasks[0]).toMatchObject({ spark_jar_task: { main_class_name: "com.x.Main" } });
  });

  it("creates pipeline with target/catalog", async () => {
    mockFetch({ body: { pipeline_id: "p1" } });
    const client = makeClient();
    const res = await client.createResource("databricks-pipeline", ACCOUNT, {
      name: "P",
      continuous: "true",
      photon: "false",
      target: "tgt",
      catalog: "cat",
    });
    expect(res.fields.continuous).toBe(true);
    expect(res.fields.photon).toBe(false);
    const body = JSON.parse(fetchMock.mock.calls[0]![1]!.body);
    expect(body).toMatchObject({ target: "tgt", catalog: "cat" });
  });

  it("creates catalog with comment", async () => {
    mockFetch({ body: { name: "main", owner: "me", comment: "c", metastore_id: "ms" } });
    const client = makeClient();
    const res = await client.createResource("databricks-catalog", ACCOUNT, {
      name: "main",
      comment: "c",
    });
    expect(res.id).toBe("acct1:databricks-catalog:main");
    expect(res.resolvedOutputs.metastoreId).toBe("ms");
  });

  it("creates schema using parent", async () => {
    mockFetch({ body: { name: "s1", catalog_name: "main", full_name: "main.s1" } });
    const client = makeClient();
    const res = await client.createResource(
      "databricks-schema",
      ACCOUNT,
      { name: "s1" },
      "acct1:databricks-catalog:main",
    );
    expect(res.id).toBe("acct1:databricks-schema:main.s1");
    expect(res.fields.catalogName).toBe("main");
  });

  it("creates schema using fields with no full_name", async () => {
    mockFetch({ body: { name: "s1", catalog_name: "main" } });
    const client = makeClient();
    const res = await client.createResource("databricks-schema", ACCOUNT, {
      name: "s1",
      catalogName: "main",
      comment: "c",
    });
    expect(res.externalId).toBe("main.s1");
  });

  it("creates table using parent (catalog.schema)", async () => {
    mockFetch({
      body: {
        name: "t1",
        full_name: "main.s1.t1",
        storage_location: "s3://x",
        columns: [{}, {}, {}],
      },
    });
    const client = makeClient();
    const res = await client.createResource(
      "databricks-table",
      ACCOUNT,
      {
        name: "t1",
        tableType: "EXTERNAL",
        dataSourceFormat: "PARQUET",
        storageLocation: "s3://x",
        comment: "c",
      },
      "acct1:databricks-schema:main.s1",
    );
    expect(res.id).toBe("acct1:databricks-table:main.s1.t1");
    expect(res.fields.columnCount).toBe(3);
    const body = JSON.parse(fetchMock.mock.calls[0]![1]!.body);
    expect(body).toMatchObject({ storage_location: "s3://x", comment: "c", catalog_name: "main" });
  });

  it("creates table with fields defaults (no parent)", async () => {
    mockFetch({ body: { name: "t1" } });
    const client = makeClient();
    const res = await client.createResource("databricks-table", ACCOUNT, {
      name: "t1",
      catalogName: "main",
    });
    expect(res.fields.schemaName).toBe("default");
    expect(res.fields.columnCount).toBe(2);
  });

  it("throws unsupported type", async () => {
    const client = makeClient();
    await expect(client.createResource("nope", ACCOUNT, {})).rejects.toThrow(
      /createResource not supported/,
    );
  });
});

describe("caCert host http routing", () => {
  it("routes api through services.http when caCert set", async () => {
    const request = vi.fn(async () => ({ status: 200, body: JSON.stringify({ clusters: [] }) }));
    const client = makeClient({ caCert: "PEM" }, { http: { request } });
    await client.listResources("databricks-cluster", ACCOUNT);
    expect(request).toHaveBeenCalledWith(expect.objectContaining({ caCert: "PEM", method: "GET" }));
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("throws on non-2xx host http response", async () => {
    const request = vi.fn(async () => ({ status: 500, body: "boom" }));
    const client = makeClient({ caCert: "PEM" }, { http: { request } });
    await expect(client.listResources("databricks-cluster", ACCOUNT)).rejects.toThrow(
      /failed: 500/,
    );
  });

  it("returns {} for empty host http body", async () => {
    const request = vi.fn(async () => ({ status: 200, body: "" }));
    const client = makeClient({ caCert: "PEM" }, { http: { request } });
    expect(await client.listResources("databricks-cluster", ACCOUNT)).toEqual([]);
  });
});
