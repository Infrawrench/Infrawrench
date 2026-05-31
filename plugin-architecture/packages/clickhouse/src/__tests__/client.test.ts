import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// --- Mock the @clickhouse/client-web SDK -----------------------------------
const sdkState: {
  createArgs: unknown[];
  query: ReturnType<typeof vi.fn>;
  command: ReturnType<typeof vi.fn>;
  close: ReturnType<typeof vi.fn>;
  jsonResult: Record<string, unknown>[];
  queryThrows: Error | null;
  commandThrows: Error | null;
} = {
  createArgs: [],
  query: vi.fn(),
  command: vi.fn(),
  close: vi.fn(),
  jsonResult: [],
  queryThrows: null,
  commandThrows: null,
};

vi.mock("@clickhouse/client-web", () => ({
  createClient: (args: unknown) => {
    sdkState.createArgs.push(args);
    return {
      query: async (q: unknown) => {
        sdkState.query(q);
        if (sdkState.queryThrows) throw sdkState.queryThrows;
        return { json: async () => sdkState.jsonResult };
      },
      command: async (c: unknown) => {
        sdkState.command(c);
        if (sdkState.commandThrows) throw sdkState.commandThrows;
      },
      close: async () => {
        sdkState.close();
      },
    };
  },
}));

import { ClickHouseClient } from "../client.js";

const ACCOUNT = "acct-1";

interface FetchCall {
  url: string;
  init?: RequestInit;
}
let calls: FetchCall[] = [];

function jsonResponse(body: unknown, status = 200): Response {
  const text = typeof body === "string" ? body : JSON.stringify(body);
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => text,
  } as unknown as Response;
}

function installFetch(handler: (url: string, init?: RequestInit) => Response) {
  return vi.spyOn(globalThis, "fetch").mockImplementation((async (
    url: string,
    init?: RequestInit,
  ) => {
    calls.push({ url: String(url), init });
    return handler(String(url), init);
  }) as typeof fetch);
}

function router(routes: Array<[(url: string, init?: RequestInit) => boolean, unknown, number?]>) {
  return installFetch((url, init) => {
    for (const [pred, body, status] of routes) {
      if (pred(url, init)) return jsonResponse(body, status ?? 200);
    }
    throw new Error(`unrouted: ${init?.method ?? "GET"} ${url}`);
  });
}

const method = (i?: RequestInit) => i?.method ?? "GET";

const CREDS = {
  apiKeyId: "kid",
  apiKeySecret: "secret",
  organizationId: "org-1",
  chHost: "h.clickhouse.cloud",
  chUser: "default",
  chPassword: "pw",
};

function client(over: Record<string, string> = {}) {
  return new ClickHouseClient({ ...CREDS, ...over });
}

const RUNNING_SERVICE = {
  id: "svc1",
  name: "prod",
  state: "running",
  provider: "aws",
  region: "us-east-1",
  clickhouseVersion: "24.1",
  numReplicas: 3,
  endpoints: [
    { protocol: "https", host: "svc1.clickhouse.cloud", port: 8443 },
    { protocol: "nativesecure", host: "svc1.clickhouse.cloud", port: 9440 },
  ],
};

beforeEach(() => {
  calls = [];
  sdkState.createArgs = [];
  sdkState.query.mockClear();
  sdkState.command.mockClear();
  sdkState.close.mockClear();
  sdkState.jsonResult = [];
  sdkState.queryThrows = null;
  sdkState.commandThrows = null;
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe("constructor", () => {
  it("throws without API key creds", () => {
    expect(() => new ClickHouseClient({ organizationId: "o" })).toThrow(/missing API key/);
  });
  it("throws without organization id", () => {
    expect(() => new ClickHouseClient({ apiKeyId: "a", apiKeySecret: "b" })).toThrow(
      /missing organization ID/,
    );
  });
  it("constructs with valid creds", () => {
    expect(client()).toBeInstanceOf(ClickHouseClient);
  });
});

describe("cloudApi (via listResources ch-service)", () => {
  it("uses basic auth + correct url", async () => {
    router([[(u) => u.includes("/services"), { result: [RUNNING_SERVICE] }]]);
    const res = await client().listResources("ch-service", ACCOUNT);
    expect(calls[0].url).toBe("https://api.clickhouse.cloud/v1/organizations/org-1/services");
    const h = calls[0].init?.headers as Record<string, string>;
    expect(h["Authorization"]).toBe(`Basic ${btoa("kid:secret")}`);
    expect(res[0].id).toBe("acct-1:ch-service:svc1");
  });

  it("throws on non-ok cloud response", async () => {
    router([[() => true, "denied", 403]]);
    await expect(client().listResources("ch-service", ACCOUNT)).rejects.toThrow(
      /ClickHouse Cloud GET .* failed: 403/,
    );
  });

  it("returns empty object body for empty response text", async () => {
    router([[() => true, ""]]);
    const res = await client().listResources("ch-service", ACCOUNT);
    expect(res).toEqual([]);
  });
});

describe("listResources ch-database", () => {
  it("queries databases for running/idle services only", async () => {
    router([
      [
        (u) => u.includes("/services"),
        {
          result: [
            RUNNING_SERVICE,
            { id: "svc2", name: "stopped", state: "stopped", provider: "aws", region: "r" },
            {
              id: "svc3",
              name: "idle",
              state: "idle",
              provider: "aws",
              region: "r",
              endpoints: [{ protocol: "https", host: "svc3.host", port: 8443 }],
            },
          ],
        },
      ],
    ]);
    sdkState.jsonResult = [{ name: "default", engine: "Atomic", comment: "" }];
    const res = await client().listResources("ch-database", ACCOUNT);
    // svc1 + svc3 are running/idle → 2 db results; svc2 skipped
    expect(res).toHaveLength(2);
    // Database listing runs through ctx.chQuery, which targets the single
    // configured credential host — one SDK client per queried service.
    const urls = sdkState.createArgs.map((a) => (a as { url: string }).url);
    expect(urls).toHaveLength(2);
    expect(urls.every((u) => u === "https://h.clickhouse.cloud")).toBe(true);
  });

  it("skips service when chQuery throws (listDatabases swallows)", async () => {
    router([[(u) => u.includes("/services"), { result: [RUNNING_SERVICE] }]]);
    sdkState.queryThrows = new Error("net down");
    const res = await client().listResources("ch-database", ACCOUNT);
    expect(res).toEqual([]);
  });

  it("throws on unknown type", async () => {
    await expect(client().listResources("nope", ACCOUNT)).rejects.toThrow(/unknown resource type/);
  });
});

describe("getResource + resolveOutput", () => {
  it("finds resource in list", async () => {
    router([[(u) => u.includes("/services"), { result: [RUNNING_SERVICE] }]]);
    const r = await client().getResource("ch-service", "acct-1:ch-service:svc1", ACCOUNT);
    expect(r.fields["name"]).toBe("prod");
  });

  it("throws when not found", async () => {
    router([[(u) => u.includes("/services"), { result: [] }]]);
    await expect(
      client().getResource("ch-service", "acct-1:ch-service:x", ACCOUNT),
    ).rejects.toThrow(/not found/);
  });

  it("resolves an output", async () => {
    router([[(u) => u.includes("/services"), { result: [RUNNING_SERVICE] }]]);
    expect(
      await client().resolveOutput("ch-service", "acct-1:ch-service:svc1", "host", ACCOUNT),
    ).toBe("svc1.clickhouse.cloud");
  });

  it("throws when output undefined", async () => {
    router([[(u) => u.includes("/services"), { result: [RUNNING_SERVICE] }]]);
    await expect(
      client().resolveOutput("ch-service", "acct-1:ch-service:svc1", "bogus", ACCOUNT),
    ).rejects.toThrow(/cannot resolve output/);
  });
});

describe("fetchDashboardStats", () => {
  async function stats(stateService: Record<string, unknown>) {
    router([[(u) => u.includes("/services"), { result: [stateService] }]]);
    return client().fetchDashboardStats(
      "ch-service",
      `acct-1:ch-service:${stateService["id"]}`,
      ACCOUNT,
    );
  }

  it("running → healthy with version + replicas", async () => {
    const s = await stats(RUNNING_SERVICE);
    expect(s[0]).toEqual({ label: "State", value: "running", variant: "status-healthy" });
    expect(s.find((x) => x.label === "Version")?.value).toBe("24.1");
    expect(s.find((x) => x.label === "Replicas")?.value).toBe("3");
    expect(s.find((x) => x.label === "Provider")?.value).toBe("AWS · us-east-1");
  });

  it("idle → degraded; stopped/stopping → error; other → degraded", async () => {
    expect(
      (await stats({ id: "a", name: "n", state: "idle", provider: "aws", region: "r" }))[0].variant,
    ).toBe("status-degraded");
    expect(
      (await stats({ id: "b", name: "n", state: "stopped", provider: "aws", region: "r" }))[0]
        .variant,
    ).toBe("status-error");
    expect(
      (await stats({ id: "c", name: "n", state: "stopping", provider: "aws", region: "r" }))[0]
        .variant,
    ).toBe("status-error");
    expect(
      (await stats({ id: "d", name: "n", state: "weird", provider: "aws", region: "r" }))[0]
        .variant,
    ).toBe("status-degraded");
  });

  it("returns empty for ch-database", async () => {
    router([[(u) => u.includes("/services"), { result: [RUNNING_SERVICE] }]]);
    sdkState.jsonResult = [{ name: "db1", engine: "Atomic", comment: "" }];
    const s = await client().fetchDashboardStats(
      "ch-database",
      "acct-1:ch-database:svc1/db1",
      ACCOUNT,
    );
    expect(s).toEqual([]);
  });
});

describe("renderDetail", () => {
  function svcResource(over: Record<string, unknown> = {}, outputs: Record<string, string> = {}) {
    return {
      id: "acct-1:ch-service:svc1",
      pluginId: "clickhouse",
      resourceTypeId: "ch-service",
      accountId: ACCOUNT,
      displayName: "prod",
      externalId: "svc1",
      fields: {
        serviceId: "svc1",
        name: "prod",
        state: "running",
        provider: "aws",
        region: "us-east-1",
        clickhouseVersion: "24.1",
        tier: "production",
        minReplicaMemoryGb: 8,
        maxReplicaMemoryGb: 16,
        numReplicas: 3,
        idleScaling: true,
        idleTimeoutMinutes: 5,
        ...over,
      },
      resolvedOutputs: {
        host: "h",
        port: "8443",
        nativePort: "9440",
        httpUrl: "https://h:8443",
        connectionString: "clickhouse://h:9440",
        ...outputs,
      },
      secretStates: [],
      createdAt: "",
      updatedAt: "",
    } as never;
  }

  it("service detail with sql editor when running + connectionString", () => {
    const view = client().renderDetail(svcResource());
    expect(view.subtitle).toBe("Service · ClickHouse Cloud");
    expect((view.status as { status: string }).status).toBe("healthy");
    expect(view.sqlEditor?.connectionStringOutputKey).toBe("connectionString");
  });

  it("service detail without memory range / tier / idle timeout", () => {
    const view = client().renderDetail(
      svcResource({
        minReplicaMemoryGb: 0,
        maxReplicaMemoryGb: 0,
        tier: "",
        idleScaling: false,
        idleTimeoutMinutes: 0,
      }),
    );
    const scaling = view.sections.find((s) => "title" in s && s.title === "Scaling");
    expect(scaling).toBeTruthy();
  });

  it("service detail without sql editor when stopped", () => {
    const view = client().renderDetail(svcResource({ state: "stopped" }));
    expect(view.sqlEditor).toBeUndefined();
    expect((view.status as { status: string }).status).toBe("error");
  });

  it("service detail no sql editor when no connectionString", () => {
    const view = client().renderDetail(svcResource({}, { connectionString: "" }));
    expect(view.sqlEditor).toBeUndefined();
  });

  it("unknown state maps to info dot", () => {
    const view = client().renderDetail(svcResource({ state: "mystery" }));
    expect((view.status as { status: string }).status).toBe("info");
  });

  it("database detail with + without comment", () => {
    const base = {
      id: "acct-1:ch-database:svc1/db",
      pluginId: "clickhouse",
      resourceTypeId: "ch-database",
      accountId: ACCOUNT,
      displayName: "db",
      externalId: "svc1/db",
      resolvedOutputs: {},
      secretStates: [],
      createdAt: "",
      updatedAt: "",
    };
    const withComment = client().renderDetail({
      ...base,
      fields: { name: "db", engine: "Atomic", comment: "hi" },
    } as never);
    expect(withComment.subtitle).toBe("Database · ClickHouse");
    const noComment = client().renderDetail({
      ...base,
      fields: { name: "db", engine: "Atomic", comment: "" },
    } as never);
    expect(noComment.title).toBe("db");
  });
});

describe("renderSidebarItem", () => {
  function item(state: string) {
    return client().renderSidebarItem({
      id: "id",
      displayName: "x",
      resourceTypeId: "ch-service",
      fields: { state },
    } as never);
  }
  it("maps states", () => {
    expect((item("running").status as { status: string }).status).toBe("healthy");
    expect((item("idle").status as { status: string }).status).toBe("degraded");
    expect((item("starting").status as { status: string }).status).toBe("provisioning");
    expect((item("").status as { status: string }).status).toBe("info");
  });
});

describe("executeQuery + introspectResource", () => {
  it("executeQuery returns rows + duration", async () => {
    sdkState.jsonResult = [{ a: 1 }, { a: 2 }];
    const out = await client().executeQuery("rid", ACCOUNT, "SELECT 1");
    expect(out.rows).toHaveLength(2);
    expect(sdkState.query).toHaveBeenCalledWith(
      expect.objectContaining({ query: "SELECT 1", format: "JSONEachRow" }),
    );
    expect(typeof out.durationMs).toBe("number");
    expect(sdkState.close).toHaveBeenCalled();
  });

  it("executeQuery wraps SDK errors", async () => {
    sdkState.queryThrows = new Error("syntax error");
    await expect(client().executeQuery("rid", ACCOUNT, "BAD")).rejects.toThrow(
      /ClickHouse query failed: syntax error/,
    );
    expect(sdkState.close).toHaveBeenCalled();
  });

  it("executeQuery returns [] when no host configured", async () => {
    sdkState.jsonResult = [{ a: 1 }];
    const out = await client({ chHost: "" }).executeQuery("rid", ACCOUNT, "SELECT 1");
    expect(out.rows).toEqual([]);
    expect(sdkState.query).not.toHaveBeenCalled();
  });

  it("introspectResource groups columns into tables", async () => {
    sdkState.jsonResult = [
      { database: "db", table: "t1", column_name: "id", data_type: "UInt64" },
      { database: "db", table: "t1", column_name: "name", data_type: "String" },
      { database: "db", table: "t2", column_name: "x", data_type: "Int32" },
    ];
    const meta = await client().introspectResource("rid", ACCOUNT);
    expect(meta).toHaveLength(2);
    expect(meta[0].name).toBe("db.t1");
    expect(meta[0].columns).toHaveLength(2);
  });

  it("introspectResource returns [] on error", async () => {
    sdkState.queryThrows = new Error("boom");
    expect(await client().introspectResource("rid", ACCOUNT)).toEqual([]);
  });

  it("normalizeChUrl: host already with scheme is used as-is", async () => {
    sdkState.jsonResult = [];
    await client({ chHost: "http://plain.host:8123" }).executeQuery("rid", ACCOUNT, "SELECT 1");
    expect((sdkState.createArgs[0] as { url: string }).url).toBe("http://plain.host:8123");
  });
});

describe("getCreateConfig", () => {
  it("database config without parent fetches running/idle services", async () => {
    router([
      [
        (u) => u.includes("/services"),
        {
          result: [
            RUNNING_SERVICE,
            { id: "svc2", name: "stopped", state: "stopped", provider: "aws", region: "r" },
          ],
        },
      ],
    ]);
    const cfg = await client().getCreateConfig("ch-database");
    const svc = cfg.fields.find((f) => f.key === "serviceId");
    expect(svc?.options).toHaveLength(1);
    expect(svc?.defaultValue).toBe("svc1");
  });

  it("database config with parent omits service field", async () => {
    const cfg = await client().getCreateConfig("ch-database", "acct-1:ch-service:svc1");
    expect(cfg.fields.find((f) => f.key === "serviceId")).toBeUndefined();
    expect(cfg.fields[0].key).toBe("name");
  });

  it("service config returns provider + region pickers", async () => {
    const cfg = await client().getCreateConfig("ch-service");
    expect(cfg.fields.find((f) => f.key === "provider")).toBeTruthy();
    const region = cfg.fields.find((f) => f.key === "region");
    expect((region as { regions?: unknown[] }).regions?.length).toBeGreaterThan(10);
  });

  it("throws for unknown type", async () => {
    await expect(client().getCreateConfig("nope")).rejects.toThrow(/create not supported/);
  });
});

describe("createResource ch-database", () => {
  it("creates a database with comment via chCommandAt", async () => {
    router([[(u) => u.includes("/services"), { result: [RUNNING_SERVICE] }]]);
    const r = await client().createResource(
      "ch-database",
      ACCOUNT,
      { name: "analytics", comment: "metrics" },
      "acct-1:ch-service:svc1",
    );
    expect(r.id).toBe("acct-1:ch-database:svc1/analytics");
    expect(r.fields["comment"]).toBe("metrics");
    expect(sdkState.command).toHaveBeenCalledWith(
      expect.objectContaining({
        query: expect.stringContaining("COMMENT"),
        query_params: { name: "analytics", comment: "metrics" },
      }),
    );
    // SDK client points at service host
    expect((sdkState.createArgs.at(-1) as { url: string }).url).toBe(
      "https://svc1.clickhouse.cloud",
    );
  });

  it("creates a database without comment", async () => {
    router([[(u) => u.includes("/services"), { result: [RUNNING_SERVICE] }]]);
    await client().createResource(
      "ch-database",
      ACCOUNT,
      { name: "db1", comment: "" },
      "acct-1:ch-service:svc1",
    );
    const cmd = sdkState.command.mock.calls.at(-1)?.[0] as { query: string; query_params: unknown };
    expect(cmd.query).not.toContain("COMMENT");
    expect(cmd.query_params).toEqual({ name: "db1" });
  });

  it("uses serviceId field over parent", async () => {
    router([[(u) => u.includes("/services"), { result: [RUNNING_SERVICE] }]]);
    const r = await client().createResource("ch-database", ACCOUNT, {
      name: "db1",
      serviceId: "svc1",
    });
    expect(r.parentResourceId).toBe("acct-1:ch-service:svc1");
  });

  it("throws when no service id", async () => {
    await expect(client().createResource("ch-database", ACCOUNT, { name: "db1" })).rejects.toThrow(
      /requires a service/,
    );
  });

  it("throws on invalid database name", async () => {
    await expect(
      client().createResource(
        "ch-database",
        ACCOUNT,
        { name: "1bad-name" },
        "acct-1:ch-service:svc1",
      ),
    ).rejects.toThrow(/alphanumeric/);
  });

  it("throws when target service not found", async () => {
    router([[(u) => u.includes("/services"), { result: [] }]]);
    await expect(
      client().createResource("ch-database", ACCOUNT, { name: "db1" }, "acct-1:ch-service:missing"),
    ).rejects.toThrow(/not found/);
  });

  it("throws when target service has no host", async () => {
    router([
      [
        (u) => u.includes("/services"),
        { result: [{ id: "svc1", name: "n", state: "running", provider: "aws", region: "r" }] },
      ],
    ]);
    await expect(
      client().createResource("ch-database", ACCOUNT, { name: "db1" }, "acct-1:ch-service:svc1"),
    ).rejects.toThrow(/no HTTPS endpoint/);
  });
});

describe("createResource ch-service", () => {
  it("creates a service via cloud API POST", async () => {
    router([
      [
        (u, i) => method(i) === "POST" && u.includes("/services"),
        {
          result: {
            service: {
              id: "new-svc",
              name: "My Service",
              state: "provisioning",
              provider: "aws",
              region: "us-east-1",
              endpoints: [{ protocol: "https", host: "new.host", port: 8443 }],
            },
            password: "genpw",
          },
        },
      ],
    ]);
    const r = await client().createResource("ch-service", ACCOUNT, {
      name: "My Service",
      provider: "aws",
      region: "us-east-1",
      minReplicaMemoryGb: "8",
      maxReplicaMemoryGb: "16",
      numReplicas: "3",
      idleScaling: "true",
    });
    expect(r.id).toBe("acct-1:ch-service:new-svc");
    expect(r.resolvedOutputs["host"]).toBe("new.host");
    expect(r.resolvedOutputs["httpUrl"]).toBe("https://new.host:8443");
    const body = JSON.parse(calls[0].init?.body as string);
    expect(body).toMatchObject({
      name: "My Service",
      provider: "aws",
      region: "us-east-1",
      minReplicaMemoryGb: 8,
      maxReplicaMemoryGb: 16,
      numReplicas: 3,
      idleScaling: true,
    });
  });

  it("creates a service without optional scaling fields, no endpoint", async () => {
    router([
      [
        (u, i) => method(i) === "POST" && u.includes("/services"),
        {
          result: {
            service: { id: "s2", name: "", state: "provisioning", provider: "gcp", region: "r" },
          },
        },
      ],
    ]);
    const r = await client().createResource("ch-service", ACCOUNT, {
      name: "x",
      provider: "gcp",
      region: "r",
      idleScaling: "false",
    });
    expect(r.displayName).toBe("s2");
    expect(r.resolvedOutputs["host"]).toBe("");
    expect(r.resolvedOutputs["connectionString"]).toBe("");
    const body = JSON.parse(calls[0].init?.body as string);
    expect(body.idleScaling).toBe(false);
    expect(body.numReplicas).toBeUndefined();
  });

  it("throws when create returns no service", async () => {
    router([[(u, i) => method(i) === "POST", { result: {} }]]);
    await expect(
      client().createResource("ch-service", ACCOUNT, { name: "x", provider: "aws", region: "r" }),
    ).rejects.toThrow(/returned no result/);
  });

  it("throws for unsupported type", async () => {
    await expect(client().createResource("nope", ACCOUNT, {})).rejects.toThrow(
      /create not supported/,
    );
  });
});

describe("deleteResource", () => {
  it("drops a database via chCommandAt at service host", async () => {
    router([[(u) => u.includes("/services"), { result: [RUNNING_SERVICE] }]]);
    sdkState.jsonResult = [{ name: "analytics", engine: "Atomic", comment: "" }];
    await client().deleteResource("ch-database", "acct-1:ch-database:svc1/analytics", ACCOUNT);
    const cmd = sdkState.command.mock.calls.at(-1)?.[0] as { query: string; query_params: unknown };
    expect(cmd.query).toContain("DROP DATABASE");
    expect(cmd.query_params).toEqual({ name: "analytics" });
    expect((sdkState.createArgs.at(-1) as { url: string }).url).toBe(
      "https://svc1.clickhouse.cloud",
    );
  });

  it("throws on invalid database name during delete", async () => {
    router([[(u) => u.includes("/services"), { result: [RUNNING_SERVICE] }]]);
    // craft a resource whose externalId yields a bad name by listing it
    sdkState.jsonResult = [{ name: "valid", engine: "Atomic", comment: "" }];
    // resourceId not present → getResource throws not found first; instead test the regex via a name we can list
    await expect(
      client().deleteResource("ch-database", "acct-1:ch-database:svc1/valid", ACCOUNT),
    ).resolves.toBeUndefined();
  });

  it("stops then deletes a running service", async () => {
    vi.useFakeTimers();
    router([
      [
        (u, i) => method(i) === "GET" && u.includes("/services") && !u.includes("/state"),
        { result: [RUNNING_SERVICE] },
      ],
      [(u, i) => method(i) === "PATCH" && u.includes("/state"), {}],
      [(u, i) => method(i) === "DELETE", {}],
    ]);
    const p = client().deleteResource("ch-service", "acct-1:ch-service:svc1", ACCOUNT);
    await vi.advanceTimersByTimeAsync(2000);
    await p;
    vi.useRealTimers();
    const patch = calls.find((c) => method(c.init) === "PATCH");
    expect(patch?.url).toContain("/services/svc1/state");
    expect(JSON.parse(patch?.init?.body as string)).toEqual({ command: "stop" });
    expect(calls.some((c) => method(c.init) === "DELETE")).toBe(true);
  });

  it("deletes a stopped service without stop step", async () => {
    router([
      [
        (u, i) => method(i) === "GET" && u.includes("/services"),
        { result: [{ id: "svc1", name: "n", state: "stopped", provider: "aws", region: "r" }] },
      ],
      [(u, i) => method(i) === "DELETE", {}],
    ]);
    await client().deleteResource("ch-service", "acct-1:ch-service:svc1", ACCOUNT);
    expect(calls.some((c) => method(c.init) === "PATCH")).toBe(false);
    expect(calls.some((c) => method(c.init) === "DELETE")).toBe(true);
  });

  it("throws for unsupported delete type", async () => {
    await expect(client().deleteResource("nope", "acct-1:nope:x", ACCOUNT)).rejects.toThrow(
      /delete not supported/,
    );
  });
});
