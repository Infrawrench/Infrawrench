import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// A server deploys ahead of the desktop release the CLI ships in, so it can
// send an enum value this build has no case for. Each command here must still
// render, the way the legacy command's fallback did where it had one.
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

describe("moment", () => {
  const event = (id: string, ts: string, over: Record<string, unknown>) => ({
    id,
    feed: "changes",
    kind: "change.updated",
    timestamp: ts,
    title: `${id} happened`,
    severity: "info",
    ...over,
  });

  // Equal timestamps sort by feed order with unknown feeds after every known
  // one, then by id: `z`, on the last known feed, must still come first.
  const MOMENT = {
    at: "2026-11-08T03:14:00.000Z",
    from: "2026-11-08T02:14:00.000Z",
    to: "2026-11-08T04:14:00.000Z",
    windowMinutes: 60,
    generatedAt: "2026-11-08T12:00:00.000Z",
    feeds: [{ feed: "quantumLedger", status: "error", error: "down" }],
    events: [
      event("b", "2026-11-08T03:00:00.000Z", { feed: "quantumLedger", severity: "catastrophic" }),
      event("a", "2026-11-08T03:00:00.000Z", { feed: "billingRuns", severity: "critical" }),
      event("z", "2026-11-08T03:00:00.000Z", { feed: "expiryAlerts", severity: "warning" }),
      event("y", "2026-11-08T03:00:00.000Z", { feed: "audit" }),
    ],
    incidents: [
      {
        id: "i1",
        pluginId: "aws",
        pluginName: "AWS",
        title: "Region-wide",
        impact: "apocalyptic",
        startedAt: "2026-11-08T02:00:00.000Z",
        resolvedAt: null,
      },
    ],
  };

  it("renders an unknown feed, severity and impact the way the legacy fallbacks did", async () => {
    serveRoutes(out, { "GET /moment": MOMENT });
    expect(await run("moment")).toBe(0);
    expect(out.stdout).toMatchInlineSnapshot(`
      "Acme · 2026-11-08 02:14:00 → 2026-11-08 04:14:00 UTC (±60m around 2026-11-08 03:14:00)
        quantumLedger unavailable, down

      Provider incidents overlapping this window
        ▲ AWS: Region-wide (active)

        03:00:00 · [Audit log] y happened (during AWS incident)
        03:00:00 ! [Expiry alerts] z happened (during AWS incident)
        03:00:00 ✗ [billingRuns] a happened (during AWS incident)
        03:00:00 · [quantumLedger] b happened (during AWS incident)

      4 events. Recentre with \`infrawrench moment <timestamp>\`, zoom with --window 15m|1h|6h.
      "
    `);
    out.stdout = "";
    expect(await run("moment", "--json")).toBe(0);
    expect(out.stdout).toBe(pretty({ org: "org_1", ...MOMENT }));
  });
});

describe("graph", () => {
  const node = (id: string) => ({
    id,
    displayName: id,
    pluginId: "aws",
    pluginDisplayName: "AWS",
    pluginLogoSvg: "",
    resourceTypeId: "t",
    resourceTypeLabel: "Thing",
    accountId: "acc_1",
    accountName: "prod",
  });
  const GRAPH = {
    nodes: [node("web"), node("db"), node("vpc")],
    edges: [
      {
        consumerResourceId: "web",
        consumerFieldKey: "dbHost",
        providerResourceId: "db",
        providerOutputKey: "endpoint",
        kind: "telepathy",
      },
      {
        consumerResourceId: "web",
        consumerFieldKey: "vpcId",
        providerResourceId: "vpc",
        providerOutputKey: "id",
        kind: "containment",
      },
    ],
  };

  it("reads an unknown edge kind as a field link and keeps it under --json", async () => {
    serveRoutes(out, { "GET /dependency-graph": GRAPH });
    expect(await run("graph")).toBe(0);
    expect(out.stdout).toMatchInlineSnapshot(`
      "Acme · 3 linked resources, 2 links

      web Thing · prod
      ├─ db Thing · prod  dbHost ← endpoint
      └─ vpc Thing · prod  belongs to

      Read downward: each child is something its parent depends on. ↺ marks a link back to a resource already on the branch.
      "
    `);
    out.stdout = "";
    expect(await run("graph", "web")).toBe(0);
    out.stdout = "";
    expect(await run("graph", "web", "--json")).toBe(0);
    const focused = JSON.parse(out.stdout);
    expect(focused.dependsOn[0]).toEqual({
      node: GRAPH.nodes[1],
      fieldKey: "dbHost",
      outputKey: "endpoint",
      kind: "telepathy",
    });
    out.stdout = "";
    expect(await run("graph", "--json")).toBe(0);
    expect(JSON.parse(out.stdout).edges).toEqual(GRAPH.edges);
  });
});

describe("routing", () => {
  const ROUTING = {
    rules: [
      {
        id: "ar1",
        name: "Mixed",
        enabled: true,
        position: 0,
        conditions: [
          { field: "trigger", op: "in", values: ["budget"] },
          { field: "moonPhase", op: "eq", value: "full" },
        ],
        destinations: [{ kind: "push" }, { kind: "carrier-pigeon", loft: "L1" }],
        continueOnMatch: false,
        quietHours: null,
        escalation: { afterMinutes: 5, destinations: [{ kind: "carrier-pigeon", loft: "L2" }] },
      },
    ],
    usingDefaults: false,
    slackChannels: [],
    msTeamsWebhooks: [],
    accounts: [],
    onCallSchedules: [],
    members: [],
    emailAvailable: true,
    emailSettings: { externalPolicy: "member-domains", allowedDomains: [] },
    memberDomains: [],
  };

  it("reads an unknown destination kind and condition field as the legacy switch did", async () => {
    serveRoutes(out, { "GET /alert-rules": ROUTING });
    expect(await run("routing")).toBe(0);
    expect(out.stdout).toMatchInlineSnapshot(`
      "Evaluated top to bottom; the first match wins unless a rule says otherwise.

      1. Mixed
         when  trigger is budget and 
         →     mobile push, 
         esc   unacknowledged after 5m → 

      "
    `);
  });

  it("still refuses a known kind with a malformed body", async () => {
    serveRoutes(out, {
      "GET /alert-rules": {
        ...ROUTING,
        rules: [{ ...ROUTING.rules[0], destinations: [{ kind: "slack" }] }],
      },
    });
    expect(await run("routing")).toBe(1);
    expect(out.stderr).toContain("Cloud request returned a malformed response for /alert-rules");
  });
});

// The legacy commands below threw a TypeError on these values (a lookup or a
// switch with no case left a table cell undefined), so there is no legacy
// output to match: the value now prints under its own name.

describe("changes", () => {
  it("prints an unknown change kind under its own name", async () => {
    serveRoutes(out, {
      "GET /changes?page=1&pageSize=50": {
        entries: [
          {
            id: "c1",
            resourceId: "r1",
            accountId: "acc_1",
            pluginId: "aws",
            resourceTypeId: "ec2-instance",
            displayName: "web-1",
            changeKind: "teleported",
            diff: [],
            createdAt: "2026-11-08T09:30:00.000Z",
            accountName: "prod",
          },
        ],
        total: 1,
      },
    });
    expect(await run("changes")).toBe(0);
    expect(out.stdout).toMatchInlineSnapshot(`
      "Acme · 1 of 1 event, newest first

      WHEN                 RESOURCE  TYPE              ACCOUNT  WHAT CHANGED
      2026-11-08 09:30  ?  web-1     aws/ec2-instance  prod     teleported  

      Narrow with --account <id|name>, --resource <id>, --kind created|updated|deleted, or --last 7d.
      "
    `);
  });
});

describe("hygiene", () => {
  it("prints an unknown severity under its own name", async () => {
    serveRoutes(out, {
      "GET /credential-hygiene": {
        generatedAt: "2026-11-08T11:00:00.000Z",
        windowDays: 90,
        auditHistoryDays: 120,
        permissionFindingsWithheld: false,
        findings: [
          {
            id: "k1",
            kind: "unused-api-key",
            severity: "existential",
            title: "Old key",
            detail: "Never used",
            recommendation: "Revoke it.",
            entityType: "api-key",
            entityId: "k1",
            entityName: "Old key",
            facts: {},
          },
        ],
        counts: { high: 0, medium: 0, low: 0, existential: 1, total: 1 },
      },
    });
    expect(await run("hygiene")).toBe(0);
    expect(out.stdout).toMatchInlineSnapshot(`
      "Acme · credential hygiene over the last 90 days

      SEVERITY     WHAT     WHY       
      existential  Old key  Never used

      0 high · 0 medium · 0 low

      Unused means no write recorded in the audit log. Reads are not logged, so this says nothing about what a person or key can see.
      "
    `);
  });
});

describe("dora", () => {
  const metric = (band: string | null) => ({ value: 1, band, sample: 3 });
  const summary = {
    deploymentFrequency: { ...metric("legendary"), deploys: 30, days: 30 },
    leadTime: { ...metric("high"), p90Hours: 2 },
    changeFailureRate: { ...metric(null), changes: 30, failures: 1 },
    timeToRestore: { ...metric("low"), restores: 1 },
  };
  const q = "from=2026-10-09T12%3A00%3A00.000Z&to=2026-11-08T12%3A00%3A00.000Z";

  it("prints an unknown band and failure kind under their own names", async () => {
    serveRoutes(out, {
      [`GET /dora?${q}`]: {
        from: "2026-10-09T12:00:00.000Z",
        to: "2026-11-08T12:00:00.000Z",
        bucket: "week",
        filter: null,
        groupBy: "repository",
        summary,
        previous: summary,
        trend: [],
        breakdown: [{ key: "acme/api", label: "acme/api", summary }],
        dimensions: [{ id: "repository", label: "Repository" }],
        settings: {},
        eventCount: 30,
        scopeValues: {},
      },
      [`GET /dora/changes?${q}`]: {
        changes: [
          {
            id: "c1",
            type: "deploy",
            name: "api v42",
            environment: "production",
            repository: null,
            commitSha: null,
            at: "2026-11-07T10:00:00.000Z",
            status: "success",
            source: "github",
            pluginId: null,
            url: null,
            isRollback: false,
            leadTimeHours: 1,
            failure: { kind: "solar-flare", refId: "", title: "", at: "" },
            scope: {},
          },
        ],
        truncated: false,
      },
    });
    expect(await run("dora")).toBe(0);
    expect(out.stdout).toMatchInlineSnapshot(`
      "Acme · delivery · last 30 days · all production

      METRIC                VALUE  BAND       PREVIOUS          TREND (PER WEEK)                     
      deployment frequency  1/day  legendary     1/day  = same                    30 deploys         
      lead time                1h  high             1h  = same                    median of 3, p90 2h
      change failure rate    100%  -              100%  = same                    1 of 30 changes    
      time to restore          1h  low              1h  = same                    1 recoveries       

      by repository
      REPOSITORY  DEPLOYS  FREQUENCY  LEAD TIME  FAILURE  RESTORE                      
      acme/api         30      1/day         1h     100%       1h  legendary high - low

      \`dora changes [--failed]\` and \`dora restores\` list what is behind the numbers.
      Scope with --scope <repository>=<value>; group with --group-by.
      "
    `);
    out.stdout = "";
    expect(await run("dora", "changes")).toBe(0);
    expect(out.stdout).toMatchInlineSnapshot(`
      "WHEN              CHANGE   ENV         COMMIT  LEAD TIME  SOURCE  FAILURE    
      2026-11-07 10:00  api v42  production  -              1h  github  solar-flare
      "
    `);
  });
});
