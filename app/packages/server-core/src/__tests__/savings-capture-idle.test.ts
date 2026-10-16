import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Deleting a resource an idle rule flags counts as a realized saving, priced
 * from billing when it matched and from the finding's list-price estimate
 * otherwise. Everything around the decision is stubbed at its module boundary.
 */

const row = {
  id: "res-nat",
  accountId: "acc-1",
  pluginId: "aws",
  resourceTypeId: "nat-gateway",
  externalId: "nat-0abc",
  displayName: "egress-nat",
  fieldsJson: { region: "us-east-1" },
};

vi.mock("../db/client", () => ({
  db: {
    select: () => ({ from: () => ({ where: () => ({ limit: () => Promise.resolve([row]) }) }) }),
  },
}));
vi.mock("../plugin-loader", () => ({
  getPlugin: async () => ({
    plugin: { resourceTypes: [{ id: "nat-gateway", displayName: "NAT Gateway" }] },
  }),
}));
const queryCosts = vi.fn(async () => [] as unknown[]);
vi.mock("../clickhouse/cost-readers", () => ({ queryCosts: () => queryCosts() }));
vi.mock("../org-accounts", () => ({ getOrgAccountClient: async () => null }));
const findIdle = vi.fn();
vi.mock("../idle/feed", () => ({
  findIdleFindingForResource: (...args: unknown[]) => findIdle(...args),
}));
const recordSavingsEvent = vi.fn();
vi.mock("../savings/events", () => ({
  recordSavingsEvent: (...args: unknown[]) => recordSavingsEvent(...args),
  endOpenScheduleSavings: vi.fn(),
  resumeScheduleSaving: vi.fn(),
}));

const { captureDeletionSaving } = await import("../savings/capture");

const input = {
  organizationId: "org-1",
  accountId: "acc-1",
  resourceId: "res-nat",
  resourceTypeId: "nat-gateway",
  pluginId: "aws",
  source: "in_app" as const,
  now: new Date("2026-10-16T00:00:00Z"),
};

beforeEach(() => {
  findIdle.mockReset();
  recordSavingsEvent.mockReset();
});

describe("captureDeletionSaving for idle resources", () => {
  it("records a deletion the idle rule flagged, at the finding's list price", async () => {
    findIdle.mockResolvedValue({
      reason: "Sent 0 B to the internet over 14 days",
      estimate: { monthlyAmount: 32.85, currency: "USD", basis: "list-price" },
    });
    await captureDeletionSaving(input);
    expect(findIdle).toHaveBeenCalledWith("org-1", "res-nat");
    expect(recordSavingsEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "orphan_deletion",
        note: "Sent 0 B to the internet over 14 days",
        currency: "USD",
        dedupeKey: "orphan_deletion:res-nat",
      }),
    );
    const event = recordSavingsEvent.mock.calls[0]![0] as { projectedMonthlyAmount: number };
    expect(event.projectedMonthlyAmount).toBeCloseTo(32.85, 2);
  });

  it("records nothing for a deletion no rule flagged", async () => {
    findIdle.mockResolvedValue(null);
    await captureDeletionSaving(input);
    expect(recordSavingsEvent).not.toHaveBeenCalled();
  });
});
