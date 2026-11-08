import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// `orphans`, `extended-support`, `probes`, `webhooks`, `slos` and
// `commitments` on effect/cli: text and `--json` output, scopes and refusals,
// against fixtures. Nothing reaches a network or a database.
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

const localOrphans = vi.hoisted(() => vi.fn());
vi.mock("../local-orphans", () => ({ listLocalOrphans: localOrphans }));
const localExtendedSupport = vi.hoisted(() => vi.fn());
vi.mock("../local-extended-support", () => ({ listLocalExtendedSupport: localExtendedSupport }));

import { run, serveRoutes, useCliCapture } from "./cli-harness";

const out = useCliCapture();

const NOW = Date.parse("2026-11-08T12:00:00.000Z");

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
});
afterEach(() => {
  vi.useRealTimers();
});

const LOCAL_REFUSALS: Array<[string, string]> = [
  [
    "probes",
    "Synthetic probes live in Infrawrench Cloud. The poller runs them through the egress proxy. Drop --local.",
  ],
  [
    "slos",
    "SLOs live in Infrawrench Cloud. The poller evaluates them over the cloud metric store. Drop --local.",
  ],
  [
    "webhooks",
    "Event subscriptions live in Infrawrench Cloud: they deliver the organization's events. Drop --local.",
  ],
  ["commitments", "Commitments live in Infrawrench Cloud. The inventory is collected server-side."],
];

describe("cloud-only refusals", () => {
  it.each(LOCAL_REFUSALS)("%s --local is refused in one line, exit 1", async (command, message) => {
    serveRoutes(out, {});
    expect(await run(command, "--local")).toBe(1);
    expect(out.stderr).toBe(`${message}\n`);
    expect(out.stdout).toBe("");
    expect(out.requests).toEqual([]);
  });
});

// --- orphans ---------------------------------------------------------------

const remediation = {
  commands: [
    {
      tool: "aws",
      command: "aws ec2 delete-volume --volume-id vol-1 --profile $AWS_PROFILE",
      description: "Delete the volume",
      destructive: true,
      placeholders: [{ name: "AWS_PROFILE", description: "The AWS CLI profile" }],
    },
  ],
  placeholders: [{ name: "AWS_PROFILE", description: "The AWS CLI profile" }],
  iac: null,
};

const orphan = (over: Record<string, unknown>) => ({
  id: "acc1:ebs-volume:vol-1",
  pluginId: "aws",
  resourceTypeId: "ebs-volume",
  resourceTypeName: "EBS Volume",
  displayName: "old-data",
  externalId: "vol-1",
  reason: "Volume is not attached to any instance",
  cost: null,
  owner: null,
  lastSyncedAt: "2026-11-08T10:00:00.000Z",
  remediation,
  ...over,
});

const ORPHANS = {
  accounts: [
    {
      accountId: "acc1",
      accountName: "prod",
      pluginId: "aws",
      pluginName: "AWS",
      resources: [
        orphan({ cost: { amount: 41.5, currency: "USD" } }),
        orphan({
          id: "acc1:nat:nat-1",
          resourceTypeName: "NAT Gateway",
          displayName: "nat-quiet",
          reason: "Idle NAT gateway",
          owner: {
            userId: null,
            displayName: "platform",
            isLabel: true,
            ticketUrl: null,
            purpose: null,
          },
          estimate: {
            monthlyAmount: 32.85,
            currency: "USD",
            basis: "list-price",
            note: "hours only",
          },
          idle: {
            ruleId: "nat-gateway",
            ruleKey: "aws:nat-gateway",
            ruleLabel: "Idle NAT gateway",
            action: "remove",
            lookbackDays: 14,
            evidence: [
              {
                metric: "BytesOutToDestination",
                label: "Bytes sent to the internet",
                statistic: "sum",
                value: 0,
                unit: "bytes",
                threshold: 1000,
                comparison: "atMost",
              },
            ],
            detectedAt: "2026-11-01T00:00:00.000Z",
            evaluatedAt: "2026-11-08T00:00:00.000Z",
            hasResource: true,
          },
          remediation: {
            commands: [],
            placeholders: [],
            iac: {
              address: "aws_nat_gateway.main",
              stateLabel: "prod state",
              attributeChanges: [],
              commands: [
                {
                  tool: "terraform",
                  command: "terraform destroy -target=aws_nat_gateway.main",
                  description: "Remove it through Terraform",
                  destructive: true,
                },
              ],
            },
          },
        }),
        orphan({
          id: "acc1:eip:ip-1",
          resourceTypeName: "Elastic IP",
          displayName: "spare-ip",
          reason: "Address is not associated",
          owner: {
            userId: "u1",
            displayName: "Ada",
            isLabel: false,
            ticketUrl: null,
            purpose: null,
          },
        }),
      ],
    },
  ],
  totalCount: 3,
  unownedCount: 1,
  costWindowDays: 30,
  generatedAt: "2026-11-08T11:00:00.000Z",
};

describe("orphans", () => {
  it("prints groups, idle evidence and remediation", async () => {
    serveRoutes(out, { "GET /orphans": ORPHANS });
    expect(await run("orphans")).toBe(0);
    expect(out.stdout).toMatchInlineSnapshot(`
      "Acme · 3 flagged resources

      prod · AWS
      RESOURCE   TYPE         REASON                                  OWNER            COST (30D)    
      old-data   EBS Volume   Volume is not attached to any instance  unowned                  $41.50
      nat-quiet  NAT Gateway  Idle NAT gateway                        platform (team)  $32.85/mo est.
      spare-ip   Elastic IP   Address is not associated               Ada                           —

      Idle evidence
        nat-quiet · Idle NAT gateway · 14 days · since 2026-11-01
          Bytes sent to the internet (BytesOutToDestination, sum): 0 B, flags at ≤ 1.0 KB
          estimate: hours only

      Remediation

        old-data
          # [destructive] Delete the volume
          aws ec2 delete-volume --volume-id vol-1 --profile $AWS_PROFILE

        nat-quiet
          Managed by Terraform at aws_nat_gateway.main: change the configuration rather than running the CLI commands.
          # [destructive] Remove it through Terraform
          terraform destroy -target=aws_nat_gateway.main

        spare-ip
          # [destructive] Delete the volume
          aws ec2 delete-volume --volume-id vol-1 --profile $AWS_PROFILE

      Set these first:
        export AWS_PROFILE=...   # The AWS CLI profile

      1 of 3 have no recorded owner. Nobody to ask before deleting, and nobody an alert can reach.

      Cost figures are best-effort per-resource billing matches; most providers don't report them. Figures marked est. are list prices for the resource's configuration. Confirm a resource is unused before deleting it.
      "
    `);
  });

  it("prints the org and the raw body under --json", async () => {
    serveRoutes(out, { "GET /orphans": ORPHANS });
    expect(await run("orphans", "--json")).toBe(0);
    expect(JSON.parse(out.stdout)).toEqual({ org: "org_1", ...ORPHANS });
  });

  it("drops the owner and cost columns for a local scan, and contacts no server", async () => {
    localOrphans.mockResolvedValue({ ...ORPHANS, costBasis: "unavailable" });
    serveRoutes(out, {});
    expect(await run("orphans", "--local")).toBe(0);
    expect(out.requests).toEqual([]);
    expect(out.stdout).toMatchInlineSnapshot(`
      "Local workspace · 3 flagged resources

      prod · AWS
      RESOURCE   TYPE         REASON                                
      old-data   EBS Volume   Volume is not attached to any instance
      nat-quiet  NAT Gateway  Idle NAT gateway                      
      spare-ip   Elastic IP   Address is not associated             

      Idle evidence
        nat-quiet · Idle NAT gateway · 14 days · since 2026-11-01
          Bytes sent to the internet (BytesOutToDestination, sum): 0 B, flags at ≤ 1.0 KB
          estimate: hours only

      Remediation

        old-data
          # [destructive] Delete the volume
          aws ec2 delete-volume --volume-id vol-1 --profile $AWS_PROFILE

        nat-quiet
          Managed by Terraform at aws_nat_gateway.main: change the configuration rather than running the CLI commands.
          # [destructive] Remove it through Terraform
          terraform destroy -target=aws_nat_gateway.main

        spare-ip
          # [destructive] Delete the volume
          aws ec2 delete-volume --volume-id vol-1 --profile $AWS_PROFILE

      Set these first:
        export AWS_PROFILE=...   # The AWS CLI profile

      Spend is collected by Infrawrench Cloud, so a local scan has no cost column. The flags never depend on billing data. Confirm a resource is unused before deleting it.
      "
    `);
    expect(out.stdout).not.toContain("cost (30d)");
  });

  it("says an empty local scan covered only this machine", async () => {
    localOrphans.mockResolvedValue({ ...ORPHANS, accounts: [], costBasis: "unavailable" });
    expect(await run("orphans", "--local")).toBe(0);
    expect(out.stdout).toMatchInlineSnapshot(`
      "Nothing looks wasted. Resources are flagged when a plugin heuristic matches. An empty list is the good outcome.
      This scan covered the local workspace only; drop --local to classify what your cloud accounts sync.
      "
    `);
  });

  it("prints a local scan as JSON without an org", async () => {
    localOrphans.mockResolvedValue({ ...ORPHANS, costBasis: "unavailable" });
    expect(await run("orphans", "--local", "--json")).toBe(0);
    expect(JSON.parse(out.stdout)).toEqual({ ...ORPHANS, costBasis: "unavailable" });
  });
});

// --- extended-support ------------------------------------------------------

const finding = (over: Record<string, unknown>) => ({
  resourceId: "acc1:eks:prod",
  pluginId: "aws",
  pluginName: "AWS",
  resourceTypeId: "eks-cluster",
  resourceTypeName: "EKS cluster",
  accountId: "acc1",
  accountName: "prod",
  displayName: "prod-cluster",
  externalId: "prod",
  region: "us-east-1",
  releaseId: "1.27",
  product: "Amazon EKS",
  engine: null,
  currentVersion: "1.27",
  targetVersion: "1.31",
  status: "surcharged",
  standardSupportEnds: "2024-07-24",
  surchargeStartsOn: "2024-07-25",
  daysUntilSurcharge: -800,
  extendedSupportEnds: "2025-07-24",
  daysUntilForcedUpgrade: -400,
  charged: true,
  quantity: 1,
  unit: null,
  currency: "USD",
  tierLabel: "extended",
  monthlySurcharge: 438,
  listMonthlySurcharge: 438,
  costBasis: "billed",
  billedLineItems: ["USE1-AmazonEKS-Hours:extendedSupport"],
  nextTier: null,
  priceNote: null,
  pricingUrl: null,
  upgradeUrl: "https://docs.aws.amazon.com/eks/",
  note: null,
  ...over,
});

const EXTENDED = {
  findings: [
    finding({}),
    finding({
      displayName: "legacy-db",
      product: "Amazon RDS for MySQL",
      currentVersion: "5.7",
      targetVersion: "8.0",
      status: "end-of-life",
      monthlySurcharge: 61.2,
      costBasis: "billed-share",
    }),
    finding({
      displayName: "staging-cluster",
      status: "upcoming",
      surchargeStartsOn: "2026-12-01",
      daysUntilSurcharge: 23,
      extendedSupportEnds: null,
      monthlySurcharge: null,
      currency: null,
      charged: false,
      costBasis: "unpriced",
    }),
    finding({ displayName: "odd-one", status: "brand-new-status", costBasis: "list-price" }),
  ],
  totalCount: 4,
  counts: { surcharged: 2, unsupported: 0, "end-of-life": 1, upcoming: 1 },
  currentMonthly: [{ currency: "USD", monthly: 937.2 }],
  upcomingMonthly: [{ currency: "USD", monthly: 73 }],
  leadDays: 90,
  billing: {
    windowDays: 30,
    accounts: [
      { accountId: "acc1", accountName: "prod", status: "read" },
      { accountId: "acc2", accountName: "legacy", status: "failed", error: "AccessDenied" },
    ],
    unattributed: [
      {
        lineItem: "USE1-ExtendedSupport:Aurora",
        region: "us-east-1",
        amount: 30,
        currency: "USD",
        accountId: "acc1",
        accountName: "prod",
        monthlyAmount: 30,
      },
    ],
  },
  generatedAt: "2026-11-08T11:00:00.000Z",
};

describe("extended-support", () => {
  it("prints findings, billing gaps and unattributed lines", async () => {
    serveRoutes(out, { "GET /extended-support": EXTENDED });
    expect(await run("extended-support")).toBe(0);
    expect(out.stdout).toMatchInlineSnapshot(`
      "Acme · 4 resources  paying $937/mo · upcoming $73.00/mo

      STATUS                   RESOURCE         ACCOUNT  VERSION                         WHEN                                 SURCHARGE             
      paying extended support  prod-cluster     prod     Amazon EKS 1.27 → 1.31          since 2024-07-25, forced 2025-07-24          $438/mo billed
      past end of support      legacy-db        prod     Amazon RDS for MySQL 5.7 → 8.0  ended 2025-07-24                     $61.20/mo billed share
      surcharge upcoming       staging-cluster  prod     Amazon EKS 1.27 → 1.31          starts 2026-12-01 (23d)                        no surcharge
      brand-new-status         odd-one          prod     Amazon EKS 1.27 → 1.31          since 2024-07-25, forced 2025-07-24            $438/mo list

      Billing unreadable for legacy; those rows are list price.
      Unattributed billed line: prod USE1-ExtendedSupport:Aurora us-east-1 $30.00/mo

      Billed amounts where the provider's billing names the charge, list price otherwise. Upgrade guides are in --json (upgradeUrl).
      "
    `);
    expect(out.stdout).toContain("brand-new-status");
  });

  it("prints the org and the raw body under --json", async () => {
    serveRoutes(out, { "GET /extended-support": EXTENDED });
    expect(await run("extended-support", "--json")).toBe(0);
    expect(JSON.parse(out.stdout)).toEqual({ org: "org_1", ...EXTENDED });
  });

  it("scans the local workspace at list price with --local", async () => {
    const { billing: _billing, ...local } = EXTENDED;
    localExtendedSupport.mockResolvedValue(local);
    serveRoutes(out, {});
    expect(await run("extended-support", "--local")).toBe(0);
    expect(out.requests).toEqual([]);
    expect(out.stdout).toMatchInlineSnapshot(`
      "Local workspace · 4 resources  paying $937/mo · upcoming $73.00/mo

      STATUS                   RESOURCE         ACCOUNT  VERSION                         WHEN                                 SURCHARGE             
      paying extended support  prod-cluster     prod     Amazon EKS 1.27 → 1.31          since 2024-07-25, forced 2025-07-24          $438/mo billed
      past end of support      legacy-db        prod     Amazon RDS for MySQL 5.7 → 8.0  ended 2025-07-24                     $61.20/mo billed share
      surcharge upcoming       staging-cluster  prod     Amazon EKS 1.27 → 1.31          starts 2026-12-01 (23d)                        no surcharge
      brand-new-status         odd-one          prod     Amazon EKS 1.27 → 1.31          since 2024-07-25, forced 2025-07-24            $438/mo list

      Local workspace, list price only. Upgrade guides are in --json (upgradeUrl).
      "
    `);
    expect(out.stdout).toContain("Local workspace, list price only.");
  });

  it("says when nothing is on an old version", async () => {
    serveRoutes(out, { "GET /extended-support": { ...EXTENDED, findings: [], totalCount: 0 } });
    expect(await run("extended-support")).toBe(0);
    expect(out.stdout).toMatchInlineSnapshot(`
      "Nothing is on an extended-support or end-of-life version (upcoming surcharges are listed 90 days ahead).
      "
    `);
  });
});

// --- probes ----------------------------------------------------------------

const probe = (over: Record<string, unknown>) => ({
  id: "p1",
  name: "Checkout",
  url: "https://shop.acme.com/health",
  method: "GET",
  intervalSeconds: 60,
  timeoutMs: 10000,
  failureThreshold: 3,
  enabled: true,
  accountId: null,
  resourceId: null,
  pluginId: null,
  resourceTypeId: null,
  outputKey: null,
  status: "up",
  consecutiveFailures: 0,
  lastProbeAt: "2026-11-08T11:59:00.000Z",
  lastStatusCode: 200,
  lastLatencyMs: 142,
  lastError: null,
  lastStateChangeAt: null,
  uptime24h: 0.9995,
  createdAt: "2026-10-01T00:00:00.000Z",
  updatedAt: "2026-10-01T00:00:00.000Z",
  ...over,
});

const PROBES = {
  probes: [
    probe({}),
    probe({
      id: "p2",
      name: "API",
      url: "https://api.acme.com/",
      status: "down",
      lastStatusCode: 503,
      lastError: "connect ECONNREFUSED",
      uptime24h: 0.95,
    }),
    probe({ id: "p3", name: "Docs", enabled: false, status: "unknown", uptime24h: null }),
    probe({
      id: "p4",
      name: "New",
      status: "unknown",
      lastProbeAt: null,
      lastLatencyMs: null,
      uptime24h: 0.992,
    }),
  ],
};

const METRICS_PATH = `GET /probes/p2/metrics?startMs=${NOW - 86_400_000}&endMs=${NOW}`;
const METRICS = {
  series: [
    { label: "Up", unit: "bool", points: [{ timestamp: 1, value: 1 }] },
    {
      label: "Latency",
      unit: "ms",
      points: [120, 180, 95, 300, 210].map((value, i) => ({ timestamp: i, value })),
    },
  ],
};

describe("probes", () => {
  it("lists probes", async () => {
    serveRoutes(out, { "GET /probes": PROBES });
    expect(await run("probes")).toBe(0);
    expect(out.stdout).toMatchInlineSnapshot(`
      "Acme · 4 probes  1 down

                  PROBE     ENDPOINT                          EVERY  UPTIME 24H  LATENCY  CHECKED         
      ● up        Checkout  GET https://shop.acme.com/health    60s      99.95%    142ms  2026-11-08 11:59
      ● down      API       GET https://api.acme.com/           60s         95%    142ms  2026-11-08 11:59
      ○ disabled  Docs      GET https://shop.acme.com/health    60s           —    142ms  2026-11-08 11:59
      ● pending   New       GET https://shop.acme.com/health    60s       99.2%        —  never           

      Probed from outside your infrastructure, so this is the internet's view. \`infrawrench probes <id|name>\` charts one probe's latency.
      "
    `);
  });

  it("prints the raw rows under --json", async () => {
    serveRoutes(out, { "GET /probes": PROBES });
    expect(await run("probes", "--json")).toBe(0);
    expect(JSON.parse(out.stdout)).toEqual({ org: "org_1", ...PROBES });
  });

  it("charts one probe matched by name", async () => {
    serveRoutes(out, { "GET /probes": PROBES, [METRICS_PATH]: METRICS });
    expect(await run("probes", "api")).toBe(0);
    expect(out.stdout).toMatchInlineSnapshot(`
      "API  ● down
      GET https://api.acme.com/ · every 60s
      uptime 24h 95% · last 142ms · HTTP 503 · connect ECONNREFUSED · checked 2026-11-08 11:59

      latency 24h ▁▄▁█▅
      min 95ms · max 300ms · 5 samples
      "
    `);
    expect(out.stdout).toContain("min 95ms · max 300ms · 5 samples");
  });

  it("prints one probe's raw row and series under --json", async () => {
    serveRoutes(out, { "GET /probes": PROBES, [METRICS_PATH]: METRICS });
    expect(await run("probes", "p2", "--json")).toBe(0);
    expect(JSON.parse(out.stdout)).toEqual({
      org: "org_1",
      probe: PROBES.probes[1],
      series: METRICS.series,
    });
  });

  it("refuses a probe nothing matches", async () => {
    serveRoutes(out, { "GET /probes": PROBES });
    expect(await run("probes", "nope")).toBe(1);
    expect(out.stderr).toBe('No probe matches "nope". Run `infrawrench probes` to list.\n');
  });

  it("refuses a second positional", async () => {
    expect(await run("probes", "a", "b")).toBe(2);
    expect(out.stdout).toBe("");
  });
});

// --- webhooks --------------------------------------------------------------

const subscription = (over: Record<string, unknown>) => ({
  id: "s1",
  name: "Ops hook",
  enabled: true,
  destination: { kind: "webhook", url: "https://hooks.acme.com/iw" },
  destinationLabel: "hooks.acme.com",
  secretHint: "a1b2",
  previousSecretExpiresAt: null,
  disabledReason: null,
  disabledAt: null,
  consecutiveFailures: 0,
  failingSince: null,
  lastSuccessAt: "2026-11-08T11:00:00.000Z",
  lastFailureAt: null,
  eventTypes: [],
  minSeverity: null,
  accountIds: [],
  environments: [],
  createdAt: "2026-10-01T00:00:00.000Z",
  updatedAt: "2026-10-01T00:00:00.000Z",
  ...over,
});

const SUBSCRIPTIONS = {
  subscriptions: [
    subscription({}),
    subscription({
      id: "s2",
      name: "Bus",
      destination: { kind: "publish", accountId: "acc1", resourceTypeId: "rule", resourceId: "r" },
      destinationLabel: "AWS / prod / EventBridge rule infra-events",
      eventTypes: ["budget.exceeded", "probe.down"],
      consecutiveFailures: 3,
      lastSuccessAt: null,
    }),
    subscription({
      id: "s3",
      name: "Old",
      enabled: false,
      disabledReason: "Failed 50 times in a row",
    }),
  ],
};

const delivery = (over: Record<string, unknown>) => ({
  id: "d1",
  subscriptionId: "s1",
  eventId: "e1",
  eventType: "infrawrench.test",
  state: "succeeded",
  attemptCount: 1,
  nextAttemptAt: null,
  lastAttemptAt: "2026-11-08T11:30:00.000Z",
  deliveredAt: "2026-11-08T11:30:00.000Z",
  responseStatus: 200,
  responseExcerpt: "ok",
  error: null,
  test: true,
  redeliveryOf: null,
  attempts: [],
  createdAt: "2026-11-08T11:30:00.000Z",
  payload: { id: "e1", type: "infrawrench.test" },
  ...over,
});

const DELIVERIES = {
  deliveries: [
    delivery({}),
    delivery({
      id: "d2",
      subscriptionId: "s2",
      eventType: "budget.exceeded",
      state: "dead",
      attemptCount: 8,
      responseStatus: null,
      error: "AccessDenied",
      test: false,
    }),
    delivery({ id: "d3", subscriptionId: "gone", state: "retrying", test: false }),
  ],
};

const TEST_PATH = "POST /event-subscriptions/s1/test";

describe("webhooks", () => {
  it("lists subscriptions bare and as `list`", async () => {
    serveRoutes(out, { "GET /event-subscriptions": SUBSCRIPTIONS });
    expect(await run("webhooks")).toBe(0);
    const bare = out.stdout;
    expect(bare).toMatchInlineSnapshot(`
      "              NAME      DESTINATION                                 EVENTS                       LAST DELIVERED  
      ● on          Ops hook  https://hooks.acme.com/iw                   all                          2026-11-08 11:00
      ● failing ×3  Bus       AWS / prod / EventBridge rule infra-events  budget.exceeded, probe.down  never           
      ● auto-off    Old       https://hooks.acme.com/iw                   all                          2026-11-08 11:00
      Old: Failed 50 times in a row
      "
    `);
    out.stdout = "";
    expect(await run("webhooks", "list")).toBe(0);
    expect(out.stdout).toBe(bare);
  });

  it("prints the raw rows under --json", async () => {
    serveRoutes(out, { "GET /event-subscriptions": SUBSCRIPTIONS });
    expect(await run("webhooks", "--json")).toBe(0);
    expect(JSON.parse(out.stdout)).toEqual({ org: "org_1", ...SUBSCRIPTIONS });
  });

  it("sends a test event", async () => {
    serveRoutes(out, {
      "GET /event-subscriptions": SUBSCRIPTIONS,
      [TEST_PATH]: { delivery: delivery({}) },
    });
    expect(await run("webhooks", "test", "ops hook")).toBe(0);
    expect(out.stdout).toMatchInlineSnapshot(`
      "✓ Ops hook: test delivered HTTP 200
      "
    `);
    expect(out.stdout).toBe("✓ Ops hook: test delivered HTTP 200\n");
  });

  it("prints the raw delivery under --json", async () => {
    serveRoutes(out, {
      "GET /event-subscriptions": SUBSCRIPTIONS,
      [TEST_PATH]: { delivery: delivery({}) },
    });
    expect(await run("webhooks", "test", "s1", "--json")).toBe(0);
    expect(JSON.parse(out.stdout)).toEqual(delivery({}));
  });

  it("says a queued test is queued", async () => {
    serveRoutes(out, {
      "GET /event-subscriptions": SUBSCRIPTIONS,
      [TEST_PATH]: { delivery: delivery({ state: "pending", responseStatus: null }) },
    });
    expect(await run("webhooks", "test", "s1")).toBe(0);
    expect(out.stdout).toBe("… Ops hook: test queued; it goes out within a minute\n");
  });

  it("exits 1 after a failed test delivery, not the 0 the legacy runner exited with", async () => {
    serveRoutes(out, {
      "GET /event-subscriptions": SUBSCRIPTIONS,
      [TEST_PATH]: {
        delivery: delivery({ state: "dead", responseStatus: 500, error: "Internal error" }),
      },
    });
    expect(await run("webhooks", "test", "s1")).toBe(1);
    expect(out.stderr).toBe("");
    expect(out.stdout).toMatchInlineSnapshot(`
      "✗ Ops hook: HTTP 500 Internal error
      "
    `);
    expect(out.stdout).toBe("✗ Ops hook: HTTP 500 Internal error\n");
  });

  it("asks for a target, exit 1", async () => {
    serveRoutes(out, { "GET /event-subscriptions": SUBSCRIPTIONS });
    expect(await run("webhooks", "test")).toBe(1);
    expect(out.stderr).toBe("Usage: infrawrench webhooks test <id|name>\n");
  });

  it("refuses a subscription nothing matches, exit 1", async () => {
    serveRoutes(out, { "GET /event-subscriptions": SUBSCRIPTIONS });
    expect(await run("webhooks", "test", "nope")).toBe(1);
    expect(out.stderr).toBe(
      'No event subscription matches "nope". Run `infrawrench webhooks` to list.\n',
    );
  });

  it("prints the whole delivery log", async () => {
    serveRoutes(out, {
      "GET /event-subscriptions": SUBSCRIPTIONS,
      "GET /event-subscriptions/deliveries?limit=50": DELIVERIES,
    });
    expect(await run("webhooks", "deliveries")).toBe(0);
    expect(out.stdout).toMatchInlineSnapshot(`
      "STATE      EVENT                    SUBSCRIPTION  TRIES  STATUS  WHEN              ERROR       
      delivered  infrawrench.test (test)  Ops hook      1      200     2026-11-08 11:30              
      failed     budget.exceeded          Bus           8      -       2026-11-08 11:30  AccessDenied
      retrying   infrawrench.test         gone          1      200     2026-11-08 11:30              
      "
    `);
    expect(out.stdout).toContain("SUBSCRIPTION");
  });

  it("prints one subscription's log without the subscription column", async () => {
    serveRoutes(out, {
      "GET /event-subscriptions": SUBSCRIPTIONS,
      "GET /event-subscriptions/deliveries?limit=50&subscriptionId=s2": DELIVERIES,
    });
    expect(await run("webhooks", "deliveries", "bus")).toBe(0);
    expect(out.stdout).toMatchInlineSnapshot(`
      "STATE      EVENT                    TRIES  STATUS  WHEN              ERROR       
      delivered  infrawrench.test (test)  1      200     2026-11-08 11:30              
      failed     budget.exceeded          8      -       2026-11-08 11:30  AccessDenied
      retrying   infrawrench.test         1      200     2026-11-08 11:30              
      "
    `);
    expect(out.stdout).not.toContain("SUBSCRIPTION");
  });

  it("prints the raw log under --json", async () => {
    serveRoutes(out, {
      "GET /event-subscriptions": SUBSCRIPTIONS,
      "GET /event-subscriptions/deliveries?limit=50": DELIVERIES,
    });
    expect(await run("webhooks", "deliveries", "--json")).toBe(0);
    expect(JSON.parse(out.stdout)).toEqual({ org: "org_1", ...DELIVERIES });
  });

  it("answers an unknown verb with help on stderr, exit 2", async () => {
    expect(await run("webhooks", "frobnicate")).toBe(2);
    expect(out.stdout).toBe("");
    expect(out.stderr).toContain("infrawrench webhooks");
  });
});

// --- slos ------------------------------------------------------------------

const slo = (over: Record<string, unknown>) => ({
  id: "slo1",
  name: "Checkout availability",
  description: "Customers can pay.",
  sliKind: "probe_availability",
  probeId: "p1",
  latencyThresholdMs: null,
  resourceId: null,
  metricKey: null,
  comparator: null,
  threshold: null,
  targetPercent: 99.9,
  windowDays: 30,
  alertsEnabled: true,
  suggestFreeze: true,
  enabled: true,
  probeName: "Checkout",
  resourceName: null,
  accountId: null,
  pluginId: null,
  resourceTypeId: null,
  status: "ok",
  sli: 0.99962,
  goodEvents: 43180,
  totalEvents: 43200,
  budgetRemaining: 0.62,
  budgetTotalMinutes: 43.2,
  budgetRemainingMinutes: 26.8,
  burnRates: { "5m": 0, "30m": 0.4, "1h": 0.5, "6h": 0.8, "3d": null },
  burnAlert: "none",
  exhaustedAt: null,
  lastEvalAt: "2026-11-08T11:55:00.000Z",
  lastError: null,
  createdAt: "2026-10-01T00:00:00.000Z",
  updatedAt: "2026-10-01T00:00:00.000Z",
  ...over,
});

const SLOS = {
  slos: [
    slo({}),
    slo({
      id: "slo2",
      name: "API latency",
      sliKind: "probe_latency",
      probeName: "API",
      latencyThresholdMs: 300,
      status: "exhausted",
      budgetRemaining: -0.4,
      budgetRemainingMinutes: -17.3,
      burnRates: { "1h": 14.2 },
      lastError: "metric store timed out",
    }),
    slo({
      id: "slo3",
      name: "DB CPU",
      sliKind: "metric_threshold",
      metricKey: "CPU %",
      comparator: "<",
      threshold: 80,
      resourceName: "db-1",
      status: "slow_burn",
      budgetRemaining: 0.2,
      budgetRemainingMinutes: 8.6,
    }),
    slo({ id: "slo4", name: "Paused", enabled: false, status: "unknown", sli: null }),
  ],
};

const HOUR_MS = 3_600_000;
const SLO_DETAIL = {
  slo: SLOS.slos[1],
  buckets: Array.from({ length: 72 }, (_, i) => ({
    startMs: NOW - (72 - i) * HOUR_MS,
    good: i % 10 === 0 ? 59 : 60,
    total: 60,
  })),
  activeFreeze: null,
};

describe("slos", () => {
  it("lists SLOs worst first", async () => {
    serveRoutes(out, { "GET /slos": SLOS });
    expect(await run("slos")).toBe(0);
    expect(out.stdout).toMatchInlineSnapshot(`
      "Acme · 4 SLOs  1 burning or spent

                      SLO                    SLI / TARGET     WINDOW  BUDGET LEFT      BURN 1H  SOURCE                             
      ● budget spent  API latency            99.962% / 99.9%     30d  over by 17m 18s    14.2×  Probe "API" answering within 300 ms
      ● slow burn     DB CPU                 99.962% / 99.9%     30d     20% (8m 36s)     0.5×  CPU % < 80 on "db-1"               
      ○ disabled      Paused                       - / 99.9%     30d    62% (26m 48s)     0.5×  Availability of probe "Checkout"   
      ● ok            Checkout availability  99.962% / 99.9%     30d    62% (26m 48s)     0.5×  Availability of probe "Checkout"   

      \`infrawrench slos <id|name>\` shows one SLO's burn rates and budget burndown.
      "
    `);
  });

  it("prints the raw rows under --json", async () => {
    serveRoutes(out, { "GET /slos": SLOS });
    expect(await run("slos", "--json")).toBe(0);
    expect(JSON.parse(out.stdout)).toEqual({ org: "org_1", ...SLOS });
  });

  it("shows one SLO's burn rates and charts", async () => {
    serveRoutes(out, { "GET /slos": SLOS, "GET /slos/slo2": SLO_DETAIL });
    expect(await run("slos", "latency")).toBe(0);
    expect(out.stdout).toMatchInlineSnapshot(`
      "API latency  ● budget spent
      Probe "API" answering within 300 ms · 99.9% over 30 days
      Customers can pay.

      SLI 99.962% · budget over by 17m 18s of 43m 12s · 43200 minutes measured · evaluated 2026-11-08 11:55
      metric store timed out
      Error budget spent: consider a change freeze (start one from the SLOs tab).

      burn rates
      5m -   30m -   1h 14.2×   6h -   3d -
      page when 1h and 5m both ≥ 14.4×
      page when 6h and 30m both ≥ 6×
      ticket when 3d and 6h both ≥ 1×

      SLI per day      ▁██▁
      budget burndown  █████████▇▇▇▇▇▇▇▇▆▆▆▆▆▆▆▆▅▅▅▅▅▅▅▅▅▄▄▄▄▄▄▄▄▃▃▃▃▃▃▃▃▂▂▂▂▂▂▂▂▂▁
      budget 77% → -85% over the window
      "
    `);
    expect(out.stdout).toContain("consider a change freeze");
  });

  it("prints one SLO's raw detail under --json", async () => {
    serveRoutes(out, { "GET /slos": SLOS, "GET /slos/slo2": SLO_DETAIL });
    expect(await run("slos", "slo2", "--json")).toBe(0);
    expect(JSON.parse(out.stdout)).toEqual({ org: "org_1", ...SLO_DETAIL });
  });

  it("refuses an SLO nothing matches", async () => {
    serveRoutes(out, { "GET /slos": SLOS });
    expect(await run("slos", "nope")).toBe(1);
    expect(out.stderr).toBe('No SLO matches "nope". Run `infrawrench slos` to list.\n');
  });
});

// --- commitments -----------------------------------------------------------

const holding = (over: Record<string, unknown>) => ({
  accountId: "acc1",
  accountName: "prod",
  pluginId: "aws",
  commitmentId: "sp-1",
  kind: "savings_plan",
  description: "Compute Savings Plan",
  scope: null,
  region: null,
  startDate: "2025-01-01T00:00:00.000Z",
  endDate: "2028-01-01T00:00:00.000Z",
  termDays: 1095,
  paymentOption: "no_upfront",
  currency: "USD",
  upfrontAmount: null,
  recurringAmount: 2.5,
  recurringPeriod: "hour",
  hourlyCommitmentAmount: 2.5,
  unitCommitments: null,
  state: "active",
  providerUtilization: null,
  lastSeenAt: "2026-11-08T00:00:00.000Z",
  utilization: {
    utilization: 0.93,
    obligationAmount: 1800,
    deliveredAmount: 1674,
    activeDays: 30,
    measuredDays: 28,
    missingDays: 2,
    windowDays: 30,
  },
  ...over,
});

const COMMITMENTS = {
  holdings: [
    holding({}),
    holding({
      commitmentId: "ri-1",
      kind: "reserved_instance",
      description: "m5.large RI",
      region: "us-east-1",
      hourlyCommitmentAmount: null,
      upfrontAmount: 1200,
      state: "queued",
      utilization: {
        utilization: 0.41,
        obligationAmount: 100,
        deliveredAmount: 41,
        activeDays: 30,
        measuredDays: 30,
        missingDays: 0,
        windowDays: 30,
      },
    }),
    holding({
      accountName: "gcp-prod",
      pluginId: "gcp",
      commitmentId: "cud-1",
      description: "n2 CUD",
      currency: null,
      hourlyCommitmentAmount: null,
      unitCommitments: [{ unit: "vCPU", amount: 32 }],
      endDate: null,
      state: "expired",
      utilization: {
        utilization: null,
        reason: "unit_denominated",
        obligationAmount: null,
        deliveredAmount: 0,
        activeDays: 0,
        measuredDays: 0,
        missingDays: 0,
        windowDays: 30,
      },
    }),
    holding({
      accountName: "azure",
      pluginId: "azure",
      commitmentId: "az-1",
      description: "VM reservation",
      currency: null,
      hourlyCommitmentAmount: null,
      providerUtilization: [
        { grainDays: 7, percentage: 88 },
        { grainDays: 30, percentage: 91 },
      ],
      utilization: {
        utilization: null,
        reason: "no_data_days",
        obligationAmount: null,
        deliveredAmount: 0,
        activeDays: 30,
        measuredDays: 0,
        missingDays: 30,
        windowDays: 30,
      },
    }),
  ],
  coverage: {
    available: true,
    currencies: [
      {
        currency: "USD",
        coveredAmount: 1674,
        uncoveredAmount: 900,
        uncoveredEligibleAmount: 400,
        broadRatio: 0.65,
        narrowRatio: 0.81,
      },
    ],
    excludedAccountIds: ["acc9"],
  },
  planner: {
    available: true,
    windowDayCount: 90,
    recommendations: [
      {
        pluginId: "aws",
        service: "EC2",
        region: "us-east-1",
        currency: "USD",
        recommendedDailyCommitment: 24,
        recommendedHourlyCommitment: 1,
        annualCommitment: 8760,
        p50DailySpend: 30,
        savingBasis: "range",
        discountRateMin: 0.2,
        discountRateMax: 0.4,
        estimatedAnnualSavingMin: 1752,
        estimatedAnnualSavingMax: 3504,
        breakEvenUtilization: 0.6,
        annualLossIfUsageHalves: 800,
      },
      {
        pluginId: "aws",
        service: "Lambda",
        region: "",
        currency: "USD",
        recommendedDailyCommitment: 2.4,
        recommendedHourlyCommitment: 0.1,
        annualCommitment: 876,
        p50DailySpend: 3,
        savingBasis: "upper_bound",
        discountRateMax: 0.17,
        estimatedAnnualSavingMax: 149,
        breakEvenUtilization: 0.83,
        annualLossIfUsageHalves: 40,
      },
    ],
    rejected: [],
  },
  failures: [
    {
      accountId: "acc3",
      accountName: "billing",
      pluginId: "aws",
      message: "AccessDenied: ce:GetReservationUtilization",
      failureCount: 2,
    },
  ],
  pendingAccountIds: ["acc4"],
  utilizationWindowDays: 30,
  plannerWindowDays: 90,
};

describe("commitments", () => {
  // `commitments` formats money in the terminal's own locale; pin it so the
  // snapshots read the same on every machine.
  beforeEach(() => {
    const NumberFormat = Intl.NumberFormat;
    vi.spyOn(Intl, "NumberFormat").mockImplementation(function (
      locales?: Intl.LocalesArgument,
      options?: Intl.NumberFormatOptions,
    ) {
      return new NumberFormat(locales ?? "en-US", options);
    });
  });

  it("prints holdings, coverage, the planner and failures", async () => {
    serveRoutes(out, { "GET /commitments": COMMITMENTS });
    expect(await run("commitments")).toBe(0);
    expect(out.stdout).toMatchInlineSnapshot(`
      "Acme · 4 commitments (2 active) · utilization over 30d of collected data
        USD usage covered by commitments: 65%–81%
        1 account(s) excluded: provider can't tell charge types apart

      COMMITMENT            ACCOUNT   REGION       COMMITTED       ENDS        STATE    UTILIZATION        
      Compute Savings Plan  prod      all regions  $2.50/h         2028-01-01  active   93% (2d no data)   
      m5.large RI           prod      us-east-1    $1,200 upfront  2028-01-01  queued   41%                
      n2 CUD                gcp-prod  all regions  32 vCPU         —           expired  unit-denominated   
      VM reservation        azure     all regions  not reported    2028-01-01  active   91% (provider, 30d)

      Savings planner
      Sized at the p10 floor of 90d uncovered usage spend. Recommendations only. Nothing is purchased automatically.
      WORKLOAD               COMMIT   ANNUAL  SAVING            BREAK-EVEN               
      aws · EC2 · us-east-1  $1.00/h  $8,760  $1,752–$3,504/yr  60% util (can shrink 40%)
      aws · Lambda           $0.10/h  $876    up to $149/yr     83% util (can shrink 17%)
      Break-even is exact: at discount d the commitment pays for itself down to 1−d utilization. Savings quote published “up to” rates.

      billing: AccessDenied: ce:GetReservationUtilization

      1 account(s) awaiting first commitment collection.
      "
    `);
  });

  it("prints the org and the raw body under --json", async () => {
    serveRoutes(out, { "GET /commitments": COMMITMENTS });
    expect(await run("commitments", "--json")).toBe(0);
    expect(JSON.parse(out.stdout)).toEqual({ org: "org_1", ...COMMITMENTS });
  });

  it("says when no account reports commitments", async () => {
    serveRoutes(out, {
      "GET /commitments": {
        ...COMMITMENTS,
        holdings: [],
        failures: [],
        planner: { ...COMMITMENTS.planner, recommendations: [] },
      },
    });
    expect(await run("commitments")).toBe(0);
    expect(out.stdout).toMatchInlineSnapshot(`
      "No commitments found. Only AWS, GCP and Azure accounts report reservations, savings plans or committed-use discounts.
      "
    `);
  });

  it("reports a body that is not the feed", async () => {
    serveRoutes(out, { "GET /commitments": { holdings: "nope" } });
    expect(await run("commitments")).toBe(1);
    expect(out.stderr).toMatch(/^Cloud request returned a malformed response for \/commitments: /);
  });
});
