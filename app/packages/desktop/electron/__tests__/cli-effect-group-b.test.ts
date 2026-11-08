import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// `incidents`, `access`, `expiring`, `schedules`, `credits` and
// `cost-visibility` on effect/cli: text and `--json` output, verbs, scopes
// and refusals, against fixtures. Nothing reaches a network or a database.
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

const localExpiring = vi.hoisted(() => vi.fn());
vi.mock("../local-expiring", () => ({ listLocalExpiring: localExpiring }));

import { RawResponse, run, serveRoutes, useCliCapture } from "./cli-harness";

const out = useCliCapture();

/** What `--json` prints for a value: two-space JSON and a newline, keys in order. */
const asJson = (value: unknown) => `${JSON.stringify(value, null, 2)}\n`;

const NOW = Date.parse("2026-11-08T12:00:00.000Z");
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const at = (offsetMs: number) => new Date(NOW + offsetMs).toISOString();

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
});
afterEach(() => {
  vi.useRealTimers();
});

const incident = (overrides: Record<string, unknown>) => ({
  id: "inc1",
  pluginId: "aws",
  pluginName: "AWS",
  title: "Elevated API errors in us-east-1",
  state: "investigating",
  impact: "major",
  url: "https://health.aws.amazon.com/1",
  startedAt: at(-3 * HOUR),
  resolvedAt: null,
  lastUpdateAt: at(-HOUR),
  lastUpdateText: "Mitigating",
  regions: ["us-east-1"],
  services: ["EC2", "Lambda"],
  providerWide: false,
  affectedResourceCount: 7,
  affectedRegions: ["us-east-1"],
  sampleResources: [
    { id: "r1", displayName: "api-1", resourceTypeId: "ec2-instance", region: "us-east-1" },
    { id: "r2", displayName: "worker", resourceTypeId: "lambda-function" },
  ],
  overlappingChangeCount: 2,
  ...overrides,
});

const INCIDENTS = {
  incidents: [
    incident({}),
    incident({
      id: "inc2",
      pluginName: "Cloudflare",
      title: "Dashboard degraded",
      impact: "a-new-impact",
      url: undefined,
      providerWide: true,
      affectedResourceCount: 0,
      affectedRegions: [],
      sampleResources: [],
      overlappingChangeCount: 0,
    }),
    incident({
      id: "inc3",
      pluginName: "Vercel",
      title: "Build delays",
      impact: "minor",
      resolvedAt: at(-HOUR),
      affectedRegions: [],
      services: ["Builds"],
      sampleResources: [],
      affectedResourceCount: 0,
    }),
  ],
};

describe("incidents", () => {
  it("prints the table and affected samples", async () => {
    serveRoutes(out, { "GET /status-incidents": INCIDENTS });
    expect(await run("incidents")).toBe(0);
    expect(out.stdout).toMatchInlineSnapshot(`
      "Acme · 2 active provider incidents, 1 resolved in the last 24h

      IMPACT    PROVIDER    INCIDENT                          SCOPE          YOUR RESOURCES  CHANGES DURING  SINCE           
      major     AWS         Elevated API errors in us-east-1  us-east-1      7               2               2026-11-08 09:00
      minor     Cloudflare  Dashboard degraded                provider-wide  0               0               2026-11-08 09:00
      resolved  Vercel      Build delays                      Builds         0               2               2026-11-08 09:00

      AWS affects api-1 (us-east-1), worker and 5 more
        https://health.aws.amazon.com/1
      "
    `);
  });

  it("prints the org and the raw incidents under --json", async () => {
    serveRoutes(out, { "GET /status-incidents": INCIDENTS });
    expect(await run("incidents", "--json")).toBe(0);
    expect(out.stdout).toBe(asJson({ org: "org_1", incidents: INCIDENTS.incidents }));
  });

  it("says when nothing overlaps", async () => {
    serveRoutes(out, { "GET /status-incidents": { incidents: [] } });
    expect(await run("incidents")).toBe(0);
    expect(out.stdout).toMatchInlineSnapshot(`
      "No provider incidents overlap this organization. Every provider status feed we watch is clear.
      "
    `);
  });

  it("refuses --local before asking the cloud", async () => {
    serveRoutes(out, {});
    expect(await run("incidents", "--local")).toBe(1);
    expect(out.requests).toEqual([]);
    expect(out.stderr).toBe(
      "Provider status correlation is computed by Infrawrench Cloud's poller, which watches each provider's public status feed. Local-only mode has no poller, so there is nothing to correlate.\n",
    );
  });

  it("refuses a stray positional", async () => {
    expect(await run("incidents", "aws")).toBe(2);
    expect(out.stdout).toBe("");
  });
});

const request = (overrides: Record<string, unknown>) => ({
  id: "req1",
  userId: "u1",
  userName: "Ada Lovelace",
  permissions: ["resources:execute", "accounts:write"],
  reason: "Restart the stuck worker",
  durationMinutes: 90,
  status: "approved",
  expiresAt: at(30 * MINUTE),
  decidedAt: at(-10 * MINUTE),
  decidedByUserId: "u2",
  decidedByName: "Grace",
  decisionNote: null,
  grantedAt: at(-10 * MINUTE),
  grantExpiresAt: at(80 * MINUTE),
  revokedAt: null,
  revokedByName: null,
  active: true,
  createdAt: at(-15 * MINUTE),
  ...overrides,
});

const REQUESTS = [
  request({}),
  request({
    id: "req2",
    userName: null,
    permissions: ["team:write"],
    durationMinutes: 45,
    status: "pending",
    active: false,
    grantExpiresAt: null,
    grantedAt: null,
  }),
  request({ id: "req3", active: false, revokedAt: at(-DAY), grantExpiresAt: at(-DAY) }),
  request({ id: "req4", active: false, status: "denied", grantExpiresAt: null }),
  request({ id: "req5", active: false, status: "expired", durationMinutes: 0 }),
];

describe("access", () => {
  it.each([[[]], [["list"]]])("lists every request for %j", async (verb) => {
    serveRoutes(out, { "GET /access-requests": REQUESTS });
    expect(await run("access", ...verb)).toBe(0);
    expect(out.stdout).toMatchInlineSnapshot(`
      "Acme · 1 live elevation, 1 waiting for a decision

      WHO           PERMISSIONS                        FOR   STATUS       CLOCK   REASON                  
      Ada Lovelace  resources:execute, accounts:write  1.5h  LIVE         in 1h   Restart the stuck worker
      unknown       team:write                         45m   waiting      in 30m  Restart the stuck worker
      Ada Lovelace  resources:execute, accounts:write  1.5h  ended early  —       Restart the stuck worker
      Ada Lovelace  resources:execute, accounts:write  1.5h  denied       —       Restart the stuck worker
      Ada Lovelace  resources:execute, accounts:write  —     expired      —       Restart the stuck worker

      Live elevations lapse on their own. End one early from Settings → Break-glass Access.
      "
    `);
  });

  it("asks for the live elevations only with `active`", async () => {
    serveRoutes(out, { "GET /access-requests?active=1": [] });
    expect(await run("access", "active")).toBe(0);
    expect(out.stdout).toBe("Nobody is holding elevated access right now.\n");
  });

  it("prints the raw rows under --json", async () => {
    serveRoutes(out, { "GET /access-requests": REQUESTS });
    expect(await run("access", "--json")).toBe(0);
    expect(out.stdout).toBe(asJson({ org: "org_1", requests: REQUESTS }));
  });

  it("refuses a status the client does not know", async () => {
    serveRoutes(out, { "GET /access-requests": [request({ status: "frozen", active: false })] });
    expect(await run("access")).toBe(1);
    expect(out.stderr).toMatch(
      /^Cloud request returned a malformed response for \/access-requests: /,
    );
  });

  it("answers an unknown verb with a parse error", async () => {
    expect(await run("access", "grant")).toBe(2);
    expect(out.stdout).toBe("");
  });
});

const expiry = (overrides: Record<string, unknown>) => ({
  resourceId: "r1",
  pluginId: "aws",
  pluginName: "AWS",
  resourceTypeId: "acm-certificate",
  resourceTypeName: "ACM Certificate",
  accountId: "acc1",
  accountName: "prod",
  displayName: "api.acme.com",
  externalId: null,
  fieldKey: "notAfter",
  kind: "tls-cert",
  label: "Certificate expires",
  basis: "expiry",
  dueAt: at(5 * DAY),
  daysRemaining: 5,
  severity: "critical",
  ...overrides,
});

const EXPIRING = {
  items: [
    expiry({
      displayName: "acme.com",
      label: "Domain renews",
      dueAt: at(40 * DAY),
      daysRemaining: 40,
      severity: "upcoming",
    }),
    expiry({}),
    expiry({
      displayName: "old.acme.com",
      dueAt: at(-3 * DAY),
      daysRemaining: -3,
      severity: "expired",
    }),
    expiry({ displayName: "deploy key", dueAt: at(0), daysRemaining: 0, severity: "critical" }),
    expiry({ displayName: "far", dueAt: at(200 * DAY), daysRemaining: 200, severity: "ok" }),
  ],
  totalCount: 5,
  counts: { expired: 1, critical: 2, warning: 0, upcoming: 1, ok: 1 },
  leadDays: 60,
  generatedAt: at(0),
};

describe("expiring", () => {
  it("prints the deadlines soonest first", async () => {
    serveRoutes(out, { "GET /expiring": EXPIRING });
    expect(await run("expiring")).toBe(0);
    expect(out.stdout).toMatchInlineSnapshot(`
      "Acme · 5 tracked deadlines  1 expired · 2 <7d · 1 ≤60d · 1 later

      RESOURCE      TYPE             ACCOUNT  DEADLINE             DUE         REMAINING     
      old.acme.com  ACM Certificate  prod     Certificate expires  2026-11-05  expired 3d ago
      deploy key    ACM Certificate  prod     Certificate expires  2026-11-08       due today
      api.acme.com  ACM Certificate  prod     Certificate expires  2026-11-13           in 5d
      acme.com      ACM Certificate  prod     Domain renews        2026-12-18          in 40d
      far           ACM Certificate  prod     Certificate expires  2027-05-27         in 200d

      Computed from already-synced fields. No provider was contacted. "≤60d" follows the organization's expiry-alert lead time; age-based deadlines (key rotation budgets) count from the last rotation.
      "
    `);
  });

  it("prints the org and the raw body under --json", async () => {
    serveRoutes(out, { "GET /expiring": EXPIRING });
    expect(await run("expiring", "--json")).toBe(0);
    expect(out.stdout).toBe(asJson({ org: "org_1", ...EXPIRING }));
  });

  it("scans the local workspace with --local and contacts no server", async () => {
    localExpiring.mockResolvedValue({ ...EXPIRING, items: [], totalCount: 0 });
    serveRoutes(out, {});
    expect(await run("expiring", "--local")).toBe(0);
    expect(out.requests).toEqual([]);
    expect(out.stdout).toMatchInlineSnapshot(`
      "Nothing is on the clock. Deadlines appear when a plugin marks a synced field as expiry-bearing, such as a cert's end date or a domain's renewal.
      This scan covered the local workspace only; drop --local for your organization.
      "
    `);
  });

  it("prints a local scan as JSON without an org", async () => {
    localExpiring.mockResolvedValue(EXPIRING);
    expect(await run("expiring", "--local", "--json")).toBe(0);
    expect(out.stdout).toBe(asJson(EXPIRING));
  });

  it("refuses a stray positional", async () => {
    expect(await run("expiring", "soon")).toBe(2);
    expect(out.stdout).toBe("");
  });
});

const schedule = (overrides: Record<string, unknown>) => ({
  id: "s1",
  resourceId: "r1",
  accountId: "acc1",
  pluginId: "aws",
  resourceTypeId: "ec2-instance",
  resourceName: "staging-api",
  accountName: "staging",
  daysOfWeek: [1, 2, 3, 4, 5],
  stopTime: "19:00",
  startTime: "08:00",
  timezone: "Europe/London",
  paused: false,
  nextTransitionAt: at(7 * HOUR),
  nextTransitionAction: "stop",
  lastRunAt: at(-5 * HOUR),
  lastRunAction: "start",
  lastRunStatus: "ok",
  lastRunError: null,
  projectedMonthlySaving: 42.5,
  currency: "USD",
  createdAt: at(-30 * DAY),
  updatedAt: at(-DAY),
  remediation: {
    commands: [
      {
        tool: "aws",
        command: "aws ec2 stop-instances --instance-ids i-123",
        description: "Stop the instance",
        destructive: false,
        placeholders: ["AWS_PROFILE"],
      },
    ],
    placeholders: [{ name: "AWS_PROFILE", description: "The AWS CLI profile for this account" }],
    iac: null,
  },
  ...overrides,
});

const SCHEDULES = {
  schedules: [
    schedule({}),
    schedule({
      id: "s2",
      resourceName: "batch",
      daysOfWeek: [1, 3, 6],
      paused: true,
      nextTransitionAt: null,
      nextTransitionAction: null,
      lastRunStatus: "failed",
      lastRunAction: "stop",
      lastRunError: "instance not found",
      projectedMonthlySaving: 10,
      currency: "EUR",
      remediation: undefined,
    }),
    schedule({
      id: "s3",
      resourceName: "db",
      daysOfWeek: [1, 2, 3, 4, 5, 6, 7],
      lastRunStatus: "skipped_freeze",
      projectedMonthlySaving: null,
      currency: null,
      remediation: {
        commands: [],
        placeholders: [],
        iac: {
          address: "aws_db_instance.db",
          stateLabel: null,
          attributeChanges: [],
          commands: [
            {
              tool: "terraform",
              command: "terraform apply",
              description: "Apply",
              destructive: true,
              placeholders: [],
            },
          ],
        },
      },
    }),
    schedule({ id: "s4", resourceName: "never", lastRunStatus: null, daysOfWeek: [] }),
  ],
};

describe("schedules", () => {
  it("prints windows, savings and remediation", async () => {
    serveRoutes(out, { "GET /schedules": SCHEDULES });
    expect(await run("schedules")).toBe(0);
    expect(out.stdout).toMatchInlineSnapshot(`
      "Acme · 4 schedules  · projected saving $85.00/mo

      RESOURCE     ACCOUNT  WINDOW                            TZ             NEXT                   LAST RUN                    SAVES    
      staging-api  staging  Mon–Fri off 19:00 → on 08:00      Europe/London  off 2026-11-08 19:00Z  start ok                    $42.50/mo
      batch        staging  Mon,Wed,Sat off 19:00 → on 08:00  Europe/London  paused                 failed: instance not found  €10.00/mo
      db           staging  every day off 19:00 → on 08:00    Europe/London  off 2026-11-08 19:00Z  skipped (freeze)                    —
      never        staging  no days off 19:00 → on 08:00      Europe/London  off 2026-11-08 19:00Z  never ran                   $42.50/mo

      Remediation

        staging-api
          # Stop the instance
          aws ec2 stop-instances --instance-ids i-123

        db
          Managed by Terraform at aws_db_instance.db: change the configuration rather than running the CLI commands.
          # [destructive] Apply
          terraform apply

        never
          # Stop the instance
          aws ec2 stop-instances --instance-ids i-123

      Set these first:
        export AWS_PROFILE=...   # The AWS CLI profile for this account

      Savings are projected from trailing per-resource billing and the weekly off-hours fraction; transitions are skipped during change freezes.
      "
    `);
  });

  it("prints the org and the raw body under --json", async () => {
    serveRoutes(out, { "GET /schedules": SCHEDULES });
    expect(await run("schedules", "--json")).toBe(0);
    expect(out.stdout).toBe(asJson({ org: "org_1", ...SCHEDULES }));
  });

  it("says when there are none", async () => {
    serveRoutes(out, { "GET /schedules": { schedules: [] } });
    expect(await run("schedules")).toBe(0);
    expect(out.stdout).toMatchInlineSnapshot(`
      "No sleep schedules. Create one from a stoppable resource's Schedule tab (web or desktop) to power non-prod resources off outside working hours.
      "
    `);
  });

  it("refuses a stray positional", async () => {
    expect(await run("schedules", "staging")).toBe(2);
    expect(out.stdout).toBe("");
  });
});

const pot = (overrides: Record<string, unknown>) => ({
  accountId: "acc1",
  accountName: "OpenAI",
  pluginId: "openai",
  capabilityLabel: "Credits",
  topUpUrl: null,
  potKey: "credits",
  label: "Prepaid credits",
  remaining: 420,
  currency: "USD",
  granted: 1000,
  creditExpiresAt: null,
  observedAt: at(-HOUR),
  burnPerDay: 70,
  burnSpanDays: 30,
  observations: 30,
  topUps: 0,
  runwayDays: 6,
  exhaustedAt: at(6 * DAY),
  neverEmpties: false,
  limitedByExpiry: false,
  urgency: "critical",
  ...overrides,
});

const CREDITS = {
  pots: [
    pot({}),
    pot({
      accountName: "Anthropic",
      remaining: 5.5,
      burnPerDay: 0.25,
      runwayDays: 22,
      urgency: "warning",
      topUps: 1,
    }),
    pot({ accountName: "Fly", runwayDays: 400, urgency: "ok", topUps: 2 }),
    pot({ accountName: "Modal", runwayDays: null, burnPerDay: null, urgency: "unknown" }),
    pot({ accountName: "Replicate", neverEmpties: true, urgency: "ok", limitedByExpiry: true }),
    pot({ accountName: "Groq", runwayDays: 0.5, urgency: "critical" }),
  ],
  failures: [
    {
      accountId: "acc9",
      accountName: "Together",
      pluginId: "together",
      error: "403 Forbidden",
      helpLabel: "Grant billing read",
      helpUrl: "https://example.com/help",
      failureCount: 2,
    },
  ],
  pendingAccountIds: [],
  burnWindowDays: 30,
};

describe("credits", () => {
  // `credits` formats money in the terminal's own locale; pin it so the
  // expected table is the same on every machine.
  beforeEach(() => {
    const Format = Intl.NumberFormat;
    vi.spyOn(Intl, "NumberFormat").mockImplementation(function (
      _locale?: Intl.LocalesArgument,
      options?: Intl.NumberFormatOptions,
    ) {
      return new Format("en-US", options);
    });
  });

  it("prints balances, runway and failures", async () => {
    serveRoutes(out, { "GET /credits": CREDITS });
    expect(await run("credits")).toBe(0);
    expect(out.stdout).toMatchInlineSnapshot(`
      "Acme · 6 balances, 3 running low · burn measured over 30d

      ACCOUNT    POT              REMAINING  BURN/DAY  RUNWAY              NOTE                
      OpenAI     Prepaid credits  $420       $70       6d                  —                   
      Anthropic  Prepaid credits  $5.50      $0.25     3w                  1 top-up in window  
      Fly        Prepaid credits  $420       $70       13mo                2 top-ups in window 
      Modal      Prepaid credits  $420       —         not enough history  —                   
      Replicate  Prepaid credits  $420       $70       no spend observed   credit expires first
      Groq       Prepaid credits  $420       $70       < 1 day             —                   

      Together: 403 Forbidden
        Grant billing read: https://example.com/help
      "
    `);
  });

  it("prints the org and the raw body under --json", async () => {
    serveRoutes(out, { "GET /credits": CREDITS });
    expect(await run("credits", "--json")).toBe(0);
    expect(out.stdout).toBe(asJson({ org: "org_1", ...CREDITS }));
  });

  it("says when nothing is tracked", async () => {
    serveRoutes(out, { "GET /credits": { ...CREDITS, pots: [], failures: [] } });
    expect(await run("credits")).toBe(0);
    expect(out.stdout).toMatchInlineSnapshot(`
      "No prepaid credit balances tracked. Only providers that expose a balance can be tracked; most bill in arrears and have no pot to burn down.
      "
    `);
  });

  it("names a failed request", async () => {
    serveRoutes(out, { "GET /credits": new RawResponse(403, '{"error":"costs:read"}') });
    expect(await run("credits")).toBe(1);
    expect(out.stderr).toBe('Cloud request failed: 403 /credits {"error":"costs:read"}\n');
  });
});

const SCOPES = {
  scopes: [
    {
      id: "cv1",
      principalKind: "role",
      principalId: "role_1",
      principalLabel: "Platform",
      costCentreIds: ["cc1", "cc2"],
      accountIds: [],
      savedFilterId: "f1",
      createdAt: at(-10 * DAY),
      updatedAt: "2026-11-01T09:00:00.000Z",
    },
    {
      id: "cv2",
      principalKind: "api_key",
      principalId: "key_1",
      principalLabel: null,
      costCentreIds: [],
      accountIds: [],
      savedFilterId: null,
      createdAt: at(-10 * DAY),
      updatedAt: "2026-10-01T09:00:00.000Z",
    },
    {
      id: "cv3",
      principalKind: "member",
      principalId: "u1",
      principalLabel: "ada@example.com",
      costCentreIds: [],
      accountIds: ["acc1"],
      savedFilterId: "f2",
      createdAt: at(-10 * DAY),
      updatedAt: "2026-10-02T09:00:00.000Z",
    },
  ],
};

const ME = {
  email: "ada@example.com",
  permissions: ["costs:read"],
  costVisibility: {
    restricted: true,
    sources: [
      {
        kind: "role",
        label: "Platform",
        costCentreIds: ["cc1"],
        accountIds: [],
        savedFilterId: null,
      },
      { kind: "member", label: null, costCentreIds: [], accountIds: [], savedFilterId: "f1" },
    ],
  },
};

describe("cost-visibility", () => {
  it.each([[[]], [["list"]]])("lists every scope for %j", async (verb) => {
    serveRoutes(out, { "GET /cost-visibility": SCOPES });
    expect(await run("cost-visibility", ...verb)).toBe(0);
    expect(out.stdout).toMatchInlineSnapshot(`
      "Acme · 3 scope(s)

      KIND     APPLIES TO       SEES                        UPDATED   
      role     Platform         2 cost centre(s), filtered  2026-11-01
      API key  deleted          nothing (sees no costs)     2026-10-01
      member   ada@example.com  1 account(s), filtered      2026-10-02

      Edit scopes in Settings → Cost Visibility.
      "
    `);
  });

  it("prints the org and the raw scopes under --json", async () => {
    serveRoutes(out, { "GET /cost-visibility": SCOPES });
    expect(await run("cost-visibility", "--json")).toBe(0);
    expect(out.stdout).toBe(asJson({ org: "org_1", scopes: SCOPES.scopes }));
  });

  it("says when there are no scopes", async () => {
    serveRoutes(out, { "GET /cost-visibility": { scopes: [] } });
    expect(await run("cost-visibility")).toBe(0);
    expect(out.stdout).toMatchInlineSnapshot(`
      "No cost visibility scopes. Everyone with cost access sees all spend.
      "
    `);
  });

  it("shows your own scope with `me`", async () => {
    serveRoutes(out, { "GET /team/me": ME });
    expect(await run("cost-visibility", "me")).toBe(0);
    expect(out.stdout).toMatchInlineSnapshot(`
      "Acme · your cost figures are scoped (every layer below must match a cost row)

      FROM    NAME      SEES             
      role    Platform  1 cost centre(s) 
      member  unknown   saved filter only
      "
    `);
  });

  it("prints your own scope under --json, unrestricted when the server sends none", async () => {
    serveRoutes(out, { "GET /team/me": ME });
    expect(await run("cost-visibility", "me", "--json")).toBe(0);
    expect(out.stdout).toBe(asJson({ org: "org_1", costVisibility: ME.costVisibility }));
    out.stdout = "";
    serveRoutes(out, { "GET /team/me": { email: "ada@example.com" } });
    expect(await run("cost-visibility", "me", "--json")).toBe(0);
    expect(JSON.parse(out.stdout)).toEqual({
      org: "org_1",
      costVisibility: { restricted: false, sources: [] },
    });
  });

  it("says when you see everything", async () => {
    serveRoutes(out, { "GET /team/me": { email: "ada@example.com" } });
    expect(await run("cost-visibility", "me")).toBe(0);
    expect(out.stdout).toMatchInlineSnapshot(`
      "Acme · you see all of the organization's costs
      "
    `);
  });

  it("answers an unknown verb with a parse error", async () => {
    expect(await run("cost-visibility", "set")).toBe(2);
    expect(out.stdout).toBe("");
  });
});
