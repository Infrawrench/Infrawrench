import { describe, expect, it, vi } from "vitest";

// `prices`, `pr-check` and `services` on effect/cli: text and `--json`
// output, refusals and exit codes, against fixtures. git is a fake; nothing
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

/** What the fake `git` answers, by its arguments joined with spaces. */
const git = vi.hoisted(() => ({
  answers: new Map<string, string | Error>(),
  files: new Map<string, string>(),
}));

vi.mock("node:child_process", async () => {
  const { promisify } = await import("node:util");
  const execFile = Object.assign(() => undefined, {
    [promisify.custom]: async (_cmd: string, args: string[]) => {
      const answer = git.answers.get(args.join(" "));
      if (answer === undefined) throw new Error(`fatal: no fixture for git ${args.join(" ")}`);
      if (answer instanceof Error) throw answer;
      return { stdout: answer, stderr: "" };
    },
  });
  return { execFile, default: { execFile } };
});

vi.mock("node:fs/promises", async (original) => {
  const real = await original<typeof import("node:fs/promises")>();
  const readFile = async (path: string) => {
    const text = git.files.get(path);
    if (text === undefined) throw new Error(`ENOENT: ${path}`);
    return text;
  };
  return { ...real, readFile, default: { ...real, readFile } };
});

import { run, serveRoutes, useCliCapture } from "./cli-harness";

const out = useCliCapture();

/** One command line, its output on its own: a test may run several. */
const cli = (...argv: string[]) => {
  out.stdout = "";
  out.stderr = "";
  return run(...argv);
};

const pretty = (value: unknown) => `${JSON.stringify(value, null, 2)}\n`;

// ---------------------------------------------------------------------------
// prices
// ---------------------------------------------------------------------------

const row = (plugin: string, name: string, amount: number, over: Record<string, unknown> = {}) => ({
  pluginId: plugin.toLowerCase(),
  pluginName: plugin,
  serviceId: "compute",
  serviceLabel: "Compute",
  sku: name,
  name,
  family: "compute",
  series: null,
  specs: { vcpus: 4, memoryGb: 16 },
  region: "us-east-1",
  regionLabel: "N. Virginia",
  price: { region: "us-east-1", rateType: "on-demand", unit: "hour", amount, currency: "USD" },
  monthlyAmount: Math.round(amount * 730 * 100) / 100,
  comparable: null,
  otherPrices: [],
  estimate: null,
  ...over,
});

const providerStatus = (name: string, state: string, over: Record<string, unknown> = {}) => ({
  pluginId: name.toLowerCase(),
  pluginName: name,
  requiresCredentials: false,
  permission: null,
  source: { name: "list", url: "https://example.com" },
  refreshHours: 24,
  services: [],
  regions: [],
  state,
  region: null,
  error: null,
  fetchedAt: null,
  truncated: false,
  ...over,
});

const SEARCH = {
  rows: [
    row("AWS", "m7g.xlarge", 0.1632),
    row("GCP", "g2-standard-4", 0.7068, {
      specs: { vcpus: 4, memoryGb: 16, gpuCount: 1, gpuModel: "NVIDIA L4" },
    }),
    row("Hetzner", "storage", 0.05, {
      specs: { storageGb: 100 },
      price: {
        region: "fsn1",
        rateType: "on-demand",
        unit: "gb-month",
        amount: 0.05,
        currency: "EUR",
      },
      monthlyAmount: null,
    }),
  ],
  total: 120,
  offset: 0,
  limit: 25,
  area: "north-america",
  rateType: "on-demand",
  providers: [
    providerStatus("AWS", "ready"),
    providerStatus("Azure", "no-account"),
    providerStatus("Oracle", "error", { error: "403", permission: "pricing:Read" }),
    providerStatus("Linode", "ready", { truncated: true }),
    providerStatus("Vultr", "loading"),
  ],
  displayCurrency: null,
  currencies: ["USD", "EUR"],
  mixedCurrencies: true,
  gpuModels: ["NVIDIA L4"],
  generatedAt: "2026-11-08T00:00:00.000Z",
};

const COMPARE = {
  target: { vcpus: 4, memoryGb: 16, gpuCount: null, gpuModel: null },
  reference: null,
  area: "europe",
  rateType: "spot",
  providers: [
    {
      pluginId: "aws",
      pluginName: "AWS",
      region: "eu-west-1",
      regionLabel: "Ireland",
      state: "ready",
      error: null,
      best: row("AWS", "m7g.xlarge", 0.05),
      alternatives: [row("AWS", "m6g.xlarge", 0.06), row("AWS", "x", 0.1, { monthlyAmount: null })],
    },
    {
      pluginId: "gcp",
      pluginName: "GCP",
      region: null,
      regionLabel: null,
      state: "ready",
      error: null,
      best: null,
      alternatives: [],
    },
    {
      pluginId: "azure",
      pluginName: "Azure",
      region: null,
      regionLabel: null,
      state: "no-account",
      error: null,
      best: null,
      alternatives: [],
    },
    {
      pluginId: "do",
      pluginName: "DigitalOcean",
      region: null,
      regionLabel: null,
      state: "loading",
      error: null,
      best: null,
      alternatives: [],
    },
  ],
  displayCurrency: null,
  mixedCurrencies: true,
  generatedAt: "2026-11-08T00:00:00.000Z",
};

describe("prices", () => {
  it("searches with every filter passed through the normalizer", async () => {
    serveRoutes(out, {
      "GET /price-catalog/search?q=xlarge+arm&pluginIds=aws%2Cgcp&area=europe&minVcpus=4&maxVcpus=8&minMemoryGb=16&maxMemoryGb=64&gpu=none&maxMonthlyPrice=200&rateType=spot&sort=vcpus&order=desc&limit=5":
        SEARCH,
    });
    const line = [
      "prices",
      "search",
      "xlarge",
      "arm",
      "--provider",
      "aws,gcp",
      "--area",
      "europe",
      "--min-vcpus",
      "4",
      "--max-vcpus",
      "8",
      "--min-memory",
      "16",
      "--max-memory",
      "64",
      "--gpu",
      "none",
      "--max-price",
      "200",
      "--rate",
      "spot",
      "--sort",
      "vcpus",
      "--desc",
      "--limit",
      "5",
    ];
    expect(await cli(...line)).toBe(0);
    expect(out.requests).toHaveLength(1);
    expect(out.stdout).toMatchInlineSnapshot(`
      "Acme · 3 of 120 instance types · On-demand · North America
        Azure: not searched: its price API needs an account in this org
        Oracle: prices could not be read: 403 (needs pricing:Read)
        Linode: list incomplete (page limit reached)
        Vultr: still fetching, run again shortly

      PROVIDER  INSTANCE       SPECS                          REGION     RATE         PER MONTH
      AWS       m7g.xlarge     4 vCPU · 16 GB                 us-east-1    $0.163/hr    $119.14
      GCP       g2-standard-4  4 vCPU · 16 GB · 1× NVIDIA L4  us-east-1    $0.707/hr    $515.96
      Hetzner   storage        100 GB disk                    us-east-1  €0.05/GB-mo        n/a

      ! Prices are in USD, EUR and sort by face value. Set a display currency and exchange rates in Settings to compare in one.

      List prices from each provider's published source; discounts are not applied.
      "
    `);
  });

  it("searches with the defaults and prints the body under --json", async () => {
    const routes: Record<string, unknown> = {};
    serveRoutes(out, routes);
    expect(await cli("prices", "search", "--vcpus", "2", "--json")).toBe(1);
    const key = out.requests[0]!;
    routes[key] = { ...SEARCH, mixedCurrencies: false };
    expect(await cli("prices", "search", "--vcpus", "2", "--json")).toBe(0);
    expect(out.stdout).toBe(pretty({ org: "org_1", ...SEARCH, mixedCurrencies: false }));
    expect(await cli("prices", "search", "--vcpus", "2")).toBe(0);
  });

  it("compares providers against a target or a reference product", async () => {
    const routes: Record<string, unknown> = {};
    serveRoutes(out, routes);
    expect(await cli("prices", "compare", "--vcpus", "4", "--memory", "16")).toBe(1);
    routes[out.requests[0]!] = COMPARE;
    expect(await cli("prices", "compare", "--vcpus", "4", "--memory", "16")).toBe(0);
    expect(out.stdout).toMatchInlineSnapshot(`
      "Cheapest match · ≥4 vCPU · ≥16 GB · Spot · Europe

      PROVIDER      REGION     INSTANCE                  SPECS           PER MONTH  RUNNERS-UP          
      AWS           eu-west-1  m7g.xlarge                4 vCPU · 16 GB     $36.50  m6g.xlarge $43.80, x
      GCP                      nothing meets every spec                                                 
      Azure                    needs an account                                                         
      DigitalOcean             loading                                                                  

      ! Providers quote in different currencies and are ordered by face value.
      "
    `);
    expect(await cli("prices", "compare", "--min-vcpus", "4", "--min-memory", "16", "--json")).toBe(
      0,
    );

    const before = out.requests.length;
    expect(await cli("prices", "compare", "--provider", "aws", "m7g.xlarge")).toBe(1);
    routes[out.requests[before]!] = {
      ...COMPARE,
      reference: row("AWS", "m7g.xlarge", 0.16),
      mixedCurrencies: false,
    };
    expect(await cli("prices", "compare", "--provider", "aws", "m7g.xlarge")).toBe(0);
    expect(out.stdout.split("\n")[0]).toBe(
      "Equivalents of m7g.xlarge · ≥4 vCPU · ≥16 GB · Spot · Europe",
    );
  });

  it("asks for a target, a verb, and refuses --local", async () => {
    expect(await cli("prices", "compare")).toBe(2);
    expect(out.stderr).toMatchInlineSnapshot(`
      "Usage:
        infrawrench prices search [query] [--provider aws,gcp] [--area europe] [--region <id>]
                                  [--min-vcpus 4] [--max-vcpus 8] [--min-memory 16] [--max-memory 64]
                                  [--gpu required|none] [--gpu-model H100] [--gpus 1] [--max-price 200]
                                  [--rate on-demand|spot|reserved|savings-plan] [--term 1yr|3yr]
                                  [--sort price|vcpus|memory|gpus|name] [--desc] [--limit 25]
        infrawrench prices compare [--vcpus 4] [--memory 16] [--gpus 1] [--gpu-model L4]
                                  [--provider <plugin> <sku>  compare against a product's specs]
                                  [--area europe] [--rate on-demand]
      "
    `);
    expect(await cli("prices")).toBe(2);
    expect(await cli("prices", "--local")).toBe(1);
    expect(out.stderr).toMatchInlineSnapshot(`
      "\`prices\` is cloud-only: drop --local, or pass --org <id|name>.
      "
    `);
    expect(await cli("prices", "search", "--local")).toBe(1);
  });

  it("reads a rate type, an area and a unit this build does not know as their words", async () => {
    const routes: Record<string, unknown> = {};
    serveRoutes(out, routes);
    expect(await cli("prices", "search")).toBe(1);
    routes[out.requests[0]!] = {
      ...SEARCH,
      area: "antarctica",
      rateType: "flex",
      rows: [
        row("AWS", "m7g.xlarge", 0.1632, { price: { ...SEARCH.rows[0]!.price, unit: "second" } }),
      ],
      providers: [],
      mixedCurrencies: false,
    };
    expect(await cli("prices", "search")).toBe(0);
    expect(out.stdout).toContain("· flex · antarctica");
    expect(out.stdout).toContain("$0.163/second");
  });
});

// ---------------------------------------------------------------------------
// pr-check
// ---------------------------------------------------------------------------

const PREVIEW = {
  conclusion: "failure",
  title: "+$412.00/mo",
  markdown: "…",
  report: {
    generatedAt: "2026-11-08T00:00:00.000Z",
    files: [
      { path: "main.tf", kind: "terraform", status: "modified", analysed: true, note: null },
      {
        path: "k8s/x.yaml",
        kind: "kubernetes",
        status: "added",
        analysed: false,
        note: "not a manifest",
      },
      { path: "old.tf", kind: "terraform", status: "removed", analysed: false, note: null },
    ],
    changes: [
      {
        address: "aws_db_instance.main",
        terraformType: "aws_db_instance",
        action: "update",
        path: "main.tf",
        line: 3,
        resourceId: "r1",
        displayName: "main",
        pluginId: "aws",
        resourceTypeId: "rds",
        changedAttributes: ["instance_class"],
        count: null,
        before: { monthlyAmount: 100, currency: "USD", partial: false },
        after: { monthlyAmount: 512, currency: "USD", partial: false },
        monthlyDelta: 412,
        currency: "USD",
        unpricedReason: null,
        blastRadius: {
          directDependants: 2,
          transitiveDependants: 3,
          references: 1,
          severity: "high",
          headline: "5 dependants",
          topDependants: [],
          unchecked: 0,
        },
        warnings: [
          { kind: "rightsizing", severity: "warning", message: "Oversized for its CPU" },
          { kind: "tag-policy", severity: "notice", message: "Missing owner tag" },
        ],
      },
      {
        address: "aws_s3_bucket.logs",
        terraformType: "aws_s3_bucket",
        action: "create",
        path: "main.tf",
        line: 9,
        resourceId: null,
        displayName: null,
        pluginId: null,
        resourceTypeId: null,
        changedAttributes: [],
        count: null,
        before: null,
        after: null,
        monthlyDelta: null,
        currency: null,
        unpricedReason: "usage-based",
        blastRadius: null,
        warnings: [],
      },
      {
        address: "aws_iam_role.x",
        terraformType: "aws_iam_role",
        action: "delete",
        path: "main.tf",
        line: 1,
        resourceId: null,
        displayName: null,
        pluginId: null,
        resourceTypeId: null,
        changedAttributes: [],
        count: null,
        before: null,
        after: null,
        monthlyDelta: -3.5,
        currency: "USD",
        unpricedReason: null,
        blastRadius: null,
        warnings: [],
      },
    ],
    totals: {
      monthlyDelta: 408.5,
      currency: "USD",
      partial: true,
      pricedChanges: 2,
      unpricedChanges: 1,
      otherCurrencyChanges: 0,
    },
    blast: { touchedResources: 1, dependants: 5, highestSeverity: "high" },
    notes: ["Prices are list prices."],
    truncated: false,
  },
};

const REPOS = [
  {
    id: "repo_1",
    installationId: 1,
    repo: "acme/infra",
    enabled: true,
    commentEnabled: true,
    costThreshold: null,
    thresholdConclusion: "neutral",
    directories: [],
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  },
];

/** A repository with one modified Terraform file, one new and one deleted. */
function fakeRepository(): void {
  git.answers.clear();
  git.files.clear();
  git.answers.set("rev-parse --show-toplevel", "/repo\n");
  git.answers.set("symbolic-ref --quiet refs/remotes/origin/HEAD", "refs/remotes/origin/main\n");
  git.answers.set("remote get-url origin", "git@github.com:acme/infra.git\n");
  git.answers.set("merge-base origin/main HEAD", "abc123\n");
  git.answers.set(
    "diff --name-status -M -z abc123 --",
    ["M", "main.tf", "D", "old.tf", "M", "README.md", "R100", "a.tf", "b.tf", ""].join("\0"),
  );
  git.answers.set(
    "ls-files --others --exclude-standard -z",
    ["k8s/x.yaml", "notes.txt", ""].join("\0"),
  );
  git.answers.set("show abc123:main.tf", 'resource "aws_db_instance" "main" {}\n');
  git.answers.set("show abc123:old.tf", 'resource "aws_iam_role" "x" {}\n');
  git.answers.set("show abc123:a.tf", "# old\n");
  git.files.set("/repo/main.tf", 'resource "aws_db_instance" "main" { instance_class = "x" }\n');
  git.files.set("/repo/b.tf", "x".repeat(600 * 1024));
  git.files.set("/repo/k8s/x.yaml", "kind: Deployment\n");
}

describe("pr-check", () => {
  it("previews the working tree against the default branch", async () => {
    fakeRepository();
    serveRoutes(out, { "POST /pr-checks/preview": PREVIEW });
    expect(await cli("pr-check")).toBe(0);
    expect(out.stdout).toMatchInlineSnapshot(`
      "skipping b.tf: larger than 512 KiB
      working tree vs origin/main · failure · +$412.00/mo

      RESOURCE              ACTION  BEFORE      AFTER       MONTHLY     BLAST RADIUS
      aws_db_instance.main  update  USD 100.00  USD 512.00     +412.00  high (5)    
      aws_s3_bucket.logs    create           -           -  not priced  new         
      aws_iam_role.x        delete           -           -       -3.50  not matched 

      ! aws_db_instance.main: Oversized for its CPU
      i aws_db_instance.main: Missing owner tag

      not priced
        aws_s3_bucket.logs: usage-based
      k8s/x.yaml: not a manifest
      old.tf: not analysed

      Prices are list prices.
      "
    `);
    // What was sent: the infrastructure files only, with both sides, the
    // oversized one left out, and the repository read off the remote.
    const sent = vi
      .mocked(fetch)
      .mock.calls.filter(([, init]) => init?.method === "POST")
      .map(([, init]) => JSON.parse(String(init?.body)));
    const expected = {
      files: [
        {
          path: "main.tf",
          before: 'resource "aws_db_instance" "main" {}\n',
          after: 'resource "aws_db_instance" "main" { instance_class = "x" }\n',
        },
        { path: "old.tf", before: 'resource "aws_iam_role" "x" {}\n', after: null },
        { path: "k8s/x.yaml", before: null, after: "kind: Deployment\n" },
      ],
      repo: "acme/infra",
    };
    expect(sent).toEqual([expected]);
    // The legacy command printed the skipped-file note into the JSON on
    // stdout; it goes to stderr now, so the document parses.
    expect(await cli("pr-check", "--json", "--base", "origin/main", "--repo", "acme/other")).toBe(
      0,
    );
    expect(out.stdout).toBe(
      pretty({ org: "org_1", target: "working tree vs origin/main", ...PREVIEW }),
    );
    expect(out.stderr).toBe("skipping b.tf: larger than 512 KiB\n");
  });

  it("says when no infrastructure file differs", async () => {
    fakeRepository();
    git.answers.set("diff --name-status -M -z abc123 --", "");
    git.answers.set("ls-files --others --exclude-standard -z", "");
    git.answers.set(
      "symbolic-ref --quiet refs/remotes/origin/HEAD",
      new Error("not a symbolic ref"),
    );
    git.answers.set("merge-base origin/main HEAD", "abc123\n");
    serveRoutes(out, {});
    expect(await cli("pr-check")).toBe(0);
    expect(out.stdout).toMatchInlineSnapshot(`
      "No infrastructure files differ from origin/main.
      "
    `);
    expect(await cli("pr-check", "--json")).toBe(0);
    expect(out.stdout).toBe(pretty({ org: "org_1", base: "origin/main", files: 0, preview: null }));
  });

  it("previews a pull request through the GitHub App", async () => {
    serveRoutes(out, {
      "GET /pr-checks/repositories": REPOS,
      "POST /pr-checks/preview": { ...PREVIEW, conclusion: "neutral" },
    });
    expect(await cli("pr-check", "--repo", "ACME/infra", "--pr", "42")).toBe(0);
    expect(out.stdout.split("\n")[0]).toBe("acme/infra#42 · neutral · +$412.00/mo");
    expect(await cli("pr-check", "--repo", "acme/nope", "--pr", "42")).toBe(1);
    expect(out.stderr).toMatchInlineSnapshot(`
      "acme/nope has no pull request checks configured. Turn them on in Settings → Pull Request Checks.
      "
    `);
    expect(await cli("pr-check", "--pr", "42")).toBe(1);
  });

  it("reports a failed git command in one line", async () => {
    git.answers.clear();
    git.answers.set("rev-parse --show-toplevel", new Error("fatal: not a git repository\nmore"));
    serveRoutes(out, {});
    expect(await cli("pr-check")).toBe(1);
    expect(out.stderr).toMatchInlineSnapshot(`
      "git rev-parse failed: fatal: not a git repository
      "
    `);
  });

  it("refuses a bad --pr at parse time", async () => {
    expect(await cli("pr-check", "--pr", "0")).toBe(2);
    expect(out.stderr).toContain('--pr must be a whole number of at least 1, got "0"');
  });
});

// ---------------------------------------------------------------------------
// services
// ---------------------------------------------------------------------------

const service = (
  id: string,
  name: string,
  tier: number | null,
  over: Record<string, unknown> = {},
) => ({
  id,
  name,
  slug: name.toLowerCase().replace(/\s+/g, "-"),
  description: null,
  tier,
  ownerTeam: null,
  links: [],
  onCallScheduleId: null,
  sloIds: [],
  runbookIds: [],
  rules: [],
  monthlyBudget: null,
  budgetCurrency: null,
  owners: [],
  onCallScheduleName: null,
  memberCount: 0,
  scores: [],
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
  ...over,
});

const SERVICES = [
  service("svc_2", "Search API", 2, {
    ownerTeam: "search",
    memberCount: 3,
    scores: [
      {
        scorecardId: "sc_1",
        scorecardName: "Production",
        score: 82,
        level: "silver",
        levelName: "Silver",
      },
    ],
  }),
  service("svc_1", "Checkout", 1, {
    description: "Takes the money",
    owners: [{ userId: "u1", name: "Ana", email: "ana@x.io" }],
    memberCount: 2,
    links: [{ label: "Runbook", url: "https://wiki/checkout" }],
    rules: [
      {
        kind: "tag",
        key: "service",
        value: "checkout",
        nameMatch: null,
        pluginId: "aws",
        accountId: null,
      },
      {
        kind: "name",
        key: null,
        value: "checkout-",
        nameMatch: "prefix",
        pluginId: null,
        accountId: "acc_1",
      },
    ],
    scores: [
      {
        scorecardId: "sc_1",
        scorecardName: "Production",
        score: 95,
        level: "gold",
        levelName: "Gold",
      },
      { scorecardId: "sc_2", scorecardName: "Security", score: null, level: null, levelName: null },
    ],
  }),
  service("svc_3", "Sandbox", null),
];

const SCORECARDS = {
  scorecards: [
    {
      id: "sc_1",
      name: "Production",
      description: null,
      checks: [],
      levels: [
        { key: "bronze", name: "Bronze", minScore: 50, color: null },
        { key: "gold", name: "Gold", minScore: 90, color: null },
        { key: "silver", name: "Silver", minScore: 75, color: null },
      ],
      isDefault: true,
      lastEvaluatedAt: null,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    },
  ],
};

const member = (name: string, over: Record<string, unknown> = {}) => ({
  resourceId: name,
  accountId: "acc_1",
  accountName: "prod",
  pluginId: "aws",
  resourceTypeId: "ec2",
  resourceName: name,
  externalId: null,
  source: "manual",
  ruleIndex: null,
  owner: null,
  missing: false,
  ...over,
});

const DETAIL = {
  service: SERVICES[1],
  members: [
    member("web-1"),
    member("checkout-db", { source: "rule", ruleIndex: 1, accountName: null }),
    member("gone", { missing: true, source: "rule", ruleIndex: 7 }),
  ],
  excluded: [member("checkout-test")],
};

const result = (id: string, name: string, score: number | null, level: string | null) => ({
  scorecardId: id,
  scorecardName: name,
  serviceId: "svc_1",
  score,
  level,
  levelName: level === null ? null : level[0]!.toUpperCase() + level.slice(1),
  checks: [
    { checkId: "c1", type: "owner", name: "Has an owner", weight: 1, status: "pass", detail: null },
    {
      checkId: "c2",
      type: "slo",
      name: "Has an SLO",
      weight: 2,
      status: "fail",
      detail: "none linked",
    },
    { checkId: "c3", type: "x", name: "Runbook", weight: 1, status: "error", detail: null },
    { checkId: "c4", type: "y", name: "Tagged", weight: 1, status: "not_applicable", detail: null },
  ],
  evaluatedAt: "2026-11-08T00:00:00.000Z",
});

const SUMMARY = {
  service: SERVICES[1],
  memberCount: 3,
  cost: {
    windowDays: 30,
    available: true,
    totals: [{ currency: "USD", amount: 1234.5 }],
    byProvider: [],
    costedMembers: 2,
  },
  slos: [
    {
      id: "s1",
      name: "Availability",
      status: "fast_burn",
      targetPercent: 99.9,
      budgetRemaining: 0.4213,
    },
    { id: "s2", name: "Latency", status: "ok", targetPercent: 99, budgetRemaining: null },
    { id: "s3", name: "Errors", status: "exhausted", targetPercent: 99.5, budgetRemaining: -0.1 },
    { id: "s4", name: "Queue", status: "slow_burn", targetPercent: 95, budgetRemaining: 0.9 },
    { id: "s5", name: "New", status: "unknown", targetPercent: 90, budgetRemaining: null },
  ],
  runbooks: [
    { id: "rb1", name: "Restart", enabled: true },
    { id: "rb2", name: "Failover", enabled: false },
  ],
  onCall: {
    scheduleId: "sch_1",
    scheduleName: "Payments",
    enabled: false,
    current: { userId: "u1", name: null, email: "ana@x.io", endsAt: "2026-11-09T09:00:00.000Z" },
    next: { userId: "u2", name: "Bo", email: null },
  },
  findings: {
    posture: { counts: { critical: 1, high: 0, medium: 2, low: 0 }, items: [] },
    orphans: [{ resourceId: "v1", resourceName: "vol-1", reason: "unattached" }],
    backups: [
      { resourceId: "db", resourceName: "checkout-db", kind: "backup", detail: "no snapshots" },
    ],
    unavailable: ["orphans"],
  },
  recentChanges: [
    {
      id: "ch1",
      resourceId: "web-1",
      resourceName: "web-1",
      pluginId: "aws",
      changeKind: "updated",
      fields: ["instanceType"],
      at: "2026-11-07T10:00:00.000Z",
    },
    {
      id: "ch2",
      resourceId: "web-2",
      resourceName: "web-2",
      pluginId: "aws",
      changeKind: "deleted",
      fields: [],
      at: "2026-11-06T10:00:00.000Z",
    },
  ],
  scorecards: [result("sc_1", "Production", 95, "gold"), result("sc_9", "Other", null, null)],
  generatedAt: "2026-11-08T00:00:00.000Z",
};

const HISTORY = {
  results: [],
  history: {
    sc_1: [
      { day: "2026-11-06", score: 80, level: "silver" },
      { day: "2026-11-07", score: null, level: null },
      { day: "2026-11-08", score: 95, level: "gold" },
    ],
  },
};

const DETAIL_ROUTES = {
  "GET /services": { services: SERVICES },
  "GET /scorecards": SCORECARDS,
  "GET /services/svc_1": DETAIL,
  "GET /services/svc_1/summary": SUMMARY,
  "GET /services/svc_1/scorecards": HISTORY,
};

describe("services", () => {
  it("lists services, worst tier first, with a column per scorecard", async () => {
    serveRoutes(out, { "GET /services": { services: SERVICES }, "GET /scorecards": SCORECARDS });
    expect(await cli("services")).toBe(0);
    expect(out.stdout).toMatchInlineSnapshot(`
      "Acme · 3 services

      SERVICE     SLUG        TIER  OWNER     MEMBERS  PRODUCTION  SECURITY  
      Checkout    checkout    T1    Ana             2  95% Gold    not scored
      Search API  search-api  T2    search          3  82% Silver  n/a       
      Sandbox     sandbox     -     no owner        0  n/a         n/a       

      \`infrawrench services show <slug>\` prints one service's summary.
      "
    `);
    expect(await cli("services", "list", "--tier", "2")).toBe(0);
    expect(out.stdout).toMatchInlineSnapshot(`
      "Acme · 1 service in tier 2

      SERVICE     SLUG        TIER  OWNER   MEMBERS  PRODUCTION
      Search API  search-api  T2    search        3  82% Silver

      \`infrawrench services show <slug>\` prints one service's summary.
      "
    `);
    expect(await cli("services", "--tier", "1", "--json")).toBe(0);
    expect(out.stdout).toBe(pretty({ org: "org_1", services: [SERVICES[1]] }));
    expect(await cli("services", "--tier", "3")).toBe(0);
    expect(out.stdout).toBe("No tier 3 services.\n");
  });

  it("still lists when the scorecards cannot be read", async () => {
    serveRoutes(out, { "GET /services": { services: SERVICES } });
    expect(await cli("services", "list")).toBe(0);
    serveRoutes(out, { "GET /services": { services: [] } });
    expect(await cli("services")).toBe(0);
  });

  it("shows one service by slug, name or the shorthand", async () => {
    serveRoutes(out, DETAIL_ROUTES);
    expect(await cli("services", "show", "checkout")).toBe(0);
    expect(out.stdout).toMatchInlineSnapshot(`
      "Checkout (checkout)  Tier 1 · Critical: customer-facing, an outage is an incident
      Takes the money
      owners  Ana
      link    Runbook https://wiki/checkout
      on-call ana@x.io until 2026-11-09 09:00 UTC · next Bo (Payments, disabled)
      cost 30d $1,234.50 · 2 of 3 members costed

      scorecards
        Production  95% Gold  ▁█
          ✗ fail Has an SLO: none linked
          ! error Runbook
          1 of 3 applicable checks pass
        Other  not scored
          ✗ fail Has an SLO: none linked
          ! error Runbook
          1 of 3 applicable checks pass

      SLOs
                        SLO           TARGET  BUDGET LEFT
        ● fast burn     Availability   99.9%        42.1%
        ● ok            Latency          99%            -
        ● budget spent  Errors         99.5%         -10%
        ● slow burn     Queue            95%          90%
        ● no data       New              90%            -

      runbooks
        Restart
        Failover (disabled)

      findings
        posture 1 critical · 0 high · 2 medium · 0 low   orphans unavailable   backup gaps 1
          checkout-db: no snapshots
          vol-1: unattached

      members (3)
        rule 1: tagged service=checkout (aws)
        rule 2: name starts with "checkout-" (account acc_1)
        RESOURCE        TYPE  PROVIDER  ACCOUNT  SOURCE
        web-1           ec2   aws       prod     picked
        checkout-db     ec2   aws       acc_1    rule 2
        gone (deleted)  ec2   aws       prod     rule  
        1 rule-matched resource excluded: checkout-test

      recent changes
        WHEN              CHANGE   RESOURCE  FIELDS      
        2026-11-07 10:00  updated  web-1     instanceType
        2026-11-06 10:00  deleted  web-2                 
      "
    `);
    expect(await cli("services", "Checkout")).toBe(0);
    expect(await cli("services", "show", "svc_1", "--json")).toBe(0);
    const { service: _s, scorecards, ...rest } = SUMMARY;
    expect(out.stdout).toBe(
      pretty({
        org: "org_1",
        service: DETAIL.service,
        members: DETAIL.members,
        excluded: DETAIL.excluded,
        summary: rest,
        scorecards,
        history: HISTORY.history,
      }),
    );
  });

  it("shows a service when its scorecard history cannot be read", async () => {
    const { "GET /services/svc_1/scorecards": _h, ...routes } = DETAIL_ROUTES;
    serveRoutes(out, {
      ...routes,
      "GET /services/svc_1/summary": {
        ...SUMMARY,
        onCall: null,
        scorecards: [],
        slos: [],
        runbooks: [],
      },
      "GET /services/svc_1": { ...DETAIL, members: [], excluded: [] },
    });
    expect(await cli("services", "show", "checkout")).toBe(0);
    expect(await cli("services", "show", "checkout", "--json")).toBe(0);
  });

  it("refuses an ambiguous or unknown service, an empty show and --local", async () => {
    serveRoutes(out, { "GET /services": { services: SERVICES } });
    expect(await cli("services", "show", "c")).toBe(1);
    expect(out.stderr).toMatchInlineSnapshot(`
      ""c" matches 2 services: search-api, checkout. Use the slug.
      "
    `);
    expect(await cli("services", "zzz")).toBe(1);
    expect(out.stderr).toMatchInlineSnapshot(`
      "No service matches "zzz". Run \`infrawrench services\` to list.
      "
    `);
    expect(await cli("services", "show")).toBe(2);
    expect(await cli("services", "--local")).toBe(1);
    expect(await cli("services", "--tier", "5")).toBe(2);
    expect(out.stderr).toContain('--tier must be a whole number from 1 to 4, got "5"');
  });

  it("reads a status, a check result or a rule kind this build does not know as its word", async () => {
    serveRoutes(out, {
      ...DETAIL_ROUTES,
      "GET /services/svc_1": {
        ...DETAIL,
        service: {
          ...DETAIL.service,
          tier: 7,
          rules: [
            {
              kind: "label",
              key: "team",
              value: "pay",
              nameMatch: null,
              pluginId: null,
              accountId: null,
            },
          ],
        },
      },
      "GET /services/svc_1/summary": {
        ...SUMMARY,
        slos: [
          { id: "s9", name: "Odd", status: "paused", targetPercent: 90, budgetRemaining: null },
        ],
        scorecards: [
          {
            ...result("sc_1", "Production", 95, "gold"),
            checks: [
              { checkId: "c", type: "x", name: "Odd", weight: 1, status: "skipped", detail: null },
            ],
          },
        ],
      },
    });
    expect(await cli("services", "show", "checkout")).toBe(0);
    expect(out.stdout).toContain("Checkout (checkout)  Tier 7");
    expect(out.stdout).toContain("rule 1: label team=pay");
    expect(out.stdout).toContain("● paused");
    expect(out.stdout).toContain("    skipped Odd");
  });
});
