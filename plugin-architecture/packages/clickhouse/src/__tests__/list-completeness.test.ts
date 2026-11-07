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
