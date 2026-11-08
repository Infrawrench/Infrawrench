import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// `leases`, `ownership`, `blast-radius`, `oversized`, `github-issues` and
// `idle-rules` on effect/cli: text and `--json` output, refusals and parse
// errors, against fixtures. Nothing reaches a network or a database.
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

import { run, serveRoutes, useCliCapture } from "./cli-harness";

const out = useCliCapture();

const NOW = new Date("2026-11-08T12:00:00.000Z");
beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
});
afterEach(() => {
  vi.useRealTimers();
});

const lease = (over: Record<string, unknown>) => ({
  id: "l1",
  resourceId: "acc1:droplet:1",
  accountId: "acc1",
  pluginId: "digitalocean",
  resourceTypeId: "droplet",
  resourceName: "staging-web",
  accountName: "do-prod",
  expiresAt: "2026-11-11T12:00:00.000Z",
  autoDelete: false,
  note: null,
  status: "active",
  firstWarningAt: null,
  finalWarningAt: null,
  deleteAttempts: 0,
  lastError: null,
  completedAt: null,
  createdAt: "2026-11-01T00:00:00.000Z",
  updatedAt: "2026-11-01T00:00:00.000Z",
  ...over,
});

const LEASES = {
  leases: [
    lease({}),
    lease({
      id: "l2",
      resourceName: "demo-db",
      expiresAt: "2026-11-08T10:00:00.000Z",
      autoDelete: true,
      firstWarningAt: "2026-11-07T00:00:00.000Z",
      note: "for the Q4 demo",
    }),
    lease({ id: "l3", resourceName: "old-box", status: "failed", lastError: "freeze in effect" }),
    lease({ id: "l4", resourceName: "gone", status: "deleted" }),
  ],
};

describe("leases", () => {
  it("prints the table", async () => {
    serveRoutes(out, { "GET /leases": LEASES });
    expect(await run("leases")).toBe(0);
    expect(out.stdout).toMatchInlineSnapshot(`
      "Acme · 4 leases (2 active)

      RESOURCE     ACCOUNT  EXPIRES                         AUTO-DELETE  STATUS                    NOTE           
      staging-web  do-prod  in 3d (2026-11-11 12:00Z)       no           active                    —              
      demo-db      do-prod  2h overdue (2026-11-08 10:00Z)  yes          first warning sent        for the Q4 demo
      old-box      do-prod  2026-11-11 12:00Z               no           failed: freeze in effect  —              
      gone         do-prod  2026-11-11 12:00Z               no           deleted                   —              

      Active leases also appear in \`infrawrench expiring\`. Auto-deletes are announced twice before they fire and pause during change freezes.
      "
    `);
  });

  it("prints the raw body under --json", async () => {
    serveRoutes(out, { "GET /leases": LEASES });
    expect(await run("leases", "--json")).toBe(0);
    expect(JSON.parse(out.stdout)).toEqual({ org: "org_1", ...LEASES });
    expect(out.stdout).toMatchInlineSnapshot(`
      "{
        "org": "org_1",
        "leases": [
          {
            "id": "l1",
            "resourceId": "acc1:droplet:1",
            "accountId": "acc1",
            "pluginId": "digitalocean",
            "resourceTypeId": "droplet",
            "resourceName": "staging-web",
            "accountName": "do-prod",
            "expiresAt": "2026-11-11T12:00:00.000Z",
            "autoDelete": false,
            "note": null,
            "status": "active",
            "firstWarningAt": null,
            "finalWarningAt": null,
            "deleteAttempts": 0,
            "lastError": null,
            "completedAt": null,
            "createdAt": "2026-11-01T00:00:00.000Z",
            "updatedAt": "2026-11-01T00:00:00.000Z"
          },
          {
            "id": "l2",
            "resourceId": "acc1:droplet:1",
            "accountId": "acc1",
            "pluginId": "digitalocean",
            "resourceTypeId": "droplet",
            "resourceName": "demo-db",
            "accountName": "do-prod",
            "expiresAt": "2026-11-08T10:00:00.000Z",
            "autoDelete": true,
            "note": "for the Q4 demo",
            "status": "active",
            "firstWarningAt": "2026-11-07T00:00:00.000Z",
            "finalWarningAt": null,
            "deleteAttempts": 0,
            "lastError": null,
            "completedAt": null,
            "createdAt": "2026-11-01T00:00:00.000Z",
            "updatedAt": "2026-11-01T00:00:00.000Z"
          },
          {
            "id": "l3",
            "resourceId": "acc1:droplet:1",
            "accountId": "acc1",
            "pluginId": "digitalocean",
            "resourceTypeId": "droplet",
            "resourceName": "old-box",
            "accountName": "do-prod",
            "expiresAt": "2026-11-11T12:00:00.000Z",
            "autoDelete": false,
            "note": null,
            "status": "failed",
            "firstWarningAt": null,
            "finalWarningAt": null,
            "deleteAttempts": 0,
            "lastError": "freeze in effect",
            "completedAt": null,
            "createdAt": "2026-11-01T00:00:00.000Z",
            "updatedAt": "2026-11-01T00:00:00.000Z"
          },
          {
            "id": "l4",
            "resourceId": "acc1:droplet:1",
            "accountId": "acc1",
            "pluginId": "digitalocean",
            "resourceTypeId": "droplet",
            "resourceName": "gone",
            "accountName": "do-prod",
            "expiresAt": "2026-11-11T12:00:00.000Z",
            "autoDelete": false,
            "note": null,
            "status": "deleted",
            "firstWarningAt": null,
            "finalWarningAt": null,
            "deleteAttempts": 0,
            "lastError": null,
            "completedAt": null,
            "createdAt": "2026-11-01T00:00:00.000Z",
            "updatedAt": "2026-11-01T00:00:00.000Z"
          }
        ]
      }
      "
    `);
  });

  it("says when there are none", async () => {
    serveRoutes(out, { "GET /leases": { leases: [] } });
    expect(await run("leases")).toBe(0);
    expect(out.stdout).toMatchInlineSnapshot(`
      "No resource leases. Set one from a resource's Lease tab (web or desktop) to put an expiry on it, optionally auto-deleting it when the lease runs out.
      "
    `);
  });

  it("refuses a stray positional", async () => {
    expect(await run("leases", "extra")).toBe(2);
    expect(out.stdout).toBe("");
  });
});

const record = (over: Record<string, unknown>) => ({
  id: "o1",
  resourceId: "acc1:droplet:1",
  accountId: "acc1",
  pluginId: "digitalocean",
  resourceTypeId: "droplet",
  resourceName: "api-1",
  ownerUserId: "u1",
  ownerName: "Ada Lovelace",
  ownerEmail: "ada@example.com",
  ownerLabel: null,
  purpose: "public API",
  ticketUrl: "https://linear.app/acme/issue/OPS-1",
  createdAt: "2026-10-01T00:00:00.000Z",
  updatedAt: "2026-10-01T00:00:00.000Z",
  ...over,
});

const OWNERSHIP = {
  ownership: [
    record({}),
    record({
      id: "o2",
      resourceId: "acc1:droplet:2",
      resourceName: "batch-runner",
      ownerUserId: null,
      ownerName: null,
      ownerEmail: null,
      ownerLabel: "data team",
      purpose: null,
      ticketUrl: null,
    }),
    record({
      id: "o3",
      resourceId: "acc1:volume:3",
      resourceName: "scratch",
      ownerUserId: null,
      ownerName: null,
      ownerEmail: null,
      purpose: "temporary",
    }),
  ],
};

describe("ownership", () => {
  it("prints every record", async () => {
    serveRoutes(out, { "GET /ownership": OWNERSHIP });
    expect(await run("ownership")).toBe(0);
    expect(out.stdout).toMatchInlineSnapshot(`
      "Acme · 3 resources with ownership recorded

      RESOURCE      OWNER             PURPOSE     TICKET                             
      api-1         Ada Lovelace      public API  https://linear.app/acme/issue/OPS-1
      batch-runner  data team (team)  —           —                                  
      scratch       unowned           temporary   https://linear.app/acme/issue/OPS-1

      Only resources with something recorded appear here. Everything else is unowned. Run \`infrawrench orphans\` to see the unowned resources that also look wasted.
      "
    `);
  });

  it("filters by a query, in text and in --json", async () => {
    serveRoutes(out, { "GET /ownership": OWNERSHIP });
    expect(await run("ownership", "DATA")).toBe(0);
    expect(out.stdout).toMatchInlineSnapshot(`
      "Acme · 1 resource with ownership recorded

      RESOURCE      OWNER             PURPOSE  TICKET
      batch-runner  data team (team)  —        —     

      Only resources with something recorded appear here. Everything else is unowned. Run \`infrawrench orphans\` to see the unowned resources that also look wasted.
      "
    `);
    expect(out.stdout).toContain("batch-runner");
    expect(out.stdout).not.toContain("api-1");
    out.stdout = "";
    expect(await run("ownership", "ada", "--json")).toBe(0);
    expect(JSON.parse(out.stdout)).toEqual({ org: "org_1", ownership: [OWNERSHIP.ownership[0]] });
    expect(out.stdout).toMatchInlineSnapshot(`
      "{
        "org": "org_1",
        "ownership": [
          {
            "id": "o1",
            "resourceId": "acc1:droplet:1",
            "accountId": "acc1",
            "pluginId": "digitalocean",
            "resourceTypeId": "droplet",
            "resourceName": "api-1",
            "ownerUserId": "u1",
            "ownerName": "Ada Lovelace",
            "ownerEmail": "ada@example.com",
            "ownerLabel": null,
            "purpose": "public API",
            "ticketUrl": "https://linear.app/acme/issue/OPS-1",
            "createdAt": "2026-10-01T00:00:00.000Z",
            "updatedAt": "2026-10-01T00:00:00.000Z"
          }
        ]
      }
      "
    `);
  });

  it("says when nothing matches", async () => {
    serveRoutes(out, { "GET /ownership": OWNERSHIP });
    expect(await run("ownership", "nope")).toBe(0);
    expect(out.stdout).toBe('Nothing recorded matches "nope".\n');
  });

  it("refuses --local", async () => {
    serveRoutes(out, {});
    expect(await run("ownership", "--local")).toBe(1);
    expect(out.stderr).toBe(
      "Ownership lives in Infrawrench Cloud. It names an org member. Drop --local.\n",
    );
    expect(out.requests).toEqual([]);
  });

  it("refuses a second positional", async () => {
    expect(await run("ownership", "a", "b")).toBe(2);
    expect(out.stdout).toBe("");
  });
});

const node = (displayName: string) => ({
  id: `acc1:x:${displayName}`,
  displayName,
  pluginId: "aws",
  pluginDisplayName: "AWS",
  pluginLogoSvg: "",
  resourceTypeId: "ec2-instance",
  resourceTypeLabel: "EC2 instance",
  accountId: "acc1",
  accountName: "prod",
});

const REPORT = {
  resourceId: "acc1:rds:db",
  resource: node("orders-db"),
  dependants: [
    { node: node("orders-api"), depth: 1, via: { fieldKey: "dbHost", outputKey: "endpoint" } },
    { node: node("orders-worker"), depth: 2 },
  ],
  directCount: 1,
  transitiveCount: 1,
  references: [
    { kind: "probe", id: "p1", name: "orders health", detail: "every 60s", userFacing: true },
    { kind: "dashboard", id: "d1", name: "Orders" },
  ],
  flowPeers: [
    {
      ref: "i-1",
      label: "orders-api",
      direction: "ingress",
      scope: "cross-zone",
      bytes: 12_345_678,
      estimatedCost: 1.2,
      currency: "USD",
      days: 7,
      resourceId: null,
    },
    {
      ref: "internet",
      label: "internet",
      direction: "egress",
      scope: "internet",
      bytes: 900,
      estimatedCost: 0,
      currency: "USD",
      days: 1,
      resourceId: null,
    },
  ],
  flowTotals: { bytes: 12_346_578, estimatedCost: 1.2, currency: "USD" },
  unchecked: [{ kind: "workflow-source", reason: "Workflows were not read." }],
  severity: "high",
  headline: "Deleting orders-db breaks 2 resources and a public status page.",
};

const BLAST_PATH = "GET /blast-radius?resourceId=acc1%3Ards%3Adb";

describe("blast-radius", () => {
  it("prints the report", async () => {
    serveRoutes(out, { [BLAST_PATH]: REPORT });
    expect(await run("blast-radius", "acc1:rds:db")).toBe(0);
    expect(out.stdout).toMatchInlineSnapshot(`
      "orders-db
      Deleting orders-db breaks 2 resources and a public status page.

      Depended on by
        orders-api  EC2 instance · prod  direct
        orders-worker  EC2 instance · prod  2 hops

      Points at it
        [probe] orders health, every 60s  customer-visible
        [dashboard] Orders

      Talks to
        ← orders-api  cross-zone · 12.3 MB
        → internet  internet · 900 B

      Not checked
        Workflows were not read.
      "
    `);
  });

  it("prints an empty report's checked line", async () => {
    const empty = {
      ...REPORT,
      resource: null,
      dependants: [],
      references: [],
      flowPeers: [],
      unchecked: [],
    };
    serveRoutes(out, { [BLAST_PATH]: empty });
    expect(await run("blast-radius", "acc1:rds:db")).toBe(0);
    expect(out.stdout).toMatchInlineSnapshot(`
      "acc1:rds:db
      Deleting orders-db breaks 2 resources and a public status page.

      Everything this report can look at was checked.
      "
    `);
  });

  it("prints the raw body under --json", async () => {
    serveRoutes(out, { [BLAST_PATH]: REPORT });
    expect(await run("blast-radius", "acc1:rds:db", "--json")).toBe(0);
    expect(JSON.parse(out.stdout)).toEqual({ org: "org_1", ...REPORT });
    expect(out.stdout).toMatchInlineSnapshot(`
      "{
        "org": "org_1",
        "resourceId": "acc1:rds:db",
        "resource": {
          "id": "acc1:x:orders-db",
          "displayName": "orders-db",
          "pluginId": "aws",
          "pluginDisplayName": "AWS",
          "pluginLogoSvg": "",
          "resourceTypeId": "ec2-instance",
          "resourceTypeLabel": "EC2 instance",
          "accountId": "acc1",
          "accountName": "prod"
        },
        "dependants": [
          {
            "node": {
              "id": "acc1:x:orders-api",
              "displayName": "orders-api",
              "pluginId": "aws",
              "pluginDisplayName": "AWS",
              "pluginLogoSvg": "",
              "resourceTypeId": "ec2-instance",
              "resourceTypeLabel": "EC2 instance",
              "accountId": "acc1",
              "accountName": "prod"
            },
            "depth": 1,
            "via": {
              "fieldKey": "dbHost",
              "outputKey": "endpoint"
            }
          },
          {
            "node": {
              "id": "acc1:x:orders-worker",
              "displayName": "orders-worker",
              "pluginId": "aws",
              "pluginDisplayName": "AWS",
              "pluginLogoSvg": "",
              "resourceTypeId": "ec2-instance",
              "resourceTypeLabel": "EC2 instance",
              "accountId": "acc1",
              "accountName": "prod"
            },
            "depth": 2
          }
        ],
        "directCount": 1,
        "transitiveCount": 1,
        "references": [
          {
            "kind": "probe",
            "id": "p1",
            "name": "orders health",
            "detail": "every 60s",
            "userFacing": true
          },
          {
            "kind": "dashboard",
            "id": "d1",
            "name": "Orders"
          }
        ],
        "flowPeers": [
          {
            "ref": "i-1",
            "label": "orders-api",
            "direction": "ingress",
            "scope": "cross-zone",
            "bytes": 12345678,
            "estimatedCost": 1.2,
            "currency": "USD",
            "days": 7,
            "resourceId": null
          },
          {
            "ref": "internet",
            "label": "internet",
            "direction": "egress",
            "scope": "internet",
            "bytes": 900,
            "estimatedCost": 0,
            "currency": "USD",
            "days": 1,
            "resourceId": null
          }
        ],
        "flowTotals": {
          "bytes": 12346578,
          "estimatedCost": 1.2,
          "currency": "USD"
        },
        "unchecked": [
          {
            "kind": "workflow-source",
            "reason": "Workflows were not read."
          }
        ],
        "severity": "high",
        "headline": "Deleting orders-db breaks 2 resources and a public status page."
      }
      "
    `);
  });

  it("refuses --local before asking for the id", async () => {
    expect(await run("blast-radius", "--local")).toBe(1);
    expect(out.stderr).toBe(
      "The impact report is assembled by Infrawrench Cloud. It reads the org's dashboards, probes, leases and flow data, none of which a local workspace has.\n",
    );
  });

  it("asks for the id with the usage line, exit 1", async () => {
    serveRoutes(out, {});
    expect(await run("blast-radius")).toBe(1);
    expect(out.stderr).toBe(
      "Usage: infrawrench blast-radius <resource-id>  (see `infrawrench ls`)\n",
    );
    expect(out.requests).toEqual([]);
  });

  it("refuses a second positional", async () => {
    expect(await run("blast-radius", "a", "b")).toBe(2);
    expect(out.stdout).toBe("");
  });
});

const size = (id: string, label: string) => ({
  id,
  label,
  vcpus: 2,
  memoryMb: 4096,
  priceMonthly: 24,
});

const oversizedRow = (over: Record<string, unknown>) => ({
  id: "acc1:droplet:1",
  pluginId: "digitalocean",
  resourceTypeId: "droplet",
  resourceTypeName: "Droplet",
  displayName: "web-1",
  externalId: "1",
  sizeFieldKey: "size",
  region: "nyc3",
  currentSize: size("s-4vcpu-8gb", "4 vCPU / 8 GB"),
  recommendedSize: size("s-2vcpu-4gb", "2 vCPU / 4 GB"),
  cpuP95: 12.5,
  memoryP95: 30,
  memoryMeasured: true,
  projectedCpuP95: 25,
  currency: "USD",
  monthlySaving: 24,
  currentMonthlyKgCo2e: 10,
  monthlyKgCo2eSaving: 4.2,
  resizeNote: null,
  lastSyncedAt: "2026-11-08T00:00:00.000Z",
  ...over,
});

const RIGHTSIZING = {
  accounts: [
    {
      accountId: "acc1",
      accountName: "do-prod",
      pluginId: "digitalocean",
      pluginName: "DigitalOcean",
      resources: [
        oversizedRow({
          remediation: {
            commands: [
              {
                tool: "doctl",
                command: "doctl compute droplet-action resize 1 --size s-2vcpu-4gb",
                description: "Resize the droplet",
                destructive: false,
              },
            ],
            placeholders: [{ name: "DO_TOKEN", description: "A DigitalOcean token" }],
            iac: null,
          },
        }),
        oversizedRow({
          id: "acc1:droplet:2",
          displayName: "web-2",
          memoryP95: null,
          memoryMeasured: false,
          monthlySaving: null,
          monthlyKgCo2eSaving: null,
        }),
      ],
    },
  ],
  totalCount: 2,
  windowDays: 14,
  generatedAt: "2026-11-08T00:00:00.000Z",
};

describe("oversized", () => {
  it("prints the groups and remediation", async () => {
    serveRoutes(out, { "GET /rightsizing": RIGHTSIZING });
    expect(await run("oversized")).toBe(0);
    expect(out.stdout).toMatchInlineSnapshot(`
      "Acme · 2 oversized resources · last 14d

      do-prod · DigitalOcean
      RESOURCE  TYPE     SIZE                           P95 CPU  P95 MEM  SAVING/MO  CO2E/MO
      web-1     Droplet  4 vCPU / 8 GB → 2 vCPU / 4 GB    12.5%      30%     $24.00  ~4.2 kg
      web-2     Droplet  4 vCPU / 8 GB → 2 vCPU / 4 GB    12.5%      n/a          —      n/a

      Remediation

        web-1
          # Resize the droplet
          doctl compute droplet-action resize 1 --size s-2vcpu-4gb

      Set these first:
        export DO_TOKEN=...   # A DigitalOcean token

      Savings are quoted from each provider's live size catalog; CO2e is estimated from published grid figures (see \`infrawrench carbon\`). Apply a resize from the web or desktop Costs panel, or run the commands above yourself. The Apply button goes through the normal resource update (change freezes and audit logging apply), and most providers require the machine to be stopped first.
      "
    `);
    expect(out.stdout).toContain("Remediation");
  });

  it("prints the raw body under --json", async () => {
    serveRoutes(out, { "GET /rightsizing": RIGHTSIZING });
    expect(await run("oversized", "--json")).toBe(0);
    expect(JSON.parse(out.stdout)).toEqual({ org: "org_1", ...RIGHTSIZING });
    expect(out.stdout).toMatchInlineSnapshot(`
      "{
        "org": "org_1",
        "accounts": [
          {
            "accountId": "acc1",
            "accountName": "do-prod",
            "pluginId": "digitalocean",
            "pluginName": "DigitalOcean",
            "resources": [
              {
                "id": "acc1:droplet:1",
                "pluginId": "digitalocean",
                "resourceTypeId": "droplet",
                "resourceTypeName": "Droplet",
                "displayName": "web-1",
                "externalId": "1",
                "sizeFieldKey": "size",
                "region": "nyc3",
                "currentSize": {
                  "id": "s-4vcpu-8gb",
                  "label": "4 vCPU / 8 GB",
                  "vcpus": 2,
                  "memoryMb": 4096,
                  "priceMonthly": 24
                },
                "recommendedSize": {
                  "id": "s-2vcpu-4gb",
                  "label": "2 vCPU / 4 GB",
                  "vcpus": 2,
                  "memoryMb": 4096,
                  "priceMonthly": 24
                },
                "cpuP95": 12.5,
                "memoryP95": 30,
                "memoryMeasured": true,
                "projectedCpuP95": 25,
                "currency": "USD",
                "monthlySaving": 24,
                "currentMonthlyKgCo2e": 10,
                "monthlyKgCo2eSaving": 4.2,
                "resizeNote": null,
                "lastSyncedAt": "2026-11-08T00:00:00.000Z",
                "remediation": {
                  "commands": [
                    {
                      "tool": "doctl",
                      "command": "doctl compute droplet-action resize 1 --size s-2vcpu-4gb",
                      "description": "Resize the droplet",
                      "destructive": false
                    }
                  ],
                  "placeholders": [
                    {
                      "name": "DO_TOKEN",
                      "description": "A DigitalOcean token"
                    }
                  ],
                  "iac": null
                }
              },
              {
                "id": "acc1:droplet:2",
                "pluginId": "digitalocean",
                "resourceTypeId": "droplet",
                "resourceTypeName": "Droplet",
                "displayName": "web-2",
                "externalId": "1",
                "sizeFieldKey": "size",
                "region": "nyc3",
                "currentSize": {
                  "id": "s-4vcpu-8gb",
                  "label": "4 vCPU / 8 GB",
                  "vcpus": 2,
                  "memoryMb": 4096,
                  "priceMonthly": 24
                },
                "recommendedSize": {
                  "id": "s-2vcpu-4gb",
                  "label": "2 vCPU / 4 GB",
                  "vcpus": 2,
                  "memoryMb": 4096,
                  "priceMonthly": 24
                },
                "cpuP95": 12.5,
                "memoryP95": null,
                "memoryMeasured": false,
                "projectedCpuP95": 25,
                "currency": "USD",
                "monthlySaving": null,
                "currentMonthlyKgCo2e": 10,
                "monthlyKgCo2eSaving": null,
                "resizeNote": null,
                "lastSyncedAt": "2026-11-08T00:00:00.000Z"
              }
            ]
          }
        ],
        "totalCount": 2,
        "windowDays": 14,
        "generatedAt": "2026-11-08T00:00:00.000Z"
      }
      "
    `);
  });

  it("says when nothing looks oversized", async () => {
    serveRoutes(out, { "GET /rightsizing": { ...RIGHTSIZING, accounts: [], totalCount: 0 } });
    expect(await run("oversized")).toBe(0);
    expect(out.stdout).toMatchInlineSnapshot(`
      "Nothing looks oversized. A machine is flagged when two weeks of stored metrics put its p95 CPU (and memory, where measured) well under its size. Metrics are stored for resources pinned to a dashboard.
      "
    `);
  });
});

const link = (over: Record<string, unknown>) => ({
  id: "g1",
  sourceKind: "orphan_resource",
  sourceId: "acc1:volume:1",
  fingerprint: "f1",
  repo: "acme/infra",
  installationId: 7,
  issueNumber: 12,
  issueUrl: "https://github.com/acme/infra/issues/12",
  state: "open",
  autoFiled: false,
  pullRequestNumber: null,
  pullRequestUrl: null,
  createdByUserId: "u1",
  createdAt: "2026-11-01T09:00:00.000Z",
  resolvedAt: null,
  status: "open",
  assignee: "octocat",
  ...over,
});

const LINKS = [
  link({ id: "g2", issueNumber: 9, state: "closed", createdAt: "2026-11-05T00:00:00.000Z" }),
  link({}),
  link({
    id: "g3",
    issueNumber: 15,
    sourceKind: "oversized_resource",
    autoFiled: true,
    pullRequestNumber: 16,
    status: null,
    assignee: null,
    createdAt: "2026-11-03T00:00:00.000Z",
  }),
];

const GITHUB_STATUS = {
  appConfigured: false,
  installations: [
    {
      installationId: 7,
      accountLogin: "acme",
      issues: "read",
      pullRequests: "write",
      contents: "admin",
      suspended: false,
      manageUrl: "https://github.com/organizations/acme/settings/installations/7",
      checked: true,
    },
    {
      installationId: 8,
      accountLogin: null,
      issues: "none",
      pullRequests: "none",
      contents: "none",
      suspended: false,
      manageUrl: null,
      checked: false,
    },
  ],
  settings: {
    enabled: true,
    defaultRepo: { installationId: 7, fullName: "acme/infra" },
    labels: ["infrawrench", "cost"],
    assignees: [],
    routes: [
      {
        id: "r1",
        match: { kind: "tag", tagKey: "team", tagValue: "data" },
        repo: { installationId: 7, fullName: "acme/data" },
        labels: [],
        assignees: [],
      },
      {
        id: "r2",
        match: { kind: "cost_centre", costCentreId: "cc_9" },
        repo: { installationId: 7, fullName: "acme/finance" },
        labels: [],
        assignees: [],
      },
    ],
    resolveAction: "close",
    pullRequestsEnabled: false,
    iacSources: [
      {
        id: "s1",
        iacAccountId: null,
        repo: { installationId: 7, fullName: "acme/terraform" },
        baseBranch: null,
        directory: "",
      },
    ],
    updatedAt: null,
  },
};

describe("github-issues", () => {
  it("lists filed issues, open first", async () => {
    serveRoutes(out, { "GET /github-issues/links": LINKS });
    expect(await run("github-issues")).toBe(0);
    expect(out.stdout).toMatchInlineSnapshot(`
      "Acme · 2 open · 3 filed

      ISSUE          STATE   STATUS  ASSIGNEE  FINDING             BY      PR   FILED     
      acme/infra#15  open    -       -         oversized resource  rule    #16  2026-11-03
      acme/infra#12  open    open    octocat   orphan resource     person  —    2026-11-01
      acme/infra#9   closed  open    octocat   orphan resource     person  —    2026-11-05
      "
    `);
  });

  it("prints the raw links under --json", async () => {
    serveRoutes(out, { "GET /github-issues/links": LINKS });
    expect(await run("github-issues", "--json")).toBe(0);
    expect(JSON.parse(out.stdout)).toEqual({ org: "org_1", links: LINKS });
    expect(out.stdout).toMatchInlineSnapshot(`
      "{
        "org": "org_1",
        "links": [
          {
            "id": "g2",
            "sourceKind": "orphan_resource",
            "sourceId": "acc1:volume:1",
            "fingerprint": "f1",
            "repo": "acme/infra",
            "installationId": 7,
            "issueNumber": 9,
            "issueUrl": "https://github.com/acme/infra/issues/12",
            "state": "closed",
            "autoFiled": false,
            "pullRequestNumber": null,
            "pullRequestUrl": null,
            "createdByUserId": "u1",
            "createdAt": "2026-11-05T00:00:00.000Z",
            "resolvedAt": null,
            "status": "open",
            "assignee": "octocat"
          },
          {
            "id": "g1",
            "sourceKind": "orphan_resource",
            "sourceId": "acc1:volume:1",
            "fingerprint": "f1",
            "repo": "acme/infra",
            "installationId": 7,
            "issueNumber": 12,
            "issueUrl": "https://github.com/acme/infra/issues/12",
            "state": "open",
            "autoFiled": false,
            "pullRequestNumber": null,
            "pullRequestUrl": null,
            "createdByUserId": "u1",
            "createdAt": "2026-11-01T09:00:00.000Z",
            "resolvedAt": null,
            "status": "open",
            "assignee": "octocat"
          },
          {
            "id": "g3",
            "sourceKind": "oversized_resource",
            "sourceId": "acc1:volume:1",
            "fingerprint": "f1",
            "repo": "acme/infra",
            "installationId": 7,
            "issueNumber": 15,
            "issueUrl": "https://github.com/acme/infra/issues/12",
            "state": "open",
            "autoFiled": true,
            "pullRequestNumber": 16,
            "pullRequestUrl": null,
            "createdByUserId": "u1",
            "createdAt": "2026-11-03T00:00:00.000Z",
            "resolvedAt": null,
            "status": null,
            "assignee": null
          }
        ]
      }
      "
    `);
  });

  it("prints the settings", async () => {
    serveRoutes(out, { "GET /github-issues": GITHUB_STATUS });
    expect(await run("github-issues", "settings")).toBe(0);
    expect(out.stdout).toMatchInlineSnapshot(`
      "Acme · filing on · pull requests off
      This server has no GitHub App configured.
      default repository  acme/infra
      labels              infrawrench, cost
      assignees           none
      when resolved       close

      routes (first match wins)
        tag team=data → acme/data
        cost centre cc_9 → acme/finance

      terraform sources
        org-wide state → acme/terraform/. @ default branch

      installations
        acme  issues read  contents admin  pull requests write
          approve the app's updated permissions: https://github.com/organizations/acme/settings/installations/7
        8  issues none  contents none  pull requests none  (could not ask GitHub)
      "
    `);
  });

  it("prints the settings body under --json", async () => {
    serveRoutes(out, { "GET /github-issues": GITHUB_STATUS });
    expect(await run("github-issues", "settings", "--json")).toBe(0);
    expect(JSON.parse(out.stdout)).toEqual({ org: "org_1", ...GITHUB_STATUS });
    expect(out.stdout).toMatchInlineSnapshot(`
      "{
        "org": "org_1",
        "appConfigured": false,
        "installations": [
          {
            "installationId": 7,
            "accountLogin": "acme",
            "issues": "read",
            "pullRequests": "write",
            "contents": "admin",
            "suspended": false,
            "manageUrl": "https://github.com/organizations/acme/settings/installations/7",
            "checked": true
          },
          {
            "installationId": 8,
            "accountLogin": null,
            "issues": "none",
            "pullRequests": "none",
            "contents": "none",
            "suspended": false,
            "manageUrl": null,
            "checked": false
          }
        ],
        "settings": {
          "enabled": true,
          "defaultRepo": {
            "installationId": 7,
            "fullName": "acme/infra"
          },
          "labels": [
            "infrawrench",
            "cost"
          ],
          "assignees": [],
          "routes": [
            {
              "id": "r1",
              "match": {
                "kind": "tag",
                "tagKey": "team",
                "tagValue": "data"
              },
              "repo": {
                "installationId": 7,
                "fullName": "acme/data"
              },
              "labels": [],
              "assignees": []
            },
            {
              "id": "r2",
              "match": {
                "kind": "cost_centre",
                "costCentreId": "cc_9"
              },
              "repo": {
                "installationId": 7,
                "fullName": "acme/finance"
              },
              "labels": [],
              "assignees": []
            }
          ],
          "resolveAction": "close",
          "pullRequestsEnabled": false,
          "iacSources": [
            {
              "id": "s1",
              "iacAccountId": null,
              "repo": {
                "installationId": 7,
                "fullName": "acme/terraform"
              },
              "baseBranch": null,
              "directory": ""
            }
          ],
          "updatedAt": null
        }
      }
      "
    `);
  });

  it("refuses an unknown verb", async () => {
    expect(await run("github-issues", "frobnicate")).toBe(2);
    expect(out.stdout).toBe("");
  });
});

const IDLE = {
  settings: { enabled: true, lookbackDays: 14, rules: {} },
  rules: [
    {
      ruleKey: "aws:idle-nat",
      pluginId: "aws",
      pluginName: "AWS",
      ruleId: "idle-nat",
      label: "Idle NAT gateway",
      description: "No traffic",
      action: "delete",
      resourceTypeNames: ["NAT gateway"],
      enabled: true,
      thresholds: [
        {
          key: "bytes",
          label: "Bytes out",
          description: null,
          unit: "bytes",
          default: 1_000_000,
          min: 0,
          max: 1e12,
          value: 5_000_000,
        },
      ],
    },
    {
      ruleKey: "aws:empty-cluster",
      pluginId: "aws",
      pluginName: "AWS",
      ruleId: "empty-cluster",
      label: "Empty cluster",
      description: "No tasks",
      action: "delete",
      resourceTypeNames: [],
      enabled: false,
      thresholds: [],
    },
  ],
  accounts: [
    {
      accountId: "acc1",
      accountName: "prod",
      pluginId: "aws",
      pluginName: "AWS",
      lastPolledAt: "2026-11-08T06:30:00.000Z",
      nextPollAt: null,
      lastError: null,
      helpLabel: null,
      helpUrl: null,
      findingCount: 3,
    },
    {
      accountId: "acc2",
      accountName: "staging",
      pluginId: "aws",
      pluginName: "AWS",
      lastPolledAt: null,
      nextPollAt: null,
      lastError: "AccessDenied: cloudwatch:GetMetricData",
      helpLabel: "Permissions",
      helpUrl: "https://docs.example.com/aws",
      findingCount: 0,
    },
  ],
};

describe("idle-rules", () => {
  it("prints the rules and collection", async () => {
    serveRoutes(out, { "GET /idle-findings": IDLE });
    expect(await run("idle-rules")).toBe(0);
    expect(out.stdout).toMatchInlineSnapshot(`
      "Acme · idle rules on · 14-day lookback
      RULE              PROVIDER  ON   THRESHOLDS                       
      Idle NAT gateway  AWS       yes  Bytes out 5.0 MB (default 1.0 MB)
      Empty cluster     AWS       no   none                             

      Collection
      ACCOUNT  PROVIDER  LAST READ         FLAGGED  ERROR                                                                
      prod     AWS       2026-11-08 06:30        3  none                                                                 
      staging  AWS       not yet                 0  AccessDenied: cloudwatch:GetMetricData (https://docs.example.com/aws)

      Findings appear in \`infrawrench orphans\`. \`infrawrench idle-rules rescan\` re-reads now.
      "
    `);
  });

  it("prints the raw body under --json", async () => {
    serveRoutes(out, { "GET /idle-findings": IDLE });
    expect(await run("idle-rules", "--json")).toBe(0);
    expect(JSON.parse(out.stdout)).toEqual({ org: "org_1", ...IDLE });
    expect(out.stdout).toMatchInlineSnapshot(`
      "{
        "org": "org_1",
        "settings": {
          "enabled": true,
          "lookbackDays": 14,
          "rules": {}
        },
        "rules": [
          {
            "ruleKey": "aws:idle-nat",
            "pluginId": "aws",
            "pluginName": "AWS",
            "ruleId": "idle-nat",
            "label": "Idle NAT gateway",
            "description": "No traffic",
            "action": "delete",
            "resourceTypeNames": [
              "NAT gateway"
            ],
            "enabled": true,
            "thresholds": [
              {
                "key": "bytes",
                "label": "Bytes out",
                "description": null,
                "unit": "bytes",
                "default": 1000000,
                "min": 0,
                "max": 1000000000000,
                "value": 5000000
              }
            ]
          },
          {
            "ruleKey": "aws:empty-cluster",
            "pluginId": "aws",
            "pluginName": "AWS",
            "ruleId": "empty-cluster",
            "label": "Empty cluster",
            "description": "No tasks",
            "action": "delete",
            "resourceTypeNames": [],
            "enabled": false,
            "thresholds": []
          }
        ],
        "accounts": [
          {
            "accountId": "acc1",
            "accountName": "prod",
            "pluginId": "aws",
            "pluginName": "AWS",
            "lastPolledAt": "2026-11-08T06:30:00.000Z",
            "nextPollAt": null,
            "lastError": null,
            "helpLabel": null,
            "helpUrl": null,
            "findingCount": 3
          },
          {
            "accountId": "acc2",
            "accountName": "staging",
            "pluginId": "aws",
            "pluginName": "AWS",
            "lastPolledAt": null,
            "nextPollAt": null,
            "lastError": "AccessDenied: cloudwatch:GetMetricData",
            "helpLabel": "Permissions",
            "helpUrl": "https://docs.example.com/aws",
            "findingCount": 0
          }
        ]
      }
      "
    `);
  });

  it("asks for a rescan, in text and in --json", async () => {
    serveRoutes(out, { "POST /idle-findings/rescan": { ok: true } });
    expect(await run("idle-rules", "rescan")).toBe(0);
    expect(out.stdout).toMatchInlineSnapshot(`
      "Every account is due for an idle collection on the next poller tick.
      "
    `);
    expect(out.requests).toEqual(["POST /idle-findings/rescan"]);
    out.stdout = "";
    expect(await run("idle-rules", "rescan", "--json")).toBe(0);
    expect(out.stdout).toMatchInlineSnapshot(`
      "{
        "org": "org_1",
        "ok": true
      }
      "
    `);
  });

  it("refuses an unknown verb", async () => {
    expect(await run("idle-rules", "frobnicate")).toBe(2);
    expect(out.stdout).toBe("");
  });
});
