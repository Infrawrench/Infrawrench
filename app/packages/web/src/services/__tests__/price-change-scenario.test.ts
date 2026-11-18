import { describe, expect, it, vi } from "vitest";
import { costScenarioModelInputError } from "@infrawrench/client-core";

vi.mock("../../db/client", () => ({ db: {} }));
vi.mock("../cost-scenarios", () => ({
  CostScenarioNameConflictError: class extends Error {},
  createCostScenarioModel: vi.fn(),
}));

const { priceChangeScenarioInput } = await import("../price-change-scenario");

const row = {
  pluginId: "aws",
  platform: "ec2",
  instanceType: "m5.large",
  region: "us-east-1",
  oldHourlyUsd: 0.096,
  newHourlyUsd: 0.105,
  effectiveAt: new Date("2026-12-01T00:00:00Z"),
  monthlyImpactUsd: 39.42,
  units: 6,
  approximate: false,
  resources: [
    { resourceId: "r1", accountId: "acct-1", units: 5, approximate: false },
    { resourceId: "r2", accountId: "acct-2", units: 1, approximate: false },
    { resourceId: "r3", accountId: "acct-1", units: 0, approximate: false },
  ],
};

describe("priceChangeScenarioInput", () => {
  const input = priceChangeScenarioInput(row, new Date("2026-11-18T00:00:00Z"));

  it("is one recurring monthly amount from the day the price takes effect", () => {
    expect(input.currency).toBe("USD");
    expect(input.name).toBe("Price change: m5.large us-east-1 from 2026-12-01");
    expect(input.adjustments).toEqual([
      expect.objectContaining({
        kind: "recurring",
        period: "monthly",
        startDate: "2026-12-01",
        endDate: null,
        amountCents: 3942,
        currency: "USD",
        percent: null,
      }),
    ]);
  });

  it("is scoped to the provider and the accounts running the type", () => {
    expect(input.adjustments[0]?.scope).toEqual([
      { dimension: "provider", op: "in", values: ["aws"] },
      { dimension: "account", op: "in", values: ["acct-1", "acct-2"] },
    ]);
  });

  it("is a model the scenario editor accepts as it is", () => {
    expect(costScenarioModelInputError(input)).toBeNull();
  });
});
