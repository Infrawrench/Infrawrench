import { beforeEach, describe, expect, it, vi } from "vitest";

import type { NetworkFlowFetchRange, NetworkFlowRecord } from "@infrawrench/plugin-base";

/**
 * What the collector wrote, in the two places a day leaves a mark: the
 * watermark that says the day will never be asked for again, and the rows.
 */
const watermarks: unknown[] = [];
const inserted: unknown[][] = [];
let stored: { collectedThrough: string | null }[] = [];

vi.mock("../db/client", () => ({
  db: {
    select: () => ({
      from: () => ({ where: () => ({ limit: async () => stored }) }),
    }),
    update: () => ({
      set: (values: Record<string, unknown>) => ({
        where: async () => {
          watermarks.push(values);
        },
      }),
    }),
  },
}));

vi.mock("../clickhouse/network-flow-writers", () => ({
  insertNetworkFlowRows: async (rows: unknown[]) => {
    inserted.push(rows);
  },
  toNetworkFlowRows: (_meta: unknown, rows: unknown[]) => rows,
}));

vi.mock("../network-flow/settings", () => ({
  getNetworkFlowSettings: async () => ({ enabled: true, initialLookbackDays: 3 }),
}));

const fetchNetworkFlows = vi.fn();
vi.mock("../sync-resources", () => ({
  loadAccountClient: async () => ({
    account: { pluginId: "aws" },
    plugin: {
      manifest: {
        networkFlows: {
          rates: { currency: "USD", asOf: "2026-08-11", perGb: { cross_zone: 0.01 } },
          maxPairsPerDay: 500,
          maxHistoryDays: 14,
          queriesBillable: true,
        },
      },
    },
    client: {
      fetchNetworkFlows: (accountId: string, range: NetworkFlowFetchRange) =>
        fetchNetworkFlows(accountId, range),
    },
  }),
}));

import { collectAccountNetworkFlows } from "../network-flow/collect";
import type { NetworkFlowLeaseGate } from "../network-flow/lease";

/** Three whole closed days are due: 08-08, 08-09, 08-10. */
const NOW = new Date("2026-08-11T09:00:00.000Z");
const DAYS = ["2026-08-08", "2026-08-09", "2026-08-10"];

function flow(day: string): NetworkFlowRecord {
  return {
    date: day,
    source: { ref: "i-local", zone: "use1-az1" },
    destination: { ref: "i-peer", zone: "use1-az2" },
    scope: "cross_zone",
    direction: "egress",
    attribution: "resolved",
    bytes: 2_000_000_000,
  };
}

/**
 * A lease as the collector sees one, with the two halves under the test's
 * control: whether another day may be started, and whether the work already
 * started is still entitled to run.
 */
function leaseStub(checkpoint: () => Promise<boolean> | boolean): {
  gate: NetworkFlowLeaseGate;
  withdraw: () => void;
  checkpoints: number;
} {
  const controller = new AbortController();
  const state = {
    gate: {
      checkpoint: async () => {
        state.checkpoints += 1;
        return checkpoint();
      },
      signal: controller.signal,
    },
    withdraw: () => controller.abort(new Error("lease no longer confirmed held")),
    checkpoints: 0,
  };
  return state;
}

beforeEach(() => {
  vi.clearAllMocks();
  watermarks.length = 0;
  inserted.length = 0;
  stored = [];
});

/*
 * A day is not a bounded unit of work — it is a walk over every flow log on the
 * account, each with its own query timeout — so the lease that entitles the
 * collector to spend the customer's money can run out in the middle of one. All
 * three of these are about what the collector does with a day it was not
 * allowed to finish, and the answer is the same every time: nothing. The
 * watermark is the only record that a day was collected, this pass is
 * forward-only, and a day marked collected is a day never asked for again.
 */
describe("collectAccountNetworkFlows under a lease that runs out", () => {
  it("hands the entitlement to the plugin, so a day can be stopped from outside", async () => {
    const lease = leaseStub(() => true);
    fetchNetworkFlows.mockResolvedValue({ sources: [], flows: [], totals: [] });

    await collectAccountNetworkFlows("acct-1", "org-1", { now: NOW, lease: lease.gate });

    expect(fetchNetworkFlows).toHaveBeenCalledTimes(3);
    for (const [, range] of fetchNetworkFlows.mock.calls) {
      expect((range as NetworkFlowFetchRange).signal).toBe(lease.gate.signal);
    }
  });

  // Nothing is competing for the account on a backfill or a one-off, so there
  // is no entitlement to hand over and the plugin runs unguarded — exactly as
  // it did before any of this existed.
  it("passes no signal at all when it is running without a lease", async () => {
    fetchNetworkFlows.mockResolvedValue({ sources: [], flows: [], totals: [] });

    await collectAccountNetworkFlows("acct-1", "org-1", { now: NOW });

    expect(fetchNetworkFlows).toHaveBeenCalledTimes(3);
    expect((fetchNetworkFlows.mock.calls[0]![1] as NetworkFlowFetchRange).signal).toBeUndefined();
  });

  it("banks the days it finished and leaves the interrupted one for next time", async () => {
    const lease = leaseStub(() => true);
    fetchNetworkFlows.mockImplementation(
      async (_accountId: string, range: NetworkFlowFetchRange) => {
        if (range.day !== DAYS[1]) return { sources: [], flows: [flow(range.day)], totals: [] };
        // The second day is the one the lease runs out under: the plugin stops
        // where it is and throws rather than answering short.
        lease.withdraw();
        throw new Error("Host withdrew network-flow authorization while collecting 2026-08-09");
      },
    );

    const result = await collectAccountNetworkFlows("acct-1", "org-1", {
      now: NOW,
      lease: lease.gate,
    });

    // Not a failure: the account did nothing wrong, so the pass ends cleanly
    // and its terminal write records a success rather than backoff.
    expect(result.daysCollected).toBe(1);
    // The first day is banked, the interrupted one is not, and the third was
    // never started — so the next pass picks up from 08-09.
    expect(watermarks).toEqual([{ collectedThrough: DAYS[0] }]);
    expect(inserted).toHaveLength(1);
    expect(fetchNetworkFlows).toHaveBeenCalledTimes(2);
  });

  // The contract says throw, and our own plugin does. A plugin that instead
  // swallowed the abort would be handing back a day assembled from a partial
  // scan, and the collector cannot tell that apart from a quiet day — so it
  // does not try to, and drops any answer that arrived after the entitlement
  // was withdrawn.
  it("discards a day a plugin answered after authorization was withdrawn", async () => {
    const lease = leaseStub(() => true);
    fetchNetworkFlows.mockImplementation(
      async (_accountId: string, range: NetworkFlowFetchRange) => {
        if (range.day === DAYS[1]) lease.withdraw();
        return { sources: [], flows: [flow(range.day)], totals: [] };
      },
    );

    const result = await collectAccountNetworkFlows("acct-1", "org-1", {
      now: NOW,
      lease: lease.gate,
    });

    expect(result.daysCollected).toBe(1);
    expect(watermarks).toEqual([{ collectedThrough: DAYS[0] }]);
    expect(inserted).toHaveLength(1);
  });

  // The cheap half of the gate: a checkpoint that says no stops the pass before
  // a single provider call, which is the common ending — a spent runtime budget
  // or a lease that is no longer confirmed far enough ahead.
  it("starts no day at all once the checkpoint stops authorizing them", async () => {
    let allowed = 1;
    const lease = leaseStub(() => allowed-- > 0);
    fetchNetworkFlows.mockResolvedValue({ sources: [], flows: [], totals: [] });

    const result = await collectAccountNetworkFlows("acct-1", "org-1", {
      now: NOW,
      lease: lease.gate,
    });

    expect(result.daysCollected).toBe(1);
    expect(fetchNetworkFlows).toHaveBeenCalledTimes(1);
    expect(watermarks).toEqual([{ collectedThrough: DAYS[0] }]);
  });

  // A failure that is not the lease is still a failure, and must still reach
  // the pass — which records it against the account with backoff. Swallowing
  // everything that happened to be thrown near an abort would turn a broken
  // account into an account that silently never collects.
  it("still throws when the day failed for a reason of its own", async () => {
    const lease = leaseStub(() => true);
    fetchNetworkFlows.mockRejectedValue(new Error("AccessDenied"));

    await expect(
      collectAccountNetworkFlows("acct-1", "org-1", { now: NOW, lease: lease.gate }),
    ).rejects.toThrow("AccessDenied");
    expect(watermarks).toEqual([]);
  });
});
