import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// `price-changes` and `price-changes catalog` on effect/cli: text and
// `--json` output and the local refusal, against fixtures. Nothing reaches a
// network or a database.
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

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(Date.parse("2026-11-18T12:00:00.000Z"));
});
afterEach(() => {
  vi.useRealTimers();
});

const change = (overrides: Record<string, unknown> = {}) => ({
  id: "11111111-1111-4111-8111-111111111111",
  pluginId: "aws",
  platform: "ec2",
  instanceType: "m5.large",
  region: "us-east-1",
  selection: { operating_system: "Linux" },
  oldHourlyUsd: 0.096,
  newHourlyUsd: 0.105,
  percent: 9.375,
  effectiveAt: "2026-11-01T00:00:00.000Z",
  upcoming: false,
  units: 6,
  approximate: false,
  monthlyImpactUsd: 39.42,
  resources: [{ displayName: "web-1" }],
  belowThreshold: false,
  alertedAt: "2026-11-02T00:00:00.000Z",
  suppressionIds: [],
  scenarioModelId: null,
  detectedAt: "2026-11-02T00:00:00.000Z",
  pageUrl: "https://instances.infrawrench.com/aws/ec2/m5.large",
  ...overrides,
});

const LIST = {
  changes: [
    change(),
    change({
      id: "22222222-2222-4222-8222-222222222222",
      instanceType: "t3.micro",
      oldHourlyUsd: 0.0104,
      newHourlyUsd: 0.0105,
      percent: 0.96,
      monthlyImpactUsd: 0.07,
      units: 1,
      belowThreshold: true,
      alertedAt: null,
    }),
  ],
  available: true,
  lastScannedAt: "2026-11-18T06:00:00.000Z",
  minMonthlyImpactCents: 1000,
  minPercent: 1,
};

describe("price-changes", () => {
  it("lists changes over the thresholds and says how many it hid", async () => {
    serveRoutes(out, { "GET /price-changes?days=180": LIST });
    expect(await run("price-changes")).toBe(0);
    expect(out.stdout).toContain("m5.large");
    expect(out.stdout).toContain("$0.096/hr → $0.105/hr");
    expect(out.stdout).toContain("+$39.42");
    expect(out.stdout).toContain("alerted");
    expect(out.stdout).not.toContain("t3.micro");
    expect(out.stdout).toContain("1 smaller change is under your thresholds (--all to list).");
    expect(out.requests).toEqual(["GET /price-changes?days=180"]);
  });

  it("includes the smaller ones with --all", async () => {
    serveRoutes(out, { "GET /price-changes?days=180": LIST });
    expect(await run("price-changes", "--all")).toBe(0);
    expect(out.stdout).toContain("t3.micro");
    expect(out.stdout).toContain("under threshold");
  });

  it("prints the body under --json", async () => {
    serveRoutes(out, { "GET /price-changes?days=180": LIST });
    expect(await run("price-changes", "--json")).toBe(0);
    expect(JSON.parse(out.stdout)).toEqual(LIST);
  });

  it("refuses --local in one line", async () => {
    serveRoutes(out, {});
    expect(await run("price-changes", "--local")).toBe(1);
    expect(out.stderr).toBe("Price changes are found by the cloud's daily scan; drop --local.\n");
    expect(out.requests).toEqual([]);
  });
});

describe("price-changes catalog", () => {
  it("lists one platform's changes", async () => {
    serveRoutes(out, {
      "GET /price-changes/catalog?days=30&platform=rds": {
        available: true,
        platforms: ["ec2", "rds"],
        platform: "rds",
        days: 30,
        changes: [
          {
            platform: "rds",
            instanceType: "db.r6g.large",
            region: "eu-west-1",
            variant: "PostgreSQL, Multi-AZ",
            oldHourlyUsd: 0.5,
            newHourlyUsd: 0.45,
            percent: -10,
            effectiveAt: "2026-11-10T00:00:00.000Z",
            vcpu: 2,
            memoryGib: 16,
            pageUrl: "https://instances.infrawrench.com/aws/rds/db.r6g.large",
          },
        ],
        truncated: false,
      },
    });
    expect(await run("price-changes", "catalog", "--provider", "rds", "--days", "30")).toBe(0);
    expect(out.stdout).toContain("Amazon RDS");
    expect(out.stdout).toContain("db.r6g.large");
    expect(out.stdout).toContain("-10%");
    expect(out.requests).toEqual(["GET /price-changes/catalog?days=30&platform=rds"]);
  });
});
