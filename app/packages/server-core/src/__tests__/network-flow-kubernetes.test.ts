import { describe, expect, it, vi } from "vitest";
import type { NetworkFlowCapabilityDeclaration, NetworkFlowRecord } from "@infrawrench/plugin-base";

vi.mock("../db/client", () => ({ db: {} }));
vi.mock("../sync-resources", () => ({ loadAccountClient: vi.fn() }));

import { aggregateNetworkFlows } from "../network-flow/aggregate";
import { resolveFlowRates } from "../network-flow/collect";

const capability: NetworkFlowCapabilityDeclaration = {
  rates: { currency: "USD", asOf: "2026-10-04", perGb: {} },
  maxPairsPerDay: 500,
  maxHistoryDays: 1,
  recut: true,
};

describe("resolveFlowRates", () => {
  const aws = {
    currency: "USD",
    asOf: "x",
    perGb: { cross_zone: 0.01, internet_egress: 0.09 },
    perRegion: { "eu-west-1": { internet_egress: 0.08 } },
  };

  it("keeps the plugin's own card when nothing else is named", async () => {
    expect(await resolveFlowRates(capability, {}, async () => aws)).toBe(capability.rates);
  });

  it("prices from the named cloud's card, with per-cluster overrides on top", async () => {
    const card = await resolveFlowRates(
      capability,
      { ratesFromPlugin: "aws", rateOverrides: { internet_egress: 0.05 } },
      async (id) => (id === "aws" ? aws : undefined),
    );
    expect(card.perGb).toEqual({ cross_zone: 0.01, internet_egress: 0.05 });
    // An override means "here", not "here unless the provider has a regional exception".
    expect(card.perRegion?.["eu-west-1"]).toEqual({});
  });

  it("falls back to its own card when the named plugin publishes none", async () => {
    const card = await resolveFlowRates(
      capability,
      { ratesFromPlugin: "missing" },
      async () => undefined,
    );
    expect(card).toBe(capability.rates);
  });
});

describe("aggregateNetworkFlows method", () => {
  const flow = (method: NetworkFlowRecord["method"], bytes: number): NetworkFlowRecord => ({
    date: "2026-10-03",
    source: { ref: "app/Deployment/web", zone: "a" },
    destination: { ref: "k8s:peers/cross_zone" },
    scope: "cross_zone",
    direction: "egress",
    attribution: "unattributed",
    bytes,
    ...(method ? { method } : {}),
  });

  it("labels a folded pair with the weakest method behind it", () => {
    const out = aggregateNetworkFlows("2026-10-03", {
      flows: [flow("flow_log", 10), flow("counter_estimate", 5)],
      rates: { currency: "USD", asOf: "x", perGb: { cross_zone: 0.01 } },
    });
    expect(out.rows).toHaveLength(1);
    expect(out.rows[0]!.method).toBe("counter_estimate");
    expect(out.rows[0]!.bytes).toBe(15);
  });

  it("stores an empty method for single-method plugins", () => {
    const out = aggregateNetworkFlows("2026-10-03", {
      flows: [flow(undefined, 10)],
      rates: { currency: "USD", asOf: "x", perGb: {} },
    });
    expect(out.rows[0]!.method).toBe("");
  });
});
