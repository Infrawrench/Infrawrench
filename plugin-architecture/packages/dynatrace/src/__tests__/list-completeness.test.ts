import { hostClient } from "@infrawrench/plugin-base/effect";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DynatraceClient } from "../client.js";
import { resetDpsTokenCacheForTests } from "../cost-data.js";
import type { Reply } from "./helpers.js";
import { CREDS, makeHttp } from "./helpers.js";

const LISTS = [
  ["host", "/api/v2/entities", "entities", 200],
  ["problem", "/api/v2/problems", "problems", 200],
  ["slo", "/api/v2/slo", "slo", 400],
  ["alerting-profile", "/api/v2/settings/objects", "items", 200],
  ["maintenance-window", "/api/v2/settings/objects", "items", 200],
  ["api-token", "/api/v2/apiTokens", "apiTokens", 10],
] as const;

const client = (route: (url: URL) => Reply | undefined) => {
  const { http, calls } = makeHttp(route);
  return { c: hostClient(new DynatraceClient(CREDS, { http })), calls };
};

beforeEach(() => {
  resetDpsTokenCacheForTests();
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      throw new Error(`unexpected request to ${url}`);
    }),
  );
});

afterEach(() => vi.unstubAllGlobals());

describe.each(LISTS)("listing %s", (type, path, key, maxPages) => {
  it("throws at the cap instead of returning part of the list", async () => {
    const { c, calls } = client((url) =>
      url.pathname === path ? { body: { [key]: [], nextPageKey: "more" } } : undefined,
    );
    await expect(c.listResources(type, "acct")).rejects.toThrow("has more than Infrawrench reads");
    expect(calls).toHaveLength(maxPages);
  });

  it("refuses a renamed key on the first page", async () => {
    const { c } = client((url) => (url.pathname === path ? { body: { rows: [] } } : undefined));
    await expect(c.listResources(type, "acct")).rejects.toThrow("is not a list");
  });

  it("refuses a renamed key on a later page", async () => {
    const { c } = client((url) => {
      if (url.pathname !== path) return undefined;
      return url.searchParams.has("nextPageKey")
        ? { body: { rows: [] } }
        : { body: { [key]: [], nextPageKey: "p2" } };
    });
    await expect(c.listResources(type, "acct")).rejects.toThrow("is not a list");
  });

  it("reads a list set to null as empty", async () => {
    const { c } = client((url) =>
      url.pathname === path ? { body: { [key]: null, nextPageKey: null } } : undefined,
    );
    await expect(c.listResources(type, "acct")).resolves.toEqual([]);
  });
});

describe("a type the token is refused", () => {
  const UNREAD_HOOK = Symbol.for("infrawrench.unreadListPart");
  const refused = { status: 403, body: { error: { code: 403, message: "Missing scope" } } };
  const TYPES = [
    ...LISTS.map(([type, path]) => [type, path] as const),
    ["synthetic-monitor", "/api/v1/synthetic/monitors"] as const,
  ];

  afterEach(() => {
    Reflect.deleteProperty(globalThis, UNREAD_HOOK);
  });

  it.each(TYPES)("keeps stored %s rows on a 403", async (type, path) => {
    const unread = vi.fn();
    Reflect.set(globalThis, UNREAD_HOOK, unread);
    const { c } = client((url) => (url.pathname === path ? refused : undefined));
    await expect(c.listResources(type, "acct")).resolves.toEqual([]);
    expect(unread).toHaveBeenCalledWith({ idPrefixes: [""] });
  });

  it.each(TYPES)("shows the %s refusal where the host keeps no track", async (type, path) => {
    const { c } = client((url) => (url.pathname === path ? refused : undefined));
    await expect(c.listResources(type, "acct")).rejects.toThrow("Missing scope");
  });

  it.each([401, 429, 500])("still fails the type on a %i", async (status) => {
    const unread = vi.fn();
    Reflect.set(globalThis, UNREAD_HOOK, unread);
    const { c } = client(() => ({ status, body: { error: { code: status, message: "no" } } }));
    await expect(c.listResources("slo", "acct")).rejects.toThrow(String(status));
    expect(unread).not.toHaveBeenCalled();
  });
});

describe("page sizes", () => {
  it("asks for the largest page the access token list documents", async () => {
    const { c, calls } = client((url) =>
      url.pathname === "/api/v2/apiTokens" ? { body: { apiTokens: [] } } : undefined,
    );
    await c.listResources("api-token", "acct");
    expect(calls[0]?.url.searchParams.get("pageSize")).toBe("10000");
  });
});

describe("listing synthetic monitors", () => {
  it("refuses an answer with no monitor list rather than emptying the type", async () => {
    const { c } = client((url) =>
      url.pathname === "/api/v1/synthetic/monitors" ? { body: { items: [] } } : undefined,
    );
    await expect(c.listResources("synthetic-monitor", "acct")).rejects.toThrow("is not a list");
  });
});

describe("platform subscription cost", () => {
  const CREDS_WITH_COST = {
    ...CREDS,
    accountUuid: "acct-uuid",
    oauthClientId: "client",
    oauthClientSecret: "secret",
  };
  const RANGE = { fromDate: "2026-10-01", toDate: "2026-10-02" };
  const COST = "/subscriptions/sub-1/environments/cost";

  const cost = (route: (url: URL) => Reply | undefined) => {
    const { http, calls } = makeHttp((url) => {
      if (url.hostname === "sso.dynatrace.com") return { body: { access_token: "tok" } };
      if (url.pathname.endsWith("/subscriptions")) {
        return { body: { data: [{ uuid: "sub-1", name: "Main" }] } };
      }
      return route(url);
    });
    const c = hostClient(new DynatraceClient(CREDS_WITH_COST, { http }));
    return { c, costCalls: () => calls.filter((call) => call.url.pathname.endsWith(COST)) };
  };

  it("throws at the cap instead of returning part of the cost", async () => {
    const { c, costCalls } = cost(() => ({ body: { data: [], nextPageKey: "more" } }));
    await expect(c.fetchCostData("acct", RANGE)).rejects.toThrow("has more than Infrawrench reads");
    expect(costCalls()).toHaveLength(1000);
  });

  it("refuses a cost page with its key renamed", async () => {
    const { c } = cost(() => ({ body: { rows: [] } }));
    await expect(c.fetchCostData("acct", RANGE)).rejects.toThrow("is not a list");
  });

  it("refuses a later cost page with its key renamed", async () => {
    const { c } = cost((url) =>
      url.search.includes("startTime")
        ? { body: { data: [], nextPageKey: "p2" } }
        : { body: { rows: [] } },
    );
    await expect(c.fetchCostData("acct", RANGE)).rejects.toThrow("is not a list");
  });

  it("refuses a subscription list with its key renamed", async () => {
    const { http } = makeHttp((url) => {
      if (url.hostname === "sso.dynatrace.com") return { body: { access_token: "tok" } };
      return url.pathname.endsWith("/subscriptions") ? { body: { rows: [] } } : undefined;
    });
    const c = hostClient(new DynatraceClient(CREDS_WITH_COST, { http }));
    await expect(c.fetchCostData("acct", RANGE)).rejects.toThrow("is not a list");
  });
});

describe("the cost route", () => {
  const CREDS_WITH_COST = {
    ...CREDS,
    accountUuid: "acct-uuid",
    oauthClientId: "client",
    oauthClientSecret: "secret",
  };
  const RANGE = { fromDate: "2026-10-01", toDate: "2026-10-01" };
  const V3 = "/sub/v3/accounts/acct-uuid/subscriptions/sub-1/environments/cost";
  const V2 = "/sub/v2/accounts/acct-uuid/subscriptions/sub-1/environments/cost";
  const page = (value: number, nextPageKey?: string) => ({
    body: {
      data: [
        {
          environmentId: "abc12345",
          cost: [{ startTime: "2026-10-01T00:00:00Z", value, capabilityName: "Hosts" }],
        },
      ],
      ...(nextPageKey ? { nextPageKey } : {}),
    },
  });

  const cost = (route: (url: URL) => Reply | undefined) => {
    const { http, calls } = makeHttp((url) => {
      if (url.hostname === "sso.dynatrace.com") return { body: { access_token: "tok" } };
      if (url.pathname.endsWith("/subscriptions")) {
        return { body: { data: [{ uuid: "sub-1", name: "Main" }] } };
      }
      return route(url);
    });
    const c = hostClient(new DynatraceClient(CREDS_WITH_COST, { http }));
    return {
      c,
      costCalls: () => calls.filter((call) => call.url.pathname.endsWith("/environments/cost")),
    };
  };

  it("reads the documented route and pages with page-key", async () => {
    const { c, costCalls } = cost((url) => {
      if (url.pathname !== V3) return undefined;
      return url.searchParams.get("page-key") === "p2" ? page(2) : page(1, "p2");
    });
    const rows = await c.fetchCostData("acct", RANGE);
    expect(rows.map((r) => r.amount)).toEqual([3]);
    expect(costCalls().map((call) => call.url.pathname)).toEqual([V3, V3]);
    expect(Object.fromEntries(costCalls()[1]?.url.searchParams ?? [])).toEqual({
      "page-key": "p2",
      environmentIds: "abc12345",
    });
    expect(costCalls()[0]?.url.searchParams.get("startTime")).toBe("2026-10-01T00:00:00Z");
  });

  it.each([400, 403, 404, 405, 410])("falls back to v2 when v3 answers %i", async (status) => {
    const { c, costCalls } = cost((url) => {
      if (url.pathname === V3) return { status, body: { error: { message: "no" } } };
      if (url.pathname !== V2) return undefined;
      return url.searchParams.get("nextPageKey") === "p2" ? page(2) : page(1, "p2");
    });
    const rows = await c.fetchCostData("acct", RANGE);
    expect(rows.map((r) => r.amount)).toEqual([3]);
    expect(costCalls().map((call) => call.url.pathname)).toEqual([V3, V2, V2]);
    expect(Object.fromEntries(costCalls()[2]?.url.searchParams ?? [])).toEqual({
      nextPageKey: "p2",
    });
  });

  it("does not ask v3 again for the rest of a read once it refused", async () => {
    const { c, costCalls } = cost((url) =>
      url.pathname === V3 ? { status: 404, body: { error: { message: "no" } } } : page(1),
    );
    await c.fetchCostData("acct", { fromDate: "2026-08-01", toDate: "2026-10-15" });
    expect(costCalls().map((call) => call.url.pathname)).toEqual([V3, V2, V2, V2]);
  });

  it.each([401, 429, 500])("does not fall back on a %i", async (status) => {
    const { c, costCalls } = cost(() => ({ status, body: { error: { message: "no" } } }));
    await expect(c.fetchCostData("acct", RANGE)).rejects.toThrow(String(status));
    expect(costCalls().map((call) => call.url.pathname)).toEqual([V3]);
  });

  it("fails the read when a later v3 page is refused, without mixing routes", async () => {
    const { c, costCalls } = cost((url) =>
      url.searchParams.has("page-key")
        ? { status: 400, body: { error: { message: "no" } } }
        : page(1, "p2"),
    );
    await expect(c.fetchCostData("acct", RANGE)).rejects.toThrow("400");
    expect(costCalls().map((call) => call.url.pathname)).toEqual([V3, V3]);
  });

  it("names the v2 refusal when both routes refuse", async () => {
    const { c, costCalls } = cost((url) => ({
      status: 403,
      body: { error: { message: url.pathname === V2 ? "v2 says no" : "v3 says no" } },
    }));
    await expect(c.fetchCostData("acct", RANGE)).rejects.toThrow("v2 says no");
    expect(costCalls()).toHaveLength(2);
  });
});
