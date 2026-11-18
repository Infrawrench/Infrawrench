import { describe, expect, it, vi } from "vitest";

// `runway` on effect/cli: text and `--json` output against fixtures. Nothing
// reaches a network or a database.
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

import { RawResponse, run, serveRoutes, useCliCapture } from "./cli-harness";

const out = useCliCapture();

const asJson = (value: unknown) => `${JSON.stringify(value, null, 2)}\n`;
const GiB = 1024 ** 3;

const forecast = (overrides: Record<string, unknown> = {}) => ({
  perDay: GiB,
  daysLeft: 6.2,
  fullAt: "2026-11-24T12:00:00.000Z",
  method: "trend",
  confidence: "ok",
  points: 120,
  ...overrides,
});

const row = (overrides: Record<string, unknown>) => ({
  key: "logicalSize",
  resourceId: "neon:acc1:br-1",
  resourceName: "main",
  resourceTypeId: "neon-branch",
  accountId: "acc1",
  accountName: "prod",
  pluginId: "neon",
  label: "Logical size",
  unit: "bytes",
  used: 9.2 * GiB,
  limit: 10 * GiB,
  utilization: 0.92,
  limitSource: "provider",
  plan: null,
  kind: "runway",
  source: "field",
  observedAt: "2026-11-18T11:00:00.000Z",
  forecast: forecast(),
  cycle: null,
  status: "critical",
  ...overrides,
});

const RUNWAY = {
  rows: [
    row({
      resourceName: "uploads",
      label: "Storage",
      used: 10 * GiB,
      utilization: 1,
      status: "full",
    }),
    row({}),
    row({
      key: "monthlySent",
      resourceName: "mail",
      accountName: "mailgun",
      label: "Emails sent",
      unit: "emails",
      used: 41_000,
      limit: 50_000,
      utilization: 0.82,
      limitSource: "plan",
      plan: "Foundation",
      kind: "allowance",
      forecast: forecast({ perDay: 2400, daysLeft: null }),
      cycle: {
        start: "2026-11-01T00:00:00.000Z",
        end: "2026-12-01T00:00:00.000Z",
        projectedUsed: 71_000,
        projectedUtilization: 1.42,
      },
    }),
    row({
      resourceName: "cache",
      label: "Memory",
      unit: "MB",
      used: 300,
      limit: 1024,
      utilization: 0.29,
      forecast: forecast({ perDay: 0.4, daysLeft: null, confidence: "noisy" }),
      status: "ok",
    }),
    row({
      resourceName: "logs",
      used: 2 * GiB,
      utilization: 0.2,
      forecast: forecast({ perDay: null, daysLeft: null, confidence: "short", method: null }),
      status: "ok",
    }),
  ],
  runwayDays: 14,
  allowanceThreshold: 0.8,
  windowDays: 14,
};

describe("runway", () => {
  it("prints usages soonest first with their runway", async () => {
    serveRoutes(out, { "GET /quotas/runway": RUNWAY });
    expect(await run("runway")).toBe(0);
    expect(out.stdout).toMatchInlineSnapshot(`
      "Acme · 5 usages, 3 running out · alerts within 14d or past 80% of an allowance

      RESOURCE  ACCOUNT  USAGE                  USED                                             %     RUNWAY            
      uploads   prod     Storage                10.0 GiB / 10.0 GiB                              100%  at the limit      
      main      prod     Logical size           9.2 GiB / 10.0 GiB                               92%   6d                
      mail      mailgun  Emails sent (monthly)  41,000 emails / 50,000 emails (Foundation plan)  82%   142% by 2026-12-01
      cache     prod     Memory                 300 MB / 1,024 MB                                29%   over a year       
      logs      prod     Logical size           2.0 GiB / 10.0 GiB                               20%   not enough history
      "
    `);
  });

  it("filters to rows at risk with --at-risk", async () => {
    serveRoutes(out, { "GET /quotas/runway": RUNWAY });
    expect(await run("runway", "--at-risk")).toBe(0);
    expect(out.stdout).toContain("uploads");
    expect(out.stdout).toContain("mail");
    expect(out.stdout).not.toContain("cache");
    expect(out.stdout).not.toContain("logs");
  });

  it("prints the org and the raw body under --json", async () => {
    serveRoutes(out, { "GET /quotas/runway": RUNWAY });
    expect(await run("runway", "--json")).toBe(0);
    expect(out.stdout).toBe(asJson({ org: "org_1", ...RUNWAY }));
  });

  it("renders a status a newer server added instead of failing", async () => {
    serveRoutes(out, {
      "GET /quotas/runway": { ...RUNWAY, rows: [row({ status: "brand-new" })] },
    });
    expect(await run("runway")).toBe(0);
    expect(out.stdout).toContain("main");
  });

  it("says when nothing is tracked", async () => {
    serveRoutes(out, { "GET /quotas/runway": { ...RUNWAY, rows: [] } });
    expect(await run("runway")).toBe(0);
    expect(out.stdout).toContain("No resources with a tracked usage and limit yet.");
  });

  it("names a failed request", async () => {
    serveRoutes(out, { "GET /quotas/runway": new RawResponse(403, '{"error":"resources:read"}') });
    expect(await run("runway")).toBe(1);
    expect(out.stderr).toBe(
      'Cloud request failed: 403 /quotas/runway {"error":"resources:read"}\n',
    );
  });
});
