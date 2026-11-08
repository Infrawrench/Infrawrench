import { describe, expect, it, vi } from "vitest";

// `paging`, `seats`, `diff` and `posture` on effect/cli: text and `--json`
// output, scopes, refusals and exit codes, against fixtures. Nothing reaches
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

const local = vi.hoisted(() => ({
  accounts: [
    { id: "loc_1", plugin_id: "aws", display_name: "staging" },
    { id: "loc_2", plugin_id: "aws", display_name: "prod" },
  ],
  diff: vi.fn(),
  posture: vi.fn(),
  dismiss: vi.fn(),
  restore: vi.fn(),
  confirm: vi.fn(async (_message: string) => true),
}));

vi.mock("../main-utils", async (original) => ({
  ...(await original<typeof import("../main-utils")>()),
  getDb: async () => ({ select: async () => local.accounts }),
}));
vi.mock("../local-environment-diff", () => ({ computeLocalEnvironmentDiff: local.diff }));
vi.mock("../local-posture", () => ({
  listLocalPosture: local.posture,
  dismissLocalPostureFinding: local.dismiss,
  restoreLocalPostureFinding: local.restore,
}));
vi.mock("../cli/effect/prompt", async () => {
  const { Effect } = await import("effect");
  return { confirm: (message: string) => Effect.promise(() => local.confirm(message)) };
});

import { RawResponse, run, serveRoutes, useCliCapture } from "./cli-harness";

const out = useCliCapture();

/** One command line, its output on its own: a test may run several. */
const cli = (...argv: string[]) => {
  out.stdout = "";
  out.stderr = "";
  return run(...argv);
};

const pretty = (value: unknown) => `${JSON.stringify(value, null, 2)}\n`;

// ---------------------------------------------------------------------------
// paging
// ---------------------------------------------------------------------------

const incident = (id: string, status: string, reference: string | null, title: string) => ({
  id,
  accountId: "pd_1",
  accountName: "PagerDuty",
  pluginId: "pagerduty",
  externalId: `ext-${id}`,
  reference,
  title,
  status,
  statusLabel: null,
  urgency: "high",
  url: null,
  serviceName: id === "i1" ? "checkout" : null,
  assignees:
    id === "i1"
      ? [
          { name: "Ada", email: null },
          { name: null, email: "bo@x.io" },
        ]
      : [],
  createdAt: "2026-11-08T10:00:00.000Z",
  updatedAt: null,
  resolvedAt: null,
  fromInfrawrench: false,
  canAcknowledge: true,
  canResolve: true,
});

const INCIDENTS = [
  incident("i1", "triggered", "#1234", "Checkout 500s"),
  incident("i2", "acknowledged", "INC-56", "Queue lag"),
  incident("i3", "paused", null, "A newer status"),
];

const EVENTS = [
  {
    id: "e1",
    accountId: "pd_1",
    targetId: "t1",
    dedupKey: "k",
    trigger: "budget",
    title: "Budget over",
    state: "triggered",
    pendingAction: "resolve",
    attempts: 2,
    lastError: "timeout",
    createdAt: "2026-11-08T09:00:00.000Z",
    updatedAt: "2026-11-08T09:30:00.000Z",
    sentAt: null,
  },
  {
    id: "e2",
    accountId: "pd_1",
    targetId: "t1",
    dedupKey: "k2",
    trigger: "probe",
    title: "Probe down",
    state: "resolved",
    pendingAction: null,
    attempts: 0,
    lastError: null,
    createdAt: "2026-11-08T08:00:00.000Z",
    updatedAt: "2026-11-08T08:30:00.000Z",
    sentAt: "2026-11-08T08:00:01.000Z",
  },
];

describe("paging", () => {
  it("lists open incidents, an unknown status reading as resolved", async () => {
    serveRoutes(out, { "GET /paging-incidents": { incidents: INCIDENTS } });
    expect(await cli("paging")).toBe(0);
    expect(out.stdout).toMatchInlineSnapshot(`
      "                REF     INCIDENT        PROVIDER   SERVICE   ASSIGNED      OPENED          
      ● triggered     #1234   Checkout 500s   PagerDuty  checkout  Ada, bo@x.io  2026-11-08 10:00
      ● acknowledged  INC-56  Queue lag       PagerDuty  —         —             2026-11-08 10:00
      ○ resolved      —       A newer status  PagerDuty  —         —             2026-11-08 10:00

      \`infrawrench paging ack <ref>\` / \`paging resolve <ref>\` writes back to the provider as you.
      "
    `);
  });

  it("--all asks for resolved ones too, and says when there are none", async () => {
    serveRoutes(out, { "GET /paging-incidents?status=all": { incidents: [] } });
    expect(await cli("paging", "--all")).toBe(0);
    expect(out.stdout).toMatchInlineSnapshot(`
      "No provider incidents mirrored. Turn mirroring on per account under Settings → On-call.
      "
    `);
    serveRoutes(out, { "GET /paging-incidents": { incidents: [] } });
    expect(await cli("paging")).toBe(0);
  });

  it("prints the incidents under --json", async () => {
    serveRoutes(out, { "GET /paging-incidents": { incidents: INCIDENTS } });
    expect(await cli("paging", "--json")).toBe(0);
    expect(out.stdout).toBe(pretty({ org: "org_1", incidents: INCIDENTS }));
  });

  it("acknowledges and resolves by reference, provider id or id", async () => {
    const routes = {
      "GET /paging-incidents?status=all": { incidents: INCIDENTS },
      "POST /paging-incidents/i1/acknowledge": { ...INCIDENTS[0], status: "acknowledged" },
      "POST /paging-incidents/i2/resolve": { ...INCIDENTS[1], status: "resolved" },
    };
    serveRoutes(out, routes);
    expect(await cli("paging", "ack", "1234")).toBe(0);
    expect(out.stdout).toMatchInlineSnapshot(`
      "● acknowledged  #1234 Checkout 500s (PagerDuty)
      "
    `);
    expect(await cli("paging", "acknowledge", "ext-i1", "--json")).toBe(0);
    expect(out.stdout).toBe(pretty({ ...INCIDENTS[0], status: "acknowledged" }));
    expect(await cli("paging", "resolve", "inc-56")).toBe(0);
  });

  it("refuses an unmatched or missing target", async () => {
    serveRoutes(out, { "GET /paging-incidents?status=all": { incidents: INCIDENTS } });
    expect(await cli("paging", "ack", "nope")).toBe(1);
    expect(out.stderr).toMatchInlineSnapshot(`
      "No provider incident matches "nope". Run \`infrawrench paging\` to list.
      "
    `);
    expect(await cli("paging", "acknowledge")).toBe(1);
    expect(out.stderr).toMatchInlineSnapshot(`
      "Usage: infrawrench paging acknowledge <id|reference>
      "
    `);
  });

  it("lists the events Infrawrench sent upstream", async () => {
    serveRoutes(out, { "GET /paging-providers/events?limit=50": { events: EVENTS } });
    expect(await cli("paging", "events")).toBe(0);
    expect(out.stdout).toMatchInlineSnapshot(`
      "STATE                       ALERT        TRIGGER  UPDATED           ERROR  
      resolve pending (2 failed)  Budget over  budget   2026-11-08 09:30  timeout
      resolved                    Probe down   probe    2026-11-08 08:30         
      "
    `);
    expect(await cli("paging", "events", "--json")).toBe(0);
    expect(out.stdout).toBe(pretty({ org: "org_1", events: EVENTS }));
  });

  it("refuses --local", async () => {
    expect(await cli("paging", "--local")).toBe(1);
    expect(out.stderr).toMatchInlineSnapshot(`
      "Paging providers live in Infrawrench Cloud: the incidents are mirrored per organization. Drop --local.
      "
    `);
  });
});

// ---------------------------------------------------------------------------
// seats
// ---------------------------------------------------------------------------

const seat = (id: string, over: Record<string, unknown>) => ({
  id,
  accountId: "gh_1",
  accountName: "GitHub",
  pluginId: "github",
  pluginName: "GitHub",
  memberId: `m-${id}`,
  seatKey: id,
  name: null,
  email: null,
  login: null,
  product: "Copilot",
  category: "ai-coding",
  seatType: "Business",
  monthlyPrice: 19,
  currency: "USD",
  priceSource: "list-price",
  priceNote: null,
  activityBasis: "last-activity",
  lastActiveAt: "2026-07-01T00:00:00.000Z",
  activityWindowDays: null,
  activitySource: "copilot",
  assignedAt: null,
  pendingRemovalOn: null,
  removable: true,
  removalNote: null,
  downgrade: null,
  context: {},
  resource: null,
  lastSeenAt: "2026-11-08T00:00:00.000Z",
  status: "inactive",
  daysInactive: 130,
  neverActive: false,
  ...over,
});

const SEATS = {
  inactiveDays: 60,
  seats: [
    seat("s1", { name: "Ada", email: "ada@x.io" }),
    seat("s2", {
      login: "bo",
      product: "Cursor",
      seatType: "Pro",
      monthlyPrice: 40,
      neverActive: true,
      lastActiveAt: null,
      daysInactive: 20,
      removable: false,
      priceSource: "contract",
    }),
    seat("s3", { email: "cy@x.io", activityBasis: "none", status: "unknown", monthlyPrice: null }),
    seat("s4", { name: "Di", activityBasis: "usage-window", status: "active", daysInactive: 2 }),
  ],
  findings: [
    {
      kind: "inactive",
      seatId: "s1",
      monthlySaving: 19,
      currency: "USD",
      remediation: {
        commands: [
          {
            command: "gh api -X DELETE /orgs/acme/copilot/ada",
            description: "Remove the seat",
            destructive: true,
          },
        ],
        placeholders: [],
        iac: null,
      },
    },
    {
      kind: "duplicate",
      seatId: "s2",
      monthlySaving: 40,
      currency: "USD",
      duplicate: {
        keptSeatId: "s1",
        keptProduct: "Copilot",
        keptAccountName: "GitHub",
        keptLastActiveAt: null,
      },
    },
    {
      kind: "downgrade",
      seatId: "s4",
      monthlySaving: null,
      currency: null,
      targetSeatType: "Free",
    },
  ],
  savingsMonthly: [{ currency: "USD", monthly: 59 }],
  spendMonthly: [{ currency: "USD", monthly: 178 }],
  counts: { seats: 4, inactive: 1, duplicate: 1, downgrade: 1, unknownActivity: 1, unpriced: 1 },
  accounts: [
    {
      accountId: "gh_1",
      accountName: "GitHub",
      pluginId: "github",
      pluginName: "GitHub",
      seatCount: 3,
      lastPolledAt: "2026-11-08T00:00:00.000Z",
      lastError: null,
    },
    {
      accountId: "ok_1",
      accountName: "Okta",
      pluginId: "okta",
      pluginName: "Okta",
      seatCount: 0,
      lastPolledAt: null,
      lastError: null,
    },
    {
      accountId: "cu_1",
      accountName: "Cursor",
      pluginId: "cursor",
      pluginName: "Cursor",
      seatCount: 1,
      lastPolledAt: null,
      lastError: "401 Unauthorized",
    },
  ],
};

describe("seats", () => {
  it("lists the findings with remediation", async () => {
    serveRoutes(out, { "GET /seats": SEATS });
    expect(await cli("seats")).toBe(0);
    expect(out.stdout).toMatchInlineSnapshot(`
      "Acme · 4 seats, threshold 60d  to save $59.00/mo · seats cost $178/mo
      1 seat(s) on providers that report no usable activity are never flagged.
      Waiting for the first seat read from Okta.
      Couldn't read seats from Cursor: 401 Unauthorized

      FINDING                   WHO  SEAT                ACCOUNT  LAST ACTIVE        SAVES               ID
      unused 60d+               Ada  Copilot · Business  GitHub   2026-07-01 (130d)  $19.00/mo list      s1
      also on Copilot (GitHub)  bo   Cursor · Pro        GitHub   never (20d held)   $40.00/mo contract  - 
      Business -> Free          Di   Copilot · Business  GitHub   2026-07-01 (2d)    not priced          s4

      Remediation

        Ada (Copilot)
          # [destructive] Remove the seat
          gh api -X DELETE /orgs/acme/copilot/ada

      Remove a flagged seat through its provider: infrawrench seats remove <id>
      "
    `);
    expect(await cli("seats", "--json")).toBe(0);
    expect(out.stdout).toBe(pretty({ org: "org_1", ...SEATS }));
  });

  it("says when nothing reports seats, or nothing is flagged", async () => {
    serveRoutes(out, { "GET /seats": { ...SEATS, accounts: [] } });
    expect(await cli("seats")).toBe(0);
    serveRoutes(out, {
      "GET /seats": {
        ...SEATS,
        findings: [],
        savingsMonthly: [],
        counts: { ...SEATS.counts, unknownActivity: 0 },
      },
    });
    expect(await cli("seats")).toBe(0);
    expect(out.stdout).toMatchInlineSnapshot(`
      "Acme · 4 seats, threshold 60d  seats cost $178/mo
      Waiting for the first seat read from Okta.
      Couldn't read seats from Cursor: 401 Unauthorized

      No seat is inactive, duplicated or on a dearer tier than it needs.
      "
    `);
  });

  it("renders a finding kind this build does not know as its own word", async () => {
    serveRoutes(out, {
      "GET /seats": {
        ...SEATS,
        findings: [{ kind: "reassign", seatId: "s4", monthlySaving: 5, currency: "USD" }],
      },
    });
    expect(await cli("seats")).toBe(0);
    expect(out.stdout).toContain("reassign");
  });

  it("lists every seat", async () => {
    serveRoutes(out, { "GET /seats": SEATS });
    expect(await cli("seats", "all")).toBe(0);
    expect(out.stdout).toMatchInlineSnapshot(`
      "WHO      EMAIL     SEAT                ACCOUNT  STATUS    LAST ACTIVE        EVIDENCE      PRICE             
      Ada      ada@x.io  Copilot · Business  GitHub   inactive  2026-07-01 (130d)  last use      $19.00/mo list    
      bo                 Cursor · Pro        GitHub   inactive  never (20d held)   last use      $40.00/mo contract
      cy@x.io  cy@x.io   Copilot · Business  GitHub   unknown   not reported       not reported  not priced        
      Di                 Copilot · Business  GitHub   active    2026-07-01 (2d)    daily usage   $19.00/mo list    
      Waiting for the first seat read from Okta.
      Couldn't read seats from Cursor: 401 Unauthorized
      "
    `);
    expect(await cli("seats", "all", "--json")).toBe(0);
    expect(out.stdout).toBe(
      pretty({ org: "org_1", inactiveDays: SEATS.inactiveDays, seats: SEATS.seats }),
    );
  });

  it("removes a seat, asking first unless -y", async () => {
    const routes = {
      "GET /seats": SEATS,
      "POST /seats/s1/remove": { effective: "end-of-cycle", message: null },
    };
    serveRoutes(out, routes);
    expect(await cli("seats", "remove", "s1", "-y")).toBe(0);
    expect(out.stdout).toMatchInlineSnapshot(`
      "Removed. The provider bills it until the end of the cycle.
      "
    `);
    expect(await cli("seats", "remove", "s1", "--json", "-y")).toBe(0);
    expect(out.stdout).toBe(
      pretty({ org: "org_1", seatId: "s1", effective: "end-of-cycle", message: null }),
    );
    local.confirm.mockResolvedValueOnce(false).mockResolvedValueOnce(false);
    expect(await cli("seats", "remove", "s1")).toBe(0);
    expect(out.stdout).toBe("");
    expect(local.confirm).toHaveBeenLastCalledWith("Remove the Copilot seat for Ada on GitHub?");
  });

  it("refuses an unknown seat, a missing id and --local", async () => {
    serveRoutes(out, { "GET /seats": SEATS });
    expect(await cli("seats", "remove", "nope", "-y")).toBe(1);
    expect(out.stderr).toMatchInlineSnapshot(`
      "No seat nope. List them with: infrawrench seats
      "
    `);
    expect(await cli("seats", "remove")).toBe(1);
    expect(await cli("seats", "--local")).toBe(1);
    expect(out.stderr).toMatchInlineSnapshot(`
      "Seats are collected in the cloud; drop --local.
      "
    `);
  });

  it("queues a refresh", async () => {
    serveRoutes(out, { "POST /seats/refresh": { queued: 3 } });
    expect(await cli("seats", "refresh")).toBe(0);
    expect(out.stdout).toMatchInlineSnapshot(`
      "Re-collecting seats for 3 account(s); this takes a few minutes.
      "
    `);
    expect(await cli("seats", "refresh", "--json")).toBe(0);
    expect(out.stdout).toBe(pretty({ org: "org_1", queued: 3 }));
  });
});

// ---------------------------------------------------------------------------
// diff
// ---------------------------------------------------------------------------

const CLOUD_ACCOUNTS = [
  { id: "acc_s", pluginId: "aws", displayName: "staging", createdAt: "2026-01-01T00:00:00Z" },
  { id: "acc_p", pluginId: "aws", displayName: "prod", createdAt: "2026-01-01T00:00:00Z" },
  { id: "acc_c", pluginId: "cloudflare", displayName: "edge", createdAt: "2026-01-01T00:00:00Z" },
];

const ref = (name: string) => ({
  resourceId: name,
  accountId: "x",
  displayName: name,
  externalId: null,
});

const DIFF = {
  a: { accountId: "acc_s", accountName: "staging", resourceCount: 4 },
  b: { accountId: "acc_p", accountName: "prod", resourceCount: 5 },
  pluginId: "aws",
  pluginName: "AWS",
  types: [
    {
      resourceTypeId: "rds",
      resourceTypeName: "RDS instance",
      countA: 1,
      countB: 1,
      delta: 0,
      onlyInA: 0,
      onlyInB: 0,
      changed: 1,
      identical: 0,
      missingFrom: null,
    },
    {
      resourceTypeId: "sqs",
      resourceTypeName: "SQS queue",
      countA: 0,
      countB: 2,
      delta: 2,
      onlyInA: 0,
      onlyInB: 2,
      changed: 0,
      identical: 0,
      missingFrom: "a",
    },
    {
      resourceTypeId: "s3",
      resourceTypeName: "S3 bucket",
      countA: 3,
      countB: 2,
      delta: -1,
      onlyInA: 1,
      onlyInB: 0,
      changed: 0,
      identical: 2,
      missingFrom: null,
    },
  ],
  entries: [
    {
      key: "db",
      resourceTypeId: "rds",
      resourceTypeName: "RDS instance",
      status: "changed",
      a: ref("db-staging"),
      b: ref("db-prod"),
      changes: [
        { field: "instanceClass", a: "db.t3.micro", b: "db.r6g.xlarge" },
        { field: "tags", a: { env: "staging" }, b: null },
        { field: "engine", b: "postgres" },
      ],
      suppressedCount: 3,
    },
    {
      key: "logs",
      resourceTypeId: "s3",
      resourceTypeName: "S3 bucket",
      status: "only-in-a",
      a: ref("logs-staging"),
      b: null,
      changes: [],
      suppressedCount: 0,
    },
  ],
  totals: {
    onlyInA: 1,
    onlyInB: 2,
    changed: 1,
    identical: 2,
    typesOnlyInA: 0,
    typesOnlyInB: 1,
    suppressedFieldChanges: 4,
  },
  unavailableTypes: [{ resourceTypeId: "lambda", resourceTypeName: "Lambda", message: "denied" }],
  includeIdentityFields: false,
  generatedAt: "2026-11-08T00:00:00.000Z",
};

describe("diff", () => {
  it("compares two cloud accounts named by position or flag", async () => {
    serveRoutes(out, {
      "GET /accounts": CLOUD_ACCOUNTS,
      "GET /environment-diff?a=acc_s&b=acc_p": DIFF,
      "GET /environment-diff?a=acc_s&b=acc_p&resourceTypeId=rds&includeIdentityFields=true": {
        ...DIFF,
        entries: [],
        unavailableTypes: [],
        includeIdentityFields: true,
      },
    });
    expect(await cli("diff", "staging", "prod")).toBe(0);
    expect(out.stdout).toMatchInlineSnapshot(`
      "staging → prod · Acme · AWS
      4 vs 5 resources · 1 only in A · 2 only in B · 1 differ · 2 identical

      ! couldn't list Lambda. Excluded from the comparison (denied)

      Inventory
      TYPE          STAGING  PROD  DELTA  NOTE                
      RDS instance        1     1      0  1 differ            
      SQS queue           0     2     +2  missing from staging
      S3 bucket           3     2     -1                      

      RDS instance
        differs  db-staging (db-prod)
          FIELD          STAGING            PROD         
          instanceClass  db.t3.micro        db.r6g.xlarge
          tags           {"env":"staging"}  —            
          engine         —                  postgres     
          + 3 id/address/timestamp differences hidden (--all shows them)

      S3 bucket
        only in A  logs-staging

      Resources are paired by type and by name with environment words removed, so api-staging lines up with api-prod. 4 id, address and timestamp differences hidden. Every resource has different ones; pass --all to see them.
      "
    `);
    expect(await cli("diff", "-a", "staging", "-b", "prod", "--json")).toBe(0);
    expect(out.stdout).toBe(pretty({ org: "org_1", ...DIFF }));
    expect(await cli("diff", "staging", "--against", "prod", "--type", "rds", "--all")).toBe(0);
    expect(out.stdout).toMatchInlineSnapshot(`
      "staging → prod · Acme · AWS
      4 vs 5 resources · 1 only in A · 2 only in B · 1 differ · 2 identical

      Inventory
      TYPE          STAGING  PROD  DELTA  NOTE                
      RDS instance        1     1      0  1 differ            
      SQS queue           0     2     +2  missing from staging
      S3 bucket           3     2     -1                      

      The two inventories match. Every resource in staging has a counterpart in prod with the same settings.
      "
    `);
  });

  it("renders a status this build does not know as its own word", async () => {
    serveRoutes(out, {
      "GET /accounts": CLOUD_ACCOUNTS,
      "GET /environment-diff?a=acc_s&b=acc_p": {
        ...DIFF,
        entries: [
          {
            key: "x",
            resourceTypeId: "s3",
            resourceTypeName: "S3 bucket",
            status: "moved",
            a: null,
            b: ref("x-prod"),
            changes: [],
            suppressedCount: 1,
          },
        ],
      },
    });
    expect(await cli("diff", "staging", "prod")).toBe(0);
    expect(out.stdout).toContain("  moved  x-prod\n");
  });

  it("diffs local accounts in-process", async () => {
    local.diff.mockResolvedValue(DIFF);
    expect(await cli("diff", "staging", "prod", "--local")).toBe(0);
    expect(local.diff).toHaveBeenLastCalledWith(
      { id: "loc_1", pluginId: "aws", displayName: "staging" },
      { id: "loc_2", pluginId: "aws", displayName: "prod" },
      { resourceTypeId: undefined, includeIdentityFields: false },
    );
    expect(await cli("diff", "staging", "prod", "--local", "--json")).toBe(0);
    expect(out.stdout).toBe(pretty(DIFF));
  });

  it("refuses one account, the same account twice and two providers", async () => {
    serveRoutes(out, { "GET /accounts": CLOUD_ACCOUNTS });
    expect(await cli("diff", "staging")).toBe(2);
    expect(out.stderr).toMatchInlineSnapshot(`
      "Two accounts are required. \`infrawrench diff -a staging -b prod\` (or \`infrawrench diff staging prod\`).
      "
    `);
    expect(await cli("diff", "staging", "staging")).toBe(2);
    expect(await cli("diff", "staging", "edge")).toBe(2);
    expect(out.stderr).toMatchInlineSnapshot(`
      ""staging" (aws) and "edge" (cloudflare) use different providers. A diff needs two accounts of the same provider.
      "
    `);
    expect(await cli("diff", "staging", "nope")).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// posture
// ---------------------------------------------------------------------------

const finding = (resourceId: string, severity: string, title: string) => ({
  resourceId,
  pluginId: "aws",
  pluginName: "AWS",
  resourceTypeId: "s3",
  resourceTypeName: "S3 bucket",
  accountId: "acc_p",
  accountName: "prod",
  displayName: resourceId,
  externalId: null,
  ruleId: `rule-${resourceId}`,
  title,
  severity,
  category: "public-exposure",
  reason: "because",
});

const POSTURE = {
  findings: [
    finding("logs", "critical", "Bucket is public"),
    finding("db", "high", "No deletion protection"),
    finding("disk", "medium", "Unencrypted"),
    finding("key", "low", "Old key"),
    finding("new", "severe", "A newer bucket"),
  ],
  totalCount: 5,
  counts: { critical: 1, high: 1, medium: 1, low: 1 },
  dismissed: [
    {
      ...finding("tmp", "high", "Bucket is public"),
      dismissal: {
        resourceId: "tmp",
        ruleId: "rule-tmp",
        dismissedAt: "2026-10-01T12:00:00.000Z",
        dismissedBy: "ada@example.com",
        reason: "Static site",
      },
    },
  ],
  dismissedCount: 1,
  generatedAt: "2026-11-08T00:00:00.000Z",
};

describe("posture", () => {
  it("lists findings and the accepted risks", async () => {
    serveRoutes(out, { "GET /posture": POSTURE });
    expect(await cli("posture")).toBe(0);
    expect(out.stdout).toMatchInlineSnapshot(`
      "Acme · 5 findings  1 critical · 1 high · 1 medium · 1 low

      SEVERITY  RESOURCE  TYPE       ACCOUNT  FINDING               
      critical  logs      S3 bucket  prod     Bucket is public      
      high      db        S3 bucket  prod     No deletion protection
      medium    disk      S3 bucket  prod     Unencrypted           
      low       key       S3 bucket  prod     Old key               
      severe    new       S3 bucket  prod     A newer bucket        

      Dismissed · 1 accepted risk

      RESOURCE  ACCOUNT  FINDING           ACCEPTED                                  
      tmp       prod     Bucket is public  2026-10-01 · ada@example.com · Static site

      Undo with \`infrawrench posture restore <resourceId> <ruleId>\`.

      Computed from already-synced fields. No provider was contacted. Rules are declared by each plugin; critical & high findings feed the daily posture alerts.
      "
    `);
    expect(await cli("posture", "--json")).toBe(0);
    expect(out.stdout).toBe(pretty({ org: "org_1", ...POSTURE }));
  });

  it("scans the local workspace", async () => {
    local.posture.mockResolvedValue({
      ...POSTURE,
      findings: [],
      totalCount: 0,
      counts: { critical: 0, high: 0, medium: 0, low: 0 },
    });
    expect(await cli("posture", "--local")).toBe(0);
    expect(out.stdout).toMatchInlineSnapshot(`
      "No open findings. Everything currently flagged has been dismissed as an accepted risk.

      Dismissed · 1 accepted risk

      RESOURCE  ACCOUNT  FINDING           ACCEPTED                                  
      tmp       prod     Bucket is public  2026-10-01 · ada@example.com · Static site

      Undo with \`infrawrench posture restore <resourceId> <ruleId>\`.
      This scan covered the local workspace only; drop --local for your organization.
      "
    `);
    expect(await cli("posture", "--local", "--json")).toBe(0);
    local.posture.mockResolvedValue({ ...POSTURE, dismissed: [], dismissedCount: 0, findings: [] });
    expect(await cli("posture", "--local")).toBe(0);
  });

  it("dismisses and restores in the cloud", async () => {
    serveRoutes(out, {
      "POST /posture/dismissals": { resourceId: "logs", ruleId: "r1", reason: "Public site" },
      "DELETE /posture/dismissals?resourceId=logs&ruleId=r1": new RawResponse(204, ""),
    });
    expect(await cli("posture", "dismiss", "logs", "r1", "--reason", "Public site")).toBe(0);
    expect(out.stdout).toMatchInlineSnapshot(`
      "Dismissed logs · r1
      Accepted for Acme. It leaves the posture list and the daily alerts until \`posture restore\`.
      "
    `);
    expect(await cli("posture", "dismiss", "logs", "r1", "--json")).toBe(0);
    expect(await cli("posture", "restore", "logs", "r1")).toBe(0);
    expect(out.stdout).toMatchInlineSnapshot(`
      "Restored logs · r1
      Back on the posture list and in the daily alerts.
      "
    `);
    expect(await cli("posture", "restore", "logs", "r1", "--json")).toBe(0);
  });

  it("dismisses and restores locally", async () => {
    local.dismiss.mockResolvedValue(null);
    local.restore.mockResolvedValueOnce(true);
    expect(await cli("posture", "dismiss", "logs", "r1", "--local", "--reason", " ")).toBe(0);
    expect(out.stdout).toMatchInlineSnapshot(`
      "Dismissed logs · r1
      Local workspace only. It stays off the list until \`posture restore\`.
      "
    `);
    expect(local.dismiss).toHaveBeenLastCalledWith("logs", "r1", " ");
    expect(await cli("posture", "dismiss", "logs", "r1", "--local", "--json")).toBe(0);
    expect(out.stdout).toBe(
      `${JSON.stringify({ dismissed: { resourceId: "logs", ruleId: "r1", reason: null } }, null, 2)}\n`,
    );
    expect(await cli("posture", "restore", "logs", "r1", "--local")).toBe(0);
    local.restore.mockResolvedValue(false);
    expect(await cli("posture", "restore", "logs", "r1", "--local")).toBe(1);
    expect(out.stderr).toMatchInlineSnapshot(`
      "That finding is not dismissed in the local workspace.
      "
    `);
  });

  it("asks for both ids", async () => {
    expect(await cli("posture", "dismiss", "logs")).toBe(2);
    expect(out.stderr).toMatchInlineSnapshot(`
      "Usage: infrawrench posture dismiss|restore <resourceId> <ruleId> [--reason <text>]
      Both ids are printed by \`infrawrench posture --json\`.
      "
    `);
    expect(await cli("posture", "restore")).toBe(2);
  });
});
