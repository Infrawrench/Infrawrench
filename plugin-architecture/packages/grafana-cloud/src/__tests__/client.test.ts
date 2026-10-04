import { beforeEach, describe, expect, it } from "vitest";
import { resetCachesForTests } from "../account.js";
import { decodeCloudToken } from "../api.js";
import { GrafanaCloudClient, nextCursor } from "../client.js";
import { stackQueries } from "../metrics.js";
import { mapComponent } from "../status-feed.js";
import { grafanaCloudTerraformExport } from "../terraform.js";
import { fakeToken, makeHttp } from "./helpers.js";

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
    const client = new GrafanaCloudClient({ token: fakeToken() }, { http, secrets });
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
    const client = new GrafanaCloudClient({ token: fakeToken() }, { http, secrets });
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
    const client = new GrafanaCloudClient({ token: fakeToken() }, { http, secrets });
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
    const client = new GrafanaCloudClient({ token: fakeToken("4242", "us") }, { http });
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
    const client = new GrafanaCloudClient({ token: fakeToken() }, { http });
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
