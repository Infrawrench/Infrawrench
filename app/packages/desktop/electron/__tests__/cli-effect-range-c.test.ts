import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// `tags`, `showback`, `k8s-network`, `ai-spend`, `scenarios` and
// `billing-rules` on effect/cli: text and `--json` output, refusals and exit
// codes, against fixtures. Nothing reaches a network or a database.
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

// ---------------------------------------------------------------------------
// tags and showback
// ---------------------------------------------------------------------------

const COMPLIANCE = {
  policy: {
    requiredTags: [{ key: "owner" }, { key: "env", allowedValues: ["prod", "dev"] }],
    enforceOnCreate: true,
  },
  accounts: [
    {
      accountId: "acc_1",
      pluginId: "aws",
      displayName: "prod",
      totalResources: 40,
      evaluated: 32,
      compliant: 30,
      score: 94,
    },
    {
      accountId: "acc_2",
      pluginId: "gcp",
      displayName: "data",
      totalResources: 10,
      evaluated: 10,
      compliant: 6,
      score: 60,
    },
    {
      accountId: "acc_3",
      pluginId: "cloudflare",
      displayName: "edge",
      totalResources: 3,
      evaluated: 0,
      compliant: 0,
      score: null,
    },
  ],
};

const UNTAGGED = {
  from: "2026-10-10",
  to: "2026-11-08",
  requiredKeys: ["owner", "env"],
  currencies: ["USD"],
  totals: { USD: 12000 },
  untaggedTotals: { USD: 3400.5 },
  byKey: [],
  topUntagged: [
    { accountId: "acc_1", accountLabel: "prod", service: "EC2", currency: "USD", amount: 2000 },
    { accountId: "acc_2", accountLabel: "data", service: "", currency: "USD", amount: 1400.5 },
  ],
};

const SHOWBACK = {
  from: "2026-10-10",
  to: "2026-11-08",
  currencies: ["USD"],
  centres: [
    {
      costCentreId: "cc_eng",
      name: "Engineering",
      totals: { USD: 100 },
      subtreeTotals: { USD: 900 },
      parentId: null,
      depth: 0,
    },
    {
      costCentreId: "cc_plat",
      name: "Platform",
      totals: { USD: 800 },
      subtreeTotals: { USD: 800 },
      parentId: "cc_eng",
      depth: 1,
    },
    {
      costCentreId: null,
      name: "Unallocated",
      totals: { USD: 50 },
      subtreeTotals: { USD: 50 },
      parentId: null,
      depth: 0,
    },
  ],
};

describe("tags", () => {
  const untaggedPath = "GET /costs/untagged?from=2026-10-10&to=2026-11-08";

  it("prints policy, compliance and untagged spend", async () => {
    serveRoutes(out, { "GET /tag-policy/compliance": COMPLIANCE, [untaggedPath]: UNTAGGED });
    expect(await run("tags")).toBe(0);
    expect(out.stdout).toMatchInlineSnapshot(`
      "Acme · requires owner, env(prod|dev) [enforced at create]

      ACCOUNT          TAGGABLE  COMPLIANT  SCORE
      prod aws         32 of 40         30    94%
      data gcp               10          6    60%
      edge cloudflare    0 of 3          0      —

      $3,400.50 of $12,000.00 missing a required tag · 2026-10-10 → 2026-11-08

      prod · EC2 ████████████████████████████████ $2,000.00
      data       ██████████████████████░░░░░░░░░░ $1,400.50
      "
    `);
    out.stdout = "";
    expect(await run("tags", "--json")).toBe(0);
    expect(out.stdout).toBe(
      pretty({
        org: "org_1",
        from: "2026-10-10",
        to: "2026-11-08",
        ...COMPLIANCE,
        untagged: UNTAGGED,
      }),
    );
  });

  it("says when there is no policy or no spend", async () => {
    serveRoutes(out, {
      "GET /tag-policy/compliance": {
        policy: { requiredTags: [], enforceOnCreate: false },
        accounts: [],
      },
      "GET /costs/untagged?from=2026-11-02&to=2026-11-08": UNTAGGED,
    });
    expect(await run("tags", "--last", "1w")).toBe(0);
    serveRoutes(out, {
      "GET /tag-policy/compliance": { ...COMPLIANCE, accounts: [] },
      "GET /costs/untagged?from=2026-09-01&to=2026-09-30": { ...UNTAGGED, currencies: [] },
    });
    out.stdout = "";
    expect(await run("tags", "--from", "2026-09-01", "--to", "2026-09-30")).toBe(0);
    expect(out.stdout).toMatchInlineSnapshot(`
      "Acme · requires owner, env(prod|dev) [enforced at create]

      No accounts connected.

      No spend collected between 2026-09-01 and 2026-09-30.
      "
    `);
  });

  it("refuses --local", async () => {
    expect(await run("tags", "--local")).toBe(1);
  });
});

describe("showback", () => {
  it("prints the centre tree", async () => {
    serveRoutes(out, { "GET /costs/showback?from=2026-10-10&to=2026-11-08": SHOWBACK });
    expect(await run("showback")).toBe(0);
    expect(out.stdout).toMatchInlineSnapshot(`
      "Acme · showback, 2026-10-10 → 2026-11-08

      Engineering (own $100.00) ████████████████████████████████ $900.00
        Platform                ████████████████████████████░░░░ $800.00
      unallocated               ██░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░ $50.00
      "
    `);
    out.stdout = "";
    expect(await run("showback", "--json")).toBe(0);
    expect(out.stdout).toBe(pretty({ org: "org_1", ...SHOWBACK }));
  });

  it("says when there are no centres or no spend, and refuses --local", async () => {
    serveRoutes(out, {
      "GET /costs/showback?from=2026-10-10&to=2026-11-08": { ...SHOWBACK, centres: [] },
    });
    expect(await run("showback")).toBe(0);
    serveRoutes(out, {
      "GET /costs/showback?from=2026-10-10&to=2026-11-08": {
        ...SHOWBACK,
        centres: [{ ...SHOWBACK.centres[0], totals: {}, subtreeTotals: {} }],
      },
    });
    out.stdout = "";
    expect(await run("showback")).toBe(0);
    out.stdout = "";
    out.stderr = "";
    expect(await run("showback", "--local")).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// k8s-network
// ---------------------------------------------------------------------------

const flowAccount = (id: string, name: string, recut: boolean) => ({
  accountId: id,
  pluginId: "kubernetes",
  displayName: name,
  supportsFlows: true,
  recut,
  collectedThrough: null,
  lastPolledAt: null,
  failureCount: 0,
  lastError: null,
  lastErrorHelpUrl: null,
  sources: [],
  lastQueryBytesScanned: null,
});

const FEED = (accounts: unknown[]) => ({
  enabled: true,
  initialLookbackDays: 7,
  estimated: true,
  range: { from: "2026-11-01", to: "2026-11-08" },
  scopes: [],
  topFlows: [],
  accounts,
  rateCards: [],
  totals: { bytes: 0, estimatedCost: 0, currency: "USD", unattributedBytes: 0, truncatedBytes: 0 },
});

const k8sRow = (label: string, bytes: number, cost: number, allocated: number | null) => ({
  key: label,
  label,
  namespace: "default",
  kind: "workload",
  bytes,
  estimatedCost: cost,
  allocatedCost: allocated,
  byScope: { cross_zone: bytes / 2, internet_egress: bytes / 4, intra_zone: bytes / 4 },
  method: "in_cluster_flows",
});

const endpoint = (ref: string, label: string) => ({
  ref,
  label,
  zone: "a",
  region: "us-east-1",
  service: "",
  resourceTypeId: "pod",
});

const K8S = {
  accountId: "k_1",
  displayName: "prod-cluster",
  range: { from: "2026-10-26", to: "2026-11-08" },
  estimated: true,
  currency: "USD",
  totals: { bytes: 5_400_000_000, estimatedCost: 120.5, allocatedCost: 90, unallocatedCost: 10 },
  billed: {
    query: "service = 'DataTransfer'",
    error: "Two rows had no usage",
    billedCost: 100,
    basis: "bytes",
    scaledDays: 0,
    daysWithoutBilled: 0,
  },
  scopes: [
    { scope: "cross_zone", bytes: 3_000_000_000, estimatedCost: 60, allocatedCost: 50 },
    { scope: "internet_egress", bytes: 2_400_000_000, estimatedCost: 60.5, allocatedCost: null },
  ],
  methods: [
    { method: "in_cluster_flows", bytes: 4_000_000_000 },
    { method: "counter_estimate", bytes: 1_400_000_000 },
  ],
  namespaces: [k8sRow("default", 4_000_000_000, 100, 80)],
  workloads: [k8sRow("api", 2_000_000, 10, null), k8sRow("worker", 900, 0.5, 0.4)],
  topTalkers: [
    {
      source: endpoint("pod/api", "api"),
      destination: endpoint("ip/1.2.3.4", ""),
      scope: "internet_egress",
      direction: "egress",
      attribution: "resolved",
      bytes: 1_000_000_000,
      packets: 10,
      estimatedCost: 9,
      currency: "USD",
      accountId: "k_1",
      pluginId: "kubernetes",
      days: 3,
    },
  ],
  collection: {
    ...flowAccount("k_1", "prod-cluster", true),
    lastError: "Flow logs bucket unreadable",
    sources: [
      {
        id: "s1",
        target: "vpc-1",
        region: null,
        destinationType: "s3",
        usable: false,
        unusableReason: "No read access",
        helpUrl: null,
      },
    ],
  },
};

describe("k8s-network", () => {
  const reportPath = "GET /network-flows/kubernetes/k_1?from=2026-10-26&to=2026-11-08";

  it("prints the only cluster's report", async () => {
    serveRoutes(out, {
      "GET /network-flows?limit=1": FEED([
        flowAccount("k_1", "prod-cluster", true),
        flowAccount("k_2", "old", false),
      ]),
      [reportPath]: K8S,
    });
    expect(await run("k8s-network")).toBe(0);
    expect(out.stdout).toMatchInlineSnapshot(`
      "~$120.50 · estimated at list price · prod-cluster · 2026-10-26 → 2026-11-08 · 5.4 GB
      $100.00 billed · $90.00 allocated to workloads · $10.00 unallocated · split by bytes alone (weakest basis)
      Two rows had no usage
      in-cluster flows 74% · pod counters only 26%
      · No read access
      Flow logs bucket unreadable

      By traffic class
      cross-zone      █████████████████████████░░░░░ $50.00 3.0 GB
      internet egress ██████████████████████████████ $60.50 2.4 GB

      By namespace
      NAME     MOSTLY      SOURCE            BYTES   ALLOCATED
      default  cross-zone  in-cluster flows  4.0 GB     $80.00

      By workload
      NAME    MOSTLY      SOURCE            BYTES   ALLOCATED
      api     cross-zone  in-cluster flows  2.0 MB     $10.00
      worker  cross-zone  in-cluster flows   900 B      $0.40

      Top talkers
        api → ip/1.2.3.4 internet egress · 1.0 GB $9.00

      Derived, never collected: these bytes also leave through the nodes, so they are kept out of org-wide network totals and never added to the cost store.
      "
    `);
    out.stdout = "";
    expect(await run("k8s-network", "--json")).toBe(0);
    expect(out.stdout).toBe(pretty(K8S));
  });

  it("picks a named cluster, with a range, a limit and no billed source", async () => {
    serveRoutes(out, {
      "GET /network-flows?limit=1": FEED([
        flowAccount("k_1", "prod-cluster", true),
        flowAccount("k_2", "staging", true),
      ]),
      "GET /network-flows/kubernetes/k_2?from=2026-11-02&to=2026-11-08&limit=5": {
        ...K8S,
        billed: { ...K8S.billed, billedCost: null, error: null, basis: "none" },
        collection: null,
        topTalkers: [],
        scopes: [],
      },
    });
    expect(await run("k8s-network", "stag", "--last", "1w", "--limit", "5")).toBe(0);
    expect(out.stdout).toMatchInlineSnapshot(`
      "~$120.50 · estimated at list price · prod-cluster · 2026-10-26 → 2026-11-08 · 5.4 GB
      No billed data-transfer source set: figures are list-price estimates.
      in-cluster flows 74% · pod counters only 26%

      By namespace
      NAME     MOSTLY      SOURCE            BYTES   ESTIMATED
      default  cross-zone  in-cluster flows  4.0 GB     $80.00

      By workload
      NAME    MOSTLY      SOURCE            BYTES   ESTIMATED
      api     cross-zone  in-cluster flows  2.0 MB     $10.00
      worker  cross-zone  in-cluster flows   900 B      $0.40

      Derived, never collected: these bytes also leave through the nodes, so they are kept out of org-wide network totals and never added to the cost store.
      "
    `);
  });

  it("refuses with no clusters, several unnamed, and an unknown one", async () => {
    serveRoutes(out, { "GET /network-flows?limit=1": FEED([]) });
    expect(await run("k8s-network")).toBe(1);
    serveRoutes(out, {
      "GET /network-flows?limit=1": FEED([
        flowAccount("k_1", "prod-cluster", true),
        flowAccount("k_2", "staging", true),
      ]),
    });
    out.stdout = "";
    out.stderr = "";
    expect(await run("k8s-network")).toBe(1);
    out.stdout = "";
    out.stderr = "";
    expect(await run("k8s-network", "nope")).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// ai-spend
// ---------------------------------------------------------------------------

const DIMENSIONS = {
  dimensions: [
    {
      id: "d1",
      key: "team",
      label: "Team",
      metadataKeys: ["team"],
      createdAt: "2026-10-01T00:00:00.000Z",
      updatedAt: "2026-10-01T00:00:00.000Z",
    },
    {
      id: "d2",
      key: "feature",
      label: "Feature",
      metadataKeys: ["feature"],
      createdAt: "2026-10-01T00:00:00.000Z",
      updatedAt: "2026-10-01T00:00:00.000Z",
    },
  ],
};

const STATS = {
  from: "2026-10-10",
  to: "2026-11-08",
  sources: [
    {
      sourceId: "s1",
      name: "OpenAI logs",
      days: 30,
      requests: 12000,
      matchedRequests: 11000,
      ambiguousRequests: 400,
      unmatchedRequests: 600,
      skippedRecords: 0,
      currency: "USD",
      attributedAmount: 900,
      billedAmount: 1000,
      coveragePercent: 90.04,
      degradedDays: 0,
      truncatedDays: 0,
    },
  ],
  providers: [
    {
      provider: "openai",
      currency: "USD",
      billedAmount: 1000,
      attributedAmount: 900,
      unattributedAmount: 100,
    },
  ],
  attributedDays: 30,
};

const SPEND = {
  from: "2026-10-10",
  to: "2026-11-08",
  dimension: "team",
  tagKey: "ai:team",
  rows: [
    { value: "search", currency: "USD", amount: 600 },
    { value: "", currency: "USD", amount: 300 },
  ],
};

const SOURCES = {
  sources: [
    {
      id: "s1",
      name: "OpenAI logs",
      kind: "plugin",
      pluginId: "openai",
      accountId: "acc_1",
      accountName: "main",
      sourceKindId: "openai-usage",
      location: {},
      enabled: true,
      lookbackDays: 7,
      baseUrl: null,
      hasApiKey: true,
      collectedThrough: "2026-11-07",
      lastRunAt: null,
      nextRunAt: null,
      lastError: null,
      lastErrorHelpUrl: null,
      failureCount: 0,
    },
    {
      id: "s2",
      name: "Gateway",
      kind: "http",
      pluginId: null,
      accountId: null,
      accountName: null,
      sourceKindId: "http-json",
      location: {},
      enabled: false,
      lookbackDays: 7,
      baseUrl: "https://gw.example.com",
      hasApiKey: false,
      collectedThrough: null,
      lastRunAt: null,
      nextRunAt: null,
      lastError: "401 from gateway",
      lastErrorHelpUrl: null,
      failureCount: 3,
    },
  ],
};

// ---------------------------------------------------------------------------
// scenarios
// ---------------------------------------------------------------------------

const adjustment = (over: Record<string, unknown>) => ({
  id: "adj",
  label: "Adjustment",
  kind: "one_off",
  startDate: "2026-12-01",
  endDate: null,
  amountCents: 4_000_000,
  currency: null,
  period: null,
  percent: null,
  scope: [],
  ...over,
});

const MODELS = {
  models: [
    {
      id: "sm_1",
      name: "Q1 plan",
      description: "Known spend for Q1",
      currency: "USD",
      adjustments: [
        adjustment({ label: "GPU purchase" }),
        adjustment({
          label: "New team",
          kind: "recurring",
          period: "monthly",
          amountCents: 1_200_000,
          endDate: "2027-03-31",
        }),
        adjustment({
          label: "Migration",
          kind: "rate_change",
          percent: -20,
          amountCents: null,
          scope: [
            { dimension: "provider", op: "in", values: ["aws", "gcp"] },
            { dimension: "tag", op: "is_set", values: [], tagKey: "env" },
          ],
        }),
        adjustment({
          label: "Daily",
          kind: "recurring",
          period: "daily",
          amountCents: -5000,
          currency: "EUR",
        }),
      ],
      createdByUserId: null,
      createdAt: "2026-10-01T00:00:00.000Z",
      updatedAt: "2026-10-01T00:00:00.000Z",
    },
  ],
};

const point = (bucket: string, amount: number) => ({ bucket, amount });

const PROJECTION = {
  series: [],
  currencies: ["USD"],
  forecast: [point("2026-11-09", 100), point("2026-11-10", 110), point("2026-11-11", 120)],
  scenario: {
    modelId: "sm_1",
    modelName: "Q1 plan",
    currency: "USD",
    points: [point("2026-11-09", 100), point("2026-11-10", 150), point("2026-11-11", 160)],
    contributions: [
      { adjustmentId: "a", label: "GPU purchase", kind: "one_off", amount: 80 },
      { adjustmentId: "b", label: "Migration", kind: "rate_change", amount: -10 },
      { adjustmentId: "c", label: "Daily", kind: "recurring", amount: 0 },
    ],
    totalDelta: 70,
    convertedFrom: "EUR",
    outOfScope: ["Daily"],
  },
};

// ---------------------------------------------------------------------------
// billing-rules
// ---------------------------------------------------------------------------

const billingRule = (id: string, name: string, over: Record<string, unknown>) => ({
  id,
  name,
  description: null,
  enabled: true,
  priority: 10,
  match: {},
  adjustment: { kind: "percentage", percent: 10 },
  createdAt: "2026-10-01T00:00:00.000Z",
  updatedAt: "2026-10-02T00:00:00.000Z",
  ...over,
});

const RULES = [
  billingRule("br_1", "Support markup", {
    description: "Our 10% on everything",
    match: { pluginId: "aws", tagKey: "billable", tagValue: "yes" },
  }),
  billingRule("br_2", "Platform fee", {
    priority: 20,
    enabled: false,
    adjustment: {
      kind: "fixed",
      amount: 500,
      currency: "USD",
      period: "monthly",
      targetKind: "account",
      targetId: "acc_1",
    },
  }),
  billingRule("br_3", "Volume tiers", {
    priority: 30,
    adjustment: {
      kind: "tiered",
      currency: "USD",
      tierMode: "volume",
      tierScope: "monthly",
      tiers: [
        { upTo: 1000, percent: 15 },
        { upTo: null, percent: 5 },
      ],
    },
    managedAccountIds: ["ma_1"],
  }),
  billingRule("br_4", "Support credit", {
    priority: 40,
    adjustment: { kind: "expression", expression: "cost * 0.9" },
  }),
];

const PREVIEW = {
  month: "2026-10",
  from: "2026-10-01",
  to: "2026-10-31",
  managedAccountId: "ma_1",
  collected: { USD: 1000, EUR: 10 },
  before: { USD: 1000, EUR: 10 },
  after: { USD: 1100, EUR: 10 },
  effects: [],
  coverage: null,
  warnings: ["One line had no service"],
  expressionFailures: [
    { ruleId: "br_4", name: "Support credit", lines: 2, message: "division by zero" },
  ],
  changes: [
    {
      pluginId: "aws",
      service: "EC2",
      accountName: "prod",
      chargeType: "usage",
      currency: "USD",
      collected: 1000,
      before: 1000,
      after: 1100,
    },
  ],
  lineCount: 3,
};
