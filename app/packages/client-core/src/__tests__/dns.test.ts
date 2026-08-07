import { describe, expect, it } from "vitest";

import {
  computeDnsInventory,
  danglingDnsRecords,
  normalizeDnsHost,
  type DnsScanInput,
  type DnsScanPlugin,
  type DnsScanResource,
} from "../dns";
import { computePostureFindings, DANGLING_DNS_RULE_ID } from "../posture";

const NOW = Date.parse("2026-08-01T12:00:00.000Z");

/**
 * A Cloudflare-shaped DNS provider (zone + record with the default field
 * names) plus a Vercel-shaped app provider whose projects claim `*.vercel.app`.
 * Between them these two cover every mechanism: zone/record roles, the
 * parent link, the name-based claim, and the has-data guard.
 */
const CLOUDFLARE: DnsScanPlugin = {
  id: "cloudflare",
  displayName: "Cloudflare",
  resourceTypes: [
    {
      id: "zone",
      displayName: "Zone",
      dnsRole: { role: "zone", domainKey: "name", statusKey: "status" },
    },
    {
      id: "dns-record",
      displayName: "DNS Record",
      dnsRole: { role: "record", zoneKey: "zoneName", proxiedKey: "proxied" },
    },
  ],
};

const VERCEL: DnsScanPlugin = {
  id: "vercel",
  displayName: "Vercel",
  resourceTypes: [
    {
      id: "vercel-project",
      displayName: "Project",
      dnsServiceHosts: [
        {
          id: "vercel-alias",
          label: "Vercel deployment alias",
          hostPattern: String.raw`([a-z0-9][a-z0-9-]*)\.vercel\.app`,
          hostKeys: ["productionUrl"],
          reason: "Anyone can claim the alias.",
        },
      ],
    },
  ],
};

function zone(overrides: Partial<DnsScanResource> = {}): DnsScanResource {
  return {
    id: "zone-1",
    pluginId: "cloudflare",
    resourceTypeId: "zone",
    accountId: "cf-acc",
    displayName: "example.com",
    externalId: "zone-ext-1",
    parentResourceId: null,
    fields: { name: "example.com", status: "active" },
    ...overrides,
  };
}

function record(
  fields: Record<string, unknown>,
  overrides: Partial<DnsScanResource> = {},
): DnsScanResource {
  return {
    id: "rec-1",
    pluginId: "cloudflare",
    resourceTypeId: "dns-record",
    accountId: "cf-acc",
    displayName: "www",
    externalId: "rec-ext-1",
    parentResourceId: "zone-1",
    fields,
    ...overrides,
  };
}

function project(overrides: Partial<DnsScanResource> = {}): DnsScanResource {
  return {
    id: "proj-1",
    pluginId: "vercel",
    resourceTypeId: "vercel-project",
    accountId: "vc-acc",
    displayName: "Marketing",
    externalId: "prj_abc",
    parentResourceId: null,
    fields: { name: "marketing" },
    ...overrides,
  };
}

/** Both accounts connected by default — the has-data guard has its own tests. */
function scan(resources: DnsScanResource[], accounts?: DnsScanInput["accounts"]): DnsScanInput {
  return {
    plugins: [CLOUDFLARE, VERCEL],
    accounts: accounts ?? [
      { id: "cf-acc", displayName: "Cloudflare prod", pluginId: "cloudflare" },
      { id: "vc-acc", displayName: "Vercel team", pluginId: "vercel" },
    ],
    resources,
  };
}

function statusOf(input: DnsScanInput): string {
  const inventory = computeDnsInventory(input, { now: NOW });
  return inventory.records[0]?.status ?? "no-records";
}

describe("normalizeDnsHost", () => {
  it("reduces the forms listers actually store to one host", () => {
    expect(normalizeDnsHost("https://Site.Netlify.app/path")).toBe("site.netlify.app");
    expect(normalizeDnsHost("site.netlify.app.")).toBe("site.netlify.app");
    expect(normalizeDnsHost("db.example.com:5432")).toBe("db.example.com");
  });

  it("leaves an IPv6 address alone rather than reading its tail as a port", () => {
    expect(normalizeDnsHost("2606:4700::6810:85e5")).toBe("2606:4700::6810:85e5");
  });
});

describe("zones and records", () => {
  it("attributes a record to its zone through parentResourceId", () => {
    const inventory = computeDnsInventory(
      scan([zone(), record({ type: "CNAME", name: "www.example.com", content: "elsewhere.test" })]),
      { now: NOW },
    );
    expect(inventory.records[0]?.zoneDomain).toBe("example.com");
    expect(inventory.zones[0]?.recordCount).toBe(1);
  });

  it("falls back to the declared zoneKey when the sync path set no parent", () => {
    const inventory = computeDnsInventory(
      scan([
        zone(),
        record(
          { type: "CNAME", name: "www", content: "elsewhere.test", zoneName: "example.com" },
          { parentResourceId: null },
        ),
      ]),
      { now: NOW },
    );
    expect(inventory.records[0]?.zoneDomain).toBe("example.com");
  });

  it("qualifies a relative record name against the zone and strips trailing dots", () => {
    const inventory = computeDnsInventory(
      scan([
        zone(),
        record({ type: "A", name: "@", content: "203.0.113.7" }),
        record({ type: "A", name: "api.example.com.", content: "203.0.113.8" }, { id: "rec-2" }),
      ]),
      { now: NOW },
    );
    const names = inventory.records.map((r) => r.name).sort();
    expect(names).toEqual(["api.example.com", "example.com"]);
  });

  it("splits a comma-joined value into one target per address", () => {
    const inventory = computeDnsInventory(
      scan([zone(), record({ type: "A", name: "www", content: "203.0.113.7, 203.0.113.8" })]),
      { now: NOW },
    );
    expect(inventory.records[0]?.targets.map((t) => t.value)).toEqual([
      "203.0.113.7",
      "203.0.113.8",
    ]);
  });

  it("skips resources whose account is gone", () => {
    const inventory = computeDnsInventory(scan([zone()], []), { now: NOW });
    expect(inventory.zones).toEqual([]);
  });
});

describe("target classification", () => {
  it("flags a record pointing at an unclaimed provider alias as dangling", () => {
    expect(
      statusOf(
        scan([
          zone(),
          record({ type: "CNAME", name: "www", content: "gone.vercel.app" }),
          project(),
        ]),
      ),
    ).toBe("dangling");
  });

  it("does not flag one a synced project claims by name", () => {
    expect(
      statusOf(
        scan([
          zone(),
          record({ type: "CNAME", name: "www", content: "marketing.vercel.app" }),
          project(),
        ]),
      ),
    ).toBe("owned");
  });

  it("accepts a hostKeys match when the label isn't the resource name", () => {
    expect(
      statusOf(
        scan([
          zone(),
          record({ type: "CNAME", name: "www", content: "marketing-a1b2c3.vercel.app" }),
          project({
            fields: { name: "marketing", productionUrl: "https://marketing-a1b2c3.vercel.app" },
          }),
        ]),
      ),
    ).toBe("owned");
  });

  it("calls an unrecognised host external, never dangling", () => {
    expect(
      statusOf(
        scan([
          zone(),
          record({ type: "CNAME", name: "www", content: "app.somesaas.com" }),
          project(),
        ]),
      ),
    ).toBe("external");
  });

  it("resolves an address to the resource that answers to it", () => {
    const droplet: DnsScanResource = {
      id: "d-1",
      pluginId: "cloudflare",
      resourceTypeId: "zone",
      accountId: "cf-acc",
      displayName: "web-1",
      externalId: "d-1-ext",
      parentResourceId: null,
      // `ip` is one of the shared identity keys, so the address is an identity.
      fields: { name: "web-1", ip: "203.0.113.7" },
    };
    const inventory = computeDnsInventory(
      scan([zone(), record({ type: "A", name: "www", content: "203.0.113.7" }), droplet]),
      { now: NOW },
    );
    expect(inventory.records[0]?.status).toBe("owned");
    expect(inventory.records[0]?.targets[0]?.resource?.displayName).toBe("web-1");
  });

  it("never analyses a record type with no host target", () => {
    expect(
      statusOf(
        scan([zone(), record({ type: "TXT", name: "www", content: "gone.vercel.app" }), project()]),
      ),
    ).toBe("not-analysed");
  });

  it("never flags inside a private zone", () => {
    const privateZone = zone({
      fields: { name: "internal.example.com", status: "active", visibility: "private" },
    });
    const plugins: DnsScanPlugin[] = [
      {
        ...CLOUDFLARE,
        resourceTypes: [
          {
            id: "zone",
            displayName: "Zone",
            dnsRole: {
              role: "zone",
              domainKey: "name",
              privateKey: "visibility",
              privateValues: ["private"],
            },
          },
          CLOUDFLARE.resourceTypes[1]!,
        ],
      },
      VERCEL,
    ];
    const inventory = computeDnsInventory(
      {
        ...scan([
          privateZone,
          record({ type: "CNAME", name: "www", content: "gone.vercel.app" }),
          project(),
        ]),
        plugins,
      },
      { now: NOW },
    );
    expect(inventory.records[0]?.status).toBe("external");
  });
});

describe("the has-data guard", () => {
  const danglingRows = [
    zone(),
    record({ type: "CNAME", name: "www", content: "gone.vercel.app" }),
    project(),
  ];

  it("says nothing when the plugin has no connected account", () => {
    const inventory = computeDnsInventory(
      scan(danglingRows, [
        { id: "cf-acc", displayName: "Cloudflare prod", pluginId: "cloudflare" },
      ]),
      { now: NOW },
    );
    expect(inventory.records[0]?.status).toBe("external");
    expect(inventory.skippedNamespaces).toHaveLength(1);
    expect(inventory.skippedNamespaces[0]?.reason).toContain("account is connected");
  });

  it("says nothing when no claimant resource has synced", () => {
    const inventory = computeDnsInventory(
      scan([zone(), record({ type: "CNAME", name: "www", content: "gone.vercel.app" })]),
      { now: NOW },
    );
    expect(inventory.records[0]?.status).toBe("external");
    expect(inventory.skippedNamespaces[0]?.reason).toContain("has synced yet");
  });

  it("reports nothing skipped once both are present", () => {
    const inventory = computeDnsInventory(scan(danglingRows), { now: NOW });
    expect(inventory.skippedNamespaces).toEqual([]);
    expect(inventory.counts.dangling).toBe(1);
    expect(danglingDnsRecords(inventory)).toHaveLength(1);
  });
});

describe("the posture bridge", () => {
  it("turns each dangling record into one finding on the record resource", () => {
    const input = scan([
      zone(),
      record({ type: "CNAME", name: "www", content: "gone.vercel.app" }),
      project(),
    ]);
    const dns = computeDnsInventory(input, { now: NOW });
    const posture = computePostureFindings(
      { plugins: input.plugins, accounts: input.accounts, resources: input.resources },
      { now: NOW, dns },
    );

    expect(posture.findings).toHaveLength(1);
    const finding = posture.findings[0]!;
    expect(finding.ruleId).toBe(DANGLING_DNS_RULE_ID);
    expect(finding.resourceId).toBe("rec-1");
    expect(finding.severity).toBe("high");
    expect(finding.displayName).toBe("www.example.com");
    expect(finding.reason).toContain("gone.vercel.app");
    expect(posture.counts.high).toBe(1);
  });

  it("emits nothing when the inventory isn't supplied", () => {
    const input = scan([
      zone(),
      record({ type: "CNAME", name: "www", content: "gone.vercel.app" }),
      project(),
    ]);
    const posture = computePostureFindings(
      { plugins: input.plugins, accounts: input.accounts, resources: input.resources },
      { now: NOW },
    );
    expect(posture.findings).toEqual([]);
  });
});
