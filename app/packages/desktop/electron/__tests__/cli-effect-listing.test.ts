import { describe, expect, it, vi } from "vitest";

// `accounts`, `resources` and `resource` on effect/cli, over fixtures for the
// cloud routes, the local accounts table and the live plugin listing.
vi.mock("electron", () => ({
  app: { getPath: () => "/tmp", getVersion: () => "9.9.9" },
  shell: { openExternal: vi.fn() },
  ipcMain: { handle: () => {} },
  safeStorage: { isEncryptionAvailable: () => false },
}));

const tokens = vi.hoisted(() => ({
  getAuthStatus: vi.fn(async () => ({ authenticated: true, email: "ada@example.com" })),
}));

vi.mock("../cloud-tokens", () => ({
  ...tokens,
  getAccessToken: vi.fn(async () => "tok"),
  forceRefreshAccessToken: vi.fn(async () => null),
  fetchCloudOrgs: vi.fn(async () => [{ id: "org_1", displayName: "Acme", role: "admin" }]),
  clearStoredTokens: vi.fn(),
  createPkceChallenge: vi.fn(),
  buildAuthorizeUrl: vi.fn(),
  exchangeAuthorizationCode: vi.fn(),
  setTokenStoreReadOnly: vi.fn(),
}));

const local = vi.hoisted(() => ({
  accounts: [{ id: "loc_1", plugin_id: "digitalocean", display_name: "home lab" }],
  listAccountResourcesLive: vi.fn(),
  resolveResourceOutputs: vi.fn(),
}));

vi.mock("../main-utils", async (original) => ({
  ...(await original<typeof import("../main-utils")>()),
  getDb: async () => ({ select: async () => local.accounts }),
}));

vi.mock("../plugin-runtime", () => ({
  listAccountResourcesLive: local.listAccountResourcesLive,
  resolveResourceOutputs: local.resolveResourceOutputs,
  fetchLocalMetricSeries: vi.fn(),
}));

import { RawResponse, run, serveRoutes, useCliCapture } from "./cli-harness";

const out = useCliCapture();

const CLOUD_ACCOUNTS = [
  { id: "acc_2", pluginId: "aws", displayName: "prod", createdAt: "2026-01-01T00:00:00Z" },
  { id: "acc_1", pluginId: "cloudflare", displayName: "edge", createdAt: "2026-01-01T00:00:00Z" },
];

const cloudRow = (id: string, typeId: string, name: string) => ({
  id,
  pluginId: "aws",
  resourceTypeId: typeId,
  accountId: "acc_2",
  displayName: name,
  externalId: id.split(":")[2],
  fieldsJson: { size: "t3.small", tags: { env: "prod" } },
  outputsJson: { ip: "10.0.0.1" },
  parentResourceId: null,
});

const CLOUD_RESOURCES = [
  cloudRow("acc_2:ec2-instance:i-2", "ec2-instance", "web-2"),
  cloudRow("acc_2:s3-bucket:assets", "s3-bucket", "assets"),
  cloudRow("acc_2:ec2-instance:i-1", "ec2-instance", "web-1"),
];

const cloudRoutes = {
  "GET /accounts": CLOUD_ACCOUNTS,
  "POST /accounts/acc_2/sync": { synced: 3 },
  "GET /accounts/acc_2/resources": CLOUD_RESOURCES,
};

describe("accounts", () => {
  it("lists local then every org", async () => {
    serveRoutes(out, cloudRoutes);
    expect(await run("accounts")).toBe(0);
    expect(out.stdout).toMatchInlineSnapshot(`
      "Local
      ID     PLUGIN        NAME    
      loc_1  digitalocean  home lab

      Acme
      ID     PLUGIN      NAME
      acc_1  cloudflare  edge
      acc_2  aws         prod
      "
    `);
    expect(out.stdout).toContain("home lab");
    expect(out.stdout).toContain("prod");
  });

  it("prints the scopes as JSON", async () => {
    serveRoutes(out, cloudRoutes);
    expect(await run("accounts", "--json")).toBe(0);
    expect(JSON.parse(out.stdout)).toEqual([
      {
        scope: "local",
        orgId: null,
        accounts: [{ id: "loc_1", pluginId: "digitalocean", displayName: "home lab" }],
      },
      {
        scope: "Acme",
        orgId: "org_1",
        accounts: [
          { id: "acc_1", pluginId: "cloudflare", displayName: "edge" },
          { id: "acc_2", pluginId: "aws", displayName: "prod" },
        ],
      },
    ]);
  });

  it("lists only the local workspace with --local", async () => {
    serveRoutes(out, {});
    expect(await run("accounts", "--local")).toBe(0);
    expect(out.requests).toEqual([]);
    expect(out.stdout).toMatchInlineSnapshot(`
      "Local
      ID     PLUGIN        NAME    
      loc_1  digitalocean  home lab
      "
    `);
  });
});

describe("resources", () => {
  it("syncs, then lists a cloud account", async () => {
    serveRoutes(out, cloudRoutes);
    expect(await run("resources", "-a", "prod")).toBe(0);
    expect(out.requests).toContain("POST /accounts/acc_2/sync");
    expect(out.stdout).toMatchInlineSnapshot(`
      "prod (aws)
      TYPE          NAME    EXTERNAL ID
      ec2-instance  web-1   i-1        
      ec2-instance  web-2   i-2        
      s3-bucket     assets  assets     
      "
    `);
  });

  it("filters by --type and prints JSON", async () => {
    serveRoutes(out, cloudRoutes);
    expect(await run("resources", "--account", "prod", "--type", "s3-bucket", "--json")).toBe(0);
    expect(out.stdout).toMatchInlineSnapshot(`
      "[
        {
          "id": "acc_2:s3-bucket:assets",
          "pluginId": "aws",
          "resourceTypeId": "s3-bucket",
          "accountId": "acc_2",
          "displayName": "assets",
          "externalId": "assets",
          "fields": {
            "size": "t3.small",
            "tags": {
              "env": "prod"
            }
          },
          "outputs": {
            "ip": "10.0.0.1"
          },
          "parentResourceId": null
        }
      ]
      "
    `);
    expect(JSON.parse(out.stdout)).toHaveLength(1);
  });

  it("lists the cached rows when the sync fails", async () => {
    serveRoutes(out, {
      ...cloudRoutes,
      "POST /accounts/acc_2/sync": new RawResponse(502, "provider down"),
    });
    expect(await run("resources", "-a", "prod")).toBe(0);
    expect(out.stderr).toBe(
      "sync failed, showing cached: Cloud request failed: 502 /accounts/acc_2/sync provider down\n",
    );
    expect(out.stdout).toContain("web-1");
  });

  it("lists a local account live and reports refused types on stderr", async () => {
    local.listAccountResourcesLive.mockResolvedValue({
      resources: [
        {
          id: "loc_1:droplet:42",
          pluginId: "digitalocean",
          resourceTypeId: "droplet",
          accountId: "loc_1",
          displayName: "nas",
          externalId: "42",
          fields: {},
          resolvedOutputs: {},
          parentResourceId: null,
        },
      ],
      errors: [{ typeId: "volume", message: "403 Forbidden" }],
    });
    serveRoutes(out, {});
    expect(await run("resources", "--local", "-a", "home")).toBe(0);
    expect(out.stdout).toMatchInlineSnapshot(`
      "home lab (digitalocean)
      TYPE     NAME  EXTERNAL ID
      droplet  nas   42         
      "
    `);
    expect(out.stderr).toBe("volume: 403 Forbidden\n");
  });

  it("refuses without --account, with the same sentence as before", async () => {
    expect(await run("resources")).toBe(1);
    expect(out.stderr).toBe("Pass --account <id|name> (see `infrawrench accounts`).\n");
  });

  it("refuses an account that matches nothing", async () => {
    serveRoutes(out, cloudRoutes);
    expect(await run("resources", "-a", "nope")).toBe(1);
    expect(out.stderr).toBe('No account matches "nope".\n');
  });

  it("rejects a flag it does not take", async () => {
    expect(await run("resources", "-a", "prod", "--kind", "x")).toBe(2);
    expect(out.stdout).toBe("");
  });
});

describe("resource", () => {
  it("shows one cloud resource, its account taken from the id", async () => {
    serveRoutes(out, cloudRoutes);
    expect(await run("resource", "acc_2:ec2-instance:i-1")).toBe(0);
    expect(out.stdout).toMatchInlineSnapshot(`
      "web-1 (ec2-instance · prod)

      id           acc_2:ec2-instance:i-1
      external id  i-1
      field size   t3.small
      field tags   {"env":"prod"}
      output ip    10.0.0.1
      "
    `);
    expect(out.stdout).toContain("field size");
  });

  it("prints the row as JSON", async () => {
    serveRoutes(out, cloudRoutes);
    expect(await run("resource", "acc_2:ec2-instance:i-1", "--json")).toBe(0);
    expect(JSON.parse(out.stdout)).toMatchObject({
      id: "acc_2:ec2-instance:i-1",
      fields: { size: "t3.small" },
      outputs: { ip: "10.0.0.1" },
    });
  });

  it("resolves a local resource's outputs on demand", async () => {
    local.listAccountResourcesLive.mockResolvedValue({
      resources: [
        {
          id: "loc_1:droplet:42",
          pluginId: "digitalocean",
          resourceTypeId: "droplet",
          accountId: "loc_1",
          displayName: "nas",
          externalId: "42",
          fields: { region: "ams3" },
          resolvedOutputs: {},
          parentResourceId: null,
        },
      ],
      errors: [],
    });
    local.resolveResourceOutputs.mockResolvedValue({ ipv4: "203.0.113.4" });
    expect(await run("resource", "loc_1:droplet:42", "--local")).toBe(0);
    expect(out.stdout).toMatchInlineSnapshot(`
      "nas (droplet · home lab)

      id            loc_1:droplet:42
      external id   42
      field region  ams3
      output ipv4   203.0.113.4
      "
    `);
    expect(out.stdout).toContain("output ipv4");
  });

  it("asks for an id, with the same sentence as before", async () => {
    expect(await run("resource")).toBe(1);
    expect(out.stderr).toBe("Usage: infrawrench resource <resource-id>\n");
  });

  it("names a resource it cannot find", async () => {
    serveRoutes(out, cloudRoutes);
    expect(await run("resource", "acc_2:ec2-instance:i-9")).toBe(1);
    expect(out.stderr).toBe("Resource acc_2:ec2-instance:i-9 not found in prod.\n");
  });
});
