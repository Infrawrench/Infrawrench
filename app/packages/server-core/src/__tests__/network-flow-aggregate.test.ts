import type {
  NetworkFlowRateCard,
  NetworkFlowRecord,
  NetworkFlowScope,
  NetworkFlowTotal,
} from "@infrawrench/plugin-base";
import { describe, expect, it } from "vitest";

import {
  aggregateNetworkFlows,
  fnv1a64,
  TRUNCATED_REF,
  type NetworkFlowDailyRow,
} from "../network-flow/aggregate";
import { boundaryFlags, priceBytes, resolveRate } from "../network-flow/pricing";

const DAY = "2026-08-10";
const GB = 1_000_000_000;

const RATES: NetworkFlowRateCard = {
  currency: "USD",
  asOf: "2026-08-11",
  perGb: {
    intra_zone: 0,
    cross_zone: 0.01,
    cross_region: 0.02,
    internet_egress: 0.09,
    internet_ingress: 0,
    provider_service: 0,
    nat_gateway: 0.045,
    unknown: 0,
  },
  perRegion: { "eu-west-1": { internet_egress: 0.09, cross_region: 0.02 } },
};

function flow(
  overrides: Partial<NetworkFlowRecord> & { bytes: number; scope: NetworkFlowScope },
): NetworkFlowRecord {
  return {
    date: DAY,
    source: { ref: "i-src", region: "us-east-1", zone: "use1-az1" },
    destination: { ref: "i-dst", region: "us-east-1", zone: "use1-az2" },
    direction: "egress",
    attribution: "resolved",
    packets: 1,
    ...overrides,
  };
}

function total(
  scope: NetworkFlowScope,
  bytes: number,
  direction: "egress" | "ingress" = "egress",
): NetworkFlowTotal {
  return { date: DAY, scope, direction, bytes };
}

function byAttribution(rows: NetworkFlowDailyRow[], attribution: string): NetworkFlowDailyRow[] {
  return rows.filter((r) => r.attribution === attribution);
}

describe("priceBytes", () => {
  it("prices per decimal GB, not GiB", () => {
    // A GiB priced as a GB would come out 7.4% high; every provider's
    // data-transfer page defines GB as 10^9.
    expect(priceBytes(RATES, "internet_egress", GB).amount).toBeCloseTo(0.09, 10);
    expect(priceBytes(RATES, "internet_egress", 1_073_741_824).amount).toBeGreaterThan(0.09);
  });

  it("prices the free boundaries at zero without dropping the bytes", () => {
    const priced = priceBytes(RATES, "intra_zone", 10 * GB);
    expect(priced.amount).toBe(0);
    expect(priced.bytes).toBe(10 * GB);
  });

  it("prices an unnamed scope at zero rather than guessing", () => {
    const sparse: NetworkFlowRateCard = { currency: "USD", asOf: "2026-01-01", perGb: {} };
    expect(priceBytes(sparse, "internet_egress", 100 * GB).amount).toBe(0);
  });

  it("clamps a negative byte count so a residual quirk cannot credit the bill", () => {
    const priced = priceBytes(RATES, "internet_egress", -5 * GB);
    expect(priced.bytes).toBe(0);
    expect(priced.amount).toBe(0);
  });

  it("prefers a regional override when one names the scope", () => {
    const card: NetworkFlowRateCard = {
      ...RATES,
      perRegion: { "ap-south-1": { internet_egress: 0.1093 } },
    };
    expect(resolveRate(card, "internet_egress", "ap-south-1")).toEqual({
      perGb: 0.1093,
      currency: "USD",
      regional: true,
    });
    // A region with an override that does not name this scope falls through.
    expect(resolveRate(card, "cross_zone", "ap-south-1").regional).toBe(false);
    expect(resolveRate(card, "cross_zone", "ap-south-1").perGb).toBe(0.01);
  });
});

describe("boundaryFlags", () => {
  it("derives the three questions from the scope", () => {
    expect(boundaryFlags("cross_zone")).toEqual({
      crossedZone: true,
      crossedRegion: false,
      leftCloud: false,
    });
    expect(boundaryFlags("cross_region").crossedRegion).toBe(true);
    expect(boundaryFlags("internet_egress").leftCloud).toBe(true);
  });

  it("does not count a NAT hop as leaving the cloud", () => {
    // NAT is a processing charge; the bytes then cross whatever boundary they
    // were headed for and that boundary is priced separately.
    expect(boundaryFlags("nat_gateway")).toEqual({
      crossedZone: false,
      crossedRegion: false,
      leftCloud: false,
    });
  });
});

describe("aggregateNetworkFlows", () => {
  it("folds duplicate pairs before ranking them", () => {
    const result = aggregateNetworkFlows(
      DAY,
      {
        flows: [
          flow({ bytes: 3 * GB, scope: "cross_zone" }),
          flow({ bytes: 4 * GB, scope: "cross_zone" }),
        ],
        rates: RATES,
      },
      { maxPairs: 10 },
    );
    const rows = byAttribution(result.rows, "resolved");
    expect(rows).toHaveLength(1);
    expect(rows[0]!.bytes).toBe(7 * GB);
    expect(rows[0]!.packets).toBe(2);
    expect(rows[0]!.estimatedCost).toBeCloseTo(0.07, 10);
  });

  it("keeps the top pairs and turns the exact remainder into a truncation row", () => {
    const flows = [
      flow({ bytes: 100 * GB, scope: "internet_egress", destination: { ref: "internet" } }),
      flow({
        bytes: 10 * GB,
        scope: "internet_egress",
        source: { ref: "i-other" },
        destination: { ref: "internet" },
      }),
    ];
    const result = aggregateNetworkFlows(
      DAY,
      // The provider says there were 250 GB of internet egress; we itemize the
      // largest pair only. The other 150 GB must still be on the screen.
      { flows, totals: [total("internet_egress", 250 * GB)], rates: RATES },
      { maxPairs: 1 },
    );

    const kept = byAttribution(result.rows, "resolved");
    expect(kept).toHaveLength(1);
    expect(kept[0]!.bytes).toBe(100 * GB);

    const truncated = byAttribution(result.rows, "truncated");
    expect(truncated).toHaveLength(1);
    expect(truncated[0]!.bytes).toBe(150 * GB);
    expect(truncated[0]!.srcRef).toBe(TRUNCATED_REF);
    // Priced, not just counted: an unpriced tail makes the itemization look
    // complete when it is not.
    expect(truncated[0]!.estimatedCost).toBeCloseTo(13.5, 10);

    expect(result.droppedPairs).toBe(1);
    expect(result.residualBytes).toBe(150 * GB);
    expect(result.totalsReported).toBe(true);
  });

  it("residual covers only its own cut when the provider reports no totals", () => {
    const result = aggregateNetworkFlows(
      DAY,
      {
        flows: [
          flow({ bytes: 5 * GB, scope: "cross_zone" }),
          flow({ bytes: 2 * GB, scope: "cross_zone", source: { ref: "i-b" } }),
        ],
        rates: RATES,
      },
      { maxPairs: 1 },
    );
    expect(result.totalsReported).toBe(false);
    const truncated = byAttribution(result.rows, "truncated");
    expect(truncated).toHaveLength(1);
    expect(truncated[0]!.bytes).toBe(2 * GB);
  });

  it("keeps an unattributable flow as its own row rather than apportioning it", () => {
    const result = aggregateNetworkFlows(
      DAY,
      {
        flows: [
          flow({ bytes: 20 * GB, scope: "internet_egress", destination: { ref: "internet" } }),
          flow({
            bytes: 80 * GB,
            scope: "internet_egress",
            attribution: "unattributed",
            source: { ref: "i-src" },
            destination: { ref: "infrawrench:unattributed", label: "Unidentified peer" },
          }),
        ],
        totals: [total("internet_egress", 100 * GB)],
        rates: RATES,
      },
      { maxPairs: 10 },
    );

    const unattributed = byAttribution(result.rows, "unattributed");
    expect(unattributed).toHaveLength(1);
    expect(unattributed[0]!.bytes).toBe(80 * GB);
    // The resolved row keeps exactly its own bytes — nothing was spread onto it.
    expect(byAttribution(result.rows, "resolved")[0]!.bytes).toBe(20 * GB);
    // And the two account for the whole reported total, so there is no tail.
    expect(byAttribution(result.rows, "truncated")).toHaveLength(0);
    expect(result.residualBytes).toBe(0);
  });

  it("produces nothing at all for a provider with no flow source", () => {
    // A plugin that found no readable source returns no flows and no totals.
    // The result must be empty rows — not a zero-byte row, which on the screen
    // is a claim that the network was quiet.
    const result = aggregateNetworkFlows(DAY, { flows: [], totals: [], rates: RATES }, {});
    expect(result.rows).toEqual([]);
    expect(result.residualBytes).toBe(0);
    expect(result.droppedPairs).toBe(0);
  });

  it("counts a total that undershoots its own pairs instead of emitting negative money", () => {
    const result = aggregateNetworkFlows(
      DAY,
      {
        flows: [flow({ bytes: 100 * GB, scope: "cross_zone" })],
        totals: [total("cross_zone", 40 * GB)],
        rates: RATES,
      },
      { maxPairs: 10 },
    );
    expect(byAttribution(result.rows, "truncated")).toHaveLength(0);
    expect(result.negativeResiduals).toBe(1);
    expect(result.rows.every((r) => r.estimatedCost >= 0)).toBe(true);
  });

  it("caps stored rows at maxPairs plus one residual per scope and direction", () => {
    const flows: NetworkFlowRecord[] = [];
    for (let i = 0; i < 40; i++) {
      flows.push(
        flow({
          bytes: (40 - i) * GB,
          scope: "cross_zone",
          source: { ref: `i-${i}` },
        }),
        flow({
          bytes: (40 - i) * GB,
          scope: "internet_egress",
          direction: "egress",
          source: { ref: `i-${i}` },
          destination: { ref: "internet" },
        }),
      );
    }
    const result = aggregateNetworkFlows(
      DAY,
      {
        flows,
        totals: [total("cross_zone", 10_000 * GB), total("internet_egress", 10_000 * GB)],
        rates: RATES,
      },
      { maxPairs: 10 },
    );
    expect(byAttribution(result.rows, "truncated")).toHaveLength(2);
    expect(result.rows).toHaveLength(12);
  });

  it("drops flows dated outside the day being aggregated", () => {
    const result = aggregateNetworkFlows(
      DAY,
      {
        flows: [flow({ bytes: 9 * GB, scope: "cross_zone", date: "2026-08-09" })],
        rates: RATES,
      },
      {},
    );
    expect(result.rows).toEqual([]);
  });

  it("hashes a pair deterministically and separates pairs that differ only off the sort key", () => {
    const result = aggregateNetworkFlows(
      DAY,
      {
        flows: [
          flow({ bytes: GB, scope: "cross_zone", destination: { ref: "i-a", zone: "use1-az2" } }),
          flow({ bytes: GB, scope: "cross_zone", destination: { ref: "i-a", zone: "use1-az3" } }),
        ],
        rates: RATES,
      },
      { maxPairs: 10 },
    );
    const rows = byAttribution(result.rows, "resolved");
    expect(rows).toHaveLength(2);
    expect(rows[0]!.pairHash).not.toBe(rows[1]!.pairHash);
    // Stable across processes — the ReplacingMergeTree key depends on it.
    expect(fnv1a64("i-src i-a  use1-az2  ")).toBe(fnv1a64("i-src i-a  use1-az2  "));
  });
});
