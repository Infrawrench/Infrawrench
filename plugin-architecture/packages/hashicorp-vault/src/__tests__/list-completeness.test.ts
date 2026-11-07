import { hostClient } from "@infrawrench/plugin-base/effect";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { VaultClient } from "../client.js";
import { unreadPrefixes } from "../lists.js";
import type { Call } from "./helpers.js";
import { makeHttp } from "./helpers.js";

const ACCOUNT = "acct";
const UNREAD_HOOK = Symbol.for("infrawrench.unreadListPart");
const unread = vi.fn<(part: { idPrefixes?: string[] }) => void>();

function client(route: (call: Call) => unknown) {
  const { http, calls } = makeHttp((call) => {
    if (call.url.hostname !== "vault.example.com") throw new Error(`Unexpected ${call.url}`);
    return route(call);
  });
  return {
    c: hostClient(
      new VaultClient({ address: "https://vault.example.com:8200", token: "hvs.t" }, {
        http,
      } as never),
    ),
    calls,
  };
}

const isList = (call: Call) => call.url.searchParams.get("list") === "true";
const pad = (i: number) => String(i).padStart(6, "0");
const unreadIdPrefixes = (): string[] =>
  unread.mock.calls.flatMap(([part]) => part.idPrefixes ?? []);

beforeEach(() => {
  unread.mockReset();
  Reflect.set(globalThis, UNREAD_HOOK, unread);
});

afterEach(() => {
  Reflect.deleteProperty(globalThis, UNREAD_HOOK);
  vi.restoreAllMocks();
});

const KV_MOUNTS = { data: { "secret/": { type: "kv", options: { version: "2" } } } };
const PKI_MOUNTS = { data: { "pki/": { type: "pki" } } };

/** A fan-out type: what lists it, and what one row's detail read looks like. */
const FAN_OUTS = [
  {
    typeId: "vault-token",
    listPath: "/v1/auth/token/accessors",
    detailPath: "/v1/auth/token/lookup-accessor",
    mounts: undefined,
    idOf: (key: string) => `${ACCOUNT}:vault-token:${key}`,
    detail: { data: { display_name: "t", policies: ["default"], expire_time: null } },
  },
  {
    typeId: "vault-lease",
    listPath: "/v1/sys/leases/lookup/",
    detailPath: "/v1/sys/leases/lookup",
    mounts: undefined,
    idOf: (key: string) => `${ACCOUNT}:vault-lease:${key}`,
    detail: { data: { ttl: 60 } },
  },
  {
    typeId: "vault-pki-cert",
    listPath: "/v1/pki/certs",
    detailPath: undefined,
    mounts: PKI_MOUNTS,
    idOf: (key: string) => `${ACCOUNT}:vault-pki-cert:pki::${key}`,
    detail: { data: { certificate: "", revocation_time: 0 } },
  },
];

function fanOutRoute(type: (typeof FAN_OUTS)[number], keys: string[]) {
  return (call: Call): unknown => {
    if (call.url.pathname === "/v1/sys/mounts" && type.mounts) return type.mounts;
    if (call.url.pathname === type.listPath && isList(call)) return { data: { keys } };
    return type.detail;
  };
}

describe("lists read past the old caps", () => {
  it("lists every KV secret past 500 in a mount", async () => {
    const keys = Array.from({ length: 700 }, (_, i) => `s${pad(i)}`);
    const { c } = client((call) => {
      if (call.url.pathname === "/v1/sys/mounts") return KV_MOUNTS;
      if (call.url.pathname === "/v1/secret/metadata/" && isList(call)) return { data: { keys } };
      return { data: { current_version: 1 } };
    });
    const rows = await c.listResources("vault-kv-secret", ACCOUNT);
    expect(rows).toHaveLength(700);
    expect(unread).not.toHaveBeenCalled();
  });

  it("asks for metadata on the same first 200 secrets each time", async () => {
    const keys = Array.from({ length: 300 }, (_, i) => `s${pad(i)}`).reverse();
    const { c, calls } = client((call) => {
      if (call.url.pathname === "/v1/sys/mounts") return KV_MOUNTS;
      if (call.url.pathname === "/v1/secret/metadata/" && isList(call)) return { data: { keys } };
      return { data: { current_version: 1 } };
    });
    const rows = await c.listResources("vault-kv-secret", ACCOUNT);
    expect(calls.filter((x) => !isList(x) && x.url.pathname.includes("/metadata/"))).toHaveLength(
      200,
    );
    expect(rows[0]!.fields["currentVersion"]).toBe(1);
    expect(rows[199]!.fields["currentVersion"]).toBe(1);
    expect(rows[200]!.fields["currentVersion"]).toBeUndefined();
  });

  it("lists a secret nested deeper than the old walk went", async () => {
    const depth = 15;
    const { c } = client((call) => {
      if (call.url.pathname === "/v1/sys/mounts") return KV_MOUNTS;
      if (!isList(call)) return { data: {} };
      const at = call.url.pathname.replace("/v1/secret/metadata/", "");
      const level = at.split("/").length - 1;
      return { data: { keys: [level < depth ? `f${level}/` : "deep"] } };
    });
    const rows = await c.listResources("vault-kv-secret", ACCOUNT);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.fields["path"]).toMatch(/\/deep$/);
  });

  it("lists a lease nested deeper than the old walk went", async () => {
    const depth = 15;
    const { c } = client((call) => {
      if (call.method !== "GET") return { data: { ttl: 60 } };
      const at = call.url.pathname.replace("/v1/sys/leases/lookup/", "");
      const level = at.split("/").length - 1;
      return { data: { keys: [level < depth ? `f${level}/` : "deep"] } };
    });
    const rows = await c.listResources("vault-lease", ACCOUNT);
    expect(rows).toHaveLength(1);
  });

  it.each(FAN_OUTS)("lists every row of $typeId past its old cap", async (type) => {
    const keys = Array.from({ length: 450 }, (_, i) => `k${pad(i)}`);
    const { c } = client(fanOutRoute(type, keys));
    const rows = await c.listResources(type.typeId, ACCOUNT);
    expect(rows.map((r) => r.id)).toEqual(keys.map(type.idOf));
    expect(unread).not.toHaveBeenCalled();
  });
});

describe("a list too long to read in one poll", () => {
  it.each(FAN_OUTS)(
    "reads $typeId up to the budget, names the rest, and does not throw",
    async (type) => {
      const keys = Array.from({ length: 2600 }, (_, i) => `k${pad(i)}`);
      const { c, calls } = client(fanOutRoute(type, keys));
      const rows = await c.listResources(type.typeId, ACCOUNT);

      const details = calls.filter((x) => !isList(x) && x.url.pathname !== "/v1/sys/mounts");
      expect(details).toHaveLength(2000);
      expect(rows).toHaveLength(2000);

      const prefixes = unreadIdPrefixes();
      expect(prefixes.length).toBeLessThan(100);
      const read = new Set(rows.map((r) => r.id));
      for (const id of keys.map(type.idOf)) {
        expect(read.has(id) !== prefixes.some((p) => id.startsWith(p))).toBe(true);
      }
    },
  );

  it("starts from a different place each poll", async () => {
    const type = FAN_OUTS[0]!;
    const keys = Array.from({ length: 2600 }, (_, i) => `k${pad(i)}`);
    vi.spyOn(Math, "random").mockReturnValue(0.5);
    const { c } = client(fanOutRoute(type, keys));
    const rows = await c.listResources(type.typeId, ACCOUNT);
    expect(rows[0]!.id).toBe(type.idOf(keys[1300]!));
    expect(rows.at(-1)!.id).toBe(type.idOf(keys[699]!));
  });

  it("stops details on the clock and names what it did not reach", async () => {
    const type = FAN_OUTS[0]!;
    const keys = Array.from({ length: 50 }, (_, i) => `k${pad(i)}`);
    let now = 1_000_000;
    vi.spyOn(Date, "now").mockImplementation(() => now);
    const { c, calls } = client((call) => {
      if (call.url.pathname === "/v1/auth/token/lookup-accessor") now += 100_000;
      return fanOutRoute(type, keys)(call);
    });
    const rows = await c.listResources(type.typeId, ACCOUNT);
    expect(calls.length).toBeLessThan(20);
    expect(rows.length).toBeLessThan(20);
    const prefixes = unreadIdPrefixes();
    const read = new Set(rows.map((r) => r.id));
    for (const id of keys.map(type.idOf)) {
      expect(read.has(id) !== prefixes.some((p) => id.startsWith(p))).toBe(true);
    }
  });

  it("walks up to the request budget, then names the folders it did not reach", async () => {
    const folders = Array.from({ length: 1500 }, (_, i) => `f${pad(i)}/`);
    const { c, calls } = client((call) => {
      if (call.url.pathname === "/v1/sys/mounts") return KV_MOUNTS;
      if (!isList(call)) return { data: {} };
      if (call.url.pathname === "/v1/secret/metadata/") return { data: { keys: folders } };
      return { data: { keys: ["s"] } };
    });
    const rows = await c.listResources("vault-kv-secret", ACCOUNT);

    expect(calls.filter(isList)).toHaveLength(1000);
    expect(rows).toHaveLength(999);
    const prefixes = unreadIdPrefixes();
    expect(prefixes.length).toBeLessThanOrEqual(1000);
    const read = new Set(rows.map((r) => r.id));
    for (const f of folders) {
      const id = `${ACCOUNT}:vault-kv-secret:secret::${f}s`;
      expect(read.has(id) !== prefixes.some((p) => id.startsWith(p))).toBe(true);
    }
  });

  it("names the mount rather than thousands of folders", async () => {
    const folders = Array.from({ length: 5000 }, (_, i) => `f${pad(i)}/`);
    const { c } = client((call) => {
      if (call.url.pathname === "/v1/sys/mounts") return KV_MOUNTS;
      if (!isList(call)) return { data: {} };
      if (call.url.pathname === "/v1/secret/metadata/") return { data: { keys: folders } };
      return { data: { keys: ["s"] } };
    });
    await c.listResources("vault-kv-secret", ACCOUNT);
    expect(unreadIdPrefixes()).toEqual([`${ACCOUNT}:vault-kv-secret:secret::`]);
  });

  it.each(FAN_OUTS)("refuses $typeId past 100,000 rows, with no detail reads", async (type) => {
    const keys = Array.from({ length: 100_001 }, (_, i) => `k${pad(i)}`);
    const { c, calls } = client(fanOutRoute(type, keys));
    await expect(c.listResources(type.typeId, ACCOUNT)).rejects.toThrow(
      "has more than Infrawrench reads",
    );
    expect(calls.filter((x) => !isList(x) && x.url.pathname !== "/v1/sys/mounts")).toEqual([]);
  });
});

describe("a failed read does not read as gone", () => {
  it("keeps a refused folder's rows and still lists the rest", async () => {
    const { c } = client((call) => {
      if (call.url.pathname === "/v1/sys/mounts") return KV_MOUNTS;
      if (!isList(call)) return { data: {} };
      if (call.url.pathname === "/v1/secret/metadata/") return { data: { keys: ["a/", "b/"] } };
      if (call.url.pathname === "/v1/secret/metadata/a/")
        return { status: 403, body: { errors: ["permission denied"] } };
      return { data: { keys: ["s"] } };
    });
    const rows = await c.listResources("vault-kv-secret", ACCOUNT);
    expect(rows.map((r) => r.externalId)).toEqual(["secret::b/s"]);
    expect(unreadIdPrefixes()).toEqual([`${ACCOUNT}:vault-kv-secret:secret::a/`]);
  });

  it("keeps a refused mount's rows and still lists another mount", async () => {
    const { c } = client((call) => {
      if (call.url.pathname === "/v1/sys/mounts")
        return {
          data: {
            "kv1/": { type: "kv", options: { version: "2" } },
            "kv2/": { type: "kv", options: { version: "2" } },
          },
        };
      if (!isList(call)) return { data: {} };
      if (call.url.pathname === "/v1/kv1/metadata/")
        return { status: 403, body: { errors: ["permission denied"] } };
      return { data: { keys: ["s"] } };
    });
    const rows = await c.listResources("vault-kv-secret", ACCOUNT);
    expect(rows.map((r) => r.externalId)).toEqual(["kv2::s"]);
    expect(unreadIdPrefixes()).toEqual([`${ACCOUNT}:vault-kv-secret:kv1::`]);
  });

  it("fails the type when no folder could be read, rather than listing nothing", async () => {
    const { c } = client((call) => {
      if (call.url.pathname === "/v1/sys/mounts") return KV_MOUNTS;
      return { status: 403, body: { errors: ["permission denied"] } };
    });
    await expect(c.listResources("vault-kv-secret", ACCOUNT)).rejects.toThrow("permission denied");
  });

  it("fails the type on a folder answering 500, keeping stored rows", async () => {
    const { c } = client((call) => {
      if (call.url.pathname === "/v1/sys/mounts") return KV_MOUNTS;
      return { status: 500, body: { errors: ["boom"] } };
    });
    await expect(c.listResources("vault-kv-secret", ACCOUNT)).rejects.toThrow("boom");
  });

  it("fails the type on a throttled token lookup, and stops sending lookups", async () => {
    const keys = Array.from({ length: 300 }, (_, i) => `k${pad(i)}`);
    const { c, calls } = client((call) => {
      if (isList(call)) return { data: { keys } };
      return { status: 429, body: { errors: ["slow down"] } };
    });
    await expect(c.listResources("vault-token", ACCOUNT)).rejects.toThrow("slow down");
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(calls.length).toBeLessThanOrEqual(7);
  });

  it("fails the type when a token's lookup is refused", async () => {
    const { c } = client((call) => {
      if (isList(call)) return { data: { keys: ["a"] } };
      return { status: 403, body: { errors: ["permission denied"] } };
    });
    await expect(c.listResources("vault-token", ACCOUNT)).rejects.toThrow("permission denied");
  });

  it("drops a token that is really gone: an invalid accessor or a bad token", async () => {
    const { c } = client((call) => {
      if (isList(call)) return { data: { keys: ["alive", "dangling", "invalid"] } };
      const { accessor } = call.body as { accessor: string };
      if (accessor === "invalid") return { status: 400, body: { errors: ["invalid accessor"] } };
      if (accessor === "dangling") return { status: 403, body: { errors: ["bad token"] } };
      return { data: { display_name: "t", policies: [] } };
    });
    const rows = await c.listResources("vault-token", ACCOUNT);
    expect(rows.map((r) => r.externalId)).toEqual(["alive"]);
    expect(unread).not.toHaveBeenCalled();
  });
});

describe("unreadPrefixes", () => {
  const ids = ["aa1", "aa2", "ab1", "ab2", "b1", "b2", "c"];

  it("covers exactly the unread ids with as few prefixes as it can", () => {
    expect(unreadPrefixes(ids, new Set(["aa1", "aa2"]))).toEqual(["ab", "b", "c"]);
    expect(unreadPrefixes(ids, new Set(["aa1", "ab2", "c"]))).toEqual(["aa2", "ab1", "b"]);
  });

  it("is empty when everything was read, and matches everything when nothing was", () => {
    expect(unreadPrefixes(ids, new Set(ids))).toEqual([]);
    expect(unreadPrefixes(ids, new Set())).toEqual([""]);
  });

  it("handles an id that is a prefix of another", () => {
    expect(unreadPrefixes(["a", "ab"], new Set(["a"]))).toEqual(["ab"]);
    expect(unreadPrefixes(["a", "ab"], new Set(["ab"]))).toEqual(["a"]);
  });
});
