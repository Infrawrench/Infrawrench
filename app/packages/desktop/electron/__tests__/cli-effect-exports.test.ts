import { mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

// `export` (Terraform HCL, `--format focus`, `--async` jobs, `export jobs`)
// and `exports` (with `run`, `warehouses`, `create` and `setup`) on
// effect/cli: text and `--json` output, the files written, the requests each
// line sends (bodies included), refusals and exit codes, against fixtures,
// pinned in `__snapshots__/cli-effect-exports.test.ts.snap`.
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
  accounts: [{ id: "loc_1", plugin_id: "aws", display_name: "home lab" }],
  listAccountResourcesLive: vi.fn(),
  getPlugin: vi.fn(),
}));

vi.mock("../main-utils", async (original) => ({
  ...(await original<typeof import("../main-utils")>()),
  getDb: async () => ({ select: async () => local.accounts }),
}));

vi.mock("../plugin-runtime", () => ({
  listAccountResourcesLive: local.listAccountResourcesLive,
  resolveResourceOutputs: vi.fn(),
  fetchLocalMetricSeries: vi.fn(),
}));

vi.mock("../../src/plugins/loader", () => ({ getPlugin: local.getPlugin }));

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
let cwd = "";
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "iw-cli-exports-"));
  cwd = process.cwd();
  process.chdir(dir);
});
afterAll(() => {
  process.chdir(cwd);
  rmSync(dir, { recursive: true, force: true });
});
const read = (name: string) => readFileSync(join(dir, name), "utf8");

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
 * now prints the command's help above the same sentence, and a failed export
 * job now exits 1 where the legacy runner's `process.exitCode` was lost.
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
  }).toMatchSnapshot(`${code} $ infrawrench ${argv.join(" ")}`);
}

// ---------------------------------------------------------------------------
// exports
// ---------------------------------------------------------------------------

const costExport = (over: Record<string, unknown>) => ({
  id: "ce1",
  name: "Nightly S3",
  format: "csv",
  schema: "focus-1.4",
  query: { version: 1, dimensions: ["provider"], tagKeys: [], filters: [] },
  cadence: "daily",
  hour: 4,
  timezone: "Europe/Berlin",
  restatementDays: 7,
  enabled: true,
  destination: {
    kind: "s3",
    bucket: "costs",
    prefix: "exports/",
    region: "eu-west-1",
    endpoint: "",
    forcePathStyle: false,
  },
  hasCredentials: true,
  credentialHint: null,
  lastRunAt: "2026-11-08T04:00:00.000Z",
  lastStatus: "succeeded",
  lastError: null,
  lastObjectCount: 3,
  lastRowCount: 420,
  nextRunAt: null,
  createdByUserId: null,
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
  ...over,
});

const EXPORTS = [
  costExport({}),
  costExport({
    id: "ce2",
    name: "Webhook",
    format: "ndjson",
    schema: "native",
    hour: 23,
    destination: { kind: "http", method: "POST", urlHint: "hooks.example.com/…a7f2" },
    lastStatus: "failed",
    lastError: "403 Forbidden from hooks.example.com",
    restatementDays: 0,
  }),
  costExport({
    id: "ce3",
    name: "Warehouse",
    destination: {
      kind: "warehouse",
      pluginId: "snowflake",
      accountId: "sf1",
      target: { database: "ANALYTICS", schema: "PUBLIC", table: "COSTS" },
    },
    lastStatus: "pending",
    enabled: false,
  }),
  costExport({
    id: "ce4",
    name: "Nightly old",
    schema: undefined,
    restatementDays: 0,
    lastStatus: "pending",
    lastObjectCount: null,
    lastRowCount: null,
  }),
];

const RUN = {
  exportId: "ce1",
  status: "succeeded",
  objects: [
    {
      periodStart: "2026-11-07",
      from: "2026-11-07",
      to: "2026-11-07",
      key: "exports/2026-11-07.csv",
      rowCount: 120,
      byteCount: 900,
    },
  ],
  rowCount: 120,
  collectionWatermark: "2026-11-07",
  error: null,
};

const targetField = (over: Record<string, unknown>) => ({
  key: "database",
  label: "Database",
  description: null,
  dependsOn: [],
  optional: false,
  allowCustom: false,
  placeholder: null,
  emptyLabel: null,
  ...over,
});

const SINKS = {
  sinks: [
    {
      pluginId: "snowflake",
      displayName: "Snowflake",
      label: "Snowflake table",
      description: null,
      targetFields: [
        targetField({}),
        targetField({ key: "schema", label: "Schema" }),
        targetField({ key: "table", label: "Table", allowCustom: true }),
        targetField({ key: "warehouse", label: "Warehouse", optional: true }),
      ],
      accounts: [{ id: "sf1", name: "Snow" }],
    },
    {
      pluginId: "databricks",
      displayName: "Databricks",
      label: "Databricks table",
      description: null,
      targetFields: [targetField({ key: "catalog", label: "Catalog" })],
      accounts: [],
    },
    {
      pluginId: "bigquery",
      displayName: "BigQuery",
      label: "BigQuery table",
      description: null,
      targetFields: [],
      accounts: [
        { id: "bq1", name: "One" },
        { id: "bq2", name: "Two" },
      ],
    },
  ],
};

const exportsRoutes = {
  "GET /cost-exports": EXPORTS,
  "POST /cost-exports/ce1/run": RUN,
  "POST /cost-exports/ce3/run": { ...RUN, exportId: "ce3", collectionWatermark: null },
  "POST /cost-exports/ce2/run": {
    ...RUN,
    status: "failed",
    objects: [],
    rowCount: 0,
    error: "403 Forbidden",
  },
  "GET /cost-exports/warehouse-sinks": SINKS,
  "POST /cost-exports": costExport({
    id: "ce9",
    name: 'Finance "daily"',
    destination: EXPORTS[2]?.destination,
  }),
  "POST /cost-exports/warehouse-setup": {
    sql: "GRANT USAGE ON DATABASE ANALYTICS TO ROLE INFRAWRENCH;\nGRANT INSERT ON TABLE COSTS TO ROLE INFRAWRENCH;",
    notes: ["Run as ACCOUNTADMIN", "The role needs a warehouse"],
  },
};

describe("exports", () => {
  it("lists exports and runs one like the legacy command", async () => {
    serve(exportsRoutes);
    await same(["exports"], 0);
    await same(["exports", "--json"], 0);
    await same(["exports", "run", "nightly", "s3"], 0);
    await same(["exports", "run", "ce1", "--json"], 0);
    await same(["exports", "run", "Warehouse"], 0);
    await same(["exports", "run", "webhook"], 1);
    await same(["exports", "run", "webhook", "--json"], 1);
    await same(["exports", "run", "nightly"], 1);
    await same(["exports", "run", "nope"], 1);
    await same(["exports", "run"], 1);
    await same(["exports", "--local"], 1);
    serve({ "GET /cost-exports": [] });
    await same(["exports"], 0);
    // An unknown verb is a parse error with the command's help, exit 2.
    await same(["exports", "rerun", "x"], 2);
  });

  it("lists warehouses and prints a warehouse export's grants", async () => {
    serve(exportsRoutes);
    await same(["exports", "warehouses"], 0);
    await same(["exports", "warehouses", "--json"], 0);
    await same(["exports", "setup", "warehouse"], 0);
    await same(["exports", "setup", "ce3", "--json"], 0);
    await same(["exports", "setup", "webhook"], 1);
    await same(["exports", "setup"], 1);
  });

  it("creates a warehouse export", async () => {
    serve(exportsRoutes);
    const full = [
      "exports",
      "create",
      "--name",
      " Finance ",
      "--plugin",
      "snowflake",
      "--target",
      "database=ANALYTICS",
      "--target",
      "schema = PUBLIC",
      "--target",
      "table=COSTS",
      "--cadence",
      "weekly",
      "--hour",
      "6",
      "--timezone",
      "Europe/London",
      "--restatement-days",
      "14",
      "--dimensions",
      "provider, service",
    ];
    await same(full, 0);
    await same([...full, "-a", "snow", "--json"], 0);
    const base = ["exports", "create", "--name", "F", "--plugin", "snowflake"];
    await same(
      [...base, "--target", "database=A", "--target", "schema=B", "--target", "table=C"],
      0,
    );
    await same(["exports", "create", "--plugin", "snowflake"], 2);
    await same(["exports", "create", "--name", "F", "--plugin", "redshift"], 2);
    await same(["exports", "create", "--name", "F", "--plugin", "databricks"], 2);
    await same(["exports", "create", "--name", "F", "--plugin", "bigquery"], 2);
    await same([...base, "-a", "nope"], 2);
    await same([...base, "--target", "oops"], 2);
    await same([...base, "--target", "region=eu"], 2);
    await same([...base, "--target", "database=A"], 2);
    await same(
      [
        ...base,
        "--target",
        "database=A",
        "--target",
        "schema=B",
        "--target",
        "table=C",
        "--cadence",
        "hourly",
      ],
      2,
    );
    await same(
      [
        ...base,
        "--target",
        "database=A",
        "--target",
        "schema=B",
        "--target",
        "table=C",
        "--dimensions",
        "tag",
      ],
      2,
    );
  });
});

// ---------------------------------------------------------------------------
// export --format focus
// ---------------------------------------------------------------------------

const REPORTS = [
  {
    id: "r1",
    name: "Platform spend",
    config: {
      dateRange: { kind: "relative", preset: "mtd" },
      filters: [{ dimension: "provider", operator: "in", values: ["aws"] }],
      savedFilterId: null,
    },
  },
  {
    id: "r2",
    name: "Q3 production",
    config: {
      dateRange: { kind: "absolute", from: "2026-07-01", to: "2026-09-30" },
      filters: [],
      savedFilterId: "sf1",
    },
  },
];

const SAVED_FILTERS = [
  {
    id: "sf1",
    name: "Prod only",
    filters: [{ dimension: "account", operator: "in", values: ["a1"] }],
  },
  { id: "sf2", name: "EU", filters: [] },
];

const FOCUS_CSV =
  "BilledCost,ChargePeriodStart,BillingCurrency\n1.5,2026-11-01,USD\n2.5,2026-11-02,USD\n";

const focusRoutes = {
  "GET /cost-reports": REPORTS,
  "GET /saved-cost-filters": SAVED_FILTERS,
  "POST /costs/focus-export": new RawResponse(200, FOCUS_CSV),
};

describe("export --format focus", () => {
  it("writes the CSV to stdout and to --out", async () => {
    serve(focusRoutes);
    await same(["export", "--format", "focus"], 0);
    await same(["export", "--format", "focus", "--json"], 0);
    await same(
      [
        "export",
        "--format",
        "focus",
        "--last",
        "7d",
        "--where",
        "provider = 'aws'",
        "--filter",
        "EU",
        "--charge-type",
        "usage",
        "--focus-version",
        "1.3",
      ],
      0,
    );
    await same(["export", "--format", "focus", "platform", "spend"], 0);
    await same(["export", "--format", "focus", "Q3", "--from", "2026-08-01", "--json"], 0);
    await same(["export", "--format", "focus", "Q3", "--filter", "prod only"], 0);
    await same(["export", "--format", "focus", "--out", "focus.csv"], 0);
    expect(read("focus.csv")).toBe(FOCUS_CSV);
    await same(["export", "--format", "focus", "-f", "f2.csv", "--to", "2026-10-31"], 0);
    expect(read("f2.csv")).toBe(FOCUS_CSV);
  });

  it("refuses in the legacy words", async () => {
    serve(focusRoutes);
    await same(["export", "--format", "focus", "--focus-version", "2.0"], 2);
    await same(["export", "--format", "focus", "Q3", "--filter", "eu"], 2);
    await same(["export", "--format", "focus", "--where", "provider ="], 2);
    await same(["export", "--format", "focus", "--filter", "nope"], 2);
    await same(["export", "--format", "focus", "nope"], 1);
    await same(["export", "--format", "focus", "--local"], 1);
    await same(["export", "--format", "focus", "--charge-type", "fees"], 2);
  });
});

// ---------------------------------------------------------------------------
// export --async and export jobs
// ---------------------------------------------------------------------------

const job = (over: Record<string, unknown>) => ({
  id: "j1aaaaaaaaaa",
  status: "queued",
  format: "csv",
  focusVersion: null,
  from: "2026-10-10",
  to: "2026-11-08",
  source: { kind: "query", reportId: null, reportName: null, unitCostMetric: null },
  progress: 0,
  rowCount: 0,
  byteCount: 0,
  error: null,
  fileName: "costs-2026-10-10-to-2026-11-08.csv",
  contentType: "text/csv",
  createdAt: "2026-11-08T12:00:00.000Z",
  startedAt: null,
  finishedAt: null,
  expiresAt: null,
  downloadUrl: null,
  ...over,
});

const DONE = job({ status: "succeeded", progress: 1, rowCount: 42 });
const JOB_CSV = "date,provider,cost\n2026-11-01,aws,1.5\n";

const jobRoutes = {
  "GET /cost-reports": REPORTS,
  "GET /saved-cost-filters": SAVED_FILTERS,
  "POST /costs/exports/jobs": job({}),
  "GET /costs/exports/jobs/j1aaaaaaaaaa": DONE,
  "GET /costs/exports/jobs/j1aaaaaaaaaa/download": new RawResponse(200, JOB_CSV, {
    "content-type": "text/csv",
  }),
  "GET /costs/exports/jobs": {
    jobs: [
      DONE,
      job({
        id: "j2bbbbbbbbbb",
        status: "running",
        progress: 0.42,
        format: "focus",
        focusVersion: "1.4",
        source: {
          kind: "report",
          reportId: "r1",
          reportName: "Platform spend",
          unitCostMetric: null,
        },
      }),
      job({ id: "j3cccccccccc", status: "failed", error: "query timed out" }),
      job({ id: "j2bbbbzzzzzz", status: "cancelled", format: "ndjson" }),
    ],
  },
  "DELETE /costs/exports/jobs/j2bbbbbbbbbb": job({ id: "j2bbbbbbbbbb", status: "cancelled" }),
};

describe("export --async and export jobs", () => {
  it("queues jobs like the legacy command", async () => {
    serve(jobRoutes);
    await same(["export", "--async"], 0);
    await same(["export", "--async", "--json"], 0);
    await same(
      [
        "export",
        "--async",
        "--format",
        "focus",
        "--focus-version",
        "1.3",
        "--where",
        "provider = 'aws'",
        "--filter",
        "eu",
        "--charge-type",
        "credit",
        "--dimensions",
        "service, account",
        "--last",
        "3m",
      ],
      0,
    );
    await same(
      ["export", "--async", "--format", "ndjson", "platform", "spend", "--from", "2026-01-01"],
      0,
    );
    await same(["export", "--async", "--format", "xml"], 2);
    await same(["export", "--async", "--focus-version", "1.3"], 2);
    await same(["export", "--async", "platform", "spend", "--where", "provider = 'aws'"], 2);
    await same(["export", "--async", "--local"], 1);
  });

  it("follows a job with --wait and writes its file", async () => {
    serve({ ...jobRoutes, "POST /costs/exports/jobs": DONE });
    await same(["export", "--async", "--wait"], 0);
    await same(["export", "--async", "--wait", "--out", "job.csv"], 0);
    expect(read("job.csv")).toBe(JOB_CSV);
    await same(["export", "--async", "--wait", "--json"], 0);
    await same(["export", "--async", "--wait", "--json", "--out", "job2.csv"], 0);
    serve(jobRoutes);
    await same(["export", "--async", "--wait"], 0);
  });

  it("fails with exit 1 when the job fails", async () => {
    serve({
      ...jobRoutes,
      "POST /costs/exports/jobs": job({ status: "failed", error: "too big" }),
    });
    await same(["export", "--async"], 1);
    await same(["export", "--async", "--json"], 1);
    await same(["export", "jobs", "j3"], 1);
    await same(["export", "jobs", "j3", "--json"], 1);
  });

  it("lists, shows and cancels jobs", async () => {
    serve(jobRoutes);
    await same(["export", "jobs"], 0);
    await same(["export", "jobs", "--json"], 0);
    await same(["export", "jobs", "j1"], 0);
    await same(["export", "jobs", "j1", "--wait", "-f", "job3.csv"], 0);
    expect(read("job3.csv")).toBe(JOB_CSV);
    await same(["export", "jobs", "j2bbbbbbbbbb"], 0);
    await same(["export", "jobs", "j2bbbbbbbbbb", "cancel"], 0);
    await same(["export", "jobs", "j2bbbbbbbbbb", "cancel", "--json"], 0);
    await same(["export", "jobs", "j2"], 2);
    await same(["export", "jobs", "nope"], 2);
    await same(["export", "jobs", "j1", "pause"], 2);
    serve({ "GET /costs/exports/jobs": { jobs: [] } });
    await same(["export", "jobs"], 0);
  });
});

// ---------------------------------------------------------------------------
// export --format terraform
// ---------------------------------------------------------------------------

const CLOUD_ACCOUNTS = [
  { id: "acc_2", pluginId: "aws", displayName: "prod", createdAt: "2026-01-01T00:00:00Z" },
  { id: "acc_3", pluginId: "github", displayName: "code", createdAt: "2026-01-01T00:00:00Z" },
];

const cloudRow = (id: string, typeId: string, name: string, parent: string | null = null) => ({
  id,
  pluginId: "aws",
  resourceTypeId: typeId,
  accountId: "acc_2",
  displayName: name,
  externalId: id.split(":")[2],
  fieldsJson: { size: "t3.small", count: 2, public: false, tags: { env: "prod" } },
  outputsJson: { ip: "10.0.0.1", ports: [80] },
  parentResourceId: parent,
});

const terraformRoutes = {
  "GET /accounts": CLOUD_ACCOUNTS,
  "POST /accounts/acc_2/sync": { synced: 3 },
  "GET /accounts/acc_2/resources": [
    cloudRow("acc_2:ec2-instance:i-2", "ec2-instance", "web-2"),
    cloudRow("acc_2:ebs-volume:v-1", "ebs-volume", "data", "acc_2:ec2-instance:i-2"),
    cloudRow("acc_2:s3-bucket:assets", "s3-bucket", "assets"),
  ],
};

/** A Terraform mapping for instances and volumes, not buckets, so both halves of the outcome show. */
const awsPlugin = {
  plugin: {
    terraformExport: {
      provider: { name: "aws", source: "hashicorp/aws", version: "~> 5.0" },
      providerConfig: {},
      variables: [],
      supportedResourceTypeIds: ["ec2-instance", "ebs-volume"],
      mapResource: (resource: {
        resourceTypeId: string;
        externalId?: string;
        displayName: string;
      }) =>
        resource.displayName === "data"
          ? null
          : {
              resource: {
                type: `aws_${resource.resourceTypeId.replace("-", "_")}`,
                name: resource.displayName.replace("-", "_"),
                attributes: { tags: { kind: "map", entries: {} } },
                importId: resource.externalId,
              },
            },
    },
  },
};

describe("export --format terraform", () => {
  it("ejects an account's inventory like the legacy command", async () => {
    serve(terraformRoutes);
    local.getPlugin.mockImplementation(async (id: string) =>
      id === "aws" ? awsPlugin : id === "github" ? { plugin: {} } : null,
    );
    await same(["export", "-a", "prod"], 0);
    await same(["export", "-a", "prod", "--json"], 0);
    await same(["export", "--format", "terraform", "-a", "acc_2"], 0);
    await same(["export", "-a", "code"], 1);
    await same(["export", "--format", "pulumi", "-a", "prod"], 2);
    await same(["export"], 1);
    local.getPlugin.mockImplementation(async () => null);
    await same(["export", "-a", "prod"], 1);
  });
});
