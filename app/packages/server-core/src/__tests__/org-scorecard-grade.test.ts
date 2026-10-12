import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The org grade's job is to read seven feeds without inventing anything,
 * and the ways that goes wrong are all about absence: an org with no data must
 * come back unassessed rather than failing, a feed that throws must cost its
 * own pillar rather than the page, and a pillar excluded for either reason must
 * not drag the overall down.
 *
 * The feeds are mocked because they are separately tested; what is under test
 * here is the reading, the exclusion and the containment.
 */

const NOW = Date.parse("2026-08-17T09:00:00.000Z");

const emptyPosture = {
  findings: [],
  totalCount: 0,
  counts: { critical: 0, high: 0, medium: 0, low: 0 },
  dismissed: [],
  dismissedCount: 0,
  generatedAt: new Date(NOW).toISOString(),
};

const emptyCoverage = {
  findings: [],
  counts: { critical: 0, high: 0, medium: 0, low: 0 },
  kindCounts: {},
  totalCount: 0,
  resources: [],
  summary: {
    statefulCount: 0,
    protectedCount: 0,
    unprotectedCount: 0,
    unknownCount: 0,
    backupCount: 0,
    orphanedBackupCount: 0,
    unattributableBackupCount: 0,
    orphanedGb: null,
    orphanedMonthlyCost: null,
    currency: null,
    worstRpoHours: null,
  },
  generatedAt: new Date(NOW).toISOString(),
};

const emptyExpiry = {
  items: [],
  totalCount: 0,
  counts: { expired: 0, critical: 0, warning: 0, upcoming: 0, ok: 0 },
  leadDays: 60,
  generatedAt: new Date(NOW).toISOString(),
};

const emptyQuotas = { rows: [], accounts: [], threshold: 0.8, unsupportedPluginIds: [] };

const emptyAccess = {
  principals: [],
  findings: [],
  totalCount: 0,
  counts: { critical: 0, high: 0, medium: 0, low: 0 },
  byRule: {},
  byRole: {},
  dismissed: [],
  dismissedCount: 0,
  unknownActivityCount: 0,
  staleDays: 90,
  generatedAt: new Date(NOW).toISOString(),
};

/**
 * Rows the fake `db` resolves to, keyed by the table the query selects **from**
 * rather than by call order: the pillars run concurrently under `allSettled`,
 * so a positional fake would be asserting on an interleaving rather than on the
 * code.
 */
const selectResults = new Map<string, unknown[]>();

function tableName(table: unknown): string {
  const symbol = Object.getOwnPropertySymbols(table as object).find((s) =>
    s.description?.includes("Name"),
  );
  return symbol ? String((table as Record<symbol, unknown>)[symbol]) : "";
}

vi.mock("../db/client", () => {
  const chain = (name = ""): unknown => {
    const builder: Record<string, unknown> = {};
    for (const method of ["from", "innerJoin", "leftJoin", "where", "orderBy", "limit"]) {
      builder[method] = (arg: unknown) => (method === "from" ? chain(tableName(arg)) : builder);
    }
    builder["then"] = (resolve: (v: unknown[]) => unknown) =>
      Promise.resolve().then(() => resolve(selectResults.get(name) ?? []));
    return builder;
  };
  return { db: { select: () => chain() } };
});

vi.mock("../posture/feed", () => ({ listPosture: vi.fn() }));
vi.mock("../backups/feed", () => ({ listBackupCoverage: vi.fn() }));
vi.mock("../expiry/feed", () => ({ listExpiring: vi.fn() }));
vi.mock("../quotas/feed", () => ({ getQuotaFeed: vi.fn() }));
vi.mock("../access-review/feed", () => ({ listAccessReview: vi.fn() }));
vi.mock("../service-catalog/store", () => ({ listServiceRecords: vi.fn() }));
vi.mock("../scorecards/store", async () => {
  const actual = await vi.importActual<typeof import("../scorecards/store")>("../scorecards/store");
  return {
    scorecardToWire: actual.scorecardToWire,
    listScorecardRecords: vi.fn(),
    listScorecardResults: vi.fn(),
  };
});

const { computeOrgScorecard } = await import("../scorecards/org-grade");
const { listPosture } = await import("../posture/feed");
const { listBackupCoverage } = await import("../backups/feed");
const { listExpiring } = await import("../expiry/feed");
const { getQuotaFeed } = await import("../quotas/feed");
const { listAccessReview } = await import("../access-review/feed");
const { listServiceRecords } = await import("../service-catalog/store");
const { listScorecardRecords, listScorecardResults } = await import("../scorecards/store");
const { GatewayOnlyError } = await import("../runtime/gateway-only");

/**
 * The live resource count (asked for by both the security and ownership
 * pillars) and the ownership row count.
 */
function setCounts(resourceCount: number, ownedCount: number) {
  selectResults.clear();
  selectResults.set("resources", [{ value: resourceCount }]);
  selectResults.set("resource_ownership", [{ value: ownedCount }]);
}

beforeEach(() => {
  setCounts(0, 0);
  vi.mocked(listPosture).mockResolvedValue(emptyPosture as never);
  vi.mocked(listBackupCoverage).mockResolvedValue(emptyCoverage as never);
  vi.mocked(listExpiring).mockResolvedValue(emptyExpiry as never);
  vi.mocked(getQuotaFeed).mockResolvedValue(emptyQuotas as never);
  vi.mocked(listAccessReview).mockResolvedValue(emptyAccess as never);
  vi.mocked(listServiceRecords).mockResolvedValue([]);
  vi.mocked(listScorecardRecords).mockResolvedValue([]);
  vi.mocked(listScorecardResults).mockResolvedValue([]);
});

function pillar(result: Awaited<ReturnType<typeof computeOrgScorecard>>, id: string) {
  return result.pillars.find((p) => p.id === id)!;
}

describe("computeOrgScorecard", () => {
  it("grades a brand new org as null rather than F", async () => {
    // An org with nothing connected has no infrastructure to grade. An F on
    // day one is a lie told to someone who has done nothing wrong.
    const result = await computeOrgScorecard("org", { now: NOW });
    expect(result.score).toBeNull();
    expect(result.grade).toBeNull();
    expect(result.failedPillars).toEqual([]);
    expect(result.pillars).toHaveLength(7);
    expect(result.pillars.every((p) => p.score === null)).toBe(true);
  });

  it("says why each pillar is unassessed instead of leaving it blank", async () => {
    const result = await computeOrgScorecard("org", { now: NOW });
    for (const p of result.pillars) {
      expect(p.unassessedReason).toBeTruthy();
    }
  });

  it("names the providers that cannot report quotas", async () => {
    vi.mocked(getQuotaFeed).mockResolvedValue({
      ...emptyQuotas,
      unsupportedPluginIds: ["vercel", "netlify"],
    } as never);
    const result = await computeOrgScorecard("org", { now: NOW });
    expect(pillar(result, "headroom").unassessedReason).toContain("vercel");
  });

  it("scores a clean org with resources at 100", async () => {
    setCounts(50, 50);
    const result = await computeOrgScorecard("org", { now: NOW });
    expect(pillar(result, "posture").score).toBe(100);
    expect(pillar(result, "ownership").score).toBe(100);
  });

  it("scores headroom on the worst quota, not the mean", async () => {
    // An average across healthy quotas would hide the one at 99% behind them,
    // precisely the failure the quota radar exists to prevent.
    vi.mocked(getQuotaFeed).mockResolvedValue({
      ...emptyQuotas,
      rows: [
        { ...quotaRow, key: "a", utilization: 0.1, name: "Fine" },
        { ...quotaRow, key: "b", utilization: 0.97, name: "Elastic IPs" },
        { ...quotaRow, key: "c", utilization: 0.2, name: "Also fine" },
      ],
    } as never);
    const result = await computeOrgScorecard("org", { now: NOW });
    expect(pillar(result, "headroom").score).toBe(3);
    expect(pillar(result, "headroom").headline).toContain("Elastic IPs");
  });

  it("measures recoverability over judged resources, not unassessed ones", async () => {
    // 10 stateful, 4 of them unreadable, 6 judged, 3 protected: 50%. Counting
    // the unassessed as gaps would put the false alarm back on the screen the
    // coverage computation was careful to keep off it.
    vi.mocked(listBackupCoverage).mockResolvedValue({
      ...emptyCoverage,
      summary: {
        ...emptyCoverage.summary,
        statefulCount: 10,
        unknownCount: 4,
        protectedCount: 3,
        unprotectedCount: 3,
      },
    } as never);
    const result = await computeOrgScorecard("org", { now: NOW });
    expect(pillar(result, "recoverability").score).toBe(50);
  });

  it("excludes an unassessed pillar from the overall rather than zeroing it", async () => {
    setCounts(20, 20);
    // Everything else stays empty/unassessed; posture and ownership are the
    // two that have a population. Both are perfect, so the overall must be 100,
    // not dragged down by five pillars there is no data for.
    const result = await computeOrgScorecard("org", { now: NOW });
    expect(result.score).toBe(100);
    expect(result.grade).toBe("A");
  });

  it("names a failed pillar and keeps the rest of the page", async () => {
    setCounts(20, 20);
    vi.mocked(getQuotaFeed).mockRejectedValue(new Error("quota table is unavailable"));
    const result = await computeOrgScorecard("org", { now: NOW });
    expect(result.failedPillars).toEqual(["headroom"]);
    // Excluded from the overall exactly as an unassessed pillar is...
    expect(result.score).toBe(100);
    // ...but described as ours rather than as a fact about the org.
    expect(pillar(result, "headroom").unassessedReason).toContain("failed to run");
  });

  it("points at the worst finding as the next step", async () => {
    setCounts(20, 20);
    vi.mocked(listPosture).mockResolvedValue({
      ...emptyPosture,
      totalCount: 1,
      counts: { critical: 1, high: 0, medium: 0, low: 0 },
      findings: [
        {
          resourceId: "r1",
          pluginId: "aws",
          pluginName: "AWS",
          resourceTypeId: "s3-bucket",
          resourceTypeName: "S3 Bucket",
          accountId: "a1",
          accountName: "prod",
          displayName: "customer-uploads",
          externalId: null,
          ruleId: "public-bucket",
          title: "Bucket allows public access",
          severity: "critical",
          category: "exposure",
          reason: "…",
        },
      ],
    } as never);
    const result = await computeOrgScorecard("org", { now: NOW });
    expect(pillar(result, "posture").nextStep).toBe(
      "Bucket allows public access: customer-uploads",
    );
    expect(pillar(result, "posture").score).toBeLessThan(100);
  });

  it("reads the service standards pillar from the stored scorecard results", async () => {
    // The same pairs the matrix below the grade shows: tier-applicable and
    // scored. Never re-evaluated or seeded here.
    vi.mocked(listScorecardRecords).mockResolvedValue([scorecardRow] as never);
    vi.mocked(listServiceRecords).mockResolvedValue([
      serviceRow("checkout", "Checkout"),
      serviceRow("search", "Search"),
    ] as never);
    vi.mocked(listScorecardResults).mockResolvedValue([
      scorecardResult("checkout", 90),
      scorecardResult("search", 50),
    ]);
    const result = await computeOrgScorecard("org", { now: NOW });
    const services = pillar(result, "services");
    expect(services.score).toBe(70);
    expect(services.nextStep).toBe("Search on Production readiness: 50%");
    // The only assessed pillar, so it is the overall.
    expect(result.score).toBe(70);
    expect(result.grade).toBe("C");
  });

  it("leaves the service standards pillar unassessed with no services", async () => {
    vi.mocked(listScorecardRecords).mockResolvedValue([scorecardRow] as never);
    const result = await computeOrgScorecard("org", { now: NOW });
    expect(pillar(result, "services").score).toBeNull();
    expect(pillar(result, "services").unassessedReason).toContain("Define a service");
  });

  it("rethrows a gateway-only error so the edge can replay on the gateway", async () => {
    // On the edge the posture feed reaches stubbed plugin code. Rendering that
    // as a failed pillar would grade the org on half its evidence.
    vi.mocked(listPosture).mockRejectedValue(new GatewayOnlyError("posture rules"));
    await expect(computeOrgScorecard("org", { now: NOW })).rejects.toThrow("gateway");
  });

  it("never reports more owned resources than there are resources", async () => {
    // An ownership row can outlive the resource it names; 103% owned would be
    // a stranger thing to show than 100%.
    setCounts(10, 14);
    const result = await computeOrgScorecard("org", { now: NOW });
    expect(pillar(result, "ownership").score).toBe(100);
  });
});

const quotaRow = {
  key: "q",
  accountId: "a1",
  accountName: "prod",
  pluginId: "aws",
  service: "EC2",
  name: "Quota",
  region: null,
  limit: 100,
  used: 10,
  utilization: 0.1,
  unit: null,
  adjustable: true,
  docsUrl: null,
  observedAt: new Date(NOW).toISOString(),
  severity: "ok",
  trend: "flat",
};

const scorecardRow = {
  id: "sc1",
  organizationId: "org",
  name: "Production readiness",
  description: null,
  checks: [],
  levels: [
    { key: "bronze", name: "Bronze", minScore: 50, color: null },
    { key: "gold", name: "Gold", minScore: 90, color: null },
  ],
  applicableTiers: [],
  alertOnLevelDrop: true,
  enabled: true,
  isDefault: true,
  lastEvaluatedAt: null,
  createdBy: null,
  createdAt: new Date(NOW),
  updatedAt: new Date(NOW),
};

function serviceRow(id: string, name: string) {
  return { id, name, slug: id, tier: null, ownerTeam: null };
}

function scorecardResult(serviceId: string, score: number) {
  return {
    scorecardId: "sc1",
    scorecardName: "Production readiness",
    serviceId,
    score,
    level: score >= 90 ? "gold" : "bronze",
    levelName: score >= 90 ? "Gold" : "Bronze",
    checks: [],
    evaluatedAt: new Date(NOW).toISOString(),
  };
}
