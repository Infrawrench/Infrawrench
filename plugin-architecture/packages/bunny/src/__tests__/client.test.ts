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
  return { c: new BunnyClient({ apiKey: "KEY" }, { http } as never), calls };
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
