import { describe, expect, it, vi } from "vitest";

import { fetchAzureCostData, mapAzureChargeType } from "../cost-data.js";
import type { AzureHttpContext } from "../shared.js";

const RANGE = { fromDate: "2026-07-01", toDate: "2026-07-02" };

const RESERVATION_ARM_ID =
  "/providers/Microsoft.Capacity/reservationOrders/ord-1/reservations/res-1";
const SAVINGS_PLAN_ARM_ID =
  "/providers/Microsoft.BillingBenefits/savingsPlanOrders/sp-1/savingsPlans/sp-a";

interface Page {
  columns: string[];
  rows: Array<Array<string | number>>;
  nextLink?: string;
}

function page(p: Page) {
  return {
    properties: {
      columns: p.columns.map((name) => ({ name })),
      rows: p.rows,
      ...(p.nextLink ? { nextLink: p.nextLink } : {}),
    },
  };
}

/**
 * A context whose `post` answers each successive query from `responses`,
 * recording the bodies so the grouping/filter shape can be asserted.
 */
function ctxFor(responses: Array<unknown | Error>) {
  const bodies: Array<Record<string, never>> = [];
  let call = 0;
  const post = vi.fn(async (_url: string, body: unknown) => {
    bodies.push(body as Record<string, never>);
    const next = responses[call++];
    if (next instanceof Error) throw next;
    return next;
  });
  const ctx = {
    get: vi.fn(),
    post,
    put: vi.fn(),
    patch: vi.fn(),
    del: vi.fn(),
    subscriptionId: "sub-1",
    tenantId: "tenant-1",
  } as unknown as AzureHttpContext;
  return { ctx, bodies, post };
}

/** `dataset.grouping` of the n-th query, as plain dimension names. */
function groupingOf(body: unknown): string[] {
  const dataset = (body as { dataset: { grouping: Array<{ name: string }> } }).dataset;
  return dataset.grouping.map((g) => g.name);
}

function filterOf(body: unknown): unknown {
  return (body as { dataset: { filter?: unknown } }).dataset.filter;
}

/** Which dataset a query asked for — `ActualCost` or `AmortizedCost`. */
function typeOf(body: unknown): string {
  return (body as { type: string }).type;
}

/** An empty amortized consumption page — "the pass ran and found nothing". */
const NO_AMORTIZED = () => page({ columns: USAGE_COLUMNS, rows: [] });

const USAGE_COLUMNS = ["Cost", "UsageDate", "ServiceName", "ResourceLocation", "Currency"];
const ATTRIBUTION_COLUMNS = ["Cost", "UsageDate", "ChargeType", "BenefitId", "Currency"];

describe("mapAzureChargeType", () => {
  it("maps every value Azure documents", () => {
    expect(mapAzureChargeType("Usage", "")).toBe("usage");
    expect(mapAzureChargeType("Refund", "")).toBe("refund");
    expect(mapAzureChargeType("Credit", "")).toBe("credit");
    expect(mapAzureChargeType("Tax", "")).toBe("tax");
    expect(mapAzureChargeType("RoundingAdjustment", "")).toBe("adjustment");
    // Amortized-only values: unreachable from ActualCost, mapped anyway so the
    // table is right the day an amortized pass lands.
    expect(mapAzureChargeType("UnusedReservation", "")).toBe("commitment_fee");
    expect(mapAzureChargeType("UnusedSavingsPlan", "")).toBe("commitment_fee");
  });

  it("only calls a Purchase a commitment fee when a benefit backs it", () => {
    expect(mapAzureChargeType("Purchase", RESERVATION_ARM_ID)).toBe("commitment_fee");
    // A Marketplace or support purchase is real money and is not a commitment.
    // `other` rather than a near-miss: `commitment_fee` would inflate every
    // commitment report and `usage` would overstate consumption.
    expect(mapAzureChargeType("Purchase", "")).toBe("other");
  });

  it("files anything it does not recognise under other, never usage", () => {
    expect(mapAzureChargeType("SomethingAzureAddedLater", "")).toBe("other");
    expect(mapAzureChargeType("", "")).toBe("other");
  });
});

describe("fetchAzureCostData query shape", () => {
  it("splits into two consumption passes and an attribution pass, inside Azure's 2-grouping limit", async () => {
    const { ctx, bodies } = ctxFor([
      page({ columns: USAGE_COLUMNS, rows: [] }),
      page({ columns: USAGE_COLUMNS, rows: [] }),
      page({ columns: ATTRIBUTION_COLUMNS, rows: [] }),
    ]);
    await fetchAzureCostData(ctx, RANGE);

    expect(bodies).toHaveLength(3);
    for (const body of bodies) {
      // "Query can have up to 2 group by clauses" — Microsoft.CostManagement.
      expect(groupingOf(body).length).toBeLessThanOrEqual(2);
    }

    const consumptionFilter = {
      dimensions: { name: "ChargeType", operator: "In", values: ["Usage"] },
    };
    // The two consumption passes are the same query against the two datasets.
    // Their *difference* per cell is what a commitment delivered — which is the
    // only way Azure prices covered usage at anything but zero, and it needs no
    // third grouping slot.
    expect(groupingOf(bodies[0])).toEqual(["ServiceName", "ResourceLocation"]);
    expect(typeOf(bodies[0])).toBe("ActualCost");
    expect(filterOf(bodies[0])).toEqual(consumptionFilter);

    expect(groupingOf(bodies[1])).toEqual(["ServiceName", "ResourceLocation"]);
    expect(typeOf(bodies[1])).toBe("AmortizedCost");
    expect(filterOf(bodies[1])).toEqual(consumptionFilter);

    expect(groupingOf(bodies[2])).toEqual(["ChargeType", "BenefitId"]);
    expect(typeOf(bodies[2])).toBe("ActualCost");
    // Deliberately unfiltered: QueryOperatorType has only `In`, so a filtered
    // complement would drop money under any charge type Azure adds later.
    expect(filterOf(bodies[2])).toBeUndefined();
  });

  it("follows nextLink within a pass", async () => {
    const { ctx, post } = ctxFor([
      page({
        columns: USAGE_COLUMNS,
        rows: [[1, 20260701, "Virtual Machines", "eastus", "USD"]],
        nextLink: "https://management.azure.com/next?$skiptoken=abc",
      }),
      page({ columns: USAGE_COLUMNS, rows: [[2, 20260702, "Storage", "westus", "USD"]] }),
      NO_AMORTIZED(),
      page({ columns: ATTRIBUTION_COLUMNS, rows: [] }),
    ]);
    const { rows } = await fetchAzureCostData(ctx, RANGE);
    expect(rows).toHaveLength(2);
    expect(post.mock.calls[1]![0]).toBe("https://management.azure.com/next?$skiptoken=abc");
  });
});

describe("fetchAzureCostData row mapping", () => {
  it("stamps usage rows with service, region and chargeType usage", async () => {
    const { ctx } = ctxFor([
      page({
        columns: USAGE_COLUMNS,
        rows: [
          [12.5, 20260701, "Virtual Machines", "eastus", "USD"],
          [3, 20260701, "Bandwidth", "Unassigned", "USD"],
          // Zero-cost rows carry no information and are dropped, as before.
          [0, 20260702, "Virtual Machines", "eastus", "USD"],
        ],
      }),
      NO_AMORTIZED(),
      page({ columns: ATTRIBUTION_COLUMNS, rows: [] }),
    ]);
    const { rows } = await fetchAzureCostData(ctx, RANGE);
    expect(rows).toEqual([
      {
        date: "2026-07-01",
        service: "Virtual Machines",
        region: "eastus",
        currency: "USD",
        amount: 12.5,
        chargeType: "usage",
      },
      {
        date: "2026-07-01",
        service: "Bandwidth",
        // "Unassigned" is Azure's placeholder for global spend, not a region.
        region: "",
        currency: "USD",
        amount: 3,
        chargeType: "usage",
      },
    ]);
  });

  it("splits a cell into on-demand and commitment-covered usage by the gap between datasets", async () => {
    // ActualCost prices reservation-covered usage at zero — the money left when
    // the reservation was bought — so cash coverage is structurally 0% and a
    // ratio built on it is an answer-shaped non-answer. AmortizedCost prices the
    // same hours at their real rate, and the difference is what the commitment
    // delivered into the cell.
    const { ctx } = ctxFor([
      page({
        columns: USAGE_COLUMNS,
        rows: [[4, 20260701, "Virtual Machines", "eastus", "USD"]],
      }),
      page({
        columns: USAGE_COLUMNS,
        rows: [[10, 20260701, "Virtual Machines", "eastus", "USD"]],
      }),
      page({ columns: ATTRIBUTION_COLUMNS, rows: [] }),
    ]);
    const { rows } = await fetchAzureCostData(ctx, RANGE);

    expect(rows).toEqual([
      {
        date: "2026-07-01",
        service: "Virtual Machines",
        region: "eastus",
        currency: "USD",
        amount: 4,
        amortizedAmount: 4,
        chargeType: "usage",
      },
      {
        date: "2026-07-01",
        service: "Virtual Machines",
        region: "eastus",
        currency: "USD",
        // Zero cash, real amortized value: the shape coverage is read from.
        amount: 0,
        amortizedAmount: 6,
        chargeType: "commitment_covered_usage",
      },
    ]);
    // No commitment id is claimed — BenefitId is not in this grouping, and is
    // an EA/MCA-only column anyway. Coverage does not need it.
    expect(rows.every((r) => r.commitmentId === undefined)).toBe(true);
    // Cash and amortized totals are each conserved.
    expect(rows.reduce((n, r) => n + r.amount, 0)).toBe(4);
    expect(rows.reduce((n, r) => n + (r.amortizedAmount ?? 0), 0)).toBe(10);
  });

  it("reports a fully covered cell that costs nothing in cash", async () => {
    const { ctx } = ctxFor([
      page({ columns: USAGE_COLUMNS, rows: [] }),
      page({
        columns: USAGE_COLUMNS,
        rows: [[7.2, 20260701, "Virtual Machines", "eastus", "USD"]],
      }),
      page({ columns: ATTRIBUTION_COLUMNS, rows: [] }),
    ]);
    const { rows } = await fetchAzureCostData(ctx, RANGE);

    expect(rows).toEqual([
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
  });

  it("does not fabricate coverage out of a correction that has landed on one dataset only", async () => {
    // Azure restates by emitting negative `Usage` lines, and the two datasets
    // need not receive one in the same collection. A −5 that has reached
    // ActualCost but not AmortizedCost reads as cash −5, amortized 0 — whose
    // "gap" is a fabricated 5 of commitment-covered spend. The totals would
    // still balance, but the coverage numerator would be wrong *and* the cell
    // would be marked commitment-eligible on that evidence, dragging the narrow
    // ratio down for every sibling account sharing (plugin, service, region).
    const { ctx } = ctxFor([
      page({
        columns: USAGE_COLUMNS,
        rows: [[-5, 20260701, "Virtual Machines", "eastus", "USD"]],
      }),
      page({ columns: USAGE_COLUMNS, rows: [[0, 20260701, "Virtual Machines", "eastus", "USD"]] }),
      page({ columns: ATTRIBUTION_COLUMNS, rows: [] }),
    ]);
    const { rows } = await fetchAzureCostData(ctx, RANGE);

    expect(rows).toEqual([
      {
        date: "2026-07-01",
        service: "Virtual Machines",
        region: "eastus",
        currency: "USD",
        amount: -5,
        amortizedAmount: 0,
        chargeType: "usage",
      },
    ]);
    expect(rows.some((r) => r.chargeType === "commitment_covered_usage")).toBe(false);
  });

  it("does not decompose a cell whose amortized figure is a correction", async () => {
    // The mirror image: amortized −5 against cash 0. The gap is negative, so
    // the old code already fell through — but the guard has to hold for the
    // case where *both* are negative and the gap is positive, e.g. cash −10
    // against amortized −4, which "decomposes" to 6 of covered spend out of
    // two refunds.
    const { ctx } = ctxFor([
      page({
        columns: USAGE_COLUMNS,
        rows: [[-10, 20260701, "Virtual Machines", "eastus", "USD"]],
      }),
      page({ columns: USAGE_COLUMNS, rows: [[-4, 20260701, "Virtual Machines", "eastus", "USD"]] }),
      page({ columns: ATTRIBUTION_COLUMNS, rows: [] }),
    ]);
    const { rows } = await fetchAzureCostData(ctx, RANGE);

    expect(rows).toEqual([
      {
        date: "2026-07-01",
        service: "Virtual Machines",
        region: "eastus",
        currency: "USD",
        amount: -10,
        amortizedAmount: -4,
        chargeType: "usage",
      },
    ]);
  });

  it("states a purchase's amortized value as zero only once amortization landed", async () => {
    // The AmortizedCost dataset has no Purchase row at all — that money *is*
    // the covered-usage rows. Saying so explicitly is what stops the amortized
    // view showing the purchase at full price alongside every slice of it.
    const withAmortization = ctxFor([
      page({ columns: USAGE_COLUMNS, rows: [] }),
      page({
        columns: USAGE_COLUMNS,
        rows: [[40, 20260701, "Virtual Machines", "eastus", "USD"]],
      }),
      page({
        columns: ATTRIBUTION_COLUMNS,
        rows: [
          [1200, 20260701, "Purchase", RESERVATION_ARM_ID, "USD"],
          [7, 20260701, "Tax", "", "USD"],
        ],
      }),
    ]);
    const { rows } = await fetchAzureCostData(withAmortization.ctx, RANGE);

    expect(rows.find((r) => r.chargeType === "commitment_fee")).toMatchObject({
      amount: 1200,
      amortizedAmount: 0,
    });
    // Tax is priced identically on both datasets and says so.
    expect(rows.find((r) => r.chargeType === "tax")).toMatchObject({
      amount: 7,
      amortizedAmount: 7,
    });

    // Without an amortized result there are no covered rows holding the
    // redistributed value, so zeroing the purchase would delete it outright.
    const withoutAmortization = ctxFor([
      page({ columns: USAGE_COLUMNS, rows: [] }),
      NO_AMORTIZED(),
      page({
        columns: ATTRIBUTION_COLUMNS,
        rows: [[1200, 20260701, "Purchase", RESERVATION_ARM_ID, "USD"]],
      }),
    ]);
    const { rows: unamortized } = await fetchAzureCostData(withoutAmortization.ctx, RANGE);
    expect(unamortized[0]!.amortizedAmount).toBeUndefined();
  });

  it("keeps collecting when the subscription refuses the amortized dataset", async () => {
    // "Cost Analysis doesn't support viewing amortized reservation costs for a
    // pay-as-you-go subscription." A refusal is a normal state: the split is
    // lost, the spend is not, and no `amortizedAmount` is claimed so the host
    // falls back to the cash figure rather than pricing the cell at nothing.
    const { ctx, bodies } = ctxFor([
      page({
        columns: USAGE_COLUMNS,
        rows: [[12, 20260701, "Virtual Machines", "eastus", "USD"]],
      }),
      new Error("Azure API POST 400: AmortizedCost is not supported for this subscription"),
      page({ columns: ATTRIBUTION_COLUMNS, rows: [] }),
    ]);
    const { rows } = await fetchAzureCostData(ctx, RANGE);

    // Still three queries, and the attribution pass still ran.
    expect(bodies).toHaveLength(3);
    expect(rows).toEqual([
      {
        date: "2026-07-01",
        service: "Virtual Machines",
        region: "eastus",
        currency: "USD",
        amount: 12,
        chargeType: "usage",
      },
    ]);
    expect(rows[0]!.amortizedAmount).toBeUndefined();
  });

  it("attributes purchases to the benefit that caused them, lower-cased for the join", async () => {
    const { ctx } = ctxFor([
      page({ columns: USAGE_COLUMNS, rows: [] }),
      NO_AMORTIZED(),
      page({
        columns: ATTRIBUTION_COLUMNS,
        rows: [
          [1200, 20260701, "Purchase", RESERVATION_ARM_ID, "USD"],
          [400, 20260701, "Purchase", SAVINGS_PLAN_ARM_ID, "USD"],
        ],
      }),
    ]);
    const { rows } = await fetchAzureCostData(ctx, RANGE);
    expect(rows).toEqual([
      {
        date: "2026-07-01",
        service: "",
        region: "",
        currency: "USD",
        amount: 1200,
        chargeType: "commitment_fee",
        // Matches CommitmentRecord.id, which mapAzureReservation lower-cases too.
        commitmentId: "/providers/microsoft.capacity/reservationorders/ord-1/reservations/res-1",
      },
      {
        date: "2026-07-01",
        service: "",
        region: "",
        currency: "USD",
        amount: 400,
        chargeType: "commitment_fee",
        commitmentId:
          "/providers/microsoft.billingbenefits/savingsplanorders/sp-1/savingsplans/sp-a",
      },
    ]);
  });

  it("drops the attribution pass's Usage rows — pass 1 already has that money", async () => {
    const { ctx } = ctxFor([
      page({
        columns: USAGE_COLUMNS,
        rows: [[100, 20260701, "Virtual Machines", "eastus", "USD"]],
      }),
      NO_AMORTIZED(),
      page({
        columns: ATTRIBUTION_COLUMNS,
        rows: [
          // Same $100, at a coarser grain. Keeping it would double the day.
          [100, 20260701, "Usage", "", "USD"],
          [7, 20260701, "Tax", "", "USD"],
        ],
      }),
    ]);
    const { rows } = await fetchAzureCostData(ctx, RANGE);
    expect(rows.map((r) => [r.chargeType, r.amount])).toEqual([
      ["usage", 100],
      ["tax", 7],
    ]);
  });

  it("never turns a placeholder benefit label into an unmatchable commitment id", async () => {
    const { ctx } = ctxFor([
      page({ columns: USAGE_COLUMNS, rows: [] }),
      NO_AMORTIZED(),
      page({
        columns: ATTRIBUTION_COLUMNS,
        rows: [
          [10, 20260701, "Purchase", "", "USD"],
          [11, 20260701, "Purchase", "Unassigned", "USD"],
          [12, 20260701, "Purchase", "No benefit", "USD"],
          // Not a resource id, so not a join key.
          [13, 20260701, "Purchase", "some-reservation", "USD"],
        ],
      }),
    ]);
    const { rows } = await fetchAzureCostData(ctx, RANGE);
    // All four spellings of "no benefit" normalize to the same empty id, and a
    // benefit-less Purchase is `other` — so all four provider rows share one
    // host key and must arrive as **one summed row**. Four separate rows would
    // be four versions of one ReplacingMergeTree row, and `FINAL` would keep
    // whichever landed last: 10 reported instead of 46.
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ chargeType: "other", amount: 46 });
    expect(rows[0]!.commitmentId).toBeUndefined();
  });

  it("defaults the currency and rejects a response missing the core columns", async () => {
    const { ctx } = ctxFor([
      page({ columns: ["Cost", "UsageDate", "ServiceName"], rows: [[5, 20260701, "Storage"]] }),
      NO_AMORTIZED(),
      page({ columns: ATTRIBUTION_COLUMNS, rows: [] }),
    ]);
    const { rows } = await fetchAzureCostData(ctx, RANGE);
    expect(rows[0]!.currency).toBe("USD");

    const broken = ctxFor([
      page({ columns: ["Something", "Else"], rows: [[1, 2]] }),
      // The fallback pass is handed the same nonsense and fails too.
      page({ columns: ["Something", "Else"], rows: [[1, 2]] }),
    ]);
    await expect(fetchAzureCostData(broken.ctx, RANGE)).rejects.toThrow(/unexpected column set/);
  });
});

describe("fetchAzureCostData fallback", () => {
  it("falls back to the unfiltered single-pass query when the split shape is rejected", async () => {
    // BenefitId is an EA/MCA column, so a pay-as-you-go subscription can
    // legitimately refuse to group by it. Losing charge types beats losing
    // the spend data.
    const { ctx, bodies } = ctxFor([
      page({ columns: USAGE_COLUMNS, rows: [[9, 20260701, "Virtual Machines", "eastus", "USD"]] }),
      NO_AMORTIZED(),
      new Error("Azure API POST 400: Invalid dataset grouping: 'BenefitId'"),
      page({ columns: USAGE_COLUMNS, rows: [[42, 20260701, "Virtual Machines", "eastus", "USD"]] }),
    ]);
    const { rows } = await fetchAzureCostData(ctx, RANGE);

    expect(bodies).toHaveLength(4);
    expect(groupingOf(bodies[3])).toEqual(["ServiceName", "ResourceLocation"]);
    expect(filterOf(bodies[3])).toBeUndefined();
    expect(rows).toEqual([
      {
        date: "2026-07-01",
        service: "Virtual Machines",
        region: "eastus",
        currency: "USD",
        amount: 42,
      },
    ]);
    // No chargeType: the fallback genuinely cannot tell, and the host records
    // an absent charge type as `usage` — which keeps the tags_hash identical
    // to what this collector wrote before charge types existed.
    expect(rows[0]!.chargeType).toBeUndefined();
  });

  it("flags the fallback as degraded so the host does not reconcile against it", async () => {
    // The rejection above fires for a subscription that can never group by
    // BenefitId *and* for one that merely had a bad minute. Either way this
    // pass writes a strictly coarser key space than the collection before it,
    // and the host's superseded-row reconciliation would read that as "the
    // attribution rows are gone" and zero every one of them for these days —
    // unrepairable, since a backfilled account only re-fetches restatementDays.
    const { ctx } = ctxFor([
      new Error("Azure API POST 400: Invalid dataset grouping: 'BenefitId'"),
      page({ columns: USAGE_COLUMNS, rows: [[42, 20260701, "Virtual Machines", "eastus", "USD"]] }),
    ]);
    const result = await fetchAzureCostData(ctx, RANGE);
    expect(result.degraded).toBe(true);
  });

  it("does not flag a healthy attributed pass", async () => {
    // Absent means "not degraded" — a normal pass must never suppress
    // reconciliation, which is the whole mechanism for retiring stale keys.
    const { ctx } = ctxFor([
      page({ columns: USAGE_COLUMNS, rows: [[9, 20260701, "Virtual Machines", "eastus", "USD"]] }),
      NO_AMORTIZED(),
      page({ columns: ATTRIBUTION_COLUMNS, rows: [[7, 20260701, "Tax", "", "USD"]] }),
    ]);
    const result = await fetchAzureCostData(ctx, RANGE);
    expect(result.degraded).toBeFalsy();
    expect(result.rows).toHaveLength(2);
  });

  it("is not degraded merely because the amortized pass was refused", async () => {
    // A pay-as-you-go subscription refusing AmortizedCost loses the
    // covered/on-demand split, not a key-space dimension: the same cells are
    // still written, still with charge types. Suppressing reconciliation there
    // would leave stale keys standing forever on every PAYG account.
    const { ctx } = ctxFor([
      page({ columns: USAGE_COLUMNS, rows: [[12, 20260701, "Virtual Machines", "eastus", "USD"]] }),
      new Error("Azure API POST 400: AmortizedCost is not supported for this subscription"),
      page({ columns: ATTRIBUTION_COLUMNS, rows: [] }),
    ]);
    const result = await fetchAzureCostData(ctx, RANGE);
    expect(result.degraded).toBeFalsy();
  });

  it("propagates errors that are not about the query shape", async () => {
    // A 403 from a missing Cost Management Reader role fails the fallback too,
    // so nothing is swallowed and the host records the real failure.
    const denied = new Error("Azure API POST 403: AuthorizationFailed");
    const { ctx } = ctxFor([denied, denied, denied]);
    await expect(fetchAzureCostData(ctx, RANGE)).rejects.toThrow(/AuthorizationFailed/);
  });
});
