import { hostClient } from "@infrawrench/plugin-base/effect";
import type { HostServices } from "@infrawrench/plugin-base";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createCivoApi } from "../api.js";
import { CivoClient } from "../client.js";
import { plugin } from "../plugin.js";

type Answer = { status?: number; body: unknown };
type Responder = (path: string, params: URLSearchParams) => Answer;

const REGIONS = [{ code: "LON1" }, { code: "FRA1" }];
const THROTTLED: Answer = { status: 429, body: { code: "rate_limited", reason: "Slow down" } };
const BROKEN: Answer = { status: 500, body: "upstream failure" };
const DENIED: Answer = {
  status: 403,
  body: { code: "authentication_access_denied", reason: "Access denied" },
};
const NOT_FOUND: Answer = { status: 404, body: "Not Found" };

function host(respond: Responder) {
  const urls: string[] = [];
  const services: HostServices = {
    http: {
      request: vi.fn(async (req) => {
        urls.push(req.url);
        const url = new URL(req.url);
        if (url.hostname !== "api.civo.com") throw new Error(`Unexpected host: ${req.url}`);
        const res = respond(url.pathname.replace(/^\/v2/, ""), url.searchParams);
        return {
          status: res.status ?? 200,
          headers: {},
          body: typeof res.body === "string" ? res.body : JSON.stringify(res.body),
        };
      }),
    },
  };
  return { services, urls };
}

function client(respond: Responder) {
  const { services, urls } = host(respond);
  return {
    urls,
    civo: hostClient(new CivoClient({ apiKey: "K" }, plugin.resourceTypes, services)),
  };
}

/** A fake account: the regions, then whatever the test's routes answer, else an empty list. */
function account(routes: (path: string, region: string | null) => Answer | undefined) {
  return client((path, params) => {
    if (path === "/regions") return { body: REGIONS };
    return routes(path, params.get("region")) ?? { body: [] };
  });
}

const ids = (rows: Array<{ externalId?: string }>) => rows.map((r) => r.externalId).sort();

const UNREAD_HOOK = Symbol.for("infrawrench.unreadListPart");
const unread = vi.fn();

beforeEach(() => {
  unread.mockClear();
  Reflect.set(globalThis, UNREAD_HOOK, unread);
  vi.stubGlobal("fetch", () => {
    throw new Error("The host transport was bypassed");
  });
});

afterEach(() => {
  Reflect.deleteProperty(globalThis, UNREAD_HOOK);
  vi.unstubAllGlobals();
});

describe("list", () => {
  const list = (respond: Responder) => {
    const { services, urls } = host(respond);
    return { urls, read: createCivoApi({ apiKey: "K", services }).list<{ id: string }>("/x") };
  };

  it("reads past the old stop at 100 pages", async () => {
    const { read, urls } = list((_, params) => ({
      body: { pages: 150, items: [{ id: `r${params.get("page")}` }] },
    }));
    expect(await read).toHaveLength(150);
    expect(urls).toHaveLength(150);
  });

  it("refuses, on the first page, a list that says it is longer than the cap", async () => {
    const { read, urls } = list(() => ({ body: { pages: 1001, items: [{ id: "a" }] } }));
    await expect(read).rejects.toThrow("has more than Infrawrench reads");
    expect(urls).toHaveLength(1);
  });

  it("follows full pages with no page count, and refuses at the cap", async () => {
    const { read, urls } = list(() => ({
      body: { items: Array.from({ length: 100 }, (_, i) => ({ id: `r${i}` })) },
    }));
    await expect(read).rejects.toThrow("has more than Infrawrench reads");
    expect(urls).toHaveLength(1000);
  });

  it("ends a list with no page count on its first short page", async () => {
    const { read, urls } = list((_, params) => ({
      body: {
        items: Array.from({ length: params.get("page") === "1" ? 100 : 3 }, (_, i) => ({
          id: `r${i}`,
        })),
      },
    }));
    expect(await read).toHaveLength(103);
    expect(urls).toHaveLength(2);
  });

  it("refuses a first page with its key renamed", async () => {
    const { read } = list(() => ({ body: { pages: 1, rows: [{ id: "a" }] } }));
    await expect(read).rejects.toThrow("is not a list");
  });

  it("refuses a later page with its key renamed", async () => {
    const { read } = list((_, params) =>
      params.get("page") === "1"
        ? { body: { pages: 2, items: [{ id: "a" }] } }
        : { body: { pages: 2, rows: [{ id: "b" }] } },
    );
    await expect(read).rejects.toThrow("is not a list");
  });

  it("refuses a later page that is a bare array", async () => {
    const { read } = list((_, params) =>
      params.get("page") === "1"
        ? { body: { pages: 2, items: [{ id: "a" }] } }
        : { body: [{ id: "b" }] },
    );
    await expect(read).rejects.toThrow("is not a list");
  });

  it("refuses an empty answer and a whole answer of null", async () => {
    await expect(list(() => ({ body: "" })).read).rejects.toThrow("is not a list");
    await expect(list(() => ({ body: null })).read).rejects.toThrow("is not a list");
  });

  it("reads a key set to null as empty", async () => {
    expect(await list(() => ({ body: { pages: 1, items: null } })).read).toEqual([]);
  });

  it("takes a short bare array as the whole list, in one request", async () => {
    const { read, urls } = list(() => ({ body: [{ id: "a" }] }));
    expect(await read).toEqual([{ id: "a" }]);
    expect(urls).toHaveLength(1);
  });

  it("asks again with no paging when a bare array fills the page", async () => {
    const { read, urls } = list((_, params) => ({
      body: Array.from({ length: params.has("per_page") ? 100 : 250 }, (_, i) => ({
        id: `r${i}`,
      })),
    }));
    expect(await read).toHaveLength(250);
    expect(urls).toHaveLength(2);
    expect(urls[1]).not.toContain("per_page");
  });

  it("refuses a re-read of a full bare array that is not a list", async () => {
    const { read } = list((_, params) => ({
      body: params.has("per_page")
        ? Array.from({ length: 100 }, (_, i) => ({ id: `r${i}` }))
        : { message: "nope" },
    }));
    await expect(read).rejects.toThrow("is not a list");
  });
});

// Every type that fans out over regions, with the route that does it.
const REGIONAL: Array<[string, string]> = [
  ["instance", "/instances"],
  ["volume", "/volumes"],
  ["volume-snapshot", "/snapshots"],
  ["instance-snapshot", "/instances"],
  ["kubernetes-cluster", "/kubernetes/clusters"],
  ["node-pool", "/kubernetes/clusters"],
  ["database", "/databases"],
  ["database-backup", "/databases"],
  ["load-balancer", "/loadbalancers"],
  ["firewall", "/firewalls"],
  ["network", "/networks"],
  ["reserved-ip", "/ips"],
  ["object-store", "/objectstores"],
  ["object-store-credential", "/objectstore/credentials"],
];

describe("a fan-out over regions", () => {
  it.each(REGIONAL)("%s: a 5xx in one region fails the type", async (type, route) => {
    const { civo } = account((path, region) =>
      path === route && region === "FRA1" ? BROKEN : undefined,
    );
    await expect(civo.listResources(type, "acct")).rejects.toThrow("Civo API error 500");
  });

  it.each(REGIONAL)("%s: a 403 from every region keeps the rows quietly", async (type, route) => {
    const { civo } = account((path) => (path === route ? DENIED : undefined));
    expect(await civo.listResources(type, "acct")).toEqual([]);
    expect(unread).toHaveBeenCalledWith({ idPrefixes: [""] });
  });

  it.each(REGIONAL)("%s: a missing endpoint in every region says so", async (type, route) => {
    const { civo } = account((path) => (path === route ? NOT_FOUND : undefined));
    await expect(civo.listResources(type, "acct")).rejects.toThrow("in every region");
    expect(unread).not.toHaveBeenCalled();
  });

  const rows = (path: string, region: string | null) =>
    path === "/instances" && region === "LON1"
      ? { body: [{ id: "i1", hostname: "a" }] }
      : undefined;

  it.each<[string, Answer]>([
    ["a throttle", THROTTLED],
    ["a 5xx", BROKEN],
    ["a 401", { status: 401, body: { code: "authentication_failed", reason: "Bad key" } }],
    [
      "a 403 that rejects the key",
      {
        status: 403,
        body: { code: "authentication_invalid_key", reason: "Bad key" },
      },
    ],
    [
      "region_unavailable on a 5xx",
      {
        status: 503,
        body: { code: "region_unavailable", reason: "Region down" },
      },
    ],
  ])("%s in one region fails the type, rows from others or not", async (_, answer) => {
    const { civo } = account(
      (path, region) => rows(path, region) ?? (path === "/instances" ? answer : undefined),
    );
    await expect(civo.listResources("instance", "acct")).rejects.toThrow("Civo API error");
  });

  it("a network failure in one region fails the type", async () => {
    const { civo } = account((path, region) => {
      if (path === "/instances" && region === "FRA1") throw new Error("socket hang up");
      return rows(path, region);
    });
    await expect(civo.listResources("instance", "acct")).rejects.toThrow("socket hang up");
  });

  it.each<[string, Answer]>([
    ["a 403 saying the key has no access", DENIED],
    ["a missing endpoint", NOT_FOUND],
    ["region_unavailable", { status: 400, body: { code: "region_unavailable", reason: "No" } }],
    ["disabled_service", { status: 400, body: { code: "disabled_service", reason: "No" } }],
    [
      "the gateway's REGION_FEATURE_UNAVAILABLE",
      {
        status: 400,
        body: {
          error: {
            message: "Not offered here",
            status: "FAILED_PRECONDITION",
            details: [{ reason: "REGION_FEATURE_UNAVAILABLE" }],
          },
        },
      },
    ],
  ])("%s in one region reads as none there", async (_, answer) => {
    const { civo } = account(
      (path, region) => rows(path, region) ?? (path === "/instances" ? answer : undefined),
    );
    expect(ids(await civo.listResources("instance", "acct"))).toEqual(["LON1/i1"]);
  });

  it("keeps the status of a missing endpoint in every region for the host's backoff", async () => {
    const { civo } = account((path) => (path === "/instances" ? NOT_FOUND : undefined));
    await expect(civo.listResources("instance", "acct")).rejects.toMatchObject({ status: 404 });
  });

  it("a service not enabled in every region keeps the rows quietly", async () => {
    const { civo } = account((path) =>
      path === "/instances"
        ? { status: 400, body: { code: "disabled_service", reason: "Not enabled" } }
        : undefined,
    );
    expect(await civo.listResources("instance", "acct")).toEqual([]);
    expect(unread).toHaveBeenCalledWith({ idPrefixes: [""] });
  });

  it("a 403 in one region and a missing endpoint in the other says so", async () => {
    const { civo } = account((path, region) => {
      if (path !== "/instances") return undefined;
      return region === "LON1" ? DENIED : NOT_FOUND;
    });
    await expect(civo.listResources("instance", "acct")).rejects.toThrow("in every region");
    expect(unread).not.toHaveBeenCalled();
  });

  it.each<[string, Answer]>([
    ["an invalid key", { status: 403, body: { code: "authentication_invalid_key", reason: "No" } }],
    [
      "a failed authentication",
      { status: 403, body: { code: "authentication_failed", reason: "No" } },
    ],
    ["a 401", { status: 401, body: { code: "authentication_failed", reason: "No" } }],
    ["a throttle", THROTTLED],
    ["a 5xx", BROKEN],
  ])("%s from every region still fails the type", async (_, answer) => {
    const { civo } = account((path) => (path === "/instances" ? answer : undefined));
    await expect(civo.listResources("instance", "acct")).rejects.toThrow("Civo API error");
    expect(unread).not.toHaveBeenCalled();
  });

  it("a 403 in one region is that region's none, with nothing to report", async () => {
    const { civo } = account(
      (path, region) => rows(path, region) ?? (path === "/instances" ? DENIED : undefined),
    );
    expect(ids(await civo.listResources("instance", "acct"))).toEqual(["LON1/i1"]);
    expect(unread).not.toHaveBeenCalled();
  });

  it("does not ask a region that does not offer the feature", async () => {
    const { civo, urls } = client((path, params) => {
      if (path === "/regions") {
        return {
          body: [
            { code: "LON1", features: { kubernetes: true } },
            {
              code: "FRA1",
              features: { kubernetes: false },
            },
          ],
        };
      }
      return { body: [{ id: `c-${params.get("region")}`, name: "c" }] };
    });
    expect(ids(await civo.listResources("kubernetes-cluster", "acct"))).toEqual(["LON1/c-LON1"]);
    expect(urls.some((u) => u.includes("region=FRA1"))).toBe(false);
  });

  it("carries a list past its cap through the fan-out", async () => {
    const { civo } = account((path, region) =>
      path === "/instances" && region === "FRA1"
        ? { body: { pages: 5000, items: [{ id: "i", hostname: "a" }] } }
        : undefined,
    );
    await expect(civo.listResources("instance", "acct")).rejects.toThrow(
      "has more than Infrawrench reads",
    );
  });
});

describe("the region list", () => {
  it.each<[string, Answer]>([
    ["a 5xx", BROKEN],
    ["no regions", { body: [] }],
    ["an answer that is not a list", { body: { regions: REGIONS } }],
  ])("%s fails a sync rather than fanning out over the static table", async (_, answer) => {
    const { civo, urls } = client((path) => (path === "/regions" ? answer : { body: [] }));
    await expect(civo.listResources("instance", "acct")).rejects.toThrow();
    expect(urls.some((u) => u.includes("/instances"))).toBe(false);
  });

  it("is read again after a failure", async () => {
    let answer = BROKEN;
    const { civo } = client((path) => (path === "/regions" ? answer : { body: [] }));
    await expect(civo.listResources("instance", "acct")).rejects.toThrow("Civo API error 500");
    answer = { body: REGIONS };
    expect(await civo.listResources("instance", "acct")).toEqual([]);
  });

  it("still offers the known regions on a create form", async () => {
    const { civo } = client((path) => (path === "/regions" ? BROKEN : { body: [] }));
    const config = await civo.getCreateConfig!("volume");
    const region = config.fields.find((f) => f.key === "region");
    expect(region).toMatchObject({ defaultValue: "LON1" });
  });

  it("still names a rejected key when checking credentials", async () => {
    const unauthorized = { status: 401, body: { code: "authentication_failed", reason: "No" } };
    const { civo } = client(() => unauthorized);
    const result = await civo.verifyCredentials!();
    expect(result.checks.find((c) => c.capabilityId === "compute")?.status).toBe("missing");
  });
});

describe("a read per parent", () => {
  const PARENTS: Array<{
    type: string;
    parentsAt: string;
    parents: unknown[];
    childAt: (id: string) => string;
    child: unknown;
    expected: string[];
  }> = [
    {
      type: "instance-snapshot",
      parentsAt: "/instances",
      parents: [
        { id: "p1", hostname: "a" },
        { id: "p2", hostname: "b" },
      ],
      childAt: (id) => `/instances/${id}/snapshots`,
      child: { id: "s1", name: "snap" },
      expected: ["LON1/p1/s1"],
    },
    {
      type: "database-backup",
      parentsAt: "/databases",
      parents: [
        { id: "p1", name: "a" },
        { id: "p2", name: "b" },
      ],
      childAt: (id) => `/databases/${id}/backups`,
      child: { id: "s1", name: "backup" },
      expected: ["LON1/p1/s1"],
    },
    {
      type: "dns-record",
      parentsAt: "/dns",
      parents: [
        { id: "p1", name: "a.example" },
        { id: "p2", name: "b.example" },
      ],
      childAt: (id) => `/dns/${id}/records`,
      child: { id: "s1", name: "www", type: "a" },
      expected: ["p1/s1"],
    },
  ];

  /** One region's worth of parents, so the expected ids stay short. */
  const parentAccount = (c: (typeof PARENTS)[number], second: Answer) =>
    account((path, region) => {
      if (path === c.parentsAt) return region === "FRA1" ? { body: [] } : { body: c.parents };
      if (path === c.childAt("p1")) return { body: [c.child] };
      if (path === c.childAt("p2")) return second;
      return undefined;
    });

  describe.each(PARENTS)("$type", (c) => {
    it("a 5xx on one parent fails the type, keeping the stored rows", async () => {
      const { civo } = parentAccount(c, BROKEN);
      await expect(civo.listResources(c.type, "acct")).rejects.toThrow("Civo API error 500");
    });

    it("a throttle on one parent fails the type", async () => {
      const { civo } = parentAccount(c, THROTTLED);
      await expect(civo.listResources(c.type, "acct")).rejects.toThrow("Civo API error 429");
    });

    it("a page that is not a list on one parent fails the type", async () => {
      const { civo } = parentAccount(c, { body: { rows: [] } });
      await expect(civo.listResources(c.type, "acct")).rejects.toThrow("is not a list");
    });

    it("a 404 reads as a parent that went between the two reads", async () => {
      const { civo } = parentAccount(c, NOT_FOUND);
      expect(ids(await civo.listResources(c.type, "acct"))).toEqual(c.expected);
    });

    it("a 404 from every parent reads as none", async () => {
      const { civo } = account((path, region) => {
        if (path === c.parentsAt) return region === "FRA1" ? { body: [] } : { body: c.parents };
        return path === c.childAt("p1") || path === c.childAt("p2") ? NOT_FOUND : undefined;
      });
      expect(await civo.listResources(c.type, "acct")).toEqual([]);
    });

    it("a 403 from every parent keeps the rows quietly", async () => {
      const { civo } = account((path, region) => {
        if (path === c.parentsAt) return region === "FRA1" ? { body: [] } : { body: c.parents };
        return path === c.childAt("p1") || path === c.childAt("p2") ? DENIED : undefined;
      });
      expect(await civo.listResources(c.type, "acct")).toEqual([]);
      expect(unread).toHaveBeenCalledWith({ idPrefixes: [""] });
    });

    it("a 404 from every parent reports nothing unread", async () => {
      const { civo } = account((path, region) => {
        if (path === c.parentsAt) return region === "FRA1" ? { body: [] } : { body: c.parents };
        return path === c.childAt("p1") || path === c.childAt("p2") ? NOT_FOUND : undefined;
      });
      await civo.listResources(c.type, "acct");
      expect(unread).not.toHaveBeenCalled();
    });
  });
});

describe("a type with no fan-out", () => {
  const BAD_KEY: Answer = {
    status: 403,
    body: { code: "authentication_invalid_key", reason: "No" },
  };

  it.each<[string, string]>([
    ["domain", "/dns"],
    ["dns-record", "/dns"],
    ["ssh-key", "/sshkeys"],
    ["account", "/quota"],
  ])("%s: a 403 keeps the rows quietly, and a bad key or a 5xx fails", async (type, route) => {
    const denied = account((path) => (path === route ? DENIED : undefined));
    expect(await denied.civo.listResources(type, "acct")).toEqual([]);
    expect(unread).toHaveBeenCalledWith({ idPrefixes: [""] });
    unread.mockClear();

    for (const answer of [BAD_KEY, BROKEN, THROTTLED]) {
      const failing = account((path) => (path === route ? answer : undefined));
      await expect(failing.civo.listResources(type, "acct")).rejects.toThrow("Civo API error");
    }
    expect(unread).not.toHaveBeenCalled();
  });

  it("a 403 on the region list keeps the rows quietly", async () => {
    const { civo, urls } = client((path) => (path === "/regions" ? DENIED : { body: [] }));
    expect(await civo.listResources("instance", "acct")).toEqual([]);
    expect(unread).toHaveBeenCalledWith({ idPrefixes: [""] });
    expect(urls.some((u) => u.includes("/instances"))).toBe(false);
  });

  it("a 403 on the region list shows where the host keeps no track", async () => {
    Reflect.deleteProperty(globalThis, UNREAD_HOOK);
    const { civo } = client((path) => (path === "/regions" ? DENIED : { body: [] }));
    await expect(civo.listResources("instance", "acct")).rejects.toThrow("Civo API error");
  });
});

describe("a read that only adds a field", () => {
  const firewalls = (rules: Answer) =>
    account((path, region) => {
      if (path === "/firewalls" && region === "LON1") {
        return { body: [{ id: "f1", name: "fw" }] };
      }
      return path === "/firewalls/f1/rules" ? rules : undefined;
    });

  const domains = (records: Answer) =>
    account((path) => {
      if (path === "/dns") return { body: [{ id: "d1", name: "a.example" }] };
      return path === "/dns/d1/records" ? records : undefined;
    });

  it("a failed read of a firewall's rules fails the type, not its finding", async () => {
    const { civo } = firewalls(BROKEN);
    await expect(civo.listResources("firewall", "acct")).rejects.toThrow("Civo API error 500");
  });

  it("firewall rules refused leave the finding unknown and the row in place", async () => {
    const { civo } = firewalls(DENIED);
    const [row] = await civo.listResources("firewall", "acct");
    expect(row?.externalId).toBe("LON1/f1");
    expect(row?.fields["openToWorld"]).toBeUndefined();
  });

  it("firewall rules that stop being a list fail the type", async () => {
    const { civo } = firewalls({ body: { rows: [] } });
    await expect(civo.listResources("firewall", "acct")).rejects.toThrow("is not a list");
  });

  it("a failed count of a domain's records fails the type", async () => {
    const { civo } = domains(THROTTLED);
    await expect(civo.listResources("domain", "acct")).rejects.toThrow("Civo API error 429");
  });

  it("a refused count of a domain's records leaves the count unknown", async () => {
    const { civo } = domains(DENIED);
    const [row] = await civo.listResources("domain", "acct");
    expect(row?.externalId).toBe("d1");
    expect(row?.fields["recordCount"]).toBeUndefined();
  });
});
