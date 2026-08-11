import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * A soft-deleted account must contribute nothing to the quota feed.
 *
 * Removing an account is a soft delete, so its `account_quota_usage` rows
 * survive it. Without the filter they keep appearing on the Quotas page, keep
 * being counted by the weekly digest's `quotasAtRisk` line, and keep paging
 * somebody under the `quotaAlerts` trigger about a limit nobody can act on any
 * more — indefinitely, because the collection pass stops running for a deleted
 * account and so nothing ever supersedes the last reading.
 *
 * The test is behavioural rather than an assertion about SQL text: the drizzle
 * predicate helpers are mocked into a small tree that the accounts query
 * actually *evaluates* against fixture rows, so a feed that fails to ask about
 * `deletedAt` sees the deleted account and fails here.
 */

vi.mock("drizzle-orm", () => ({
  and: (...parts: unknown[]) => ({ op: "and", parts: parts.filter(Boolean) }),
  eq: (col: unknown, value: unknown) => ({ op: "eq", col, value }),
  isNull: (col: unknown) => ({ op: "isNull", col }),
  gte: (col: unknown, value: unknown) => ({ op: "gte", col, value }),
  lt: (col: unknown, value: unknown) => ({ op: "lt", col, value }),
  inArray: (col: unknown, values: unknown) => ({ op: "inArray", col, values }),
  notInArray: (col: unknown, values: unknown) => ({ op: "notInArray", col, values }),
  asc: (col: unknown) => ({ op: "asc", col }),
}));

vi.mock("../db/schema", () => ({
  accounts: { __t: "accounts", organizationId: "organizationId", deletedAt: "deletedAt" },
  accountQuotaUsage: { __t: "accountQuotaUsage", organizationId: "organizationId" },
  accountQuotaSnapshots: {
    __t: "accountQuotaSnapshots",
    organizationId: "organizationId",
    observedAt: "observedAt",
  },
  accountQuotaPolls: { __t: "accountQuotaPolls", organizationId: "organizationId" },
}));

const LIVE = {
  id: "acc-live",
  displayName: "prod-aws",
  pluginId: "aws",
  organizationId: "org-1",
  deletedAt: null,
};
const DELETED = {
  id: "acc-deleted",
  displayName: "retired-aws",
  pluginId: "aws",
  organizationId: "org-1",
  deletedAt: new Date("2026-07-01T00:00:00.000Z"),
};

/** Evaluate the mocked predicate tree against a row. */
function matches(pred: unknown, row: Record<string, unknown>): boolean {
  const p = pred as { op?: string; parts?: unknown[]; col?: string; value?: unknown };
  if (!p || typeof p !== "object" || !p.op) return true;
  switch (p.op) {
    case "and":
      return (p.parts ?? []).every((part) => matches(part, row));
    case "eq":
      return row[p.col as string] === p.value;
    case "isNull":
      return row[p.col as string] === null || row[p.col as string] === undefined;
    default:
      return true;
  }
}

/** One stored quota reading per account — both accounts have one. */
function quotaRow(accountId: string) {
  return {
    accountId,
    quotaKey: "ec2/L-1216C47A/eu-west-1",
    organizationId: "org-1",
    service: "ec2",
    name: "Running On-Demand Standard instances",
    region: "eu-west-1",
    quotaLimit: 1024,
    used: 1010,
    utilization: 1010 / 1024,
    unit: "vCPUs",
    adjustable: true,
    docsUrl: null,
    observedAt: new Date("2026-08-11T00:00:00.000Z"),
  };
}

vi.mock("../db/client", () => ({
  db: {
    select: (_projection?: unknown) => ({
      from: (table: { __t: string }) => ({
        where: (pred: unknown) => {
          if (table.__t === "accounts") {
            return Promise.resolve([LIVE, DELETED].filter((a) => matches(pred, a)));
          }
          if (table.__t === "accountQuotaUsage") {
            // Deliberately unfiltered: the quota tables genuinely still hold
            // the deleted account's rows, which is the whole point.
            return Promise.resolve([quotaRow(LIVE.id), quotaRow(DELETED.id)]);
          }
          if (table.__t === "accountQuotaSnapshots") {
            return { orderBy: () => Promise.resolve([]) };
          }
          return Promise.resolve([
            {
              accountId: DELETED.id,
              lastPolledAt: new Date("2026-07-01T00:00:00.000Z"),
              lastError: "This key cannot read Service Quotas.",
              lastErrorHelpLabel: null,
              lastErrorHelpUrl: null,
            },
          ]);
        },
      }),
    }),
  },
}));

vi.mock("../plugin-loader", () => ({
  loadPlugins: async () => [
    { plugin: { manifest: { id: "aws", quotas: { label: "Service Quotas", partial: true } } } },
  ],
}));

vi.mock("../quotas/settings", () => ({
  getQuotaSettings: async () => ({
    organizationId: "org-1",
    enabled: true,
    threshold: 0.8,
    lastNotifiedAt: null,
  }),
}));

const { getQuotaFeed } = await import("../quotas/feed");

beforeEach(() => vi.clearAllMocks());

describe("getQuotaFeed — soft-deleted accounts", () => {
  it("drops a deleted account's stored quota rows", async () => {
    const feed = await getQuotaFeed("org-1");

    expect(feed.rows.map((r) => r.accountId)).toEqual([LIVE.id]);
    expect(feed.rows.map((r) => r.accountName)).toEqual(["prod-aws"]);
  });

  // The status list is what the page renders as "quotas could not be read for
  // this account". A deleted account's stale failure there is an error banner
  // about something the reader has already dealt with.
  it("drops a deleted account from the per-account status list", async () => {
    const feed = await getQuotaFeed("org-1");

    expect(feed.accounts.map((a) => a.accountId)).toEqual([LIVE.id]);
    expect(feed.accounts.some((a) => a.lastError !== null)).toBe(false);
  });

  /**
   * The digest's `quotasAtRisk` and the alert pass both count
   * `alertableQuotas(feed.rows)`, so this is the assertion that a deleted
   * account cannot page anybody.
   */
  it("leaves nothing for the alert pass or the digest to count", async () => {
    const feed = await getQuotaFeed("org-1");
    const atRisk = feed.rows.filter((r) => r.severity !== "ok");

    expect(atRisk).toHaveLength(1);
    expect(atRisk[0]?.accountId).toBe(LIVE.id);
  });

  it("still reports the live account's reading, so the filter is not just emptying the feed", async () => {
    const feed = await getQuotaFeed("org-1");

    expect(feed.rows[0]).toMatchObject({
      accountId: LIVE.id,
      service: "ec2",
      limit: 1024,
      used: 1010,
      severity: "critical",
    });
    expect(feed.threshold).toBe(0.8);
  });
});
