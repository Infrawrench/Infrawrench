import { hostClient } from "@infrawrench/plugin-base/effect";
import { describe, expect, it } from "vitest";
import { exportResourcesToTerraform } from "@infrawrench/plugin-base";
import { chartPoints } from "../api.js";
import { BunnyClient, edgeRuleFromFields, pullZoneUpdateBody, recordBody } from "../client.js";
import { billingCostRows, creditBalances } from "../cost.js";
import { mapComponent, parseStatusFeed } from "../status-feed.js";
import { bunnyTerraformExport } from "../terraform.js";

type Req = {
  url: string;
  method: string;
  headers: Record<string, string>;
  body?: string | Uint8Array;
};

function client(route: (u: URL, r: Req) => { status?: number; body?: unknown }) {
  const calls: Req[] = [];
  const http = {
    async request(req: Req) {
      calls.push(req);
      const r = route(new URL(req.url), req);
      return {
        status: r.status ?? 200,
        headers: {},
        body:
          r.body === undefined ? "" : typeof r.body === "string" ? r.body : JSON.stringify(r.body),
      };
    },
  };
  return { c: hostClient(new BunnyClient({ apiKey: "KEY" }, { http } as never)), calls };
}

const PZ = {
  Id: 7,
  Name: "site",
  OriginUrl: "https://origin.example.com",
  OriginType: 0,
  Type: 0,
  Enabled: true,
  Hostnames: [
    { Id: 1, Value: "site.b-cdn.net", IsSystemHostname: true, HasCertificate: true },
    { Id: 2, Value: "cdn.example.com", ForceSSL: true, HasCertificate: true },
  ],
  EdgeRules: [
    {
      Guid: "g1",
      ActionType: 1,
      ActionParameter1: "https://new",
      Triggers: [{ Type: 0, PatternMatches: ["*/old/*"], PatternMatchingType: 0 }],
      TriggerMatchingType: 0,
      Description: "redirect",
      Enabled: true,
    },
    { Guid: "sys", ActionType: 0, ReadOnly: true, Triggers: [] },
  ],
  MonthlyBandwidthUsed: 1000,
};

describe("listing", () => {
  it("sends AccessKey and maps pull zones, hostnames and edge rules", async () => {
    const { c, calls } = client(() => ({ body: [PZ] }));
    const [pz] = await c.listResources("pull-zone", "a1");
    expect(calls[0]!.headers["AccessKey"]).toBe("KEY");
    expect(calls[0]!.url).toBe("https://api.bunny.net/pullzone");
    expect(pz!.fields).toMatchObject({
      cdnHostname: "site.b-cdn.net",
      type: "Premium",
      originType: "Standard",
    });
    const hosts = await c.listResources("hostname", "a1");
    expect(hosts.map((h) => h.externalId)).toEqual(["7/site.b-cdn.net", "7/cdn.example.com"]);
    const rules = await c.listResources("edge-rule", "a1");
    expect(rules).toHaveLength(1);
    expect(rules[0]!.fields).toMatchObject({
      action: "Redirect",
      triggerType: "Url",
      triggerPatterns: "*/old/*",
    });
  });

  it("pages DNS zones and maps records with type names", async () => {
    const { c, calls } = client((u) => {
      const page = Number(u.searchParams.get("page"));
      return {
        body: {
          Items:
            page === 1
              ? [
                  {
                    Id: 3,
                    Domain: "example.com",
                    Records: [{ Id: 9, Type: 2, Name: "www", Value: "site.b-cdn.net", Ttl: 300 }],
                  },
                ]
              : [],
          HasMoreItems: page === 1,
        },
      };
    });
    const recs = await c.listResources("dns-record", "a1");
    expect(calls).toHaveLength(2);
    expect(recs[0]!.fields).toMatchObject({
      type: "CNAME",
      name: "www",
      content: "site.b-cdn.net",
      zoneId: "3",
    });
    expect(recs[0]!.externalId).toBe("3/9");
  });

  it("maps errors with status", async () => {
    const { c } = client(() => ({
      status: 401,
      body: { ErrorKey: "unauthorized", Message: "Bad key" },
    }));
    await expect(c.listResources("pull-zone", "a1")).rejects.toMatchObject({
      status: 401,
      message: expect.stringContaining("Bad key"),
    });
  });
});

describe("actions and edits", () => {
  it("creates an edge rule and finds it by its new guid", async () => {
    let added = false;
    const { c, calls } = client((u) => {
      if (u.pathname.endsWith("/addOrUpdate")) {
        added = true;
        return { body: "" };
      }
      return {
        body: {
          ...PZ,
          EdgeRules: added
            ? [
                ...PZ.EdgeRules,
                { Guid: "new", ActionType: 4, Triggers: [{ Type: 4, PatternMatches: ["CN"] }] },
              ]
            : PZ.EdgeRules,
        },
      };
    });
    const r = await c.createResource(
      "edge-rule",
      "a1",
      { action: "BlockRequest", triggerType: "CountryCode", triggerPatterns: '["CN"]' },
      "a1:pull-zone:7",
    );
    expect(r.externalId).toBe("7/new");
    const body = JSON.parse(
      String(calls.find((x) => x.url.endsWith("/addOrUpdate"))!.body),
    ) as Record<string, unknown>;
    expect(body).toMatchObject({ ActionType: 4, Triggers: [{ Type: 4, PatternMatches: ["CN"] }] });
    expect(body["Guid"]).toBeUndefined();
  });

  it("keeps extra triggers when editing an edge rule", () => {
    const current = {
      Guid: "g",
      ActionType: 1,
      Triggers: [
        { Type: 0, PatternMatches: ["a"] },
        { Type: 9, PatternMatches: ["GET"] },
      ],
    };
    const next = edgeRuleFromFields({ triggerPatterns: "b, c" }, current);
    expect(next.Triggers).toEqual([
      { Type: 0, PatternMatches: ["b", "c"] },
      { Type: 9, PatternMatches: ["GET"] },
    ]);
    expect(next.Guid).toBe("g");
  });

  it("purges a URL through POST /purge", async () => {
    const { c, calls } = client(() => ({ body: "" }));
    await c.executeNoSqlCommand("pull-zone", "a1:pull-zone:7", "a1", "purge-url", [
      JSON.stringify({ url: "cdn.example.com/a.png" }),
    ]);
    expect(calls[0]!.method).toBe("POST");
    expect(calls[0]!.url).toBe(
      "https://api.bunny.net/purge?url=https%3A%2F%2Fcdn.example.com%2Fa.png&async=false",
    );
  });

  it("builds update bodies", () => {
    expect(
      pullZoneUpdateBody({
        blockedCountries: "cn, ru",
        originShield: "true",
        originHostHeader: "example.com",
      }),
    ).toEqual({
      BlockedCountries: ["CN", "RU"],
      EnableOriginShield: true,
      OriginHostHeader: "example.com",
      AddHostHeader: true,
    });
    expect(recordBody({ type: "MX", name: "", content: "mx.example.com", priority: "10" })).toEqual(
      { Type: 4, Name: "", Value: "mx.example.com", Ttl: 300, Priority: 10 },
    );
  });
});

describe("ids in paths", () => {
  const HOSTILE = "7/../../billing?x=1";
  const ENCODED = "7%2F..%2F..%2Fbilling%3Fx%3D1";

  it.each([
    ["pull-zone", `/pullzone/${ENCODED}`],
    ["storage-zone", `/storagezone/${ENCODED}`],
    ["dns-zone", `/dnszone/${ENCODED}`],
    ["video-library", `/videolibrary/${ENCODED}`],
    ["edge-script", `/compute/script/${ENCODED}`],
    ["container-app", `/mc/apps/${ENCODED}`],
  ])("encodes the id when deleting a %s", async (type, path) => {
    const { c, calls } = client(() => ({ body: "" }));
    await c.deleteResource(type, `a1:${type}:${HOSTILE}`, "a1");
    expect(calls.map((x) => x.url)).toEqual([`https://api.bunny.net${path}`]);
  });

  it.each([
    ["pull-zone", "purge-all", `/pullzone/${ENCODED}/purgeCache`],
    ["pull-zone", "reset-token-key", `/pullzone/${ENCODED}/resetSecurityKey`],
    ["storage-zone", "reset-password", `/storagezone/${ENCODED}/resetPassword`],
    ["video-library", "reset-api-key", `/videolibrary/${ENCODED}/resetApiKey`],
    ["edge-script", "publish", `/compute/script/${ENCODED}/publish`],
    ["container-app", "restart", `/mc/apps/${ENCODED}/restart`],
    ["container-app", "deploy", `/mc/apps/${ENCODED}/deploy`],
    ["container-app", "undeploy", `/mc/apps/${ENCODED}/undeploy`],
  ])("encodes the id on %s %s", async (type, action, path) => {
    const { c, calls } = client(() => ({ body: "" }));
    await c.invokeAction(type, `a1:${type}:${HOSTILE}`, action, "a1");
    expect(calls.map((x) => x.url)).toEqual([`https://api.bunny.net${path}`]);
  });

  it("encodes both ids of a child on delete", async () => {
    const { c, calls } = client(() => ({ body: "" }));
    await c.deleteResource("edge-rule", "a1:edge-rule:7/g?1/x", "a1");
    await c.deleteResource("dns-record", "a1:dns-record:3/9?x", "a1");
    expect(calls.map((x) => x.url)).toEqual([
      "https://api.bunny.net/pullzone/7/edgerules/g%3F1%2Fx",
      "https://api.bunny.net/dnszone/3/records/9%3Fx",
    ]);
  });

  it("encodes the id in an update and on the statistics routes", async () => {
    const { c, calls } = client((u) => ({
      body: u.pathname.endsWith("/statistics") ? {} : { Id: 7, Name: "z" },
    }));
    await c.updateResource("storage-zone", `a1:storage-zone:${HOSTILE}`, "a1", {
      custom404FilePath: "/404.html",
    });
    expect(calls[0]!.url).toBe(`https://api.bunny.net/storagezone/${ENCODED}`);
    await c.fetchMetricSeries("dns-zone", `a1:dns-zone:${HOSTILE}`, "a1");
    expect(new URL(calls.at(-1)!.url).pathname).toBe(`/dnszone/${ENCODED}/statistics`);
  });

  it.each(["pull-zone", "storage-zone", "dns-zone", "video-library", "edge-script"])(
    "refuses to delete a %s with a blank id",
    async (type) => {
      const { c, calls } = client(() => ({ body: "" }));
      await expect(c.deleteResource(type, `a1:${type}:`, "a1")).rejects.toThrow("blank");
      expect(calls).toEqual([]);
    },
  );

  it.each([
    ["hostname", "a1:hostname:7"],
    ["hostname", "a1:hostname:7/"],
    ["hostname", "a1:hostname:/cdn.example.com"],
    ["edge-rule", "a1:edge-rule:7"],
    ["dns-record", "a1:dns-record:3"],
  ])("refuses to delete a %s missing an id: %s", async (type, id) => {
    const { c, calls } = client(() => ({ body: "" }));
    await expect(c.deleteResource(type, id, "a1")).rejects.toThrow("does not name a child");
    expect(calls).toEqual([]);
  });

  it("refuses to add a hostname to a blank pull zone", async () => {
    const { c, calls } = client(() => ({ body: "" }));
    await expect(c.createResource("hostname", "a1", { hostname: "x.example.com" })).rejects.toThrow(
      "blank",
    );
    expect(calls).toEqual([]);
  });

  describe("storage objects", () => {
    const zone = {
      Id: 1,
      Name: "assets",
      Password: "ZONEPW",
      StorageHostname: "ny.storage.bunnycdn.com",
    };

    it.each(["", "/", "//", "..", "a/..", "./a"])(
      "refuses to delete the object key %j, which would reach something else",
      async (key) => {
        const { c, calls } = client(() => ({ body: [zone] }));
        await expect(c.deleteStorageObject("assets", key)).rejects.toThrow(
          "does not name a storage object",
        );
        expect(calls.filter((x) => x.method === "DELETE")).toEqual([]);
      },
    );

    it("still deletes a folder and an object with an awkward name", async () => {
      const { c, calls } = client((u) => (u.host === "api.bunny.net" ? { body: [zone] } : {}));
      await c.deleteStorageObject("assets", "img/");
      await c.deleteStorageObject("assets", "a b?.txt");
      expect(calls.filter((x) => x.method === "DELETE").map((x) => x.url)).toEqual([
        "https://ny.storage.bunnycdn.com/assets/img/",
        "https://ny.storage.bunnycdn.com/assets/a%20b%3F.txt",
      ]);
    });
  });
});

describe("pull zone origins", () => {
  it.each([
    [0, "Standard"],
    [1, "DnsAccelerate"],
    [2, "Storage"],
    [3, "LoadBalancer"],
    [4, "EdgeScript"],
    [5, "MagicContainer"],
    [6, "PushZone"],
  ])("reads OriginType %i as %s", async (OriginType, name) => {
    const { c } = client(() => ({ body: [{ ...PZ, OriginType }] }));
    const [pz] = await c.listResources("pull-zone", "a1");
    expect(pz!.fields["originType"]).toBe(name);
  });

  it("creates a storage origin with the pull zone number for a storage zone", async () => {
    const { c, calls } = client(() => ({ status: 201, body: { ...PZ, OriginType: 2 } }));
    await c.createResource("pull-zone", "a1", {
      name: "site",
      originType: "storage",
      storageZoneId: "12",
    });
    expect(JSON.parse(String(calls[0]!.body))).toMatchObject({ OriginType: 2, StorageZoneId: 12 });
  });

  async function originBlock(zone: Record<string, unknown>) {
    const { c } = client(() => ({ body: [{ ...PZ, ...zone }] }));
    const resources = await c.listResources("pull-zone", "a1");
    return exportResourcesToTerraform(resources, () => bunnyTerraformExport).hcl;
  }

  it.each([
    [{ OriginType: 2, StorageZoneId: 12 }, ['type = "StorageZone"', "storagezone = 12"]],
    [{ OriginType: 3, LoadBalancerId: 8 }, ['type = "LoadBalancer"', "loadbalancer = 8"]],
    [{ OriginType: 4, EdgeScriptId: 9 }, ['type = "ComputeScript"', "script = 9"]],
    [
      { OriginType: 5, MagicContainersAppId: "app", MagicContainersEndpointId: "ep" },
      ['type = "ComputeContainer"', 'container_app_id = "app"', 'container_endpoint_id = "ep"'],
    ],
    [
      { OriginType: 1, OriginUrl: "https://origin.example.com:8443" },
      ['type = "DnsAccelerate"', "dns_port = 8443", 'dns_scheme = "https"'],
    ],
    [
      { OriginType: 1, OriginUrl: "http://origin.example.com" },
      ['type = "DnsAccelerate"', "dns_port = 80", 'dns_scheme = "http"'],
    ],
    [{ OriginType: 0 }, ['type = "OriginUrl"', 'url = "https://origin.example.com"']],
  ])("ejects the origin block of %j", async (zone, expected) => {
    const hcl = await originBlock(zone);
    for (const line of expected) expect(hcl).toMatch(new RegExp(`${line}\\b|${line}$`, "m"));
  });

  it.each([6, 99])("does not eject OriginType %i, which the provider cannot express", async (t) => {
    expect(await originBlock({ OriginType: t })).not.toContain("bunnynet_pullzone");
  });
});

describe("storage region pickers", () => {
  function regions(body: unknown) {
    return client((u) => (u.pathname === "/storagezone/regions" ? { body } : { body: [] })).c;
  }

  it("uses the documented Code as the option id", async () => {
    const c = regions([
      { Code: "DE", Name: "Falkenstein" },
      { Code: "NY", Name: "New York" },
    ]);
    const { fields } = await c.getCreateConfig("storage-zone");
    const region = fields.find((f) => f.key === "region")!;
    expect(region.defaultValue).toBe("DE");
    expect(region.options).toEqual([
      { id: "DE", label: "Falkenstein", description: "DE" },
      { id: "NY", label: "New York", description: "NY" },
    ]);
    expect(fields.find((f) => f.key === "replicationRegions")!.policies).toEqual([
      { id: "DE", label: "Falkenstein" },
      { id: "NY", label: "New York" },
    ]);
  });

  it("offers video libraries the same codes", async () => {
    const { fields } = await regions([{ Code: "SG", Name: "Singapore" }]).getCreateConfig(
      "video-library",
    );
    expect(fields.find((f) => f.key === "replicationRegions")!.policies).toEqual([
      { id: "SG", label: "Singapore" },
    ]);
  });

  it("falls back to Id for an answer without Code, and drops a row with neither", async () => {
    const { fields } = await regions([
      { Id: "LA", Name: "Los Angeles" },
      { Code: null, Name: "Nowhere" },
    ]).getCreateConfig("storage-zone");
    expect(fields.find((f) => f.key === "region")!.options).toEqual([
      { id: "LA", label: "Los Angeles", description: "LA" },
    ]);
  });

  it("creates a storage zone with the picked code", async () => {
    const { c, calls } = client(() => ({ status: 201, body: { Id: 1, Name: "z" } }));
    await c.createResource("storage-zone", "a1", {
      name: "z",
      region: "NY",
      replicationRegions: '["NY","DE"]',
    });
    expect(JSON.parse(String(calls[0]!.body))).toMatchObject({
      Region: "NY",
      ReplicationRegions: ["DE"],
    });
  });
});

describe("container app metrics", () => {
  const DAY = 86_400_000;

  it.each([
    [DAY, "Hourly"],
    [3 * DAY, "Hourly"],
    [7 * DAY, "Daily"],
  ])("asks for a %i ms window with granularity %s", async (span, granularity) => {
    const { c, calls } = client(() => ({
      body: { cpuUsageChart: { "2026-10-01T00:00:00Z": 1 } },
    }));
    const endMs = Date.parse("2026-10-10T00:00:00Z");
    const out = await c.fetchMetricSeries("container-app", "a1:container-app:app", "a1", {
      startMs: endMs - span,
      endMs,
    });
    const u = new URL(calls[0]!.url);
    expect(u.pathname).toBe("/mc/apps/app/statistics");
    expect(u.searchParams.get("granularity")).toBe(granularity);
    expect(u.searchParams.get("fromDate")).toBe(new Date(endMs - span).toISOString());
    expect(out.map((x) => x.label)).toEqual(["CPU"]);
  });
});

describe("reading a whole list", () => {
  const PAGED: Array<[string, string]> = [
    ["dns-zone", "/dnszone"],
    ["video-library", "/videolibrary"],
    ["edge-script", "/compute/script"],
  ];

  it.each(PAGED)("%s throws when the list outruns the page cap", async (type, path) => {
    const { c, calls } = client((u) => {
      expect(u.pathname).toBe(path);
      return { body: { Items: [{ Id: 1, Name: "x", Domain: "x" }], HasMoreItems: true } };
    });
    await expect(c.listResources(type, "a1")).rejects.toThrow("has more than Infrawrench reads");
    expect(calls).toHaveLength(50);
  });

  it.each(PAGED)("%s throws on a renamed key, first page or later", async (type) => {
    const first = client(() => ({ body: { Rows: [], HasMoreItems: false } }));
    await expect(first.c.listResources(type, "a1")).rejects.toThrow("is not a list");
    const later = client((u) =>
      u.searchParams.get("page") === "1"
        ? { body: { Items: [{ Id: 1, Name: "x", Domain: "x" }], HasMoreItems: true } }
        : { body: { Rows: [], HasMoreItems: false } },
    );
    await expect(later.c.listResources(type, "a1")).rejects.toThrow("is not a list");
    expect(later.calls).toHaveLength(2);
  });

  it.each(PAGED)("%s throws on an empty answer", async (type) => {
    const { c } = client(() => ({ body: "" }));
    await expect(c.listResources(type, "a1")).rejects.toThrow("is not a list");
  });

  it.each(PAGED)("%s reads the document's null Items as an empty page", async (type) => {
    const { c } = client(() => ({ body: { Items: null, HasMoreItems: false } }));
    await expect(c.listResources(type, "a1")).resolves.toEqual([]);
  });

  it("still takes a page that is the array itself", async () => {
    const { c, calls } = client(() => ({ body: [{ Id: 1, Domain: "x" }] }));
    expect(await c.listResources("dns-zone", "a1")).toHaveLength(1);
    expect(calls).toHaveLength(1);
  });

  it.each([
    ["pull-zone", "/pullzone"],
    ["storage-zone", "/storagezone"],
  ])("%s throws when %s does not answer a list", async (type) => {
    const named = client(() => ({ body: { Items: [] } }));
    await expect(named.c.listResources(type, "a1")).rejects.toThrow("is not a list");
    const blank = client(() => ({ body: "" }));
    await expect(blank.c.listResources(type, "a1")).rejects.toThrow("is not a list");
  });

  describe("Magic Containers", () => {
    const app = { id: "app", name: "app" };

    it("throws when the list outruns the page cap, with nothing fetched for it", async () => {
      const { c, calls } = client(() => ({ body: { items: [app], cursor: "next" } }));
      await expect(c.listResources("container-app", "a1")).rejects.toThrow(
        "has more than Infrawrench reads",
      );
      expect(calls).toHaveLength(100);
      expect(calls.every((x) => new URL(x.url).pathname === "/mc/apps")).toBe(true);
    });

    it("reads past the old cap of 5,000 apps", async () => {
      let page = 0;
      const { c } = client((u) => {
        if (u.pathname !== "/mc/apps") return { body: app };
        page++;
        return { body: { items: [app], cursor: page < 60 ? `c${page}` : null } };
      });
      expect(await c.listResources("container-app", "a1")).toHaveLength(60);
    });

    it("throws on a renamed key, first page or later", async () => {
      const first = client(() => ({ body: { apps: [] } }));
      await expect(first.c.listResources("container-app", "a1")).rejects.toThrow("is not a list");
      const later = client((u) =>
        u.pathname !== "/mc/apps"
          ? { body: app }
          : u.searchParams.has("nextCursor")
            ? { body: { apps: [] } }
            : { body: { items: [app], cursor: "next" } },
      );
      await expect(later.c.listResources("container-app", "a1")).rejects.toThrow("is not a list");
    });

    it.each([403, 404])("reads a first page %i as no Magic Containers", async (status) => {
      const { c } = client(() => ({ status, body: { Message: "no" } }));
      await expect(c.listResources("container-app", "a1")).resolves.toEqual([]);
    });

    it.each([403, 404])(
      "fails on a later page's %i rather than prune every app",
      async (status) => {
        const { c } = client((u) =>
          u.pathname !== "/mc/apps"
            ? { body: app }
            : u.searchParams.has("nextCursor")
              ? { status, body: { Message: "no" } }
              : { body: { items: [app], cursor: "next" } },
        );
        await expect(c.listResources("container-app", "a1")).rejects.toMatchObject({ status });
      },
    );

    it("drops only an app deleted between the list and its read", async () => {
      const { c } = client((u) => {
        if (u.pathname === "/mc/apps")
          return { body: { items: [{ id: "gone" }, { id: "app" }], cursor: null } };
        return u.pathname.endsWith("/gone")
          ? { status: 404, body: { Message: "gone" } }
          : { body: app };
      });
      const apps = await c.listResources("container-app", "a1");
      expect(apps.map((a) => a.externalId)).toEqual(["app"]);
    });

    it("fails when an app's read is refused rather than prune every app", async () => {
      const { c } = client((u) =>
        u.pathname === "/mc/apps"
          ? { body: { items: [app], cursor: null } }
          : { status: 403, body: { Message: "no" } },
      );
      await expect(c.listResources("container-app", "a1")).rejects.toMatchObject({ status: 403 });
    });

    it("ends on an empty list", async () => {
      const { c } = client(() => ({ body: { items: [], cursor: null } }));
      await expect(c.listResources("container-app", "a1")).resolves.toEqual([]);
    });

    it("probes with one small page, however many apps there are", async () => {
      const { c, calls } = client((u) =>
        u.pathname === "/mc/apps" ? { body: { items: [app], cursor: "next" } } : { body: [] },
      );
      const { checks } = await c.verifyCredentials();
      expect(checks.find((x) => x.capabilityId === "containers")!.status).toBe("ok");
      const apps = calls.filter((x) => new URL(x.url).pathname === "/mc/apps");
      expect(apps).toHaveLength(1);
      expect(new URL(apps[0]!.url).searchParams.get("limit")).toBe("1");
    });
  });

  describe("the account summary", () => {
    it("fails rather than count a list it could not finish", async () => {
      const { c } = client((u) =>
        u.pathname === "/dnszone"
          ? { body: { Items: [{ Id: 1, Domain: "x" }], HasMoreItems: true } }
          : { body: u.pathname === "/billing" ? {} : [] },
      );
      await expect(c.listResources("account", "a1")).rejects.toThrow(
        "has more than Infrawrench reads",
      );
    });

    it("fails on an answer that is not a list", async () => {
      const { c } = client((u) => ({
        body: u.pathname === "/pullzone" ? { Items: [] } : u.pathname === "/billing" ? {} : [],
      }));
      await expect(c.listResources("account", "a1")).rejects.toThrow("is not a list");
    });

    it("still shows the account when a count is refused", async () => {
      const { c } = client((u) =>
        u.pathname === "/billing" ? { body: {} } : { status: 500, body: { Message: "no" } },
      );
      const [account] = await c.listResources("account", "a1");
      expect(account!.fields).toMatchObject({ pullZoneCount: 0, dnsZoneCount: 0 });
    });
  });

  it("refuses a storage listing that is not a list", async () => {
    const { c } = client((u) =>
      u.host === "api.bunny.net"
        ? { body: [{ Id: 1, Name: "assets", Password: "PW" }] }
        : { body: { Items: [] } },
    );
    await expect(c.listStorageObjects("assets", "")).rejects.toThrow("is not a list");
  });
});

describe("storage browser", () => {
  it("lists with the zone password on the zone's storage host", async () => {
    const { c, calls } = client((u) => {
      if (u.host === "api.bunny.net")
        return {
          body: [
            {
              Id: 1,
              Name: "assets",
              Password: "ZONEPW",
              StorageHostname: "ny.storage.bunnycdn.com",
            },
          ],
        };
      return {
        body: [
          { ObjectName: "img", IsDirectory: true },
          { ObjectName: "a b.txt", Length: 5, LastChanged: "2026-10-01T00:00:00" },
        ],
      };
    });
    const out = await c.listStorageObjects("assets", "");
    expect(out.map((o) => [o.key, o.isDirectory])).toEqual([
      ["img/", true],
      ["a b.txt", false],
    ]);
    expect(out[1]!.lastModified).toBe("2026-10-01T00:00:00Z");
    const list = calls[1]!;
    expect(list.url).toBe("https://ny.storage.bunnycdn.com/assets/");
    expect(list.headers["AccessKey"]).toBe("ZONEPW");
  });
});

describe("billing, status and terraform", () => {
  it("splits this month by product and dates closed months", () => {
    const rows = billingCostRows(
      {
        MonthlyChargesEUTraffic: 1.5,
        MonthlyChargesStorage: 0.25,
        MonthlyChargesTaxes: 0.3,
        MonthlyChargesDNS: 0,
        BillingRecords: [
          { Id: 1, Amount: -12, Timestamp: "2026-10-01T00:05:00Z", Type: 3 },
          { Id: 2, Amount: 50, Timestamp: "2026-09-10T00:00:00Z", Type: 2 },
        ],
      },
      new Date("2026-10-15T00:00:00Z"),
    );
    expect(rows).toEqual([
      { date: "2026-10-01", currency: "USD", amount: 1.5, service: "CDN traffic", region: "EU" },
      { date: "2026-10-01", currency: "USD", amount: 0.25, service: "Edge Storage" },
      { date: "2026-10-01", currency: "USD", amount: 0.3, service: "Taxes", chargeType: "tax" },
      { date: "2026-09-01", currency: "USD", amount: 12, service: "All products" },
    ]);
    expect(creditBalances({ Balance: 20, CouponBalance: 0 })).toEqual([
      { key: "balance", label: "Prepaid balance", remaining: 20, currency: "USD" },
    ]);
  });

  it("parses charts", () => {
    expect(
      chartPoints({ "2026-10-02T00:00:00Z": 2, "2026-10-01T00:00:00Z": 1 }).map((p) => p.value),
    ).toEqual([1, 2]);
    expect(chartPoints([{ x: "2026-10-01T00:00:00Z", y: 3 }])[0]!.value).toBe(3);
  });

  it("maps status components to resource types", () => {
    expect(mapComponent("CDN")).toMatchObject({
      resourceTypes: ["pull-zone", "hostname", "edge-rule"],
    });
    expect(mapComponent("Bunny Fonts")).toBeNull();
    const out = parseStatusFeed(
      JSON.stringify({
        incidents: [
          {
            id: "x",
            name: "Storage slow",
            status: "investigating",
            impact: "major",
            components: [{ name: "Edge Storage" }],
          },
        ],
      }),
    );
    expect(out[0]!.resourceTypes).toEqual(["storage-zone"]);
  });

  it("exports a pull zone and a DNS record", () => {
    const base = {
      pluginId: "bunny",
      accountId: "a1",
      resolvedOutputs: {},
      secretStates: [],
      createdAt: "",
      updatedAt: "",
    };
    const out = exportResourcesToTerraform(
      [
        {
          ...base,
          id: "a1:pull-zone:7",
          resourceTypeId: "pull-zone",
          displayName: "site",
          externalId: "7",
          fields: {
            name: "site",
            originJson: JSON.stringify({ type: "Standard", url: "https://o" }),
          },
        },
        {
          ...base,
          id: "a1:dns-record:3/9",
          resourceTypeId: "dns-record",
          displayName: "CNAME www",
          externalId: "3/9",
          fields: { type: "CNAME", name: "www", content: "x.b-cdn.net", ttl: 300 },
        },
      ],
      () => bunnyTerraformExport,
    );
    expect(out.hcl).toContain('resource "bunnynet_pullzone"');
    expect(out.hcl).toContain('type = "OriginUrl"');
    expect(out.hcl).toContain("terraform import bunnynet_dns_record.cname_www 3|9");
  });
});
