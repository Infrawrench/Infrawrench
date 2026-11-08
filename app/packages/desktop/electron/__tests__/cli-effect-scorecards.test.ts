import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// `scorecards` on effect/cli: the org grade and matrix, one scorecard's
// detail with each service's trend, `--json` as the server sent it, and the
// refusals, against fixtures. Nothing reaches a network or a database.
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

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-11-08T12:00:00.000Z"));
});
afterEach(() => {
  vi.useRealTimers();
});

const cli = (...argv: string[]) => {
  out.stdout = "";
  out.stderr = "";
  return run(...argv);
};

const levels = [
  { key: "bronze", name: "Bronze", minScore: 50, color: null },
  { key: "gold", name: "Gold", minScore: 90, color: "#fc0" },
  { key: "silver", name: "Silver", minScore: 70, color: null },
];

const card = (id: string, name: string, over: Record<string, unknown> = {}) => ({
  id,
  name,
  description: "Production readiness",
  checks: [
    { id: "ch1", type: "has_owner", name: null, weight: 3, params: {} },
    {
      id: "ch2",
      type: "no_critical_posture",
      name: "No criticals",
      weight: 5,
      params: { severities: ["critical", "high"] },
    },
    { id: "ch3", type: "quantum_ready", name: null, weight: 2, params: { qubits: 4 } },
  ],
  levels,
  applicableTiers: [1, 2],
  alertOnLevelDrop: true,
  enabled: true,
  isDefault: false,
  lastEvaluatedAt: "2026-11-08T06:00:00.000Z",
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
  ...over,
});

const result = (
  serviceId: string,
  scorecardId: string,
  score: number | null,
  level: string | null,
) => ({
  scorecardId,
  scorecardName: scorecardId,
  serviceId,
  score,
  level,
  levelName: level === null ? null : level[0]!.toUpperCase() + level.slice(1),
  checks: [
    {
      checkId: "ch1",
      type: "has_owner",
      name: "Has owner",
      weight: 3,
      status: "pass",
      detail: null,
    },
    {
      checkId: "ch2",
      type: "no_critical_posture",
      name: "No criticals",
      weight: 5,
      status: score !== null && score < 70 ? "fail" : "pass",
      detail: null,
    },
  ],
  evaluatedAt: "2026-11-08T06:00:00.000Z",
});

const overview = {
  scorecards: [card("sc_prod", "Production"), card("sc_sec", "Security", { enabled: false })],
  services: [
    { id: "svc_api", name: "API", slug: "api", tier: 1, ownerTeam: "core" },
    { id: "svc_web", name: "Web", slug: "web", tier: 2, ownerTeam: null },
    { id: "svc_jobs", name: "Jobs", slug: "jobs", tier: null, ownerTeam: null },
  ],
  results: [
    result("svc_api", "sc_prod", 92, "gold"),
    result("svc_web", "sc_prod", 64, "bronze"),
    result("svc_jobs", "sc_prod", null, null),
    result("svc_api", "sc_sec", 40, null),
  ],
};

const orgGrade = {
  score: 74,
  grade: "C",
  pillars: [
    {
      id: "posture",
      score: 60,
      weight: 25,
      headline: "3 critical findings",
      unassessedReason: null,
      nextStep: "Fix the public bucket",
      facts: [],
    },
    {
      id: "headroom",
      score: 90,
      weight: 10,
      headline: "Minds read",
      unassessedReason: null,
      nextStep: null,
      facts: [],
    },
    {
      id: "ownership",
      score: null,
      weight: 5,
      headline: "No owners",
      unassessedReason: "No services yet",
      nextStep: null,
      facts: [],
    },
  ],
  failedPillars: ["access"],
  trend: [
    { day: "2026-10-01", score: 70, grade: "C", pillars: {} },
    { day: "2026-10-15", score: 72, grade: "C", pillars: {} },
    { day: "2026-11-01", score: 74, grade: "C", pillars: {} },
  ],
  generatedAt: "2026-11-08T06:00:00.000Z",
};

const history = (points: Array<number | null>) => ({
  results: [],
  history: {
    sc_prod: points.map((score, i) => ({ day: `2026-11-0${i + 1}`, score, level: null })),
    sc_sec: [{ day: "2026-11-01", score: 1, level: null }],
  },
});

const routes = {
  "GET /scorecards/overview": overview,
  "GET /scorecards/org": orgGrade,
  "GET /services/svc_api/scorecards": history([80, 85, 92]),
  "GET /services/svc_web/scorecards": history([70, 64]),
  "GET /services/svc_jobs/scorecards": new RawResponse(500, "boom"),
};

describe("scorecards", () => {
  it("prints the org grade above the matrix", async () => {
    serveRoutes(out, routes);
    expect(await cli("scorecards")).toBe(0);
    expect(out.stdout).toMatchInlineSnapshot(`
      "Org grade  C 74  +4 since 2026-10-01  · Acme
        ▆▆▆ 3 daily readings
        biggest drag: Security posture · Fix the public bucket
        1 pillar could not be read and is excluded, not counted against the grade

        PILLAR            WEIGHT  SCORE  READING            
        Security posture      25     60  3 critical findings
        Headroom              10     90  Minds read         
        Ownership              5    n/a  No services yet    

      Acme · 3 services × 2 scorecards

      SERVICE  TIER  PRODUCTION  SECURITY (OFF)
      API      T1    92% Gold    40%           
      Web      T2    64% Bronze  n/a           
      Jobs     -     not scored  n/a           

      n/a: the scorecard does not apply to the service's tier. \`infrawrench scorecards <name>\` shows one scorecard's checks.
      "
    `);
  });

  it("prints the matrix --json as the server sent it", async () => {
    serveRoutes(out, routes);
    expect(await cli("scorecards", "--json")).toBe(0);
    expect(JSON.parse(out.stdout)).toEqual({ org: "org_1", orgGrade, ...overview });
  });

  it("keeps the matrix when the org grade cannot be read", async () => {
    serveRoutes(out, { ...routes, "GET /scorecards/org": new RawResponse(500, "nope") });
    expect(await cli("scorecards")).toBe(0);
    expect(out.stdout).toMatchInlineSnapshot(`
      "Org grade: could not be read right now. The matrix below is unaffected.

      Acme · 3 services × 2 scorecards

      SERVICE  TIER  PRODUCTION  SECURITY (OFF)
      API      T1    92% Gold    40%           
      Web      T2    64% Bronze  n/a           
      Jobs     -     not scored  n/a           

      n/a: the scorecard does not apply to the service's tier. \`infrawrench scorecards <name>\` shows one scorecard's checks.
      "
    `);
    serveRoutes(out, { ...routes, "GET /scorecards/org": new RawResponse(500, "nope") });
    expect(await cli("scorecards", "--json")).toBe(0);
    expect(JSON.parse(out.stdout).orgGrade).toBeNull();
  });

  it("says so when nothing could be assessed, and when there is nothing to score", async () => {
    serveRoutes(out, {
      ...routes,
      "GET /scorecards/org": { ...orgGrade, score: null, grade: null, trend: [] },
      "GET /scorecards/overview": { ...overview, services: [] },
    });
    expect(await cli("scorecards")).toBe(0);
    expect(out.stdout).toMatchInlineSnapshot(`
      "Org grade · Acme · nothing could be assessed yet; connect an account and let it sync

      No services to score yet. Create one from the Services tab.
      "
    `);
    serveRoutes(out, { ...routes, "GET /scorecards/overview": { ...overview, scorecards: [] } });
    expect(await cli("scorecards")).toBe(0);
    expect(out.stdout).toMatchInlineSnapshot(`
      "Org grade  C 74  +4 since 2026-10-01  · Acme
        ▆▆▆ 3 daily readings
        biggest drag: Security posture · Fix the public bucket
        1 pillar could not be read and is excluded, not counted against the grade

        PILLAR            WEIGHT  SCORE  READING            
        Security posture      25     60  3 critical findings
        Headroom              10     90  Minds read         
        Ownership              5    n/a  No services yet    

      No scorecards. Create one from the Scorecards tab.
      "
    `);
  });

  it("shows one scorecard by name with each service's trend", async () => {
    serveRoutes(out, routes);
    expect(await cli("scorecards", "prod")).toBe(0);
    expect(out.stdout).toMatchInlineSnapshot(`
      "Production  enabled
      Production readiness
      applies to tier 1, tier 2 · alerts on a level drop · evaluated 2026-11-08 06:00 UTC

      levels
        Bronze ≥ 50  ·  Silver ≥ 70  ·  Gold ≥ 90

      checks
        CHECK          TYPE                 WEIGHT  PARAMS                            
        Has an owner   has_owner              3/10  -                                 
        No criticals   no_critical_posture    5/10  Severities that fail=critical,high
        quantum_ready  quantum_ready          2/10  qubits=4                          

      services (3)
        SERVICE  TIER  SCORE       90D  FAILING     
        API      T1    92% Gold    ▁▄█  -           
        Web      T2    64% Bronze  █▁   No criticals
        Jobs     -     not scored  -    -           

      \`infrawrench services show <slug>\` prints why each check failed.
      "
    `);
    expect(out.requests).toEqual([
      "GET /scorecards/overview",
      "GET /services/svc_api/scorecards",
      "GET /services/svc_web/scorecards",
      "GET /services/svc_jobs/scorecards",
    ]);
  });

  it("shows one scorecard --json, by id prefix and by name", async () => {
    serveRoutes(out, routes);
    const code = await cli("scorecards", "sc_s", "--json");
    expect(out.stderr).toBe("");
    expect(code).toBe(0);
    expect(JSON.parse(out.stdout)).toEqual({
      org: "org_1",
      scorecard: overview.scorecards[1],
      services: [overview.services[0]],
      results: [overview.results[3]],
      history: { svc_api: history([80, 85, 92]).history.sc_sec },
    });
    serveRoutes(out, routes);
    expect(await cli("scorecards", "production", "--json")).toBe(0);
  });

  it("labels a pillar this build does not know by its id", async () => {
    serveRoutes(out, {
      ...routes,
      "GET /scorecards/org": {
        ...orgGrade,
        grade: "E",
        pillars: [{ ...orgGrade.pillars[1], id: "telepathy", score: 10, nextStep: "Think" }],
      },
    });
    expect(await cli("scorecards")).toBe(0);
    expect(out.stdout.split("\n").slice(0, 8).join("\n")).toMatchInlineSnapshot(`
      "Org grade  E 74  +4 since 2026-10-01  · Acme
        ▆▆▆ 3 daily readings
        biggest drag: telepathy · Think
        1 pillar could not be read and is excluded, not counted against the grade

        PILLAR     WEIGHT  SCORE  READING   
        telepathy      10     10  Minds read
      "
    `);
  });

  it("refuses an unknown scorecard and --local", async () => {
    serveRoutes(out, routes);
    expect(await cli("scorecards", "nothing")).toBe(1);
    expect(out.stderr).toMatchInlineSnapshot(`
      "No scorecard matches "nothing". Run \`infrawrench scorecards\` to list.
      "
    `);
    expect(await cli("scorecards", "--local")).toBe(1);
    expect(out.stderr).toMatchInlineSnapshot(`
      "Scorecards live in Infrawrench Cloud, where the poller evaluates them. Drop --local.
      "
    `);
  });
});
