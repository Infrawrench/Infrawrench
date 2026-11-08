import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// `budgets` (with `annotate`), `tag-keys` (with its edits), `virtual-tags`
// and `invoices` on effect/cli: text and `--json` output, the requests each
// line sends (bodies included), refusals and exit codes, against fixtures,
// pinned in `__snapshots__/cli-effect-cost-objects.test.ts.snap`. Nothing
// reaches a network or a database.
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
 * they replaced.
 */
async function same(argv: string[], code: number) {
  const from = out.requests.length;
  out.stdout = "";
  out.stderr = "";
  expect(await run(...argv)).toBe(code);
  expect({
    stdout: out.stdout,
    stderr: out.stderr,
    requests: out.requests.slice(from),
  }).toMatchSnapshot(`${code} $ infrawrench ${argv.join(" ")}`);
}

// ---------------------------------------------------------------------------
// budgets
// ---------------------------------------------------------------------------

const note = {
  text: "Quarterly load test",
  notedAt: "2026-11-04T10:00:00.000Z",
  notedByUserId: "u1",
  notedByName: "Ada",
  annotationId: null,
};

const budget = (over: Record<string, unknown>) => ({
  id: "b1",
  name: "Platform",
  amountCents: 1_000_000,
  currency: "USD",
  filters: [],
  thresholds: [],
  month: "2026-11",
  actualCents: 820_000,
  forecastCents: 1_150_000,
  forecastLowCents: 1_050_000,
  forecastHighCents: 1_250_000,
  currentMonthEvents: [
    { id: "ev1", thresholdType: "actual", thresholdPercent: 80, triggeredAt: "x", note },
    { id: "ev2", thresholdType: "forecast", thresholdPercent: 100, triggeredAt: "x", note: null },
  ],
  placements: [],
  measure: "cost",
  parentBudgetId: null,
  periodStart: "2026-11-01",
  periodEnd: "2026-11-30",
  periodLimit: 1_000_000,
  rolledUp: true,
  childCount: 1,
  hierarchyWarnings: [{ kind: "allocation", childTotal: 1_200_000, parentLimit: 1_000_000 }],
  ...over,
});

const BUDGETS = [
  budget({}),
  budget({
    id: "b2",
    name: "API",
    parentBudgetId: "b1",
    amountCents: 600_000,
    periodLimit: 600_000,
    actualCents: 300_000,
    forecastCents: null,
    forecastLowCents: null,
    forecastHighCents: null,
    currentMonthEvents: [],
    rolledUp: false,
    hierarchyWarnings: [],
  }),
  budget({
    id: "b3",
    name: "Tokens",
    measure: "usage",
    usageUnit: "tokens",
    amountCents: 0,
    actualCents: 0,
    forecastCents: null,
    periodLimit: 2_000_000,
    actualUsage: 1_500_000,
    forecastUsage: 2_100_000,
    periodStart: "2026-11-05",
    periodEnd: "2026-11-18",
    currentMonthEvents: [],
    rolledUp: false,
    hierarchyWarnings: undefined,
  }),
  budget({
    id: "b4",
    name: "Orphan with a long name that goes past the column width limit",
    parentBudgetId: "gone",
    periodStart: null,
    periodLimit: undefined,
    amountCents: 0,
    scenarioForecastCents: 50_000,
    currentMonthEvents: [],
    rolledUp: false,
    hierarchyWarnings: [{ kind: "forecast", childTotal: 2, parentLimit: 1 }],
  }),
];

const budgetEvent = (over: Record<string, unknown>) => ({
  id: "ev1abcdef",
  month: "2026-11",
  thresholdType: "actual",
  thresholdPercent: 80,
  actualAmountCents: 800_000,
  forecastAmountCents: null,
  triggeredAt: "2026-11-04T08:00:00.000Z",
  note,
  ...over,
});

const EVENTS = [
  budgetEvent({}),
  budgetEvent({
    id: "ev2",
    thresholdType: "forecast",
    thresholdPercent: 100,
    forecastAmountCents: 1_100_000,
    note: { ...note, notedByName: null },
  }),
  budgetEvent({ id: "ev3", thresholdType: "forecast", thresholdPercent: 120, note: null }),
];

const USAGE_EVENTS = [
  budgetEvent({ id: "u1", actualUsage: 1_600_000, note: null }),
  budgetEvent({ id: "u2", thresholdType: "forecast", forecastUsage: 2_100_000, note: null }),
  budgetEvent({ id: "u3", thresholdType: "forecast", note: null }),
];

const budgetRoutes = {
  "GET /budgets": BUDGETS,
  "GET /budgets/b1/events": EVENTS,
  "GET /budgets/b2/events": [],
  "GET /budgets/b3/events": USAGE_EVENTS,
  "POST /budgets/b1/events/ev1abcdef/note": {
    ...budgetEvent({}),
    followUp: { slack: 1, msTeams: 2 },
  },
  "POST /budgets/b1/events/ev2/note": { ...EVENTS[1], followUp: { slack: 0, msTeams: 0 } },
};

describe("budgets", () => {
  it("lists the tree and shows one budget like the legacy command", async () => {
    serve(budgetRoutes);
    await same(["budgets"], 0);
    await same(["budgets", "--json"], 0);
    await same(["budgets", "platform"], 0);
    await same(["budgets", "b1", "--json"], 0);
    await same(["budgets", "Tokens"], 0);
    await same(["budgets", "api"], 0);
    await same(["budgets", "o"], 1);
    await same(["budgets", "nope"], 1);
    await same(["budgets", "--local"], 1);
    serve({ "GET /budgets": [] });
    await same(["budgets"], 0);
  });

  it("annotates a firing", async () => {
    serve(budgetRoutes);
    await same(["budgets", "annotate", "Platform", "--note", "  load test  "], 0);
    await same(["budgets", "annotate", "Platform", "--note", "why", "--event", "ev2"], 0);
    await same(["budgets", "annotate", "b1", "--note", "why", "--event", "ev2", "--json"], 0);
    await same(["budgets", "annotate", "--note", "why"], 2);
    await same(["budgets", "annotate", "Platform"], 2);
    await same(["budgets", "annotate", "Platform", "--note", "   "], 2);
    await same(["budgets", "annotate", "API", "--note", "why"], 1);
    await same(["budgets", "annotate", "Platform", "--note", "why", "--event", "zz"], 1);
    await same(["budgets", "annotate", "Platform", "--note", "why", "--local"], 1);
  });
});

// ---------------------------------------------------------------------------
// tag-keys
// ---------------------------------------------------------------------------

const tagKey = (over: Record<string, unknown>) => ({
  key: "team",
  providers: ["aws", "gcp"],
  sources: [],
  costRowCount: 12_345,
  costResourceCount: 40,
  inventoryCount: 52,
  lastSeen: "2026-11-07",
  hidden: false,
  hiddenBy: null,
  preferred: false,
  ...over,
});

const SETTINGS = { hidden: ["aws:cloudformation:*", "env"], preferred: ["team"] };

const TAG_KEYS = {
  keys: [
    tagKey({ preferred: true }),
    tagKey({
      key: "aws:cloudformation:stack-name",
      providers: ["aws"],
      hidden: true,
      hiddenBy: "aws:cloudformation:*",
    }),
    tagKey({ key: "env", hidden: true, hiddenBy: "env", costRowCount: 1_000_000 }),
    tagKey({ key: "misc", providers: [], lastSeen: null, costRowCount: 0, inventoryCount: 3 }),
  ],
  settings: SETTINGS,
  lookbackDays: 90,
  truncated: true,
};

describe("tag-keys", () => {
  it("lists the keys and edits the lists", async () => {
    serve({
      "GET /tag-keys": TAG_KEYS,
      "GET /tag-keys/settings": SETTINGS,
      "PUT /tag-keys/settings": { hidden: ["aws:cloudformation:*", "env", "misc"], preferred: [] },
    });
    await same(["tag-keys"], 0);
    await same(["tag-keys", "--json"], 0);
    await same(["tag-keys", "hide", "misc"], 0);
    await same(["tag-keys", "hide", "env"], 0);
    await same(["tag-keys", "unhide", "env", "--json"], 0);
    await same(["tag-keys", "unhide", "team"], 0);
    await same(["tag-keys", "pin", "env"], 0);
    await same(["tag-keys", "pin", "team", "--json"], 0);
    await same(["tag-keys", "unpin", "team"], 0);
    await same(["tag-keys", "unpin", "misc"], 0);
    await same(["tag-keys", "hide"], 1);
    await same(["tag-keys", "pin"], 1);
    await same(["tag-keys", "--local"], 1);
    // An unknown action is a parse error with the command's help, exit 2.
    await same(["tag-keys", "bury", "misc"], 2);
    serve({
      "GET /tag-keys": { ...TAG_KEYS, settings: { hidden: [], preferred: [] }, truncated: false },
    });
    await same(["tag-keys"], 0);
  });
});

// ---------------------------------------------------------------------------
// virtual-tags
// ---------------------------------------------------------------------------

const rule = (over: Record<string, unknown>) => ({
  query: "provider = 'aws'",
  description: null,
  startsOn: null,
  endsOn: null,
  kind: "value",
  value: "platform",
  sources: [],
  valueTransform: "none",
  allocations: [],
  ...over,
});

const virtualTag = (over: Record<string, unknown>) => ({
  id: "vt1",
  key: "team",
  name: "Team",
  description: "Who owns the spend",
  defaultValue: "unowned",
  rules: [
    rule({ description: "Everything on AWS" }),
    rule({
      query: "",
      kind: "tag",
      value: null,
      sources: [{ tagKey: "Team", valuePrefix: "t-", query: null }],
      valueTransform: "lower",
      startsOn: "2026-01-01",
    }),
    rule({
      kind: "split",
      value: null,
      allocations: [
        { value: "a", percent: 60, metricId: null },
        { value: "b", percent: 40, metricId: null },
      ],
      endsOn: "2026-12-31",
    }),
    rule({
      kind: "metric_split",
      value: null,
      allocations: [
        { value: "x", percent: null, metricId: "bm1" },
        { value: "y", percent: null, metricId: "bm-missing" },
      ],
      startsOn: "2026-01-01",
      endsOn: "2026-06-30",
    }),
  ],
  status: {
    state: "ready",
    processedAt: "2026-11-08T02:00:00.000Z",
    error: null,
    stats: {
      from: "2025-11-08",
      to: "2026-11-07",
      currencies: [
        {
          currency: "USD",
          total: 1000,
          unmatched: 124,
          byRule: [500, 200, 100, 76],
          topValues: [
            { value: "platform", amount: 500 },
            { value: "data", amount: 300 },
          ],
        },
        { currency: "EUR", total: 100, unmatched: 3, byRule: [97], topValues: [] },
      ],
      metricFallbackDays: 2,
      distinctValues: 7,
    },
  },
  createdByUserId: null,
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-11-01T00:00:00.000Z",
  ...over,
});

const VIRTUAL_TAGS = [
  virtualTag({}),
  virtualTag({
    id: "vt2",
    key: "env",
    name: "Environment",
    description: null,
    defaultValue: null,
    rules: [],
    status: { state: "failed", processedAt: null, error: "query timed out", stats: null },
  }),
  virtualTag({
    id: "vt3",
    key: "cc",
    name: "Cost centre",
    rules: [rule({})],
    status: {
      state: "processing",
      processedAt: null,
      error: null,
      stats: {
        from: null,
        to: null,
        currencies: [],
        metricFallbackDays: 0,
        distinctValues: 0,
      },
    },
  }),
  virtualTag({
    id: "vt4",
    key: "region-group",
    name: "Envoy",
    status: { state: "pending", processedAt: null, error: null, stats: null },
  }),
];

const tagRoutes = {
  "GET /virtual-tags": VIRTUAL_TAGS,
  "GET /business-metrics": { metrics: [{ id: "bm1", name: "Signups" }] },
  "POST /virtual-tags/vt1/reprocess": {
    ...virtualTag({}),
    status: { state: "pending", processedAt: null, error: null, stats: null },
  },
};

describe("virtual-tags", () => {
  it("lists, shows and reprocesses like the legacy command", async () => {
    serve(tagRoutes);
    await same(["virtual-tags"], 0);
    await same(["virtual-tags", "--json"], 0);
    await same(["virtual-tags", "show", "team"], 0);
    await same(["virtual-tags", "show", "vt1", "--json"], 0);
    await same(["virtual-tags", "env"], 0);
    await same(["virtual-tags", "Cost", "centre"], 0);
    await same(["virtual-tags", "region-group"], 0);
    await same(["virtual-tags", "reprocess", "team"], 0);
    await same(["virtual-tags", "reprocess", "TEAM", "--json"], 0);
    await same(["virtual-tags", "show"], 2);
    await same(["virtual-tags", "reprocess"], 2);
    await same(["virtual-tags", "show", "en"], 1);
    await same(["virtual-tags", "nope"], 1);
    await same(["virtual-tags", "--local"], 1);
    serve({ "GET /virtual-tags": [] });
    await same(["virtual-tags"], 0);
  });

  it("shows ids when the metrics cannot be read", async () => {
    serve({ "GET /virtual-tags": VIRTUAL_TAGS, "GET /business-metrics": new RawResponse(403, "") });
    await same(["virtual-tags", "show", "team"], 0);
  });
});

// ---------------------------------------------------------------------------
// invoices
// ---------------------------------------------------------------------------

const delivery = {
  status: "succeeded",
  recipients: ["ap@northwind.example"],
  delivered: 1,
  attemptedAt: "2026-10-03T09:00:00.000Z",
  deliveredAt: "2026-10-03T09:00:01.000Z",
  attempts: 1,
  error: null,
};

const totals = (billed: Record<string, number>) => ({
  collected: billed,
  adjustment: {},
  adjusted: billed,
  billed,
});

const summary = (over: Record<string, unknown>) => ({
  id: "inv1",
  managedAccountId: "ma1",
  managedAccountName: "Northwind",
  number: "INV-2026-0004",
  status: "sent",
  periodFrom: "2026-09-01",
  periodTo: "2026-09-30",
  currency: "USD",
  totals: totals({ USD: 1234.5 }),
  issuedAt: "2026-10-02T09:00:00.000Z",
  sentAt: "2026-10-03T09:00:00.000Z",
  delivery,
  voidedAt: null,
  voidReason: null,
  supersedesInvoiceId: null,
  supersededByInvoiceId: null,
  createdAt: "2026-10-01T00:00:00.000Z",
  updatedAt: "2026-10-03T00:00:00.000Z",
  ...over,
});

const SUMMARIES = [
  summary({}),
  summary({
    id: "inv2",
    number: null,
    status: "draft",
    totals: null,
    managedAccountName: "Contoso",
    issuedAt: null,
    sentAt: null,
    delivery: null,
  }),
  summary({
    id: "inv3",
    number: "INV-2026-0003",
    status: "approved",
    totals: totals({ EUR: 10, USD: 0, GBP: 5 }),
    sentAt: null,
  }),
  summary({
    id: "inv4",
    number: "INV-2026-0002",
    status: "void",
    voidedAt: "2026-09-15T00:00:00.000Z",
    voidReason: "wrong customer",
    managedAccountName: "Fabrikam",
  }),
];

const line = (over: Record<string, unknown>) => ({
  kind: "cost_centre",
  refId: "cc1",
  label: "Platform",
  currency: "USD",
  collected: 1000,
  adjustment: 100,
  adjusted: 1100,
  rate: 1,
  billed: 1100,
  ...over,
});

const INVOICE = {
  ...summary({}),
  notes: null,
  lines: [
    line({}),
    line({ label: "Data", currency: "EUR", adjustment: 0, adjusted: 100, rate: 1.08, billed: 108 }),
    line({ kind: "account", label: "JP account", currency: "JPY", rate: null, billed: null }),
  ],
  totals: totals({ USD: 1208, JPY: 1100 }),
  derivation: {
    costBasis: "amortized",
    applyBillingRules: true,
    rateDate: "2026-09-30",
    rates: [{ currency: "EUR", rate: 1.08, effectiveFrom: "2026-09-01", source: "manual" }],
    unconverted: ["JPY"],
    rules: [{ id: "br1", name: "Markup", kind: "markup", summary: "+10% on everything" }],
    scope: {
      costCentres: [{ id: "cc1", name: "Platform" }],
      accounts: [{ id: "a1", label: "prod (aws)" }],
    },
    missingScope: ["cc-gone", "a-gone"],
  },
  billing: {
    profileId: "bp1",
    profileName: "EU customers",
    legalName: "Northwind Traders Ltd",
    attention: null,
    address: null,
    taxId: "GB123",
    poNumber: "PO-77",
    to: ["ap@northwind.example"],
    cc: ["cfo@northwind.example"],
    paymentTermsDays: 30,
    issueDate: "2026-10-02",
    dueDate: "2026-11-01",
    taxRates: [],
    bank: null,
    footer: null,
    logoId: null,
    numberPrefix: "INV",
    numberIncludesYear: true,
  },
  live: false,
  computedAt: "2026-10-02T09:00:00.000Z",
  approvedByUserId: "u1",
  sentByUserId: "u1",
  voidedByUserId: null,
  createdByUserId: "u1",
  supersedesInvoiceId: "inv0",
  supersededByInvoiceId: "inv9",
};

const DRAFT = {
  ...INVOICE,
  ...summary({ id: "inv2", number: null, status: "draft", managedAccountName: "Contoso" }),
  lines: [],
  totals: totals({}),
  derivation: {
    ...INVOICE.derivation,
    applyBillingRules: false,
    rates: [],
    unconverted: [],
    scope: { costCentres: [], accounts: [] },
    missingScope: ["only"],
  },
  billing: {
    ...INVOICE.billing,
    taxId: null,
    poNumber: null,
    to: [],
    cc: [],
    dueDate: null,
    profileName: null,
  },
  delivery: {
    ...delivery,
    status: "failed",
    delivered: 0,
    recipients: ["a@x.example", "b@x.example"],
    error: "mailbox full",
  },
  live: true,
  supersedesInvoiceId: null,
  supersededByInvoiceId: null,
};

const VOID = {
  ...INVOICE,
  ...summary(SUMMARIES[3] ?? {}),
  derivation: { ...INVOICE.derivation, rules: [] },
  billing: null,
  delivery: null,
};

const CUSTOMERS = [
  {
    id: "ma1",
    name: "Northwind",
    contactName: null,
    contactEmail: null,
    billingAddress: null,
    billingCurrency: "USD",
    costBasis: "amortized",
    applyBillingRules: true,
    pricing: {},
    notes: null,
    billingProfileId: "bp1",
    costCentreIds: ["cc1", "cc2"],
    accountIds: ["a1"],
    invoiceCount: 3,
    createdByUserId: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  },
  {
    id: "ma2",
    name: "Contoso",
    contactName: null,
    contactEmail: null,
    billingAddress: null,
    billingCurrency: "EUR",
    costBasis: "cash",
    applyBillingRules: false,
    pricing: {},
    notes: null,
    billingProfileId: null,
    costCentreIds: ["cc3"],
    accountIds: [],
    invoiceCount: 1,
    createdByUserId: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  },
  {
    id: "ma3",
    name: "Empty",
    contactName: null,
    contactEmail: null,
    billingAddress: null,
    billingCurrency: "USD",
    costBasis: "cash",
    applyBillingRules: true,
    pricing: {},
    notes: null,
    billingProfileId: null,
    costCentreIds: [],
    accountIds: [],
    invoiceCount: 0,
    createdByUserId: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  },
];

const profile = (over: Record<string, unknown>) => ({
  id: "bp1",
  name: "EU customers",
  legalName: "Acme Europe BV",
  address: "1 Main St\nAmsterdam",
  taxId: "NL123",
  poNumber: null,
  toEmails: ["billing@acme.example"],
  ccEmails: [],
  currency: "EUR",
  paymentTermsDays: 0,
  numberPrefix: "EU",
  numberIncludesYear: true,
  numberStart: 100,
  taxRates: [{ name: "VAT", rate: 21 }],
  bank: {
    accountName: "Acme Europe",
    bankName: "ING",
    iban: "NL91 ABNA 0417 1643 00",
    bic: "INGBNL2A",
    accountNumber: null,
    routingNumber: null,
    instructions: null,
  },
  footer: "Thank you",
  logo: "logo-id",
  managedAccountIds: ["ma1", "ma-gone"],
  createdByUserId: null,
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
  ...over,
});

const PROFILES = [
  profile({}),
  profile({
    id: "bp2",
    name: "EU partners",
    legalName: null,
    address: null,
    taxId: null,
    toEmails: [],
    currency: null,
    paymentTermsDays: null,
    numberIncludesYear: false,
    taxRates: [],
    bank: null,
    footer: null,
    logo: null,
    managedAccountIds: [],
  }),
  profile({
    id: "bp3",
    name: "US",
    paymentTermsDays: 30,
    bank: {
      ...profile({}).bank,
      iban: null,
      accountNumber: "123456789",
      routingNumber: "021000021",
    },
  }),
];

const UNASSIGNED = {
  periodFrom: "2026-10-01",
  periodTo: "2026-10-31",
  rows: [
    {
      kind: "cost_centre",
      id: "cc9",
      name: "Research",
      pluginId: null,
      amounts: { USD: 120, EUR: 0 },
    },
    { kind: "account", id: "a9", name: "sandbox", pluginId: "gcp", amounts: { USD: 40, EUR: 300 } },
    { kind: "account", id: "a8", name: "misc", pluginId: null, amounts: {} },
    { kind: "unallocated", id: null, name: "", pluginId: null, amounts: { USD: 5 } },
  ],
  totals: {
    unassigned: { USD: 165, EUR: 300 },
    assigned: { USD: 1000 },
    all: { USD: 1165, EUR: 300 },
  },
  assignable: 3,
};

const invoiceRoutes = {
  "GET /invoices": SUMMARIES,
  "GET /invoices/inv1": INVOICE,
  "GET /invoices/inv2": DRAFT,
  "GET /invoices/inv4": VOID,
  "GET /managed-accounts": CUSTOMERS,
  "GET /billing-profiles": PROFILES,
  "GET /managed-accounts/unassigned": UNASSIGNED,
  "GET /managed-accounts/unassigned?from=2026-09-01&to=2026-09-30": {
    ...UNASSIGNED,
    rows: [],
  },
};

describe("invoices", () => {
  it("lists invoices and shows one like the legacy command", async () => {
    serve(invoiceRoutes);
    await same(["invoices"], 0);
    await same(["invoices", "--json"], 0);
    await same(["invoices", "INV-2026-0004"], 0);
    await same(["invoices", "inv1", "--json"], 0);
    await same(["invoices", "contoso"], 0);
    await same(["invoices", "fabrikam"], 0);
    await same(["invoices", "northwind"], 1);
    await same(["invoices", "nope"], 1);
    await same(["invoices", "--local"], 1);
    serve({ "GET /invoices": [] });
    await same(["invoices"], 0);
  });

  it("lists customers and billing profiles", async () => {
    serve(invoiceRoutes);
    await same(["invoices", "customers"], 0);
    await same(["invoices", "customers", "--json"], 0);
    await same(["invoices", "profiles"], 0);
    await same(["invoices", "profiles", "--json"], 0);
    await same(["invoices", "profiles", "eu", "customers"], 0);
    await same(["invoices", "profiles", "bp2", "--json"], 0);
    await same(["invoices", "profiles", "US"], 0);
    await same(["invoices", "profiles", "eu"], 1);
    await same(["invoices", "profiles", "nope"], 1);
    serve({ "GET /managed-accounts": [], "GET /billing-profiles": [] });
    await same(["invoices", "customers"], 0);
    await same(["invoices", "profiles"], 0);
  });

  it("reports unassigned spend", async () => {
    serve(invoiceRoutes);
    await same(["invoices", "unassigned"], 0);
    await same(["invoices", "unassigned", "--json"], 0);
    await same(["invoices", "unassigned", "--from", "2026-09-01", "--to", "2026-09-30"], 0);
    await same(["invoices", "unassigned", "--from", "2026-09-01"], 2);
    await same(["invoices", "unassigned", "--from", "Sept", "--to", "Oct"], 2);
    await same(["invoices", "unassigned", "--from", "2026-09-30", "--to", "2026-09-01"], 2);
  });
});
