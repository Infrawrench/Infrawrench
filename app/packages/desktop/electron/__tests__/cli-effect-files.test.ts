import { mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

// `network-reports`, `k8s-efficiency`, `resource-reports`, `recordings`,
// `dashboards`, `canvas`, `reports` and `compliance` on effect/cli: the
// commands that write files (`--format`, `--out`, `--file`). Text and `--json`
// output, the files they write, refusals and exit codes, against fixtures,
// pinned in `__snapshots__/cli-effect-files.test.ts.snap`. Nothing reaches a
// network or a database; files land in a temporary working directory.
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

const NOW = new Date("2026-11-08T12:00:00.000Z");
beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
});
afterEach(() => {
  vi.useRealTimers();
});

let dir = "";
let cwd = "";
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "iw-cli-files-"));
  cwd = process.cwd();
  process.chdir(dir);
});
afterAll(() => {
  process.chdir(cwd);
  rmSync(dir, { recursive: true, force: true });
});

const read = (name: string) => readFileSync(join(dir, name), "utf8");
const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
const withTz = (path: string) => (tz ? `${path}?tz=${encodeURIComponent(tz)}` : path);

/** {@link run} with the capture cleared first, so each assertion sees one command's output. */
async function run_(...argv: string[]): Promise<number> {
  out.stdout = "";
  out.stderr = "";
  return run(...argv);
}

/**
 * Run one line and pin what it did: the exit code, both streams and the
 * requests it made. The snapshots were first proved byte-identical to the
 * legacy commands' output on these fixtures, through copies of the modules
 * they replaced.
 */
async function same(argv: string[], code: number) {
  const from = out.requests.length;
  expect(await run_(...argv)).toBe(code);
  const here = (text: string) => text.replaceAll(realpathSync(dir), "<cwd>");
  expect({
    stdout: here(out.stdout),
    stderr: here(out.stderr),
    // The PDF routes carry the machine's zone, which is the test runner's.
    requests: out.requests.slice(from).map((r) => (tz ? r.replace(withTz(""), "?tz=<zone>") : r)),
  }).toMatchSnapshot(`${code} $ infrawrench ${argv.join(" ")}`);
}

// ---------------------------------------------------------------------------
// network-reports
// ---------------------------------------------------------------------------

const zeroTotals = {
  bytes: 0,
  estimatedCost: 0,
  sampledBytes: 0,
  sampledCost: 0,
  unattributedBytes: 0,
  truncatedBytes: 0,
};
const figures = { ...zeroTotals, bytes: 2e9, estimatedCost: 0.18, sampledBytes: 5e8 };

const FLOW_REPORT = {
  id: "nr1",
  name: "Egress by VPC",
  description: null,
  config: {
    version: 1,
    dateRange: { kind: "relative", preset: "30d" },
    granularity: "daily",
    groupBy: "network",
    filters: {},
    metric: "both",
  },
  folderId: null,
  createdByUserId: null,
  createdAt: "2026-10-01T00:00:00.000Z",
  updatedAt: "2026-10-01T00:00:00.000Z",
};

const endpoint = (ref: string, label: string) => ({
  ref,
  label,
  zone: "us-east-1a",
  region: "us-east-1",
  service: "",
  resourceTypeId: "",
  network: "vpc-1",
});

const FLOW_RUN = {
  reportId: "nr1",
  name: "Egress by VPC",
  from: "2026-10-01",
  to: "2026-10-02",
  granularity: "daily",
  groupBy: "network",
  metric: "both",
  estimated: true,
  buckets: ["2026-10-01", "2026-10-02"],
  series: [
    {
      id: "vpc-1|USD",
      groupKey: "vpc-1",
      label: "vpc-1",
      currency: "USD",
      points: [
        { bucket: "2026-10-01", ...figures },
        { bucket: "2026-10-02", ...zeroTotals, bytes: 1e9 },
      ],
      total: figures,
    },
  ],
  overall: [
    {
      id: "|USD",
      groupKey: "",
      label: "",
      currency: "USD",
      points: [
        { bucket: "2026-10-01", ...figures },
        { bucket: "2026-10-02", ...zeroTotals, bytes: 1e9 },
      ],
      total: figures,
    },
  ],
  groups: [{ groupKey: "vpc-1", label: "vpc-1", currency: "USD", pairCount: 3, ...figures }],
  groupCount: 2,
  topTalkers: [
    {
      source: endpoint("i-1", "web-1"),
      destination: endpoint("internet", "Internet"),
      scope: "internet_egress",
      direction: "egress",
      attribution: "resolved",
      bytes: 2e9,
      packets: 100,
      estimatedCost: 0.18,
      currency: "USD",
      accountId: "acc_1",
      accountName: "prod",
      pluginId: "aws",
      days: 2,
      sampled: true,
    },
  ],
  sampledPluginIds: ["aws"],
  notices: ["sampled_sources"],
};

const flowRoutes = {
  "GET /network-flows/reports": [FLOW_REPORT],
  "POST /network-flows/reports/nr1/run": FLOW_RUN,
};

describe("network-reports", () => {
  it("lists, runs, and prints --json like the legacy command", async () => {
    serveRoutes(out, flowRoutes);
    await same(["network-reports"], 0);
    await same(["network-reports", "--json"], 0);
    await same(["network-reports", "egress"], 0);
    await same(["network-reports", "Egress", "by", "VPC", "--json"], 0);
    await same(["network-reports", "nope"], 1);
    await same(["network-reports", "egress", "--local"], 1);
  });

  it("writes both CSVs to stdout and to --out/--file", async () => {
    serveRoutes(out, flowRoutes);
    await same(["network-reports", "egress", "--format", "csv"], 0);
    await same(["network-reports", "egress", "--format", "pairs-csv"], 0);
    await same(["network-reports", "egress", "--format", "csv", "--out", "series.csv"], 0);
    const written = read("series.csv");
    expect(written.startsWith('"bucket","group"')).toBe(true);
    await same(["network-reports", "egress", "--format", "pairs-csv", "-f", "pairs.csv"], 0);
    expect(read("pairs.csv")).toContain('"web-1"');
  });

  it("renders the other groupings and metrics like the legacy command", async () => {
    const run = (extra: Record<string, unknown>) => ({ ...FLOW_RUN, ...extra });
    const groups = [
      { groupKey: "internet_egress", label: "", currency: "USD", pairCount: 1, ...figures },
      { groupKey: "__other__", label: "", currency: "USD", pairCount: 2, ...zeroTotals },
    ];
    const sources = [
      { groupKey: "infrawrench:truncated", label: "", currency: "USD", pairCount: 0, ...figures },
      {
        groupKey: "infrawrench:unattributed",
        label: "",
        currency: "USD",
        pairCount: 0,
        ...figures,
      },
      { groupKey: "i-1", label: "web-1", currency: "USD", pairCount: 1, ...figures },
    ];
    serveRoutes(out, {
      "GET /network-flows/reports": [
        FLOW_REPORT,
        { ...FLOW_REPORT, id: "nr2", name: "Classes" },
        { ...FLOW_REPORT, id: "nr3", name: "Sources" },
        { ...FLOW_REPORT, id: "nr4", name: "Flat" },
      ],
      "POST /network-flows/reports/nr2/run": run({
        groupBy: "traffic_class",
        metric: "cost",
        groups,
        groupCount: 2,
      }),
      "POST /network-flows/reports/nr3/run": run({
        groupBy: "source",
        metric: "bytes",
        groups: sources,
        groupCount: 3,
        notices: [],
      }),
      "POST /network-flows/reports/nr4/run": run({ groupBy: "none", groups: [], topTalkers: [] }),
    });
    await same(["network-reports", "classes"], 0);
    await same(["network-reports", "sources"], 0);
    await same(["network-reports", "flat"], 0);
    await same(["network-reports", "flat", "--format", "csv"], 0);
  });

  it("refuses an unknown format with the legacy sentence", async () => {
    serveRoutes(out, flowRoutes);
    expect(await run_("network-reports", "egress", "--format", "xml")).toBe(2);
    expect(out.stderr).toContain("--format takes csv or pairs-csv for network flow reports.");
    expect(out.requests).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// k8s-efficiency
// ---------------------------------------------------------------------------

const k8sFigures = (total: number) => ({
  total,
  used: total / 2,
  unused: total / 4,
  unmeasured: 0,
  idle: total / 8,
  overhead: total / 8,
  allocated: total,
  efficiency: 0.5,
  measuredShare: 0.9,
});

const K8S_REPORT = {
  id: "k1",
  name: "Namespaces",
  description: null,
  config: {
    version: 1,
    dateRange: { kind: "relative", preset: "30d" },
    granularity: "day",
    filters: [],
    groupBy: "namespace",
    idle: "separate",
    basis: "total",
  },
  folderId: null,
  createdByUserId: null,
  createdAt: "2026-10-01T00:00:00.000Z",
  updatedAt: "2026-10-01T00:00:00.000Z",
};

const K8S_RESULT = {
  from: "2026-10-10",
  to: "2026-11-08",
  granularity: "day",
  groupBy: "namespace",
  idle: "separate",
  basis: "total",
  buckets: ["2026-10-10"],
  includesLegacyRows: true,
  currencies: [
    {
      currency: "USD",
      totals: k8sFigures(800),
      categories: [
        { category: "cpu", figures: k8sFigures(500) },
        { category: "memory", figures: k8sFigures(300) },
      ],
      points: [],
      rows: [
        {
          key: "default",
          kind: "group",
          label: "default",
          figures: k8sFigures(600),
          categories: [],
          points: [],
        },
        {
          key: "idle",
          kind: "idle",
          label: "",
          figures: k8sFigures(200),
          categories: [],
          points: [],
        },
      ],
    },
  ],
};

const k8sRoutes = {
  "GET /k8s-efficiency-reports": [K8S_REPORT],
  "POST /k8s-efficiency-reports/k1/run": { reportId: "k1", name: "Namespaces", result: K8S_RESULT },
  "POST /k8s-efficiency-reports/query": K8S_RESULT,
  "GET /k8s-efficiency-reports/k1/export?format=csv&perPeriod=true": new RawResponse(
    200,
    "currency,period,group\nUSD,2026-10,default\n",
  ),
};

describe("k8s-efficiency", () => {
  it("lists, runs, queries ad hoc and exports like the legacy command", async () => {
    serveRoutes(out, k8sRoutes);
    await same(["k8s-efficiency"], 0);
    await same(["k8s-efficiency", "--json"], 0);
    await same(["k8s-efficiency", "namespaces"], 0);
    await same(["k8s-efficiency", "namespaces", "--json"], 0);
    await same(["k8s-efficiency", "--group-by", "namespace", "--last", "7d"], 0);
    await same(["k8s-efficiency", "--group-by", "tag:team", "--basis", "allocated", "--json"], 0);
    await same(["k8s-efficiency", "--group-by", "namespace", "--basis", "cash"], 1);
    await same(
      ["k8s-efficiency", "--group-by", "workload", "--from", "2026-10-01", "--to", "2026-10-31"],
      0,
    );
    await same(["k8s-efficiency", "--format", "csv"], 1);
    await same(["k8s-efficiency", "--group-by", "namespace", "--format", "csv"], 1);
    await same(["k8s-efficiency", "namespaces", "--format", "csv"], 0);
    await same(["k8s-efficiency", "namespaces", "--format", "csv", "--out", "k8s.csv"], 0);
    expect(read("k8s.csv")).toBe("currency,period,group\nUSD,2026-10,default\n");
    await same(["k8s-efficiency", "nope"], 1);
    await same(["k8s-efficiency", "--local"], 1);
  });
});

// ---------------------------------------------------------------------------
// resource-reports
// ---------------------------------------------------------------------------

const RESOURCE_REPORT = {
  id: "rr1",
  name: "Untagged EC2",
  description: "Instances without an owner tag",
  config: {
    version: 1,
    filters: {
      pluginIds: ["aws"],
      accountIds: [],
      resourceTypes: [],
      regions: ["us-east-1"],
      statuses: [],
      tags: [{ source: "tag", key: "owner", op: "missing", values: [] }],
      nameContains: null,
      createdFrom: null,
      createdTo: null,
    },
    columns: ["core:name", "core:created", "cost:range"],
    sort: null,
    costRange: { kind: "relative", preset: "30d" },
    costBasis: "cash",
    pageSize: 50,
  },
  folderId: "f1",
  createdByUserId: null,
  createdAt: "2026-10-01T00:00:00.000Z",
  updatedAt: "2026-10-01T00:00:00.000Z",
};

const RESOURCE_ROWS = {
  columns: [
    { id: "core:name", kind: "core", key: "name", label: "Name" },
    { id: "core:created", kind: "core", key: "created", label: "Created" },
    { id: "cost:range", kind: "cost", key: "range", label: "Accrued cost" },
  ],
  rows: [
    {
      id: "r1",
      accountId: "acc_1",
      pluginId: "aws",
      resourceTypeId: "ec2",
      values: { "core:name": "web-1", "core:created": "2026-01-02T03:04:05Z" },
      costs: { "cost:range": [{ currency: "USD", amount: 12.5 }] },
    },
    {
      id: "r2",
      accountId: "acc_1",
      pluginId: "aws",
      resourceTypeId: "ec2",
      values: { "core:name": "web-2", "core:created": null },
      costs: {},
    },
  ],
  total: 120,
  offset: 0,
  limit: 2,
  truncated: false,
  sort: { column: "core:name", direction: "asc" },
  cost: {
    available: true,
    reason: null,
    basis: "cash",
    windows: [{ window: "range", from: "2026-10-10", to: "2026-11-08" }],
  },
};

const resourceRoutes = {
  "GET /resource-reports": [RESOURCE_REPORT],
  "GET /resource-reports/folders": [
    { id: "f1", name: "Hygiene", parentFolderId: null, createdAt: "x", updatedAt: "x" },
  ],
  "GET /resource-reports/rr1/rows": RESOURCE_ROWS,
  "GET /resource-reports/rr1/rows?offset=2&limit=2&sort=core%3Aname&direction=desc": RESOURCE_ROWS,
  "GET /resource-reports/rr1/csv": new RawResponse(200, "Name,Cost\nweb-1,12.50\n"),
};

describe("resource-reports", () => {
  it("lists, runs a page, and exports like the legacy command", async () => {
    serveRoutes(out, resourceRoutes);
    await same(["resource-reports"], 0);
    await same(["resource-reports", "--json"], 0);
    await same(["resource-reports", "untagged"], 0);
    await same(["resource-reports", "untagged", "--json"], 0);
    await same(
      [
        "resource-reports",
        "untagged",
        "--offset",
        "2",
        "--limit",
        "2",
        "--sort",
        "core:name",
        "--desc",
      ],
      0,
    );
    await same(["resource-reports", "untagged", "--format", "csv"], 0);
    await same(["resource-reports", "untagged", "--format", "csv", "--out", "rr.csv"], 0);
    expect(read("rr.csv")).toBe("Name,Cost\nweb-1,12.50\n");
    await same(["resource-reports", "nothing"], 1);
    await same(["resource-reports", "--local"], 1);
  });

  it("keeps the list when the folders cannot be read", async () => {
    serveRoutes(out, { "GET /resource-reports": [RESOURCE_REPORT] });
    await same(["resource-reports"], 0);
  });

  it("refuses a bad --format and --offset in the legacy words", async () => {
    serveRoutes(out, resourceRoutes);
    expect(await run_("resource-reports", "untagged", "--format", "xlsx")).toBe(2);
    expect(out.stderr).toContain('--format must be csv for resource reports, got "xlsx".');
    expect(await run_("resource-reports", "untagged", "--offset", "-1")).toBe(2);
    expect(out.stderr).toContain('--offset must be a whole number from 0 to 100000000, got "-1"');
  });
});

// ---------------------------------------------------------------------------
// recordings
// ---------------------------------------------------------------------------

const RECORDING = {
  id: "rec_12345678abc",
  userId: "u1",
  userName: "Ada",
  accountId: null,
  resourceId: null,
  host: "10.0.0.5",
  port: 22,
  username: "ubuntu",
  hopCount: 0,
  cols: 80,
  rows: 24,
  hasInput: false,
  status: "complete",
  outputBytes: 20480,
  eventCount: 10,
  startedAt: "2026-11-01T10:00:00.000Z",
  endedAt: "2026-11-01T10:04:12.000Z",
  durationMs: 252_000,
};

const CAST = '{"version":2,"width":80,"height":24}\n[0.1,"o","hello"]\n';

const recordingRoutes = {
  "GET /session-recordings": [
    RECORDING,
    { ...RECORDING, id: "rec_api", userName: null, status: "recording", durationMs: null },
  ],
  "GET /session-recordings/settings": {
    enabled: false,
    captureInput: false,
    retentionDays: 90,
    usage: { recordingCount: 2, storedBytes: 40960, capturedBytes: 40960 },
  },
  "GET /session-recordings/rec_1/cast?download=1": new RawResponse(200, CAST),
};

describe("recordings", () => {
  it("lists, and passes the asciicast through or to --file", async () => {
    serveRoutes(out, recordingRoutes);
    await same(["recordings"], 0);
    await same(["recordings", "list", "--json"], 0);
    await same(["recordings", "get", "rec_1"], 0);
    expect(out.stdout).toBe(CAST);
    await same(["recordings", "get", "rec_1", "--file", "s.cast"], 0);
    expect(read("s.cast")).toBe(CAST);
    await same(["recordings", "get"], 1);
  });
});

// ---------------------------------------------------------------------------
// dashboards
// ---------------------------------------------------------------------------

const schedule = (id: string, extra: Record<string, unknown> = {}) => ({
  id,
  cadence: "weekly",
  sendDay: 1,
  sendDayOfMonth: 1,
  hour: 8,
  timezone: "UTC",
  slackChannelIds: ["C1"],
  teamsWebhookIds: [],
  emailRecipients: ["a@example.com", "b@example.com"],
  enabled: true,
  nextSendAt: null,
  lastSentAt: null,
  lastStatus: "succeeded",
  lastError: null,
  createdByUserId: null,
  createdAt: "2026-10-01T00:00:00.000Z",
  updatedAt: "2026-10-01T00:00:00.000Z",
  ...extra,
});

const DASHBOARDS = [
  { id: "d1", name: "Finance", isDefault: false, isResolvedDefault: true },
  { id: "d2", name: "Home", isDefault: true },
];

const kpiWidget = (id: string, gridX: number, title: string, source: unknown) => ({
  id,
  dashboardId: "d1",
  kind: "kpi",
  title,
  config: { version: 1, source, comparePreviousPeriod: true },
  gridX,
  gridY: 0,
  gridW: 3,
  gridH: 2,
});

const PDF = "%PDF-1.7\nfake pdf bytes\n";

const dashboardRoutes = {
  "GET /dashboards": DASHBOARDS,
  "GET /dashboard-notifications": [
    { ...schedule("n1"), dashboardId: "d1", attachPdf: true },
    { ...schedule("n2", { lastStatus: "failed" }), dashboardId: "d1", attachPdf: false },
  ],
  "GET /dashboards/default": {
    dashboardId: "d1",
    dashboardName: "Finance",
    source: "role",
    userDefaultDashboardId: null,
    roleDefault: { roleId: "r1", roleName: "Finance", dashboardId: "d1" },
    orgDefaultDashboardId: "d2",
    skipped: ["user"],
  },
  "GET /dashboards/d1": {
    id: "d1",
    widgets: [
      kpiWidget("w2", 3, "", {
        kind: "cost_report",
        reportId: "r1",
        measure: "cost",
        aggregation: "daily_average",
      }),
      kpiWidget("w1", 0, "Budget left", { kind: "budget", budgetId: "b1", measure: "remaining" }),
      { ...kpiWidget("w3", 6, "Notes", null), kind: "text" },
    ],
  },
  // A percentage: client-core formats money in the machine's locale, and the
  // snapshot must not depend on the runner's.
  "POST /dashboards/kpi": {
    value: 41,
    unit: "percent",
    previous: 36,
    change: 5,
    changePercent: 13.9,
    upIsGood: false,
    from: "2026-10-10",
    to: "2026-11-08",
  },
  "GET /dashboards/d1/notifications": [
    { ...schedule("n1"), dashboardId: "d1", attachPdf: true },
    {
      ...schedule("n2", {
        lastStatus: "failed",
        lastError: "channel_not_found",
        cadence: "monthly",
      }),
      dashboardId: "d1",
      attachPdf: false,
    },
  ],
  [`GET ${withTz("/dashboards/d1/pdf")}`]: new RawResponse(200, PDF),
  "POST /dashboards/d1/notifications/n1/send": {
    attempted: 3,
    succeeded: 3,
    slack: { attempted: 1, succeeded: 1 },
    teams: { attempted: 0, succeeded: 0 },
    email: { attempted: 2, succeeded: 2 },
    pdfAttached: true,
    slackFilesUploaded: 0,
  },
  "POST /dashboards/d1/notifications/n2/send": new RawResponse(502, "slack down"),
};

describe("dashboards", () => {
  it("lists, shows one, and prints --json like the legacy command", async () => {
    serveRoutes(out, dashboardRoutes);
    await same(["dashboards"], 0);
    await same(["dashboards", "--json"], 0);
    await same(["dashboards", "finance"], 0);
    await same(["dashboards", "finance", "--json"], 0);
    await same(["dashboards", "nope"], 1);
    await same(["dashboards", "--format", "pdf"], 1);
    await same(["dashboards", "--local"], 1);
  });

  it("keeps the list when delivery and the default cannot be read", async () => {
    serveRoutes(out, { "GET /dashboards": DASHBOARDS });
    await same(["dashboards"], 0);
    await same(["dashboards", "finance"], 0);
  });

  it("writes the PDF to its default name and to --out", async () => {
    serveRoutes(out, dashboardRoutes);
    await same(["dashboards", "finance", "--format", "pdf"], 0);
    expect(read("finance.pdf")).toBe(PDF);
    await same(["dashboards", "finance", "--format", "PDF", "--out", "d.pdf", "--json"], 0);
    expect(read("d.pdf")).toBe(PDF);
    await same(["dashboards", "finance", "--out", "d.pdf"], 1);
  });

  it("sends to each schedule and reports the failures", async () => {
    serveRoutes(out, dashboardRoutes);
    await same(["dashboards", "send", "finance"], 0);
    await same(["dashboards", "send", "finance", "--json"], 0);
    await same(["dashboards", "send"], 1);
  });
});

// ---------------------------------------------------------------------------
// canvas
// ---------------------------------------------------------------------------

const CANVAS = {
  id: "cv1",
  name: "AI spend",
  description: "Model and GPU spend",
  spec: {
    version: 1,
    blocks: [
      { id: "b1", kind: "text", text: "# Overview\nWhat we spend on models." },
      {
        id: "b2",
        kind: "kpi",
        title: "Monthly AI spend",
        metric: { type: "spend", dateRange: { kind: "relative", preset: "30d" }, filters: [] },
      },
      {
        id: "b3",
        kind: "chart",
        title: "By service",
        config: { chartType: "stacked_bar", groupBy: "service" },
      },
      {
        id: "b4",
        kind: "table",
        title: "By account",
        query: { groupBy: "account", binning: "monthly" },
      },
      { id: "b5", kind: "budgets", title: "Budgets" },
      { id: "b6", kind: "anomalies", title: "Spikes", days: 30, limit: 5 },
      { id: "b7", kind: "custom_graph", graphId: "g1" },
      { id: "b8", kind: "cost_report", reportId: "r1" },
    ],
  },
  prompt: "Show me AI spend",
  conversationId: null,
  createdByUserId: null,
  createdAt: "2026-10-01T00:00:00.000Z",
  updatedAt: "2026-11-01T09:00:00.000Z",
  placements: [{ widgetId: "w1", dashboardId: "d1", dashboardName: "Finance" }],
};

const CANVAS_RUN = {
  canvasId: "cv1",
  name: "AI spend",
  ranAt: "2026-11-08T12:00:00.000Z",
  displayCurrency: null,
  blocks: [
    { id: "b1", kind: "text", text: "# Overview\nWhat we spend on models." },
    {
      id: "b2",
      kind: "kpi",
      kpi: {
        value: 4210,
        unit: "money",
        currency: "USD",
        changePercent: 12.5,
        from: "2026-10-10",
        to: "2026-11-08",
        note: "includes credits",
      },
    },
    {
      id: "b3",
      kind: "chart",
      from: "2026-10-10",
      to: "2026-11-08",
      cost: {
        currencies: ["USD"],
        totals: { USD: 300 },
        series: [
          {
            key: "bedrock",
            label: "Bedrock",
            currency: "USD",
            points: [
              { bucket: "2026-11-01", amount: 100 },
              { bucket: "2026-11-02", amount: 200 },
            ],
          },
        ],
      },
    },
    {
      id: "b4",
      kind: "table",
      table: {
        columns: ["2026-09", "2026-10"],
        rows: [{ key: "a", label: "prod", values: [10, 20], total: 30 }],
        currency: "USD",
        otherCurrencies: [],
        from: "2026-09-01",
        to: "2026-10-31",
      },
    },
    {
      id: "b5",
      kind: "budgets",
      budgets: [{ name: "AI", currency: "USD", amountCents: 100000, actualCents: 120000 }],
      missing: [],
    },
    { id: "b6", kind: "anomalies", anomalies: [], withheld: true },
    { id: "b7", kind: "custom_graph", graph: { id: "g1", name: "GPU hours" }, spec: null },
    { id: "b8", kind: "cost_report", report: null, error: "Report was deleted." },
  ],
};

const canvasRoutes = {
  "GET /cost-canvases": [CANVAS],
  "POST /cost-canvases/cv1/run": CANVAS_RUN,
  [`GET ${withTz("/cost-canvases/cv1/pdf")}`]: new RawResponse(200, PDF),
};

describe("canvas", () => {
  it("lists, shows and refreshes like the legacy command", async () => {
    serveRoutes(out, canvasRoutes);
    await same(["canvas"], 0);
    await same(["canvas", "list", "--json"], 0);
    await same(["canvas", "show", "ai"], 0);
    await same(["canvas", "show", "ai", "--json"], 0);
    await same(["canvas", "refresh", "AI", "spend"], 0);
    await same(["canvas", "run", "ai", "--json"], 0);
    await same(["canvas", "ai"], 0);
    await same(["canvas", "show"], 1);
    await same(["canvas", "show", "nope"], 1);
    await same(["canvas", "list", "--format", "pdf"], 1);
    await same(["canvas", "--format", "pdf"], 1);
  });

  it("writes the PDF from show and refresh", async () => {
    serveRoutes(out, canvasRoutes);
    await same(["canvas", "show", "ai", "--format", "pdf"], 0);
    expect(read("ai-spend.pdf")).toBe(PDF);
    await same(["canvas", "ai", "--format", "pdf", "-f", "c.pdf"], 0);
    expect(read("c.pdf")).toBe(PDF);
    await same(["canvas", "refresh", "ai", "--out", "c.pdf"], 1);
  });
});

// ---------------------------------------------------------------------------
// reports
// ---------------------------------------------------------------------------

const costReport = (id: string, name: string, config: Record<string, unknown> = {}) => ({
  id,
  name,
  description: id === "r1" ? "What finance watches" : null,
  config: {
    version: 1,
    chartType: "stacked_bar",
    binning: "daily",
    dateRange: { kind: "relative", preset: "30d" },
    groupBy: "service",
    filters: [],
    topN: 5,
    comparePreviousPeriod: false,
    showForecast: false,
    ...config,
  },
  folderId: id === "r1" ? "f2" : null,
  createdByUserId: null,
  createdAt: "2026-10-01T00:00:00.000Z",
  updatedAt: "2026-10-01T00:00:00.000Z",
  placements: id === "r1" ? [{ widgetId: "w", dashboardId: "d1", dashboardName: "Finance" }] : [],
});

const COST_REPORTS = [
  costReport("r1", "Monthly spend"),
  costReport("r2", "Monthly by account", {
    groupBy: "account",
    dateRange: { kind: "absolute", from: "2026-01-01", to: "2026-03-31" },
  }),
  costReport("r3", "GPU usage", { groupBy: "none" }),
];

const FOLDERS = [
  { id: "f1", name: "Finance", parentFolderId: null, createdAt: "x", updatedAt: "x" },
  { id: "f2", name: "Monthly", parentFolderId: "f1", createdAt: "x", updatedAt: "x" },
];

const runResult = (extra: Record<string, unknown> = {}) => ({
  reportId: "r1",
  name: "Monthly spend",
  from: "2026-10-10",
  to: "2026-11-08",
  result: {
    series: [
      {
        key: "ec2",
        label: "EC2",
        currency: "USD",
        points: [
          { bucket: "2026-11-01", amount: 100 },
          { bucket: "2026-11-02", amount: 150 },
        ],
      },
      {
        key: "__other__",
        label: "Other",
        currency: "USD",
        points: [{ bucket: "2026-11-01", amount: 20 }],
      },
    ],
    currencies: ["USD"],
    totals: { USD: 270 },
    previousTotals: { USD: 200 },
    ...extra,
  },
});

const reportRoutes = {
  "GET /cost-reports": COST_REPORTS,
  "GET /cost-report-folders": FOLDERS,
  "GET /cost-report-notifications": [
    { ...schedule("n1"), costReportId: "r1" },
    { ...schedule("n2", { lastStatus: "no_targets" }), costReportId: "r1" },
    { ...schedule("n3", { cadence: "daily" }), costReportId: "r2" },
  ],
  "POST /cost-reports/r1/run": runResult(),
  "POST /cost-reports/r2/run": runResult({
    xAxis: {
      dimension: "account",
      segment: "dimension",
      values: [
        { key: "a", label: "prod" },
        { key: "b", label: "staging" },
      ],
    },
    series: [
      {
        key: "ec2",
        label: "EC2",
        currency: "USD",
        points: [
          { bucket: "a", amount: 120 },
          { bucket: "b", amount: 30 },
        ],
      },
    ],
  }),
  [`GET ${withTz("/cost-reports/r1/pdf")}`]: new RawResponse(200, PDF),
  "GET /cost-reports/r1/notifications": [schedule("n1"), schedule("n2")],
  "GET /cost-reports/r3/notifications": [],
  "POST /cost-reports/r1/notifications/n1/send": {
    attempted: 2,
    succeeded: 2,
    slack: { attempted: 1, succeeded: 1 },
    teams: { attempted: 0, succeeded: 0 },
    email: { attempted: 1, succeeded: 1 },
  },
  "POST /cost-reports/r1/notifications/n2/send": new RawResponse(500, "boom"),
  "POST /cost-reports/bulk": { action: "move", reports: 1, folders: 1 },
  "GET /cost-report-anomaly-alerts": {
    alerts: [
      {
        id: "a1",
        reportId: "r1",
        reportName: "Monthly spend",
        enabled: true,
        sigmas: 3,
        minDeltaCents: 5000,
        destinations: [{ kind: "slack", channelId: "C1" }, { kind: "push" }],
        createdAt: "x",
        updatedAt: "x",
        lastEvaluatedAt: null,
        lastError: "Slack token expired",
        recent: [
          {
            id: "f1",
            day: "2026-11-01",
            currency: "USD",
            actual: 420,
            baseline: 100,
            threshold: 150,
            notifiedAt: "2026-11-01T09:00:00Z",
            createdAt: "x",
          },
        ],
      },
      {
        id: "a2",
        reportId: "r2",
        reportName: "Monthly by account",
        enabled: false,
        sigmas: 2.5,
        minDeltaCents: 1000,
        destinations: [],
        createdAt: "x",
        updatedAt: "x",
        lastEvaluatedAt: null,
        lastError: null,
        recent: [],
      },
    ],
  },
};

describe("reports", () => {
  it("lists, runs and prints --json like the legacy command", async () => {
    serveRoutes(out, reportRoutes);
    await same(["reports"], 0);
    await same(["reports", "--json"], 0);
    await same(["reports", "monthly", "spend"], 0);
    await same(["reports", "Monthly spend", "--json"], 0);
    await same(["reports", "monthly by account"], 0);
    await same(["reports", "monthly"], 1);
    await same(["reports", "nope"], 1);
    await same(["reports", "--format", "pdf"], 1);
    await same(["reports", "--local"], 1);
  });

  it("keeps the list without the delivery column", async () => {
    serveRoutes(out, {
      "GET /cost-reports": COST_REPORTS,
      "GET /cost-report-folders": FOLDERS,
    });
    await same(["reports"], 0);
  });

  it("sends display overrides and refuses a bad one", async () => {
    serveRoutes(out, reportRoutes);
    await same(["reports", "monthly spend", "--bin", "week", "--cumulative"], 0);
    await same(["reports", "monthly spend", "--measure", "dollars"], 2);
  });

  it("checks a usage measure against the units the org has", async () => {
    serveRoutes(out, {
      ...reportRoutes,
      "GET /costs/dimensions?dimension=usage-units": {
        values: [{ value: "Hrs", label: "Hrs", count: 3 }],
      },
    });
    await same(["reports", "monthly spend", "--measure", "usage"], 2);
    await same(["reports", "monthly spend", "--x-axis", "account", "--json"], 0);
    await same(["reports", "gpu usage", "--measure", "count"], 2);
  });

  it("renders a usage and a count run like the legacy command", async () => {
    serveRoutes(out, {
      ...reportRoutes,
      "POST /cost-reports/r1/run": runResult({ measure: "usage", usageUnit: "Hrs" }),
      "POST /cost-reports/r2/run": runResult({ measure: "count" }),
    });
    await same(["reports", "monthly spend"], 0);
    await same(["reports", "monthly by account"], 0);
  });

  it("fails when every send failed", async () => {
    serveRoutes(out, {
      ...reportRoutes,
      "POST /cost-reports/r1/notifications/n1/send": new RawResponse(500, "boom"),
    });
    await same(["reports", "send", "monthly spend"], 1);
    await same(["reports", "send", "monthly spend", "--json"], 1);
  });

  it("writes the PDF", async () => {
    serveRoutes(out, reportRoutes);
    await same(["reports", "monthly spend", "--format", "pdf"], 0);
    expect(read("monthly-spend.pdf")).toBe(PDF);
    await same(["reports", "monthly spend", "--file", "m.pdf", "--format", "pdf", "--json"], 0);
    await same(["reports", "monthly spend", "--out", "m.pdf"], 1);
  });

  it("sends, moves, deletes and lists anomaly alerts", async () => {
    serveRoutes(out, reportRoutes);
    await same(["reports", "send", "monthly spend"], 0);
    await same(["reports", "send", "monthly spend", "--json"], 0);
    await same(["reports", "send", "gpu"], 1);
    await same(["reports", "send"], 1);
    await same(["reports", "move", "monthly spend", "folder:Monthly", "--folder", "Finance"], 0);
    await same(["reports", "move", "gpu", "--folder", "top", "--json"], 0);
    await same(["reports", "move", "gpu"], 2);
    await same(["reports", "move", "--folder", "top"], 2);
    await same(["reports", "move", "gpu", "--folder", "Nowhere"], 1);
    await same(["reports", "move", "zzz", "--folder", "top"], 1);
    await same(["reports", "delete", "gpu"], 2);
    await same(["reports", "delete", "gpu", "-y"], 0);
    await same(["reports", "delete"], 2);
    await same(["reports", "anomalies"], 0);
    await same(["reports", "anomalies", "--json"], 0);
    await same(["reports", "anomalies", "monthly", "spend"], 0);
    await same(["reports", "anomalies", "gpu"], 0);
  });
});

// ---------------------------------------------------------------------------
// compliance
// ---------------------------------------------------------------------------

const control = (id: string, status: string, extra: Record<string, unknown> = {}) => ({
  id,
  title: `Control ${id}`,
  group: "Access",
  sources: ["access_reviews"],
  status,
  reasons: status === "gaps" ? ["No access review in the period"] : [],
  missingSources: [],
  applicable: status !== "not-applicable",
  justification: null,
  owner: id === "CC6.1" ? { userId: "u1", displayName: "Ada" } : null,
  notes: id === "CC6.2" ? "Quarterly review scheduled" : null,
  settingUpdatedAt: null,
  ...extra,
});

const COMPLIANCE = {
  framework: {
    id: "soc2",
    name: "SOC 2",
    version: "2017 TSC",
    description: "Trust services criteria",
    scopeNote: "",
    controlCount: 3,
  },
  period: { from: "2026-08-10", to: "2026-11-07" },
  controls: [
    control("CC6.1", "evidence"),
    control("CC6.2", "gaps"),
    control("CC9.9", "not-applicable"),
  ],
  sources: [
    {
      sourceId: "access_reviews",
      label: "Access reviews",
      kind: "control",
      status: "present",
      summary: "2 reviews completed",
      metrics: [],
      gaps: [],
      itemCount: 2,
      error: null,
    },
    {
      sourceId: "vulns",
      label: "Vulnerability findings",
      kind: "monitoring",
      status: "unavailable",
      summary: "",
      metrics: [],
      gaps: [],
      itemCount: 0,
      error: "Scanner not connected",
    },
  ],
  counts: { evidence: 1, gaps: 1, notApplicable: 1, total: 3, unowned: 1 },
  generatedAt: "2026-11-08T12:00:00.000Z",
};

const ZIP = "PK\u0003\u0004fake zip";

const complianceRoutes = {
  "GET /compliance?framework=soc2": COMPLIANCE,
  "GET /compliance?framework=iso27001&from=2026-01-01&to=2026-03-31": COMPLIANCE,
  "GET /compliance/frameworks": {
    frameworks: [
      {
        id: "soc2",
        name: "SOC 2",
        version: "2017 TSC",
        description: "Trust services criteria",
        scopeNote: "",
        controlCount: 33,
      },
    ],
  },
  "GET /compliance/pack?framework=soc2&from=2026-08-11&to=2026-11-08": new RawResponse(200, ZIP, {
    "content-disposition": 'attachment; filename="soc2-pack.zip"',
  }),
  "GET /compliance/pack?framework=iso27001&from=2026-01-01&to=2026-03-31": new RawResponse(
    200,
    ZIP,
  ),
};

describe("compliance", () => {
  it("reports status, gaps and frameworks like the legacy command", async () => {
    serveRoutes(out, complianceRoutes);
    await same(["compliance"], 0);
    await same(["compliance", "status", "--json"], 0);
    await same(["compliance", "--gaps"], 0);
    await same(["compliance", "--gaps", "--json"], 0);
    await same(
      ["compliance", "--framework", "ISO27001", "--from", "2026-01-01", "--to", "2026-03-31"],
      0,
    );
    await same(["compliance", "frameworks"], 0);
    await same(["compliance", "frameworks", "--json"], 0);
  });

  it("refuses bad selections in the legacy words", async () => {
    serveRoutes(out, complianceRoutes);
    await same(["compliance", "--framework", "SOC 2"], 2);
    await same(["compliance", "--from", "2026-13-01"], 2);
    await same(["compliance", "--from", "2026-03-01", "--to", "2026-01-01"], 2);
    await same(["compliance", "--last", "30d"], 2);
    await same(["compliance", "--local"], 2);
    await same(["compliance", "frameworks", "--local"], 2);
  });

  it("writes the evidence pack where it was told, or where the server named it", async () => {
    serveRoutes(out, complianceRoutes);
    await same(["compliance", "export"], 0);
    expect(read("soc2-pack.zip")).toBe(ZIP);
    await same(
      [
        "compliance",
        "export",
        "--framework",
        "iso27001",
        "--from",
        "2026-01-01",
        "--to",
        "2026-03-31",
        "--json",
      ],
      0,
    );
    expect(read("iso27001-evidence-2026-01-01-to-2026-03-31.zip")).toBe(ZIP);
    await same(["compliance", "export", "--out", "pack.zip"], 0);
    expect(read("pack.zip")).toBe(ZIP);
  });

  it("refuses a pack that is not a ZIP", async () => {
    serveRoutes(out, {
      "GET /compliance/pack?framework=soc2&from=2026-08-11&to=2026-11-08": new RawResponse(
        200,
        "not a zip",
      ),
    });
    await same(["compliance", "export"], 1);
  });
});

// ---------------------------------------------------------------------------
// values a newer server sends that this build does not know
// ---------------------------------------------------------------------------

describe("unknown values", () => {
  it("network-reports renders them raw and refuses the pairs CSV it cannot write", async () => {
    const run = {
      ...FLOW_RUN,
      granularity: "hourly",
      groupBy: "subnet",
      notices: ["new_notice"],
      groups: [{ ...FLOW_RUN.groups[0], groupKey: "sn-1", label: "sn-1" }],
      topTalkers: [{ ...FLOW_RUN.topTalkers[0], scope: "satellite", direction: "sideways" }],
    };
    serveRoutes(out, {
      "GET /network-flows/reports": [
        { ...FLOW_REPORT, config: { ...FLOW_REPORT.config, metric: "packets" } },
      ],
      "POST /network-flows/reports/nr1/run": run,
    });
    expect(await run_("network-reports")).toBe(0);
    expect(out.stdout).toMatchInlineSnapshot(`
      "REPORT         SHOWS    GRANULARITY  GROUP BY       ID 
      Egress by VPC  packets  Daily        VPC / network  nr1
      "
    `);
    expect(await run_("network-reports", "egress")).toBe(0);
    expect(out.stdout).toMatchInlineSnapshot(`
      "Egress by VPC · 2026-10-01 to 2026-10-02 · hourly · by subnet
        Estimated from flow logs at list prices: it will not match the invoice.
        new_notice

      USD  $0.18 estimated  ·  2.0 GB  ·  25% sampled  ·  100% attributed to a pair
           cost  █▁

      SUBNET  BYTES   EST. COST  PAIRS  SAMPLED
      sn-1    2.0 GB      $0.18      3      25%
        1 more not listed.

      SOURCE  DESTINATION  CLASS      BYTES   EST. COST  DAYS
      web-1   Internet     satellite  2.0 GB     $0.18*     2
      * from a sampled flow source
      "
    `);
    expect(await run_("network-reports", "egress", "--format", "csv")).toBe(0);
    expect(out.stdout).toMatchInlineSnapshot(`
      ""bucket","group","currency","bytes","estimated_cost","sampled_share","unattributed_bytes","outside_top_pairs_bytes"
      "2026-10-01","vpc-1","USD",2000000000,0.18,0.25,0,0
      "2026-10-02","vpc-1","USD",1000000000,0,0,0,0
      "total","vpc-1","USD",2000000000,0.18,0.25,0,0
      "
    `);
    expect(await run_("network-reports", "egress", "--format", "pairs-csv")).toBe(1);
    expect(out.stderr).toMatchInlineSnapshot(`
      "This server reports a flow value this version of the CLI does not know ("satellite"), so it cannot write the pairs CSV. Update the desktop app, or export it from the Network tab.
      "
    `);
  });

  it("k8s-efficiency renders an unknown category and row kind raw", async () => {
    const block = K8S_RESULT.currencies[0];
    serveRoutes(out, {
      ...k8sRoutes,
      "POST /k8s-efficiency-reports/k1/run": {
        reportId: "k1",
        name: "Namespaces",
        result: {
          ...K8S_RESULT,
          includesLegacyRows: false,
          currencies: [
            {
              ...block,
              categories: [{ category: "tpu", figures: k8sFigures(100) }],
              rows: [{ ...block?.rows[1], kind: "reserved", label: "" }],
            },
          ],
        },
      },
    });
    expect(await run_("k8s-efficiency", "namespaces")).toBe(0);
    expect(out.stdout).toMatchInlineSnapshot(`
      "Namespaces · 2026-10-10 → 2026-11-08 · by namespace · efficiency of total cost · idle separate

      $800.00 total · 50% efficient · 90% measured
      used $400.00 · requested, unused $200.00 · unmeasured $0.00 · idle $100.00 · overhead $100.00

      By cost category
      tpu ██████████████████████████████ $100.00 50%

      GROUP     TOTAL    USED     UNUSED  UNMEASURED  IDLE    OVERHEAD  EFFICIENCY
      reserved  $200.00  $100.00  $50.00       $0.00  $25.00    $25.00         50%
      "
    `);
  });

  it("recordings shows a status it does not know as is", async () => {
    serveRoutes(out, {
      ...recordingRoutes,
      "GET /session-recordings": [{ ...RECORDING, status: "archived" }],
    });
    expect(await run_("recordings")).toBe(0);
    expect(out.stdout).toMatchInlineSnapshot(`
      "Session recording is off for this organization. Turn it on in Settings → Session Recordings.

      Acme · 2 recordings, 40 KB stored, kept 90d

      ID        STARTED            WHO  TARGET           DURATION  SIZE   STATUS  
      rec_1234  2026-11-01 10:00Z  Ada  ubuntu@10.0.0.5  4m 12s    20 KB  archived

      infrawrench recordings get <id> | asciinema play -   (or --file out.cast to save it)
      "
    `);
  });

  it("dashboards names an unknown KPI source and shows an unknown unit's number", async () => {
    serveRoutes(out, {
      ...dashboardRoutes,
      "GET /dashboards/d1": {
        id: "d1",
        widgets: [
          kpiWidget("w1", 0, "", { kind: "forecast_accuracy" }),
          kpiWidget("w2", 1, "", { kind: "budget", budgetId: "b1", measure: "burn_rate" }),
          kpiWidget("w3", 2, "", { kind: "realized_savings", eventKind: "rightsizing" }),
        ],
      },
      "POST /dashboards/kpi": {
        value: 42,
        unit: "ratio",
        previous: null,
        change: 2,
        changePercent: 5,
        upIsGood: true,
      },
    });
    expect(await run_("dashboards", "finance")).toBe(0);
    expect(out.stdout).toMatchInlineSnapshot(`
      "Finance · d1

      KPIs
      CARD                            VALUE  CHANGE  WINDOW
      forecast_accuracy               42     -             
      burn_rate                       42     -             
      Realized savings: Right-sizing  42     -             

      Delivery
        weekly Mon 08:00 UTC · 1 Slack, 2 emails · PDF attached · succeeded
        monthly day 1 08:00 UTC · 1 Slack, 2 emails · failed
          channel_not_found

      A terminal can't draw the cards: \`infrawrench dashboards "Finance" --format pdf\` saves the rendered dashboard.
      "
    `);
  });

  it("canvas describes an unknown block by its title and formats an unknown mode as a unit cost", async () => {
    serveRoutes(out, {
      "GET /cost-canvases": [
        {
          ...CANVAS,
          spec: {
            version: 1,
            blocks: [
              { id: "b1", kind: "map", title: "Regions" },
              { id: "b2", kind: "kpi", title: "Ratio", metric: { type: "spend" } },
              { id: "b3", kind: "chart", title: "Per user" },
            ],
          },
        },
      ],
      "POST /cost-canvases/cv1/run": {
        ...CANVAS_RUN,
        blocks: [
          { id: "b1", kind: "map" },
          { id: "b2", kind: "kpi", kpi: { value: 3.5, unit: "ratio" } },
          {
            id: "b3",
            kind: "chart",
            from: "2026-10-10",
            to: "2026-11-08",
            unitCost: {
              mode: "per_seat",
              scale: 1,
              metric: { unit: "seat" },
              series: [{ currency: "USD", overallValue: 1.2345 }],
            },
          },
        ],
      },
    });
    expect(await run_("canvas", "show", "ai")).toBe(0);
    expect(out.stdout).toMatchInlineSnapshot(`
      "AI spend · cv1
      Model and GPU spend

      prompt      Show me AI spend
      blocks      3
      dashboards  Finance
      updated     2026-11-01T09:00:00.000Z

       1  map          Regions
       2  kpi          Ratio (spend)
       3  chart        Per user

      Run it: infrawrench canvas refresh "AI spend"
      "
    `);
    expect(await run_("canvas", "ai")).toBe(0);
    expect(out.stdout).toMatchInlineSnapshot(`
      "AI spend · refreshed 2026-11-08T12:00:00.000Z


      Ratio  3.5

      Per user  1.23 USD/seat  (2026-10-10 → 2026-11-08)

      "
    `);
  });

  it("reports renders an unknown grouping, bin, measure and axis segment", async () => {
    serveRoutes(out, {
      ...reportRoutes,
      "GET /cost-reports": [
        costReport("r1", "Monthly spend", { groupBy: "team", binning: "fortnightly" }),
      ],
      "GET /cost-report-notifications": [],
      "POST /cost-reports/r1/run": runResult({ measure: "carbon" }),
    });
    expect(await run_("reports")).toBe(0);
    expect(out.stdout).toMatchInlineSnapshot(`
      "Acme · saved cost reports

      NAME           FOLDER             SHAPE                        DASHBOARDS  DELIVERY  ID
      Monthly spend  Finance / Monthly  stacked bar · by team · 30d           1  —         r1

      Run one with \`infrawrench reports <name|id>\`; \`infrawrench reports send <name|id>\` delivers it to its schedules now.
      "
    `);
    expect(await run_("reports", "monthly spend")).toBe(0);
    expect(out.stdout).toMatchInlineSnapshot(`
      "Monthly spend · 2026-10-10 → 2026-11-08  270 (prev 200, +35.0%)
      What finance watches

      fortnightly ▁█

      EC2   ████████████████████████████████ 250
      other ███░░░░░░░░░░░░░░░░░░░░░░░░░░░░░ 20

      Shown on Finance. Editing this report changes those cards too.
      "
    `);
    // Unknown values are the server's to check: no local refusal, no unit lookup.
    expect(await run_("reports", "monthly spend", "--measure", "usage", "--unit", "Hrs")).toBe(0);
    expect(out.requests.at(-1)).toBe("POST /cost-reports/r1/run");
  });
});
