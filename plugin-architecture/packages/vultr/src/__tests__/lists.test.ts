import type { HostServices } from "@infrawrench/plugin-base";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createVultrApi } from "../api.js";
import { fetchVultrCostData } from "../cost-data.js";
import {
  listBuckets,
  listDatabaseUsers,
  listDnsRecords,
  listDomains,
  listFirewallGroups,
  listLogicalDbs,
} from "../listers.js";

type Answer = { status?: number; body: unknown; headers?: Record<string, string> };

function api(responder: (url: URL) => Answer) {
  const urls: URL[] = [];
  const services: HostServices = {
    http: {
      request: vi.fn(async (req) => {
        const url = new URL(req.url);
        if (url.origin !== "https://api.vultr.com") throw new Error(`unexpected ${req.url}`);
        urls.push(url);
        const res = responder(url);
        return {
          status: res.status ?? 200,
          headers: res.headers ?? {},
          body: typeof res.body === "string" ? res.body : JSON.stringify(res.body),
        };
      }),
    },
  };
  return { api: createVultrApi({ apiKey: "KEY", services, retryDelayMs: 0 }), urls };
}

const page = (key: string, rows: unknown[], next = "") => ({
  body: { [key]: rows, meta: { total: rows.length, links: { next, prev: "" } } },
});

const UNREAD = Symbol.for("infrawrench.unreadListPart");

function trackUnread() {
  const parts: Array<{ parentResourceIds?: readonly string[] }> = [];
  Reflect.set(globalThis, UNREAD, (p: { parentResourceIds?: readonly string[] }) => parts.push(p));
  return parts;
}

afterEach(() => {
  Reflect.deleteProperty(globalThis, UNREAD);
});

const unreadParents = (parts: Array<{ parentResourceIds?: readonly string[] }>) =>
  parts.flatMap((p) => p.parentResourceIds ?? []);

describe("api.all", () => {
  it("throws past 200 pages instead of returning what it read", async () => {
    let n = 0;
    const { api: a, urls } = api(() => page("instances", [{ id: `i${n}` }], `c${++n}`));
    await expect(a.all("/instances", "instances")).rejects.toThrow(
      "has more than Infrawrench reads",
    );
    expect(urls).toHaveLength(200);
  });

  it("refuses a page whose envelope key is not a list, first page or later", async () => {
    const first = api(() => ({ body: { servers: [], meta: { links: { next: "" } } } }));
    await expect(first.api.all("/instances", "instances")).rejects.toThrow("is not a list");

    const later = api((u) =>
      u.searchParams.get("cursor")
        ? { body: { instances: { id: "x" }, meta: { links: { next: "" } } } }
        : page("instances", [{ id: "a" }], "abc"),
    );
    await expect(later.api.all("/instances", "instances")).rejects.toThrow("is not a list");
  });

  it("refuses a next cursor that repeats instead of ending the list there", async () => {
    const { api: a } = api(() => page("instances", [{ id: "a" }], "same"));
    await expect(a.all("/instances", "instances")).rejects.toThrow(
      "Refusing to read that as the end of the list",
    );
  });

  it("retries a throttled GET instead of failing the read", async () => {
    let calls = 0;
    const { api: a, urls } = api(() =>
      ++calls < 3
        ? { status: 429, body: { error: "Rate limit reached", status: 429 } }
        : page("instances", [{ id: "a" }]),
    );
    const rows = await a.all<{ id: string }>("/instances", "instances");
    expect(rows.map((r) => r.id)).toEqual(["a"]);
    expect(urls).toHaveLength(3);
  });

  it("still fails on a throttle that does not let up", async () => {
    const { api: a } = api(() => ({ status: 429, body: { error: "Rate limit reached" } }));
    await expect(a.all("/instances", "instances")).rejects.toMatchObject({ status: 429 });
  });
});

const dbs = page("databases", [
  { id: "d1", database_engine: "pg" },
  { id: "d2", database_engine: "mysql" },
]);

describe("database users and logical databases", () => {
  it("fails the type when one database's users cannot be read", async () => {
    const { api: a } = api((u) => {
      if (u.pathname === "/v2/databases") return dbs;
      if (u.pathname === "/v2/databases/d1/users") return { body: { users: [{ username: "a" }] } };
      return { status: 500, body: { error: "Internal error" } };
    });
    await expect(listDatabaseUsers(a, "acct")).rejects.toMatchObject({ status: 500 });
  });

  it("reads a database gone since the list (404) as having no users", async () => {
    const { api: a } = api((u) => {
      if (u.pathname === "/v2/databases") return dbs;
      if (u.pathname === "/v2/databases/d1/users") return { body: { users: [{ username: "a" }] } };
      return { status: 404, body: { error: "Not found" } };
    });
    const rows = await listDatabaseUsers(a, "acct");
    expect(rows.map((r) => r.id)).toEqual(["acct:database-user:d1/a"]);
  });

  it("keeps a database's stored users when Vultr refuses that one database", async () => {
    const parts = trackUnread();
    const { api: a } = api((u) => {
      if (u.pathname === "/v2/databases") return dbs;
      if (u.pathname === "/v2/databases/d1/users") return { body: { users: [{ username: "a" }] } };
      return { status: 400, body: { error: "Database is not ready" } };
    });
    const rows = await listDatabaseUsers(a, "acct");
    expect(rows.map((r) => r.id)).toEqual(["acct:database-user:d1/a"]);
    expect(unreadParents(parts)).toEqual(["acct:database:d2"]);
  });

  it("throws that refusal where the host keeps no track of unread parents", async () => {
    const { api: a } = api((u) => {
      if (u.pathname === "/v2/databases") return dbs;
      return { status: 400, body: { error: "Database is not ready" } };
    });
    await expect(listDatabaseUsers(a, "acct")).rejects.toMatchObject({ status: 400 });
  });

  it("refuses a users answer with no users list", async () => {
    const { api: a } = api((u) =>
      u.pathname === "/v2/databases" ? dbs : { body: { error: "maintenance" } },
    );
    await expect(listDatabaseUsers(a, "acct")).rejects.toThrow("is not a list");
  });

  it("fails the type when one database's logical databases cannot be read", async () => {
    const { api: a } = api((u) => {
      if (u.pathname === "/v2/databases") return dbs;
      if (u.pathname === "/v2/databases/d1/dbs") return { body: { dbs: [{ name: "defaultdb" }] } };
      return { status: 503, body: { error: "Unavailable" } };
    });
    await expect(listLogicalDbs(a, "acct")).rejects.toMatchObject({ status: 503 });
  });
});

describe("DNS records", () => {
  const domains = page("domains", [{ domain: "a.example" }, { domain: "b.example" }]);

  it("fails the type when one domain's records cannot be read", async () => {
    const { api: a } = api((u) => {
      if (u.pathname === "/v2/domains") return domains;
      if (u.pathname === "/v2/domains/a.example/records") return page("records", [{ id: "r1" }]);
      return { status: 500, body: { error: "Internal error" } };
    });
    await expect(listDnsRecords(a, "acct")).rejects.toMatchObject({ status: 500 });
  });

  it("passes a truncated record list through instead of reading it as none", async () => {
    let n = 0;
    const { api: a } = api((u) =>
      u.pathname === "/v2/domains" ? domains : page("records", [{ id: `r${n}` }], `c${++n}`),
    );
    await expect(listDnsRecords(a, "acct")).rejects.toThrow("has more than Infrawrench reads");
  });

  it("passes a broken record page through the record count's catch too", async () => {
    const { api: a } = api((u) =>
      u.pathname === "/v2/domains" ? domains : { body: { error: "maintenance" } },
    );
    await expect(listDomains(a, "acct")).rejects.toThrow("is not a list");
  });

  it("passes a broken rule page through the firewall group's catch", async () => {
    const { api: a } = api((u) =>
      u.pathname === "/v2/firewalls"
        ? page("firewall_groups", [{ id: "g1" }])
        : { body: { error: "maintenance" } },
    );
    await expect(listFirewallGroups(a, "acct")).rejects.toThrow("is not a list");
  });
});

describe("buckets", () => {
  const subs = page("object_storages", [
    { id: "s1", status: "active", s3_hostname: "ewr1.vultrobjects.com" },
    { id: "s2", status: "active", s3_hostname: "ewr1.vultrobjects.com" },
  ]);

  it("fails the type when one subscription's buckets cannot be read", async () => {
    const { api: a } = api((u) => {
      if (u.pathname === "/v2/object-storage") return subs;
      if (u.pathname === "/v2/object-storage/s1/bucket")
        return { body: { buckets: [{ name: "x" }] } };
      return { status: 500, body: { error: "Internal error" } };
    });
    await expect(listBuckets(a, "acct")).rejects.toMatchObject({ status: 500 });
  });

  it("keeps the stored buckets of a subscription that is not active", async () => {
    const parts = trackUnread();
    const { api: a, urls } = api((u) => {
      if (u.pathname === "/v2/object-storage")
        return page("object_storages", [
          { id: "s1", status: "active" },
          { id: "s2", status: "suspended" },
        ]);
      return { body: { buckets: [{ name: "x" }] } };
    });
    const rows = await listBuckets(a, "acct");
    expect(rows.map((r) => r.id)).toEqual(["acct:bucket:s1/x"]);
    expect(unreadParents(parts)).toEqual(["acct:object-storage:s2"]);
    expect(urls.some((u) => u.pathname.includes("/s2/"))).toBe(false);
  });
});

describe("costs", () => {
  it("refuses a pending-charges answer with no list instead of reading it as nothing owed", async () => {
    const { api: a } = api((u) => {
      if (u.pathname === "/v2/billing/invoices") return page("billing_invoices", []);
      if (u.pathname === "/v2/billing/pending-charges") return { body: { error: "maintenance" } };
      throw new Error(`unexpected ${u.pathname}`);
    });
    await expect(
      fetchVultrCostData(
        a,
        { fromDate: "2026-09-01", toDate: "2026-09-10" },
        Date.parse("2026-09-10T12:00:00Z"),
      ),
    ).rejects.toThrow("is not a list");
  });
});
