import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The custom-source half of the shared ingest validator: synthetic sub-account
 * ids instead of real accounts, FOCUS charge attribution, and the upload's
 * declared date range. The plain API-push behaviour is covered by
 * `external-costs.test.ts`; these options must not leak into it.
 */

import { fakePostgres } from "./helpers/fake-postgres";

const insertCostRows = vi.fn(async (_rows: Array<Record<string, unknown>>) => undefined);
const hashTags = vi.fn(
  (tags: Record<string, string> | undefined, extras?: { chargeType?: string }) =>
    `${JSON.stringify(tags ?? {})}|${extras?.chargeType ?? "usage"}`,
);
vi.mock("../clickhouse/cost-writers", () => ({ insertCostRows, hashTags }));
vi.mock("../clickhouse/client", () => ({ isClickHouseConfigured: () => true }));
const pg = fakePostgres();
vi.mock("../db/client", () => ({ db: pg.db }));

let ingest: typeof import("../cost/cost-ingest");
let ids: typeof import("../cost/custom-cost-ids");

beforeEach(async () => {
  vi.clearAllMocks();
  pg.reset();
  ingest = await import("../cost/cost-ingest");
  ids = await import("../cost/custom-cost-ids");
});

function source(overrides: Record<string, unknown> = {}) {
  return {
    pluginId: ids.customCostPluginId("src1"),
    tag: { key: ids.CUSTOM_COST_UPLOAD_TAG, value: "up1" },
    fallbackAccountId: ids.customCostAccountId("src1"),
    subAccountId: (sub: string) => ids.customCostAccountId("src1", sub),
    allowAttribution: true,
    dateRange: { from: "2026-07-01", to: "2026-07-31" },
    errorPrefix: "uploads",
    maxRows: 5000,
    ...overrides,
  };
}

describe("custom cost ids", () => {
  it("round-trips plugin and account ids", () => {
    expect(ids.sourceIdFromCustomPluginId("custom:abc")).toBe("abc");
    expect(ids.sourceIdFromCustomPluginId("aws")).toBeNull();
    expect(ids.parseCustomCostAccountId("custom:abc/prod")).toEqual({
      sourceId: "abc",
      subAccount: "prod",
    });
    expect(ids.parseCustomCostAccountId("custom:abc")).toEqual({
      sourceId: "abc",
      subAccount: null,
    });
  });
});

describe("validateCostRows for a custom source", () => {
  it("maps sub-accounts, charge attribution, and stamps the upload tag", async () => {
    const rows = await ingest.validateCostRows({
      organizationId: "org1",
      source: source(),
      rows: [
        {
          date: "2026-07-02",
          currency: "USD",
          amount: 100,
          subAccount: "prod",
          chargeType: "commitment_fee",
          amortizedAmount: 0,
          commitmentId: "ri-1",
        },
        { date: "2026-07-03", currency: "USD", amount: 5 },
      ],
    });
    expect(rows[0]).toMatchObject({
      account_id: "custom:src1/prod",
      plugin_id: "custom:src1",
      charge_type: "commitment_fee",
      amortized_amount: 0,
      amortized_reported: 1,
      commitment_id: "ri-1",
      tags: { "infrawrench:upload": "up1" },
    });
    expect(hashTags).toHaveBeenCalledWith(
      { "infrawrench:upload": "up1" },
      { chargeType: "commitment_fee", commitmentId: "ri-1" },
    );
    expect(rows[1]).toMatchObject({
      account_id: "custom:src1",
      charge_type: "usage",
      amortized_reported: 0,
    });
    // Validation only: nothing written, and no account lookup for synthetic ids.
    expect(insertCostRows).not.toHaveBeenCalled();
    expect(pg.queries).toHaveLength(0);
  });

  it("rejects rows outside the declared range, unknown charge types, and real account ids", async () => {
    const run = (row: Record<string, unknown>) =>
      ingest.validateCostRows({
        organizationId: "org1",
        source: source(),
        rows: [{ date: "2026-07-02", currency: "USD", amount: 1, ...row } as never],
      });
    await expect(run({ date: "2026-08-01" })).rejects.toThrow(/outside the upload's range/);
    await expect(run({ chargeType: "bogus" })).rejects.toThrow(/unknown chargeType/);
    await expect(run({ accountId: "acc1" })).rejects.toThrow(/use subAccount/);
  });

  it("ignores attribution fields for sources that do not allow them", async () => {
    const rows = await ingest.validateCostRows({
      organizationId: "org1",
      source: source({ allowAttribution: false }),
      rows: [{ date: "2026-07-02", currency: "USD", amount: 1, chargeType: "tax" }],
    });
    expect(rows[0]).toMatchObject({ charge_type: "usage", amortized_reported: 0 });
  });
});
