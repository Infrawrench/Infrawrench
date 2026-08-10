/**
 * Superseded-row reconciliation: the mechanism that replaced a documented
 * `ALTER TABLE cost_daily DELETE` in two plugins' upgrade notes.
 *
 * A ReplacingMergeTree only replaces a row something rewrites, and `cost_daily`
 * folds charge type and commitment id into `tags_hash` — so the day a plugin
 * starts stamping charge types, a cell whose spend was entirely non-usage moves
 * to a new key and its old row lingers, double-counting. The same shape recurs
 * whenever a provider restates a cell away or a label changes, which is why it
 * is solved in the host rather than in each plugin.
 *
 * The tests below are in two halves, and the second half is the important one:
 * a mechanism that zeroes stored spend has to be *provably* inert when the
 * evidence is thin.
 */
import { describe, expect, it, vi } from "vitest";

import { hashTags, toCostDailyRows, type CostDailyRow } from "../clickhouse/cost-writers";
import { supersededTombstones, type StoredCostRowKey } from "../clickhouse/cost-reconcile";

const META = { organizationId: "org-1", accountId: "acc-1", pluginId: "azure" };

/** A stored row as the read-back query returns it. */
function stored(over: Partial<StoredCostRowKey> = {}): StoredCostRowKey {
  const tags = over.tags ?? {};
  return {
    day: "2026-07-01",
    service: "Virtual Machines",
    region: "eastus",
    resource_id: "",
    tags,
    tags_hash: over.tags_hash ?? hashTags(tags),
    currency: "USD",
    charge_type: "usage",
    commitment_id: "",
    ...over,
  };
}

function written(rows: Parameters<typeof toCostDailyRows>[1]): CostDailyRow[] {
  return toCostDailyRows(META, rows);
}

// ─── It fires where the hazard is ───────────────────────────────────────────

describe("supersededTombstones supersedes what a collection no longer writes", () => {
  it("zeroes the stale combined row of a cell that is now entirely non-usage", () => {
    // Before: one undifferentiated row for (day, service, region) holding a
    // reservation purchase. After: the purchase arrives at a new hash because
    // `commitment_fee` folds into `tags_hash`, and nothing rewrites the old key.
    const staleKey = stored({ service: "Reservations", region: "" });
    const rows = written([
      {
        date: "2026-07-01",
        service: "Reservations",
        currency: "USD",
        amount: 1200,
        chargeType: "commitment_fee",
      },
    ]);

    const tombstones = supersededTombstones(META, [staleKey], rows);

    expect(tombstones).toHaveLength(1);
    expect(tombstones[0]).toMatchObject({
      organization_id: "org-1",
      account_id: "acc-1",
      plugin_id: "azure",
      day: "2026-07-01",
      service: "Reservations",
      region: "",
      currency: "USD",
      amount: 0,
      usage_amount: 0,
      amortized_amount: 0,
      amortized_reported: 0,
    });
    // Same sort key as the stale row, which is what makes this a replacement
    // rather than an extra row.
    expect(tombstones[0]!.tags_hash).toBe(staleKey.tags_hash);
    // Charge type and commitment id ride in that hash, so they are carried
    // forward verbatim — a tombstone that changed them would describe a row
    // whose hash no longer matches its own contents.
    expect(tombstones[0]!.charge_type).toBe(staleKey.charge_type);
    expect(tombstones[0]!.commitment_id).toBe(staleKey.commitment_id);
  });

  it("zeroes a regional cell whose consumption became commitment-covered", () => {
    // The residue no in-plugin tombstone can reach: a fully reserved fleet's
    // cell moves from `usage` to `commitment_covered_usage` and takes its hash
    // with it.
    const staleKey = stored();
    const rows = written([
      {
        date: "2026-07-01",
        service: "Virtual Machines",
        region: "eastus",
        currency: "USD",
        amount: 0,
        amortizedAmount: 7.2,
        chargeType: "commitment_covered_usage",
      },
    ]);

    expect(supersededTombstones(META, [staleKey], rows)).toHaveLength(1);
  });

  it("zeroes a cell the provider restated away entirely", () => {
    // Nothing to do with charge types: the provider now reports nothing for
    // this service on a day it still reports other spend.
    const gone = stored({ service: "Bandwidth" });
    const rows = written([
      {
        date: "2026-07-01",
        service: "Virtual Machines",
        region: "eastus",
        currency: "USD",
        amount: 10,
      },
    ]);

    const tombstones = supersededTombstones(META, [gone, stored()], rows);
    expect(tombstones.map((t) => t.service)).toEqual(["Bandwidth"]);
  });

  it("de-duplicates several stored versions of one key", () => {
    const key = stored({ service: "Reservations" });
    const rows = written([{ date: "2026-07-01", service: "Other", currency: "USD", amount: 1 }]);
    expect(supersededTombstones(META, [key, { ...key }], rows)).toHaveLength(1);
  });
});

// ─── It must not fire anywhere else ─────────────────────────────────────────

describe("supersededTombstones must not fire on thin evidence", () => {
  it("does nothing at all when the collection produced no rows", () => {
    // A provider that errored into an empty result, or a billing export that
    // has not caught up, is not evidence that the stored spend is wrong. This
    // is the guard that makes the mechanism safe to run on every collection.
    expect(supersededTombstones(META, [stored(), stored({ service: "Other" })], [])).toEqual([]);
  });

  it("leaves days the collection did not write to alone", () => {
    // A provider that reports the most recent day late must not wipe it.
    const yesterday = stored({ day: "2026-06-30" });
    const rows = written([
      {
        date: "2026-07-01",
        service: "Virtual Machines",
        region: "eastus",
        currency: "USD",
        amount: 10,
      },
    ]);

    expect(supersededTombstones(META, [yesterday], rows)).toEqual([]);
  });

  it("leaves a key the collection rewrote alone", () => {
    // The overwhelmingly common case: a usage row hashes exactly as it did
    // before charge types existed, so re-collection replaces it and there is
    // nothing to supersede.
    const rows = written([
      {
        date: "2026-07-01",
        service: "Virtual Machines",
        region: "eastus",
        currency: "USD",
        amount: 10,
      },
    ]);
    expect(supersededTombstones(META, [stored()], rows)).toEqual([]);
  });

  it("distinguishes keys that differ only in tags", () => {
    const tagged = stored({ tags: { env: "prod" } });
    const untagged = stored();
    const rows = written([
      {
        date: "2026-07-01",
        service: "Virtual Machines",
        region: "eastus",
        currency: "USD",
        amount: 10,
        tags: { env: "prod" },
      },
    ]);

    // The tagged row was rewritten; the untagged one was not.
    const tombstones = supersededTombstones(META, [tagged, untagged], rows);
    expect(tombstones).toHaveLength(1);
    expect(tombstones[0]!.tags_hash).toBe(untagged.tags_hash);
  });

  it("never zeroes a row pushed through the ingest API", () => {
    // Pushed rows carry a reserved `infrawrench:`-prefixed tag naming their
    // source. A collector must never zero spend a user pushed — the two key
    // spaces are deliberately disjoint and neither owns the other.
    const pushed = stored({
      service: "Snowflake",
      tags: { "infrawrench:source": "external" },
    });
    const rows = written([
      {
        date: "2026-07-01",
        service: "Virtual Machines",
        region: "eastus",
        currency: "USD",
        amount: 10,
      },
    ]);

    expect(supersededTombstones(META, [pushed], rows)).toEqual([]);
  });

  it("writes a tombstone that reads as nothing on either money basis", () => {
    const rows = written([{ date: "2026-07-01", service: "Other", currency: "USD", amount: 1 }]);
    const [tombstone] = supersededTombstones(META, [stored()], rows);
    // `amortized_reported: 0` means "no opinion", so the amortized reader falls
    // back to `amount` — which is also 0. Nothing to double-count either way.
    expect(tombstone!.amount).toBe(0);
    expect(tombstone!.amortized_amount).toBe(0);
    expect(tombstone!.amortized_reported).toBe(0);
  });
});

// ─── The period-native repair ───────────────────────────────────────────────

describe("supersededTombstones repairs a period-native plugin's intra-period residue", () => {
  const MISTRAL = { organizationId: "org-1", accountId: "acc-1", pluginId: "mistral" };

  /**
   * What a month of the old Mistral dating left behind: the running total of
   * the in-progress month, filed on a *different* day every collection because
   * the month end was clamped into the requested range. Summed, the month reads
   * as the sum of its own prefixes.
   */
  function pollutedAugust(): StoredCostRowKey[] {
    return [15, 16, 17, 18].map((day) =>
      stored({ day: `2026-08-${day}`, service: "chat", region: "" }),
    );
  }

  /** The fixed collector: one row for the month, dated to the period start. */
  const augustTotal = () =>
    toCostDailyRows(MISTRAL, [
      { date: "2026-08-01", service: "chat", currency: "USD", amount: 61 },
    ]);

  it("zeroes the stranded prefixes the fixed dating no longer writes", () => {
    // The day rule cannot reach these: nothing rewrites 2026-08-15..18 ever
    // again, because the month's total now lives on the 1st. Reading the month
    // as the restated unit is what retires them — on the next collection, with
    // no operator step and nothing plugin-specific in this module.
    const tombstones = supersededTombstones(MISTRAL, pollutedAugust(), augustTotal(), {
      periodNative: true,
    });

    expect(tombstones.map((t) => t.day)).toEqual([
      "2026-08-15",
      "2026-08-16",
      "2026-08-17",
      "2026-08-18",
    ]);
    for (const tombstone of tombstones) {
      expect(tombstone.amount).toBe(0);
      expect(tombstone.amortized_amount).toBe(0);
      expect(tombstone.plugin_id).toBe("mistral");
    }
  });

  it("leaves the period start it just rewrote alone", () => {
    const withStart = [
      ...pollutedAugust(),
      stored({ day: "2026-08-01", service: "chat", region: "" }),
    ];
    const tombstones = supersededTombstones(MISTRAL, withStart, augustTotal(), {
      periodNative: true,
    });
    // The row on the 1st was replaced by the collection itself; a tombstone for
    // it would zero the month's actual total.
    expect(tombstones.some((t) => t.day === "2026-08-01")).toBe(false);
    expect(tombstones).toHaveLength(4);
  });

  it("does nothing of the sort for a daily plugin", () => {
    // Same input, no `periodNative`: a day the plugin did not write to is a day
    // the provider skipped, and skipping is not restating to zero.
    expect(supersededTombstones(MISTRAL, pollutedAugust(), augustTotal())).toEqual([]);
    expect(
      supersededTombstones(MISTRAL, pollutedAugust(), augustTotal(), { periodNative: false }),
    ).toEqual([]);
  });

  it("expands only a month whose first day the collection wrote", () => {
    // Cloudflare's charge periods follow each subscription's billing-cycle
    // anchor, Turso dates rows to an invoice due date, OVH to a bill's issue
    // date — all period-native, none of them a calendar month filed on the 1st.
    // Widening the unit to "whatever month a written row falls in" would let a
    // flaky page of one provider's invoice list zero a sibling invoice.
    const anchored = toCostDailyRows(MISTRAL, [
      { date: "2026-08-17", service: "workers", currency: "USD", amount: 5 },
    ]);
    expect(
      supersededTombstones(MISTRAL, [stored({ day: "2026-08-03", service: "workers" })], anchored, {
        periodNative: true,
      }),
    ).toEqual([]);
  });

  it("expands only the months it wrote, not every month in the chunk", () => {
    // A backfill chunk can span two months. July was collected and restated;
    // June was not fetched at all by this pass and must be untouched.
    const june = stored({ day: "2026-06-20", service: "chat", region: "" });
    const july = stored({ day: "2026-07-20", service: "chat", region: "" });
    const rows = toCostDailyRows(MISTRAL, [
      { date: "2026-07-01", service: "chat", currency: "USD", amount: 30 },
    ]);

    const tombstones = supersededTombstones(MISTRAL, [june, july], rows, { periodNative: true });
    expect(tombstones.map((t) => t.day)).toEqual(["2026-07-20"]);
  });

  it("keeps every other guard while it does so", () => {
    // Guard 1: an empty fetch is still not evidence of anything, period-native
    // or not — this is the guard that makes zeroing safe to run every day.
    expect(supersededTombstones(MISTRAL, pollutedAugust(), [], { periodNative: true })).toEqual([]);

    // Guard 3: a pushed row inside the period is still not a collector's to
    // zero, even though the collector now claims the whole month.
    const pushed = stored({
      day: "2026-08-12",
      service: "Snowflake",
      tags: { "infrawrench:source": "external" },
    });
    expect(supersededTombstones(MISTRAL, [pushed], augustTotal(), { periodNative: true })).toEqual(
      [],
    );
  });
});

// ─── The invisible coupling guard 3 rests on ────────────────────────────────

describe("guard 3 depends on collectors keeping reserved keys out of `tags`", () => {
  it("does not store the synthetic charge-type and commitment entries it hashes", () => {
    // `hashTags` folds `infrawrench:charge_type` and `infrawrench:commitment`
    // into `tags_hash` because the sort key cannot carry them — but it must not
    // write them into the `tags` column. Guard 3 skips any stored row whose
    // tags carry a reserved key, so if they *were* stored, every attribution
    // row a collector writes would look like a pushed row and reconciliation
    // would silently do nothing for the exact rows it exists to fix.
    const [attributed] = toCostDailyRows(META, [
      {
        date: "2026-07-01",
        service: "Reservations",
        currency: "USD",
        amount: 1200,
        chargeType: "commitment_fee",
        commitmentId: "/providers/microsoft.capacity/…/res-1",
      },
    ]);

    expect(Object.keys(attributed!.tags)).toEqual([]);
    // The hash still separates it from a plain usage row at the same key.
    expect(attributed!.tags_hash).not.toBe(hashTags({}));
  });

  it("still tombstones a collector's attribution row once it goes stale", () => {
    // The end-to-end consequence of the property above: an attribution row
    // stored by an earlier collection, no longer written, is a candidate.
    const [attributed] = toCostDailyRows(META, [
      {
        date: "2026-07-01",
        service: "Reservations",
        currency: "USD",
        amount: 1200,
        chargeType: "commitment_fee",
      },
    ]);
    const storedAttribution: StoredCostRowKey = {
      day: attributed!.day,
      service: attributed!.service,
      region: attributed!.region,
      resource_id: attributed!.resource_id,
      tags: attributed!.tags,
      tags_hash: attributed!.tags_hash,
      currency: attributed!.currency,
      charge_type: attributed!.charge_type,
      commitment_id: attributed!.commitment_id,
    };
    const rows = written([
      { date: "2026-07-01", service: "Virtual Machines", currency: "USD", amount: 10 },
    ]);

    const tombstones = supersededTombstones(META, [storedAttribution], rows);
    expect(tombstones).toHaveLength(1);
    expect(tombstones[0]!.charge_type).toBe("commitment_fee");
  });
});

// ─── Reading back only what still holds money ───────────────────────────────

describe("getStoredCostRowKeys excludes rows that are already zero", () => {
  it("filters on both money columns, so a key is tombstoned once and not forever", async () => {
    // Without the filter a superseded key comes back on every subsequent
    // collection looking exactly like a candidate again — still stored, still
    // not written — and each one re-inserts an identical zero row. Idempotent,
    // but unbounded write amplification against the table whose whole point is
    // retaining years of daily history.
    const query = vi.fn(async (_args: { query: string }) => ({ json: async () => [] }));
    vi.doMock("../clickhouse/client", () => ({
      isClickHouseConfigured: () => true,
      getClickHouseClient: () => ({ query }),
    }));
    vi.resetModules();
    const { getStoredCostRowKeys } = await import("../clickhouse/cost-reconcile");

    await getStoredCostRowKeys(META, "2026-07-01", "2026-07-31");

    const sql = query.mock.calls[0]![0].query.replace(/\s+/g, " ");
    expect(sql).toContain("(amount != 0 OR amortized_amount != 0)");
    vi.doUnmock("../clickhouse/client");
    vi.resetModules();
  });
});
