import type { UnreadListPart } from "@infrawrench/plugin-base";
import { hostClient } from "@infrawrench/plugin-base/effect";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MailgunClient } from "../client.js";

interface Answer {
  status?: number;
  body?: unknown;
}

function client(route: (url: URL, method: string, body?: string) => Answer, region = "both") {
  const calls: Array<{ url: URL; method: string; body?: string }> = [];
  const http = {
    async request(req: { url: string; method: string; body?: string | Uint8Array }) {
      const url = new URL(req.url);
      if (url.host !== "api.mailgun.net" && url.host !== "api.eu.mailgun.net") {
        throw new Error(`Unexpected host ${url.host}`);
      }
      const body = typeof req.body === "string" ? req.body : undefined;
      calls.push({ url, method: req.method, ...(body !== undefined ? { body } : {}) });
      const r = route(url, req.method, body);
      return {
        status: r.status ?? 200,
        headers: {},
        body: r.body === undefined ? "" : JSON.stringify(r.body),
      };
    },
  };
  return {
    c: hostClient(new MailgunClient({ apiKey: "key-1", region }, { http } as never)),
    calls,
  };
}

const DOMAIN_ROWS = { total_count: 2, items: [{ name: "a.test" }, { name: "b.test" }] };

const UNREAD_HOOK = Symbol.for("infrawrench.unreadListPart");
const unread = vi.fn<(part: UnreadListPart) => void>();
const namedParents = () => [
  ...new Set(unread.mock.calls.flatMap(([part]) => part.parentResourceIds ?? [])),
];
const namedPrefixes = () => [
  ...new Set(unread.mock.calls.flatMap(([part]) => part.idPrefixes ?? [])),
];

beforeEach(() => {
  unread.mockReset();
  Reflect.set(globalThis, UNREAD_HOOK, unread);
});
afterEach(() => {
  Reflect.deleteProperty(globalThis, UNREAD_HOOK);
  vi.useRealTimers();
});

describe("caps throw rather than read the rest as deleted", () => {
  const fullPage = (size: number, key = "items") => ({
    [key]: Array.from({ length: size }, (_, i) => ({ id: `r${i}`, tag: `t${i}` })),
    total_count: 10_000_000,
    total: 10_000_000,
  });

  it("routes: 100,000 rows at 1,000 a page", async () => {
    const { c, calls } = client(() => ({ body: fullPage(1000) }), "us");
    await expect(c.listResources("mailgun-route", "a")).rejects.toThrow(
      "has more than Infrawrench reads",
    );
    expect(calls).toHaveLength(100);
  });

  it("domains: 100,000 rows at 1,000 a page", async () => {
    const { c, calls } = client(() => ({ body: fullPage(1000) }), "us");
    await expect(c.listResources("mailgun-domain", "a")).rejects.toThrow(
      "has more than Infrawrench reads",
    );
    expect(calls).toHaveLength(100);
  });

  it("a domain's SMTP credentials: 10,000 rows at 100 a page", async () => {
    const { c, calls } = client(
      (url) =>
        url.pathname === "/v4/domains"
          ? { body: { total_count: 1, items: [{ name: "a.test" }] } }
          : { body: fullPage(100) },
      "us",
    );
    await expect(c.listResources("mailgun-smtp-credential", "a")).rejects.toThrow(
      "has more than Infrawrench reads",
    );
    expect(calls.filter((x) => x.url.pathname.endsWith("/credentials"))).toHaveLength(100);
  });

  it("tags: 100,000 rows at the documented 1,000 a page", async () => {
    const { c, calls } = client(() => ({ body: fullPage(1000) }), "us");
    await expect(c.listResources("mailgun-tag", "a")).rejects.toThrow(
      "has more than Infrawrench reads",
    );
    expect(calls).toHaveLength(100);
    expect(JSON.parse(calls[1]!.body ?? "{}").pagination).toMatchObject({
      skip: 1000,
      limit: 1000,
    });
  });

  it("subaccounts: 100,000 rows at 1,000 a page", async () => {
    const { c, calls } = client(() => ({ body: fullPage(1000, "subaccounts") }), "us");
    await expect(c.listResources("mailgun-subaccount", "a")).rejects.toThrow(
      "has more than Infrawrench reads",
    );
    expect(calls).toHaveLength(100);
  });

  it("mailing lists: 1,000 pages", async () => {
    let n = 0;
    const { c, calls } = client(() => {
      n += 1;
      return {
        body: {
          items: [{ address: `l${n}@x` }],
          paging: { next: `https://api.mailgun.net/v3/lists/pages?page=next&address=${n}` },
        },
      };
    }, "us");
    await expect(c.listResources("mailgun-mailing-list", "a")).rejects.toThrow(
      "has more than Infrawrench reads",
    );
    expect(calls).toHaveLength(1000);
  });

  it("a next link that repeats with rows on the page cannot be called the end", async () => {
    const { c, calls } = client(
      () => ({
        body: {
          items: [{ address: "l@x" }],
          paging: { next: "https://api.mailgun.net/v3/lists/pages?page=next&address=l" },
        },
      }),
      "us",
    );
    await expect(c.listResources("mailgun-mailing-list", "a")).rejects.toThrow(
      "has more than Infrawrench reads",
    );
    expect(calls).toHaveLength(2);
  });
});

describe("a shorter page than asked for", () => {
  it("reads on while total_count says there is more, so a clamped limit loses nothing", async () => {
    const { c, calls } = client((url) => {
      const skip = Number(url.searchParams.get("skip"));
      const items = skip < 200 ? [{ id: `r${skip}` }, { id: `r${skip + 1}` }] : [];
      return { body: { total_count: 4, items: skip < 4 ? items : [] } };
    }, "us");
    const routes = await c.listResources("mailgun-route", "a");
    expect(routes).toHaveLength(4);
    expect(calls.map((x) => x.url.searchParams.get("skip"))).toEqual(["0", "2"]);
  });

  it("ends on an empty page when total_count overstates the list", async () => {
    const { c, calls } = client(
      (url) =>
        url.searchParams.get("skip") === "0"
          ? { body: { total_count: 9, items: [{ id: "r" }] } }
          : { body: { total_count: 9, items: [] } },
      "us",
    );
    expect(await c.listResources("mailgun-route", "a")).toHaveLength(1);
    expect(calls).toHaveLength(2);
  });

  it("reads tags to an empty page, so a clamped limit loses nothing", async () => {
    const { c, calls } = client((_url, _m, body) => {
      const skip = JSON.parse(body ?? "{}").pagination.skip;
      return { body: { items: skip < 200 ? [{ tag: `t${skip}` }] : [] } };
    }, "us");
    const tags = await c.listResources("mailgun-tag", "a");
    expect(tags.length).toBe(200);
    expect(calls).toHaveLength(201);
  });
});

describe("a page that is not a list", () => {
  const cases: Array<[string, string]> = [
    ["mailgun-domain", "/v4/domains"],
    ["mailgun-route", "/v3/routes"],
    ["mailgun-mailing-list", "/v3/lists/pages"],
    ["mailgun-tag", "/v1/analytics/tags"],
    ["mailgun-subaccount", "/v5/accounts/subaccounts"],
    ["mailgun-api-key", "/v1/keys"],
    ["mailgun-account-webhook", "/v1/webhooks"],
    ["mailgun-ip-pool", "/v3/ip_pools"],
    ["mailgun-ip", "/v3/ips"],
  ];

  it.each(cases)("%s rejects a renamed key", async (typeId, path) => {
    const { c } = client(
      (url) => (url.pathname === path ? { body: { renamed: [] } } : { body: {} }),
      "us",
    );
    await expect(c.listResources(typeId, "a")).rejects.toThrow("is not a list");
  });

  it("rejects a renamed key on a later page", async () => {
    const full = Array.from({ length: 1000 }, (_, i) => ({ id: `r${i}` }));
    const { c } = client(
      (url) =>
        url.searchParams.get("skip") === "0"
          ? { body: { total_count: 2000, items: full } }
          : { body: { renamed: full } },
      "us",
    );
    await expect(c.listResources("mailgun-route", "a")).rejects.toThrow("is not a list");
  });

  it("rejects a mailing list page with its key renamed after the first", async () => {
    const { c } = client(
      (url) =>
        url.searchParams.get("page")
          ? { body: { renamed: [] } }
          : {
              body: {
                items: [{ address: "l@x" }],
                paging: { next: "https://api.mailgun.net/v3/lists/pages?page=next" },
              },
            },
      "us",
    );
    await expect(c.listResources("mailgun-mailing-list", "a")).rejects.toThrow("is not a list");
  });

  it("rejects an empty 200 rather than reading it as no rows", async () => {
    const { c } = client(() => ({}), "us");
    await expect(c.listResources("mailgun-route", "a")).rejects.toThrow("is not a list");
  });

  it("rejects a domain's webhooks answer with no webhooks object", async () => {
    const { c } = client(
      (url) =>
        url.pathname === "/v4/domains"
          ? { body: { total_count: 1, items: [{ name: "a.test" }] } }
          : { body: { message: "ok" } },
      "us",
    );
    await expect(c.listResources("mailgun-webhook", "a")).rejects.toThrow("is not a list");
  });

  it("reads a null list as empty, as Go serialises a nil slice", async () => {
    const { c } = client(() => ({ body: { total_count: 0, items: null } }), "us");
    expect(await c.listResources("mailgun-route", "a")).toEqual([]);
  });
});

describe("next links", () => {
  const evil = {
    items: [{ address: "l@x" }],
    paging: { next: "https://evil.example/v3/lists/pages?page=next" },
  };

  it("refuses to send the key to another host, through the region catch", async () => {
    const { c, calls } = client(() => ({ body: evil }));
    await expect(c.listResources("mailgun-mailing-list", "a")).rejects.toThrow(
      "Refusing to send the account's credentials there",
    );
    expect(calls.every((x) => x.url.host.endsWith("mailgun.net"))).toBe(true);
  });

  it("refuses plain HTTP on Mailgun's own host", async () => {
    const { c } = client(
      () => ({
        body: { items: [{ address: "l@x" }], paging: { next: "http://api.mailgun.net/x" } },
      }),
      "us",
    );
    await expect(c.listResources("mailgun-mailing-list", "a")).rejects.toThrow(
      "Refusing to send the account's credentials there",
    );
  });

  it("follows a link naming Mailgun's other API host", async () => {
    const { c, calls } = client(
      (url) =>
        url.host === "api.eu.mailgun.net"
          ? {
              body: {
                items: [{ address: "l@x" }],
                paging: { next: "https://api.mailgun.net/v3/lists/pages?page=next" },
              },
            }
          : { body: { items: [] } },
      "eu",
    );
    expect(await c.listResources("mailgun-mailing-list", "a")).toHaveLength(1);
    expect(calls).toHaveLength(2);
  });

  it("resolves a relative next link against the page it came from", async () => {
    const { c, calls } = client(
      (url) =>
        url.searchParams.get("page")
          ? { body: { items: [] } }
          : {
              body: {
                items: [{ address: "l@x" }],
                paging: { next: "/v3/lists/pages?page=next" },
              },
            },
      "eu",
    );
    expect(await c.listResources("mailgun-mailing-list", "a")).toHaveLength(1);
    expect(calls[1]!.url.href).toBe("https://api.eu.mailgun.net/v3/lists/pages?page=next");
  });
});

describe("regions", () => {
  const refuseWith = (status: number) => () => ({ status, body: { message: "no" } });

  it("a key every region rejects fails, rather than reading as no rows", async () => {
    const { c } = client(refuseWith(401));
    await expect(c.listResources("mailgun-route", "a")).rejects.toThrow("Mailgun API error 401");
    await expect(c.listResources("mailgun-domain", "a")).rejects.toThrow("Mailgun API error 401");
    await expect(c.listResources("mailgun-account", "a")).rejects.toThrow("Mailgun API error 401");
    expect(unread).not.toHaveBeenCalled();
  });

  it("a key only one region rejects keeps that region's stored rows", async () => {
    const { c } = client((url) =>
      url.host === "api.eu.mailgun.net"
        ? { status: 401, body: { message: "no" } }
        : { body: { total_count: 1, items: [{ id: "r1" }] } },
    );
    const routes = await c.listResources("mailgun-route", "a");
    expect(routes.map((r) => r.externalId)).toEqual(["us/r1"]);
    expect(namedPrefixes()).toEqual(["a:mailgun-route:eu/"]);
  });

  it("a region 401 keeps the stored rows of every type read from a shared domain list", async () => {
    const { c } = client((url) => {
      if (url.host === "api.eu.mailgun.net") return { status: 401, body: { message: "no" } };
      if (url.pathname === "/v4/domains") return { body: { total_count: 0, items: [] } };
      return { status: 404, body: { message: "no" } };
    });
    await c.listResources("mailgun-domain", "a");
    await c.listResources("mailgun-dns-record", "a");
    expect(namedPrefixes()).toEqual(["a:mailgun-domain:eu/", "a:mailgun-dns-record:eu/"]);
  });

  it("a region refusing with 403 while another answers reads as none", async () => {
    const { c } = client((url) =>
      url.host === "api.eu.mailgun.net"
        ? { status: 403, body: { message: "no" } }
        : { body: { total_count: 1, items: [{ id: "r1" }] } },
    );
    expect(await c.listResources("mailgun-route", "a")).toHaveLength(1);
    expect(unread).not.toHaveBeenCalled();
  });

  it("every region refusing with 403 keeps the rows quietly", async () => {
    const { c } = client(refuseWith(403));
    expect(await c.listResources("mailgun-route", "a")).toEqual([]);
    expect(namedPrefixes()).toEqual([""]);
  });

  it("every region refusing shows on a host that keeps no track", async () => {
    Reflect.deleteProperty(globalThis, UNREAD_HOOK);
    const { c } = client(refuseWith(403));
    await expect(c.listResources("mailgun-route", "a")).rejects.toThrow("Mailgun API error 403");
  });

  it("every region answering 404 reads as none", async () => {
    const { c } = client(refuseWith(404));
    expect(await c.listResources("mailgun-route", "a")).toEqual([]);
    expect(unread).not.toHaveBeenCalled();
  });

  it.each([429, 500])("one region answering %i fails the type", async (status) => {
    const { c } = client((url) =>
      url.host === "api.eu.mailgun.net"
        ? { status, body: { message: "later" } }
        : { body: { total_count: 1, items: [{ id: "r1" }] } },
    );
    await expect(c.listResources("mailgun-route", "a")).rejects.toThrow(
      `Mailgun API error ${status}`,
    );
  });
});

describe("account-level types", () => {
  it.each(["mailgun-api-key", "mailgun-account-webhook", "mailgun-ip-pool", "mailgun-ip"])(
    "%s keeps its rows when the key's role is refused",
    async (typeId) => {
      const { c } = client(() => ({ status: 403, body: { message: "no" } }), "us");
      expect(await c.listResources(typeId, "a")).toEqual([]);
      expect(namedPrefixes()).toEqual([""]);
    },
  );

  it("a refused role shows on a host that keeps no track", async () => {
    Reflect.deleteProperty(globalThis, UNREAD_HOOK);
    const { c } = client(() => ({ status: 403, body: { message: "no" } }), "us");
    await expect(c.listResources("mailgun-api-key", "a")).rejects.toThrow("Mailgun API error 403");
  });

  it("a route the account does not have reads as none", async () => {
    const { c } = client(() => ({ status: 404, body: { message: "no" } }), "us");
    expect(await c.listResources("mailgun-subaccount", "a")).toEqual([]);
    expect(unread).not.toHaveBeenCalled();
  });

  it("a failed pool read fails the IP type rather than blanking every IP's pools", async () => {
    const { c } = client(
      (url) =>
        url.pathname === "/v3/ip_pools"
          ? { status: 500, body: { message: "later" } }
          : { body: { total_count: 1, items: ["1.2.3.4"], details: [{ ip: "1.2.3.4" }] } },
      "us",
    );
    await expect(c.listResources("mailgun-ip", "a")).rejects.toThrow("Mailgun API error 500");
  });
});

describe("what fans out over domains", () => {
  const parentOf = (name: string) => `a:mailgun-domain:us/${name}`;
  const types: Array<[string, RegExp, (name: string) => unknown]> = [
    [
      "mailgun-smtp-credential",
      /\/credentials$/,
      (name) => ({ total_count: 1, items: [{ login: `pm@${name}` }] }),
    ],
    [
      "mailgun-webhook",
      /\/webhooks$/,
      () => ({ webhooks: { delivered: { urls: ["https://hook.test"] } } }),
    ],
    [
      "mailgun-dns-record",
      /^\/v4\/domains\/[^/]+$/,
      (name) => ({
        domain: { name },
        sending_dns_records: [{ record_type: "TXT", name, value: "v=spf1" }],
      }),
    ],
  ];

  /** Answers `failing`'s read with `status`, and every other domain's as it should. */
  function fanOut(child: RegExp, row: (name: string) => unknown, failing: string, status: number) {
    return client((url) => {
      if (url.pathname === "/v4/domains") return { body: DOMAIN_ROWS };
      if (!child.test(url.pathname)) return { status: 404, body: { message: "no" } };
      if (url.pathname.includes(failing)) return { status, body: { message: "failed" } };
      const name = url.pathname.includes("a.test") ? "a.test" : "b.test";
      return { body: row(name) };
    }, "us");
  }

  describe.each(types)("%s", (typeId, child, row) => {
    it.each([500, 401])("a domain answering %i fails the type", async (status) => {
      const { c } = fanOut(child, row, "b.test", status);
      await expect(c.listResources(typeId, "a")).rejects.toThrow(`Mailgun API error ${status}`);
    });

    it.each([400, 403])("a domain refused with %i keeps its rows", async (status) => {
      const { c } = fanOut(child, row, "b.test", status);
      const rows = await c.listResources(typeId, "a");
      expect(rows.length).toBeGreaterThan(0);
      expect(rows.every((r) => r.externalId?.includes("a.test"))).toBe(true);
      expect(namedParents()).toEqual([parentOf("b.test")]);
    });

    it("a domain gone since the list was read has nothing left", async () => {
      const { c } = fanOut(child, row, "b.test", 404);
      const rows = await c.listResources(typeId, "a");
      expect(rows.every((r) => r.externalId?.includes("a.test"))).toBe(true);
      expect(unread).not.toHaveBeenCalled();
    });

    it("a throttle keeps what it left unread", async () => {
      const { c } = fanOut(child, row, "b.test", 429);
      const rows = await c.listResources(typeId, "a");
      expect(rows.every((r) => r.externalId?.includes("a.test"))).toBe(true);
      expect(namedParents()).toEqual([parentOf("b.test")]);
    });

    it("a throttle shows on a host that keeps no track", async () => {
      Reflect.deleteProperty(globalThis, UNREAD_HOOK);
      const { c } = fanOut(child, row, "b.test", 429);
      await expect(c.listResources(typeId, "a")).rejects.toThrow("Mailgun API error 429");
    });
  });

  it("the domain rows of a domain whose detail was refused stay as they are", async () => {
    const { c } = fanOut(types[2]![1], types[2]![2], "b.test", 403);
    const rows = await c.listResources("mailgun-domain", "a");
    expect(rows.map((r) => r.externalId)).toEqual(["us/a.test"]);
    expect(namedPrefixes()).toEqual([parentOf("b.test")]);
    expect(namedParents()).toEqual([]);
  });

  it("each type reading the cached domains names what went unread for itself", async () => {
    const { c, calls } = fanOut(types[2]![1], types[2]![2], "b.test", 403);
    await c.listResources("mailgun-domain", "a");
    unread.mockReset();
    await c.listResources("mailgun-dns-record", "a");
    expect(calls.filter((x) => x.url.pathname === "/v4/domains")).toHaveLength(1);
    expect(namedParents()).toEqual([parentOf("b.test")]);
  });

  it("every domain refused shows on a host that keeps no track", async () => {
    Reflect.deleteProperty(globalThis, UNREAD_HOOK);
    const { c } = client(
      (url) =>
        url.pathname === "/v4/domains"
          ? { body: DOMAIN_ROWS }
          : { status: 403, body: { message: "no" } },
      "us",
    );
    await expect(c.listResources("mailgun-smtp-credential", "a")).rejects.toThrow(
      "Mailgun API error 403",
    );
  });

  it("one domain refused shows on a host that keeps no track", async () => {
    Reflect.deleteProperty(globalThis, UNREAD_HOOK);
    const { c } = fanOut(types[0]![1], types[0]![2], "b.test", 403);
    await expect(c.listResources("mailgun-smtp-credential", "a")).rejects.toThrow(
      "Mailgun API error 403",
    );
  });

  describe("past the request budget", () => {
    const many = Array.from({ length: 700 }, (_, i) => ({ name: `d${i}.test` }));
    const route = (url: URL): Answer => {
      if (url.pathname === "/v4/domains") return { body: { total_count: 700, items: many } };
      if (url.pathname.endsWith("/webhooks")) return { body: { webhooks: {} } };
      if (url.pathname.endsWith("/credentials")) return { body: { total_count: 0, items: [] } };
      const name = decodeURIComponent(url.pathname.split("/")[3] ?? "");
      return { body: { domain: { name } } };
    };
    const domainsRead = (calls: Array<{ url: URL }>, end: RegExp) =>
      calls.filter((x) => end.test(x.url.pathname)).map((x) => x.url.pathname.split("/")[3]);

    it("reads what fits and names the rest", async () => {
      const { c, calls } = client(route, "us");
      await c.listResources("mailgun-webhook", "a");
      const read = domainsRead(calls, /\/webhooks$/);
      expect(read).toHaveLength(500);
      expect(namedParents()).toHaveLength(200);
      expect(new Set([...read, ...namedParents().map((p) => p.split("/")[1])]).size).toBe(700);
    });

    it("gets round to every domain over later polls", async () => {
      vi.useFakeTimers();
      const seen = new Set<string | undefined>();
      for (let minute = 0; minute < 10; minute++) {
        vi.setSystemTime(Date.UTC(2026, 10, 7, 12, minute));
        const { c, calls } = client(route, "us");
        await c.listResources("mailgun-smtp-credential", "a");
        for (const d of domainsRead(calls, /\/credentials$/)) seen.add(d);
      }
      expect(seen.size).toBe(700);
    });

    it("keeps domain rows it did not read, without emptying the fields of the rest", async () => {
      const { c, calls } = client(route, "us");
      const rows = await c.listResources("mailgun-domain", "a");
      expect(rows).toHaveLength(500);
      expect(domainsRead(calls, /^\/v4\/domains\/[^/]+$/)).toHaveLength(500);
      expect(namedPrefixes()).toHaveLength(200);
      expect(namedPrefixes()[0]).toMatch(/^a:mailgun-domain:us\/d\d+\.test$/);
    });

    it("reads them all on a host that keeps no track", async () => {
      Reflect.deleteProperty(globalThis, UNREAD_HOOK);
      const { c, calls } = client(route, "us");
      await c.listResources("mailgun-webhook", "a");
      expect(domainsRead(calls, /\/webhooks$/)).toHaveLength(700);
    });

    it("reads every domain again where the host keeps no track of a cached read's rest", async () => {
      const { c, calls } = client(route, "us");
      await c.listResources("mailgun-domain", "a");
      Reflect.deleteProperty(globalThis, UNREAD_HOOK);
      await expect(c.listResources("mailgun-domain", "a")).resolves.toHaveLength(700);
      expect(domainsRead(calls, /^\/v4\/domains\/[^/]+$/)).toHaveLength(500 + 700);
    });

    it("still finds one child of a domain past the budget", async () => {
      const { c } = client((url) => {
        if (url.pathname === "/v3/domains/d699.test/webhooks")
          return { body: { webhooks: { delivered: { urls: ["https://hook.test"] } } } };
        return route(url);
      }, "us");
      const found = await c.getResource(
        "mailgun-webhook",
        "a:mailgun-webhook:us/d699.test/https://hook.test",
        "a",
      );
      expect(found.fields["url"]).toBe("https://hook.test");
    });
  });
});

describe("single reads of a domain's children", () => {
  it("reads one credential and one DNS record without listing every domain", async () => {
    const { c, calls } = client((url) => {
      if (url.pathname === "/v3/domains/a.test/credentials")
        return { body: { total_count: 1, items: [{ login: "pm@a.test" }] } };
      if (url.pathname === "/v4/domains/a.test")
        return {
          body: {
            domain: { name: "a.test" },
            sending_dns_records: [{ record_type: "TXT", name: "a.test", value: "v=spf1" }],
          },
        };
      if (url.pathname === "/v4/domains") throw new Error("listed every domain");
      return { status: 404, body: { message: "no" } };
    }, "us");
    const cred = await c.getResource(
      "mailgun-smtp-credential",
      "a:mailgun-smtp-credential:us/a.test/pm@a.test",
      "a",
    );
    expect(cred.fields["login"]).toBe("pm@a.test");
    const rec = await c.getResource(
      "mailgun-dns-record",
      "a:mailgun-dns-record:us/a.test/sending/0",
      "a",
    );
    expect(rec.fields["type"]).toBe("TXT");
    expect(calls.some((x) => x.url.pathname === "/v4/domains")).toBe(false);
  });

  it("answers not found for a child that is gone or an id with no domain", async () => {
    const { c } = client(() => ({ body: { webhooks: {} } }), "us");
    await expect(
      c.getResource("mailgun-webhook", "a:mailgun-webhook:us/a.test/https://gone.test", "a"),
    ).rejects.toThrow("not found");
    await expect(c.getResource("mailgun-webhook", "a:mailgun-webhook:us/", "a")).rejects.toThrow(
      "not found",
    );
  });
});

describe("edits that merge with what is there", () => {
  const WEBHOOK_ID = "a:mailgun-webhook:us/a.test/https://hook.test";

  it("keeps a webhook's other events, reading only its own domain", async () => {
    const { c, calls } = client((url, method) => {
      if (url.pathname === "/v3/domains/a.test/webhooks")
        return {
          body: {
            webhooks: {
              delivered: { urls: ["https://hook.test"] },
              opened: { urls: ["https://hook.test"] },
            },
          },
        };
      if (url.pathname === "/v4/domains/a.test/webhooks" && method === "PUT") return { body: {} };
      throw new Error(`Unexpected ${method} ${url.pathname}`);
    }, "us");
    await c.updateResource("mailgun-webhook", WEBHOOK_ID, "a", { clicked: "true" });
    const put = calls.find((x) => x.method === "PUT")!;
    expect(new URLSearchParams(put.body).getAll("event_types").sort()).toEqual([
      "clicked",
      "delivered",
      "opened",
    ]);
  });

  it("writes nothing to a webhook whose events could not be read", async () => {
    const { c, calls } = client(() => ({ status: 500, body: { message: "later" } }), "us");
    await expect(
      c.updateResource("mailgun-webhook", WEBHOOK_ID, "a", { clicked: "true" }),
    ).rejects.toThrow("Mailgun API error 500");
    expect(calls.some((x) => x.method === "PUT")).toBe(false);
  });

  it("writes nothing to a webhook that is no longer there", async () => {
    const { c, calls } = client(() => ({ body: { webhooks: {} } }), "us");
    await expect(
      c.updateResource("mailgun-webhook", WEBHOOK_ID, "a", { clicked: "true" }),
    ).rejects.toThrow("not found");
    expect(calls.some((x) => x.method === "PUT")).toBe(false);
  });

  it("does not blank an account webhook's URL when its role cannot read them", async () => {
    const { c, calls } = client(() => ({ status: 403, body: { message: "no" } }), "us");
    await expect(
      c.updateResource("mailgun-account-webhook", "a:mailgun-account-webhook:w1", "a", {
        delivered: "true",
      }),
    ).rejects.toThrow();
    expect(calls.some((x) => x.method === "PUT")).toBe(false);
  });
});
