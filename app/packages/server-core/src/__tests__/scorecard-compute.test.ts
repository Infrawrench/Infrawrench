import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The pillar assembly's job is to read six feeds without inventing anything,
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
 * rather than by call order — the pillars run concurrently under `allSettled`,
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

const { computeScorecard } = await import("../scorecard/compute");
const { listPosture } = await import("../posture/feed");
const { listBackupCoverage } = await import("../backups/feed");
const { listExpiring } = await import("../expiry/feed");
const { getQuotaFeed } = await import("../quotas/feed");
const { listAccessReview } = await import("../access-review/feed");

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
});

function pillar(result: Awaited<ReturnType<typeof computeScorecard>>, id: string) {
  return result.pillars.find((p) => p.id === id)!;
}

describe("computeScorecard", () => {
  it("grades a brand new org as null rather than F", async () => {
    // An org with nothing connected has no infrastructure to grade. An F on
    // day one is a lie told to someone who has done nothing wrong.
    const result = await computeScorecard("org", { now: NOW });
    expect(result.score).toBeNull();
    expect(result.grade).toBeNull();
    expect(result.failedPillars).toEqual([]);
    expect(result.pillars).toHaveLength(6);
    expect(result.pillars.every((p) => p.score === null)).toBe(true);
  });

  it("says why each pillar is unassessed instead of leaving it blank", async () => {
    const result = await computeScorecard("org", { now: NOW });
    for (const p of result.pillars) {
      expect(p.unassessedReason).toBeTruthy();
    }
  });

  it("names the providers that cannot report quotas", async () => {
    vi.mocked(getQuotaFeed).mockResolvedValue({
      ...emptyQuotas,
      unsupportedPluginIds: ["vercel", "netlify"],
    } as never);
    const result = await computeScorecard("org", { now: NOW });
    expect(pillar(result, "headroom").unassessedReason).toContain("vercel");
  });

  it("scores a clean org with resources at 100", async () => {
    setCounts(50, 50);
    const result = await computeScorecard("org", { now: NOW });
    expect(pillar(result, "security").score).toBe(100);
    expect(pillar(result, "ownership").score).toBe(100);
  });

  it("scores headroom on the worst quota, not the mean", async () => {
    // An average across healthy quotas would hide the one at 99% behind them —
    // precisely the failure the quota radar exists to prevent.
    vi.mocked(getQuotaFeed).mockResolvedValue({
      ...emptyQuotas,
      rows: [
        { ...quotaRow, key: "a", utilization: 0.1, name: "Fine" },
        { ...quotaRow, key: "b", utilization: 0.97, name: "Elastic IPs" },
        { ...quotaRow, key: "c", utilization: 0.2, name: "Also fine" },
      ],
    } as never);
    const result = await computeScorecard("org", { now: NOW });
    expect(pillar(result, "headroom").score).toBe(3);
    expect(pillar(result, "headroom").headline).toContain("Elastic IPs");
  });

  it("measures recoverability over judged resources, not unassessed ones", async () => {
    // 10 stateful, 4 of them unreadable, 6 judged, 3 protected → 50%. Counting
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
    const result = await computeScorecard("org", { now: NOW });
    expect(pillar(result, "recoverability").score).toBe(50);
  });

  it("excludes an unassessed pillar from the overall rather than zeroing it", async () => {
    setCounts(20, 20);
    // Everything else stays empty/unassessed; security and ownership are the
    // two that have a population. Both are perfect, so the overall must be 100
    // — not dragged down by four pillars there is no data for.
    const result = await computeScorecard("org", { now: NOW });
    expect(result.score).toBe(100);
    expect(result.grade).toBe("A");
  });

  it("names a failed pillar and keeps the rest of the page", async () => {
    setCounts(20, 20);
    vi.mocked(getQuotaFeed).mockRejectedValue(new Error("quota table is unavailable"));
    const result = await computeScorecard("org", { now: NOW });
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
    const result = await computeScorecard("org", { now: NOW });
    expect(pillar(result, "security").nextStep).toBe(
      "Bucket allows public access — customer-uploads",
    );
    expect(pillar(result, "security").score).toBeLessThan(100);
  });

  it("never reports more owned resources than there are resources", async () => {
    // An ownership row can outlive the resource it names; 103% owned would be
    // a stranger thing to show than 100%.
    setCounts(10, 14);
    const result = await computeScorecard("org", { now: NOW });
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
