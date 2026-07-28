import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Hosted build seconds priced into cost_daily. The invariant worth a test is
 * the reserved `infrawrench:deployment` tag: it keeps a build row's
 * ReplacingMergeTree key disjoint from provider-collected rows for the same
 * day and service, and keys each row on its run so same-day builds add up
 * instead of overwriting one another.
 */

const insertCostRows = vi.fn(async (_rows: Array<Record<string, unknown>>) => undefined);
const hashTags = vi.fn((tags: Record<string, string> | undefined) => JSON.stringify(tags ?? {}));
vi.mock("../clickhouse/cost-writers", () => ({ insertCostRows, hashTags }));

const isClickHouseConfigured = vi.fn(() => true);
vi.mock("../clickhouse/client", () => ({ isClickHouseConfigured }));

vi.mock("../db/schema", () => ({
  accounts: {
    __t: "accounts",
    id: "id",
    organizationId: "organization_id",
    deletedAt: "deleted_at",
  },
}));

const db = { select: () => ({ from: () => ({ where: () => Promise.resolve([]) }) }) };
vi.mock("../db/client", () => ({ db }));

let mod: typeof import("../cost/deployment-costs");

const STARTED_AT = new Date("2026-07-01T23:30:00.000Z");

async function write(overrides: Partial<Parameters<typeof mod.writeDeploymentBuildCost>[0]> = {}) {
  return mod.writeDeploymentBuildCost({
    organizationId: "org1",
    runId: "run1",
    env: "prod",
    buildSeconds: 120,
    startedAt: STARTED_AT,
    ...overrides,
  });
}

/** The rows handed to ClickHouse by the first (and only) call. */
function inserted(): Array<Record<string, unknown>> {
  return insertCostRows.mock.calls[0]?.[0] ?? [];
}

beforeEach(async () => {
  vi.clearAllMocks();
  isClickHouseConfigured.mockReturnValue(true);
  mod = await import("../cost/deployment-costs");
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("writeDeploymentBuildCost", () => {
  it("prices build seconds onto a tagged cost_daily row", async () => {
    expect(await write()).toEqual({ written: 1 });
    expect(inserted()[0]).toMatchObject({
      organization_id: "org1",
      account_id: "deployment:prod",
      plugin_id: "deployment",
      day: "2026-07-01",
      service: "Hosted builds",
      resource_id: "run1",
      currency: "USD",
      usage_amount: 120,
      usage_unit: "seconds",
      tags: { "infrawrench:deployment": "run1" },
    });
    expect(inserted()[0]?.["amount"]).toBeCloseTo(120 * mod.HOSTED_BUILD_USD_PER_SECOND, 10);
  });

  it("keeps two runs on the same day on disjoint keys", async () => {
    await write({ runId: "run1" });
    const first = inserted()[0];
    insertCostRows.mockClear();
    await write({ runId: "run2" });
    const second = insertCostRows.mock.calls[0]?.[0]?.[0];
    expect(first?.["tags_hash"]).not.toEqual(second?.["tags_hash"]);
  });

  it("writes nothing for a build we didn't host", async () => {
    expect(await write({ buildSeconds: null })).toEqual({ written: 0 });
    expect(await write({ buildSeconds: 0 })).toEqual({ written: 0 });
    expect(insertCostRows).not.toHaveBeenCalled();
  });

  it("no-ops instead of throwing when cost storage isn't configured", async () => {
    isClickHouseConfigured.mockReturnValue(false);
    expect(await write()).toEqual({ written: 0 });
    expect(insertCostRows).not.toHaveBeenCalled();
  });

  it("lands the spend on the UTC day the run started", async () => {
    await write({ startedAt: new Date("2026-07-02T00:10:00.000Z") });
    expect(inserted()[0]?.["day"]).toBe("2026-07-02");
  });
});

describe("deployment cost account ids", () => {
  it("round-trips an environment and labels it", async () => {
    const ids = await import("../cost/deployment-cost-ids");
    const id = ids.deploymentCostAccountId("staging");
    expect(id).toBe("deployment:staging");
    expect(ids.envFromCostAccountId(id)).toBe("staging");
    expect(ids.deploymentCostAccountLabels([id, "acc1"])).toEqual(
      new Map([[id, "staging (deployments)"]]),
    );
  });

  it("returns null for a real account id", async () => {
    const ids = await import("../cost/deployment-cost-ids");
    expect(ids.envFromCostAccountId("acc1")).toBeNull();
  });
});
