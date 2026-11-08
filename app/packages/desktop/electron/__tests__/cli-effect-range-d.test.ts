import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// `savings` (with `log`, `findings`, `findings set` and `views`), `dora` and
// `currency` on effect/cli: text and `--json` output, refusals and exit
// codes, against fixtures. Nothing reaches a network or a database.
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

const pretty = (value: unknown) => `${JSON.stringify(value, null, 2)}\n`;

const reset = () => {
  out.stdout = "";
  out.stderr = "";
};

// ---------------------------------------------------------------------------
// savings
// ---------------------------------------------------------------------------

const bucket = (key: string, label: string, realized: number) => ({
  key,
  label,
  currency: "USD",
  realized,
  projected: realized * 1.5,
  events: 1,
});

const savingsEvent = (title: string, over: Record<string, unknown>) => ({
  id: title,
  kind: "rightsizing",
  source: "app",
  title,
  note: null,
  occurredOn: "2026-09-01",
  endedOn: null,
  accountId: null,
  accountName: null,
  pluginId: null,
  resourceTypeId: null,
  resourceId: null,
  resourceName: null,
  costCentreId: null,
  projectedMonthlyAmount: 120,
  currency: "USD",
  horizonMonths: 12,
  costAnnotationId: null,
  createdByUserId: null,
  createdAt: "2026-09-01T00:00:00.000Z",
  updatedAt: "2026-09-01T00:00:00.000Z",
  basis: "billing",
  status: "active",
  realizedCurrency: "USD",
  baselinePerDay: 10,
  currentPerDay: 6,
  realizedToDate: 200,
  realizedInRange: 180,
  projectedInRange: 240,
  accruedDays: 60,
  horizonEndsOn: null,
  attributedCostCentreId: null,
  attributedCostCentreName: null,
  shortfall: null,
  editable: "full",
  ...over,
});

const REALIZED = {
  from: "2025-11-01",
  to: "2026-11-07",
  settings: { horizonMonths: 12, shortfallThresholdPercent: 50, baselineWindowDays: 14 },
  totals: [
    { currency: "USD", realized: 380, projected: 500 },
    { currency: "EUR", realized: 5, projected: 0 },
  ],
  byMonth: [
    { month: "2026-09", currency: "USD", realized: 180, projected: 240 },
    { month: "2026-10", currency: "USD", realized: 200, projected: 260 },
  ],
  byKind: [bucket("rightsizing", "Right-sizing", 300), bucket("brand_new", "New", 80)],
  byCostCentre: [bucket("cc1", "Platform", 380)],
  byAccount: [bucket("acc_1", "prod", 380)],
  events: [
    savingsEvent("Resize api", {}),
    savingsEvent("Delete old disks", {
      kind: "orphan_deletion",
      basis: "estimate",
      shortfall: { kind: "grew_back", realizedPerDay: 1, projectedPerDay: 4 },
    }),
    savingsEvent("CDN contract", {
      kind: "manual",
      basis: "unmeasured",
      realizedInRange: null,
      projectedMonthlyAmount: null,
      shortfall: { kind: "below_projection", realizedPerDay: 1, projectedPerDay: 2 },
    }),
  ],
  shortfallCount: 1,
  unmeasuredCount: 1,
};

const money = (amount: number, currency = "USD") => ({ amount, currency });

const finding = (key: string, over: Record<string, unknown>) => ({
  key,
  kind: "orphan",
  sourceId: key,
  title: `Unattached volume ${key}`,
  detail: null,
  pluginId: "aws",
  pluginName: "AWS",
  accountId: "acc_1",
  accountName: "prod",
  region: "us-east-1",
  resourceId: null,
  resourceName: key,
  resourceTypeId: null,
  resourceTypeName: null,
  tags: {},
  monthlySavings: money(42),
  status: "ready",
  statusChangedAt: null,
  statusChangedBy: null,
  statusNote: null,
  resolution: null,
  detectedAt: "2026-10-01T08:00:00.000Z",
  lastSeenAt: "2026-11-08T08:00:00.000Z",
  present: true,
  realizedSavings: null,
  ...over,
});

const FINDINGS = {
  findings: [
    finding("orphan:v1", {}),
    finding("oversized:i1", {
      kind: "oversized",
      status: "in_progress",
      statusNote: "ticket OPS-1",
      monthlySavings: null,
    }),
    finding("seat:u1", {
      kind: "seat",
      status: "completed",
      resolution: "resolved",
      accountName: null,
    }),
  ],
  summary: {
    counts: { ready: 4, in_progress: 1, completed: 3, archived: 0 },
    potentialMonthly: [money(500), money(20, "EUR")],
    unpricedOpenCount: 2,
    realized: [money(80)],
    realizedWindowDays: 30,
    savingsRate: [{ currency: "USD", rate: 0.137 }],
  },
  unavailable: [{ kind: "extended_support", error: "Catalog unavailable" }],
  generatedAt: "2026-11-08T12:00:00.000Z",
};

const VIEWS = [
  {
    id: "v1",
    name: "Prod waste",
    description: null,
    status: "open",
    filter: {
      kinds: ["orphan", "oversized"],
      pluginIds: ["aws"],
      accountIds: ["acc_1", "acc_2"],
      regions: ["us-east-1"],
      tags: [{ key: "env", values: ["prod"] }, { key: "team" }],
      minMonthlySavings: 50,
      detectedFrom: "2026-01-01",
      detectedTo: null,
      search: "volume",
    },
    sort: { field: "savings", direction: "desc" },
    createdByUserId: null,
    createdAt: "2026-10-01T00:00:00.000Z",
    updatedAt: "2026-10-01T00:00:00.000Z",
  },
  {
    id: "v2",
    name: "Everything",
    description: null,
    status: "in_progress",
    filter: {},
    sort: { field: "name", direction: "asc" },
    createdByUserId: null,
    createdAt: "2026-10-01T00:00:00.000Z",
    updatedAt: "2026-10-01T00:00:00.000Z",
  },
];

const ACCOUNTS = [
  { id: "acc_1", pluginId: "aws", displayName: "prod", createdAt: "2026-01-01T00:00:00Z" },
];

describe("savings", () => {
  it("prints the realized report by month and by a grouping", async () => {
    serveRoutes(out, {
      "GET /savings/realized": REALIZED,
      "GET /savings/realized?from=2026-01-01&to=2026-06-30": REALIZED,
    });
    expect(await run("savings")).toBe(0);
    // `savings` formats money in the machine's locale; en-GB writes US$.
    expect(out.stdout.replaceAll("US$", "$")).toMatchInlineSnapshot(`
      "Acme · realized savings 2025-11-01 → 2026-11-07 · horizon 12 months

      $380 realized of $500 projected (76%)
      €5.00 realized of €0.00 projected

      by month (USD)
      2026-09 ███████████████████████████░░░ $180 / $240
      2026-10 ██████████████████████████████ $200 / $260

      SINCE       ACTION            TYPE            PROJECTED/MO  REALIZED      BASIS       NOTE               
      2026-09-01  Resize api        right-sizing    $120        $180        billing     active             
      2026-09-01  Delete old disks  orphan cleanup  $120        $180        estimate    grew back          
      2026-09-01  CDN contract      manual          —             not measured  unmeasured  short of projection

      1 action(s) realizing less than projected.
      1 action(s) not measurable yet (not counted).
      "
    `);
    reset();
    expect(
      await run("savings", "--group-by", "kind", "--from", "2026-01-01", "--to", "2026-06-30"),
    ).toBe(0);
    reset();
    expect(await run("savings", "--group-by", "cost-centre")).toBe(0);
    expect(out.stdout).toContain("by cost centre (USD)");
    reset();
    expect(await run("savings", "--group-by", "account", "--json")).toBe(0);
    expect(out.stdout).toBe(pretty({ org: "org_1", ...REALIZED }));
  });

  it("says when nothing is recorded, and refuses a bad --group-by", async () => {
    serveRoutes(out, { "GET /savings/realized": { ...REALIZED, events: [] } });
    expect(await run("savings")).toBe(0);
    reset();
    expect(await run("savings", "--group-by", "team")).toBe(2);
    expect(out.stderr).toContain(
      '--group-by must be month, kind, cost-centre or account, got "team"',
    );
  });

  it("logs a saving", async () => {
    const created = savingsEvent("Cancelled the old CDN", {
      kind: "manual",
      projectedMonthlyAmount: 120,
      currency: "EUR",
      occurredOn: "2026-11-01",
    });
    serveRoutes(out, { "POST /savings/events": created });
    expect(
      await run(
        "savings",
        "log",
        "Cancelled",
        "the old CDN",
        "--amount",
        "120",
        "--currency",
        "eur",
        "--from",
        "2026-11-01",
        "--note",
        "hi",
        "--resource",
        "r1",
      ),
    ).toBe(0);
    expect(out.stdout).toMatchInlineSnapshot(`
      "Logged Cancelled the old CDN · €120/mo from 2026-11-01
      "
    `);
    reset();
    expect(await run("savings", "log", "x", "--amount", "5", "--json")).toBe(0);
    expect(out.stdout).toBe(pretty({ org: "org_1", event: created }));
  });

  it("refuses a log with no title or a bad amount", async () => {
    expect(await run("savings", "log", "--amount", "5")).toBe(2);
    reset();
    expect(await run("savings", "log", "x")).toBe(2);
    reset();
    expect(await run("savings", "log", "x", "--amount", "0")).toBe(2);
  });

  it("lists findings, filtered", async () => {
    serveRoutes(out, {
      "GET /savings/findings?status=open": FINDINGS,
      "GET /accounts": ACCOUNTS,
      "GET /savings/findings?view=Prod+waste&kind=orphan%2Cseat&provider=aws&region=us-east-1&account=acc_1&tag=env%3Dprod&minSavings=10&detectedFrom=2026-01-01&detectedTo=2026-11-01&q=vol&sort=name%3Aasc":
        {
          ...FINDINGS,
          findings: [],
          unavailable: [],
          summary: {
            ...FINDINGS.summary,
            realized: null,
            savingsRate: null,
            unpricedOpenCount: 0,
            potentialMonthly: [],
          },
        },
    });
    expect(await run("savings", "findings")).toBe(0);
    expect(out.stdout).toMatchInlineSnapshot(`
      "Acme · 3 findings · open
      $500.00 + €20.00/mo potential   $80.00 realized in 30d   14% savings rate
      4 ready · 1 in progress · 3 completed · 0 archived · 2 open unpriced
      extended support findings could not be computed: Catalog unavailable

      KEY           FINDING                         KIND         ACCOUNT  SAVES/MO  DETECTED    STATUS                    
      orphan:v1     Unattached volume orphan:v1     orphaned     prod       $42.00  2026-10-01  ready for review          
      oversized:i1  Unattached volume oversized:i1  oversized    prod            ?  2026-10-01  in progress · ticket OPS-1
      seat:u1       Unattached volume seat:u1       unused seat             $42.00  2026-10-01  completed (auto)          

      Change a status: infrawrench savings findings set <key>... --status in_progress
      "
    `);
    reset();
    expect(await run("savings", "findings", "--json")).toBe(0);
    reset();
    expect(
      await run(
        "savings",
        "findings",
        "--view",
        "Prod waste",
        "--kind",
        "orphan, seat",
        "--provider",
        "aws",
        "--region",
        "us-east-1",
        "-a",
        "prod",
        "--tag",
        "env=prod",
        "--min-savings",
        "10",
        "--from",
        "2026-01-01",
        "--to",
        "2026-11-01",
        "--search",
        "vol",
        "--sort",
        "name",
      ),
    ).toBe(0);
    expect(out.stdout).toMatchInlineSnapshot(`
      "Acme · 0 findings
      none/mo potential
      4 ready · 1 in progress · 3 completed · 0 archived

      (none)
      "
    `);
  });

  it("refuses bad finding filters with the legacy sentences", async () => {
    expect(await run("savings", "findings", "--status", "done")).toBe(2);
    expect(out.stderr).toContain(
      '--status must be one of open, ready, in_progress, completed, archived, all, got "done"',
    );
    reset();
    expect(await run("savings", "findings", "--kind", "orphan,idle")).toBe(2);
    expect(out.stderr).toContain(
      '--kind must be one of orphan, oversized, extended_support, seat, got "idle"',
    );
    reset();
    expect(await run("savings", "findings", "--min-savings", "lots")).toBe(2);
    expect(out.stderr).toContain('--min-savings must be a monthly amount, got "lots"');
    reset();
    expect(await run("savings", "findings", "--sort", "savings:up")).toBe(2);
    expect(out.stderr).toContain('--sort must be one of asc, desc, got "up"');
    expect(out.requests).toEqual([]);
  });

  it("sets findings' status", async () => {
    const result = {
      updated: [{ key: "orphan:v1" }, { key: "seat:u1" }],
      missing: ["orphan:gone"],
    };
    serveRoutes(out, { "POST /savings/findings/status": result });
    expect(
      await run(
        "savings",
        "findings",
        "set",
        "orphan:v1",
        "seat:u1",
        "orphan:gone",
        "--status",
        "archived",
        "--note",
        "done",
      ),
    ).toBe(0);
    expect(out.stdout).toMatchInlineSnapshot(`
      "Moved 2 findings to archived.
      Not found: orphan:gone
      "
    `);
    reset();
    expect(
      await run("savings", "findings", "set", "orphan:v1", "--status", "ready", "--json"),
    ).toBe(0);
    expect(out.stdout).toBe(pretty({ org: "org_1", ...result }));
  });

  it("refuses a set with no keys, no status or a bad status", async () => {
    expect(await run("savings", "findings", "set", "--status", "ready")).toBe(2);
    reset();
    expect(await run("savings", "findings", "set", "orphan:v1")).toBe(2);
    reset();
    expect(await run("savings", "findings", "set", "orphan:v1", "--status", "open")).toBe(2);
  });

  it("lists saved views", async () => {
    serveRoutes(out, { "GET /savings-views": VIEWS });
    expect(await run("savings", "views")).toBe(0);
    expect(out.stdout).toMatchInlineSnapshot(`
      "NAME        STATUS       FILTER                                                                                                       SORT        
      Prod waste  open         orphaned/oversized, aws, 2 account(s), us-east-1, env=prod team, >= 50/mo, detected 2026-01-01..…, "volume"  savings desc
      Everything  in progress  everything                                                                                                   name asc    

      Open one: infrawrench savings findings --view "<name>"
      "
    `);
    reset();
    expect(await run("savings", "views", "--json")).toBe(0);
    expect(out.stdout).toBe(pretty({ org: "org_1", views: VIEWS }));
    serveRoutes(out, { "GET /savings-views": [] });
    reset();
    expect(await run("savings", "views")).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// dora
// ---------------------------------------------------------------------------

const metric = (value: number | null, band: string | null, sample: number) => ({
  value,
  band,
  sample,
});

const summary = (scale: number) => ({
  deploymentFrequency: { ...metric(2 * scale, "elite", 60), deploys: 60 * scale, days: 30 },
  leadTime: { ...metric(5 / scale, "high", 40), p90Hours: 30 },
  changeFailureRate: { ...metric(0.12, "medium", 60), changes: 60, failures: 7 },
  timeToRestore: { ...metric(null, null, 0), restores: 0 },
});

const DORA = {
  from: "2026-10-09T12:00:00.000Z",
  to: "2026-11-08T12:00:00.000Z",
  bucket: "week",
  filter: { dimension: "environment", value: "production" },
  groupBy: "repository",
  summary: summary(1),
  previous: summary(0.5),
  trend: [
    {
      start: "2026-10-05",
      deploys: 10,
      changes: 10,
      failures: 1,
      restores: 0,
      leadTimeMedianHours: 4,
      changeFailureRate: 0.1,
      restoreMedianHours: null,
    },
    {
      start: "2026-10-12",
      deploys: 20,
      changes: 20,
      failures: 3,
      restores: 1,
      leadTimeMedianHours: 6,
      changeFailureRate: 0.15,
      restoreMedianHours: 2,
    },
    {
      start: "2026-10-19",
      deploys: 15,
      changes: 15,
      failures: 2,
      restores: 0,
      leadTimeMedianHours: 5,
      changeFailureRate: 0.13,
      restoreMedianHours: null,
    },
  ],
  breakdown: [
    { key: "acme/api", label: "acme/api", summary: summary(1) },
    { key: null, label: "", summary: summary(0.5) },
  ],
  dimensions: [
    { id: "environment", label: "Environment" },
    { id: "repository", label: "Repository" },
  ],
  settings: {},
  eventCount: 60,
  scopeValues: { environment: [{ key: "production", label: "Production" }] },
};

const doraChange = (name: string, over: Record<string, unknown>) => ({
  id: name,
  type: "deploy",
  name,
  environment: "production",
  repository: "acme/api",
  commitSha: "abcdef1234567",
  at: "2026-11-07T10:00:00.000Z",
  status: "success",
  source: "github",
  pluginId: null,
  url: null,
  isRollback: false,
  leadTimeHours: 3.5,
  failure: null,
  scope: {},
  ...over,
});

const CHANGES = {
  changes: [
    doraChange("api v42", {
      failure: { kind: "incident", refId: "i1", title: "500s", at: "2026-11-07T11:00:00.000Z" },
    }),
    doraChange("api v41", {
      isRollback: true,
      failure: { kind: "rollback", refId: "r", title: "", at: "" },
      pluginId: "vercel",
    }),
    doraChange("web v9", {
      environment: null,
      commitSha: null,
      leadTimeHours: null,
      failure: { kind: "failed_deploy", refId: "", title: "", at: "" },
    }),
    doraChange("web v8", { failure: { kind: "reverted", refId: "", title: "", at: "" } }),
  ],
  truncated: true,
};

const RESTORES = {
  restores: [
    {
      kind: "incident",
      id: "i1",
      title: "500s on checkout",
      startedAt: "2026-11-07T11:00:00.000Z",
      restoredAt: "2026-11-07T12:30:00.000Z",
      hours: 1.5,
      changeId: null,
    },
    {
      kind: "rollback",
      id: "r1",
      title: "api v41",
      startedAt: "2026-11-06T11:00:00.000Z",
      restoredAt: "2026-11-06T11:20:00.000Z",
      hours: 0.33,
      changeId: "c",
    },
  ],
};

const DORA_SETTINGS = {
  failureWindowHours: 24,
  productionEnvironments: ["production", "prod"],
  pipelinePatterns: [],
  countFailedDeploys: true,
  includeResourceChanges: false,
  digestEnabled: true,
  updatedAt: null,
};

describe("dora", () => {
  const q = "from=2026-10-09T12%3A00%3A00.000Z&to=2026-11-08T12%3A00%3A00.000Z";

  it("prints the four metrics with a breakdown", async () => {
    serveRoutes(out, {
      [`GET /dora?${q}&dimension=environment&value=production&groupBy=repository`]: DORA,
    });
    expect(await run("dora", "--scope", "environment=production", "--group-by", "repository")).toBe(
      0,
    );
    expect(out.stdout).toMatchInlineSnapshot(`
      "Acme · delivery · last 30 days · environment Production

      METRIC                VALUE  BAND    PREVIOUS            TREND (PER WEEK)                       
      deployment frequency  2/day  elite      1/day  ▲ better  ▁█▅               60 deploys           
      lead time                5h  high         10h  ▲ better  ▁█▅               median of 40, p90 30h
      change failure rate     12%  medium       12%  = same    ▁█▅               7 of 60 changes      
      time to restore         n/a  -            n/a            ▁█▁               0 recoveries         

      by repository
      REPOSITORY  DEPLOYS  FREQUENCY  LEAD TIME  FAILURE  RESTORE                     
      acme/api         60      2/day         5h      12%      n/a  elite high medium -
      not known        30      1/day        10h      12%      n/a  elite high medium -

      \`dora changes [--failed]\` and \`dora restores\` list what is behind the numbers.
      Scope with --scope <environment|repository>=<value>; group with --group-by.
      "
    `);
    reset();
    expect(
      await run("dora", "--scope", "environment=production", "--group-by", "repository", "--json"),
    ).toBe(0);
    expect(out.stdout).toBe(pretty({ org: "org_1", ...DORA }));
  });

  it("says when there are no deploys", async () => {
    const empty = {
      ...DORA,
      eventCount: 0,
      filter: null,
      summary: {
        ...summary(1),
        changeFailureRate: { ...metric(null, null, 0), changes: 0, failures: 0 },
      },
    };
    serveRoutes(out, {
      "GET /dora?from=2026-10-25T12%3A00%3A00.000Z&to=2026-11-08T12%3A00%3A00.000Z": empty,
    });
    expect(await run("dora", "--last", "2w")).toBe(0);
    expect(out.stdout).toMatchInlineSnapshot(`
      "Acme · delivery · last 30 days · all production

      No deploys in the range. Metrics come from Infrawrench deploys, synced provider deploys,
      CI pipelines named in the settings, GitHub deployments and POST /dora/deployments.
      "
    `);
  });

  it("lists changes and failed changes", async () => {
    serveRoutes(out, {
      [`GET /dora/changes?${q}`]: CHANGES,
      [`GET /dora/changes?${q}&failedOnly=true`]: { changes: [], truncated: false },
    });
    expect(await run("dora", "changes")).toBe(0);
    expect(out.stdout).toMatchInlineSnapshot(`
      "WHEN              CHANGE              ENV         COMMIT   LEAD TIME  SOURCE  FAILURE       
      2026-11-07 10:00  api v42             production  abcdef1       3.5h  github  incident: 500s
      2026-11-07 10:00  api v41 (rollback)  production  abcdef1       3.5h  vercel  rolled back   
      2026-11-07 10:00  web v9              -           -              n/a  github  deploy failed 
      2026-11-07 10:00  web v8              production  abcdef1       3.5h  github  reverted      
      Showing the newest 4. Narrow --last or --scope for the rest.
      "
    `);
    reset();
    expect(await run("dora", "changes", "--json")).toBe(0);
    reset();
    expect(await run("dora", "changes", "--failed")).toBe(0);
  });

  it("lists restores and settings", async () => {
    serveRoutes(out, {
      [`GET /dora/restores?${q}&dimension=owner`]: RESTORES,
      "GET /dora/settings": DORA_SETTINGS,
    });
    expect(await run("dora", "restores", "--scope", "owner")).toBe(0);
    expect(out.stdout).toMatchInlineSnapshot(`
      "RESTORED          KIND      WHAT              TOOK
      2026-11-07 12:30  incident  500s on checkout  1.5h
      2026-11-06 11:20  rollback  api v41            20m
      "
    `);
    reset();
    expect(await run("dora", "restores", "--scope", "owner", "--json")).toBe(0);
    reset();
    expect(await run("dora", "settings")).toBe(0);
    expect(out.stdout).toMatchInlineSnapshot(`
      "Delivery settings
      production environments  production, prod
      deploy pipelines         none
      failure window           24h
      failed deploys count     yes
      resource changes count   no
      weekly digest line       on

      Edit them on the Delivery tab (Settings), or with the infrawrench_dora_settings Terraform resource.
      "
    `);
    reset();
    expect(await run("dora", "settings", "--json")).toBe(0);
  });

  it("refuses a bad window, a bad scope and --local", async () => {
    expect(await run("dora", "--from", "2026-11-08", "--to", "2026-11-01")).toBe(2);
    reset();
    expect(await run("dora", "--days", "400")).toBe(2);
    reset();
    expect(await run("dora", "changes", "--scope", "=x")).toBe(2);
    reset();
    expect(await run("dora", "--local")).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// currency
// ---------------------------------------------------------------------------

const stated = (from: string, to: string, rate: string, effectiveTo: string | null) => ({
  id: `${from}${to}`,
  fromCurrency: from,
  toCurrency: to,
  rate,
  effectiveFrom: "2026-01-01",
  effectiveTo,
  createdBy: null,
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
});

const CURRENCY = {
  displayCurrency: "USD",
  autoRates: true,
  rateBasis: "month_end",
  rates: [stated("EUR", "USD", "1.08", null), stated("GBP", "USD", "1.27", "2026-06-30")],
  feed: {
    source: "ecb",
    sourceName: "European Central Bank",
    sourceUrl: "https://www.ecb.europa.eu",
    latestRateDate: "2026-11-07",
    earliestRateDate: "1999-01-04",
    currencies: ["USD", "GBP", "JPY"],
    lastSuccessAt: null,
    lastError: "timeout",
  },
};

const LOOKUP = {
  fromCurrency: "EUR",
  toCurrency: "USD",
  date: "2026-09-30",
  rateBasis: "daily",
  rate: 1.0812,
  source: "ecb",
  rateDate: "2026-09-30",
  manualRateId: null,
  explanation: "No stated rate covers that day, so the ECB reference rate applies.",
};

const FEED_RATES = {
  ...CURRENCY.feed,
  date: "2026-11-08",
  base: "USD",
  rateDate: "2026-11-07",
  rates: [
    { currency: "EUR", rate: 0.92 },
    { currency: "JPY", rate: 151.3 },
  ],
};

const importRow = (line: number, action: string, extra: Record<string, unknown> = {}) => ({
  line,
  action,
  rate: { fromCurrency: "EUR", toCurrency: "USD", rate: "1.1", effectiveFrom: "2026-10-01" },
  ...extra,
});

const PREVIEW = {
  dryRun: true,
  applied: false,
  rows: [
    importRow(2, "create"),
    importRow(3, "update", {
      previousRate: "1.05",
      rate: {
        fromCurrency: "GBP",
        toCurrency: "USD",
        rate: "1.3",
        effectiveFrom: "2026-10-01",
        effectiveTo: "2026-10-31",
      },
    }),
    importRow(4, "unchanged"),
    { line: 5, action: "error", error: "rate must be positive" },
  ],
  counts: { create: 1, update: 1, unchanged: 1, error: 1 },
  fileError: null,
};

describe("currency", () => {
  it("prints the overview", async () => {
    serveRoutes(out, { "GET /currency": CURRENCY });
    expect(await run("currency")).toBe(0);
    expect(out.stdout).toMatchInlineSnapshot(`
      "Acme · display currency USD
        automatic rates on · basis end-of-month rate
        ECB feed: latest publication 2026-11-07, history from 1999-01-04
        ! last fetch failed: timeout
        covered: USD, GBP, JPY; anything else is manual-only

      FROM  TO   RATE  FROM DATE   UNTIL     
      EUR   USD  1.08  2026-01-01  open-ended
      GBP   USD  1.27  2026-01-01  2026-06-30

      A stated rate always wins over an automatic one for the days it covers. \`infrawrench currency rate <FROM> [TO] [YYYY-MM-DD]\` shows which rate a day converts at.
      "
    `);
    reset();
    expect(await run("currency", "--json")).toBe(0);
    expect(out.stdout).toBe(pretty({ org: "org_1", ...CURRENCY }));
    serveRoutes(out, {
      "GET /currency": {
        ...CURRENCY,
        displayCurrency: null,
        autoRates: false,
        rateBasis: "daily",
        rates: [],
        feed: { ...CURRENCY.feed, latestRateDate: null, lastError: null, currencies: [] },
      },
    });
    reset();
    expect(await run("currency")).toBe(0);
  });

  it("looks up a rate", async () => {
    serveRoutes(out, {
      "GET /currency/lookup?from=EUR&to=USD&date=2026-09-30": LOOKUP,
      "GET /currency/lookup?from=GBP": {
        ...LOOKUP,
        fromCurrency: "GBP",
        rate: null,
        source: null,
        rateDate: null,
      },
    });
    expect(await run("currency", "rate", "eur", "usd", "2026-09-30")).toBe(0);
    expect(out.stdout).toMatchInlineSnapshot(`
      "EUR → USD on 2026-09-30 1.0812 (ECB reference rate, 2026-09-30)
      No stated rate covers that day, so the ECB reference rate applies.
      "
    `);
    reset();
    expect(await run("currency", "rate", "GBP")).toBe(0);
    reset();
    expect(await run("currency", "rate", "GBP", "--json")).toBe(0);
    reset();
    expect(await run("currency", "rate", "dollars")).toBe(2);
  });

  it("prints the feed for a day", async () => {
    serveRoutes(out, {
      "GET /currency/feed?date=2026-11-08&base=USD": FEED_RATES,
      "GET /currency/feed": { ...FEED_RATES, rateDate: null },
    });
    expect(await run("currency", "feed", "2026-11-08", "--currency", "usd")).toBe(0);
    expect(out.stdout).toMatchInlineSnapshot(`
      "ECB reference rates in USD for 2026-11-08 (carried from 2026-11-07)

      CURRENCY  1 UNIT IN USD
      EUR                0.92
      JPY               151.3
      "
    `);
    reset();
    expect(await run("currency", "feed")).toBe(0);
    reset();
    expect(await run("currency", "feed", "yesterday")).toBe(2);
    reset();
    expect(await run("currency", "feed", "--currency", "dollars")).toBe(2);
    expect(out.stderr).toContain(
      '--currency must be a three-letter code like USD (got "dollars").',
    );
  });

  it("prints the template as is", async () => {
    serveRoutes(out, {
      "GET /currency/rates/template": new RawResponse(200, "from,to,rate,effective_from\n"),
    });
    expect(await run("currency", "template")).toBe(0);
    expect(out.stdout).toBe("from,to,rate,effective_from\n");
  });

  describe("import", () => {
    const file = join(mkdtempSync(join(tmpdir(), "iw-currency-")), "rates.csv");
    writeFileSync(file, "from,to,rate,effective_from\nEUR,USD,1.1,2026-10-01\n");

    it("refuses a file with invalid rows, and exits 1", async () => {
      serveRoutes(out, { "POST /currency/rates/import": PREVIEW });
      expect(await run("currency", "import", file)).toBe(1);
      expect(out.stdout).toMatchInlineSnapshot(`
        "LINE  RATE             EFFECTIVE                 RESULT                     
           2  1 EUR = 1.1 USD  2026-10-01                new                        
           3  1 GBP = 1.3 USD  2026-10-01 to 2026-10-31  replaces (was 1.05)        
           4  1 EUR = 1.1 USD  2026-10-01                unchanged                  
           5                                             error rate must be positive

        1 new, 1 replace a stored rate, 1 unchanged, 1 with errors
        Nothing written: fix the rows above, or pass --skip-invalid to import the valid ones.
        "
      `);
      reset();
      expect(await run("currency", "import", file, "--json")).toBe(1);
      expect(out.stdout).toBe(pretty({ org: "org_1", ...PREVIEW }));
    });

    it("previews only without -y, and writes with it", async () => {
      serveRoutes(out, {
        "POST /currency/rates/import": { ...PREVIEW, dryRun: false, applied: true },
      });
      expect(await run("currency", "import", file, "--skip-invalid")).toBe(0);
      expect(out.stdout).toContain("Preview only. Re-run with -y to write these rates.");
      reset();
      expect(await run("currency", "import", file, "--skip-invalid", "-y")).toBe(0);
      expect(out.stdout).toContain("Imported: 1 new, 1 replaced, 1 unchanged, 1 skipped.");
      reset();
      expect(await run("currency", "import", file, "--skip-invalid", "--json")).toBe(0);
      reset();
      expect(await run("currency", "import", file, "--skip-invalid", "--yes", "--json")).toBe(0);
    });

    it("says when nothing is new", async () => {
      serveRoutes(out, {
        "POST /currency/rates/import": {
          ...PREVIEW,
          rows: [importRow(2, "unchanged")],
          counts: { create: 0, update: 0, unchanged: 1, error: 0 },
        },
      });
      expect(await run("currency", "import", file)).toBe(0);
      expect(out.stdout).toContain("Nothing to write: every rate in the file is already stored.");
    });

    it("refuses a missing or unreadable file", async () => {
      expect(await run("currency", "import")).toBe(2);
      reset();
      expect(await run("currency", "import", "/nonexistent/rates.csv")).toBe(1);
    });
  });

  it("refuses --local everywhere", async () => {
    for (const verb of [[], ["rate", "EUR"], ["feed"], ["template"], ["import", "x.csv"]]) {
      reset();
      expect(await run("currency", ...verb, "--local")).toBe(1);
    }
  });
});
