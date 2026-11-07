import { hostClient } from "@infrawrench/plugin-base/effect";
import { afterEach, describe, expect, it } from "vitest";
import { fastlyCursorPaged, fastlyJsonApiPaged, fastlyPaged } from "../api.js";
import { FastlyClient } from "../client.js";
import { ctxWith, makeHttp } from "./helpers.js";
import type { Reply } from "./helpers.js";

const ACCOUNT = "acc1";
const CAP = "has more than Infrawrench reads";
const NOT_A_LIST = "is not a list";

function ids(count: number, from = 0) {
  return Array.from({ length: count }, (_, i) => ({ id: `s${from + i}` }));
}

function pageOf(url: URL) {
  return Number(url.searchParams.get("page") ?? url.searchParams.get("page[number]") ?? 0);
}

function clientWith(route: (url: URL) => Reply) {
  const { http, calls } = makeHttp(route);
  return { c: hostClient(new FastlyClient({ apiToken: "test-token" }, { http } as never)), calls };
}

const SERVICE = { id: "SU1", name: "www", type: "vcl", version: 2 };
const DETAIL = {
  ...SERVICE,
  versions: [{ number: 2, active: true }],
  active_version: { number: 2 },
};

function serviceRoute(url: URL): Reply | undefined {
  if (url.pathname === "/service") return { body: pageOf(url) === 1 ? [SERVICE] : [] };
  if (url.pathname === "/service/SU1/details") return { body: DETAIL };
  return undefined;
}

describe("classic lists (page, per_page)", () => {
  it("throws at the cap with more to read, after exactly the cap's requests", async () => {
    const { http, calls } = makeHttp((url) => ({ body: ids(100, pageOf(url) * 100) }));
    await expect(fastlyPaged(ctxWith(http), "/service")).rejects.toThrow(CAP);
    expect(calls).toHaveLength(100);
  });

  it("reads a list past the old 5,000-row stop", async () => {
    const { http } = makeHttp((url) => ({
      body: pageOf(url) <= 60 ? ids(100, pageOf(url) * 100) : [],
    }));
    await expect(fastlyPaged(ctxWith(http), "/service")).resolves.toHaveLength(6000);
  });

  it("refuses a page that is not a list, on the first page and a later one", async () => {
    const first = makeHttp(() => ({ body: { msg: "degraded" } }));
    await expect(fastlyPaged(ctxWith(first.http), "/service")).rejects.toThrow(NOT_A_LIST);
    const later = makeHttp((url) => ({ body: pageOf(url) === 1 ? ids(100) : { msg: "degraded" } }));
    await expect(fastlyPaged(ctxWith(later.http), "/service")).rejects.toThrow(NOT_A_LIST);
  });

  it("refuses an empty body rather than reading it as the end", async () => {
    const { http } = makeHttp(() => ({}));
    await expect(fastlyPaged(ctxWith(http), "/service")).rejects.toThrow(NOT_A_LIST);
  });

  it("keeps reading a short page when the Link header says there is a next one", async () => {
    // A server that serves fewer than the per_page it was asked for looks like the last page.
    const { http, calls } = makeHttp((url) =>
      pageOf(url) === 1
        ? {
            body: ids(100),
            headers: { link: '<https://api.fastly.com/x?page=2>; rel="next"' },
          }
        : { body: ids(40, 100) },
    );
    await expect(fastlyPaged(ctxWith(http), "/x", {}, 1000)).resolves.toHaveLength(140);
    expect(calls).toHaveLength(2);
  });

  it("uses a Link header only to know there is more, never as a place to send the token", async () => {
    const { http, calls } = makeHttp((url) =>
      pageOf(url) === 1
        ? { body: ids(1), headers: { link: '<https://evil.example/x?page=2>; rel="next"' } }
        : { body: [] },
    );
    await fastlyPaged(ctxWith(http), "/x");
    expect(calls.map((c) => c.url.host)).toEqual(["api.fastly.com", "api.fastly.com"]);
  });

  it("stops on a short page with no Link header, with no extra request", async () => {
    const { http, calls } = makeHttp(() => ({ body: ids(3) }));
    await expect(fastlyPaged(ctxWith(http), "/x")).resolves.toHaveLength(3);
    expect(calls).toHaveLength(1);
  });
});

describe("JSON:API lists (page[number], page[size])", () => {
  it("throws at the cap with more to read, after exactly the cap's requests", async () => {
    const { http, calls } = makeHttp(() => ({ body: { data: ids(100), meta: {} } }));
    await expect(fastlyJsonApiPaged(ctxWith(http), "/tls/certificates")).rejects.toThrow(CAP);
    expect(calls).toHaveLength(100);
  });

  it("reads a list past the old 5,000-row stop", async () => {
    const { http } = makeHttp((url) => ({
      body: { data: ids(100, pageOf(url) * 100), meta: { total_pages: 60 } },
    }));
    const { data } = await fastlyJsonApiPaged(ctxWith(http), "/tls/certificates");
    expect(data).toHaveLength(6000);
  });

  it("refuses a page whose data is not a list, on the first page and a later one", async () => {
    const first = makeHttp(() => ({ body: { errors: [{ title: "degraded" }] } }));
    await expect(fastlyJsonApiPaged(ctxWith(first.http), "/x")).rejects.toThrow(NOT_A_LIST);
    const later = makeHttp((url) => ({
      body: pageOf(url) === 1 ? { data: ids(100), meta: { total_pages: 2 } } : { rows: [] },
    }));
    await expect(fastlyJsonApiPaged(ctxWith(later.http), "/x")).rejects.toThrow(NOT_A_LIST);
  });

  it("trusts total_pages over a short page", async () => {
    const { http, calls } = makeHttp((url) => ({
      body: { data: ids(20, pageOf(url) * 20), meta: { total_pages: 3 } },
    }));
    const { data } = await fastlyJsonApiPaged(ctxWith(http), "/x");
    expect(data).toHaveLength(60);
    expect(calls).toHaveLength(3);
  });

  it("stops on a full last page when total_pages says it is the last", async () => {
    const { http, calls } = makeHttp(() => ({
      body: { data: ids(100), meta: { total_pages: 1 } },
    }));
    await fastlyJsonApiPaged(ctxWith(http), "/x");
    expect(calls).toHaveLength(1);
  });

  it("refuses an empty page that says there is more", async () => {
    const { http, calls } = makeHttp(() => ({ body: { data: [], meta: { total_pages: 5 } } }));
    await expect(fastlyJsonApiPaged(ctxWith(http), "/x")).rejects.toThrow("says there is more");
    expect(calls).toHaveLength(1);
  });

  it("reads an empty account as empty", async () => {
    const { http } = makeHttp(() => ({ body: { data: [], meta: { total_pages: 0 } } }));
    await expect(fastlyJsonApiPaged(ctxWith(http), "/x")).resolves.toEqual({
      data: [],
      included: [],
    });
  });
});

describe("cursor lists (cursor, limit)", () => {
  it("throws at the cap with more to read, after exactly the cap's requests", async () => {
    const { http, calls } = makeHttp(() => ({
      body: { data: ids(1), meta: { next_cursor: "more" } },
    }));
    await expect(fastlyCursorPaged(ctxWith(http), "/resources/stores/kv")).rejects.toThrow(CAP);
    expect(calls).toHaveLength(100);
  });

  it("refuses a page whose data is not a list, on the first page and a later one", async () => {
    const first = makeHttp(() => ({ body: { stores: [] } }));
    await expect(fastlyCursorPaged(ctxWith(first.http), "/x")).rejects.toThrow(NOT_A_LIST);
    const later = makeHttp((url) => ({
      body: url.searchParams.get("cursor")
        ? { msg: "degraded" }
        : { data: ids(1), meta: { next_cursor: "more" } },
    }));
    await expect(fastlyCursorPaged(ctxWith(later.http), "/x")).rejects.toThrow(NOT_A_LIST);
  });

  it("reads the recorded empty answer and a null list as empty", async () => {
    const empty = makeHttp(() => ({ body: { data: [], meta: { limit: 1000, total: 0 } } }));
    await expect(fastlyCursorPaged(ctxWith(empty.http), "/x")).resolves.toEqual([]);
    const nil = makeHttp(() => ({ body: { data: null, meta: { limit: 200 } } }));
    await expect(fastlyCursorPaged(ctxWith(nil.http), "/x")).resolves.toEqual([]);
  });
});

describe("lists answered as one bare array", () => {
  it("refuses a config store list that is not an array", async () => {
    const { c } = clientWith(() => ({ body: { msg: "degraded" } }));
    await expect(c.listResources("config-store", ACCOUNT)).rejects.toThrow(NOT_A_LIST);
  });

  it("refuses an API token list that is not an array", async () => {
    const { c } = clientWith((url) => {
      if (url.pathname === "/tokens") return { body: { msg: "degraded" } };
      return serviceRoute(url) ?? { status: 404, body: {} };
    });
    await expect(c.listResources("api-token", ACCOUNT)).rejects.toThrow(NOT_A_LIST);
  });

  it("refuses a logging list that is not an array", async () => {
    const { c } = clientWith((url) => {
      if (url.pathname.includes("/logging/")) return { body: { msg: "degraded" } };
      return serviceRoute(url) ?? { status: 404, body: {} };
    });
    await expect(c.listResources("logging-endpoint", ACCOUNT)).rejects.toThrow(NOT_A_LIST);
  });

  it("refuses a dictionary list that is not an array", async () => {
    const { c } = clientWith((url) => {
      if (url.pathname.endsWith("/dictionary")) return { body: { msg: "degraded" } };
      return serviceRoute(url) ?? { status: 404, body: {} };
    });
    await expect(c.listResources("dictionary", ACCOUNT)).rejects.toThrow(NOT_A_LIST);
  });

  it("refuses a config store's items that are not an array", async () => {
    const { c } = clientWith(() => ({ body: { msg: "degraded" } }));
    await expect(
      c.listKvKeys("config-store", `${ACCOUNT}:config-store:cs1`, ACCOUNT),
    ).rejects.toThrow(NOT_A_LIST);
  });

  it("refuses a KV store's keys that are not a list", async () => {
    const { c } = clientWith(() => ({ body: { keys: [] } }));
    await expect(c.listKvKeys("kv-store", `${ACCOUNT}:kv-store:kv1`, ACCOUNT)).rejects.toThrow(
      NOT_A_LIST,
    );
  });
});

describe("catches around the service list", () => {
  const endless = (url: URL): Reply => {
    if (url.pathname === "/service") return { body: ids(100, pageOf(url) * 100) };
    if (url.pathname === "/tokens") return { body: [] };
    return { body: {} };
  };

  it("does not read a truncated service list as no services for the tokens", async () => {
    const { c } = clientWith(endless);
    await expect(c.listResources("api-token", ACCOUNT)).rejects.toThrow(CAP);
  });

  it("does not read a truncated service list as no services for the account", async () => {
    const { c } = clientWith(endless);
    await expect(c.listResources("account", ACCOUNT)).rejects.toThrow(CAP);
  });

  it("still lists tokens when the service list only failed", async () => {
    const { c } = clientWith((url) => {
      if (url.pathname === "/service") return { status: 500, body: {} };
      if (url.pathname === "/tokens") return { body: [{ id: "t1", name: "ci" }] };
      return { body: {} };
    });
    await expect(c.listResources("api-token", ACCOUNT)).resolves.toHaveLength(1);
  });
});

describe("a refused list keeps its stored rows", () => {
  const HOOK = Symbol.for("infrawrench.unreadListPart");
  afterEach(() => {
    Reflect.deleteProperty(globalThis, HOOK);
  });

  function trackUnread() {
    const parts: Array<{ parentResourceIds?: readonly string[]; idPrefixes?: readonly string[] }> =
      [];
    Reflect.set(globalThis, HOOK, (part: (typeof parts)[number]) => {
      parts.push(part);
    });
    return parts;
  }

  it("reports the whole type on a 403, where a host keeps track", async () => {
    const parts = trackUnread();
    const { c } = clientWith(() => ({ status: 403, body: { msg: "Forbidden" } }));
    await expect(c.listResources("kv-store", ACCOUNT)).resolves.toEqual([]);
    expect(parts).toEqual([{ idPrefixes: [""] }]);
  });

  it("shows the refusal where no host keeps track", async () => {
    const { c } = clientWith(() => ({ status: 403, body: { msg: "Forbidden" } }));
    await expect(c.listResources("kv-store", ACCOUNT)).rejects.toThrow(/403/);
  });

  it("does not read a throttle or an outage as a refusal", async () => {
    trackUnread();
    for (const status of [429, 500, 401]) {
      const { c } = clientWith(() => ({ status, body: {} }));
      await expect(c.listResources("kv-store", ACCOUNT)).rejects.toThrow(String(status));
    }
  });

  const refusedOne = (url: URL): Reply => {
    if (url.pathname === "/service") {
      return {
        body:
          pageOf(url) === 1
            ? [SERVICE, { id: "SU2", name: "limited", type: "vcl", version: 1 }]
            : [],
      };
    }
    if (url.pathname === "/service/SU1/details") return { body: DETAIL };
    if (url.pathname.startsWith("/service/SU2")) return { status: 403, body: {} };
    return { body: [] };
  };

  it.each(["domain", "backend"])(
    "keeps the %s rows of a service whose details were refused",
    async (type) => {
      const parts = trackUnread();
      const { c } = clientWith(refusedOne);
      await expect(c.listResources(type, ACCOUNT)).resolves.toEqual([]);
      expect(parts).toEqual([{ parentResourceIds: [`${ACCOUNT}:service:SU2`] }]);
    },
  );

  it("names no parent when every service's details were read", async () => {
    const parts = trackUnread();
    const { c } = clientWith((url) => serviceRoute(url) ?? { body: [] });
    await c.listResources("domain", ACCOUNT);
    expect(parts).toEqual([]);
  });

  const oneServiceRefuses = (url: URL): Reply => {
    if (url.pathname === "/service") {
      return {
        body:
          pageOf(url) === 1
            ? [SERVICE, { id: "SU2", type: "vcl", versions: [{ number: 1, active: true }] }]
            : [],
      };
    }
    if (url.pathname === "/service/SU1/details") return { body: DETAIL };
    if (url.pathname.startsWith("/service/SU2")) return { status: 403, body: {} };
    return { body: [] };
  };

  it("keeps the logging endpoints of the kinds a service refuses, and no others", async () => {
    const parts = trackUnread();
    const { c } = clientWith((url) => {
      if (url.pathname === "/service/SU1/version/2/logging/s3") {
        return { status: 403, body: {} };
      }
      return oneServiceRefuses(url);
    });
    await expect(c.listResources("logging-endpoint", ACCOUNT)).resolves.toEqual([]);
    const prefixes = parts.flatMap((p) => p.idPrefixes ?? []);
    expect(prefixes).toContain(`${ACCOUNT}:logging-endpoint:SU1/s3/`);
    expect(prefixes).not.toContain(`${ACCOUNT}:logging-endpoint:SU1/datadog/`);
    expect(prefixes).toContain(`${ACCOUNT}:logging-endpoint:SU2/datadog/`);
  });

  it("reports the whole logging type when every read is refused", async () => {
    const parts = trackUnread();
    const { c } = clientWith((url) => {
      if (url.pathname.includes("/logging/")) return { status: 403, body: {} };
      return serviceRoute(url) ?? { body: [] };
    });
    await expect(c.listResources("logging-endpoint", ACCOUNT)).resolves.toEqual([]);
    expect(parts).toEqual([{ idPrefixes: [""] }]);
  });

  it("shows a logging refusal that covers everything where no host keeps track", async () => {
    const { c } = clientWith((url) => {
      if (url.pathname.includes("/logging/")) return { status: 403, body: {} };
      return serviceRoute(url) ?? { body: [] };
    });
    await expect(c.listResources("logging-endpoint", ACCOUNT)).rejects.toThrow(/403/);
  });

  it("does not keep the logging rows of a kind that answers 404", async () => {
    const parts = trackUnread();
    const { c } = clientWith((url) => {
      if (url.pathname.includes("/logging/")) return { status: 404, body: {} };
      return serviceRoute(url) ?? { body: [] };
    });
    await expect(c.listResources("logging-endpoint", ACCOUNT)).resolves.toEqual([]);
    expect(parts).toEqual([]);
  });

  it("keeps the dictionaries of a service that refuses them", async () => {
    const parts = trackUnread();
    const { c } = clientWith(oneServiceRefuses);
    await expect(c.listResources("dictionary", ACCOUNT)).resolves.toEqual([]);
    expect(parts).toEqual([{ parentResourceIds: [`${ACCOUNT}:service:SU2`] }]);
  });

  it("reports the whole dictionary type when every service refuses", async () => {
    const parts = trackUnread();
    const { c } = clientWith((url) => {
      if (url.pathname.endsWith("/dictionary")) return { status: 403, body: {} };
      return serviceRoute(url) ?? { body: [] };
    });
    await expect(c.listResources("dictionary", ACCOUNT)).resolves.toEqual([]);
    expect(parts).toEqual([{ idPrefixes: [""] }]);
  });
});
