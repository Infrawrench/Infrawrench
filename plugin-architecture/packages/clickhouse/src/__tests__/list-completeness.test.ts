/**
 * A sync soft-deletes whatever a list stops returning, so these drive the real client
 * through a stubbed transport and check that only a read that saw everything prunes.
 */
import { hostClient } from "@infrawrench/plugin-base/effect";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const sdk = vi.hoisted(() => ({
  urls: [] as string[],
  rows: [] as Record<string, unknown>[],
  queryError: null as Error | null,
}));

vi.mock("@clickhouse/client-web", () => ({
  createClient: (args: { url: string }) => ({
    query: async () => {
      sdk.urls.push(args.url);
      if (sdk.queryError) throw sdk.queryError;
      return { json: async () => sdk.rows };
    },
    command: async () => undefined,
    close: async () => undefined,
  }),
}));

import { ClickHouseClient } from "../client.js";

const ACCOUNT = "acct-1";
const ORG = "/v1/organizations/org-1";
const UNREAD_HOOK = Symbol.for("infrawrench.unreadListPart");

type Answer = { status?: number; body?: unknown };
let requests: string[] = [];

/** Answers only what a test names; anything else fails it rather than leaving the process. */
function serve(routes: Record<string, Answer | ((path: string) => Answer)>): void {
  vi.stubGlobal("fetch", async (url: string) => {
    const path = String(url).replace("https://api.clickhouse.cloud", "");
    requests.push(path);
    const route = routes[path] ?? routes[path.split("?")[0] ?? ""];
    if (!route) throw new Error(`unexpected request: ${path}`);
    const { status = 200, body } = typeof route === "function" ? route(path) : route;
    const text = typeof body === "string" ? body : JSON.stringify(body);
    return new Response(text, { status });
  });
}

function client(over: Record<string, string> = {}) {
  return hostClient(
    new ClickHouseClient({
      apiKeyId: "kid",
      apiKeySecret: "secret",
      organizationId: "org-1",
      chHost: "svc1.clickhouse.cloud",
      chUser: "default",
      chPassword: "pw",
      ...over,
    }),
  );
}

/** Records what a list reports unread, through the global hook the host installs. */
async function inListScope<T>(fn: () => Promise<T>): Promise<{ value: T; unread: unknown[] }> {
  const unread: unknown[] = [];
  Reflect.set(globalThis, UNREAD_HOOK, (part: unknown) => unread.push(part));
  try {
    return { value: await fn(), unread };
  } finally {
    Reflect.deleteProperty(globalThis, UNREAD_HOOK);
  }
}

function service(id: string, state = "running") {
  return {
    id,
    name: id,
    state,
    provider: "aws",
    region: "us-east-1",
    endpoints: [{ protocol: "https", host: `${id}.clickhouse.cloud`, port: 8443 }],
  };
}

beforeEach(async () => {
  requests = [];
  sdk.urls = [];
  sdk.rows = [];
  sdk.queryError = null;
  const { Socket } = await vi.importActual<{
    Socket: { prototype: { connect: () => void } };
  }>("node:net");
  vi.spyOn(Socket.prototype, "connect").mockImplementation(() => {
    throw new Error("a socket must not be opened");
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("pages", () => {
  it("follows the API key list's cursor to its last page", async () => {
    serve({
      [`${ORG}/keys`]: (path) =>
        path.includes("cursor=")
          ? { body: { result: [{ id: "k2" }], nextCursor: null } }
          : { body: { result: [{ id: "k1" }], nextCursor: "a/b+c" } },
    });
    const keys = await client().listResources("ch-api-key", ACCOUNT);
    expect(keys.map((k) => k.externalId)).toEqual(["k1", "k2"]);
    expect(requests).toEqual([`${ORG}/keys`, `${ORG}/keys?cursor=a%2Fb%2Bc`]);
  });

  it("throws, after exactly its cap, on a list that never ends", async () => {
    serve({ [`${ORG}/keys`]: { body: { result: [{ id: "k" }], nextCursor: "more" } } });
    await expect(client().listResources("ch-api-key", ACCOUNT)).rejects.toThrow(
      "has more than Infrawrench reads",
    );
    expect(requests).toHaveLength(1000);
  });

  it("refuses a later page with its key renamed", async () => {
    serve({
      [`${ORG}/keys`]: (path) =>
        path.includes("cursor=")
          ? { body: { items: [] } }
          : { body: { result: [{ id: "k1" }], nextCursor: "n" } },
    });
    await expect(client().listResources("ch-api-key", ACCOUNT)).rejects.toThrow("is not a list");
  });

  it.each([
    ["ch-service", `${ORG}/services`],
    ["ch-api-key", `${ORG}/keys`],
    ["ch-member", `${ORG}/members`],
    ["ch-postgres", `${ORG}/postgres`],
  ])("refuses a %s page with its key renamed", async (typeId, path) => {
    serve({ [path]: { body: { items: [] } } });
    await expect(client().listResources(typeId, ACCOUNT)).rejects.toThrow("is not a list");
  });

  it("reads a null list as empty, which is how an empty one can be written", async () => {
    serve({ [`${ORG}/members`]: { body: { result: null } } });
    expect(await client().listResources("ch-member", ACCOUNT)).toEqual([]);
  });
});

describe("usage costs", () => {
  const range = { fromDate: "2026-10-01", toDate: "2026-10-31" };
  const path = `${ORG}/usageCost`;

  it("reads the rows", async () => {
    serve({
      [path]: {
        body: {
          result: {
            grandTotalCHC: 2,
            costs: [{ date: "2026-10-01", entityId: "e", metrics: { computeCHC: 2 } }],
          },
        },
      },
    });
    const rows = await client().fetchCostData(ACCOUNT, range);
    expect(rows).toEqual([
      { date: "2026-10-01", service: "Compute", resourceId: "e", currency: "USD", amount: 2 },
    ]);
  });

  it("refuses an answer with no report in it, which would read as no spend", async () => {
    serve({ [path]: { body: {} } });
    await expect(client().fetchCostData(ACCOUNT, range)).rejects.toThrow("is not a list");
  });

  it("refuses a total with no records behind it", async () => {
    serve({ [path]: { body: { result: { grandTotalCHC: 12 } } } });
    await expect(client().fetchCostData(ACCOUNT, range)).rejects.toThrow("is not a list");
  });

  it("reads a zero total with no records as no spend, since the document does not require them", async () => {
    serve({ [path]: { body: { result: { grandTotalCHC: 0 } } } });
    expect(await client().fetchCostData(ACCOUNT, range)).toEqual([]);
  });
});

describe("backups and ClickPipes, per service", () => {
  const services = { [`${ORG}/services`]: { body: { result: [service("a"), service("b")] } } };
  const svc = (id: string) => `acct-1:ch-service:${id}`;
  const pipes = (id: string) => `${ORG}/services/${id}/clickpipes`;
  const backups = (id: string) => `${ORG}/services/${id}/backups`;

  it.each([
    ["ch-backup", backups],
    ["ch-clickpipe", pipes],
  ])("%s fails the type on a throttle, a 5xx or a rejected key", async (typeId, path) => {
    for (const status of [429, 500, 401]) {
      serve({
        ...services,
        [path("a")]: { body: { result: [{ id: "x" }] } },
        [path("b")]: { status, body: "no" },
      });
      await expect(client().listResources(typeId, ACCOUNT)).rejects.toThrow(`failed: ${status}`);
    }
  });

  it.each([
    ["ch-backup", backups],
    ["ch-clickpipe", pipes],
  ])("%s refuses a page with its key renamed", async (typeId, path) => {
    serve({
      ...services,
      [path("a")]: { body: { result: [] } },
      [path("b")]: { body: { items: [] } },
    });
    await expect(client().listResources(typeId, ACCOUNT)).rejects.toThrow("is not a list");
  });

  it("carries the status on the error, for the hosts' backoff", async () => {
    serve({
      ...services,
      [pipes("a")]: { status: 429, body: "slow" },
      [pipes("b")]: { body: { result: [] } },
    });
    const failure: unknown = await client()
      .listResources("ch-clickpipe", ACCOUNT)
      .catch((err: unknown) => err);
    expect(failure).toMatchObject({ status: 429 });
  });

  it.each([403, 400])("keeps one service's rows, and only its rows, on a %i", async (status) => {
    serve({
      ...services,
      [pipes("a")]: { body: { result: [{ id: "p" }] } },
      [pipes("b")]: { status, body: "no" },
    });
    const { value, unread } = await inListScope(() =>
      client().listResources("ch-clickpipe", ACCOUNT),
    );
    expect(value.map((r) => r.externalId)).toEqual(["a/p"]);
    expect(unread).toEqual([{ parentResourceIds: [svc("b")] }]);
  });

  it("keeps every service's rows, without an error, when a key may not read any", async () => {
    serve({
      ...services,
      [pipes("a")]: { status: 403, body: "no" },
      [pipes("b")]: { status: 403, body: "no" },
    });
    const { value, unread } = await inListScope(() =>
      client().listResources("ch-clickpipe", ACCOUNT),
    );
    expect(value).toEqual([]);
    expect(unread).toEqual([{ parentResourceIds: [svc("a"), svc("b")] }]);
  });

  it("shows one service's refusal where the host keeps no track", async () => {
    serve({
      ...services,
      [pipes("a")]: { body: { result: [{ id: "p" }] } },
      [pipes("b")]: { status: 403, body: "no" },
    });
    await expect(client().listResources("ch-clickpipe", ACCOUNT)).rejects.toThrow("failed: 403");
  });

  it("reads a service that has gone, mid-deletion, as having none", async () => {
    serve({
      ...services,
      [backups("a")]: { body: { result: [] } },
      [backups("b")]: { status: 404, body: "gone" },
    });
    const { value, unread } = await inListScope(() => client().listResources("ch-backup", ACCOUNT));
    expect(value).toEqual([]);
    expect(unread).toEqual([]);
  });

  it("says a row is refused, not missing, when asked for one directly", async () => {
    serve({
      ...services,
      [pipes("a")]: { status: 403, body: "no" },
      [pipes("b")]: { body: { result: [] } },
    });
    await expect(
      client().getResource("ch-clickpipe", "acct-1:ch-clickpipe:a/p", ACCOUNT),
    ).rejects.toThrow("failed: 403");
  });
});

describe("a credential refused a whole type", () => {
  it.each([
    ["ch-service", `${ORG}/services`],
    ["ch-database", `${ORG}/services`],
    ["ch-backup", `${ORG}/services`],
    ["ch-clickpipe", `${ORG}/services`],
    ["ch-api-key", `${ORG}/keys`],
    ["ch-member", `${ORG}/members`],
    ["ch-postgres", `${ORG}/postgres`],
  ])("%s keeps its rows without an error on a 403", async (typeId, path) => {
    serve({ [path]: { status: 403, body: "no" } });
    const { value, unread } = await inListScope(() => client().listResources(typeId, ACCOUNT));
    expect(value).toEqual([]);
    expect(unread).toEqual([{ idPrefixes: [""] }]);
  });

  it("shows a refused type where the host keeps no track", async () => {
    serve({ [`${ORG}/keys`]: { status: 403, body: "no" } });
    await expect(client().listResources("ch-api-key", ACCOUNT)).rejects.toThrow("failed: 403");
  });

  it("fails on a key the provider rejects outright", async () => {
    serve({ [`${ORG}/keys`]: { status: 401, body: "bad key" } });
    await expect(client().listResources("ch-api-key", ACCOUNT)).rejects.toThrow("failed: 401");
  });

  it("does not call a row not found when the list was refused", async () => {
    serve({ [`${ORG}/keys`]: { status: 403, body: "no" } });
    await expect(
      client().getResource("ch-api-key", "acct-1:ch-api-key:k", ACCOUNT),
    ).rejects.toThrow("failed: 403");
  });
});

describe("databases", () => {
  const list = (...services: unknown[]) => ({
    [`${ORG}/services`]: { body: { result: services } },
  });
  const SQL_URL = "https://svc1.clickhouse.cloud:8443";

  beforeEach(() => {
    sdk.rows = [{ name: "default", engine: "Atomic", comment: "" }];
  });

  it("files them under the service the SQL connection reaches, and no other", async () => {
    serve(list(service("svc1"), service("svc2")));
    const { value, unread } = await inListScope(() =>
      client().listResources("ch-database", ACCOUNT),
    );
    expect(value.map((r) => r.externalId)).toEqual(["svc1/default"]);
    expect(unread).toEqual([]);
    expect(sdk.urls).toEqual([SQL_URL]);
  });

  it("finds that service however the host was typed", async () => {
    serve(list(service("svc1"), service("svc2")));
    const c = client({ chHost: "https://SVC1.clickhouse.cloud:8443/" });
    const rows = await c.listResources("ch-database", ACCOUNT);
    expect(rows.map((r) => r.externalId)).toEqual(["svc1/default"]);
  });

  it("files them under every service when the host is on none, as a private endpoint is", async () => {
    serve(list(service("svc1"), service("svc2")));
    const c = client({ chHost: "abc.vpce.clickhouse.cloud" });
    const rows = await c.listResources("ch-database", ACCOUNT);
    expect(rows.map((r) => r.externalId)).toEqual(["svc1/default", "svc2/default"]);
  });

  it("fails on a failed read of a running service, so its rows stay", async () => {
    serve(list(service("svc1")));
    sdk.queryError = new Error("Timeout error.");
    await expect(client().listResources("ch-database", ACCOUNT)).rejects.toThrow(
      "ClickHouse query failed: Timeout error.",
    );
  });

  it("fails on SQL credentials the service rejects", async () => {
    serve(list(service("svc1")));
    sdk.queryError = Object.assign(new Error("Authentication failed"), {
      code: "516",
      type: "AUTHENTICATION_FAILED",
    });
    await expect(client().listResources("ch-database", ACCOUNT)).rejects.toThrow(
      "Authentication failed",
    );
  });

  it("keeps the service's rows without an error when the SQL user may not read them", async () => {
    serve(list(service("svc1")));
    sdk.queryError = Object.assign(new Error("Not enough privileges"), {
      code: "497",
      type: "ACCESS_DENIED",
    });
    const { value, unread } = await inListScope(() =>
      client().listResources("ch-database", ACCOUNT),
    );
    expect(value).toEqual([]);
    expect(unread).toEqual([{ parentResourceIds: ["acct-1:ch-service:svc1"] }]);
  });

  it("keeps a stopped service's rows, with no query, and without an error", async () => {
    serve(list(service("svc1", "stopped"), service("svc2")));
    const { value, unread } = await inListScope(() =>
      client().listResources("ch-database", ACCOUNT),
    );
    expect(value).toEqual([]);
    expect(unread).toEqual([{ parentResourceIds: ["acct-1:ch-service:svc1"] }]);
    expect(sdk.urls).toEqual([]);
  });

  it("does not wake an idle service to list it, and keeps its rows", async () => {
    serve(list(service("svc1", "idle")));
    const { value, unread } = await inListScope(() =>
      client().listResources("ch-database", ACCOUNT),
    );
    expect(value).toEqual([]);
    expect(unread).toEqual([{ parentResourceIds: ["acct-1:ch-service:svc1"] }]);
    expect(sdk.urls).toEqual([]);
  });

  it("keeps every row when there is no SQL connection to read them with", async () => {
    serve(list(service("svc1")));
    const { value, unread } = await inListScope(() =>
      client({ chHost: "" }).listResources("ch-database", ACCOUNT),
    );
    expect(value).toEqual([]);
    expect(unread).toEqual([{ idPrefixes: [""] }]);
  });
});

describe("a Postgres service whose details cannot be read", () => {
  const PG = { id: "pg1", name: "db", state: "running", size: "r8gd.large" };
  const list = { [`${ORG}/postgres`]: { body: { result: [PG] } } };

  it("leaves out what only the details supply, so the stored values stay", async () => {
    serve({ ...list, [`${ORG}/postgres/pg1`]: { status: 429, body: "slow" } });
    const [row] = await client().listResources("ch-postgres", ACCOUNT);
    expect(row!.fields).toMatchObject({ postgresId: "pg1", state: "running", size: "r8gd.large" });
    for (const key of ["hostname", "username", "storageSize"]) {
      expect(row!.fields).not.toHaveProperty(key);
    }
    expect(row!.resolvedOutputs).toEqual({ postgresId: "pg1" });
  });

  it("treats an answer with no service in it the same way", async () => {
    serve({ ...list, [`${ORG}/postgres/pg1`]: { body: {} } });
    const [row] = await client().listResources("ch-postgres", ACCOUNT);
    expect(row!.fields).not.toHaveProperty("hostname");
  });

  it("writes them when the details are read", async () => {
    serve({
      ...list,
      [`${ORG}/postgres/pg1`]: {
        body: { result: { ...PG, hostname: "pg.example", username: "u", storageSize: 100 } },
      },
    });
    const [row] = await client().listResources("ch-postgres", ACCOUNT);
    expect(row!.fields).toMatchObject({ hostname: "pg.example", username: "u", storageSize: 100 });
    expect(row!.resolvedOutputs).toMatchObject({ hostname: "pg.example", username: "u" });
  });
});
