import { hostClient } from "@infrawrench/plugin-base/effect";
import { beforeEach, describe, expect, it } from "vitest";
import { resetCachesForTests } from "../account.js";
import { decodeCloudToken } from "../api.js";
import { GrafanaCloudClient, nextCursor } from "../client.js";
import { stackQueries } from "../metrics.js";
import { mapComponent } from "../status-feed.js";
import { grafanaCloudTerraformExport } from "../terraform.js";
import { fakeToken, makeHttp, type Reply } from "./helpers.js";

beforeEach(() => resetCachesForTests());

const STACK = {
  id: 11,
  orgId: 4242,
  slug: "acme-prod",
  name: "Acme Prod",
  url: "https://acme-prod.grafana.net",
  regionSlug: "prod-us-east-0",
  status: "active",
  labels: { team: "platform" },
  hmInstancePromId: 900,
  regionSyntheticMonitoringApiUrl: "https://synthetic-monitoring-api-us-east-0.grafana.net",
};

function secretsStore() {
  const store = new Map<string, string>();
  return {
    store,
    secrets: {
      async getPlaintext(resourceId: string, key: string) {
        return store.get(`${resourceId}|${key}`) ?? null;
      },
      async setPlaintext(resourceId: string, key: string, value: string) {
        store.set(`${resourceId}|${key}`, value);
      },
    },
  };
}

function baseRoute(url: URL, method: string): { status?: number; body?: unknown } | undefined {
  if (url.pathname === "/api/orgs/4242") return { body: { id: 4242, slug: "acme", name: "Acme" } };
  if (url.pathname === "/api/orgs/acme/instances") return { body: { items: [STACK] } };
  if (url.pathname === "/api/instances/acme-prod" && method === "GET") return { body: STACK };
  return undefined;
}

describe("decodeCloudToken", () => {
  it("reads the org id and region from the token", () => {
    expect(decodeCloudToken(fakeToken("77", "prod-eu-west-2"))).toEqual({
      orgId: "77",
      region: "prod-eu-west-2",
    });
  });
  it("returns nothing for a token it cannot read", () => {
    expect(decodeCloudToken("glc_not-json")).toEqual({});
    expect(decodeCloudToken("glsa_abc")).toEqual({});
  });
});

describe("nextCursor", () => {
  it("accepts a path, a bare cursor, or nothing", () => {
    expect(nextCursor("/v1/accesspolicies?region=us&pageCursor=abc%3D")).toBe("abc=");
    expect(nextCursor("xyz")).toBe("xyz");
    expect(nextCursor(null)).toBeUndefined();
  });
});

describe("GrafanaCloudClient", () => {
  it("lists stacks and marks a stack connected once a token is stored", async () => {
    const { http } = makeHttp((url, method) => baseRoute(url, method) ?? { status: 404 });
    const { secrets } = secretsStore();
    const client = hostClient(new GrafanaCloudClient({ token: fakeToken() }, { http, secrets }));
    const [stack] = await client.listResources("stack", "acct");
    expect(stack?.externalId).toBe("acme-prod");
    expect(stack?.fields["connected"]).toBe(false);
    expect(stack?.fields["labels"]).toBe("team=platform");
    await client.updateResource("stack", "acct:stack:acme-prod", "acct", {
      serviceAccountToken: "glsa_123",
    });
    const [again] = await client.listResources("stack", "acct");
    expect(again?.fields["connected"]).toBe(true);
  });

  it("lists a connected stack's dashboards with its token and skips unconnected ones", async () => {
    const { http, calls } = makeHttp((url, method) => {
      const base = baseRoute(url, method);
      if (base) return base;
      if (url.host === "acme-prod.grafana.net" && url.pathname === "/api/search") {
        return {
          body: [{ uid: "abc", title: "Overview", url: "/d/abc/overview", folderTitle: "Ops" }],
        };
      }
      return { status: 404 };
    });
    const { secrets } = secretsStore();
    const client = hostClient(new GrafanaCloudClient({ token: fakeToken() }, { http, secrets }));
    expect(await client.listResources("dashboard", "acct")).toEqual([]);
    await secrets.setPlaintext("acct:stack:acme-prod", "serviceAccountToken", "glsa_123");
    const [dash] = await client.listResources("dashboard", "acct");
    expect(dash?.externalId).toBe("acme-prod/abc");
    expect(dash?.parentResourceId).toBe("acct:stack:acme-prod");
    expect(dash?.fields["url"]).toBe("https://acme-prod.grafana.net/d/abc/overview");
    const search = calls.find((c) => c.url.pathname === "/api/search");
    expect(search?.headers["Authorization"]).toBe("Bearer glsa_123");
  });

  it("connects a stack by minting a service account token through the Cloud API", async () => {
    const { http, calls } = makeHttp((url, method) => {
      const base = baseRoute(url, method);
      if (base) return base;
      if (url.pathname === "/api/instances/11/api/serviceaccounts/search") {
        return { body: { serviceAccounts: [] } };
      }
      if (url.pathname === "/api/instances/11/api/serviceaccounts" && method === "POST") {
        return { body: { id: 5, name: "infrawrench" } };
      }
      if (url.pathname === "/api/instances/11/api/serviceaccounts/5/tokens") {
        return { body: { id: 1, key: "glsa_minted" } };
      }
      return { status: 404 };
    });
    const { secrets, store } = secretsStore();
    const client = hostClient(new GrafanaCloudClient({ token: fakeToken() }, { http, secrets }));
    await client.invokeAction("stack", "acct:stack:acme-prod", "connect", "acct");
    expect(store.get("acct:stack:acme-prod|serviceAccountToken")).toBe("glsa_minted");
    const create = calls.find((c) => c.url.pathname === "/api/instances/11/api/serviceaccounts");
    expect(create?.body).toEqual({ name: "infrawrench", role: "Admin", isDisabled: false });
    expect(create?.headers["x-request-id"]).toBeTruthy();
  });

  it("fans access policies out over regions and dedupes them", async () => {
    const { http, calls } = makeHttp((url, method) => {
      const base = baseRoute(url, method);
      if (base) return base;
      if (url.pathname === "/api/v1/accesspolicies") {
        return {
          body: {
            items: [
              {
                id: "p1",
                name: "infra",
                displayName: "Infra",
                scopes: ["stacks:read"],
                realms: [{ type: "stack", identifier: "11" }],
                status: "active",
              },
            ],
            metadata: { pagination: { nextPage: null } },
          },
        };
      }
      return { status: 404 };
    });
    const client = hostClient(new GrafanaCloudClient({ token: fakeToken("4242", "us") }, { http }));
    const policies = await client.listResources("access-policy", "acct");
    expect(policies).toHaveLength(1);
    expect(policies[0]?.fields["realms"]).toBe("Stack acme-prod");
    const regions = calls
      .filter((c) => c.url.pathname === "/api/v1/accesspolicies")
      .map((c) => c.url.searchParams.get("region"));
    expect(regions.sort()).toEqual(["prod-us-east-0", "us"]);
  });

  it("keeps scopes and realms when turning a policy off", async () => {
    const policy = {
      id: "p1",
      displayName: "Infra",
      scopes: ["stacks:read"],
      realms: [{ type: "org", identifier: "4242" }],
      status: "active",
    };
    const { http, calls } = makeHttp((url, method) => {
      if (url.pathname === "/api/v1/accesspolicies/p1")
        return { body: method === "GET" ? policy : {} };
      return baseRoute(url, method) ?? { status: 404 };
    });
    const client = hostClient(new GrafanaCloudClient({ token: fakeToken() }, { http }));
    await client.invokeAction("access-policy", "acct:access-policy:us/p1", "disable", "acct");
    const post = calls.find((c) => c.method === "POST");
    expect(post?.url.searchParams.get("region")).toBe("us");
    expect(post?.body).toMatchObject({
      status: "inactive",
      scopes: ["stacks:read"],
      realms: policy.realms,
    });
  });
});

describe("stackQueries", () => {
  it("filters every usage metric to the stack's own instance ids", () => {
    const q = stackQueries({ promInstanceId: "900", logsInstanceId: "901" });
    expect(q.map((x) => x.promql)).toContain('sum(grafanacloud_instance_active_series{id="900"})');
    expect(
      q.some((x) =>
        x.promql.includes('grafanacloud_logs_instance_bytes_received_per_second{id="901"}'),
      ),
    ).toBe(true);
    expect(q.some((x) => x.promql.includes("traces"))).toBe(false);
  });
});

describe("status feed", () => {
  it("maps a regional component to that region's stacks", () => {
    expect(mapComponent("AWS Australia - prod-ap-southeast-2: Querying")).toEqual({
      regions: ["prod-ap-southeast-2"],
      services: ["Querying"],
      resourceTypes: ["stack"],
    });
    expect(mapComponent("Grafana.com")).toEqual({ services: ["Grafana.com"], providerWide: true });
    expect(mapComponent("Support Tickets")).toBeNull();
  });
});

describe("terraform export", () => {
  it("maps a stack to grafana_cloud_stack", () => {
    const out = grafanaCloudTerraformExport.mapResource({
      id: "a:stack:acme-prod",
      pluginId: "grafana-cloud",
      resourceTypeId: "stack",
      accountId: "a",
      displayName: "Acme Prod",
      externalId: "acme-prod",
      fields: {
        name: "Acme Prod",
        slug: "acme-prod",
        region: "prod-us-east-0",
        labels: "team=platform",
      },
      resolvedOutputs: {},
      secretStates: [],
      createdAt: "",
      updatedAt: "",
    });
    expect(out?.resource?.type).toBe("grafana_cloud_stack");
    expect(out?.resource?.importId).toBe("acme-prod");
    expect(Object.keys(out?.resource?.attributes ?? {})).toEqual(
      expect.arrayContaining(["name", "slug", "region_slug", "labels", "delete_protection"]),
    );
  });
});

describe("reading a list to its end", () => {
  const SM_URL = "https://synthetic-monitoring-api-us-east-0.grafana.net";

  /** A client on a stack with both tokens stored, over a fixture that 404s anything unlisted. */
  function connected(route: (url: URL, method: string) => Reply | undefined) {
    const made = makeHttp(
      (url, method) => route(url, method) ?? baseRoute(url, method) ?? { status: 404 },
    );
    const { secrets, store } = secretsStore();
    store.set("acct:stack:acme-prod|serviceAccountToken", "glsa_123");
    store.set("acct:stack:acme-prod|syntheticMonitoringToken", "sm_123");
    const client = hostClient(
      new GrafanaCloudClient({ token: fakeToken() }, { http: made.http, secrets }),
    );
    return { client, calls: made.calls };
  }

  const hits = (count: number, from = 0) =>
    Array.from({ length: count }, (_, i) => ({ uid: `d${from + i}`, title: `D${from + i}` }));

  describe("dashboards", () => {
    it("asks for the next page after a full one", async () => {
      const { client, calls } = connected((url) => {
        if (url.pathname !== "/api/search") return undefined;
        const page = url.searchParams.get("page");
        return { body: page === "1" ? hits(5000) : hits(3, 5000) };
      });
      expect(await client.listResources("dashboard", "acct")).toHaveLength(5003);
      const searches = calls.filter((c) => c.url.pathname === "/api/search");
      expect(searches.map((c) => c.url.searchParams.get("page"))).toEqual(["1", "2"]);
      expect(searches[0]?.url.searchParams.get("limit")).toBe("5000");
      expect(searches[0]?.url.searchParams.get("type")).toBe("dash-db");
    });

    it("refuses a list that never ends, after 10 pages", async () => {
      const { client, calls } = connected((url) =>
        url.pathname === "/api/search" ? { body: hits(5000) } : undefined,
      );
      await expect(client.listResources("dashboard", "acct")).rejects.toThrow(
        "has more than Infrawrench reads",
      );
      expect(calls.filter((c) => c.url.pathname === "/api/search")).toHaveLength(10);
    });

    it.each(["1", "2"])("refuses a page %s that is not a list", async (bad) => {
      const { client } = connected((url) => {
        if (url.pathname !== "/api/search") return undefined;
        return url.searchParams.get("page") === bad ? { body: { hits: [] } } : { body: hits(5000) };
      });
      await expect(client.listResources("dashboard", "acct")).rejects.toThrow("is not a list");
    });
  });

  describe.each([
    { typeId: "access-policy", route: "/api/v1/accesspolicies" },
    { typeId: "access-policy-token", route: "/api/v1/tokens" },
  ])("$typeId", ({ typeId, route }) => {
    const rows = [{ id: "x1", name: "x", accessPolicyId: "p1" }];

    /** Answers only `route`; the policy names a token listing reads come back empty. */
    function onRoute(answer: (cursor: string | null) => Reply) {
      return connected((url) => {
        if (url.pathname === route) return answer(url.searchParams.get("pageCursor"));
        if (url.pathname === "/api/v1/accesspolicies") return { body: { items: [] } };
        return undefined;
      });
    }

    it("refuses a list that never ends, after 100 pages", async () => {
      const { client, calls } = onRoute(() => ({
        body: { items: rows, metadata: { pagination: { nextPage: `${route}?pageCursor=more` } } },
      }));
      await expect(client.listResources(typeId, "acct")).rejects.toThrow(
        "has more than Infrawrench reads",
      );
      expect(calls.filter((c) => c.url.pathname === route)).toHaveLength(100);
    });

    it("reads on past an empty page", async () => {
      const { client } = onRoute((cursor) =>
        cursor
          ? { body: { items: rows, metadata: { pagination: { nextPage: null } } } }
          : { body: { items: [], metadata: { pagination: { nextPage: "abc" } } } },
      );
      expect(await client.listResources(typeId, "acct")).toHaveLength(1);
    });

    it.each([null, "more"])("refuses a page that is not a list, after cursor %s", async (bad) => {
      const { client } = onRoute((cursor) =>
        cursor === bad
          ? { body: { policies: rows } }
          : { body: { items: rows, metadata: { pagination: { nextPage: "more" } } } },
      );
      await expect(client.listResources(typeId, "acct")).rejects.toThrow("is not a list");
    });

    it("fails on a next page it cannot read rather than ending the list", async () => {
      const { client } = onRoute(() => ({
        body: { items: rows, metadata: { pagination: { nextPage: `${route}?other=1` } } },
      }));
      await expect(client.listResources(typeId, "acct")).rejects.toThrow("is not a list");
    });

    it.each([400, 404])("reads a %i on the first page as a region with nothing", async (status) => {
      const { client } = onRoute(() => ({ status }));
      expect(await client.listResources(typeId, "acct")).toEqual([]);
    });

    it.each([400, 404])("fails on a %i on a later page", async (status) => {
      const { client } = onRoute((cursor) =>
        cursor
          ? { status }
          : { body: { items: rows, metadata: { pagination: { nextPage: "more" } } } },
      );
      await expect(client.listResources(typeId, "acct")).rejects.toThrow(`error ${status}`);
    });
  });

  it("does not read a truncated policy list as no policy names", async () => {
    const { client } = connected((url) => {
      if (url.pathname === "/api/v1/tokens") return { body: { items: [] } };
      if (url.pathname === "/api/v1/accesspolicies") {
        return { body: { items: [], metadata: { pagination: { nextPage: "more" } } } };
      }
      return undefined;
    });
    await expect(client.listResources("access-policy-token", "acct")).rejects.toThrow(
      "has more than Infrawrench reads",
    );
  });

  it("does not read a failed stack list as the token's own region alone", async () => {
    const { http } = makeHttp((url) => {
      if (url.pathname === "/api/orgs/4242") return { body: { id: 4242, slug: "acme" } };
      if (url.pathname === "/api/orgs/acme/instances") return { status: 500, body: "down" };
      return { body: { items: [] } };
    });
    const client = hostClient(new GrafanaCloudClient({ token: fakeToken() }, { http }));
    await expect(client.listResources("access-policy", "acct")).rejects.toThrow("error 500");
  });

  it("lists the token's own region when the token may not read stacks", async () => {
    const { http, calls } = makeHttp((url) => {
      if (url.pathname === "/api/orgs/4242") return { body: { id: 4242, slug: "acme" } };
      if (url.pathname === "/api/orgs/acme/instances") return { status: 403 };
      return { body: { items: [{ id: "p1", name: "infra" }] } };
    });
    const client = hostClient(new GrafanaCloudClient({ token: fakeToken() }, { http }));
    expect(await client.listResources("access-policy", "acct")).toHaveLength(1);
    expect(calls.at(-1)?.url.searchParams.get("region")).toBe("prod-us-east-0");
  });

  it("refuses a stack listing whose items key is gone", async () => {
    const { http } = makeHttp((url) => {
      if (url.pathname === "/api/orgs/4242") return { body: { id: 4242, slug: "acme" } };
      return { body: { instances: [STACK] } };
    });
    const client = hostClient(new GrafanaCloudClient({ token: fakeToken() }, { http }));
    await expect(client.listResources("stack", "acct")).rejects.toThrow("is not a list");
  });

  it.each([
    { typeId: "stack-plugin", path: "/api/instances/11/plugins", body: { plugins: [] } },
    { typeId: "member", path: "/api/orgs/acme/members", body: { members: [] } },
    { typeId: "alert-rule", path: "/api/v1/provisioning/alert-rules", body: { rules: [] } },
    { typeId: "contact-point", path: "/api/v1/provisioning/contact-points", body: {} },
    { typeId: "datasource", path: "/api/datasources", body: { message: "x" } },
    { typeId: "synthetic-check", path: "/api/v1/check", body: { checks: [] } },
  ])("refuses a $typeId listing that is not a list", async ({ typeId, path, body }) => {
    const { client } = connected((url) =>
      url.pathname === path
        ? { body }
        : url.pathname === "/api/v1/probe"
          ? { body: [] }
          : undefined,
    );
    await expect(client.listResources(typeId, "acct")).rejects.toThrow("is not a list");
  });

  it("does not read a bad probe page as no probe names", async () => {
    const { client } = connected((url) => {
      if (url.origin !== SM_URL) return undefined;
      if (url.pathname === "/api/v1/check") return { body: [] };
      if (url.pathname === "/api/v1/probe") return { body: { probes: [] } };
      return undefined;
    });
    await expect(client.listResources("synthetic-check", "acct")).rejects.toThrow("is not a list");
  });

  it("does not read a bad bill page as an organization with no bill", async () => {
    const { client } = connected((url) =>
      url.pathname === "/api/orgs/acme/billed-usage" ? { body: { usage: [] } } : undefined,
    );
    await expect(client.listResources("organization", "acct")).rejects.toThrow("is not a list");
  });
});

describe("alert rule folder names", () => {
  const rule = (folderUID: string) => ({ uid: `r-${folderUID}`, title: "CPU high", folderUID });

  function connected(route: (url: URL) => Reply | undefined) {
    const made = makeHttp((url, method) => route(url) ?? baseRoute(url, method) ?? { status: 404 });
    const { secrets, store } = secretsStore();
    store.set("acct:stack:acme-prod|serviceAccountToken", "glsa_123");
    const client = hostClient(
      new GrafanaCloudClient({ token: fakeToken() }, { http: made.http, secrets }),
    );
    return { client, calls: made.calls };
  }

  it("names a rule in a nested folder from one search of every folder", async () => {
    const { client, calls } = connected((url) => {
      if (url.pathname === "/api/v1/provisioning/alert-rules") return { body: [rule("nested")] };
      if (url.pathname === "/api/search") {
        return { body: [{ uid: "nested", title: "Payments", folderUid: "root" }] };
      }
      return undefined;
    });
    const [listed] = await client.listResources("alert-rule", "acct");
    expect(listed?.fields["folder"]).toBe("Payments");
    expect(listed?.fields["folderUid"]).toBe("nested");
    const search = calls.find((c) => c.url.pathname === "/api/search");
    expect(search?.url.searchParams.get("type")).toBe("dash-folder");
    expect(calls.filter((c) => c.url.pathname.startsWith("/api/folders"))).toEqual([]);
  });

  it("reads the next page of folders after a full one", async () => {
    const full = Array.from({ length: 5000 }, (_, i) => ({ uid: `f${i}`, title: `F${i}` }));
    const { client } = connected((url) => {
      if (url.pathname === "/api/v1/provisioning/alert-rules") return { body: [rule("late")] };
      if (url.pathname === "/api/search") {
        return url.searchParams.get("page") === "1"
          ? { body: full }
          : { body: [{ uid: "late", title: "Last" }] };
      }
      return undefined;
    });
    const [listed] = await client.listResources("alert-rule", "acct");
    expect(listed?.fields["folder"]).toBe("Last");
  });

  it("does not fail the rules when there are more folders than it reads", async () => {
    const full = Array.from({ length: 5000 }, (_, i) => ({ uid: `f${i}`, title: `F${i}` }));
    const { client } = connected((url) => {
      if (url.pathname === "/api/v1/provisioning/alert-rules") return { body: [rule("f1")] };
      if (url.pathname === "/api/search") return { body: full };
      return undefined;
    });
    const [listed] = await client.listResources("alert-rule", "acct");
    expect(listed?.fields["folder"]).toBe("F1");
  });

  it("looks up a folder the search left out by its UID", async () => {
    const { client, calls } = connected((url) => {
      if (url.pathname === "/api/v1/provisioning/alert-rules") {
        return { body: [rule("nested"), { ...rule("nested"), uid: "r2" }, rule("root")] };
      }
      if (url.pathname === "/api/search") return { body: [{ uid: "root", title: "Top" }] };
      if (url.pathname === "/api/folders/nested") return { body: { uid: "nested", title: "Deep" } };
      return undefined;
    });
    const listed = await client.listResources("alert-rule", "acct");
    expect(listed.map((r) => r.fields["folder"])).toEqual(["Deep", "Deep", "Top"]);
    expect(calls.filter((c) => c.url.pathname === "/api/folders/nested")).toHaveLength(1);
  });

  it("keeps the UID for a folder it may not read", async () => {
    const { client } = connected((url) => {
      if (url.pathname === "/api/v1/provisioning/alert-rules") return { body: [rule("hidden")] };
      if (url.pathname === "/api/search") return { body: [] };
      if (url.pathname === "/api/folders/hidden") return { status: 403 };
      return undefined;
    });
    const [listed] = await client.listResources("alert-rule", "acct");
    expect(listed?.fields["folder"]).toBe("hidden");
  });

  it("keeps UIDs, with no lookups, when the search itself fails", async () => {
    const { client, calls } = connected((url) => {
      if (url.pathname === "/api/v1/provisioning/alert-rules") return { body: [rule("a")] };
      if (url.pathname === "/api/search") return { status: 500, body: "down" };
      return undefined;
    });
    const [listed] = await client.listResources("alert-rule", "acct");
    expect(listed?.fields["folder"]).toBe("a");
    expect(calls.filter((c) => c.url.pathname.startsWith("/api/folders"))).toEqual([]);
  });

  it("does not read a bad folder page as no folders", async () => {
    const { client } = connected((url) => {
      if (url.pathname === "/api/v1/provisioning/alert-rules") return { body: [rule("a")] };
      if (url.pathname === "/api/search") return { body: { folders: [] } };
      return undefined;
    });
    await expect(client.listResources("alert-rule", "acct")).rejects.toThrow("is not a list");
  });
});
