import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

// `unit-costs` (the metric list, the calculation in every mode, `--labels`,
// `--usage-units`, `--format`), `unit-costs sources` and `unit-costs importer`
// on effect/cli: text and `--json` output, the requests each line sends
// (bodies included), refusals and exit codes, against fixtures, pinned in
// `__snapshots__/cli-effect-unit-costs.test.ts.snap`.
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

import { RawResponse, run, useCliCapture } from "./cli-harness";

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
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "iw-cli-unit-costs-"));
});
afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});
const file = (name: string, text: string) => {
  const path = join(dir, name);
  writeFileSync(path, text);
  return path;
};

/** `fetch` answered from `routes` by `METHOD /path`, each request recorded with its body. */
function serve(routes: Record<string, unknown>): void {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string, init?: RequestInit) => {
      const url = new URL(input);
      const path = url.pathname.replace(/^\/api\/org\/[^/]+/, "") + url.search;
      const key = `${init?.method ?? "GET"} ${path}`;
      out.requests.push(init?.body ? `${key} ${String(init.body)}` : key);
      if (!(key in routes)) return new Response(`no fixture for ${key}`, { status: 404 });
      const route = routes[key];
      if (route instanceof RawResponse) {
        const body = route.status === 204 ? null : route.body;
        return new Response(body, { status: route.status, headers: route.headers });
      }
      return new Response(JSON.stringify(route), { status: 200 });
    }),
  );
}

/**
 * Run one line and pin what it did: the exit code, both streams and the
 * requests it sent. The snapshots were first proved byte-identical to the
 * legacy commands' output on these fixtures, through copies of the modules
 * they replaced; a refusal the legacy parser made before any command ran
 * now prints the command's help above the same sentence.
 */
async function same(argv: string[], code: number) {
  const from = out.requests.length;
  out.stdout = "";
  out.stderr = "";
  expect(await run(...argv)).toBe(code);
  const here = (text: string) =>
    text.replaceAll(realpathSync(dir), "<dir>").replaceAll(dir, "<dir>");
  expect({
    stdout: here(out.stdout),
    stderr: here(out.stderr),
    requests: out.requests.slice(from).map(here),
  }).toMatchSnapshot(`${code} $ infrawrench ${argv.map(here).join(" ")}`);
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const metric = (over: Record<string, unknown>) => ({
  id: "bm1",
  key: "active-customers",
  name: "Active customers",
  unit: "customer",
  description: null,
  kind: "count",
  currency: null,
  costScope: [],
  savedFilterId: null,
  labelMappings: [],
  thresholds: [],
  createdByUserId: null,
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
  coverage: { firstDay: "2026-10-01", lastDay: "2026-10-31", reportedDays: 28 },
  importer: null,
  ...over,
});

const METRICS = {
  metrics: [
    metric({}),
    metric({
      id: "bm2",
      key: "revenue",
      name: "Revenue",
      unit: "USD",
      kind: "currency",
      currency: "USD",
      costScope: [{ dimension: "provider", operator: "in", values: ["aws"] }],
      coverage: null,
    }),
    metric({
      id: "bm3",
      key: "signups",
      name: "Signups",
      unit: "signup",
      costScope: [{}, {}],
      coverage: { firstDay: "2026-10-01", lastDay: "2026-10-10", reportedDays: 10 },
    }),
  ],
};

const point = (over: Record<string, unknown>) => ({
  bucket: "2026-11-01",
  value: 0.5,
  cost: 50,
  metricValue: 100,
  reportedDays: 1,
  bucketDays: 1,
  ...over,
});

const series = (over: Record<string, unknown>) => ({
  currency: "USD",
  points: [
    point({}),
    point({
      bucket: "2026-11-02",
      value: null,
      cost: 40,
      metricValue: null,
      gap: "no_metric_value",
      reportedDays: 0,
    }),
    point({ bucket: "2026-11-03", value: 0.6, cost: 60, reportedDays: 3, bucketDays: 7 }),
    point({ bucket: "2026-11-04", value: null, cost: 1, metricValue: 0, gap: "brand_new_reason" }),
    point({ bucket: "2026-11-05", value: 0.4, cost: 40 }),
  ],
  overallValue: 0.75,
  overallCost: 191,
  overallMetricValue: 300,
  ...over,
});

const UNIT = {
  metric: {
    id: "bm1",
    key: "active-customers",
    name: "Active customers",
    unit: "customer",
    kind: "count",
    currency: null,
  },
  mode: "unit_cost",
  binning: "daily",
  scale: 1,
  series: [series({})],
  gapBuckets: 2,
  partialBuckets: 1,
};

const MARGIN = {
  ...UNIT,
  metric: { ...UNIT.metric, key: "revenue", name: "Revenue", unit: "USD", kind: "currency" },
  mode: "margin",
  series: [
    series({
      overallAbsoluteMargin: 1200,
      points: [
        point({ value: 0.42, absoluteMargin: 300 }),
        point({ bucket: "2026-11-02", absoluteMargin: null }),
      ],
    }),
  ],
  gapBuckets: 0,
  partialBuckets: 0,
};

const SPLIT = {
  ...UNIT,
  groupByLabel: "customer",
  costPerLabel: false,
  scale: 1000,
  series: [
    series({ label: { key: "customer", value: "acme" } }),
    series({
      label: { key: "customer", value: null },
      overallValue: null,
      overallMetricValue: null,
    }),
    series({ label: { key: "customer", value: null, other: true }, points: [point({})] }),
  ],
  gapBuckets: 0,
  partialBuckets: 0,
};

const MIXED = {
  ...UNIT,
  mode: "raw_metric",
  series: [series({}), series({ currency: "EUR", points: [point({})] })],
  gapBuckets: 0,
  partialBuckets: 0,
};

const USAGE_UNIT = {
  ...UNIT,
  metric: null,
  mode: "usage_unit_cost",
  usageUnit: "GB-Mo",
  scale: 1_000_000,
  gapBuckets: 0,
  partialBuckets: 0,
};

const unitRoutes = {
  "GET /business-metrics": METRICS,
  "GET /business-metrics/usage-units": {
    units: [
      { unit: "Hrs", usage: 12_345.6, services: ["EC2", "RDS"] },
      { unit: "GB-Mo", usage: 0.42, services: [] },
    ],
  },
  "GET /business-metrics/active-customers/labels": {
    labels: [
      {
        key: "customer",
        values: ["acme", "globex", "initech", "umbrella", "hooli", "stark", "wayne"],
        truncated: false,
        mapping: { kind: "dimension", dimension: "tag", tagKey: "customer" },
      },
      { key: "plan", values: ["free"], truncated: true, mapping: { kind: "cost_centre" } },
      { key: "region", values: [], truncated: false, mapping: null },
      {
        key: "svc",
        values: ["api"],
        truncated: false,
        mapping: { kind: "dimension", dimension: "service" },
      },
    ],
  },
  "POST /business-metrics/active-customers/unit-costs": UNIT,
  "POST /business-metrics/revenue/unit-costs": MARGIN,
  "POST /business-metrics/signups/unit-costs": SPLIT,
  "POST /business-metrics/mixed/unit-costs": MIXED,
  "POST /business-metrics/empty/unit-costs": { ...UNIT, series: [] },
  "POST /business-metrics/usage-unit-costs": USAGE_UNIT,
  "POST /business-metrics/active-customers/unit-costs/export": new RawResponse(
    200,
    "bucket,currency,value,cost,metric_value\n2026-11-01,USD,0.5,50,100\n2026-11-02,USD,,40,\n",
  ),
};

describe("unit-costs", () => {
  it("lists metrics and usage units like the legacy command", async () => {
    serve(unitRoutes);
    await same(["unit-costs"], 0);
    await same(["unit-costs", "--json"], 0);
    await same(["unit-costs", "--usage-units"], 0);
    await same(["unit-costs", "--usage-units", "--json"], 0);
    await same(["unit-costs", "active-customers", "--labels"], 0);
    await same(["unit-costs", "active-customers", "--labels", "--json"], 0);
    await same(["unit-costs", "--local"], 1);
    await same(["unit-costs", "--usage-units", "--local"], 1);
    serve({
      "GET /business-metrics": { metrics: [] },
      "GET /business-metrics/usage-units": {},
      "GET /business-metrics/active-customers/labels": { labels: [] },
    });
    await same(["unit-costs"], 0);
    await same(["unit-costs", "--usage-units"], 0);
    await same(["unit-costs", "active-customers", "--labels"], 0);
  });

  it("draws the calculation in each mode", async () => {
    serve(unitRoutes);
    await same(["unit-costs", "active-customers"], 0);
    await same(["unit-costs", "active-customers", "--json"], 0);
    const full = [
      "unit-costs",
      "active-customers",
      "--last",
      "2w",
      "--group-by",
      "weekly",
      "--basis",
      "amortized",
      "--currency",
      "eur",
      "--where",
      "provider = 'aws'",
      "--scale",
      "1k",
      "--label",
      "plan=pro,enterprise",
      "--label",
      "region!=eu",
      "--split",
      "customer",
      "--mode",
      "unit",
    ];
    await same(full, 0);
    await same(["unit-costs", "revenue", "--margin"], 0);
    await same(["unit-costs", "revenue", "--mode", "margin", "--json"], 0);
    await same(["unit-costs", "signups", "--split", "customer"], 0);
    await same(["unit-costs", "mixed", "--mode", "raw"], 0);
    await same(["unit-costs", "empty"], 0);
    await same(["unit-costs", "--usage-unit", "GB-Mo", "--scale", "1m"], 0);
    await same(["unit-costs", "--usage-unit", "GB-Mo", "--json"], 0);
    await same(["unit-costs", "active-customers", "--mode", "usage", "--usage-unit", "Hrs"], 0);
  });

  it("writes the export verbatim", async () => {
    serve(unitRoutes);
    await same(["unit-costs", "active-customers", "--format", "csv"], 0);
    await same(
      ["unit-costs", "active-customers", "--format", "ndjson", "--group-by", "monthly"],
      0,
    );
  });

  it("refuses bad flags in the legacy words", async () => {
    serve(unitRoutes);
    await same(["unit-costs", "active-customers", "--mode", "ratio"], 2);
    await same(["unit-costs", "active-customers", "--scale", "7"], 2);
    await same(["unit-costs", "active-customers", "--label", "nope"], 2);
    await same(["unit-costs", "active-customers", "--label", "plan= ,"], 2);
    await same(["unit-costs", "revenue", "--margin", "--mode", "raw"], 2);
    await same(["unit-costs", "active-customers", "--usage-unit", "Hrs", "--mode", "raw"], 2);
    await same(["unit-costs", "active-customers", "--mode", "usage"], 2);
    await same(["unit-costs", "active-customers", "--group-by", "hourly"], 2);
    await same(["unit-costs", "active-customers", "--basis", "net"], 2);
    await same(["unit-costs", "active-customers", "--currency", "dollars"], 2);
    await same(["unit-costs", "active-customers", "--local"], 1);
    await same(["unit-costs", "active-customers", "--format", "xml"], 2);
    await same(["unit-costs", "active-customers", "--last", "6h"], 2);
  });
});

// ---------------------------------------------------------------------------
// sources and importer
// ---------------------------------------------------------------------------

const SOURCES = {
  sources: [
    {
      accountId: "acc-aws",
      accountName: "prod",
      pluginId: "aws",
      pluginName: "AWS",
      source: {
        label: "CloudWatch metric",
        kind: "metric",
        fields: [
          { key: "namespace", label: "Namespace", type: "select", required: true },
          {
            key: "metric",
            label: "Metric",
            type: "select",
            required: true,
            dependsOn: ["namespace"],
          },
          { key: "stat", label: "Statistic", type: "select" },
        ],
      },
    },
    {
      accountId: "acc-pg",
      accountName: "Warehouse",
      pluginId: "postgres",
      pluginName: "PostgreSQL",
      source: {
        label: "SQL query",
        kind: "sql",
        readOnly: "enforced",
        fields: [{ key: "sql", label: "Query", type: "sql", required: true }],
      },
    },
    {
      accountId: "acc-ch",
      accountName: "ClickHouse",
      pluginId: "clickhouse",
      pluginName: "ClickHouse",
      source: { label: "SQL query", kind: "sql", readOnly: "validated", fields: [] },
    },
  ],
};

const IMPORTER = {
  id: "imp1",
  metricId: "bm1",
  accountId: "acc-pg",
  accountName: "Warehouse",
  pluginId: "postgres",
  sourceLabel: "SQL query",
  params: { sql: "SELECT day, count(*)\nFROM customers\nGROUP BY 1", note: "daily" },
  schedule: "daily",
  backfillDays: 3,
  timezone: "UTC",
  aggregation: "sum",
  enabled: true,
  nextRunAt: "2026-11-09T04:00:00.000Z",
  lastRunAt: "2026-11-08T04:00:00.000Z",
  lastStatus: "success",
  lastError: null,
  consecutiveFailures: 0,
  createdByUserId: null,
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
};

const importRun = (over: Record<string, unknown>) => ({
  id: "run1",
  importerId: "imp1",
  trigger: "schedule",
  status: "success",
  from: "2026-11-05",
  to: "2026-11-07",
  pointsRead: 3,
  daysWritten: 3,
  error: null,
  notes: [],
  startedAt: "2026-11-08T04:00:00.000Z",
  finishedAt: "2026-11-08T04:00:02.000Z",
  durationMs: 1800,
  ...over,
});

const RUNS = {
  runs: [
    importRun({}),
    importRun({ id: "run2", trigger: "manual", status: "error", error: "x".repeat(100) }),
    importRun({ id: "run3", status: "running" }),
  ],
};

const importerRoutes = {
  "GET /business-metrics/importer-sources": SOURCES,
  "GET /business-metrics/active-customers/importer": { importer: IMPORTER },
  "GET /business-metrics/active-customers/importer/runs?limit=10": RUNS,
  "GET /business-metrics/active-customers/importer/runs?limit=50": RUNS,
  "POST /business-metrics/active-customers/importer/run": importRun({
    trigger: "manual",
    notes: ["2 days had no rows"],
  }),
  "PUT /business-metrics/active-customers/importer": { ...IMPORTER, enabled: false },
  "DELETE /business-metrics/active-customers/importer": new RawResponse(204, ""),
  "GET /business-metrics/signups/importer": { importer: null },
  "PUT /business-metrics/signups/importer": {
    ...IMPORTER,
    accountId: "acc-aws",
    accountName: null,
    sourceLabel: null,
    params: { namespace: "AWS/EC2" },
    lastRunAt: null,
    nextRunAt: null,
    lastStatus: "error",
    lastError: "AccessDenied",
    consecutiveFailures: 2,
  },
  "POST /business-metrics/signups/importer/run": importRun({
    status: "error",
    error: "no rows",
    durationMs: null,
  }),
};

describe("unit-costs sources and importer", () => {
  it("lists the sources", async () => {
    serve(importerRoutes);
    await same(["unit-costs", "sources"], 0);
    await same(["unit-costs", "sources", "--json"], 0);
    await same(["unit-costs", "sources", "--local"], 1);
    serve({ "GET /business-metrics/importer-sources": {} });
    await same(["unit-costs", "sources"], 0);
  });

  it("shows, runs and lists an importer's runs", async () => {
    serve(importerRoutes);
    await same(["unit-costs", "importer", "active-customers"], 0);
    await same(["unit-costs", "importer", "active-customers", "show", "--json"], 0);
    await same(["unit-costs", "importer", "signups"], 0);
    await same(["unit-costs", "importer", "signups", "--json"], 0);
    await same(["unit-costs", "importer", "active-customers", "runs"], 0);
    await same(["unit-costs", "importer", "active-customers", "runs", "--json"], 0);
    await same(
      [
        "unit-costs",
        "importer",
        "active-customers",
        "run",
        "--from",
        "2026-10-01",
        "--to",
        "2026-10-31",
      ],
      0,
    );
    await same(["unit-costs", "importer", "active-customers", "run", "--json"], 0);
    await same(["unit-costs", "importer", "signups", "run"], 1);
    await same(["unit-costs", "importer", "signups", "run", "--json"], 1);
  });

  it("sets, pauses, resumes and deletes an importer", async () => {
    serve(importerRoutes);
    const sql = file("query.sql", "SELECT 1");
    const doc = file(
      "importer.json",
      JSON.stringify({ accountId: "acc-pg", params: { sql: "SELECT 2" }, schedule: "weekly" }),
    );
    await same(["unit-costs", "importer", "active-customers", "disable"], 0);
    await same(["unit-costs", "importer", "active-customers", "enable", "--json"], 0);
    await same(["unit-costs", "importer", "signups", "enable"], 1);
    await same(
      [
        "unit-costs",
        "importer",
        "active-customers",
        "set",
        "--set",
        "schedule=weekly",
        "--set",
        "backfillDays=7",
        "--set",
        "enabled=1",
        "--set",
        "aggregation=max",
        "--set",
        "timezone=Europe/London",
        "--set",
        `sql=@${sql}`,
      ],
      0,
    );
    await same(
      ["unit-costs", "importer", "signups", "set", "-a", "prod", "--set", "namespace=AWS/EC2"],
      0,
    );
    await same(["unit-costs", "importer", "signups", "set", "--account", "acc-aws", "--json"], 0);
    await same(
      ["unit-costs", "importer", "active-customers", "set", "-f", doc, "-a", "Warehouse"],
      0,
    );
    await same(["unit-costs", "importer", "active-customers", "set", "--file", doc, "--json"], 0);
    await same(["unit-costs", "importer", "active-customers", "delete"], 0);
    await same(["unit-costs", "importer", "active-customers", "delete", "--json"], 0);
  });

  it("refuses bad importer input in the legacy words", async () => {
    serve(importerRoutes);
    const bad = file("bad.json", "{ nope");
    await same(["unit-costs", "importer"], 2);
    await same(["unit-costs", "importer", "active-customers", "bounce"], 2);
    await same(["unit-costs", "importer", "signups", "set"], 2);
    await same(["unit-costs", "importer", "signups", "set", "-a", "nope"], 1);
    await same(["unit-costs", "importer", "active-customers", "set", "--set", "oops"], 2);
    await same(
      [
        "unit-costs",
        "importer",
        "active-customers",
        "set",
        "--set",
        `sql=@${join(dir, "missing.sql")}`,
      ],
      2,
    );
    await same(["unit-costs", "importer", "active-customers", "set", "--file", bad], 2);
    await same(["unit-costs", "importer", "active-customers", "--local"], 1);
  });
});
