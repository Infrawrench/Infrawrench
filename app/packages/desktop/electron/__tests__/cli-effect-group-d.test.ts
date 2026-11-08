import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// `status-pages`, `declared-incidents`, `issues` and `estimate` on effect/cli:
// text and `--json` output, refusals and exit codes, against fixtures.
// Nothing reaches a network or a database.
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

/** What `--json` writes for `value`: two-space JSON and a newline. */
const pretty = (value: unknown) => `${JSON.stringify(value, null, 2)}\n`;

// ---------------------------------------------------------------------------
// status-pages
// ---------------------------------------------------------------------------

const component = (
  probeName: string,
  probeStatus: string,
  probeEnabled: boolean,
  extra: { label?: string | null; groupName?: string | null } = {},
) => ({
  id: `c-${probeName}`,
  probeId: `p-${probeName}`,
  label: extra.label ?? null,
  groupName: extra.groupName ?? null,
  position: 0,
  probeName,
  probeStatus,
  probeEnabled,
});

const PAGES = {
  pages: [
    {
      id: "sp_1",
      slug: "acme-status",
      title: "Acme Status",
      description: "Public status for Acme.",
      published: true,
      showHistory: true,
      showUptime: true,
      supportUrl: null,
      components: [
        component("api-health", "up", true, { label: "API", groupName: "Core" }),
        component("checkout", "down", true),
        component("search", "unknown", true),
        component("legacy", "up", false),
      ],
      createdAt: "2026-10-01T00:00:00.000Z",
      updatedAt: "2026-10-02T00:00:00.000Z",
    },
    {
      id: "sp_2",
      slug: "internal",
      title: "Internal tools",
      description: null,
      published: false,
      showHistory: false,
      showUptime: false,
      supportUrl: null,
      components: [],
      createdAt: "2026-10-03T00:00:00.000Z",
      updatedAt: "2026-10-03T00:00:00.000Z",
    },
  ],
};

describe("status-pages", () => {
  it("lists pages as text", async () => {
    serveRoutes(out, { "GET /status-pages": PAGES });
    expect(await run("status-pages")).toBe(0);
    expect(out.stdout).toMatchInlineSnapshot(`
      "Acme · 2 status pages

      PAGE            STATE    COMPONENTS  URL                                     
      Acme Status     ● live            4  http://localhost:3000/status/acme-status
      Internal tools  ○ draft           0  http://localhost:3000/status/internal   

      1 page is readable by anyone with the link.
      "
    `);
  });

  it("lists pages as JSON", async () => {
    serveRoutes(out, { "GET /status-pages": PAGES });
    expect(await run("status-pages", "--json")).toBe(0);
    expect(out.stdout).toBe(pretty({ org: "org_1", pages: PAGES.pages }));
  });

  it("details one page by title prefix, as text and as the raw page", async () => {
    serveRoutes(out, { "GET /status-pages": PAGES });
    expect(await run("status-pages", "acme")).toBe(0);
    expect(out.stdout).toMatchInlineSnapshot(`
      "Acme Status · live
      Public status for Acme.

      url  http://localhost:3000/status/acme-status
      shows  24h uptime, 90d history

      PUBLIC NAME  GROUP  PROBE       STATE    
      API          Core   api-health  ● up     
      checkout     —      checkout    ● down   
      search       —      search      ● pending
      legacy       —      legacy      ○ paused 

      1 probe paused. Those components show as "No data" to visitors.
      "
    `);
    out.stdout = "";
    expect(await run("status-pages", "sp_2", "--json")).toBe(0);
    expect(out.stdout).toBe(pretty(PAGES.pages[1]));
  });

  it("details a page with no components", async () => {
    serveRoutes(out, { "GET /status-pages": PAGES });
    expect(await run("status-pages", "Internal tools")).toBe(0);
    expect(out.stdout).toMatchInlineSnapshot(`
      "Internal tools · draft

      url  http://localhost:3000/status/internal
      shows  current state only

      No components. This page publishes nothing.
      "
    `);
  });

  it("says when there are no pages", async () => {
    serveRoutes(out, { "GET /status-pages": { pages: [] } });
    expect(await run("status-pages")).toBe(0);
    expect(out.stdout).toMatchInlineSnapshot(`
      "No status pages yet. Create one from the Probes tab. A page publishes probes you already run.
      "
    `);
  });

  it("refuses an unknown page and --local", async () => {
    serveRoutes(out, { "GET /status-pages": PAGES });
    expect(await run("status-pages", "nope")).toBe(1);
    expect(out.stderr).toBe(
      'No status page matches "nope". Run `infrawrench status-pages` to list.\n',
    );
    out.stderr = "";
    expect(await run("status-pages", "--local")).toBe(1);
    expect(out.stderr).toBe(
      "Status pages live in Infrawrench Cloud. The page is served by the web app. Drop --local.\n",
    );
    expect(out.requests).toEqual(["GET /status-pages"]);
  });

  it("exits 2 for a second positional", async () => {
    expect(await run("status-pages", "a", "b")).toBe(2);
    expect(out.stdout).toBe("");
  });
});

// ---------------------------------------------------------------------------
// declared-incidents
// ---------------------------------------------------------------------------

const NOW = new Date("2026-11-08T12:00:00.000Z");

const artifact = (kind: string, status: string, label: string | null, error: string | null) => ({
  id: `art-${kind}`,
  kind,
  status,
  label,
  refId: null,
  refSecondary: null,
  error,
  request: null,
  createdAt: "2026-11-08T09:00:00.000Z",
  updatedAt: "2026-11-08T09:00:00.000Z",
});

const incident = (over: Record<string, unknown>) => ({
  id: "inc_1",
  title: "Checkout 500s",
  severity: "sev1",
  status: "open",
  summary: "Payments failing for EU customers.",
  startedAt: "2026-11-08T09:15:00.000Z",
  mitigatedAt: null,
  resolvedAt: null,
  declaredByUserId: "u1",
  declaredByName: "Ada",
  resolvedByUserId: null,
  affectedResourceIds: [],
  affectedAccountIds: [],
  issueUrl: null,
  createdAt: "2026-11-08T09:15:00.000Z",
  updatedAt: "2026-11-08T09:15:00.000Z",
  artifacts: [],
  noteCount: 0,
  ...over,
});

const INCIDENTS = {
  incidents: [
    incident({
      artifacts: [
        artifact("freeze", "active", "Incident freeze", null),
        artifact("status_page", "failed", null, "page unreachable"),
      ],
    }),
    incident({
      id: "inc_2",
      title: "DNS blip",
      severity: "sev3",
      status: "resolved",
      summary: null,
      startedAt: "2026-11-01T10:00:00.000Z",
      resolvedAt: "2026-11-02T12:30:00.000Z",
      declaredByName: null,
      artifacts: [artifact("slack", "closed", "#incidents", null)],
    }),
  ],
};

const TIMELINE = {
  incidentId: "inc_1",
  from: "2026-11-08T08:45:00.000Z",
  to: "2026-11-08T12:00:00.000Z",
  generatedAt: "2026-11-08T12:00:00.000Z",
  entries: [
    {
      id: "deploy:1",
      source: "deploy",
      kind: "deploy.finished",
      at: "2026-11-08T09:10:00.000Z",
      title: "Deployed checkout v42",
      detail: "by ci",
      severity: "info",
    },
    {
      id: "probe:1",
      source: "probe",
      kind: "probe.down",
      at: "2026-11-08T09:14:00.000Z",
      title: "checkout went down",
      severity: "critical",
    },
  ],
  feeds: [
    { feed: "changes", status: "ok" },
    { feed: "alerts", status: "error", error: "timeout" },
  ],
  truncated: true,
};

describe("declared-incidents", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(NOW);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("lists incidents as text", async () => {
    serveRoutes(out, { "GET /incidents": INCIDENTS });
    expect(await run("declared-incidents")).toBe(0);
    expect(out.stdout).toMatchInlineSnapshot(`
      "Acme · 2 incidents  1 not resolved

                  SEV   INCIDENT       STARTED           DURATION   DECLARED BY  ARTEFACTS
      ● open      SEV1  Checkout 500s  2026-11-08 09:15     2h 45m  Ada           1 failed
      ○ resolved  SEV3  DNS blip       2026-11-01 10:00  1d 2h 30m  —                    1

      \`infrawrench declared-incidents <id|title>\` prints one incident's assembled timeline. Declare and resolve from the Incidents tab.
      "
    `);
  });

  it("lists incidents as JSON", async () => {
    serveRoutes(out, { "GET /incidents": INCIDENTS });
    expect(await run("declared-incidents", "--json")).toBe(0);
    expect(out.stdout).toBe(pretty({ org: "org_1", ...INCIDENTS }));
  });

  it("prints one incident's timeline as text and as JSON", async () => {
    serveRoutes(out, {
      "GET /incidents": INCIDENTS,
      "GET /incidents/inc_1/timeline": TIMELINE,
    });
    expect(await run("declared-incidents", "checkout")).toBe(0);
    expect(out.stdout).toMatchInlineSnapshot(`
      "SEV1 Checkout 500s  ● open
      started 2026-11-08 09:15 · 2h 45m · declared by Ada
      Payments failing for EU customers.

        · freeze: active (Incident freeze)
        ✗ status_page: failed, page unreachable

      feeds unavailable or not visible to you: alerts

      · 2026-11-08 09:10 deploy        Deployed checkout v42
        by ci
      ● 2026-11-08 09:14 probe         checkout went down

      Timeline truncated. This window holds more events than one view can carry.
      "
    `);
    out.stdout = "";
    expect(await run("declared-incidents", "inc_1", "--json")).toBe(0);
    expect(out.stdout).toBe(
      pretty({
        org: "org_1",
        incident: INCIDENTS.incidents[0],
        timeline: TIMELINE,
      }),
    );
  });

  it("says when a timeline window was quiet", async () => {
    serveRoutes(out, {
      "GET /incidents": INCIDENTS,
      "GET /incidents/inc_2/timeline": { ...TIMELINE, entries: [], feeds: [], truncated: false },
    });
    expect(await run("declared-incidents", "DNS blip")).toBe(0);
    expect(out.stdout).toMatchInlineSnapshot(`
      "SEV3 DNS blip  ○ resolved
      started 2026-11-01 10:00 · 1d 2h 30m

        · slack: closed (#incidents)

      Nothing else was recorded in this window. The change feed, deploys and alerts were all quiet.
      "
    `);
  });

  it("says when nothing has been declared", async () => {
    serveRoutes(out, { "GET /incidents": { incidents: [] } });
    expect(await run("declared-incidents")).toBe(0);
    expect(out.stdout).toBe("No incidents have been declared. Long may it last.\n");
  });

  it("refuses an unknown incident and --local", async () => {
    serveRoutes(out, { "GET /incidents": INCIDENTS });
    expect(await run("declared-incidents", "nope")).toBe(1);
    expect(out.stderr).toBe(
      'No incident matches "nope". Run `infrawrench declared-incidents` to list.\n',
    );
    out.stderr = "";
    expect(await run("declared-incidents", "--local")).toBe(1);
    expect(out.stderr).toBe(
      "Incidents live in Infrawrench Cloud. An incident is org-scoped and declaring one composes cloud features. Drop --local.\n",
    );
  });

  it("exits 2 for an unknown flag", async () => {
    expect(await run("declared-incidents", "--severity", "sev1")).toBe(2);
    expect(out.stdout).toBe("");
  });
});

// ---------------------------------------------------------------------------
// issues
// ---------------------------------------------------------------------------

const JIRA = [
  {
    id: "j1",
    sourceKind: "cost_anomaly",
    sourceId: "an_1",
    issueKey: "OPS-412",
    issueUrl: "https://acme.atlassian.net/browse/OPS-412",
    createdByUserId: "u1",
    createdAt: "2026-10-05T10:00:00.000Z",
    status: "In Progress",
    statusCategory: "in_progress",
    assignee: "Ada",
    issueUpdatedAt: "2026-10-07T10:00:00.000Z",
    statusSyncedAt: "2026-10-07T10:05:00.000Z",
  },
];

const LINEAR = [
  {
    id: "l1",
    sourceKind: "orphan",
    sourceId: "r_1",
    issueIdentifier: "ENG-123",
    issueUrl: "https://linear.app/acme/issue/ENG-123",
    createdByUserId: null,
    createdAt: "2026-10-06T10:00:00.000Z",
    status: "Done",
    statusCategory: "done",
    assignee: null,
    issueUpdatedAt: null,
    statusSyncedAt: null,
  },
];

const GITHUB = [
  {
    id: "g1",
    sourceKind: "rightsizing",
    sourceId: "r_2",
    fingerprint: "fp",
    repo: "acme/infra",
    installationId: 7,
    issueNumber: 88,
    issueUrl: "https://github.com/acme/infra/issues/88",
    state: "open",
    autoFiled: false,
    pullRequestNumber: null,
    pullRequestUrl: null,
    createdByUserId: "u1",
    createdAt: "2026-10-08T10:00:00.000Z",
    resolvedAt: null,
  },
];

describe("issues", () => {
  const routes = {
    "GET /jira/links": JIRA,
    "GET /linear/links": LINEAR,
    "GET /github-issues/links": GITHUB,
  };

  it("lists every tracker as text", async () => {
    serveRoutes(out, routes);
    expect(await run("issues")).toBe(0);
    expect(out.stdout).toMatchInlineSnapshot(`
      "Acme · 2 open · 3 filed

      TRACKER  ISSUE          STATUS       ASSIGNEE  FINDING       UPDATED   
      jira     OPS-412        In Progress  Ada       cost anomaly  2026-10-07
      github   acme/infra#88  unknown      -         rightsizing   2026-10-08
      linear   ENG-123        Done         -         orphan        2026-10-06
      "
    `);
  });

  it("lists every tracker as JSON", async () => {
    serveRoutes(out, routes);
    expect(await run("issues", "--json")).toBe(0);
    expect(out.stdout).toMatchInlineSnapshot(`
      "{
        "org": "org_1",
        "issues": [
          {
            "tracker": "jira",
            "issue": "OPS-412",
            "url": "https://acme.atlassian.net/browse/OPS-412",
            "sourceKind": "cost_anomaly",
            "sourceId": "an_1",
            "status": "In Progress",
            "statusCategory": "in_progress",
            "assignee": "Ada",
            "issueUpdatedAt": "2026-10-07T10:00:00.000Z",
            "statusSyncedAt": "2026-10-07T10:05:00.000Z",
            "filedAt": "2026-10-05T10:00:00.000Z"
          },
          {
            "tracker": "github",
            "issue": "acme/infra#88",
            "url": "https://github.com/acme/infra/issues/88",
            "sourceKind": "rightsizing",
            "sourceId": "r_2",
            "status": null,
            "statusCategory": null,
            "assignee": null,
            "issueUpdatedAt": null,
            "statusSyncedAt": null,
            "filedAt": "2026-10-08T10:00:00.000Z"
          },
          {
            "tracker": "linear",
            "issue": "ENG-123",
            "url": "https://linear.app/acme/issue/ENG-123",
            "sourceKind": "orphan",
            "sourceId": "r_1",
            "status": "Done",
            "statusCategory": "done",
            "assignee": null,
            "issueUpdatedAt": null,
            "statusSyncedAt": null,
            "filedAt": "2026-10-06T10:00:00.000Z"
          }
        ]
      }
      "
    `);
    expect(JSON.parse(out.stdout).issues.map((r: { issue: string }) => r.issue)).toEqual([
      "OPS-412",
      "acme/infra#88",
      "ENG-123",
    ]);
  });

  it("reads only the tracker named", async () => {
    serveRoutes(out, routes);
    expect(await run("issues", "linear")).toBe(0);
    expect(out.requests).toEqual(["GET /linear/links"]);
    expect(out.stdout).toMatchInlineSnapshot(`
      "Acme · 0 open · 1 filed

      TRACKER  ISSUE    STATUS  ASSIGNEE  FINDING  UPDATED   
      linear   ENG-123  Done    -         orphan   2026-10-06
      "
    `);
  });

  it("skips a tracker it cannot read", async () => {
    serveRoutes(out, { ...routes, "GET /jira/links": new RawResponse(403, '{"error":"no"}') });
    expect(await run("issues")).toBe(0);
    expect(out.stderr).toBe("");
    expect(out.stdout).toMatchInlineSnapshot(`
      "Acme · 1 open · 2 filed

      TRACKER  ISSUE          STATUS   ASSIGNEE  FINDING      UPDATED   
      github   acme/infra#88  unknown  -         rightsizing  2026-10-08
      linear   ENG-123        Done     -         orphan       2026-10-06
      "
    `);
    expect(out.stdout).not.toContain("OPS-412");
  });

  it("says when nothing has been filed", async () => {
    serveRoutes(out, {});
    expect(await run("issues")).toBe(0);
    expect(out.stdout).toBe("Nothing has been filed as an issue yet.\n");
  });

  it("exits 2 for a tracker it does not know", async () => {
    expect(await run("issues", "trello")).toBe(2);
    expect(out.stdout).toBe("");
  });
});

// ---------------------------------------------------------------------------
// estimate
// ---------------------------------------------------------------------------

const RESOURCE_ID = "acc_1:droplet:12345";

const ESTIMATE = {
  estimate: {
    monthlyAmount: 31.5,
    currency: "USD",
    lineItems: [
      { label: "Compute (s-2vcpu-4gb)", monthlyAmount: 24, detail: "730 h × $0.03571/h" },
      { label: "Backups", monthlyAmount: 7.5 },
    ],
    partial: true,
    notes: ["Excludes bandwidth overage."],
  },
  carbon: {
    estimate: {
      vcpus: 2,
      count: 1,
      region: "nyc3",
      grid: "digitalocean",
      gridIntensity: 367.4,
      gridZone: "US-NY",
      gridBasis: "average",
      pue: 1.2,
      kwh: 12.3,
      kgCo2e: 4.52,
    },
    reason: null,
    inScope: true,
    role: "instance",
    assumptions: {
      cpuUtilization: 0.5,
      coefficientSource: "test",
      coefficientVintage: "test",
      scope: "test",
    },
  },
};

const ACCOUNTS = [
  { id: "acc_1", pluginId: "digitalocean", displayName: "prod", createdAt: "2026-01-01" },
  { id: "acc_2", pluginId: "aws", displayName: "staging", createdAt: "2026-01-01" },
];

const resourceRow = (id: string, displayName: string, externalId: string) => ({
  id,
  pluginId: "digitalocean",
  resourceTypeId: id.split(":")[1],
  accountId: "acc_1",
  displayName,
  externalId,
  fieldsJson: {},
  outputsJson: {},
  parentResourceId: null,
});

const RESOURCES = [
  resourceRow(RESOURCE_ID, "web-1", "12345"),
  resourceRow("acc_1:droplet:12346", "web-2", "12346"),
  resourceRow("acc_1:volume:v1", "web-data", "v1"),
];

describe("estimate", () => {
  it("prices a resource by id as text", async () => {
    serveRoutes(out, { "POST /resources/cost-estimate": ESTIMATE });
    expect(await run("estimate", RESOURCE_ID)).toBe(0);
    expect(out.stdout).toMatchInlineSnapshot(`
      "at least $31.50/month · droplet

      Compute (s-2vcpu-4gb)  $24  730 h × $0.03571/h
      Backups                $7.50

      ! Partial. Some components of this resource have no published rate.
        Excludes bandwidth overage.

      ~4.5 kg CO2e/month · estimated
        2 vCPU · US-NY · 367 g/kWh · PUE 1.2
      "
    `);
  });

  it("prints the raw estimate and carbon under --json", async () => {
    serveRoutes(out, { "POST /resources/cost-estimate": ESTIMATE });
    expect(await run("estimate", RESOURCE_ID, "--json")).toBe(0);
    expect(out.stdout).toBe(pretty({ resourceId: RESOURCE_ID, ...ESTIMATE }));
  });

  it("sends the target the server prices", async () => {
    const fetchSpy = vi.fn(async () => new Response(JSON.stringify(ESTIMATE)));
    vi.stubGlobal("fetch", fetchSpy);
    expect(await run("estimate", RESOURCE_ID)).toBe(0);
    expect(fetchSpy).toHaveBeenCalledWith(
      "http://localhost:3000/api/org/org_1/resources/cost-estimate",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({
          accountId: "acc_1",
          resourceTypeId: "droplet",
          resourceId: RESOURCE_ID,
        }),
      }),
    );
  });

  it("resolves a name against --account", async () => {
    const routes = {
      "GET /accounts": ACCOUNTS,
      "GET /accounts/acc_1/resources": RESOURCES,
      "POST /resources/cost-estimate": { estimate: null, carbon: null },
    };
    serveRoutes(out, routes);
    expect(await run("estimate", "web-1", "-a", "prod")).toBe(0);
    expect(out.stdout).toMatchInlineSnapshot(`
      "No estimate available for droplet (this provider plugin doesn't publish rates for it)
      "
    `);
    out.stdout = "";
    expect(await run("estimate", "web-1", "-a", "prod", "--json")).toBe(0);
    expect(out.stdout).toMatchInlineSnapshot(`
      "{
        "resourceId": "acc_1:droplet:12345",
        "estimate": null,
        "carbon": null
      }
      "
    `);
  });

  it("explains an unplaceable carbon estimate", async () => {
    serveRoutes(out, {
      "POST /resources/cost-estimate": {
        estimate: null,
        carbon: { ...ESTIMATE.carbon, estimate: null, reason: "unknown-region" },
      },
    });
    expect(await run("estimate", RESOURCE_ID)).toBe(0);
    expect(out.stdout).toMatchInlineSnapshot(`
      "No estimate available for droplet (this provider plugin doesn't publish rates for it)

      No carbon estimate: region not covered.
      "
    `);
  });

  it("refuses without a resource, before looking at --local", async () => {
    expect(await run("estimate", "--local")).toBe(1);
    expect(out.stderr).toBe(
      "Usage: infrawrench estimate <resource-id|name> [--account <id|name>] [--org <id|name>]\n",
    );
  });

  it("refuses --local", async () => {
    expect(await run("estimate", RESOURCE_ID, "--local")).toBe(1);
    expect(out.stderr).toBe("`estimate` is cloud-only. Drop --local, or pass --org <id|name>.\n");
  });

  it("refuses a name without --account", async () => {
    serveRoutes(out, {});
    expect(await run("estimate", "web-1")).toBe(1);
    expect(out.stderr).toBe(
      '"web-1" is not a full resource id. Pass {accountId}:{typeId}:{externalId}, or a name with --account <id|name> (see `infrawrench resources`).\n',
    );
  });

  it("refuses ambiguous and unknown names", async () => {
    serveRoutes(out, { "GET /accounts": ACCOUNTS, "GET /accounts/acc_1/resources": RESOURCES });
    expect(await run("estimate", "web", "-a", "prod")).toBe(1);
    expect(out.stderr).toBe(
      '"web" matches several resources: web-1, web-2, web-data. Be more specific or pass the full id.\n',
    );
    out.stderr = "";
    expect(await run("estimate", "db", "-a", "prod")).toBe(1);
    expect(out.stderr).toBe(
      'No resource matches "db" on this account. See `infrawrench resources --account …`.\n',
    );
  });

  it("refuses a name matching several resources exactly", async () => {
    serveRoutes(out, {
      "GET /accounts": ACCOUNTS,
      "GET /accounts/acc_1/resources": [
        resourceRow("acc_1:droplet:1", "web", "1"),
        resourceRow("acc_1:volume:2", "web", "2"),
      ],
    });
    expect(await run("estimate", "web", "-a", "prod")).toBe(1);
    expect(out.stderr).toBe(
      '"web" matches several resources: web (droplet), web (volume). Pass the full id from `infrawrench resources --json`.\n',
    );
  });

  it("renders an unknown account as one line from the legacy helper", async () => {
    serveRoutes(out, { "GET /accounts": ACCOUNTS });
    expect(await run("estimate", "web-1", "-a", "nope")).toBe(1);
    expect(out.stderr).toBe('No account matches "nope".\n');
  });

  it("exits 2 for a second positional", async () => {
    expect(await run("estimate", "a", "b")).toBe(2);
    expect(out.stdout).toBe("");
  });
});
