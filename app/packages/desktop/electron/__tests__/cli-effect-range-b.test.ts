import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// `changes`, `moment`, `metrics`, `graph`, `search` and `starred` on
// effect/cli: text and `--json` output, refusals and exit codes, against
// fixtures. Nothing reaches a network or a database.
// Pin the cloud URL: env.ts is generated per machine, and CI's points at production.
vi.mock("../../env", async (original) => ({
  ...(await original<typeof import("../../env")>()),
  CLOUD_URL: "http://localhost:3000",
}));
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

const local = vi.hoisted(() => ({
  accounts: [{ id: "loc_1", plugin_id: "digitalocean", display_name: "home lab" }],
  fetchLocalMetricSeries: vi.fn(),
}));

vi.mock("../main-utils", async (original) => ({
  ...(await original<typeof import("../main-utils")>()),
  getDb: async () => ({ select: async () => local.accounts }),
}));

vi.mock("../plugin-runtime", () => ({
  listAccountResourcesLive: vi.fn(),
  resolveResourceOutputs: vi.fn(),
  fetchLocalMetricSeries: local.fetchLocalMetricSeries,
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

const ACCOUNTS = [
  { id: "acc_1", pluginId: "aws", displayName: "prod", createdAt: "2026-01-01T00:00:00Z" },
  { id: "acc_2", pluginId: "aws", displayName: "staging", createdAt: "2026-01-01T00:00:00Z" },
];

// ---------------------------------------------------------------------------
// changes
// ---------------------------------------------------------------------------

const change = (id: string, kind: string, name: string, diff: unknown[] = []) => ({
  id,
  resourceId: `acc_1:ec2-instance:${name}`,
  accountId: "acc_1",
  pluginId: "aws",
  resourceTypeId: "ec2-instance",
  displayName: name,
  changeKind: kind,
  diff,
  createdAt: "2026-11-08T09:30:00.000Z",
  accountName: id === "c3" ? null : "prod",
});

const FEED = {
  entries: [
    change("c1", "updated", "web-1", [
      { field: "size", from: "t3.small", to: "t3.large" },
      { field: "tags", from: { env: "dev" }, to: null },
      { field: "region", from: "us-east-1", to: "us-east-2" },
      { field: "ami", from: "ami-1", to: "ami-2" },
    ]),
    change("c2", "created", "web-2"),
    change("c3", "deleted", "old"),
  ],
  total: 7,
};

describe("changes", () => {
  it("lists the feed as text and JSON", async () => {
    serveRoutes(out, { "GET /changes?page=1&pageSize=50": FEED });
    expect(await run("changes")).toBe(0);
    expect(out.stdout).toMatchInlineSnapshot(`
      "Acme · 3 of 7 events, newest first

      WHEN                 RESOURCE  TYPE              ACCOUNT  WHAT CHANGED                 
      2026-11-08 09:30  ~  web-1     aws/ec2-instance  prod     size, tags, region and 1 more
      2026-11-08 09:30  +  web-2     aws/ec2-instance  prod     Appeared                     
      2026-11-08 09:30  -  old       aws/ec2-instance  —        Disappeared                  

      Narrow with --account <id|name>, --resource <id>, --kind created|updated|deleted, or --last 7d.
      "
    `);
    out.stdout = "";
    expect(await run("changes", "--json")).toBe(0);
    expect(out.stdout).toBe(pretty({ org: "org_1", limit: 50, total: 7, entries: FEED.entries }));
  });

  it("narrows by account, kind, resource and window, with diffs", async () => {
    const path =
      "/changes?page=1&pageSize=200&kind=updated&resourceId=acc_1%3Aec2-instance%3Aweb-1&accountId=acc_1&from=2026-11-01T12%3A00%3A00.000Z";
    serveRoutes(out, { "GET /accounts": ACCOUNTS, [`GET ${path}`]: FEED });
    expect(
      await run(
        "changes",
        "-a",
        "prod",
        "--kind",
        "updated",
        "--resource",
        "acc_1:ec2-instance:web-1",
        "--last",
        "1w",
        "--limit",
        "900",
      ),
    ).toBe(0);
    expect(out.stdout).toMatchInlineSnapshot(`
      "Acme · 3 of 7 events, newest first

      WHEN                 RESOURCE  TYPE              ACCOUNT  WHAT CHANGED                 
      2026-11-08 09:30  ~  web-1     aws/ec2-instance  prod     size, tags, region and 1 more
      2026-11-08 09:30  +  web-2     aws/ec2-instance  prod     Appeared                     
      2026-11-08 09:30  -  old       aws/ec2-instance  —        Disappeared                  

      2026-11-08 09:30 web-1
      size    t3.small → t3.large
      tags    {"env":"dev"} → —
      region  us-east-1 → us-east-2
      ami     ami-1 → ami-2

      Pass --limit to see further back.
      "
    `);
  });

  it("passes --from/--to through, and anchors --days on --to", async () => {
    serveRoutes(out, {
      "GET /changes?page=1&pageSize=50&from=2026-10-01&to=2026-10-31": { entries: [], total: 0 },
      "GET /changes?page=1&pageSize=50&from=2026-10-28T00%3A00%3A00.000Z&to=2026-10-31": {
        entries: [],
        total: 0,
      },
    });
    expect(await run("changes", "--from", "2026-10-01", "--to", "2026-10-31")).toBe(0);
    out.stdout = "";
    expect(await run("changes", "--days", "3", "--to", "2026-10-31")).toBe(0);
    expect(out.stdout).toMatchInlineSnapshot(`
      "No changes recorded for this filter. Events start accumulating once the poller has synced an account at least twice.
      "
    `);
  });

  it("refuses a bad --to, a bad --kind and --local", async () => {
    serveRoutes(out, {});
    expect(await run("changes", "--days", "3", "--to", "soon")).toBe(2);
    out.stderr = "";
    expect(await run("changes", "--local")).toBe(1);
    out.stderr = "";
    expect(await run("changes", "--kind", "moved")).toBe(2);
    expect(out.stderr).toContain('--kind must be one of created, updated, deleted (got "moved").');
  });
});

// ---------------------------------------------------------------------------
// moment
// ---------------------------------------------------------------------------

const momentEvent = (id: string, ts: string, over: Record<string, unknown> = {}) => ({
  id,
  feed: "changes",
  kind: "change.updated",
  timestamp: ts,
  title: `${id} changed`,
  severity: "info",
  ...over,
});

const MOMENT = {
  at: "2026-11-08T03:14:00.000Z",
  from: "2026-11-08T02:14:00.000Z",
  to: "2026-11-08T04:14:00.000Z",
  windowMinutes: 60,
  generatedAt: "2026-11-08T12:00:00.000Z",
  feeds: [
    { feed: "changes", status: "ok" },
    { feed: "workflowRuns", status: "error", error: "timeout" },
    { feed: "audit", status: "omitted" },
    { feed: "costAnomalies", status: "ok", truncated: true },
  ],
  events: [
    momentEvent("a", "2026-11-08T03:00:00.000Z", { resourceId: "r1", resourceName: "db-1" }),
    momentEvent("b", "2026-11-08T03:02:00.000Z", { resourceId: "r1", resourceName: "db-1" }),
    momentEvent("c", "2026-11-08T03:04:00.000Z", {
      resourceId: "r1",
      resourceName: "db-1",
      severity: "critical",
      detail: "size",
    }),
    momentEvent("d", "2026-11-08T03:20:00.000Z", {
      feed: "deployments",
      kind: "deployment.failed",
      severity: "warning",
      title: "Deploy api failed",
    }),
  ],
  incidents: [
    {
      id: "i1",
      pluginId: "aws",
      pluginName: "AWS",
      title: "EC2 degraded",
      impact: "minor",
      startedAt: "2026-11-08T03:10:00.000Z",
      resolvedAt: null,
      url: "https://status.aws/1",
    },
  ],
};

describe("moment", () => {
  it("prints the merged window around a timestamp", async () => {
    serveRoutes(out, { "GET /moment?at=2026-11-08T03%3A14%3A00.000Z&window=60": MOMENT });
    expect(await run("moment", "2026-11-08", "03:14Z", "-w", "1h")).toBe(0);
    expect(out.stdout).toMatchInlineSnapshot(`
      "Acme · 2026-11-08 02:14:00 → 2026-11-08 04:14:00 UTC (±60m around 2026-11-08 03:14:00)
        Workflow runs unavailable, timeout
        Audit log omitted: your role lacks its read permission
        Cost anomalies truncated: more events than the window returns

      Provider incidents overlapping this window
        ▲ AWS: EC2 degraded (active) https://status.aws/1

        03:00:00 ┌ 3 events on db-1
          03:00:00 · [Resource changes] a changed
          03:02:00 · [Resource changes] b changed
          03:04:00 ✗ [Resource changes] c changed (size)
        03:20:00 ! [Deployments] Deploy api failed (during AWS incident)

      4 events. Recentre with \`infrawrench moment <timestamp>\`, zoom with --window 15m|1h|6h.
      "
    `);
    out.stdout = "";
    expect(await run("moment", "2026-11-08T03:14:00Z", "--window", "1h", "--json")).toBe(0);
    expect(out.stdout).toBe(pretty({ org: "org_1", ...MOMENT }));
  });

  it("says when the window is empty", async () => {
    serveRoutes(out, { "GET /moment": { ...MOMENT, feeds: [], events: [], incidents: [] } });
    expect(await run("moment", "now")).toBe(0);
    expect(out.stdout).toMatchInlineSnapshot(`
      "Acme · 2026-11-08 02:14:00 → 2026-11-08 04:14:00 UTC (±60m around 2026-11-08 03:14:00)

      Nothing recorded in this window. Try a wider one: --window 6h.
      "
    `);
  });

  it("refuses a bad timestamp, a bad window and --local", async () => {
    expect(await run("moment", "yesterday-ish")).toBe(2);
    out.stderr = "";
    expect(await run("moment", "--local")).toBe(1);
    out.stderr = "";
    expect(await run("moment", "-w", "1y")).toBe(2);
    expect(out.stderr).toContain('Invalid duration "1y": use forms like 30m, 6h, 7d, 2w');
  });
});

// ---------------------------------------------------------------------------
// metrics
// ---------------------------------------------------------------------------

const SERIES = [
  {
    label: "CPU %",
    unit: "%",
    points: [
      { timestamp: 1, value: 10 },
      { timestamp: 2, value: 55 },
      { timestamp: 3, value: 30 },
    ],
  },
  { label: "Network in", unit: "B/s", points: [{ timestamp: 1, value: 2048 }] },
  { label: "Empty", points: [] },
];

describe("metrics", () => {
  const ID = "acc_1:ec2-instance:i-1";
  const path = "POST /resources/aws/ec2-instance/metrics";

  it("charts a cloud resource's series", async () => {
    serveRoutes(out, { "GET /accounts": ACCOUNTS, [path]: { series: SERIES } });
    expect(
      await run("metrics", ID, "--from", "2026-11-08T00:00:00Z", "--to", "2026-11-08T06:00:00Z"),
    ).toBe(0);
    // The time axis is in the machine's locale and zone: left out.
    const lines = out.stdout.split("\n");
    const withoutAxis = lines.filter(
      (_, i) => !(lines[i - 1]?.includes("└") || lines[i - 1]?.includes("(no data points)")),
    );
    expect(withoutAxis.join("\n")).toMatchInlineSnapshot(`
      "CPU % min 10.0 %  max 55.0 %  now 30.0 %
      55.0 % ┤ █ 
             ┤ █ 
             ┤ █ 
      27.5 % ┤ █▇
             ┤ ██
             ┤▂██
      0.00 % ┤███
             └──────────────────────────────────────────────────────────────────

      Network in min 2048 B/s  max 2048 B/s  now 2048 B/s
      2048 B/s ┤█
               ┤█
               ┤█
      1024 B/s ┤█
               ┤█
               ┤█
      0.00 B/s ┤█
               └──────────────────────────────────────────────────────────────────

      Empty
      (no data points)
      "
    `);
  });

  it("filters by --series and prints JSON", async () => {
    serveRoutes(out, { "GET /accounts": ACCOUNTS, [path]: { series: SERIES } });
    expect(await run("metrics", ID, "--series", "cpu", "--last", "6h", "--json")).toBe(0);
    expect(out.stdout).toBe(
      pretty({
        resourceId: ID,
        startMs: NOW.getTime() - 6 * 3_600_000,
        endMs: NOW.getTime(),
        series: [SERIES[0]],
      }),
    );
    out.stdout = "";
    expect(await run("metrics", ID, "--series", "disk")).toBe(0);
    expect(out.stdout).toMatchInlineSnapshot(`
      "No series matches "disk". Available: CPU %, Network in, Empty
      "
    `);
  });

  it("reads a local resource live", async () => {
    local.fetchLocalMetricSeries.mockResolvedValue([]);
    expect(await run("metrics", "loc_1:droplet:42", "--local")).toBe(0);
    expect(out.stdout).toMatchInlineSnapshot(`
      "No metric points. The provider reported nothing for this resource and range.
      "
    `);
  });

  it("refuses a missing or malformed id, bad dates and an unknown account", async () => {
    serveRoutes(out, { "GET /accounts": ACCOUNTS });
    expect(await run("metrics")).toBe(1);
    out.stderr = "";
    expect(await run("metrics", "nope")).toBe(1);
    out.stderr = "";
    expect(await run("metrics", ID, "--from", "whenever")).toBe(1);
    out.stderr = "";
    expect(await run("metrics", "acc_9:ec2-instance:i-1")).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// graph
// ---------------------------------------------------------------------------

const node = (id: string, name: string, type: string) => ({
  id,
  displayName: name,
  pluginId: "aws",
  pluginDisplayName: "AWS",
  pluginLogoSvg: "",
  resourceTypeId: type,
  resourceTypeLabel: type,
  accountId: "acc_1",
  accountName: "prod",
});

const GRAPH = {
  nodes: [
    node("lb", "edge-lb", "Load balancer"),
    node("web", "web-1", "Instance"),
    node("db", "db-1", "Database"),
    node("vpc", "main", "VPC"),
    node("lonely", "lonely", "Bucket"),
  ],
  edges: [
    {
      consumerResourceId: "lb",
      consumerFieldKey: "targets",
      providerResourceId: "web",
      providerOutputKey: "id",
      kind: "declared",
      label: "routes to",
    },
    {
      consumerResourceId: "web",
      consumerFieldKey: "dbHost",
      providerResourceId: "db",
      providerOutputKey: "endpoint",
    },
    {
      consumerResourceId: "web",
      consumerFieldKey: "vpcId",
      providerResourceId: "vpc",
      providerOutputKey: "id",
      kind: "containment",
    },
  ],
  truncated: true,
};

// ---------------------------------------------------------------------------
// search and starred
// ---------------------------------------------------------------------------

const hit = (over: Record<string, unknown>) => ({
  id: "acc_1:ec2-instance:i-1",
  pluginId: "aws",
  pluginDisplayName: "AWS",
  pluginLogoSvg: "",
  resourceTypeId: "ec2-instance",
  resourceTypeLabel: "EC2 instance",
  accountId: "acc_1",
  accountName: "prod",
  displayName: "web-1",
  ...over,
});

const HITS = [
  hit({ kind: "resource" }),
  hit({
    id: "wf_1",
    pluginId: "__workflows__",
    resourceTypeId: "workflow",
    resourceTypeLabel: "Workflow",
    accountId: "",
    accountName: "",
    displayName: "Nightly backup",
    subtitle: "Runs at 02:00",
  }),
  hit({
    id: "rep_1",
    kind: "cost_report",
    pluginId: "__objects__",
    resourceTypeId: "cost_report",
    resourceTypeLabel: "Cost report",
    accountId: "",
    accountName: "",
    displayName: "Web spend",
  }),
];

const STARRED = {
  items: [{ ...HITS[2], kind: "cost_report", starredAt: "2026-11-01T00:00:00.000Z" }],
};

describe("search", () => {
  it("prints hits as text and JSON", async () => {
    serveRoutes(out, { "GET /search?q=web+spend&kinds=all": HITS });
    expect(await run("search", "web", "spend")).toBe(0);
    expect(out.stdout).toMatchInlineSnapshot(`
      "KIND         NAME            DETAIL               OPEN                                                                                                 
      Resource     web-1           EC2 instance · prod  http://localhost:3000/org/org_1/resources/aws/ec2-instance/acc_1%3Aec2-instance%3Ai-1?accountId=acc_1
      Workflow     Nightly backup  Runs at 02:00        http://localhost:3000/org/org_1/workflows/wf_1                                                       
      Cost report  Web spend                            http://localhost:3000/org/org_1/cost-reports/rep_1                                                   
      "
    `);
    out.stdout = "";
    expect(await run("search", "web spend", "--json")).toBe(0);
  });

  it("narrows by kind, and says when nothing matches", async () => {
    serveRoutes(out, { "GET /search?q=zzz&kinds=cost_report%2Cslo": [] });
    expect(await run("search", "zzz", "--kind", "cost_report, slo")).toBe(0);
    expect(out.stdout).toMatchInlineSnapshot(`
      "Nothing you can open matches "zzz".
      "
    `);
  });

  it("refuses an empty query, an unknown kind and --local", async () => {
    expect(await run("search")).toBe(2);
    out.stderr = "";
    expect(await run("search", "x", "--kind", "slo,widgets")).toBe(2);
    out.stderr = "";
    expect(await run("search", "x", "--local")).toBe(1);
  });
});

describe("starred", () => {
  it("lists stars as text and JSON", async () => {
    serveRoutes(out, { "GET /starred": STARRED });
    expect(await run("starred")).toBe(0);
    expect(out.stdout).toMatchInlineSnapshot(`
      "KIND         NAME       DETAIL  OPEN                                              
      Cost report  Web spend          http://localhost:3000/org/org_1/cost-reports/rep_1
      "
    `);
    out.stdout = "";
    expect(await run("starred", "list", "--json")).toBe(0);
    serveRoutes(out, { "GET /starred": { items: [] } });
    out.stdout = "";
    expect(await run("starred")).toBe(0);
  });

  it("stars and unstars one", async () => {
    serveRoutes(out, {
      "PUT /starred/cost_report/rep_1": { item: STARRED.items[0] },
      "DELETE /starred/cost_report/rep_1": {},
    });
    expect(await run("starred", "add", "cost_report", "rep_1")).toBe(0);
    expect(out.stdout).toBe("Starred Web spend.\n");
    out.stdout = "";
    expect(await run("starred", "add", "cost_report", "rep_1", "--json")).toBe(0);
    out.stdout = "";
    expect(await run("starred", "remove", "cost_report", "rep_1")).toBe(0);
    out.stdout = "";
    expect(await run("starred", "remove", "cost_report", "rep_1", "--json")).toBe(0);
  });

  it("refuses a missing id, an unknown kind and --local", async () => {
    expect(await run("starred", "add", "cost_report")).toBe(2);
    out.stderr = "";
    expect(await run("starred", "remove", "widget", "w1")).toBe(2);
    out.stderr = "";
    expect(await run("starred", "--local")).toBe(1);
  });
});
