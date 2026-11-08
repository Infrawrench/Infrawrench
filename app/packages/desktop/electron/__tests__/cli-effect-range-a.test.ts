import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// `hygiene`, `carbon`, `alerts` and `routing` on effect/cli: text and
// `--json` output, refusals and exit codes, against fixtures. Nothing reaches
// a network or a database.
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

const pretty = (value: unknown) => `${JSON.stringify(value, null, 2)}\n`;

// ---------------------------------------------------------------------------
// hygiene
// ---------------------------------------------------------------------------

const finding = (id: string, severity: string, title: string, detail: string) => ({
  id,
  kind: "unused-api-key",
  severity,
  title,
  detail,
  recommendation: "Revoke it.",
  entityType: "api-key",
  entityId: id,
  entityName: title,
  facts: { lastUsedDays: 120 },
});

const HYGIENE = {
  generatedAt: "2026-11-08T11:00:00.000Z",
  windowDays: 90,
  auditHistoryDays: 40,
  permissionFindingsWithheld: true,
  findings: [
    finding("k1", "high", "CI deploy key", "Not used in 120 days"),
    finding("k2", "low", "Laptop SSH key", "Referenced by no host"),
  ],
  counts: { high: 1, medium: 0, low: 1, total: 2 },
};

describe("hygiene", () => {
  it("prints findings and the caveat", async () => {
    serveRoutes(out, { "GET /credential-hygiene?windowDays=90": HYGIENE });
    expect(await run("hygiene", "--days", "90")).toBe(0);
    expect(out.stdout).toMatchInlineSnapshot(`
      "Acme · credential hygiene over the last 90 days

      SEVERITY  WHAT            WHY                  
      high      CI deploy key   Not used in 120 days 
      low       Laptop SSH key  Referenced by no host

      1 high · 0 medium · 1 low

      Unused means no write recorded in the audit log. Reads are not logged, so this says nothing about what a person or key can see.
      Only 40 days of audit history. Unused-permission findings were withheld.
      "
    `);
  });

  it("says when there is nothing, and with no history", async () => {
    serveRoutes(out, {
      "GET /credential-hygiene": {
        ...HYGIENE,
        windowDays: 30,
        auditHistoryDays: null,
        findings: [],
        counts: { high: 0, medium: 0, low: 0, total: 0 },
      },
    });
    expect(await run("hygiene")).toBe(0);
    expect(out.stdout).toMatchInlineSnapshot(`
      "Acme · credential hygiene over the last 30 days

      Nothing to flag.

      Unused means no write recorded in the audit log. Reads are not logged, so this says nothing about what a person or key can see.
      No audit history yet. Unused-permission findings were withheld.
      "
    `);
  });

  it("prints the body under --json", async () => {
    serveRoutes(out, { "GET /credential-hygiene": HYGIENE });
    expect(await run("hygiene", "--json")).toBe(0);
    expect(out.stdout).toBe(pretty({ org: "org_1", ...HYGIENE }));
  });

  it("refuses a bad --days with the legacy sentence", async () => {
    expect(await run("hygiene", "--days", "0")).toBe(2);
    expect(out.stderr).toContain('--days must be a whole number of at least 1, got "0"');
    expect(out.requests).toEqual([]);
  });

  it("refuses a flag it does not read, with its help", async () => {
    expect(await run("hygiene", "--last", "7d")).toBe(2);
    expect(out.stderr).toContain("--last");
    expect(out.stdout).toBe("");
  });
});

// ---------------------------------------------------------------------------
// carbon
// ---------------------------------------------------------------------------

const carbonRow = (name: string, region: string, vcpus: number, count: number, kg: number) => ({
  vcpus,
  count,
  region,
  grid: "aws",
  gridIntensity: 312.4,
  gridZone: `aws ${region}`,
  gridBasis: "annual",
  pue: 1.15,
  kwh: 10,
  kgCo2e: kg,
  resourceId: `r-${name}`,
  displayName: name,
  pluginId: "aws",
  resourceTypeId: "ec2-instance",
  accountId: "acc_1",
  accountName: "prod",
});

const CARBON = {
  windowDays: 30,
  totalKgCo2e: 412.5,
  totalKwh: 1320.4,
  estimatedCount: 3,
  unestimated: [
    {
      resourceId: "r-x",
      displayName: "edge-worker",
      pluginId: "cloudflare",
      resourceTypeId: "worker",
      accountId: "acc_2",
      accountName: null,
      region: null,
      reason: "unsupported-provider",
    },
    {
      resourceId: "r-y",
      displayName: "odd-vm",
      pluginId: "aws",
      resourceTypeId: "ec2-instance",
      accountId: "acc_1",
      accountName: "prod",
      region: "mars-1",
      reason: "brand-new-reason",
    },
  ],
  unestimatedCount: 23,
  duplicateCount: 2,
  byRegion: [
    { key: "us-east-1", label: "us-east-1", kgCo2e: 300, kwh: 900, resourceCount: 2 },
    { key: "eu-west-1", label: "eu-west-1", kgCo2e: 112.5, kwh: 420.4, resourceCount: 1 },
  ],
  byAccount: [],
  byProvider: [{ key: "aws", label: "AWS", kgCo2e: 412.5, kwh: 1320.4, resourceCount: 3 }],
  rows: [
    carbonRow("api-1", "us-east-1", 4, 1, 200),
    carbonRow("workers", "us-east-1", 2, 3, 100),
    carbonRow("db", "eu-west-1", 8, 1, 112.5),
  ],
  assumptions: {
    cpuUtilization: 0.5,
    pue: { aws: 1.15 },
    vcpuWatts: { aws: { min: 0.7, max: 3.5 } },
    coefficientSource: "Cloud Carbon Footprint",
    coefficientVintage: "2024",
    scope: "Processors only.",
  },
  generatedAt: "2026-11-08T11:00:00.000Z",
};

describe("carbon", () => {
  it("prints the estimate with its gaps", async () => {
    serveRoutes(out, { "GET /carbon?windowDays=30": CARBON });
    expect(await run("carbon")).toBe(0);
    expect(out.stdout).toMatchInlineSnapshot(`
      "~413 kg CO2e · estimated · Acme · last 30d · 1320 kWh
      3 resources estimated · 23 could not be estimated · 2 nodes counted as their instance

      By provider
      AWS ██████████████████████████████ 413 kg

      By region
      us-east-1 ██████████████████████████████ 300 kg
      eu-west-1 ███████████░░░░░░░░░░░░░░░░░░░ 113 kg

      Heaviest resources
      RESOURCE  PROVIDER  REGION     VCPU  G/KWH  CO2E  
      api-1     aws       us-east-1     4    312  200 kg
      workers   aws       us-east-1     6    312  100 kg
      db        aws       eu-west-1     8    312  113 kg

      Not estimated, and why
        edge-worker cloudflare · no published grid figures
        odd-vm aws · brand-new-reason
        … and 3 more (--output json for all)

      Estimated, not measured. 50% CPU utilisation assumed; grid figures 2024; processors only.
      "
    `);
  });

  it("sizes the window from --last or --days, and prints the body under --json", async () => {
    serveRoutes(out, { "GET /carbon?windowDays=14": CARBON, "GET /carbon?windowDays=90": CARBON });
    expect(await run("carbon", "--last", "2w", "--json")).toBe(0);
    expect(out.stdout).toBe(pretty(CARBON));
    out.stdout = "";
    expect(await run("carbon", "--days", "90", "--last", "2w", "--json")).toBe(0);
  });

  it("refuses a window past the bound and a bad --last", async () => {
    serveRoutes(out, {});
    expect(await run("carbon", "--days", "400")).toBe(2);
    expect(out.stderr).toBe(
      "Window too large. The server accepts at most 365 days, asked for 400.\n",
    );
    out.stderr = "";
    expect(await run("carbon", "--last", "6h")).toBe(2);
    expect(out.stderr).toContain('Invalid --last "6h": use forms like 7d, 30d, 12w, 3m');
  });
});

// ---------------------------------------------------------------------------
// alerts
// ---------------------------------------------------------------------------

const rule = (name: string, over: Record<string, unknown>) => ({
  id: `r-${name}`,
  name,
  metricKey: "CPU %",
  comparator: ">",
  threshold: 90,
  forMinutes: 15,
  cooldownMinutes: 60,
  enabled: true,
  pluginId: "aws",
  resourceTypeId: "ec2-instance",
  tagKey: "env",
  tagValue: "prod",
  lastEvalAt: null,
  createdAt: "2026-10-01T00:00:00.000Z",
  updatedAt: "2026-10-01T00:00:00.000Z",
  firingCount: 0,
  matchingResourceCount: 4,
  ...over,
});

const RULES = [
  rule("Hot CPU", { firingCount: 2 }),
  rule("Disk", {
    metricKey: "Disk %",
    enabled: false,
    pluginId: null,
    resourceTypeId: null,
    tagKey: null,
    tagValue: null,
  }),
];

const EVENTS = [
  {
    id: "e1",
    ruleId: "r-Hot CPU",
    ruleName: "Hot CPU",
    resourceId: "i-1",
    resourceName: "web-1",
    status: "firing",
    observedValue: 97.4567,
    firedAt: "2026-11-08T10:00:00.000Z",
    resolvedAt: null,
  },
  {
    id: "e2",
    ruleId: "r-Hot CPU",
    ruleName: "Hot CPU",
    resourceId: "i-2",
    resourceName: "web-2",
    status: "resolved",
    observedValue: 91,
    firedAt: "2026-11-07T10:00:00.000Z",
    resolvedAt: "2026-11-07T11:30:00.000Z",
  },
];

describe("alerts", () => {
  it("lists rules as text and JSON", async () => {
    serveRoutes(out, { "GET /metric-alerts": RULES });
    expect(await run("alerts")).toBe(0);
    expect(out.stdout).toMatchInlineSnapshot(`
      "Acme · 2 rules · 2 firings

         RULE     CONDITION            RESOURCES                      MATCHES  FIRING
      ●  Hot CPU  CPU % > 90 for 15m   aws · ec2-instance · env=prod        4       2
      ○  Disk     Disk % > 90 for 15m  all resources                        4       0

      Rules match resources by query (provider + type + tag), so resources created later are covered automatically. \`infrawrench alerts events\` shows recent firings.
      "
    `);
    out.stdout = "";
    expect(await run("alerts", "--json")).toBe(0);
    expect(out.stdout).toBe(pretty({ org: "org_1", rules: RULES }));
  });

  it("says when there are no rules", async () => {
    serveRoutes(out, { "GET /metric-alerts": [] });
    expect(await run("alerts")).toBe(0);
  });

  it("lists events with a capped limit", async () => {
    serveRoutes(out, {
      "GET /metric-alerts/events?limit=200": EVENTS,
      "GET /metric-alerts/events": [],
    });
    expect(await run("alerts", "events", "--limit", "500")).toBe(0);
    expect(out.stdout).toMatchInlineSnapshot(`
      "Acme · 2 firings, newest first

      RULE     RESOURCE  OBSERVED  FIRED             STATUS                   
      Hot CPU  web-1        97.46  2026-11-08 10:00  firing                   
      Hot CPU  web-2           91  2026-11-07 10:00  resolved 2026-11-07 11:30
      "
    `);
    out.stdout = "";
    expect(await run("alerts", "events", "--limit", "500", "--json")).toBe(0);
    expect(out.stdout).toBe(pretty({ org: "org_1", events: EVENTS }));
    out.stdout = "";
    expect(await run("alerts", "events")).toBe(0);
  });

  it("refuses --local", async () => {
    expect(await run("alerts", "--local")).toBe(1);
    out.stderr = "";
    expect(await run("alerts", "events", "--local")).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// routing
// ---------------------------------------------------------------------------

const ROUTING = {
  rules: [
    {
      id: "ar1",
      name: "Big anomalies",
      enabled: true,
      position: 0,
      conditions: [
        { field: "trigger", op: "in", values: ["cost-anomaly", "budget"] },
        { field: "severity", op: "gte", severity: "warning" },
        { field: "accountId", op: "notIn", values: ["acc_1", "acc_9"] },
        { field: "amountCents", op: "gte", cents: 50000 },
        { field: "key", op: "contains", value: "prod" },
        { field: "text", op: "notContains", value: "test" },
      ],
      destinations: [
        { kind: "slack", channelId: "C1" },
        { kind: "slack", channelId: "C404" },
        { kind: "msteams", webhookId: "w1" },
        { kind: "on-call", scheduleId: "s1" },
        { kind: "email-member", userId: "u1" },
        { kind: "email-member", userId: "u-gone" },
        { kind: "email-address", address: "finance@example.com" },
        { kind: "paging-provider", accountId: "acc_pd", targetId: "SVC1" },
        { kind: "provider-on-call", accountId: "acc_x", sourceId: "POL1" },
      ],
      continueOnMatch: true,
      quietHours: {
        timezone: "Europe/Berlin",
        startMinute: 1320,
        endMinute: 480,
        days: [1, 2, 3],
        urgentOverride: "critical",
      },
      escalation: { afterMinutes: 15, destinations: [{ kind: "push" }] },
    },
    {
      id: "ar2",
      name: "Swallow drift",
      enabled: false,
      position: 1,
      conditions: [
        { field: "pluginId", op: "in", values: ["aws"] },
        { field: "resourceTypeId", op: "notIn", values: ["s3-bucket"] },
        { field: "key", op: "eq", value: "drift" },
      ],
      destinations: [],
      continueOnMatch: false,
      quietHours: {
        timezone: "UTC",
        startMinute: 0,
        endMinute: 60,
        days: [],
        urgentOverride: null,
      },
      escalation: null,
    },
    {
      id: "ar3",
      name: "Everything",
      enabled: true,
      position: 2,
      conditions: [],
      destinations: [{ kind: "github-issues" }, { kind: "push" }],
      continueOnMatch: false,
      quietHours: null,
      escalation: null,
    },
  ],
  usingDefaults: false,
  slackChannels: [{ id: "C1", name: "incidents", isPrivate: false }],
  msTeamsWebhooks: [{ id: "w1", label: "Ops" }],
  accounts: [
    { id: "acc_1", displayName: "prod", pluginId: "aws" },
    { id: "acc_pd", displayName: "PagerDuty", pluginId: "pagerduty" },
  ],
  onCallSchedules: [{ id: "s1", name: "Primary" }],
  members: [{ userId: "u1", name: "Ada", email: "ada@example.com" }],
  emailAvailable: true,
  emailSettings: { externalPolicy: "member-domains", allowedDomains: [] },
  memberDomains: ["example.com"],
};

const DELIVERIES = [
  {
    id: "d1",
    trigger: "cost-anomaly",
    severity: "critical",
    title: "Spend spike on EC2",
    body: "…",
    ruleName: "Big anomalies",
    state: "held",
    createdAt: "2026-11-08T02:00:00.000Z",
    deliverAfter: "2026-11-08T07:00:00.000Z",
    escalateAt: null,
    acknowledgedAt: null,
    acknowledgedByUserId: null,
  },
  {
    id: "d2",
    trigger: "budget",
    severity: "warning",
    title: "Budget at 90%",
    body: "…",
    ruleName: null,
    state: "awaiting_ack",
    createdAt: "2026-11-08T03:00:00.000Z",
    deliverAfter: null,
    escalateAt: "2026-11-08T03:15:00.000Z",
    acknowledgedAt: null,
    acknowledgedByUserId: null,
  },
  {
    id: "d3",
    trigger: "budget",
    severity: "info",
    title: "Odd",
    body: "…",
    ruleName: "x",
    state: "brand_new_state",
    createdAt: "2026-11-08T04:00:00.000Z",
    deliverAfter: null,
    escalateAt: null,
    acknowledgedAt: null,
    acknowledgedByUserId: null,
  },
];

const EMAIL = {
  externalPolicy: "member-domains",
  allowedDomains: ["partner.io"],
  emailAvailable: false,
  memberDomains: ["example.com"],
  suppressions: [{ id: "s1", email: "old@example.com", createdAt: "2026-10-01T09:00:00.000Z" }],
};
