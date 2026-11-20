import { describe, expect, it, vi } from "vitest";

// `migrate-estimate` on effect/cli: text and `--json` output, the service
// lookup and the refusals, against fixtures. Nothing reaches a network.
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

const cli = (...argv: string[]) => {
  out.stdout = "";
  out.stderr = "";
  return run(...argv);
};

const SERVICES = {
  services: [
    { id: "svc-1", slug: "checkout", name: "Checkout API" },
    { id: "svc-2", slug: "search", name: "Search" },
  ],
};

const RESULT = {
  estimateId: null,
  name: "Checkout API on hetzner",
  source: { kind: "service", label: "Checkout API", resourceCount: 3 },
  target: { pluginId: "hetzner", pluginName: "Hetzner" },
  region: {
    region: "fsn1",
    regionLabel: "Falkenstein",
    area: "europe",
    sourceAreas: ["europe"],
    choice: "nearest",
    crossesArea: false,
  },
  rows: [
    {
      resourceId: "r1",
      displayName: "api-1",
      pluginId: "aws",
      pluginName: "AWS",
      resourceTypeId: "ec2-instance",
      resourceTypeName: "EC2 Instance",
      accountId: "a1",
      category: "vm",
      sourceRegion: "eu-central-1",
      sourceArea: "europe",
      instanceType: "m7i.large",
      specs: { vcpus: 2, memoryGb: 8, gpuCount: null, gpuModel: null, diskGb: null, count: 1 },
      current: { amount: 74.2, currency: "USD", basis: "billed", partial: false },
      target: {
        resourceTypeId: "server",
        resourceTypeName: "Server",
        sizeId: "cx32",
        sizeLabel: "CX32",
        vcpus: 4,
        memoryGb: 8,
        gpuCount: null,
        region: "fsn1",
        regionLabel: "Falkenstein",
        cost: { amount: 6.8, currency: "USD", basis: "list-price", partial: false },
        overridden: false,
      },
      note: null,
      candidates: [],
      targetTypes: [{ id: "server", name: "Server" }],
    },
    {
      resourceId: "r2",
      displayName: "orders-db",
      pluginId: "aws",
      pluginName: "AWS",
      resourceTypeId: "rds-instance",
      resourceTypeName: "RDS Instance",
      accountId: "a1",
      category: "managed-postgres",
      sourceRegion: "eu-central-1",
      sourceArea: "europe",
      instanceType: "db.r6g.large",
      specs: { vcpus: 2, memoryGb: null, gpuCount: null, gpuModel: null, diskGb: 100, count: 1 },
      current: { amount: 190, currency: "USD", basis: "estimate", partial: true },
      target: {
        resourceTypeId: "pg",
        resourceTypeName: "Managed Postgres",
        sizeId: null,
        sizeLabel: null,
        vcpus: null,
        memoryGb: null,
        gpuCount: null,
        region: "fsn1",
        regionLabel: "Falkenstein",
        cost: null,
        overridden: false,
      },
      note: "no-account",
      candidates: [],
      targetTypes: [],
    },
  ],
  unmatched: [
    {
      resourceId: "r3",
      displayName: "events",
      pluginId: "aws",
      pluginName: "AWS",
      resourceTypeId: "sqs-queue",
      resourceTypeName: "SQS Queue",
      category: null,
      reason: "no-category",
      current: null,
    },
  ],
  totals: {
    current: [{ amount: 264.2, currency: "USD" }],
    target: [{ amount: 6.8, currency: "USD" }],
    currentUnknown: 0,
    targetUnknown: 1,
    unmatchedCurrent: [],
    comparable: {
      currency: "USD",
      current: 264.2,
      target: 6.8,
      pairedDelta: -67.4,
      pairedRows: 1,
    },
  },
  displayCurrency: null,
  terraform: true,
  truncated: false,
  generatedAt: "2026-11-18T00:00:00.000Z",
};

describe("migrate-estimate", () => {
  it("prices a service found by name on the target, side by side", async () => {
    serveRoutes(out, {
      "GET /services": SERVICES,
      "POST /migration-estimates/preview": RESULT,
    });
    expect(await cli("migrate-estimate", "--service", "checkout api", "--to", "hetzner")).toBe(0);
    expect(out.requests).toEqual(["GET /services", "POST /migration-estimates/preview"]);
    expect(out.stdout).toContain("Checkout API on Hetzner · Falkenstein (nearest)");
    expect(out.stdout).toContain("api-1");
    expect(out.stdout).toContain("$74.20 billed");
    expect(out.stdout).toContain("CX32");
    expect(out.stdout).toContain("needs an account on the target provider");
    expect(out.stdout).toContain("-$67.40/month");
    expect(out.stdout).toContain("No equivalent on Hetzner");
    expect(out.stdout).toContain("no cross-provider equivalent");
  });

  it("prints the body under --json", async () => {
    serveRoutes(out, {
      "GET /services": SERVICES,
      "POST /migration-estimates/preview": RESULT,
    });
    expect(
      await cli("migrate-estimate", "--service", "checkout", "--to", "hetzner", "--json"),
    ).toBe(0);
    expect(JSON.parse(out.stdout)).toEqual({ org: "org_1", savedId: null, ...RESULT });
  });

  it("saves the estimate and reads it back from the saved route", async () => {
    serveRoutes(out, {
      "POST /migration-estimates": { id: "est-1", name: "Move" },
      "GET /migration-estimates/est-1/result": RESULT,
    });
    expect(
      await cli("migrate-estimate", "--resources", "r1,r2", "--to", "hetzner", "--save", "Move"),
    ).toBe(0);
    expect(out.requests).toEqual([
      "POST /migration-estimates",
      "GET /migration-estimates/est-1/result",
    ]);
    expect(out.stdout).toContain("Saved as");
  });

  it("refuses an incomplete command line and an unknown service", async () => {
    serveRoutes(out, { "GET /services": SERVICES });
    expect(await cli("migrate-estimate", "--to", "hetzner")).not.toBe(0);
    expect(await cli("migrate-estimate", "--service", "billing", "--to", "hetzner")).not.toBe(0);
    expect(out.stderr).toContain('No service matches "billing"');
  });
});
