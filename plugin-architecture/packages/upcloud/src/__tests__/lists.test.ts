import type { HostServices } from "@infrawrench/plugin-base";
import { hostClient } from "@infrawrench/plugin-base/effect";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createUpCloudApi } from "../api.js";
import { UpCloudClient } from "../client.js";
import { plugin } from "../plugin.js";

// This package has no Node types; the socket guard only needs `connect`.
const netModule = "node:net";
const net: { Socket: { prototype: { connect: () => unknown } } } = await import(netModule);

type Reply = { status?: number; body: unknown };

const UNREAD_HOOK = Symbol.for("infrawrench.unreadListPart");

beforeEach(() => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => {
      throw new Error("no network in tests");
    }),
  );
  vi.spyOn(net.Socket.prototype, "connect").mockImplementation(() => {
    throw new Error("no sockets in tests");
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  Reflect.deleteProperty(globalThis, UNREAD_HOOK);
});

function host(responder: (path: string, url: URL) => Reply | undefined) {
  const paths: string[] = [];
  const request = vi.fn(async (req: { url: string }) => {
    const url = new URL(req.url);
    const path = url.pathname.replace(/^\/1\.3/, "");
    paths.push(path + url.search);
    const res = responder(path, url);
    if (!res) throw new Error(`unexpected request ${req.url}`);
    return {
      status: res.status ?? 200,
      headers: {},
      body: typeof res.body === "string" ? res.body : JSON.stringify(res.body),
    };
  });
  const services: HostServices = { http: { request } };
  return { services, paths, request };
}

const client = (services: HostServices) =>
  hostClient(new UpCloudClient({ apiToken: "t" }, plugin.resourceTypes, services));

const problem = (status: number) => ({
  status,
  body: { type: "https://developers.upcloud.com/1.3/errors#ERROR_X", title: "nope", status },
});

describe("paged", () => {
  it("throws past its cap instead of returning the first 10,000", async () => {
    const { services, paths } = host(() => ({
      body: Array.from({ length: 100 }, (_, i) => ({ uuid: `d${i}` })),
    }));
    await expect(createUpCloudApi({ apiToken: "t", services }).paged("/database")).rejects.toThrow(
      "has more than Infrawrench reads",
    );
    expect(paths).toHaveLength(100);
  });

  it("refuses a page that is not a list, first or later", async () => {
    const first = host(() => ({ body: { databases: [] } }));
    await expect(
      createUpCloudApi({ apiToken: "t", services: first.services }).paged("/database"),
    ).rejects.toThrow("is not a list");

    const later = host((_p, url) =>
      url.searchParams.get("offset") === "0"
        ? { body: Array.from({ length: 100 }, (_, i) => ({ uuid: `d${i}` })) }
        : { body: { error: "x" } },
    );
    await expect(
      createUpCloudApi({ apiToken: "t", services: later.services }).paged("/database"),
    ).rejects.toThrow("is not a list");
  });

  it("takes a first page longer than the limit as the whole list", async () => {
    const { services, paths } = host(() => ({
      body: Array.from({ length: 140 }, (_, i) => ({ uuid: `u${i}` })),
    }));
    const all = await createUpCloudApi({ apiToken: "t", services }).paged("/x");
    expect(all).toHaveLength(140);
    expect(paths).toHaveLength(1);
  });
});

describe("legacy lists", () => {
  it("refuses an answer without its envelope", async () => {
    const { services } = host(() => ({ body: { error: { error_message: "x" } } }));
    await expect(client(services).listResources("router", "a")).rejects.toThrow("is not a list");
  });

  it("refuses an envelope whose inner key was renamed", async () => {
    const { services } = host(() => ({ body: { routers: { routerz: [{ uuid: "r1" }] } } }));
    await expect(client(services).listResources("router", "a")).rejects.toThrow("is not a list");
  });

  it("reads an empty envelope as none", async () => {
    const empty = host(() => ({ body: { routers: { router: [] } } }));
    expect(await client(empty.services).listResources("router", "a")).toEqual([]);
    const bare = host(() => ({ body: { routers: {} } }));
    expect(await client(bare.services).listResources("router", "a")).toEqual([]);
  });
});

const DBS = [
  { uuid: "db1", type: "pg" },
  { uuid: "db2", type: "mysql" },
];
const SERVICES = [{ uuid: "os1" }, { uuid: "os2" }];

const CHILD_TYPES = [
  {
    typeId: "database-user",
    parents: () => ({ body: DBS }),
    parentPath: "/database",
    childPath: (id: string) => `/database/${id}/users`,
    child: { username: "app" },
    parentId: "a:database:db2",
  },
  {
    typeId: "database-db",
    parents: () => ({ body: DBS }),
    parentPath: "/database",
    childPath: (id: string) => `/database/${id}/databases`,
    child: { name: "app" },
    parentId: "a:database:db2",
  },
  {
    typeId: "bucket",
    parents: () => ({ body: SERVICES }),
    parentPath: "/object-storage-2",
    childPath: (id: string) => `/object-storage-2/${id.replace("db", "os")}/buckets`,
    child: { name: "b" },
    parentId: "a:object-storage:os2",
  },
  {
    typeId: "object-storage-user",
    parents: () => ({ body: SERVICES }),
    parentPath: "/object-storage-2",
    childPath: (id: string) => `/object-storage-2/${id.replace("db", "os")}/users`,
    child: { username: "u" },
    parentId: "a:object-storage:os2",
  },
];

describe.each(CHILD_TYPES)("$typeId", (t) => {
  const responder =
    (second: Reply) =>
    (path: string): Reply | undefined => {
      if (path === t.parentPath) return t.parents();
      if (path === t.childPath("db1")) return { body: [t.child] };
      if (path === t.childPath("db2")) return second;
      return undefined;
    };

  it("fails the type when one parent's read fails, instead of reading it as none", async () => {
    for (const status of [500, 429, 401]) {
      const { services } = host(responder(problem(status)));
      await expect(client(services).listResources(t.typeId, "a")).rejects.toThrow(`${status}`);
    }
  });

  it("reads a parent that is gone as none", async () => {
    const { services } = host(responder(problem(404)));
    const rows = await client(services).listResources(t.typeId, "a");
    expect(rows).toHaveLength(1);
  });

  it("keeps the rows of a parent that refuses, where the host tracks them", async () => {
    const note = vi.fn();
    Reflect.set(globalThis, UNREAD_HOOK, note);
    const { services } = host(responder(problem(409)));
    const rows = await client(services).listResources(t.typeId, "a");
    expect(rows).toHaveLength(1);
    expect(note).toHaveBeenCalledWith({ parentResourceIds: [t.parentId] });
  });

  it("fails a refusal where the host keeps no track, rather than return part", async () => {
    for (const status of [403, 409]) {
      const { services } = host(responder(problem(status)));
      await expect(client(services).listResources(t.typeId, "a")).rejects.toThrow(`${status}`);
    }
  });

  it("refuses a child page that is not a list", async () => {
    const { services } = host(responder({ body: { error: "x" } }));
    await expect(client(services).listResources(t.typeId, "a")).rejects.toThrow("is not a list");
  });
});

describe("node groups", () => {
  const clusters = [
    { uuid: "k1", zone: "fi-hel1", node_groups: [{ name: "embedded" }] },
    { uuid: "k2", zone: "fi-hel1" },
  ];

  it("falls back to the embedded groups, and fails when there are none to fall back to", async () => {
    const withEmbedded = host((path) => {
      if (path === "/kubernetes") return { body: [clusters[0]] };
      if (path === "/kubernetes/k1/node-groups") return problem(500);
      return undefined;
    });
    const rows = await client(withEmbedded.services).listResources("node-group", "a");
    expect(rows.map((r) => r.displayName)).toEqual(["embedded"]);

    const without = host((path) => {
      if (path === "/kubernetes") return { body: [clusters[1]] };
      if (path === "/kubernetes/k2/node-groups") return problem(500);
      return undefined;
    });
    await expect(client(without.services).listResources("node-group", "a")).rejects.toThrow("500");
  });

  it("reads a cluster that is gone as none", async () => {
    const { services } = host((path) => {
      if (path === "/kubernetes") return { body: [clusters[1]] };
      if (path === "/kubernetes/k2/node-groups") return problem(404);
      return undefined;
    });
    expect(await client(services).listResources("node-group", "a")).toEqual([]);
  });

  it("refuses a cluster list that is not a list", async () => {
    const { services } = host(() => ({ body: { clusters: [] } }));
    await expect(client(services).listResources("kubernetes-cluster", "a")).rejects.toThrow(
      "is not a list",
    );
  });
});

describe("host transport", () => {
  it("sends every request through the host without a CA it was not given", async () => {
    const { services, request } = host(() => ({ body: { routers: { router: [] } } }));
    await client(services).listResources("router", "a");
    expect(request).toHaveBeenCalled();
    expect(request.mock.calls[0]![0]).not.toHaveProperty("caCert");
    expect(fetch).not.toHaveBeenCalled();
  });
});
