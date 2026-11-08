import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

// `costs` (the chart, `--anomalies` with its feedback verbs, `--alerts`,
// `tag-keys`, `forecast(s)`, `push`, `sources`) and `page` on effect/cli: text
// and `--json` output, the requests each line sends (bodies included),
// refusals and exit codes, against fixtures, pinned in
// `__snapshots__/cli-effect-costs.test.ts.snap`. Nothing reaches a network or
// a database; the pushed files live in a temporary directory.
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
  dir = mkdtempSync(join(tmpdir(), "iw-cli-costs-"));
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
    requests: out.requests.slice(from),
  }).toMatchSnapshot(`${code} $ infrawrench ${argv.map(here).join(" ")}`);
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const account = (over: Record<string, unknown>) => ({
  accountId: "a1",
  pluginId: "aws",
  displayName: "prod",
  supportsCosts: true,
  periodNative: true,
  dimensions: [],
  chargeTypes: true,
  amortization: true,
  blending: false,
  estimated: false,
  costLastPolledAt: "2026-11-07T00:00:00.000Z",
  costBackfilledAt: null,
  costPollFailureCount: 0,
  costPollError: null,
  coverage: { firstDay: "2026-01-01", lastDay: "2026-11-07" },
  ...over,
});

const STATUS = { accounts: [account({})] };
const STATUS_NOISY = {
  accounts: [
    account({}),
    account({
      accountId: "a2",
      displayName: "staging",
      coverage: null,
      costPollError: {
        message: "AccessDenied on ce:GetCostAndUsage",
        helpLink: { label: "Fix it", url: "https://example.com/fix" },
      },
    }),
    account({ accountId: "a3", displayName: "fresh", coverage: null }),
    account({ accountId: "a4", displayName: "colo", estimated: true, amortization: false }),
    account({ accountId: "a5", displayName: "github", supportsCosts: false }),
  ],
};

const series = (key: string, label: string, amounts: number[], currency = "USD") => ({
  key,
  label,
  currency,
  points: amounts.map((amount, i) => ({ bucket: `2026-11-0${i + 1}`, amount })),
});

const QUERY = {
  series: [series("aws", "AWS", [10, 12, 8]), series("__other__", "Other", [1, 2, 3])],
  currencies: ["USD"],
  totals: { USD: 36 },
  previousTotals: { USD: 30 },
};

const QUERY_X = {
  series: [
    {
      key: "aws",
      label: "AWS",
      currency: "USD",
      points: [
        { bucket: "ec2", amount: 20 },
        { bucket: "s3", amount: 5 },
      ],
    },
    {
      key: "gcp",
      label: "GCP",
      currency: "USD",
      points: [{ bucket: "ec2", amount: 2 }],
    },
  ],
  comparison: [
    {
      key: "aws",
      label: "AWS",
      currency: "USD",
      points: [{ bucket: "ec2", amount: 10 }],
    },
  ],
  currencies: ["USD"],
  totals: { USD: 27 },
  previousTotals: { USD: 10 },
  xAxis: {
    dimension: "service",
    segment: "dimension",
    values: [
      { key: "ec2", label: "EC2" },
      { key: "s3", label: "S3" },
    ],
  },
};

const QUERY_CONVERTED = {
  ...QUERY,
  totals: { USD: 36, JPY: 1500 },
  currencies: ["USD", "JPY"],
  conversion: {
    displayCurrency: "USD",
    converted: [
      {
        currency: "EUR",
        rates: [
          { effectiveFrom: "2026-10-01", rate: 1.08, source: "manual" },
          { effectiveFrom: "2026-11-02", rate: 1.09, source: "ecb" },
          { effectiveFrom: "2026-11-01", rate: 1.07, source: "ecb" },
        ],
      },
      { currency: "GBP", rates: [{ effectiveFrom: "2026-11-01", rate: 1.27, source: "ecb" }] },
      { currency: "CHF", rates: [{ effectiveFrom: "2026-09-01", rate: 1.1 }] },
    ],
    unconverted: ["JPY"],
    rateBasis: "daily",
  },
};

const QUERY_USAGE = {
  series: [series("ec2", "EC2", [100, 200], "")],
  currencies: [""],
  totals: { "": 300 },
  measure: "usage",
  usageUnit: "Hrs",
};

const QUERY_COUNT = {
  series: [series("ec2", "EC2", [3, 4], "")],
  currencies: [""],
  totals: { "": 5 },
  measure: "count",
};

const SAVED_FILTERS = [
  {
    id: "sf1",
    name: "Prod only",
    description: null,
    filters: [{ dimension: "account", operator: "in", values: ["a1"] }],
    query: "account = 'a1'",
    createdByUserId: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  },
];

const chartRoutes = {
  "POST /costs/query": QUERY,
  "GET /costs/status": STATUS,
  "GET /saved-cost-filters": SAVED_FILTERS,
  "GET /costs/dimensions?dimension=usage-units": {
    values: [
      { value: "Hrs", label: "Hrs" },
      { value: "GB-Mo", label: "GB-Mo" },
    ],
  },
};

const anomaly = (over: Record<string, unknown>) => ({
  id: "a1b2c3d4e5f6",
  day: "2026-11-05",
  kind: "spike",
  dimension: "service",
  dimensionKey: "Amazon EC2",
  currency: "USD",
  actualCents: 50000,
  baselineCents: 20000,
  thresholdCents: 30000,
  detectedAt: "2026-11-06T02:00:00.000Z",
  notifiedAt: "2026-11-06T02:01:00.000Z",
  hints: [],
  contributors: [
    {
      facet: "resource",
      key: "i-0abc",
      tagKey: null,
      label: "api-server",
      accountId: "a1",
      resource: null,
      actualCents: 40000,
      baselineCents: 10000,
      deltaCents: 30000,
      share: 1,
    },
  ],
  acknowledgement: {
    explanation: "The quarterly load test, which ran for most of the day against production",
    acknowledgedAt: "2026-11-06T09:00:00.000Z",
    acknowledgedByUserId: "u1",
    annotationId: null,
  },
  feedback: {
    verdict: "expected",
    reason: "planned_launch",
    note: null,
    at: "2026-11-06T09:00:00.000Z",
    byUserId: "u1",
    byName: "Ada",
    suppressionId: null,
  },
  suppressionId: null,
  ...over,
});

const ANOMALY = anomaly({});
const ANOMALIES = {
  anomalies: [
    ANOMALY,
    anomaly({
      id: "a1ff00112233",
      day: "2026-11-06",
      kind: "new_source",
      dimension: "provider",
      dimensionKey: "gcp",
      actualCents: 12000,
      baselineCents: 0,
      notifiedAt: null,
      contributors: [],
      acknowledgement: null,
      feedback: null,
      suppressionId: "s1",
    }),
    anomaly({
      id: "b9c8d7",
      day: "2026-11-07",
      contributors: undefined,
      acknowledgement: undefined,
      feedback: { ...ANOMALY.feedback, verdict: "unexpected", byName: null },
    }),
  ],
};

const ALERTS = {
  alerts: [
    {
      id: "al1",
      name: "EC2 jump",
      filters: [{ dimension: "provider", operator: "in", values: ["aws"] }],
      groupBy: "service",
      groupByTagKey: null,
      cadence: "weekly",
      thresholdPercent: 25,
      thresholdAmountCents: 10000,
      direction: "increase",
      enabled: true,
      lastEvaluatedAt: null,
      lastFiredAt: "2026-11-03T06:00:00.000Z",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    },
    {
      id: "al2",
      name: "Team spend",
      filters: [],
      groupBy: "tag",
      groupByTagKey: "team",
      cadence: "monthly",
      thresholdPercent: null,
      thresholdAmountCents: 5000,
      direction: "both",
      enabled: false,
      lastEvaluatedAt: null,
      lastFiredAt: null,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    },
    {
      id: "al3",
      name: "Daily drop",
      filters: [],
      groupBy: null,
      groupByTagKey: null,
      cadence: "daily",
      thresholdPercent: 10,
      thresholdAmountCents: null,
      direction: "decrease",
      enabled: true,
      lastEvaluatedAt: null,
      lastFiredAt: null,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    },
  ],
};

const alertEvent = (over: Record<string, unknown>) => ({
  id: "e1",
  alertId: "al1",
  alertName: "EC2 jump",
  periodKey: "2026-W44",
  windowFrom: "2026-10-27",
  windowTo: "2026-11-02",
  previousFrom: "2026-10-20",
  previousTo: "2026-10-26",
  groupKey: "Amazon EC2",
  currency: "USD",
  previousAmountCents: 10000,
  currentAmountCents: 17300,
  changePercent: 73,
  direction: "increase",
  firedAt: "2026-11-03T06:00:00.000Z",
  notifiedAt: null,
  ...over,
});

const EVENTS = {
  events: [
    alertEvent({}),
    alertEvent({
      id: "e2",
      groupKey: "",
      windowFrom: "2026-11-01",
      windowTo: "2026-11-01",
      changePercent: null,
    }),
    alertEvent({
      id: "e3",
      alertName: "Daily drop",
      groupKey: "",
      changePercent: -42,
      direction: "decrease",
    }),
  ],
};

const REPORTS = [
  { id: "r1", name: "Platform spend", config: {} },
  { id: "r2", name: "Platform EU", config: {} },
];

const FORECASTS = {
  forecasts: [
    {
      id: "fc1",
      reportId: "r1",
      name: "EU launch",
      description: null,
      scenarioModelIds: ["m1"],
      driverMetricId: null,
      isDefault: true,
      createdByUserId: null,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    },
    {
      id: "fc2",
      reportId: "r1",
      name: "Hiring plan",
      description: null,
      scenarioModelIds: [],
      driverMetricId: "bm1",
      isDefault: false,
      createdByUserId: null,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    },
  ],
};

const forecastSeries = (over: Record<string, unknown>) => ({
  forecastId: null,
  name: "Automatic",
  isDefault: false,
  points: [10, 12, 15, 11, 18, 20, 22].map((expected, i) => ({
    day: `2026-11-1${i}`,
    expected,
    low: expected - 2,
    high: expected + 2,
  })),
  total: { expected: 1000, low: 900, high: 1100 },
  deltaFromBaseline: 0,
  scenarios: [],
  driver: null,
  warnings: [],
  ...over,
});

const DRIVER = {
  metricId: "bm1",
  metricName: "Signups",
  metricUnit: "signup",
  unitCost: 0.5,
  metricTotal: 2000,
  coveredDays: 80,
  totalDays: 90,
};

const EU_SERIES = forecastSeries({
  forecastId: "fc1",
  name: "EU launch",
  isDefault: true,
  total: { expected: 1250, low: null, high: null },
  deltaFromBaseline: 250,
  scenarios: [
    { modelId: "m1", modelName: "Launch", totalDelta: 250, contributions: [], outOfScope: [] },
  ],
  driver: DRIVER,
  warnings: ["Only 40 days of history"],
});

const FORECAST_RESULT = {
  reportId: "r1",
  reportName: "Platform spend",
  from: "2026-11-08",
  to: "2027-02-05",
  lastObservedDay: "2026-11-07",
  currency: "USD",
  confidenceLevel: 80,
  baseline: forecastSeries({}),
  forecast: EU_SERIES,
  forecasts: [
    EU_SERIES,
    forecastSeries({ forecastId: "fc2", name: "Hiring plan", deltaFromBaseline: -40 }),
  ],
};

const suppression = (over: Record<string, unknown>) => ({
  id: "s1abcdef",
  scope: "service",
  scopeKey: "Amazon EC2",
  tagKey: null,
  scopeLabel: null,
  recurrence: "weekly",
  anchorDay: "2026-11-05",
  startsOn: "2026-11-05",
  expiresOn: "2027-02-05",
  reason: "planned_launch",
  note: null,
  sourceAnomalyId: "a1b2c3d4e5f6",
  createdByUserId: "u1",
  createdByName: "Ada",
  createdAt: "2026-11-06T09:00:00.000Z",
  updatedAt: "2026-11-06T09:00:00.000Z",
  active: true,
  suppressedCount: 3,
  ...over,
});

const SUPPRESSIONS = {
  suppressions: [
    suppression({}),
    suppression({
      id: "s1ff9988",
      scope: "tag",
      scopeKey: "prod",
      tagKey: "env",
      recurrence: "seasonal",
      reason: null,
      active: false,
      suppressedCount: 0,
    }),
    suppression({ id: "c0ffee", scope: "cost_centre", scopeKey: "cc1", scopeLabel: "Platform" }),
  ],
};

const PRECISION = {
  months: 3,
  periods: [
    { month: "2026-09", detected: 5, suppressed: 1, expected: 2, unexpected: 1, precision: 0.33 },
    { month: "2026-10", detected: 0, suppressed: 0, expected: 0, unexpected: 0, precision: null },
    { month: "2026-11", detected: 2, suppressed: 0, expected: 0, unexpected: 2, precision: 1 },
  ],
  totals: { detected: 7, suppressed: 1, expected: 2, unexpected: 3, precision: 0.6 },
  reasons: [
    { reason: "planned_launch", count: 2 },
    { reason: "migration", count: 1 },
  ],
};

const SENSITIVITY = {
  enabled: true,
  windowDays: 90,
  baseSigmas: 3,
  adjustments: [
    {
      dimension: "service",
      dimensionKey: "Amazon EC2",
      baseSigmas: 3,
      sigmas: 3.5,
      expectedCount: 4,
      unexpectedCount: 0,
      explanation: "4 expected verdicts raised the bar",
    },
    {
      dimension: "provider",
      dimensionKey: "gcp",
      baseSigmas: 3,
      sigmas: 3,
      expectedCount: 0,
      unexpectedCount: 2,
      explanation: "unexpected verdicts keep it at the base",
    },
  ],
};

const SOURCES = [
  {
    id: "cs1",
    name: "Colo",
    description: null,
    defaultCurrency: "USD",
    pluginId: "custom-colo",
    uploadCount: 2,
    lastUploadAt: "2026-10-02T09:00:00.000Z",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  },
  {
    id: "cs2",
    name: "Datadog",
    description: null,
    defaultCurrency: null,
    pluginId: "custom-datadog",
    uploadCount: 0,
    lastUploadAt: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  },
];

const upload = (over: Record<string, unknown>) => ({
  id: "u1",
  sourceId: "cs1",
  fileName: "sept.csv",
  format: "csv",
  mode: "append",
  status: "complete",
  fromDate: "2026-09-01",
  toDate: "2026-09-30",
  rowCount: 30,
  totals: { USD: 1200 },
  uploadedBy: { id: "u1", name: "Ada", email: "ada@example.com" },
  via: "web",
  createdAt: "2026-10-02T09:00:00.000Z",
  completedAt: "2026-10-02T09:00:05.000Z",
  ...over,
});

const UPLOADS = [
  upload({}),
  upload({
    id: "u2",
    fileName: null,
    format: "rows",
    status: "replaced",
    uploadedBy: { id: "u2", name: null, email: "bot@example.com" },
    via: "cli",
  }),
  upload({ id: "u4", status: "uploading", uploadedBy: null, fileName: "aug.csv", rowCount: 0 }),
];

const NEW_UPLOAD = upload({
  id: "u3",
  fileName: "nov.csv",
  status: "uploading",
  fromDate: "2026-11-01",
  toDate: "2026-11-02",
  rowCount: 0,
  totals: {},
  via: "cli",
});

const pushRoutes = {
  "GET /custom-cost-sources": SOURCES,
  "GET /custom-cost-sources/cs1/uploads": UPLOADS,
  "GET /custom-cost-sources/cs2/uploads": [],
  "POST /custom-cost-sources/cs1/uploads": NEW_UPLOAD,
  "POST /custom-cost-sources/cs1/uploads/u3/rows": { received: 2 },
  "POST /custom-cost-sources/cs1/uploads/u3/complete": {
    ...NEW_UPLOAD,
    status: "complete",
    rowCount: 2,
    totals: { USD: 30 },
  },
  "POST /costs/rows": { written: 1 },
};

// ---------------------------------------------------------------------------
// costs
// ---------------------------------------------------------------------------

describe("costs", () => {
  it("charts spend like the legacy command", async () => {
    serve(chartRoutes);
    await same(["costs"], 0);
    await same(["costs", "--json"], 0);
    await same(["costs", "--last", "7d", "--group-by", "service", "--compare"], 0);
    await same(["costs", "--from", "2026-10-01", "--to", "2026-10-31", "--cumulative"], 0);
    await same(["costs", "--group-by", "tag:team", "--bin", "week"], 0);
    await same(["costs", "--group-by", "none", "--json"], 0);
  });

  it("narrows by basis, charge type, currency, --where and --filter", async () => {
    serve(chartRoutes);
    const narrowed = [
      "costs",
      "--basis",
      "amortized",
      "--charge-type",
      "usage",
      "--charge-type",
      "credit",
      "--currency",
      "usd",
      "--where",
      "provider = 'aws' AND tag['env'] != 'dev'",
      "--filter",
      "prod ONLY",
    ];
    await same(narrowed, 0);
    await same([...narrowed, "--json"], 0);
    await same(["costs", "--basis", "blended"], 0);
    await same(["costs", "--filter", "sf1", "--json"], 0);
    serve({ ...chartRoutes, "GET /costs/status": STATUS_NOISY });
    await same(["costs", "--basis", "amortized"], 0);
    await same(["costs", "--basis", "blended", "--json"], 0);
  });

  it("prints collection warnings and the conversion notice", async () => {
    serve({
      ...chartRoutes,
      "GET /costs/status": STATUS_NOISY,
      "POST /costs/query": QUERY_CONVERTED,
    });
    await same(["costs", "--currency", "USD"], 0);
    await same(["costs", "--currency", "USD", "--json"], 0);
    serve({ ...chartRoutes, "POST /costs/query": { series: [], currencies: [], totals: {} } });
    await same(["costs"], 0);
  });

  it("draws a dimension axis, usage and counts", async () => {
    serve({ ...chartRoutes, "POST /costs/query": QUERY_X });
    await same(["costs", "--x-axis", "service", "--compare"], 0);
    await same(["costs", "--x-axis", "service", "--group-by", "provider"], 0);
    await same(["costs", "--x-axis", "tag:team", "--segment-by-date", "--json"], 0);
    serve({ ...chartRoutes, "POST /costs/query": QUERY_USAGE });
    await same(["costs", "--measure", "usage", "--unit", "Hrs", "--group-by", "service"], 0);
    serve({ ...chartRoutes, "POST /costs/query": QUERY_COUNT });
    await same(["costs", "--measure", "count", "--group-by", "service"], 0);
  });

  it("refuses bad flags in the legacy words", async () => {
    serve(chartRoutes);
    await same(["costs", "--basis", "net"], 2);
    await same(["costs", "--currency", "dollars"], 2);
    await same(["costs", "--where", "provider = "], 2);
    await same(["costs", "--where", "provider = 'aws' OR region = 'eu'"], 2);
    await same(["costs", "--filter", "nope"], 2);
    await same(["costs", "--group-by", "galaxy"], 1);
    await same(["costs", "--x-axis", "galaxy"], 2);
    await same(["costs", "--measure", "dollars"], 2);
    await same(["costs", "--bin", "fortnight"], 2);
    await same(["costs", "--measure", "usage"], 2);
    await same(["costs", "--measure", "count", "--group-by", "none"], 2);
    await same(["costs", "--unit", "Hrs"], 2);
    await same(["costs", "--local"], 1);
    await same(["costs", "--charge-type", "fees"], 2);
    await same(["costs", "--last", "6h"], 2);
    serve({ ...chartRoutes, "GET /saved-cost-filters": [] });
    await same(["costs", "--filter", "prod"], 2);
    serve({
      ...chartRoutes,
      "GET /costs/dimensions?dimension=usage-units": { values: [] },
    });
    await same(["costs", "--measure", "usage"], 2);
  });

  it("renders a measure or an axis segment this build does not know", async () => {
    serve({
      ...chartRoutes,
      "POST /costs/query": { ...QUERY_USAGE, measure: "carbon", usageUnit: "kg" },
    });
    await same(["costs"], 0);
    serve({
      ...chartRoutes,
      "POST /costs/query": { ...QUERY_X, xAxis: { ...QUERY_X.xAxis, segment: "week" } },
    });
    await same(["costs", "--x-axis", "service"], 0);
  });

  it("takes the anomaly verbs without --anomalies, and refuses an unknown verb", async () => {
    serve({
      "GET /costs/anomaly-sensitivity": SENSITIVITY,
      "GET /costs/anomaly-suppressions": SUPPRESSIONS,
    });
    await same(["costs", "sensitivity"], 0);
    await same(["costs", "--anomalies", "suppressions", "nope"], 2);
    await same(["costs", "nope"], 2);
  });

  it("lists anomalies", async () => {
    serve({
      "GET /costs/anomalies?days=30": ANOMALIES,
      "GET /costs/anomalies?days=7": { anomalies: [] },
    });
    await same(["costs", "--anomalies"], 0);
    await same(["costs", "--anomalies", "--json"], 0);
    await same(["costs", "--anomalies", "--last", "1w"], 0);
    await same(["costs", "--anomalies", "--days", "7", "--json"], 0);
    await same(["costs", "--anomalies", "--days", "120"], 2);
    await same(["costs", "--anomalies", "--local"], 1);
  });

  it("lists change alerts", async () => {
    serve({
      "GET /cost-alerts": ALERTS,
      "GET /cost-alerts/events?limit=20": EVENTS,
      "GET /cost-alerts/events?limit=200": { events: [] },
    });
    await same(["costs", "--alerts"], 0);
    await same(["costs", "--alerts", "--json"], 0);
    await same(["costs", "--alerts", "--limit", "500"], 0);
    await same(["costs", "--alerts", "--local"], 1);
    serve({ "GET /cost-alerts": { alerts: [] }, "GET /cost-alerts/events?limit=20": EVENTS });
    await same(["costs", "--alerts"], 0);
  });

  it("lists tag keys", async () => {
    serve({
      "GET /costs/dimensions?dimension=tag-keys": {
        values: [
          "team",
          { value: "env", label: "env" },
          "k8s_node_label:pool",
          "k8s_pvc_label:app",
          "k8s_namespace",
        ],
      },
    });
    await same(["costs", "tag-keys"], 0);
    await same(["costs", "tag-keys", "--json"], 0);
    await same(["costs", "tag-keys", "--local"], 1);
    serve({ "GET /costs/dimensions?dimension=tag-keys": { values: [] } });
    await same(["costs", "tag-keys"], 0);
  });
});

describe("costs forecast(s)", () => {
  const routes = {
    "GET /cost-reports": REPORTS,
    "GET /cost-reports/r1/forecasts": FORECASTS,
    "POST /cost-reports/r1/forecasted-costs": FORECAST_RESULT,
  };

  it("lists a report's forecasts", async () => {
    serve(routes);
    await same(["costs", "forecasts", "platform", "spend"], 0);
    await same(["costs", "forecasts", "r1", "--json"], 0);
    await same(["costs", "forecasts"], 2);
    await same(["costs", "forecasts", "platform"], 1);
    await same(["costs", "forecasts", "nope"], 1);
    await same(["costs", "forecasts", "r1", "--local"], 1);
    serve({ ...routes, "GET /cost-reports/r1/forecasts": { forecasts: [] } });
    await same(["costs", "forecasts", "r1"], 0);
  });

  it("projects a report's spend", async () => {
    serve(routes);
    await same(["costs", "forecast", "Platform spend"], 0);
    await same(["costs", "forecast", "r1", "--json"], 0);
    const full = [
      "costs",
      "forecast",
      "r1",
      "--forecast",
      "hiring",
      "--provider",
      "aws, gcp",
      "--service",
      "Amazon EC2",
      "--level",
      "95%",
      "--from",
      "2026-11-10",
      "--to",
      "2026-12-31",
      "--all",
    ];
    await same(full, 0);
    await same([...full, "--json"], 0);
    await same(["costs", "forecast", "r1", "--forecast", "auto", "--json"], 0);
    await same(["costs", "forecast", "r1", "--forecast", "EU LAUNCH", "--json"], 0);
    await same(["costs", "forecast"], 2);
    await same(["costs", "forecast", "r1", "--to", "tomorrow"], 2);
    await same(["costs", "forecast", "r1", "--level", "70"], 2);
    await same(["costs", "forecast", "r1", "--forecast", "nope"], 1);
    await same(["costs", "forecast", "r1", "--forecast", "a"], 1);
    serve({
      ...routes,
      "POST /cost-reports/r1/forecasted-costs": {
        ...FORECAST_RESULT,
        currency: null,
        lastObservedDay: null,
        forecast: forecastSeries({ points: [], driver: { ...DRIVER, unitCost: null } }),
        forecasts: undefined,
      },
    });
    await same(["costs", "forecast", "r1", "--all"], 0);
  });
});

describe("costs --anomalies feedback", () => {
  const routes = {
    "GET /costs/anomalies?days=90": ANOMALIES,
    "POST /costs/anomalies/a1b2c3d4e5f6/feedback": {
      anomaly: ANOMALY,
      suppression: suppression({}),
    },
    "POST /costs/anomalies/b9c8d7/feedback": { anomaly: ANOMALIES.anomalies[2], suppression: null },
    "POST /costs/anomalies/zz/feedback": { anomaly: ANOMALY, suppression: null },
    "DELETE /costs/anomalies/a1b2c3d4e5f6/feedback": ANOMALY,
  };

  it("records, replaces and withdraws a verdict", async () => {
    serve(routes);
    const full = [
      "costs",
      "--anomalies",
      "feedback",
      "a1b2",
      "--expected",
      "--reason",
      "planned_launch",
      "--note",
      "  launch week  ",
      "--explain",
      "--recurrence",
      "weekly",
      "--expires",
      "2026-12-31",
    ];
    await same(full, 0);
    await same([...full, "--json"], 0);
    await same(
      ["costs", "--anomalies", "feedback", "b9", "--unexpected", "--reason", "data_issue"],
      0,
    );
    await same(["costs", "--anomalies", "feedback", "zz", "--expected"], 0);
    await same(["costs", "--anomalies", "feedback", "a1b2c3d4e5f6", "--clear"], 0);
    await same(["costs", "--anomalies", "feedback", "a1b2c3d4e5f6", "--clear", "--json"], 0);
  });

  it("refuses what the server would refuse, before the request", async () => {
    serve(routes);
    const bad: string[][] = [
      [],
      ["--expected", "--unexpected"],
      ["--clear", "--expected"],
      ["--expected", "--reason", "vibes"],
      ["--unexpected", "--recurrence", "weekly"],
      ["--expected", "--recurrence", "daily"],
      ["--expected", "--expires", "2026-12-31"],
      ["--expected", "--recurrence", "one_off", "--expires", "2026-02-30"],
      ["--expected", "--explain"],
      ["--expected", "--note", "x".repeat(501)],
    ];
    for (const extra of bad) await same(["costs", "--anomalies", "feedback", "a1b2", ...extra], 2);
    await same(["costs", "--anomalies", "feedback"], 2);
    await same(["costs", "--anomalies", "feedback", "a1", "--expected"], 2);
    await same(["costs", "--anomalies", "feedback", "a1b2", "--expected", "--local"], 1);
  });

  it("lists and deletes suppressions", async () => {
    serve({
      "GET /costs/anomaly-suppressions": SUPPRESSIONS,
      "DELETE /costs/anomaly-suppressions/s1abcdef": new RawResponse(204, ""),
      "DELETE /costs/anomaly-suppressions/c0ffee": new RawResponse(204, ""),
    });
    await same(["costs", "--anomalies", "suppressions"], 0);
    await same(["costs", "--anomalies", "suppressions", "--json"], 0);
    await same(["costs", "--anomalies", "suppressions", "delete", "s1ab"], 0);
    await same(["costs", "--anomalies", "suppressions", "delete", "c0ffee", "--json"], 0);
    await same(["costs", "--anomalies", "suppressions", "delete", "s1"], 2);
    await same(["costs", "--anomalies", "suppressions", "delete", "nope"], 1);
    await same(["costs", "--anomalies", "suppressions", "delete"], 2);
    await same(["costs", "--anomalies", "suppressions", "--local"], 1);
    serve({ "GET /costs/anomaly-suppressions": { suppressions: [] } });
    await same(["costs", "--anomalies", "suppressions"], 0);
  });

  it("reports precision and sensitivity", async () => {
    serve({
      "GET /costs/anomaly-precision?months=6": PRECISION,
      "GET /costs/anomaly-precision?months=3": { ...PRECISION, months: 1, reasons: [] },
      "GET /costs/anomaly-sensitivity": SENSITIVITY,
    });
    await same(["costs", "--anomalies", "precision"], 0);
    await same(["costs", "--anomalies", "precision", "--months", "3"], 0);
    await same(["costs", "--anomalies", "precision", "--json"], 0);
    await same(["costs", "--anomalies", "precision", "--months", "30"], 2);
    await same(["costs", "--anomalies", "precision", "--months", "0"], 2);
    await same(["costs", "--anomalies", "sensitivity"], 0);
    await same(["costs", "--anomalies", "sensitivity", "--json"], 0);
    await same(["costs", "--anomalies", "sensitivity", "--local"], 1);
    serve({
      "GET /costs/anomaly-sensitivity": { ...SENSITIVITY, enabled: false, adjustments: [] },
    });
    await same(["costs", "--anomalies", "sensitivity"], 0);
  });
});

describe("costs push and sources", () => {
  it("lists custom sources and one source's uploads", async () => {
    serve(pushRoutes);
    await same(["costs", "sources"], 0);
    await same(["costs", "sources", "--json"], 0);
    await same(["costs", "sources", "colo"], 0);
    await same(["costs", "sources", "cs1", "--json"], 0);
    await same(["costs", "sources", "Datadog"], 0);
    await same(["costs", "sources", "nope"], 2);
    await same(["costs", "sources", "--local"], 1);
    serve({ "GET /custom-cost-sources": [] });
    await same(["costs", "sources"], 0);
  });

  it("pushes JSON rows to the plain endpoint and into a custom source", async () => {
    serve(pushRoutes);
    const rows = file(
      "rows.json",
      JSON.stringify([{ date: "2026-11-01", currency: "USD", amount: 10 }]),
    );
    const envelope = file(
      "envelope.json",
      JSON.stringify({ rows: [{ date: "2026-11-01", currency: "USD", amount: 10 }] }),
    );
    await same(["costs", "push", "--source", "colo-script", "--file", rows], 0);
    await same(["costs", "push", "--source", "colo-script", "-f", envelope, "--json"], 0);
    await same(["costs", "push", "--source", "Colo", "--file", rows], 0);
    await same(["costs", "push", "--source", "cs1", "--file", rows, "--json"], 0);
  });

  it("uploads CSV and FOCUS files into a custom source", async () => {
    serve(pushRoutes);
    const csv = file("nov.csv", "Date,Cost,Service\n2026-11-01,10,Rack\n2026-11-02,20,Power\n");
    const focus = file(
      "nov-focus.csv",
      "BilledCost,ChargePeriodStart,BillingCurrency,ServiceName\n10,2026-11-01T00:00:00Z,USD,Rack\n20,2026-11-02T00:00:00Z,USD,Power\n",
    );
    const sept = file("sept.csv", "Date,Cost\n2026-09-03,10\n2026-09-04,oops\n");
    await same(["costs", "push", "--source", "colo", "--format", "csv", "--file", csv], 0);
    await same(
      ["costs", "push", "--source", "colo", "--format", "focus", "--file", focus, "--json"],
      0,
    );
    await same(["costs", "push", "--source", "colo", "--format", "csv", "--file", sept], 2);
    await same(
      ["costs", "push", "--source", "colo", "--format", "csv", "--file", sept, "--replace"],
      0,
    );
    await same(
      ["costs", "push", "--source", "colo", "--format", "csv", "--file", sept, "--append"],
      0,
    );
    await same(
      [
        "costs",
        "push",
        "--source",
        "colo",
        "--format",
        "csv",
        "--file",
        csv,
        "--map",
        "cost=Service",
      ],
      2,
    );
    await same(
      ["costs", "push", "--source", "colo", "--format", "csv", "--file", csv, "--map", "nope"],
      2,
    );
  });

  it("refuses bad input in the legacy words", async () => {
    serve(pushRoutes);
    const rows = file("bad.json", "{ nope");
    const shape = file("shape.json", JSON.stringify({ items: [] }));
    const empty = file("empty.json", "[]");
    const csv = file("plain.csv", "Date,Cost\n2026-11-01,10\n");
    const headerless = file("headerless.csv", "");
    const notFocus = file("not-focus.csv", "Date,Cost\n2026-11-01,10\n");
    const noCost = file("no-cost.csv", "Day,Thing\n2026-11-01,10\n");
    const ambiguous = file("ambiguous.csv", "Date,Cost\n01/02/2026,10\n03/04/2026,5\n");
    await same(["costs", "push", "--file", csv], 2);
    await same(["costs", "push", "--source", "x", "--file", join(dir, "missing.json")], 2);
    await same(["costs", "push", "--source", "x", "--file", rows], 2);
    await same(["costs", "push", "--source", "x", "--file", shape], 2);
    await same(["costs", "push", "--source", "colo", "--file", empty], 2);
    await same(["costs", "push", "--source", "nope", "--format", "csv", "--file", csv], 2);
    await same(["costs", "push", "--source", "colo", "--format", "csv", "--file", headerless], 2);
    await same(["costs", "push", "--source", "colo", "--format", "focus", "--file", notFocus], 2);
    await same(["costs", "push", "--source", "colo", "--format", "csv", "--file", noCost], 2);
    await same(["costs", "push", "--source", "colo", "--format", "csv", "--file", ambiguous], 2);
    await same(
      [
        "costs",
        "push",
        "--source",
        "colo",
        "--format",
        "csv",
        "--file",
        ambiguous,
        "--date-format",
        "mdy",
      ],
      0,
    );
    await same(
      [
        "costs",
        "push",
        "--source",
        "colo",
        "--format",
        "csv",
        "--file",
        ambiguous,
        "--date-format",
        "iso",
      ],
      2,
    );
    await same(["costs", "push", "--source", "colo", "--file", csv, "--local"], 1);
    await same(["costs", "push", "--source", "colo", "--format", "xml", "--file", csv], 2);
  });
});

describe("page", () => {
  it("pages and clears", async () => {
    serve({
      "POST /pages": { delivered: true, suppressed: false, sms: 1, push: 2, slack: 1, msTeams: 0 },
      "DELETE /pages?source=monitor&key=db": { cleared: true },
      "DELETE /pages?source=monitor": { cleared: false },
    });
    const full = [
      "page",
      "db",
      "is",
      "down",
      "--source",
      "monitor",
      "--key",
      "db",
      "--title",
      "Outage",
      "--cooldown",
      "15",
      "--voice",
    ];
    await same(full, 0);
    await same([...full, "--json"], 0);
    await same(["page", "clear", "--source", "monitor", "--key", "db"], 0);
    await same(["page", "clear", "--source", "monitor", "--json"], 0);
    await same(["page", "clear", "--source", "monitor"], 0);
  });

  it("says when a page was suppressed or reached nobody", async () => {
    serve({
      "POST /pages": {
        delivered: false,
        suppressed: true,
        sms: 0,
        push: 0,
        slack: 0,
        msTeams: 0,
        retryAt: "2026-11-08T12:15:00.000Z",
      },
    });
    await same(["page", "hi", "--source", "monitor"], 0);
    serve({
      "POST /pages": { delivered: false, suppressed: false, sms: 0, push: 0, slack: 0, msTeams: 0 },
    });
    await same(["page", "hi", "--source", "monitor"], 0);
  });

  it("refuses a page with nothing to say, no source, a bad cooldown or --local", async () => {
    serve({});
    await same(["page", "--source", "monitor"], 2);
    await same(["page", "hi"], 2);
    await same(["page", "clear"], 2);
    await same(["page", "hi", "--source", "monitor", "--local"], 1);
    await same(["page", "hi", "--source", "monitor", "--cooldown", "1.5"], 2);
  });
});
