import { hostClient } from "@infrawrench/plugin-base/effect";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { HostServices, ResourceInstance } from "@infrawrench/plugin-base";
import { OktaClient } from "../client.js";
import { normalizeOrgUrl, rateLimitBucket } from "../api.js";
import { parseStatusFeed } from "../status-feed.js";
import { oktaTerraformExport } from "../terraform.js";

const ACCOUNT = "acct";
const ORG = "https://acme.okta.com";

interface Call {
  url: string;
  method: string;
  headers: Record<string, string>;
  body?: string;
}
interface Reply {
  status?: number;
  body?: unknown;
  headers?: Record<string, string>;
}

let calls: Call[] = [];

function services(handler: (call: Call) => Reply): HostServices {
  return {
    http: {
      request: async (req) => {
        const call: Call = {
          url: req.url,
          method: req.method,
          headers: req.headers,
          ...(typeof req.body === "string" ? { body: req.body } : {}),
        };
        calls.push(call);
        const res = handler(call);
        return {
          status: res.status ?? 200,
          headers: res.headers ?? {},
          body:
            res.body === undefined
              ? ""
              : typeof res.body === "string"
                ? res.body
                : JSON.stringify(res.body),
        };
      },
    },
  };
}

function ssws(handler: (call: Call) => Reply) {
  return hostClient(
    new OktaClient({ orgUrl: "acme-admin.okta.com", apiToken: "tok" }, services(handler)),
  );
}

function decodeJwt(jwt: string): {
  header: Record<string, unknown>;
  claims: Record<string, unknown>;
} {
  const [h, c] = jwt.split(".");
  const dec = (s: string) => JSON.parse(atob(s.replace(/-/g, "+").replace(/_/g, "/")));
  return { header: dec(h!), claims: dec(c!) };
}

beforeEach(() => {
  calls = [];
});

describe("credentials", () => {
  it("needs an API token or a service app key", () => {
    expect(() => hostClient(new OktaClient({ orgUrl: ORG }))).toThrow(/API token/);
    expect(() => hostClient(new OktaClient({ orgUrl: ORG, clientId: "x" }))).toThrow(/private key/);
  });

  it("maps the admin console host to the org host", () => {
    expect(normalizeOrgUrl("acme-admin.okta.com")).toBe("https://acme.okta.com");
    expect(normalizeOrgUrl("https://dev-1-admin.oktapreview.com/admin/dashboard")).toBe(
      "https://dev-1.oktapreview.com",
    );
    expect(normalizeOrgUrl("https://login.example.com")).toBe("https://login.example.com");
  });
});

describe("SSWS transport", () => {
  it("sends the SSWS header and follows Link pagination", async () => {
    const client = ssws((call) => {
      if (call.url === `${ORG}/api/v1/users?limit=200`) {
        return {
          body: [{ id: "u1", status: "ACTIVE", profile: { login: "ada@example.com" } }],
          headers: {
            link: `<${ORG}/api/v1/users?limit=200>; rel="self", <${ORG}/api/v1/users?after=u1&limit=200>; rel="next"`,
          },
        };
      }
      return { body: [{ id: "u2", status: "LOCKED_OUT", profile: { login: "bob@example.com" } }] };
    });
    const users = await client.listResources("user", ACCOUNT);
    expect(users.map((u) => u.externalId)).toEqual(["u1", "u2"]);
    expect(calls[0]!.headers["Authorization"]).toBe("SSWS tok");
    expect(calls[1]!.url).toBe(`${ORG}/api/v1/users?after=u1&limit=200`);
    expect(client.renderSidebarItem(users[1]!).status?.status).toBe("error");
  });

  it("surfaces Okta's errorSummary and the HTTP status", async () => {
    const client = ssws(() => ({
      status: 403,
      body: {
        errorCode: "E0000006",
        errorSummary: "You do not have permission to perform the requested action",
        errorCauses: [],
      },
    }));
    const error = (await client
      .getResource("user", `${ACCOUNT}:user:u1`, ACCOUNT)
      .catch((e) => e)) as Error & { status?: number };
    expect(error.status).toBe(403);
    expect(error.message).toContain("You do not have permission");
    expect(error.message).toContain("E0000006");
  });

  it("deactivates a user before deleting", async () => {
    const client = ssws((call) =>
      call.method === "GET" ? { body: { id: "u1", status: "ACTIVE" } } : { status: 204 },
    );
    await client.deleteResource("user", `${ACCOUNT}:user:u1`);
    expect(calls.map((c) => `${c.method} ${new URL(c.url).pathname}`)).toEqual([
      "GET /api/v1/users/u1",
      "POST /api/v1/users/u1/lifecycle/deactivate",
      "DELETE /api/v1/users/u1",
    ]);
  });

  it("lists every policy type and tolerates feature-gated ones", async () => {
    const client = ssws((call) => {
      const type = new URL(call.url).searchParams.get("type");
      if (type === "PASSWORD")
        return {
          body: [{ id: "p1", type, name: "Default", status: "ACTIVE", system: true, priority: 1 }],
        };
      if (type === "ENTITY_RISK")
        return { status: 400, body: { errorSummary: "feature not enabled" } };
      return { body: [] };
    });
    const policies = await client.listResources("policy", ACCOUNT);
    expect(policies).toHaveLength(1);
    expect(policies[0]!.fields).toMatchObject({ type: "PASSWORD", system: true, priority: 1 });
    expect(calls).toHaveLength(12);
  });

  it("reads rate-limit headroom as quotas", async () => {
    const client = ssws(() => ({
      body: [],
      headers: {
        "x-rate-limit-limit": "600",
        "x-rate-limit-remaining": "540",
        "x-rate-limit-reset": "1700000000",
      },
    }));
    const quotas = await client.fetchQuotas(ACCOUNT);
    expect(quotas).toHaveLength(5);
    expect(quotas[0]).toMatchObject({ id: "rate-limit:/api/v1/users", limit: 600, used: 60 });
  });

  it("builds IP network zones from CIDRs and ranges", async () => {
    const client = ssws((call) => ({ body: { id: "z1", ...JSON.parse(call.body ?? "{}") } }));
    const zone = await client.createResource("network-zone", ACCOUNT, {
      name: "Office",
      usage: "POLICY",
      gateways: "203.0.113.0/24, 198.51.100.1-198.51.100.9",
    });
    expect(JSON.parse(calls[0]!.body!)).toMatchObject({
      type: "IP",
      gateways: [
        { type: "CIDR", value: "203.0.113.0/24" },
        { type: "RANGE", value: "198.51.100.1-198.51.100.9" },
      ],
    });
    expect(zone.fields["gateways"]).toBe("203.0.113.0/24, 198.51.100.1-198.51.100.9");
  });
});

describe("list reads", () => {
  const next = (url: string) => ({ link: `<${url}>; rel="next"` });
  const endless = (call: Call): Reply => ({
    body: [{ id: `u${calls.length}` }],
    headers: next(
      `${ORG}/api/v1/whatever?after=${calls.length}&from=${new URL(call.url).pathname}`,
    ),
  });

  it.each([
    ["user", 250],
    ["group", 50],
    ["app", 250],
    ["authorization-server", 250],
    ["trusted-origin", 250],
    ["network-zone", 500],
    ["api-token", 500],
    ["event-hook", 500],
  ])("refuses a %s list past its cap, after %i requests", async (type, pages) => {
    await expect(ssws(endless).listResources(type, ACCOUNT)).rejects.toThrow(
      "has more than Infrawrench reads",
    );
    expect(calls).toHaveLength(pages);
  });

  it("refuses the seat list only past its own cap", async () => {
    await expect(ssws(endless).fetchSeats(ACCOUNT, { lookbackDays: 30 })).rejects.toThrow(
      "has more than Infrawrench reads",
    );
    expect(calls).toHaveLength(1000);
  });

  it("carries a list past its cap through the policy read", async () => {
    await expect(ssws(endless).listResources("policy", ACCOUNT)).rejects.toThrow(
      "has more than Infrawrench reads",
    );
  });

  it("keeps the newest pages of the sign-in chart window", async () => {
    const series = await ssws(endless).fetchMetricSeries("org", "o", ACCOUNT);
    expect(calls).toHaveLength(5);
    expect(series.length).toBeGreaterThan(0);
  });

  it("reads a page with its key renamed as an error, first or later", async () => {
    await expect(
      ssws(() => ({ body: { users: [] } })).listResources("user", ACCOUNT),
    ).rejects.toThrow("is not a list");
    calls = [];
    await expect(
      ssws((call) =>
        call.url.includes("after=")
          ? { body: { users: [] } }
          : { body: [{ id: "u1" }], headers: next(`${ORG}/api/v1/users?after=u1`) },
      ).listResources("user", ACCOUNT),
    ).rejects.toThrow("is not a list");
    expect(calls).toHaveLength(2);
  });

  it("reads a 2xx with no body as an error, not as no users", async () => {
    await expect(ssws(() => ({})).listResources("user", ACCOUNT)).rejects.toThrow("is not a list");
  });

  it("reads a domain answer with no domains key as an error, not as no domains", async () => {
    await expect(
      ssws(() => ({ body: { items: [] } })).listResources("domain", ACCOUNT),
    ).rejects.toThrow("is not a list");
  });

  it("refuses a next link to another host and sends it nothing", async () => {
    const client = ssws(() => ({
      body: [{ id: "u1" }],
      headers: next("https://evil.example/api/v1/users?after=u1"),
    }));
    await expect(client.listResources("user", ACCOUNT)).rejects.toThrow(
      "Refusing to send the account's credentials there",
    );
    expect(calls.map((c) => new URL(c.url).host)).toEqual(["acme.okta.com"]);
  });

  it("carries the refusal through the policy read, the picker and the detail view", async () => {
    const refuse = () => ({
      body: [{ id: "x1", profile: { login: "a", name: "a" } }],
      headers: next("https://evil.example/next"),
    });
    const refusal = "Refusing to send the account's credentials there";
    await expect(ssws(refuse).listResources("policy", ACCOUNT)).rejects.toThrow(refusal);
    await expect(ssws(refuse).getCreateConfig("user")).rejects.toThrow(refusal);
    await expect(
      ssws(refuse).enrichDetail({
        id: `${ACCOUNT}:user:u1`,
        pluginId: "okta",
        resourceTypeId: "user",
        accountId: ACCOUNT,
        displayName: "a",
        externalId: "u1",
        fields: {},
        resolvedOutputs: {},
        secretStates: [],
        createdAt: "",
        updatedAt: "",
      }),
    ).rejects.toThrow(refusal);
    expect(calls.every((c) => new URL(c.url).host === "acme.okta.com")).toBe(true);
  });

  it("reads a next link whose URL holds a comma", async () => {
    const client = ssws((call) =>
      call.url.includes("after=")
        ? { body: [{ id: "u2" }] }
        : {
            body: [{ id: "u1" }],
            headers: {
              link: `<${ORG}/api/v1/users?ids=1,2&after=3>; rel="next", <${ORG}/api/v1/users>; rel="self"`,
            },
          },
    );
    const users = await client.listResources("user", ACCOUNT);
    expect(users.map((u) => u.externalId)).toEqual(["u1", "u2"]);
    expect(calls[1]!.url).toBe(`${ORG}/api/v1/users?ids=1,2&after=3`);
  });

  it("fails the policy read on a rate limit rather than prune that type", async () => {
    const client = ssws((call) => {
      const type = new URL(call.url).searchParams.get("type");
      if (type === "MFA_ENROLL") return { status: 429, body: { errorSummary: "slow down" } };
      return { body: [{ id: `p-${type}`, type, name: "Default" }] };
    });
    const error = (await client.listResources("policy", ACCOUNT).catch((e) => e)) as {
      status?: number;
    };
    expect(error.status).toBe(429);
  });

  it("fails the policy read when every type refuses, which is the token and not the org", async () => {
    const client = ssws(() => ({ status: 403, body: { errorSummary: "no" } }));
    const error = (await client.listResources("policy", ACCOUNT).catch((e) => e)) as {
      status?: number;
    };
    expect(error.status).toBe(403);
  });

  it("tolerates a type the org's plan refuses with 403", async () => {
    const client = ssws((call) => {
      const type = new URL(call.url).searchParams.get("type");
      if (type === "PASSWORD") return { body: [{ id: "p1", type, name: "Default" }] };
      return { status: 403, body: { errorCode: "E0000015", errorSummary: "feature" } };
    });
    const policies = await client.listResources("policy", ACCOUNT);
    expect(policies.map((p) => p.externalId)).toEqual(["p1"]);
  });

  describe("app dashboard counts", () => {
    const stats = (handler: (call: Call) => Reply) =>
      ssws(handler).fetchDashboardStats("app", `${ACCOUNT}:app:a1`);

    it("counts what it read", async () => {
      await expect(stats(() => ({ body: [{ id: "x" }, { id: "y" }] }))).resolves.toEqual([
        { label: "Assigned users", value: "2" },
        { label: "Assigned groups", value: "2" },
      ]);
    });

    it("says a count at its cap is at least that many", async () => {
      const rows = (n: number) => Array.from({ length: n }, (_, i) => ({ id: `x${i}` }));
      await expect(
        stats((call) => {
          const users = call.url.includes("/users");
          return {
            body: rows(users ? 500 : 200),
            headers: next(`${ORG}${new URL(call.url).pathname}?after=${calls.length}`),
          };
        }),
      ).resolves.toEqual([
        { label: "Assigned users", value: "2000+" },
        { label: "Assigned groups", value: "800+" },
      ]);
    });

    it("shows nothing for a count it could not read, rather than 0", async () => {
      await expect(stats(() => ({ status: 403, body: { errorSummary: "no" } }))).resolves.toEqual(
        [],
      );
    });
  });

  describe("transport", () => {
    afterEach(() => vi.unstubAllGlobals());

    it("goes through the host's HTTP service, with no CA unless one is set", async () => {
      const fetchStub = vi.fn(() => {
        throw new Error("fetch must not be called");
      });
      vi.stubGlobal("fetch", fetchStub);
      const request = vi.fn(async () => ({ status: 200, headers: {}, body: "[]" }));
      const client = hostClient(
        new OktaClient({ orgUrl: ORG, apiToken: "tok" }, { http: { request } }),
      );
      await client.listResources("user", ACCOUNT);
      expect(request).toHaveBeenCalledTimes(1);
      expect(request.mock.calls[0]).not.toHaveProperty("0.caCert");
      expect(fetchStub).not.toHaveBeenCalled();
    });
  });
});

describe("editing an event hook", () => {
  const H = `${ACCOUNT}:event-hook:who1`;
  const expression = "event.target.?[displayName eq 'Sales'].size()>0";
  const current = (filter: object | null) => ({
    id: "who1",
    name: "Old",
    events: {
      type: "EVENT_TYPE",
      items: ["group.user_membership.add", "user.session.start"],
      filter,
    },
    channel: {
      type: "HTTP",
      version: "1.0.0",
      config: {
        uri: "https://hooks.example.com/okta",
        method: "POST",
        authScheme: { type: "HEADER", key: "authorization" },
      },
    },
  });
  const filter = {
    type: "EXPRESSION_LANGUAGE",
    eventFilterMap: [
      { event: "group.user_membership.add", condition: { version: null, expression } },
    ],
  };
  const edit = async (read: object, fields: Record<string, string>) => {
    const client = ssws((call) => ({
      body: call.method === "PUT" ? JSON.parse(call.body!) : read,
    }));
    await client.updateResource("event-hook", H, ACCOUNT, fields);
    return JSON.parse(calls.find((c) => c.method === "PUT")!.body!);
  };

  it("keeps the filter on a rename, in the shape the document's example sends", async () => {
    const body = await edit(current(filter), { name: "New" });
    expect(body.name).toBe("New");
    expect(body.events).toEqual({
      type: "EVENT_TYPE",
      items: ["group.user_membership.add", "user.session.start"],
      filter: {
        type: "EXPRESSION_LANGUAGE",
        eventFilterMap: [{ event: "group.user_membership.add", condition: { expression } }],
      },
    });
  });

  it("keeps the filter when the URL changes", async () => {
    const body = await edit(current(filter), { uri: "https://hooks.example.com/new" });
    expect(body.channel.config.uri).toBe("https://hooks.example.com/new");
    expect(body.events.filter.eventFilterMap).toHaveLength(1);
  });

  it("drops only the entries for events the edit unsubscribes", async () => {
    const two = {
      ...filter,
      eventFilterMap: [
        ...filter.eventFilterMap,
        { event: "user.session.start", condition: { expression: "true" } },
      ],
    };
    const body = await edit(current(two), { events: "user.session.start" });
    expect(body.events).toEqual({
      type: "EVENT_TYPE",
      items: ["user.session.start"],
      filter: {
        type: "EXPRESSION_LANGUAGE",
        eventFilterMap: [{ event: "user.session.start", condition: { expression: "true" } }],
      },
    });
  });

  it("sends no filter when the last filtered event goes", async () => {
    const body = await edit(current(filter), { events: "user.session.start" });
    expect(body.events).not.toHaveProperty("filter");
  });

  it("sends no filter for a hook without one", async () => {
    const body = await edit(current(null), { name: "New" });
    expect(body.events).not.toHaveProperty("filter");
  });
});

describe("editing a trusted origin", () => {
  const T = `${ACCOUNT}:trusted-origin:tos1`;
  const dashboard = { type: "IFRAME_EMBED", allowedOktaApps: ["OKTA_ENDUSER"] };
  const current = {
    id: "tos1",
    name: "Old",
    origin: "https://app.example.com",
    scopes: [{ type: "CORS" }, dashboard],
  };
  const edit = async (fields: Record<string, string>) => {
    const client = ssws((call) => ({
      body: call.method === "PUT" ? JSON.parse(call.body!) : current,
    }));
    await client.updateResource("trusted-origin", T, ACCOUNT, fields);
    return JSON.parse(calls.find((c) => c.method === "PUT")!.body!);
  };

  it("keeps an iframe scope's allowed apps on a rename", async () => {
    const body = await edit({ name: "New" });
    expect(body).toEqual({
      name: "New",
      origin: "https://app.example.com",
      scopes: [{ type: "CORS" }, dashboard],
    });
  });

  it("keeps a sign-in-only iframe scope, whose empty list means something", async () => {
    const signIn = { type: "IFRAME_EMBED", allowedOktaApps: [] };
    const client = ssws((call) => ({
      body: call.method === "PUT" ? JSON.parse(call.body!) : { ...current, scopes: [signIn] },
    }));
    await client.updateResource("trusted-origin", T, ACCOUNT, { name: "New" });
    expect(JSON.parse(calls.find((c) => c.method === "PUT")!.body!).scopes).toEqual([signIn]);
  });

  it("keeps them while the toggles change the other scopes", async () => {
    const body = await edit({ cors: "false", redirect: "true" });
    expect(body.scopes).toEqual([dashboard, { type: "REDIRECT" }]);
  });
});

describe("group stats", () => {
  const G = `${ACCOUNT}:group:00g1`;
  const group = { id: "00g1", type: "OKTA_GROUP", profile: { name: "Eng" } };
  const listed = {
    ...group,
    _embedded: { stats: { usersCount: 7, appsCount: 2 } },
  };

  it("reads a group's counts from the list, where expand=stats is documented", async () => {
    const client = ssws((call) => ({
      body: new URL(call.url).pathname === "/api/v1/groups" ? [listed] : group,
    }));
    const found = await client.getResource("group", G, ACCOUNT);
    expect(found.fields).toMatchObject({ name: "Eng", memberCount: 7, appCount: 2 });
    const single = calls.find((c) => new URL(c.url).pathname === "/api/v1/groups/00g1")!;
    expect(new URL(single.url).search).toBe("");
    const lookup = new URL(calls.find((c) => new URL(c.url).pathname === "/api/v1/groups")!.url);
    expect(lookup.searchParams.get("filter")).toBe('id eq "00g1"');
    expect(lookup.searchParams.get("expand")).toBe("stats");
  });

  it("still returns the group when its counts cannot be read", async () => {
    const client = ssws((call) =>
      new URL(call.url).pathname === "/api/v1/groups"
        ? { status: 400, body: { errorSummary: "no" } }
        : { body: group },
    );
    const found = await client.getResource("group", G, ACCOUNT);
    expect(found.fields["name"]).toBe("Eng");
    expect(found.fields).not.toHaveProperty("memberCount");
  });

  it("says a missing group is missing, whatever the counts did", async () => {
    const client = ssws((call) =>
      new URL(call.url).pathname === "/api/v1/groups"
        ? { body: [] }
        : { status: 404, body: { errorSummary: "gone" } },
    );
    const error = (await client.getResource("group", G, ACCOUNT).catch((e) => e)) as {
      status?: number;
    };
    expect(error.status).toBe(404);
  });

  it("shows the dashboard's counts", async () => {
    const client = ssws(() => ({ body: [listed] }));
    await expect(client.fetchDashboardStats("group", G)).resolves.toEqual([
      { label: "Members", value: "7" },
      { label: "Apps", value: "2" },
    ]);
  });

  it.each([
    ["the answer has no stats", () => ({ body: [group] })],
    ["the row is not there", () => ({ body: [] })],
    ["the read fails", () => ({ status: 500, body: { errorSummary: "no" } })],
  ])("shows no dashboard counts rather than 0 when %s", async (_name, reply) => {
    await expect(ssws(reply).fetchDashboardStats("group", G)).resolves.toEqual([]);
  });

  it("does not put an id that is not one into a filter", async () => {
    const client = ssws(() => ({ body: [listed] }));
    await expect(
      client.fetchDashboardStats("group", `${ACCOUNT}:group:x" or id eq "y`),
    ).resolves.toEqual([]);
    expect(calls).toHaveLength(0);
  });
});

describe("detail lists", () => {
  const resource = (typeId: string, externalId: string): ResourceInstance => ({
    id: `${ACCOUNT}:${typeId}:${externalId}`,
    pluginId: "okta",
    resourceTypeId: typeId,
    accountId: ACCOUNT,
    displayName: externalId,
    externalId,
    fields: {},
    resolvedOutputs: {},
    secretStates: [],
    createdAt: "",
    updatedAt: "",
  });
  const twoPages = (path: string, first: object, second: object) => (call: Call) => {
    const { pathname, searchParams } = new URL(call.url);
    if (pathname !== path) return { body: [] };
    return searchParams.get("after")
      ? { body: [second] }
      : {
          body: [first],
          headers: { link: `<${ORG}${path}?after=p2>; rel="next"` },
        };
  };

  it("reads every page of an authorization server's scopes, at the largest page size", async () => {
    const path = "/api/v1/authorizationServers/as1/scopes";
    const client = ssws(twoPages(path, { id: "s1", name: "a" }, { id: "s2", name: "b" }));
    const detail = await client.enrichDetail(resource("authorization-server", "as1"));
    expect(JSON.parse(detail.resolvedOutputs["__scopes__"]!)).toEqual([
      { id: "s1", name: "a" },
      { id: "s2", name: "b" },
    ]);
    expect(calls.find((c) => c.url.includes("/scopes"))!.url).toBe(`${ORG}${path}?limit=200`);
    const rendered = JSON.stringify(client.renderDetail(detail));
    expect(rendered).toContain('"id":"s2"');
  });

  it("reads every page of a policy's rules, so a later one can be chosen", async () => {
    const path = "/api/v1/policies/p1/rules";
    const client = ssws(
      twoPages(path, { id: "r1", name: "a", status: "ACTIVE" }, { id: "r2", name: "b" }),
    );
    const detail = await client.enrichDetail(resource("policy", "p1"));
    expect(
      JSON.parse(detail.resolvedOutputs["__rules__"]!).map((r: { id: string }) => r.id),
    ).toEqual(["r1", "r2"]);
    expect(JSON.stringify(client.renderDetail(detail))).toContain('"id":"r2"');
  });

  it("follows a link on an authorization server's policies and a user's groups", async () => {
    const policies = ssws(
      twoPages("/api/v1/authorizationServers/as1/policies", { name: "a" }, { name: "b" }),
    );
    const server = await policies.enrichDetail(resource("authorization-server", "as1"));
    expect(JSON.parse(server.resolvedOutputs["__policies__"]!)).toHaveLength(2);
    const groups = ssws(twoPages("/api/v1/users/u1/groups", { id: "g1" }, { id: "g2" }));
    const user = await groups.enrichDetail(resource("user", "u1"));
    expect(JSON.parse(user.resolvedOutputs["__groups__"]!)).toHaveLength(2);
  });

  it("keeps what it read when a detail list runs past its cap", async () => {
    const client = ssws((call) => ({
      body: [{ id: `r${calls.length}` }],
      headers: {
        link: `<${new URL(call.url).origin}/api/v1/policies/p1/rules?after=${calls.length}>; rel="next"`,
      },
    }));
    const detail = await client.enrichDetail(resource("policy", "p1"));
    expect(JSON.parse(detail.resolvedOutputs["__rules__"]!)).toHaveLength(50);
  });
});

describe("OAuth service app with DPoP", () => {
  it("signs a client assertion, answers the DPoP nonce challenge and binds API calls", async () => {
    const pair = (await crypto.subtle.generateKey(
      {
        name: "RSASSA-PKCS1-v1_5",
        modulusLength: 2048,
        publicExponent: new Uint8Array([1, 0, 1]),
        hash: "SHA-256",
      },
      true,
      ["sign", "verify"],
    )) as CryptoKeyPair;
    const jwk = { ...(await crypto.subtle.exportKey("jwk", pair.privateKey)), kid: "key-1" };
    let tokenCalls = 0;
    const client = hostClient(
      new OktaClient(
        {
          orgUrl: ORG,
          clientId: "0oaclient",
          privateKey: JSON.stringify(jwk),
          scopes: "okta.users.read",
        },
        services((call) => {
          if (call.url.endsWith("/oauth2/v1/token")) {
            tokenCalls++;
            if (tokenCalls === 1)
              return {
                status: 400,
                body: { error: "invalid_dpop_proof", error_description: "DPoP proof required" },
              };
            if (tokenCalls === 2)
              return {
                status: 400,
                body: { error: "use_dpop_nonce" },
                headers: { "dpop-nonce": "n-1" },
              };
            return { body: { access_token: "at-1", token_type: "DPoP", expires_in: 3600 } };
          }
          return { body: { id: "u1", status: "ACTIVE", profile: { login: "a@b.c" } } };
        }),
      ),
    );
    await client.getResource("user", `${ACCOUNT}:user:u1`, ACCOUNT);

    const form = new URLSearchParams(calls[2]!.body!);
    expect(form.get("grant_type")).toBe("client_credentials");
    expect(form.get("scope")).toBe("okta.users.read");
    const assertion = form.get("client_assertion")!;
    const { header, claims } = decodeJwt(assertion);
    expect(header).toMatchObject({ alg: "RS256", kid: "key-1" });
    expect(claims).toMatchObject({
      iss: "0oaclient",
      sub: "0oaclient",
      aud: `${ORG}/oauth2/v1/token`,
    });
    const [h, c, s] = assertion.split(".");
    const sig = Uint8Array.from(atob(s!.replace(/-/g, "+").replace(/_/g, "/")), (ch) =>
      ch.charCodeAt(0),
    );
    expect(
      await crypto.subtle.verify(
        "RSASSA-PKCS1-v1_5",
        pair.publicKey,
        sig,
        new TextEncoder().encode(`${h}.${c}`),
      ),
    ).toBe(true);
    expect(decodeJwt(calls[2]!.headers["DPoP"]!).claims).toMatchObject({
      htm: "POST",
      nonce: "n-1",
    });

    const api = calls[3]!;
    expect(api.headers["Authorization"]).toBe("DPoP at-1");
    const proof = decodeJwt(api.headers["DPoP"]!);
    expect(proof.header).toMatchObject({ typ: "dpop+jwt", alg: "ES256" });
    expect(proof.claims).toMatchObject({ htm: "GET", htu: `${ORG}/api/v1/users/u1` });
    expect(typeof proof.claims["ath"]).toBe("string");
  });
});

describe("helpers", () => {
  it("groups rate-limit buckets", () => {
    expect(rateLimitBucket("/api/v1/users")).toBe("/api/v1/users");
    expect(rateLimitBucket("/api/v1/users/00u1")).toBe("/api/v1/users/{id}");
    expect(rateLimitBucket("/api/v1/users/00u1/groups")).toBe("/api/v1/users/{id}/*");
  });
});

describe("status feed", () => {
  it("keeps unresolved entries from the Atom feed", () => {
    const body = `<feed xmlns="http://www.w3.org/2005/Atom">
 <entry><title>Resolved Service Disruption</title><updated>2025-04-30T16:47:04.000Z</updated><link href="https://status.okta.com/#incident/a"/><id>https://www.salesforce.com/a</id><content type="text">Fixed.</content></entry>
 <entry><title>Service Degradation</title><updated>2026-10-06T10:00:00.000Z</updated><link href="https://status.okta.com/#incident/b"/><id>https://www.salesforce.com/b</id><content type="text">US Cell 6 errors.</content></entry>
</feed>`;
    const incidents = parseStatusFeed(body);
    expect(incidents).toHaveLength(1);
    expect(incidents[0]).toMatchObject({
      externalId: "https://www.salesforce.com/b",
      impact: "minor",
      providerWide: true,
      lastUpdateText: "US Cell 6 errors.",
    });
  });
});

describe("terraform", () => {
  it("exports IP network zones with their gateways", () => {
    const out = oktaTerraformExport.mapResource({
      id: "a:network-zone:z1",
      pluginId: "okta",
      resourceTypeId: "network-zone",
      accountId: "a",
      displayName: "Office",
      externalId: "z1",
      fields: { name: "Office", type: "IP", usage: "POLICY", gateways: "203.0.113.0/24" },
      resolvedOutputs: {},
      secretStates: [],
      createdAt: "",
      updatedAt: "",
    });
    expect(out?.resource).toMatchObject({ type: "okta_network_zone", importId: "z1" });
    expect(out?.resource.attributes["gateways"]).toEqual({
      kind: "list",
      items: [{ kind: "string", value: "203.0.113.0/24" }],
    });
  });
});
