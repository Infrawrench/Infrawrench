import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// `agents` and `dns` on effect/cli: text and `--json` output, scopes and
// refusals, against fixtures. Nothing reaches a network or a database.
vi.mock("electron", () => ({
  app: { getPath: () => "/tmp", getVersion: () => "9.9.9" },
  shell: { openExternal: vi.fn() },
  ipcMain: { handle: () => {} },
  safeStorage: { isEncryptionAvailable: () => false },
}));

vi.mock("../cloud-tokens", () => ({
  getAccessToken: vi.fn(async () => "tok"),
  forceRefreshAccessToken: vi.fn(async () => null),
  fetchCloudOrgs: vi.fn(async () => [{ id: "org_1", displayName: "Acme", role: "admin" }]),
  getAuthStatus: vi.fn(async () => ({ authenticated: true, email: "ada@example.com" })),
  clearStoredTokens: vi.fn(),
  createPkceChallenge: vi.fn(),
  buildAuthorizeUrl: vi.fn(),
  exchangeAuthorizationCode: vi.fn(),
  setTokenStoreReadOnly: vi.fn(),
}));

const localDns = vi.hoisted(() => vi.fn());
vi.mock("../local-dns", () => ({ listLocalDns: localDns }));

import { RawResponse, run, serveRoutes, useCliCapture } from "./cli-harness";

const out = useCliCapture();

const HOUR = 3_600_000;
const NOW = Date.parse("2026-11-08T12:00:00.000Z");
const iso = (msAgo: number) => new Date(NOW - msAgo).toISOString();

const AGENTS = [
  {
    id: "a1",
    label: "ci-bot",
    kind: "cli",
    prefix: "iwa_abcd",
    claimedAt: iso(48 * HOUR),
    claimedByUserId: "u1",
    claimedByEmail: "ada@example.com",
    lastSeenAt: iso(2 * HOUR),
    revokedAt: null,
    createdAt: iso(72 * HOUR),
    linkId: null,
    externalId: null,
    scopes: null,
    providers: null,
  },
  {
    id: "a2",
    label: null,
    kind: "cli",
    prefix: "iwa_efgh",
    claimedAt: null,
    claimedByUserId: null,
    claimedByEmail: null,
    lastSeenAt: null,
    revokedAt: null,
    createdAt: iso(HOUR),
    linkId: null,
    externalId: null,
    scopes: null,
    providers: null,
  },
  {
    id: "a3",
    label: "nibblet",
    kind: "platform",
    prefix: null,
    claimedAt: iso(HOUR),
    claimedByUserId: null,
    claimedByEmail: null,
    lastSeenAt: iso(30_000),
    revokedAt: null,
    createdAt: iso(HOUR),
    linkId: "l1",
    externalId: "n1",
    scopes: ["costs:read"],
    providers: [],
  },
];

describe("agents", () => {
  // Only Date: Effect's scheduler needs the real timers.
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(NOW);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("prints the table and the unclaimed note", async () => {
    serveRoutes(out, { "GET /agent-registrations": AGENTS });
    expect(await run("agents")).toBe(0);
    expect(out.stdout).toMatchInlineSnapshot(`
      "Acme · agent credentials

      NAME     STATUS     CREDENTIAL  CLAIMED BY       LAST USED
      ci-bot   claimed    iwa_abcd…   ada@example.com  2h ago   
      unnamed  unclaimed  iwa_efgh…   —                never    
      nibblet  platform   external    —                just now 

      1 unclaimed. Their workspaces are deleted 24 hours after they were created.
      "
    `);
    expect(out.stdout).toContain("1 unclaimed.");
  });

  it("prints the raw rows under --json", async () => {
    serveRoutes(out, { "GET /agent-registrations": AGENTS });
    expect(await run("agents", "--json")).toBe(0);
    expect(JSON.parse(out.stdout)).toEqual({ org: "org_1", agents: AGENTS });
    expect(out.stdout).toMatchInlineSnapshot(`
      "{
        "org": "org_1",
        "agents": [
          {
            "id": "a1",
            "label": "ci-bot",
            "kind": "cli",
            "prefix": "iwa_abcd",
            "claimedAt": "2026-11-06T12:00:00.000Z",
            "claimedByUserId": "u1",
            "claimedByEmail": "ada@example.com",
            "lastSeenAt": "2026-11-08T10:00:00.000Z",
            "revokedAt": null,
            "createdAt": "2026-11-05T12:00:00.000Z",
            "linkId": null,
            "externalId": null,
            "scopes": null,
            "providers": null
          },
          {
            "id": "a2",
            "label": null,
            "kind": "cli",
            "prefix": "iwa_efgh",
            "claimedAt": null,
            "claimedByUserId": null,
            "claimedByEmail": null,
            "lastSeenAt": null,
            "revokedAt": null,
            "createdAt": "2026-11-08T11:00:00.000Z",
            "linkId": null,
            "externalId": null,
            "scopes": null,
            "providers": null
          },
          {
            "id": "a3",
            "label": "nibblet",
            "kind": "platform",
            "prefix": null,
            "claimedAt": "2026-11-08T11:00:00.000Z",
            "claimedByUserId": null,
            "claimedByEmail": null,
            "lastSeenAt": "2026-11-08T11:59:30.000Z",
            "revokedAt": null,
            "createdAt": "2026-11-08T11:00:00.000Z",
            "linkId": "l1",
            "externalId": "n1",
            "scopes": [
              "costs:read"
            ],
            "providers": []
          }
        ]
      }
      "
    `);
  });

  it("says when nothing has registered", async () => {
    serveRoutes(out, { "GET /agent-registrations": [] });
    expect(await run("agents")).toBe(0);
    expect(out.stdout).toBe(
      "Acme · agent credentials\n\nNo agents have registered against this organization.\n",
    );
  });

  it("reports a body that is not the listing", async () => {
    serveRoutes(out, { "GET /agent-registrations": [{ label: 3 }] });
    expect(await run("agents")).toBe(1);
    expect(out.stderr).toMatch(
      /^Cloud request returned a malformed response for \/agent-registrations: /,
    );
  });

  it("names a failed request", async () => {
    serveRoutes(out, { "GET /agent-registrations": new RawResponse(403, '{"error":"no"}') });
    expect(await run("agents")).toBe(1);
    expect(out.stderr).toBe('Cloud request failed: 403 /agent-registrations {"error":"no"}\n');
  });
});

const dangling = {
  value: "acme-assets.s3.amazonaws.com",
  classification: "dangling",
  resource: null,
  service: {
    pluginId: "aws",
    pluginName: "AWS",
    resourceTypeId: "s3-bucket",
    ruleId: "s3",
    label: "S3 bucket endpoint",
    severity: "high",
    reason: "Anyone can create that bucket.",
    claimLabel: "acme-assets",
  },
};

const record = (name: string, status: string, targets: unknown[]) => ({
  resourceId: `r:${name}`,
  pluginId: "cloudflare",
  pluginName: "Cloudflare",
  resourceTypeId: "dns-record",
  resourceTypeName: "DNS record",
  accountId: "acc1",
  accountName: "prod",
  zoneResourceId: "z1",
  zoneDomain: "acme.com",
  name,
  type: "CNAME",
  ttl: 300,
  priority: null,
  proxied: false,
  targets,
  status,
});

const INVENTORY = {
  zones: [
    {
      resourceId: "z1",
      pluginId: "cloudflare",
      pluginName: "Cloudflare",
      resourceTypeId: "dns-zone",
      resourceTypeName: "DNS zone",
      accountId: "acc1",
      accountName: "prod",
      domain: "acme.com",
      status: "active",
      isPrivate: false,
      recordCount: 3,
      providerRecordCount: 5,
      danglingCount: 1,
    },
    {
      resourceId: "z2",
      pluginId: "aws",
      pluginName: "AWS",
      resourceTypeId: "route53-zone",
      resourceTypeName: "Hosted zone",
      accountId: "acc2",
      accountName: "infra",
      domain: "internal.acme",
      status: null,
      isPrivate: true,
      recordCount: 0,
      providerRecordCount: null,
      danglingCount: 0,
    },
  ],
  records: [
    record("assets.acme.com", "dangling", [dangling]),
    record("www.acme.com", "owned", [
      { value: "lb.acme.com", classification: "owned", resource: null, service: null },
    ]),
    record("x.acme.com", "brand-new-classification", []),
  ],
  counts: { zones: 2, records: 3, owned: 1, dangling: 1, external: 0, notAnalysed: 1 },
  skippedNamespaces: [
    { pluginId: "vercel", pluginName: "Vercel", label: "Vercel alias", reason: "not synced" },
  ],
  generatedAt: "2026-11-08T00:00:00.000Z",
};

describe("dns", () => {
  it("prints zones, records, dangling detail and gaps", async () => {
    serveRoutes(out, { "GET /dns": INVENTORY });
    expect(await run("dns")).toBe(0);
    expect(out.stdout).toMatchInlineSnapshot(`
      "Acme · 2 zones, 3 records  1 dangling · 1 internal · 1 not analysed

      DOMAIN                   PROVIDER    ACCOUNT  RECORDS         DANGLING
      acme.com                 Cloudflare  prod     3 (5 reported)  1       
      internal.acme (private)  AWS         infra    0               0       

      STATUS                    TYPE   NAME             TARGET                        PROVIDER  
      dangling                  CNAME  assets.acme.com  acme-assets.s3.amazonaws.com  Cloudflare
      internal                  CNAME  www.acme.com     lb.acme.com                   Cloudflare
      brand-new-classification  CNAME  x.acme.com       —                             Cloudflare

      dangling CNAME assets.acme.com → acme-assets.s3.amazonaws.com
        S3 bucket endpoint. Nothing synced claims "acme-assets". Anyone can create that bucket.

      Not checked
        Vercel alias, not synced

      Computed from synced state; no provider was contacted and no DNS was resolved.
      "
    `);
    expect(out.stdout).toContain("brand-new-classification");
  });

  it("prints the org and the raw body under --json", async () => {
    serveRoutes(out, { "GET /dns": INVENTORY });
    expect(await run("dns", "--json")).toBe(0);
    expect(JSON.parse(out.stdout)).toEqual({ org: "org_1", ...INVENTORY });
    expect(out.stdout).toMatchInlineSnapshot(`
      "{
        "org": "org_1",
        "zones": [
          {
            "resourceId": "z1",
            "pluginId": "cloudflare",
            "pluginName": "Cloudflare",
            "resourceTypeId": "dns-zone",
            "resourceTypeName": "DNS zone",
            "accountId": "acc1",
            "accountName": "prod",
            "domain": "acme.com",
            "status": "active",
            "isPrivate": false,
            "recordCount": 3,
            "providerRecordCount": 5,
            "danglingCount": 1
          },
          {
            "resourceId": "z2",
            "pluginId": "aws",
            "pluginName": "AWS",
            "resourceTypeId": "route53-zone",
            "resourceTypeName": "Hosted zone",
            "accountId": "acc2",
            "accountName": "infra",
            "domain": "internal.acme",
            "status": null,
            "isPrivate": true,
            "recordCount": 0,
            "providerRecordCount": null,
            "danglingCount": 0
          }
        ],
        "records": [
          {
            "resourceId": "r:assets.acme.com",
            "pluginId": "cloudflare",
            "pluginName": "Cloudflare",
            "resourceTypeId": "dns-record",
            "resourceTypeName": "DNS record",
            "accountId": "acc1",
            "accountName": "prod",
            "zoneResourceId": "z1",
            "zoneDomain": "acme.com",
            "name": "assets.acme.com",
            "type": "CNAME",
            "ttl": 300,
            "priority": null,
            "proxied": false,
            "targets": [
              {
                "value": "acme-assets.s3.amazonaws.com",
                "classification": "dangling",
                "resource": null,
                "service": {
                  "pluginId": "aws",
                  "pluginName": "AWS",
                  "resourceTypeId": "s3-bucket",
                  "ruleId": "s3",
                  "label": "S3 bucket endpoint",
                  "severity": "high",
                  "reason": "Anyone can create that bucket.",
                  "claimLabel": "acme-assets"
                }
              }
            ],
            "status": "dangling"
          },
          {
            "resourceId": "r:www.acme.com",
            "pluginId": "cloudflare",
            "pluginName": "Cloudflare",
            "resourceTypeId": "dns-record",
            "resourceTypeName": "DNS record",
            "accountId": "acc1",
            "accountName": "prod",
            "zoneResourceId": "z1",
            "zoneDomain": "acme.com",
            "name": "www.acme.com",
            "type": "CNAME",
            "ttl": 300,
            "priority": null,
            "proxied": false,
            "targets": [
              {
                "value": "lb.acme.com",
                "classification": "owned",
                "resource": null,
                "service": null
              }
            ],
            "status": "owned"
          },
          {
            "resourceId": "r:x.acme.com",
            "pluginId": "cloudflare",
            "pluginName": "Cloudflare",
            "resourceTypeId": "dns-record",
            "resourceTypeName": "DNS record",
            "accountId": "acc1",
            "accountName": "prod",
            "zoneResourceId": "z1",
            "zoneDomain": "acme.com",
            "name": "x.acme.com",
            "type": "CNAME",
            "ttl": 300,
            "priority": null,
            "proxied": false,
            "targets": [],
            "status": "brand-new-classification"
          }
        ],
        "counts": {
          "zones": 2,
          "records": 3,
          "owned": 1,
          "dangling": 1,
          "external": 0,
          "notAnalysed": 1
        },
        "skippedNamespaces": [
          {
            "pluginId": "vercel",
            "pluginName": "Vercel",
            "label": "Vercel alias",
            "reason": "not synced"
          }
        ],
        "generatedAt": "2026-11-08T00:00:00.000Z"
      }
      "
    `);
  });

  it("scans the local workspace with --local and contacts no server", async () => {
    localDns.mockResolvedValue({ ...INVENTORY, zones: [], records: [] });
    serveRoutes(out, {});
    expect(await run("dns", "--local")).toBe(0);
    expect(out.requests).toEqual([]);
    expect(out.stdout).toMatchInlineSnapshot(`
      "No DNS zones synced. Connect an account on a provider that manages DNS (Cloudflare, Route 53, Cloud DNS, DigitalOcean, Netlify, Azure DNS or Vercel).
      This scan covered the local workspace only; drop --local for your organization.
      "
    `);
    expect(out.stdout).toContain("drop --local for your organization");
  });

  it("prints a local scan as JSON without an org", async () => {
    localDns.mockResolvedValue(INVENTORY);
    expect(await run("dns", "--local", "--json")).toBe(0);
    expect(JSON.parse(out.stdout)).toEqual(INVENTORY);
  });

  it("refuses a stray positional", async () => {
    expect(await run("dns", "extra")).toBe(2);
    expect(out.stdout).toBe("");
  });
});
